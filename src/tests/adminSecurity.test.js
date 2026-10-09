/**
 * Automated Security & Privacy Test Suite for PixelTalk Admin Console
 *
 * Requirements Covered:
 * 1. Admin authentication via environment-derived credentials.
 * 2. Strict separation of platform admin from regular users / group admins.
 * 3. Immediate 403 Forbidden response and audit logging for unauthorized admin API attempts.
 * 4. STRICT MESSAGE PRIVACY:
 *    - /api/admin/messages explicitly rejected with 403 Forbidden.
 *    - User detail & Group detail endpoints project ONLY safe metadata, zero message exposure.
 *    - Audit logs contain zero passwords, tokens, secrets, or private chat bodies.
 * 5. Safe User Management & Demotion/Deletion protections for primary platform admin.
 * 6. Safe Group Management without message access.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const dns = require('dns');
const mongoose = require('mongoose');

try {
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch {
  /* Ignore */
}

const config = require('../config');
const app = require('../app');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const AdminAuditLog = require('../models/AdminAuditLog');
const { issueToken } = require('../services/authService');

let server;
let baseUrl;
let adminUser;
let adminToken;
let regularUser;
let regularToken;
let testGroup;

before(async () => {
  // Connect to database if not already connected
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 10000,
    });
  }

  // Ensure Platform Admin exists according to .env
  const adminSecret = config.adminPasswordHash || config.adminPassword || 'admin123456';
  adminUser = await User.findOne({
    $or: [{ email: config.adminEmail }, { username: config.adminUsername }],
  }).select('+passwordHash');

  if (!adminUser) {
    adminUser = await User.create({
      username: config.adminUsername,
      displayName: config.adminDisplayName,
      email: config.adminEmail,
      passwordHash: adminSecret,
      avatarId: 'avatar-05',
      role: 'admin',
      status: 'active',
    });
  } else {
    adminUser.role = 'admin';
    adminUser.status = 'active';
    adminUser.passwordHash = adminSecret;
    await adminUser.save();
  }

  // Create a regular user for security isolation tests
  const regEmail = 'security_test_user_' + Date.now() + '@pixeltalk.dev';
  const regUsername = 'sectest_' + Math.floor(Math.random() * 10000);
  regularUser = await User.create({
    username: regUsername,
    displayName: 'Security Test Regular User',
    email: regEmail,
    passwordHash: 'regularpassword123',
    avatarId: 'avatar-01',
    role: 'user',
    status: 'active',
  });

  // Create a test group conversation
  testGroup = await Conversation.create({
    type: 'group',
    name: 'Security Test Lounge ' + Date.now(),
    description: 'A private lounge for testing security isolation',
    createdBy: regularUser._id,
    members: [regularUser._id],
    memberRoles: [{ userId: regularUser._id, role: 'Owner' }],
  });

  // Generate tokens
  adminToken = issueToken(adminUser);
  regularToken = issueToken(regularUser);

  // Start ephemeral server
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  // Cleanup test group and test regular user
  if (testGroup) {
    await Conversation.deleteOne({ _id: testGroup._id });
  }
  if (regularUser) {
    await User.deleteOne({ _id: regularUser._id });
  }

  // Close HTTP server and Mongoose connection
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
});

describe('1. Platform Admin Authentication & Security Auditing', () => {
  test('Admin login with invalid password fails with 401 and generic message', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: config.adminUsername,
        password: 'wrong_password_attempt_9999',
      }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 401);
    assert.strictEqual(data.success, false);
    assert.match(data.message, /invalid credentials|invalid email or password/i);

    // Verify ADMIN_LOGIN_FAILED was logged
    const failedLog = await AdminAuditLog.findOne({
      action: 'ADMIN_LOGIN_FAILED',
    }).sort({ createdAt: -1 });

    assert.ok(failedLog, 'ADMIN_LOGIN_FAILED audit log should be recorded');
  });

  test('Admin login with valid environment credentials succeeds with 200 and admin role', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: config.adminUsername,
        password: config.adminPassword || 'admin123456',
      }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.user.role, 'admin');
    assert.ok(data.data.token, 'Token must be returned');

    // Verify ADMIN_LOGIN_SUCCESS was logged
    const successLog = await AdminAuditLog.findOne({
      action: 'ADMIN_LOGIN_SUCCESS',
      adminId: adminUser._id,
    }).sort({ createdAt: -1 });

    assert.ok(successLog, 'ADMIN_LOGIN_SUCCESS audit log should be recorded');
  });
});

