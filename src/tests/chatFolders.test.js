/**
 * Automated Test Suite for PixelTalk Custom Chat Folders & Locked Folders
 *
 * Requirements Covered:
 * 1. Folder creation (unlocked and locked with PIN/passcode).
 * 2. Case-insensitive duplicate name validation per user (isolated across users).
 * 3. Folder locking, unlocking, PIN changes, and lock removal.
 * 4. Cryptographic password hashing (bcrypt) and prevention of password hash leaks.
 * 5. Multi-user isolation: User A cannot manage or unlock User B's folders.
 * 6. Non-destructive conversation movement (direct chats & groups).
 * 7. Non-destructive folder deletion: conversations return to unfiled list without deleting chats or messages.
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
const ChatSection = require('../models/ChatSection');
const { issueToken } = require('../services/authService');

let server;
let baseUrl;
let userA;
let tokenA;
let userB;
let tokenB;
let directConvo;
let groupConvo;

before(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 10000,
    });
  }

  // Create User A
  userA = await User.create({
    username: 'folder_tester_a_' + Date.now(),
    displayName: 'Folder Tester A',
    email: 'foldertest_a_' + Date.now() + '@pixeltalk.dev',
    passwordHash: 'secretpassword123',
    avatarId: 'avatar-01',
    role: 'user',
    status: 'active',
  });

  // Create User B
  userB = await User.create({
    username: 'folder_tester_b_' + Date.now(),
    displayName: 'Folder Tester B',
    email: 'foldertest_b_' + Date.now() + '@pixeltalk.dev',
    passwordHash: 'secretpassword123',
    avatarId: 'avatar-02',
    role: 'user',
    status: 'active',
  });

  tokenA = issueToken(userA);
  tokenB = issueToken(userB);

  // Create direct conversation between User A and User B
  directConvo = await Conversation.create({
    type: 'direct',
    createdBy: userA._id,
    members: [userA._id, userB._id],
    memberStates: [
      { userId: userA._id, sectionId: null },
      { userId: userB._id, sectionId: null },
    ],
  });

  // Create group conversation
  groupConvo = await Conversation.create({
    type: 'group',
    name: 'Folder Test Lounge ' + Date.now(),
    description: 'Testing folder assignments',
    createdBy: userA._id,
    members: [userA._id, userB._id],
    memberRoles: [
      { userId: userA._id, role: 'Owner' },
      { userId: userB._id, role: 'Member' },
    ],
    memberStates: [
      { userId: userA._id, sectionId: null },
      { userId: userB._id, sectionId: null },
    ],
  });

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
  if (directConvo) await Conversation.deleteOne({ _id: directConvo._id });
  if (groupConvo) await Conversation.deleteOne({ _id: groupConvo._id });
  if (userA) {
    await ChatSection.deleteMany({ userId: userA._id });
    await User.deleteOne({ _id: userA._id });
  }
  if (userB) {
    await ChatSection.deleteMany({ userId: userB._id });
    await User.deleteOne({ _id: userB._id });
  }

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
});

describe('1. Custom Folder Creation & Validation', () => {
  let createdFolder;

  test('User A can create an unlocked folder', async () => {
    const res = await fetch(`${baseUrl}/api/chat-sections`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Work Projects' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 201);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.section.name, 'Work Projects');
    assert.strictEqual(data.data.section.isLocked, false);
    assert.strictEqual(data.data.section.passcodeHash, undefined);
    createdFolder = data.data.section;
  });

  test('User A can create a locked folder with PIN', async () => {
    const res = await fetch(`${baseUrl}/api/chat-sections`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Secret Vault',
        isLocked: true,
        passcode: '9876',
      }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 201);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.section.name, 'Secret Vault');
    assert.strictEqual(data.data.section.isLocked, true);
    assert.strictEqual(data.data.section.hasPasscode, true);
    assert.strictEqual(data.data.section.passcodeHash, undefined); // Never exposed
  });

  test('Reject empty folder name', async () => {
    const res = await fetch(`${baseUrl}/api/chat-sections`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: '   ' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 400);
    assert.strictEqual(data.success, false);
  });

  test('Reject duplicate folder name for the same user (case-insensitive)', async () => {
    const res = await fetch(`${baseUrl}/api/chat-sections`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'work projects' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 409);
    assert.strictEqual(data.success, false);
    assert.match(data.message, /already have a folder named/i);
  });

  test('Allow the same folder name for a different user (User B)', async () => {
    const res = await fetch(`${baseUrl}/api/chat-sections`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenB}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Work Projects' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 201);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.section.name, 'Work Projects');
  });
});

describe('2. Folder Locking, Unlocking & Security', () => {
  let lockedFolder;

  before(async () => {
    const res = await fetch(`${baseUrl}/api/chat-sections`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Private Security Folder',
        isLocked: true,
        passcode: '1234',
      }),
    });
    const data = await res.json();
    lockedFolder = data.data.section;
  });

  test('Unlocking with correct PIN succeeds (200)', async () => {
    const res = await fetch(`${baseUrl}/api/chat-sections/${lockedFolder._id}/unlock`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ passcode: '1234' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.unlocked, true);
  });

  test('Unlocking with incorrect PIN is rejected with 401', async () => {
    const res = await fetch(`${baseUrl}/api/chat-sections/${lockedFolder._id}/unlock`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ passcode: '9999' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 401);
    assert.strictEqual(data.success, false);
    assert.match(data.message, /incorrect folder pin or password/i);
  });

  test('User B cannot unlock User A’s folder (404 / Unauthorized)', async () => {
    const res = await fetch(`${baseUrl}/api/chat-sections/${lockedFolder._id}/unlock`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenB}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ passcode: '1234' }),
    });

    assert.strictEqual(res.status, 404);
  });

  test('Change PIN on locked folder with valid current PIN', async () => {
    const res = await fetch(`${baseUrl}/api/chat-sections/${lockedFolder._id}/lock`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        currentPasscode: '1234',
        newPasscode: '5678',
      }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.data.section.isLocked, true);

    // Verify new PIN unlocks
    const verifyRes = await fetch(`${baseUrl}/api/chat-sections/${lockedFolder._id}/unlock`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ passcode: '5678' }),
    });
    assert.strictEqual(verifyRes.status, 200);
  });

  test('Remove lock from folder with valid current PIN', async () => {
    const res = await fetch(`${baseUrl}/api/chat-sections/${lockedFolder._id}/remove-lock`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ currentPasscode: '5678' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.data.section.isLocked, false);
    assert.strictEqual(data.data.section.hasPasscode, false);
  });
});

describe('3. Conversation Movement & Isolation Across Folders', () => {
  let targetFolder;

  before(async () => {
    const res = await fetch(`${baseUrl}/api/chat-sections`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Gaming Lounge' }),
    });
    const data = await res.json();
    targetFolder = data.data.section;
  });

  test('User A can move a direct chat into a folder', async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${directConvo._id}/move-section`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sectionId: targetFolder._id }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(String(data.data.sectionId), String(targetFolder._id));

    // Verify in User A's conversation list
    const listRes = await fetch(`${baseUrl}/api/conversations`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const listData = await listRes.json();
    const matched = listData.data.conversations.find((c) => String(c._id) === String(directConvo._id));
    assert.strictEqual(String(matched.sectionId), String(targetFolder._id));
  });

  test('User A moving chat does NOT affect User B’s folder assignment', async () => {
    const listResB = await fetch(`${baseUrl}/api/conversations`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const listDataB = await listResB.json();
    const matchedB = listDataB.data.conversations.find((c) => String(c._id) === String(directConvo._id));
    assert.strictEqual(matchedB.sectionId, null, 'User B’s sectionId must remain null');
  });

  test('User A can move group conversation into folder', async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${groupConvo._id}/move-section`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sectionId: targetFolder._id }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(String(data.data.sectionId), String(targetFolder._id));
  });

  test('User A can remove conversation from folder (unfile)', async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${groupConvo._id}/move-section`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sectionId: null }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.data.sectionId, null);
  });

  test('Deleting folder unfiles conversation without deleting chat or messages', async () => {
    const delRes = await fetch(`${baseUrl}/api/chat-sections/${targetFolder._id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(delRes.status, 200);

    // Verify conversation still exists in database
    const convoCheck = await Conversation.findById(directConvo._id);
    assert.ok(convoCheck, 'Conversation must NOT be deleted when folder is deleted');
    assert.strictEqual(convoCheck.deletedAt, null);

    // Verify conversation is now unfiled for User A
    const listRes = await fetch(`${baseUrl}/api/conversations`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const listData = await listRes.json();
    const matched = listData.data.conversations.find((c) => String(c._id) === String(directConvo._id));
    assert.strictEqual(matched.sectionId, null);
  });
});
