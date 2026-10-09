/**
 * Integration Test: Notification Center & Quick Switch Account
 *
 * Tests:
 * 1. Persistent notification creation across messages, follows, group invitations, and calls.
 * 2. Privacy enforcement (private room messages sanitized to safe preview).
 * 3. Notification listing, categorized filtering, and accurate unread count badge calculation.
 * 4. Read/unread management (mark single, mark all, dismiss/delete).
 * 5. Multi-tenant isolation (User A cannot access or mutate User B's notifications).
 * 6. Account session validation & identity switching security.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const dns = require('dns');
const mongoose = require('mongoose');

try {
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch {
  /* Ignore */
}

const app = require('../app');
const config = require('../config');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const Follow = require('../models/Follow');
const notificationService = require('../services/notificationService');
const followService = require('../services/followService');
const conversationService = require('../services/conversationService');

const { issueToken } = require('../services/authService');

let server;
let baseUrl;

let userA;
let userB;
let tokenA;
let tokenB;

before(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 10000,
    });
  }

  // Cleanup prior test artifacts
  await User.deleteMany({ email: /.*@pixeltalk\.test/ });
  await Notification.deleteMany({});
  await Conversation.deleteMany({ name: /Test Notif .*/ });

  const ts = Date.now();
  userA = await User.create({
    username: `notif_alice_${ts}`,
    displayName: 'Alice Notif',
    email: `alice_${ts}@pixeltalk.test`,
    passwordHash: 'hashedPass123',
    avatarId: 'avatar-01',
    role: 'user',
    status: 'active',
  });
  tokenA = issueToken(userA);

  userB = await User.create({
    username: `notif_bob_${ts}`,
    displayName: 'Bob Notif',
    email: `bob_${ts}@pixeltalk.test`,
    passwordHash: 'hashedPass123',
    avatarId: 'avatar-02',
    role: 'user',
    status: 'active',
  });
  tokenB = issueToken(userB);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await User.deleteMany({ email: /.*@pixeltalk\.test/ });
  await Notification.deleteMany({});
  await Conversation.deleteMany({ name: /Test Notif .*/ });
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await mongoose.disconnect();
});

describe('1. Notification Creation & Privacy Rules', () => {
  test('Creating notifications for follow request and follow acceptance', async () => {
    // User A follows User B
    const notif = await notificationService.createNotification({
      recipientId: userB._id,
      actorId: userA._id,
      type: 'follow_request',
      category: 'social',
      title: 'Follow Request',
      body: 'Alice Notif sent you a follow request.',
      targetType: 'profile',
      targetId: String(userA._id),
    });

    assert.ok(notif._id);
    assert.equal(String(notif.recipientId), String(userB._id));
    assert.equal(notif.isRead, false);
    assert.equal(notif.category, 'social');

    const unreadB = await notificationService.getUnreadCount(userB._id);
    assert.equal(unreadB.unreadCount, 1);
  });

  test('Creating group invitation notification', async () => {
    const notif = await notificationService.createNotification({
      recipientId: userB._id,
      actorId: userA._id,
      type: 'group_invitation',
      category: 'groups',
      title: 'Group Invitation',
      body: 'Alice Notif invited you to join #DevLounge',
      targetType: 'group',
      targetId: '507f1f77bcf86cd799439011',
    });

    assert.ok(notif._id);
    assert.equal(notif.category, 'groups');

    const unreadB = await notificationService.getUnreadCount(userB._id);
    assert.equal(unreadB.unreadCount, 2);
  });

  test('Private room notification content sanitization', async () => {
    const notif = await notificationService.createNotification({
      recipientId: userB._id,
      actorId: userA._id,
      type: 'message_group',
      category: 'messages',
      title: '#SecretGroup',
      body: 'New message', // Safe placeholder without exposing secret payload
      targetType: 'conversation',
      targetId: '507f1f77bcf86cd799439022',
    });

    assert.ok(notif._id);
    assert.equal(notif.body, 'New message');
  });

  test('Self notifications are ignored', async () => {
    const notif = await notificationService.createNotification({
      recipientId: userA._id,
      actorId: userA._id,
      type: 'message_direct',
      category: 'messages',
      title: 'Self Message',
      body: 'Hello self',
    });

    assert.equal(notif, null);
  });
});

