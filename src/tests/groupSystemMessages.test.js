/**
 * ============================================================
 * TEST SUITE: COMPLETE GROUP SYSTEM MESSAGES & ACTIVITY EVENTS
 * ============================================================
 *
 * Verifies:
 * 1. Membership events (join, leave, admin remove, unauthorized remove rejection)
 * 2. Role assignment & Ownership transfer system events
 * 3. Group profile & identity changes (name, description, avatar photo, photo removal)
 * 4. Group settings changes (adminOnlyChat, invitePermission, privacy)
 * 5. Idempotency & Unchanged settings produce ZERO extra messages
 * 6. Message history integrity & unread count separation
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const conversationService = require('../services/conversationService');
const messageService = require('../services/messageService');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/pixeltalk_test_group_events';

let userOwner, userAdmin, userMember, userOther;

test.before(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(MONGO_URI);
  }
  await Promise.all([
    User.deleteMany({ email: /@groupevents-test\.com$/ }),
    Conversation.deleteMany({ name: /GroupEvents/i }),
  ]);

  userOwner = await User.create({
    username: 'owner_ge',
    displayName: 'Owner Player',
    email: 'owner@groupevents-test.com',
    avatarId: 'avatar-01',
    passwordHash: 'dummyHash',
    status: 'active',
  });

  userAdmin = await User.create({
    username: 'admin_ge',
    displayName: 'Admin Player',
    email: 'admin@groupevents-test.com',
    avatarId: 'avatar-02',
    passwordHash: 'dummyHash',
    status: 'active',
  });

  userMember = await User.create({
    username: 'member_ge',
    displayName: 'Member Player',
    email: 'member@groupevents-test.com',
    avatarId: 'avatar-03',
    passwordHash: 'dummyHash',
    status: 'active',
  });

  userOther = await User.create({
    username: 'other_ge',
    displayName: 'Other Player',
    email: 'other@groupevents-test.com',
    avatarId: 'avatar-04',
    passwordHash: 'dummyHash',
    status: 'active',
  });
});

test.after(async () => {
  await Promise.all([
    User.deleteMany({ email: /@groupevents-test\.com$/ }),
    Conversation.deleteMany({ name: /GroupEvents/i }),
    Message.deleteMany({}),
  ]);
  await mongoose.disconnect();
});

test('1. Membership System Events: Join, Leave, and Remove', async (t) => {
  let group;

  await t.test('Creating group creates initial join message for creator', async () => {
    group = await conversationService.createGroup(userOwner, {
      name: 'GroupEvents Lounge',
      description: 'Initial description',
      privacy: 'public',
    });

    const messages = await Message.find({ conversationId: group._id, messageType: 'system' });
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].systemEvent.eventType, 'member_joined');
    assert.strictEqual(messages[0].content, 'owner_ge joined the room');
  });

  await t.test('User joins public group -> exactly one member_joined message', async () => {
    const joinRes = await conversationService.joinGroup(userMember, group._id);
    assert.ok(joinRes.newlyJoined);
    assert.ok(joinRes.systemMessage);
    assert.strictEqual(joinRes.systemMessage.systemEvent.eventType, 'member_joined');
    assert.strictEqual(joinRes.systemMessage.content, 'member_ge joined the room');

    const totalSystemMsgs = await Message.find({ conversationId: group._id, messageType: 'system' });
    assert.strictEqual(totalSystemMsgs.length, 2);
  });

  await t.test('Rejoining or refreshing does NOT duplicate join message', async () => {
    const repeatJoin = await conversationService.joinGroup(userMember, group._id);
    assert.strictEqual(repeatJoin.newlyJoined, false);
    assert.strictEqual(repeatJoin.systemMessage, null);

    const totalSystemMsgs = await Message.find({ conversationId: group._id, messageType: 'system' });
    assert.strictEqual(totalSystemMsgs.length, 2);
  });

  await t.test('Unauthorized non-admin removal is rejected and generates 0 system messages', async () => {
    await assert.rejects(
      async () => {
        await conversationService.removeMember(userMember._id, group._id, userOwner._id);
      },
      { statusCode: 403 },
    );

    const totalSystemMsgs = await Message.find({ conversationId: group._id, messageType: 'system' });
    assert.strictEqual(totalSystemMsgs.length, 2);
  });

  await t.test('Admin removes member -> member_removed system message identifies target and actor', async () => {
    // Add userOther to group first
    await conversationService.joinGroup(userOther, group._id);

    const removeRes = await conversationService.removeMember(userOwner._id, group._id, userOther._id);
    assert.ok(removeRes.systemMessage);
    assert.strictEqual(removeRes.systemMessage.systemEvent.eventType, 'member_removed');
    assert.strictEqual(
      removeRes.systemMessage.content,
      'Other Player was removed from the room by Owner Player',
    );
    assert.strictEqual(String(removeRes.systemMessage.systemEvent.actorId?._id || removeRes.systemMessage.systemEvent.actorId), String(userOwner._id));
    assert.strictEqual(String(removeRes.systemMessage.systemEvent.targetUserId?._id || removeRes.systemMessage.systemEvent.targetUserId), String(userOther._id));
  });

  await t.test('Member leaves voluntarily -> member_left system message is created', async () => {
    const leaveRes = await conversationService.leave(userMember, group._id);
    assert.ok(leaveRes.systemMessage);
    assert.strictEqual(leaveRes.systemMessage.systemEvent.eventType, 'member_left');
    assert.strictEqual(leaveRes.systemMessage.content, 'Member Player left the room');
  });
});

test('2. Role Assignment & Ownership Transfer System Events', async (t) => {
  let group;

  await t.test('Setup group with Owner and Member', async () => {
    group = await conversationService.createGroup(userOwner, {
      name: 'GroupEvents Roles',
      privacy: 'public',
    });
    await conversationService.joinGroup(userAdmin, group._id);
    await conversationService.joinGroup(userMember, group._id);
  });

  await t.test('Owner promotes Member to Admin -> member_role_changed system message', async () => {
    const result = await conversationService.updateMemberRole(userOwner._id, group._id, userMember._id, 'Admin');
    assert.ok(result.systemMessage);
    assert.strictEqual(result.systemMessage.systemEvent.eventType, 'member_role_changed');
    assert.strictEqual(result.systemMessage.content, 'Member Player was promoted to admin by Owner Player');
  });

  await t.test('Owner demotes Admin to Moderator -> member_role_changed system message', async () => {
    const result = await conversationService.updateMemberRole(userOwner._id, group._id, userMember._id, 'Moderator');
    assert.ok(result.systemMessage);
    assert.strictEqual(result.systemMessage.systemEvent.eventType, 'member_role_changed');
    assert.strictEqual(result.systemMessage.content, 'Member Player was demoted to moderator by Owner Player');
  });

  await t.test('Owner transfers group ownership to Admin -> owner_transferred system message', async () => {
    const result = await conversationService.updateMemberRole(userOwner._id, group._id, userAdmin._id, 'Owner');
    assert.ok(result.systemMessage);
    assert.strictEqual(result.systemMessage.systemEvent.eventType, 'owner_transferred');
    assert.strictEqual(result.systemMessage.content, 'Owner Player transferred group ownership to Admin Player');
  });
});

test('3. Group Profile, Identity & Settings Changes', async (t) => {
  let group;

  await t.test('Setup group for settings testing', async () => {
    group = await conversationService.createGroup(userOwner, {
      name: 'GroupEvents Settings',
      description: 'Original description',
      privacy: 'public',
    });
  });

  await t.test('Group name changed -> group_name_changed system message with new name', async () => {
    const result = await conversationService.updateSettings(userOwner._id, group._id, {
      name: 'GroupEvents Renamed',
    });
    assert.strictEqual(result.systemMessages.length, 1);
    assert.strictEqual(result.systemMessages[0].systemEvent.eventType, 'group_name_changed');
    assert.strictEqual(
      result.systemMessages[0].content,
      'Owner Player changed the group name to "GroupEvents Renamed"',
    );
  });

  await t.test('Group description changed -> group_description_changed system message', async () => {
    const result = await conversationService.updateSettings(userOwner._id, group._id, {
      description: 'Updated awesome description',
    });
    assert.strictEqual(result.systemMessages.length, 1);
    assert.strictEqual(result.systemMessages[0].systemEvent.eventType, 'group_description_changed');
    assert.strictEqual(result.systemMessages[0].content, 'Owner Player updated the group description');
  });

  await t.test('Group photo changed -> group_photo_changed system message', async () => {
    const result = await conversationService.updateSettings(userOwner._id, group._id, {
      avatarUrl: 'https://res.cloudinary.com/pixeltalk/image/upload/v123/new_photo.png',
      avatarPublicId: 'pixeltalk/group_avatars/new_photo',
    });
    assert.strictEqual(result.systemMessages.length, 1);
    assert.strictEqual(result.systemMessages[0].systemEvent.eventType, 'group_photo_changed');
    assert.strictEqual(result.systemMessages[0].content, 'Owner Player updated the group photo');
  });

  await t.test('Group photo removed -> group_photo_removed system message', async () => {
    const result = await conversationService.updateSettings(userOwner._id, group._id, {
      avatarUrl: '',
      avatarPublicId: '',
    });
    assert.strictEqual(result.systemMessages.length, 1);
    assert.strictEqual(result.systemMessages[0].systemEvent.eventType, 'group_photo_removed');
    assert.strictEqual(result.systemMessages[0].content, 'Owner Player removed the group photo');
  });

  await t.test('Group settings changed (adminOnlyChat) -> group_settings_changed system message', async () => {
    const result = await conversationService.updateSettings(userOwner._id, group._id, {
      settings: { adminOnlyChat: true },
    });
    assert.strictEqual(result.systemMessages.length, 1);
    assert.strictEqual(result.systemMessages[0].systemEvent.eventType, 'group_settings_changed');
    assert.strictEqual(result.systemMessages[0].content, 'Owner Player enabled admin-only messaging');
  });

  await t.test('Saving unchanged settings produces ZERO system messages (idempotent)', async () => {
    const result = await conversationService.updateSettings(userOwner._id, group._id, {
      settings: { adminOnlyChat: true },
    });
    assert.strictEqual(result.systemMessages.length, 0);
  });

  await t.test('Group privacy changed -> group_settings_changed system message', async () => {
    const result = await conversationService.updateSettings(userOwner._id, group._id, {
      privacy: 'invite',
    });
    assert.strictEqual(result.systemMessages.length, 1);
    assert.strictEqual(result.systemMessages[0].systemEvent.eventType, 'group_settings_changed');
    assert.strictEqual(result.systemMessages[0].content, 'Owner Player updated the group privacy to invite');
  });
});

test('4. Chat History, Unread Message Integrity & Permissions', async (t) => {
  let group;

  await t.test('Setup group and send normal message vs system message', async () => {
    group = await conversationService.createGroup(userOwner, {
      name: 'GroupEvents Unread',
      privacy: 'public',
    });
    await conversationService.joinGroup(userMember, group._id);

    // Send a normal text message from Owner
    await messageService.create({
      conversationId: group._id,
      senderId: userOwner._id,
      content: 'Hello everyone!',
    });
  });

  await t.test('Unread count calculation ignores system messages', async () => {
    const convos = await conversationService.listForUser(userMember._id);
    const targetConvo = convos.find((c) => String(c._id) === String(group._id));
    assert.ok(targetConvo);
    // There is 1 normal unread message and multiple system messages (joins), unread count must be exactly 1
    assert.strictEqual(targetConvo.unreadCount, 1);
  });

  await t.test('Historical system messages are returned with systemEvent metadata in message list', async () => {
    const history = await messageService.listForConversation(group._id, userMember._id);
    const systemMsgs = history.messages.filter((m) => m.messageType === 'system');
    assert.ok(systemMsgs.length >= 2);
    for (const sm of systemMsgs) {
      assert.ok(sm.systemEvent);
      assert.ok(sm.systemEvent.eventType);
    }
  });
});