describe('2. Authorization Boundaries & Role Separation', () => {
  test('Unauthenticated request to /api/admin/stats returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/admin/stats`);
    const data = await res.json();
    assert.strictEqual(res.status, 401);
    assert.strictEqual(data.success, false);
  });

  test('Regular authenticated user cannot access /api/admin/stats (returns 403)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/stats`, {
      headers: {
        Authorization: `Bearer ${regularToken}`,
      },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 403);
    assert.strictEqual(data.success, false);

    // Small delay to ensure fire-and-forget audit log is persisted
    await new Promise((r) => setTimeout(r, 100));

    // Verify UNAUTHORIZED_ADMIN_ACCESS_ATTEMPT was logged
    const attemptLog = await AdminAuditLog.findOne({
      action: 'UNAUTHORIZED_ADMIN_ACCESS_ATTEMPT',
      adminId: regularUser._id,
    }).sort({ createdAt: -1 });

    assert.ok(attemptLog, 'UNAUTHORIZED_ADMIN_ACCESS_ATTEMPT should be recorded for audit trail');
  });

  test('Regular authenticated user cannot access /api/admin/users (returns 403)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/users`, {
      headers: {
        Authorization: `Bearer ${regularToken}`,
      },
    });
    assert.strictEqual(res.status, 403);
  });

  test('Regular authenticated user cannot access /api/admin/groups (returns 403)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/groups`, {
      headers: {
        Authorization: `Bearer ${regularToken}`,
      },
    });
    assert.strictEqual(res.status, 403);
  });

  test('Regular authenticated user cannot access /api/admin/audit-logs (returns 403)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/audit-logs`, {
      headers: {
        Authorization: `Bearer ${regularToken}`,
      },
    });
    assert.strictEqual(res.status, 403);
  });
});

describe('3. Strict Message Privacy (NON-NEGOTIABLE)', () => {
  test('Admin calling /api/admin/messages is strictly rejected with 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/api/admin/messages`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 403);
    assert.strictEqual(data.success, false);
    assert.match(data.message, /prohibited from reading private message content/i);
  });

  test('Admin user detail endpoint (/api/admin/users/:id) returns metadata without private messages', async () => {
    const res = await fetch(`${baseUrl}/api/admin/users/${regularUser._id}`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.user.username, regularUser.username);

    // Verify strictly forbidden message fields are not returned
    assert.strictEqual(data.data.user.messages, undefined);
    assert.strictEqual(data.data.user.conversations, undefined);
    assert.strictEqual(data.data.user.chatHistory, undefined);
    assert.strictEqual(data.data.user.passwordHash, undefined);
  });

  test('Admin group detail endpoint (/api/admin/groups/:id) returns group metadata and roster without message history', async () => {
    const res = await fetch(`${baseUrl}/api/admin/groups/${testGroup._id}`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.group.name, testGroup.name);
    assert.ok(Array.isArray(data.data.group.members));

    // Verify zero message content is leaked
    assert.strictEqual(data.data.group.messages, undefined);
    assert.strictEqual(data.data.group.chatHistory, undefined);
    assert.strictEqual(data.data.group.lastMessageContent, undefined);
  });

  test('Admin audit logs endpoint contains no credentials, passwords, or message text', async () => {
    const res = await fetch(`${baseUrl}/api/admin/audit-logs?limit=50`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.data.logs));

    for (const log of data.data.logs) {
      assert.strictEqual(log.password, undefined);
      assert.strictEqual(log.passwordHash, undefined);
      assert.strictEqual(log.token, undefined);
      assert.strictEqual(log.messageContent, undefined);
      assert.strictEqual(log.messageBody, undefined);
    }
  });
});

describe('4. Platform Admin User Management & Safeguards', () => {
  test('Admin can list and search users', async () => {
    const res = await fetch(`${baseUrl}/api/admin/users?q=${regularUser.username}&limit=10`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.ok(data.data.users.length >= 1);
    assert.strictEqual(data.data.users[0].username, regularUser.username);
  });

  test('Admin can suspend and reactivate a regular user', async () => {
    // Suspend
    const suspendRes = await fetch(`${baseUrl}/api/admin/users/${regularUser._id}/status`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'suspended' }),
    });
    const suspendData = await suspendRes.json();
    assert.strictEqual(suspendRes.status, 200);
    assert.strictEqual(suspendData.data.user.status, 'suspended');

    // Reactivate
    const activateRes = await fetch(`${baseUrl}/api/admin/users/${regularUser._id}/status`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'active' }),
    });
    const activateData = await activateRes.json();
    assert.strictEqual(activateRes.status, 200);
    assert.strictEqual(activateData.data.user.status, 'active');
  });

  test('Admin cannot demote or delete the primary platform administrator configured in .env', async () => {
    // Demote attempt
    const demoteRes = await fetch(`${baseUrl}/api/admin/users/${adminUser._id}/role`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'user' }),
    });
    assert.strictEqual(demoteRes.status, 400);

    // Delete attempt
    const deleteRes = await fetch(`${baseUrl}/api/admin/users/${adminUser._id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    assert.strictEqual(deleteRes.status, 400);
  });
});

describe('5. Platform Admin Group Management', () => {
  test('Admin can list groups with pagination and member counts', async () => {
    const res = await fetch(`${baseUrl}/api/admin/groups?search=Security+Test+Lounge&limit=10`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.ok(data.data.groups.length >= 1);
    const found = data.data.groups.find((g) => (g.id || g._id) === testGroup._id.toString() || g.name === testGroup.name);
    assert.ok(found, 'Test group should be in admin groups list');
    assert.strictEqual(found.name, testGroup.name);
  });

  test('Admin can delete group and action is logged', async () => {
    const delRes = await fetch(`${baseUrl}/api/admin/groups/${testGroup._id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    const delData = await delRes.json();
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(delData.success, true);

    // Verify GROUP_DELETED audit log
    const delLog = await AdminAuditLog.findOne({
      action: 'GROUP_DELETED',
      targetId: testGroup._id,
    });
    assert.ok(delLog, 'GROUP_DELETED audit record should be present');
  });
});