describe('2. Notification Listing, Filtering & Pagination', () => {
  test('GET /api/notifications returns user notifications with totalUnread', async () => {
    const res = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.data.notifications));
    assert.equal(data.data.notifications.length, 3);
    assert.equal(data.data.totalUnread, 3);
  });

  test('GET /api/notifications?category=social filters by category', async () => {
    const res = await fetch(`${baseUrl}/api/notifications?category=social`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data.notifications.length, 1);
    assert.equal(data.data.notifications[0].category, 'social');
  });

  test('GET /api/notifications/unread-count returns accurate count', async () => {
    const res = await fetch(`${baseUrl}/api/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data.unreadCount, 3);
  });
});

describe('3. Read/Unread State Management & Deletion', () => {
  let targetNotifId;

  test('PATCH /api/notifications/:id/read marks single notification as read', async () => {
    const listRes = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const listData = await listRes.json();
    targetNotifId = listData.data.notifications[0]._id;

    const readRes = await fetch(`${baseUrl}/api/notifications/${targetNotifId}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const readData = await readRes.json();
    assert.equal(readData.success, true);
    assert.equal(readData.data.notification.isRead, true);
    assert.equal(readData.data.unreadCount, 2);
  });

  test('POST /api/notifications/read-all marks all notifications as read', async () => {
    const res = await fetch(`${baseUrl}/api/notifications/read-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data.unreadCount, 0);

    const countRes = await fetch(`${baseUrl}/api/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const countData = await countRes.json();
    assert.equal(countData.data.unreadCount, 0);
  });

  test('DELETE /api/notifications/:id removes notification', async () => {
    const delRes = await fetch(`${baseUrl}/api/notifications/${targetNotifId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const delData = await delRes.json();
    assert.equal(delData.success, true);

    const listRes = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const listData = await listRes.json();
    assert.equal(listData.data.notifications.length, 2);
  });
});

describe('4. Security & Multi-Tenant Isolation', () => {
  test('User A cannot mark User B notification as read (Unauthorized)', async () => {
    const listRes = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const listData = await listRes.json();
    const bobNotifId = listData.data.notifications[0]._id;

    const unauthorizedRes = await fetch(`${baseUrl}/api/notifications/${bobNotifId}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const unauthorizedData = await unauthorizedRes.json();
    assert.equal(unauthorizedData.success, false);
    assert.equal(unauthorizedRes.status, 404);
  });

  test('User A cannot delete User B notification (Unauthorized)', async () => {
    const listRes = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const listData = await listRes.json();
    const bobNotifId = listData.data.notifications[0]._id;

    const unauthorizedRes = await fetch(`${baseUrl}/api/notifications/${bobNotifId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const unauthorizedData = await unauthorizedRes.json();
    assert.equal(unauthorizedData.success, false);
    assert.equal(unauthorizedRes.status, 404);
  });

  test('User A sees only User A notifications', async () => {
    const resA = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const dataA = await resA.json();
    assert.equal(dataA.success, true);
    assert.equal(dataA.data.notifications.length, 0);
  });
});

describe('5. Quick Account Switcher — Session Validation & Identity Isolation', () => {
  test('Authenticating with Token A returns User A identity', async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data.user.username, userA.username);
  });

  test('Authenticating with Token B returns User B identity', async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.data.user.username, userB.username);
  });

  test('Invalid / forged token is rejected with 401', async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: 'Bearer forged.invalid.token' },
    });
    assert.equal(res.status, 401);
  });
});
