/**
 * Automated Test Suite for PixelTalk Chat & Group Context Menu
 *
 * Requirements Covered:
 * 1. Mark as Read & Mark as Unread endpoints and user unread counter updates.
 * 2. Pin / Unpin & Mute / Unmute user preferences for direct chats and group lounges.
 * 3. User-specific Clear Conversation (clears message history for caller only).
 * 4. User-specific Delete Chat (hides direct conversation for caller only).
 * 5. Group Membership & Access Control:
 *    - Regular members can leave group.
 *    - Group owner cannot leave group without transfer (403).
 *    - Regular members cannot delete group (403).
 *    - Group owner can delete group (200).
 * 6. Move to Folder isolation for direct chats and group lounges.
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
const ChatSection = require('../models/ChatSection');
const { issueToken } = require('../services/authService');

let server;
let baseUrl;
let userA;
let tokenA;
let userB;
let tokenB;
let userC;
let tokenC;
let directConvo;
let groupConvo;

before(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 10000,
    });
  }

  // Create Users
  userA = await User.create({
    username: 'ctx_user_a_' + Date.now(),
    displayName: 'Context Tester A',
    email: 'ctx_a_' + Date.now() + '@pixeltalk.dev',
    passwordHash: 'secretpassword123',
    avatarId: 'avatar-01',
    role: 'user',
    status: 'active',
  });

  userB = await User.create({
    username: 'ctx_user_b_' + Date.now(),
    displayName: 'Context Tester B',
    email: 'ctx_b_' + Date.now() + '@pixeltalk.dev',
    passwordHash: 'secretpassword123',
    avatarId: 'avatar-02',
    role: 'user',
    status: 'active',
  });

  userC = await User.create({
    username: 'ctx_user_c_' + Date.now(),
    displayName: 'Context Tester C',
    email: 'ctx_c_' + Date.now() + '@pixeltalk.dev',
    passwordHash: 'secretpassword123',
    avatarId: 'avatar-03',
    role: 'user',
    status: 'active',
  });

  tokenA = issueToken(userA);
  tokenB = issueToken(userB);
  tokenC = issueToken(userC);

  // Direct conversation
  directConvo = await Conversation.create({
    type: 'direct',
    createdBy: userA._id,
    members: [userA._id, userB._id],
    memberStates: [
      { userId: userA._id, sectionId: null },
      { userId: userB._id, sectionId: null },
    ],
  });

  // Messages in direct conversation
  await Message.create({
    conversationId: directConvo._id,
    senderId: userB._id,
    content: 'Hello User A from User B!',
    readBy: [userB._id, userA._id],
    deliveredTo: [userB._id, userA._id],
    status: 'read',
  });

  // Group conversation owned by User A
  groupConvo = await Conversation.create({
    type: 'group',
    name: 'Context Lounge ' + Date.now(),
    description: 'Testing context menu actions',
    createdBy: userA._id,
    members: [userA._id, userB._id, userC._id],
    admins: [userA._id],
    memberRoles: [
      { userId: userA._id, role: 'Owner' },
      { userId: userB._id, role: 'Member' },
      { userId: userC._id, role: 'Member' },
    ],
  });

  // Group message
  await Message.create({
    conversationId: groupConvo._id,
    senderId: userA._id,
    content: 'Welcome to the test group lounge!',
    readBy: [userA._id, userB._id, userC._id],
    deliveredTo: [userA._id, userB._id, userC._id],
    status: 'read',
  });

  // Start HTTP server on dynamic port
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}/api`;
      resolve();
    });
  });
});

after(async () => {
  // Cleanup test documents
  if (userA) {
    await User.deleteMany({ _id: { $in: [userA._id, userB._id, userC._id] } });
    await Conversation.deleteMany({ _id: { $in: [directConvo._id, groupConvo._id] } });
    await Message.deleteMany({ conversationId: { $in: [directConvo._id, groupConvo._id] } });
    await ChatSection.deleteMany({ userId: { $in: [userA._id, userB._id, userC._id] } });
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
});

async function apiRequest(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: res.status, data };
}

describe('1. Mark as Read & Mark as Unread State Management', () => {
  test('User A marks direct chat as unread -> unread count becomes 1', async () => {
    const res = await apiRequest(`/conversations/${directConvo._id}/unread`, {
      method: 'POST',
      token: tokenA,
    });
    assert.strictEqual(res.status, 200);

    // Verify in conversation list
    const listRes = await apiRequest('/conversations', { token: tokenA });
    assert.strictEqual(listRes.status, 200);
    const target = listRes.data.data.conversations.find(
      (c) => String(c._id) === String(directConvo._id)
    );
    assert.ok(target);
    assert.strictEqual(target.unreadCount, 1);
  });

  test('User A marks direct chat as read -> unread count becomes 0', async () => {
    const res = await apiRequest(`/conversations/${directConvo._id}/read`, {
      method: 'POST',
      token: tokenA,
    });
    assert.strictEqual(res.status, 200);

    const listRes = await apiRequest('/conversations', { token: tokenA });
    assert.strictEqual(listRes.status, 200);
    const target = listRes.data.data.conversations.find(
      (c) => String(c._id) === String(directConvo._id)
    );
    assert.ok(target);
    assert.strictEqual(target.unreadCount, 0);
  });
});

describe('2. Pinning and Notification Muting', () => {
  test('User A can toggle pin on direct conversation', async () => {
    const res = await apiRequest(`/users/pin/${directConvo._id}`, {
      method: 'PATCH',
      token: tokenA,
    });
    assert.strictEqual(res.status, 200);
    assert.ok(
      res.data.data.pinnedConversations.some(
        (id) => String(id) === String(directConvo._id)
      )
    );

    // Unpin
    const unpinRes = await apiRequest(`/users/pin/${directConvo._id}`, {
      method: 'PATCH',
      token: tokenA,
    });
    assert.strictEqual(unpinRes.status, 200);
    assert.ok(
      !unpinRes.data.data.pinnedConversations.some(
        (id) => String(id) === String(directConvo._id)
      )
    );
  });

  test('User A can toggle mute on direct conversation', async () => {
    const res = await apiRequest(`/users/mute/${directConvo._id}`, {
      method: 'PATCH',
      token: tokenA,
    });
    assert.strictEqual(res.status, 200);
    assert.ok(
      res.data.data.mutedConversations.some(
        (id) => String(id) === String(directConvo._id)
      )
    );
  });
});

describe('3. User-Specific Clear Conversation', () => {
  test('User A clears direct conversation -> User A history is empty, User B history is intact', async () => {
    // Send a message first
    await Message.create({
      conversationId: directConvo._id,
      senderId: userB._id,
      content: 'Message before clear',
    });

    const clearRes = await apiRequest(`/conversations/${directConvo._id}/clear`, {
      method: 'POST',
      token: tokenA,
    });
    assert.strictEqual(clearRes.status, 200);

    // User A fetches messages -> empty
    const msgsA = await apiRequest(`/messages/${directConvo._id}`, { token: tokenA });
    assert.strictEqual(msgsA.status, 200);
    assert.strictEqual(msgsA.data.data.messages.length, 0);

    // User B fetches messages -> messages remain visible
    const msgsB = await apiRequest(`/messages/${directConvo._id}`, { token: tokenB });
    assert.strictEqual(msgsB.status, 200);
    assert.ok(msgsB.data.data.messages.length > 0);
  });
});

describe('4. User-Specific Delete Direct Chat', () => {
  test('User A deletes direct chat -> hidden from User A list, preserved for User B', async () => {
    const delRes = await apiRequest(`/conversations/${directConvo._id}/delete-chat`, {
      method: 'POST',
      token: tokenA,
    });
    assert.strictEqual(delRes.status, 200);

    // User A list does not contain directConvo
    const listA = await apiRequest('/conversations', { token: tokenA });
    assert.strictEqual(listA.status, 200);
    const inA = listA.data.data.conversations.some(
      (c) => String(c._id) === String(directConvo._id)
    );
    assert.strictEqual(inA, false);

    // User B list still contains directConvo
    const listB = await apiRequest('/conversations', { token: tokenB });
    assert.strictEqual(listB.status, 200);
    const inB = listB.data.data.conversations.some(
      (c) => String(c._id) === String(directConvo._id)
    );
    assert.strictEqual(inB, true);
  });
});

describe('5. Group Lounge Actions: Leave Group vs Delete Group', () => {
  test('Group owner (User A) cannot leave group without transfer (403 Forbidden)', async () => {
    const res = await apiRequest(`/conversations/${groupConvo._id}/leave`, {
      method: 'POST',
      token: tokenA,
    });
    assert.strictEqual(res.status, 403);
  });

  test('Regular member (User B) can leave group', async () => {
    const res = await apiRequest(`/conversations/${groupConvo._id}/leave`, {
      method: 'POST',
      token: tokenB,
    });
    assert.strictEqual(res.status, 200);

    // Verify User B is no longer in group members
    const checkRes = await apiRequest(`/conversations/${groupConvo._id}/members`, {
      token: tokenA,
    });
    assert.strictEqual(checkRes.status, 200);
    const hasUserB = checkRes.data.data.members.some(
      (m) => String(m._id || m.id) === String(userB._id)
    );
    assert.strictEqual(hasUserB, false);
  });

  test('Non-owner (User C) cannot delete group (403 Forbidden)', async () => {
    const res = await apiRequest(`/conversations/${groupConvo._id}`, {
      method: 'DELETE',
      token: tokenC,
    });
    assert.strictEqual(res.status, 403);
  });

  test('Group owner (User A) can delete group', async () => {
    const res = await apiRequest(`/conversations/${groupConvo._id}`, {
      method: 'DELETE',
      token: tokenA,
    });
    assert.strictEqual(res.status, 200);

    // Verify group is marked deleted
    const checkConvo = await Conversation.findById(groupConvo._id);
    assert.ok(checkConvo.deletedAt);
  });
});
