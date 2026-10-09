/**
 * Automated Test Suite for PixelTalk Room Join System Messages
 *
 * Requirements Covered:
 * 1. User joins public room -> exactly one "{username} joined the room" system message created.
 * 2. User joins private room after valid passcode -> exactly one system message created.
 * 3. Invalid passcode attempt fails with 403 -> ZERO system messages created.
 * 4. User accepts invitation -> exactly one system message created.
 * 5. Already a member calling join again (idempotent / refresh) -> ZERO duplicate system messages.
 * 6. Regular user cannot send fake/forged messageType='system' directly via message creation API.
 * 7. System messages persist in message history and are returned with correct chronological order and metadata.
 * 8. Unread message counts do NOT count system messages.
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
const GroupInvitation = require('../models/GroupInvitation');
const { issueToken } = require('../services/authService');
const conversationService = require('../services/conversationService');
const messageService = require('../services/messageService');

let server;
let baseUrl;
let userA;
let tokenA;
let userB;
let tokenB;
let userC;
let tokenC;

before(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 10000,
    });
  }

  const ts = Date.now();
  userA = await User.create({
    username: `shadab_${ts}`,
    displayName: 'Shadab Khan',
    email: `shadab_${ts}@pixeltalk.internal`,
    passwordHash: 'hashedPass123',
    avatarId: 'avatar-01',
    role: 'user',
    status: 'active',
  });
  tokenA = issueToken(userA);

  userB = await User.create({
    username: `rahul_${ts}`,
    displayName: 'Rahul Verma',
    email: `rahul_${ts}@pixeltalk.internal`,
    passwordHash: 'hashedPass123',
    avatarId: 'avatar-02',
    role: 'user',
    status: 'active',
  });
  tokenB = issueToken(userB);

  userC = await User.create({
    username: `muskan_${ts}`,
    displayName: 'Muskan Patel',
    email: `muskan_${ts}@pixeltalk.internal`,
    passwordHash: 'hashedPass123',
    avatarId: 'avatar-03',
    role: 'user',
    status: 'active',
  });
  tokenC = issueToken(userC);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (userA) await User.deleteOne({ _id: userA._id });
  if (userB) await User.deleteOne({ _id: userB._id });
  if (userC) await User.deleteOne({ _id: userC._id });
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
});

describe('1. Public & Private Room Join System Messages', () => {
  let publicRoom;
  let privateRoom;

  test('Room creator establishment generates initial join system message', async () => {
    const res = await fetch(`${baseUrl}/api/conversations/groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        name: `Public Lounge ${Date.now()}`,
        description: 'Open to all players',
        privacy: 'public',
      }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 201);
    assert.strictEqual(data.success, true);
    publicRoom = data.data.conversation;

    // Check system message was created for creator
    const msgs = await Message.find({ conversationId: publicRoom._id, messageType: 'system' });
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].content, `${userA.username} joined the room`);
    assert.strictEqual(msgs[0].systemEvent.eventType, 'member_joined');
    assert.strictEqual(String(msgs[0].systemEvent.actorId), String(userA._id));
  });

  test('User B joins public room -> exactly one join system message created', async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${publicRoom._id}/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({}),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.ok(data.data.conversation);

    // Verify messages for this conversation
    const msgs = await Message.find({ conversationId: publicRoom._id, messageType: 'system' }).sort({ createdAt: 1 });
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[1].content, `${userB.username} joined the room`);
    assert.strictEqual(msgs[1].systemEvent.eventType, 'member_joined');
    assert.strictEqual(String(msgs[1].systemEvent.actorId), String(userB._id));
    assert.strictEqual(msgs[1].systemEvent.actorUsername, userB.username);
  });

  test('User B joins public room AGAIN (idempotent / refresh) -> ZERO duplicate join messages', async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${publicRoom._id}/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({}),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.systemMessage, null);

    // Total system messages must remain exactly 2
    const msgs = await Message.find({ conversationId: publicRoom._id, messageType: 'system' });
    assert.strictEqual(msgs.length, 2);
  });

  test('Private room with passcode creation and unauthorized join rejection', async () => {
    // User A creates private room with passcode 'pixelPass123'
    const res = await fetch(`${baseUrl}/api/conversations/groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        name: `Secret Lounge ${Date.now()}`,
        description: 'Locked room',
        privacy: 'private',
        passcode: 'pixelPass123',
      }),
    });
    const data = await res.json();
    assert.strictEqual(res.status, 201);
    privateRoom = data.data.conversation;

    // User C tries to join with wrong passcode
    const failRes = await fetch(`${baseUrl}/api/conversations/${privateRoom._id}/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenC}`,
      },
      body: JSON.stringify({ passcode: 'wrongPasscode' }),
    });
    assert.strictEqual(failRes.status, 403);

    // Verify no system message for User C
    const msgs = await Message.find({ conversationId: privateRoom._id, senderId: userC._id });
    assert.strictEqual(msgs.length, 0);
  });

  test('User C joins private room with correct passcode -> exactly one join system message', async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${privateRoom._id}/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenC}`,
      },
      body: JSON.stringify({ passcode: 'pixelPass123' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.ok(data.data.systemMessage);
    assert.strictEqual(data.data.systemMessage.content, `${userC.username} joined the room`);

    // Verify in database
    const userCMsg = await Message.findOne({
      conversationId: privateRoom._id,
      senderId: userC._id,
      messageType: 'system',
    });
    assert.ok(userCMsg);
    assert.strictEqual(userCMsg.content, `${userC.username} joined the room`);
    assert.strictEqual(userCMsg.systemEvent.eventType, 'member_joined');
  });
});

describe('2. Group Invitation Acceptance Join Messages', () => {
  let inviteRoom;
  let invitationId;

  test('User A creates room and invites User B', async () => {
    const createRes = await fetch(`${baseUrl}/api/conversations/groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        name: `Invite Lounge ${Date.now()}`,
        privacy: 'invite',
      }),
    });
    const createData = await createRes.json();
    inviteRoom = createData.data.conversation;

    // Send invitation to User B
    const inviteRes = await fetch(`${baseUrl}/api/conversations/${inviteRoom._id}/invitations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ userIds: [userB._id] }),
    });
    const inviteData = await inviteRes.json();
    assert.strictEqual(inviteRes.status, 201);
    invitationId = inviteData.data.invitations[0]._id;
  });

  test('User B accepts invitation -> exactly one join system message created', async () => {
    const respondRes = await fetch(`${baseUrl}/api/conversations/invitations/${invitationId}/respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ action: 'ACCEPT' }),
    });

    const data = await respondRes.json();
    assert.strictEqual(respondRes.status, 200);
    assert.strictEqual(data.success, true);
    assert.ok(data.data.systemMessage);
    assert.strictEqual(data.data.systemMessage.content, `${userB.username} joined the room`);

    // Verify in database
    const userBMsg = await Message.findOne({
      conversationId: inviteRoom._id,
      senderId: userB._id,
      messageType: 'system',
    });
    assert.ok(userBMsg);
    assert.strictEqual(userBMsg.content, `${userB.username} joined the room`);
  });
});

describe('3. Security, Immutability & Chat History Integrity', () => {
  let testRoom;

  before(async () => {
    const convo = await Conversation.create({
      type: 'group',
      name: `Security Integrity Room ${Date.now()}`,
      nameNormalized: `security integrity room ${Date.now()}`.toLowerCase(),
      members: [userA._id, userB._id],
      admins: [userA._id],
      createdBy: userA._id,
    });
    testRoom = convo;
  });

  test('Client cannot impersonate or forge system messages via message creation API', async () => {
    const res = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({
        conversationId: testRoom._id,
        content: 'Malicious system message attempt',
        messageType: 'system',
      }),
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.success, false);
  });

  test('Message list endpoint returns system messages in history with systemEvent field', async () => {
    // Generate join message
    await messageService.createSystemJoinMessage({
      conversationId: testRoom._id,
      actor: userB,
    });

    // Send normal text message
    await messageService.create({
      conversationId: testRoom._id,
      senderId: userB._id,
      content: 'Hello everyone!',
      messageType: 'text',
    });

    const listRes = await fetch(`${baseUrl}/api/messages/${testRoom._id}`, {
      headers: {
        Authorization: `Bearer ${tokenB}`,
      },
    });

    const data = await listRes.json();
    assert.strictEqual(listRes.status, 200);
    assert.strictEqual(data.success, true);
    assert.ok(data.data.messages.length >= 2);

    const systemMsg = data.data.messages.find((m) => m.messageType === 'system');
    assert.ok(systemMsg);
    assert.strictEqual(systemMsg.content, `${userB.username} joined the room`);
    assert.strictEqual(systemMsg.systemEvent.eventType, 'member_joined');
    assert.strictEqual(systemMsg.systemEvent.actorUsername, userB.username);
  });

  test('Unread message count does NOT include system messages', async () => {
    // Create new test conversation with User A and User B
    const room = await Conversation.create({
      type: 'group',
      name: `Unread Check Room ${Date.now()}`,
      nameNormalized: `unread check room ${Date.now()}`.toLowerCase(),
      members: [userA._id, userB._id],
      admins: [userA._id],
      createdBy: userA._id,
    });

    // User A creates system message
    await messageService.createSystemJoinMessage({
      conversationId: room._id,
      actor: userA,
    });

    // Check unread count for User B via listForUser
    const inboxList = await conversationService.listForUser(userB._id);
    const item = inboxList.find((c) => String(c._id) === String(room._id));
    assert.ok(item);
    assert.strictEqual(item.unreadCount, 0); // System message does NOT increment unread counter
  });
});
