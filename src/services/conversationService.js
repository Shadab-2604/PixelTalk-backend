/**
 * Conversation Service
 *
 * Responsibility:
 * Encapsulates business logic for direct conversations and community group lounges:
 * - Querying and sorting user conversation inboxes with last-message projections
 * - Idempotent direct conversation find-or-create logic
 * - Group room creation, privacy enforcement (public, invite, passcode-protected)
 * - Member role hierarchy management (Owner, Admin, Moderator, Member)
 * - Passcode verification and hashing
 *
 * CONNECTED MODULES:
 * - Controllers: backend/src/controllers/conversationController.js
 * - Sockets: backend/src/sockets/index.js (room routing & membership checks)
 * - Models: backend/src/models/Conversation.js, backend/src/models/Message.js, backend/src/models/User.js
 * - Frontend: frontend/services/conversationService.js, frontend/features/conversations/*
 *
 * CONCEPTS:
 * - Non-Member Safe Previews: Non-members querying a public lounge receive safe metadata
 *   (name, description, member count) while message history remains restricted until joined.
 * - Idempotency: `getOrCreateDirect` prevents duplicate conversation channels between two users.
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const GroupInvitation = require('../models/GroupInvitation');
const cloudinaryService = require('./cloudinaryService');
const messageService = require('./messageService');
const { ApiError } = require('../utils/apiResponse');
const { requireString, validAvatarId, sanitizeLimit } = require('../utils/validation');

const DIRECT_MEMBERS = 2;

async function listForUser(userId) {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const convos = await Conversation.find({ members: userObjectId, deletedAt: null })
    .populate('members', 'username displayName avatarId presence lastSeen status role customStatus bio')
    .populate('createdBy', 'username displayName avatarId')
    .sort({ updatedAt: -1 })
    .lean();

  if (!convos.length) return [];

  const convoIds = convos.map((c) => c._id);

  // 1. Single aggregation to get latest message for all conversations in one roundtrip (avoids N+1 queries)
  const latestMessagesRaw = await Message.aggregate([
    { $match: { conversationId: { $in: convoIds }, deletedAt: null } },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $group: {
        _id: '$conversationId',
        lastMsg: { $first: '$$ROOT' },
      },
    },
  ]);

  // Lookup senders for the latest messages in one batch query
  const senderIds = [...new Set(latestMessagesRaw.map((m) => m.lastMsg.senderId).filter(Boolean))];
  const senders = await User.find({ _id: { $in: senderIds } })
    .select('username displayName avatarId')
    .lean();
  const senderMap = new Map(senders.map((s) => [s._id.toString(), s]));

  const latestMap = new Map();
  for (const item of latestMessagesRaw) {
    const msg = item.lastMsg;
    const sender = senderMap.get(msg.senderId?.toString()) || null;
    latestMap.set(item._id.toString(), {
      ...msg,
      id: msg._id.toString(),
      senderId: sender,
    });
  }

  // 2. Single aggregation to calculate unread message counts across all conversations for this user
  const unreadRaw = await Message.aggregate([
    {
      $match: {
        conversationId: { $in: convoIds },
        readBy: { $ne: userObjectId },
        deletedAt: null,
        messageType: { $ne: 'system' },
      },
    },
    {
      $group: {
        _id: '$conversationId',
        unreadCount: { $sum: 1 },
      },
    },
  ]);
  const unreadMap = new Map(unreadRaw.map((u) => [u._id.toString(), u.unreadCount]));

  // 3. Process each conversation respecting user-specific clear & delete states
  const populated = [];

  for (const c of convos) {
    const cIdStr = c._id.toString();
    const lastMsg = latestMap.get(cIdStr) || null;

    // Check user-specific member state (clearedAt / deletedAt)
    const memberStates = Array.isArray(c.memberStates) ? c.memberStates : [];
    const myState = memberStates.find((s) => {
      const sid = s.userId?._id ? s.userId._id.toString() : s.userId?.toString();
      return sid === userObjectId.toString();
    });

    const userClearedAt = myState?.clearedAt ? new Date(myState.clearedAt).getTime() : 0;
    const userDeletedAt = myState?.deletedAt ? new Date(myState.deletedAt).getTime() : 0;
    const effectiveCutoff = Math.max(userClearedAt, userDeletedAt);

    // If chat was deleted by user:
    // It remains hidden UNLESS a new message was sent after userDeletedAt
    if (userDeletedAt > 0) {
      const lastMsgTime = lastMsg ? new Date(lastMsg.createdAt).getTime() : 0;
      if (lastMsgTime <= userDeletedAt) {
        // Chat remains hidden for this user
        continue;
      }
    }

    // Determine visible last message
    let visibleLastMsg = lastMsg;
    if (effectiveCutoff > 0 && lastMsg) {
      const lastMsgTime = new Date(lastMsg.createdAt).getTime();
      if (lastMsgTime <= effectiveCutoff) {
        visibleLastMsg = null;
      }
    }

    // Determine unread count
    let unreadCount = unreadMap.get(cIdStr) || 0;
    if (effectiveCutoff > 0 && unreadCount > 0 && !visibleLastMsg) {
      unreadCount = 0;
    }

    // Personal section folder for this user
    const userState = c.memberStates?.find((m) => String(m.userId) === String(userId));
    const sectionId = userState?.sectionId ? String(userState.sectionId) : null;

    populated.push({
      ...c,
      id: cIdStr,
      lastMessage: visibleLastMsg,
      lastMessageAt: visibleLastMsg ? visibleLastMsg.createdAt : (effectiveCutoff > 0 ? null : c.updatedAt),
      unreadCount,
      sectionId,
    });
  }

  // Sort by latest message activity
  return populated.sort((a, b) => new Date(b.lastMessageAt || b.updatedAt) - new Date(a.lastMessageAt || a.updatedAt));
}

async function getByIdForUser(conversationId, userId) {
  if (!mongoose.isValidObjectId(conversationId)) throw new ApiError(400, 'Invalid conversation id');
  const convo = await Conversation.findById(conversationId)
    .populate('members', 'username displayName avatarId presence lastSeen status role customStatus bio')
    .populate('pastMembers.userId', 'username displayName avatarId avatarUrl')
    .populate('createdBy', 'username displayName avatarId');
  if (!convo || convo.deletedAt) throw new ApiError(404, 'Conversation not found');

  const isMember = convo.hasMember(userId);
  if (!isMember) {
    // Return safe preview info so user can view details and join
    return {
      _id: convo._id,
      id: convo._id,
      type: convo.type,
      name: convo.name,
      description: convo.description,
      avatarId: convo.avatarId,
      avatarUrl: convo.avatarUrl,
      privacy: convo.privacy,
      hasPasscode: Boolean(convo.hasPasscode || convo.privacy === 'private'),
      memberCount: (convo.members || []).length,
      createdBy: convo.createdBy,
      createdAt: convo.createdAt,
      isMember: false,
    };
  }

  const obj = convo.toJSON ? convo.toJSON() : convo;
  return {
    ...obj,
    hasPasscode: Boolean(convo.hasPasscode || convo.privacy === 'private'),
    isMember: true,
    myRole: convo.getMemberRole(userId),
  };
}

async function searchRooms(q, limit) {
  const term = String(q || '').trim().replace(/^#+/, '');
  if (!term) return [];
  const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  const rooms = await Conversation.find({
    type: 'group',
    deletedAt: null,
    $or: [{ name: rx }, { description: rx }],
  })
    .populate('createdBy', 'username displayName avatarId')
    .limit(sanitizeLimit(limit, 20, 50))
    .sort({ updatedAt: -1 });

  return rooms.map((r) => ({
    _id: r._id,
    id: r._id,
    type: 'group',
    name: r.name,
    description: r.description,
    avatarId: r.avatarId,
    avatarUrl: r.avatarUrl,
    privacy: r.privacy,
    hasPasscode: Boolean(r.hasPasscode || r.privacy === 'private'),
    memberCount: (r.members || []).length,
    members: r.members,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

async function getOrCreateDirect(userA, userB) {
  if (userA.toString() === userB.toString()) throw new ApiError(400, 'Cannot start a direct chat with yourself');
  if (!mongoose.isValidObjectId(userB)) throw new ApiError(400, 'Invalid recipient user ID');

  const targetUser = await User.findById(userB);
  if (!targetUser) throw new ApiError(404, 'User not found');

  const existing = await Conversation.findOne({
    type: 'direct',
    members: { $all: [userA, userB], $size: DIRECT_MEMBERS },
    deletedAt: null,
  })
    .populate('members', 'username displayName avatarId presence lastSeen status role customStatus bio')
    .populate('createdBy', 'username displayName avatarId');

  if (existing) return { convo: existing, created: false };

  // Strict Private Account Protection:
  // If recipient account is private, requester must be an approved (ACCEPTED) follower.
  if (targetUser.privacy?.accountType === 'private') {
    const Follow = require('../models/Follow');
    const isAcceptedFollower = await Follow.findOne({
      followerId: userA,
      followingId: userB,
      status: 'ACCEPTED',
    });
    if (!isAcceptedFollower) {
      throw new ApiError(
        403,
        'This account is private. You must follow them and have your request accepted to start a direct chat.',
      );
    }
  }

  const convo = await Conversation.create({
    type: 'direct',
    members: [userA, userB],
    admins: [userA],
    privacy: 'private',
    createdBy: userA,
  });

  const populated = await Conversation.findById(convo._id)
    .populate('members', 'username displayName avatarId presence lastSeen status role customStatus bio')
    .populate('createdBy', 'username displayName avatarId');

  return { convo: populated, created: true };
}

/*
 * GROUP CREATION
 * WHAT: Creates a new community group lounge.
 * WHY: Establishes the channel, stores profile info (avatar/photo, description),
 * and automatically assigns the creator as OWNER + GROUP ADMIN.
 * SECURITY:
 * - Creator is OWNER and GROUP ADMIN in this group only.
 * - Does NOT grant Platform Admin privileges.
 * - If other players were selected during creation, they are NOT immediately added;
 *   formal PENDING invitations are generated, ensuring they must explicitly ACCEPT before joining.
 */
async function createGroup(creator, { name, description, avatarId, avatarUrl, avatarPublicId, memberIds, privacy, passcode, settings }) {
  const groupName = requireString(name, 'Room name', { min: 2, max: 64 });
  const nameNormalized = groupName.toLowerCase().trim();

  // Enforce unique room name (case-insensitive)
  const existing = await Conversation.findOne({
    type: 'group',
    nameNormalized,
    deletedAt: null,
  });
  if (existing) throw new ApiError(409, 'Room name already exists.');

  const creatorId = creator._id.toString();

  // Creator automatically becomes OWNER + GROUP ADMIN
  const convo = new Conversation({
    type: 'group',
    name: groupName,
    nameNormalized,
    description: typeof description === 'string' ? description.trim().slice(0, 240) : '',
    avatarId: avatarId ? validAvatarId(avatarId) : 'avatar-06',
    avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : '',
    avatarPublicId: typeof avatarPublicId === 'string' ? avatarPublicId : '',
    members: [creator._id],
    admins: [creator._id],
    memberRoles: [{ userId: creator._id, role: 'Owner' }],
    createdBy: creator._id,
    privacy: ['private', 'invite', 'public'].includes(privacy) ? privacy : 'public',
    hasPasscode: false,
    settings: {
      adminOnlyChat: Boolean(settings?.adminOnlyChat),
      invitePermission: settings?.invitePermission === 'ADMINS_ONLY' ? 'ADMINS_ONLY' : 'ANY_MEMBER',
    },
    permissions: {
      sendMessages: !Boolean(settings?.adminOnlyChat),
      inviteMembers: settings?.invitePermission !== 'ADMINS_ONLY',
      editRoom: false,
      manageMembers: false,
      manageRoles: false,
      deleteMessages: false,
      removeMembers: false,
      managePasscode: false,
    },
  });

  if (privacy === 'private' || (passcode !== undefined && passcode !== null && String(passcode).trim() !== '')) {
    const pass = requireString(passcode, 'Passcode', { min: 4, max: 64 });
    convo.privacy = 'private';
    convo.hasPasscode = true;
    const saltRounds = 10;
    convo.passcodeHash = await bcrypt.hash(pass, saltRounds);
  } else {
    convo.hasPasscode = false;
    convo.passcodeHash = null;
  }

  await convo.save();

  // If initial players were selected to be invited, generate pending invitations
  const pendingMemberIds = Array.from(new Set(memberIds || []))
    .filter((id) => mongoose.isValidObjectId(id) && id.toString() !== creatorId);

  if (pendingMemberIds.length > 0) {
    for (const uid of pendingMemberIds) {
      await GroupInvitation.create({
        conversationId: convo._id,
        inviterId: creator._id,
        invitedUserId: uid,
        status: 'PENDING',
      }).catch(() => {});
    }
  }

  const populated = await Conversation.findById(convo._id)
    .populate('members', 'username displayName avatarId avatarUrl presence lastSeen status role customStatus bio')
    .populate('createdBy', 'username displayName avatarId avatarUrl');

  await messageService.createSystemJoinMessage({
    conversationId: convo._id,
    actor: creator,
  }).catch((err) => {
    console.warn('[createGroup] System message note:', err.message);
  });

  return populated;
}

/*
 * UPDATE GROUP SETTINGS & PROFILE
 * WHAT: Allows authorized Group Admins / Owner to modify group preferences at any time.
 * WHY: Settings are not creation-only; preferences (group name, description, avatar photo,
 * messaging permission, invitation permission) evolve over time.
 * SECURITY:
 * - Strictly verifies convo.hasAdmin(actorId) in MongoDB.
 * - Client cannot forge roles or bypass permission checks.
 * - Handles Cloudinary asset cleanup if group photo is replaced or removed.
 */
async function updateSettings(actorId, conversationId, body) {
  const convo = await Conversation.findById(conversationId);
  if (!convo || convo.deletedAt) throw new ApiError(404, 'Conversation not found');

  if (!convo.hasAdmin(actorId)) {
    throw new ApiError(403, 'Only the group owner and group admins can modify group settings');
  }

  const updates = {};
  if (body.name !== undefined) {
    const newName = requireString(body.name, 'Room name', { min: 2, max: 64 });
    const newNormalized = newName.toLowerCase().trim();
    if (newNormalized !== convo.nameNormalized) {
      const clash = await Conversation.findOne({
        _id: { $ne: convo._id },
        type: 'group',
        nameNormalized: newNormalized,
        deletedAt: null,
      });
      if (clash) throw new ApiError(409, 'Room name already exists.');
    }
    updates.name = newName;
    updates.nameNormalized = newNormalized;
  }

  if (body.description !== undefined) updates.description = String(body.description).slice(0, 240);
  if (body.avatarId !== undefined) updates.avatarId = validAvatarId(body.avatarId);

  // Group Profile Photo (Cloudinary upload / removal)
  if (body.avatarUrl !== undefined) {
    const oldPublicId = convo.avatarPublicId;
    updates.avatarUrl = String(body.avatarUrl || '');
    updates.avatarPublicId = String(body.avatarPublicId || '');
    if (oldPublicId && oldPublicId !== updates.avatarPublicId) {
      cloudinaryService.deleteImage(oldPublicId).catch(() => {});
    }
  }

  if (body.privacy !== undefined && ['public', 'private', 'invite'].includes(body.privacy)) {
    updates.privacy = body.privacy;
    if (body.privacy !== 'private' && (body.passcode === undefined || body.passcode === '' || body.passcode === null)) {
      updates.passcodeHash = null;
      updates.hasPasscode = false;
    }
  }

  if (body.passcode !== undefined) {
    if (body.passcode === '' || body.passcode === null) {
      updates.passcodeHash = null;
      updates.hasPasscode = false;
      if (updates.privacy === 'private' || (!updates.privacy && convo.privacy === 'private')) {
        updates.privacy = body.privacy && ['public', 'invite'].includes(body.privacy) ? body.privacy : 'public';
      }
    } else {
      const pass = requireString(body.passcode, 'Passcode', { min: 4, max: 64 });
      updates.passcodeHash = await bcrypt.hash(pass, 10);
      updates.privacy = 'private';
      updates.hasPasscode = true;
    }
  }

  // Master Group Settings (Admin-only chat, Invitation permissions)
  const currentSettings = convo.settings || { adminOnlyChat: false, invitePermission: 'ANY_MEMBER' };
  const newSettings = { ...currentSettings };

  if (body.settings && typeof body.settings === 'object') {
    if (typeof body.settings.adminOnlyChat === 'boolean') {
      newSettings.adminOnlyChat = body.settings.adminOnlyChat;
    }
    if (['ANY_MEMBER', 'ADMINS_ONLY'].includes(body.settings.invitePermission)) {
      newSettings.invitePermission = body.settings.invitePermission;
    }
  } else {
    if (typeof body.adminOnlyChat === 'boolean') {
      newSettings.adminOnlyChat = body.adminOnlyChat;
    }
    if (['ANY_MEMBER', 'ADMINS_ONLY'].includes(body.invitePermission)) {
      newSettings.invitePermission = body.invitePermission;
    }
  }

  updates.settings = newSettings;

  // Keep permissions object in sync for backward compatibility
  updates.permissions = {
    ...(convo.permissions || {}),
    sendMessages: !newSettings.adminOnlyChat,
    inviteMembers: newSettings.invitePermission !== 'ADMINS_ONLY',
  };

  if (body.permissions && typeof body.permissions === 'object') {
    if (typeof body.permissions.editRoom === 'boolean') updates.permissions.editRoom = body.permissions.editRoom;
    if (typeof body.permissions.manageMembers === 'boolean') updates.permissions.manageMembers = body.permissions.manageMembers;
    if (typeof body.permissions.manageRoles === 'boolean') updates.permissions.manageRoles = body.permissions.manageRoles;
    if (typeof body.permissions.deleteMessages === 'boolean') updates.permissions.deleteMessages = body.permissions.deleteMessages;
    if (typeof body.permissions.removeMembers === 'boolean') updates.permissions.removeMembers = body.permissions.removeMembers;
    if (typeof body.permissions.managePasscode === 'boolean') updates.permissions.managePasscode = body.permissions.managePasscode;
  }

  const updated = await Conversation.findByIdAndUpdate(conversationId, updates, { new: true })
    .populate('members', 'username displayName avatarId avatarUrl presence lastSeen status role customStatus bio')
    .populate('createdBy', 'username displayName avatarId avatarUrl');

  // Generate system messages for genuine setting & profile changes
  const systemMessages = [];
  try {
    const actorUser = await User.findById(actorId).select('username displayName avatarId');
    const actorName = actorUser?.displayName || actorUser?.username || 'Admin';

    // 1. Group Name Changed
    if (updates.name && updates.name !== convo.name) {
      const msg = await messageService.createSystemMessage({
        conversationId: convo._id,
        actor: actorUser,
        eventType: 'group_name_changed',
        content: `${actorName} changed the group name to "${updates.name}"`,
        metadata: { oldName: convo.name, newName: updates.name },
      });
      if (msg) systemMessages.push(msg);
    }

    // 2. Group Description Changed
    if (updates.description !== undefined && updates.description !== (convo.description || '')) {
      const msg = await messageService.createSystemMessage({
        conversationId: convo._id,
        actor: actorUser,
        eventType: 'group_description_changed',
        content: `${actorName} updated the group description`,
      });
      if (msg) systemMessages.push(msg);
    }

    // 3. Group Photo Changed / Removed
    if (body.avatarUrl !== undefined) {
      if (body.avatarUrl === '' && convo.avatarUrl) {
        const msg = await messageService.createSystemMessage({
          conversationId: convo._id,
          actor: actorUser,
          eventType: 'group_photo_removed',
          content: `${actorName} removed the group photo`,
        });
        if (msg) systemMessages.push(msg);
      } else if (body.avatarUrl && body.avatarUrl !== convo.avatarUrl) {
        const msg = await messageService.createSystemMessage({
          conversationId: convo._id,
          actor: actorUser,
          eventType: 'group_photo_changed',
          content: `${actorName} updated the group photo`,
        });
        if (msg) systemMessages.push(msg);
      }
    } else if (body.avatarId !== undefined && body.avatarId !== convo.avatarId && !convo.avatarUrl) {
      const msg = await messageService.createSystemMessage({
        conversationId: convo._id,
        actor: actorUser,
        eventType: 'group_photo_changed',
        content: `${actorName} updated the group photo`,
      });
      if (msg) systemMessages.push(msg);
    }

    // 4. Admin-Only Messaging Changed
    if (newSettings.adminOnlyChat !== Boolean(convo.settings?.adminOnlyChat)) {
      const msg = await messageService.createSystemMessage({
        conversationId: convo._id,
        actor: actorUser,
        eventType: 'group_settings_changed',
        content: newSettings.adminOnlyChat
          ? `${actorName} enabled admin-only messaging`
          : `${actorName} disabled admin-only messaging`,
        metadata: { setting: 'adminOnlyChat', value: newSettings.adminOnlyChat },
      });
      if (msg) systemMessages.push(msg);
    }

    // 5. Invite Permission Changed
    if (newSettings.invitePermission !== (convo.settings?.invitePermission || 'ANY_MEMBER')) {
      const msg = await messageService.createSystemMessage({
        conversationId: convo._id,
        actor: actorUser,
        eventType: 'group_settings_changed',
        content: newSettings.invitePermission === 'ADMINS_ONLY'
          ? `${actorName} changed who can invite members to Admins Only`
          : `${actorName} changed who can invite members to Any Member`,
        metadata: { setting: 'invitePermission', value: newSettings.invitePermission },
      });
      if (msg) systemMessages.push(msg);
    }

    // 6. Privacy Changed
    if (updates.privacy && updates.privacy !== convo.privacy) {
      const msg = await messageService.createSystemMessage({
        conversationId: convo._id,
        actor: actorUser,
        eventType: 'group_settings_changed',
        content: `${actorName} updated the group privacy to ${updates.privacy}`,
        metadata: { setting: 'privacy', value: updates.privacy },
      });
      if (msg) systemMessages.push(msg);
    }
  } catch (err) {
    console.warn('[updateSettings] System message generation notice:', err.message);
  }

  return { convo: updated, systemMessages };
}

async function getMembers(conversationId, actorId) {
  const convo = await Conversation.findById(conversationId).populate(
    'members',
    'username displayName avatarId avatarUrl presence lastSeen status role customStatus bio createdAt',
  );
  if (!convo || convo.deletedAt) throw new ApiError(404, 'Room not found');

  const membersWithRoles = (convo.members || []).map((m) => {
    const role = convo.getMemberRole(m._id);
    const obj = m.toJSON ? m.toJSON() : m;
    return {
      ...obj,
      role,
      isOwner: role === 'Owner',
      isAdmin: role === 'Admin' || role === 'Owner',
    };
  });

  return { members: membersWithRoles, myRole: convo.getMemberRole(actorId) };
}

/*
 * ROLE ASSIGNMENT & HIERARCHY
 * WHAT: Manages player roles within a group: OWNER > ADMIN > MODERATOR > MEMBER.
 * WHY: Role hierarchy ensures that lower roles cannot manage or escalate to higher roles.
 * SECURITY:
 * - Only the OWNER can transfer ownership to another member.
 * - Group Admins cannot demote or modify the Owner.
 * - Group Admins cannot promote anyone to Owner.
 * - Non-admins cannot assign roles.
 */
async function updateMemberRole(actorId, conversationId, targetUserId, newRole) {
  const normalizedNewRole = (newRole || '').trim();
  const canonicalRole = normalizedNewRole.charAt(0).toUpperCase() + normalizedNewRole.slice(1).toLowerCase();

  if (!['Owner', 'Admin', 'Moderator', 'Member'].includes(canonicalRole)) {
    throw new ApiError(400, 'Invalid role. Must be Owner, Admin, Moderator, or Member');
  }

  const convo = await Conversation.findById(conversationId);
  if (!convo || convo.deletedAt) throw new ApiError(404, 'Room not found');
  if (convo.type !== 'group') throw new ApiError(400, 'Roles only apply to rooms');

  const actorRole = convo.getMemberRole(actorId);
  const targetRole = convo.getMemberRole(targetUserId);

  if (actorRole !== 'Owner' && actorRole !== 'Admin') {
    throw new ApiError(403, 'Only room owners and group admins can assign roles');
  }

  // Only the Owner can transfer ownership
  if (canonicalRole === 'Owner' && actorRole !== 'Owner') {
    throw new ApiError(403, 'Only the current room owner can transfer ownership');
  }

  // Admin cannot modify or demote the Owner
  if (targetRole === 'Owner' && actorRole !== 'Owner') {
    throw new ApiError(403, 'You cannot modify the room owner role');
  }

  // Transferring ownership: former owner becomes Admin, target becomes Owner
  if (canonicalRole === 'Owner') {
    convo.createdBy = targetUserId;
    const actorIdStr = actorId.toString();
    const prevOwnerEntry = (convo.memberRoles || []).find((r) => (r.userId?._id || r.userId).toString() === actorIdStr);
    if (prevOwnerEntry) prevOwnerEntry.role = 'Admin';
    else convo.memberRoles.push({ userId: actorId, role: 'Admin' });
  }

  // Update target user's role
  const targetIdStr = targetUserId.toString();
  let roles = Array.isArray(convo.memberRoles) ? [...convo.memberRoles] : [];
  const existingIdx = roles.findIndex((r) => (r.userId?._id ? r.userId._id.toString() : r.userId?.toString()) === targetIdStr);

  if (existingIdx >= 0) {
    roles[existingIdx].role = canonicalRole;
  } else {
    roles.push({ userId: targetUserId, role: canonicalRole });
  }

  // Maintain admins array
  if (canonicalRole === 'Admin' || canonicalRole === 'Owner') {
    if (!convo.admins.some((a) => a.toString() === targetIdStr)) convo.admins.push(targetUserId);
  } else {
    convo.admins = convo.admins.filter((a) => a.toString() !== targetIdStr);
  }

  convo.memberRoles = roles;
  await convo.save();

  const populated = await Conversation.findById(conversationId)
    .populate('members', 'username displayName avatarId avatarUrl presence lastSeen status role customStatus bio')
    .populate('pastMembers.userId', 'username displayName avatarId avatarUrl')
    .populate('createdBy', 'username displayName avatarId avatarUrl');

  let systemMessage = null;
  try {
    const actorUser = await User.findById(actorId).select('username displayName avatarId');
    const targetUser = await User.findById(targetUserId).select('username displayName avatarId');
    const actorName = actorUser?.displayName || actorUser?.username || 'Admin';
    const targetName = targetUser?.displayName || targetUser?.username || 'Player';

    if (canonicalRole === 'Owner') {
      systemMessage = await messageService.createSystemMessage({
        conversationId,
        actor: actorUser,
        targetUser,
        eventType: 'owner_transferred',
        content: `${actorName} transferred group ownership to ${targetName}`,
        metadata: { oldOwnerId: actorId, newOwnerId: targetUserId },
      });
    } else if (targetRole !== canonicalRole) {
      let content = `${actorName} changed ${targetName}'s role to ${canonicalRole}`;
      if (canonicalRole === 'Admin') {
        content = `${targetName} was promoted to admin by ${actorName}`;
      } else if (canonicalRole === 'Moderator') {
        content = targetRole === 'Admin'
          ? `${targetName} was demoted to moderator by ${actorName}`
          : `${targetName} was promoted to moderator by ${actorName}`;
      } else if (canonicalRole === 'Member') {
        content = `${targetName} was demoted to member by ${actorName}`;
      }

      systemMessage = await messageService.createSystemMessage({
        conversationId,
        actor: actorUser,
        targetUser,
        eventType: 'member_role_changed',
        content,
        metadata: { oldRole: targetRole, newRole: canonicalRole },
      });
    }
  } catch (err) {
    console.warn('[updateMemberRole] System message generation notice:', err.message);
  }

  return { convo: populated, targetUserId, newRole: canonicalRole, systemMessage };
}

/*
 * GROUP INVITATION FLOW
 * WHAT: Creates pending invitations for other users to join a group.
 * WHY: Users cannot be forcefully added without consent. Every invitation starts as PENDING
 * and requires the invited player to explicitly ACCEPT or REJECT.
 * SECURITY:
 * - Checks convo.canInvite(actorId) (enforcing ANY_MEMBER vs ADMINS_ONLY).
 * - Prevents self-invitation.
 * - Prevents duplicate pending invitations (via unique DB index + check).
 * - Prevents inviting players who are already members.
 */
async function inviteMembers(actorId, conversationId, userIds) {
  const convo = await Conversation.findById(conversationId);
  if (!convo || convo.deletedAt) throw new ApiError(404, 'Conversation not found');
  if (convo.type !== 'group') throw new ApiError(400, 'Invitations can only be sent for group conversations');

  if (!convo.canInvite(actorId)) {
    throw new ApiError(403, 'Only group admins can invite users to this group');
  }

  const rawIds = Array.isArray(userIds) ? userIds : [userIds];
  const ids = Array.from(new Set(rawIds.filter((id) => mongoose.isValidObjectId(id))));
  if (ids.length === 0) throw new ApiError(400, 'At least one valid userId is required');

  const actorIdStr = actorId.toString();
  const createdInvites = [];
  const errors = [];

  for (const uid of ids) {
    const uidStr = uid.toString();
    if (uidStr === actorIdStr) {
      errors.push({ userId: uidStr, message: 'You cannot invite yourself' });
      continue;
    }
    if (convo.hasMember(uid)) {
      errors.push({ userId: uidStr, message: 'User is already a member of this group' });
      continue;
    }

    const targetUser = await User.findById(uid);
    if (!targetUser || targetUser.status !== 'active') {
      errors.push({ userId: uidStr, message: 'User not found or account is not active' });
      continue;
    }

    const existingPending = await GroupInvitation.findOne({
      conversationId: convo._id,
      invitedUserId: uid,
      status: 'PENDING',
    });
    if (existingPending) {
      errors.push({ userId: uidStr, message: 'An invitation is already pending for this user' });
      continue;
    }

    const invitation = await GroupInvitation.create({
      conversationId: convo._id,
      inviterId: actorId,
      invitedUserId: uid,
      status: 'PENDING',
    });

    const populated = await GroupInvitation.findById(invitation._id)
      .populate('inviterId', 'username displayName avatarId')
      .populate('conversationId', 'name description avatarId avatarUrl type createdBy');

    createdInvites.push(populated);
  }

  if (createdInvites.length === 0 && errors.length > 0) {
    throw new ApiError(400, errors[0].message);
  }

  return { invitations: createdInvites, errors, conversation: convo };
}

/*
 * ADD MEMBERS (Delegates to invitation approval workflow)
 * WHAT: Invites players to the group lounge.
 * WHY: Adheres strictly to the requirement that every invite requires user approval.
 */
async function addMembers(actorId, conversationId, userIds) {
  const result = await inviteMembers(actorId, conversationId, userIds);
  return { convo: result.conversation, invitations: result.invitations, errors: result.errors };
}

/*
 * GET MY PENDING INVITATIONS
 * WHAT: Retrieves all pending invitations addressed to the authenticated user.
 */
async function getMyInvitations(userId) {
  const invitations = await GroupInvitation.find({ invitedUserId: userId, status: 'PENDING' })
    .populate('inviterId', 'username displayName avatarId')
    .populate('conversationId', 'name description avatarId avatarUrl type members createdBy')
    .sort({ createdAt: -1 });

  return invitations;
}

/*
 * GET GROUP PENDING INVITATIONS
 * WHAT: Retrieves all pending invitations for a specific group (accessible to Group Admins).
 */
async function getGroupInvitations(actorId, conversationId) {
  const convo = await Conversation.findById(conversationId);
  if (!convo || convo.deletedAt) throw new ApiError(404, 'Conversation not found');
  if (!convo.hasAdmin(actorId)) throw new ApiError(403, 'Only group admins can view pending group invitations');

  return GroupInvitation.find({ conversationId, status: 'PENDING' })
    .populate('invitedUserId', 'username displayName avatarId presence')
    .populate('inviterId', 'username displayName avatarId')
    .sort({ createdAt: -1 });
}

/*
 * RESPOND TO INVITATION
 * WHAT: Handles accepting or rejecting a group invitation.
 * WHY: Flow: Inviter -> Invitation Created -> Invited User receives request -> [ ACCEPT ] [ REJECT ].
 * If ACCEPT: user is added to group members with 'Member' role.
 * If REJECT: invitation is marked rejected, user does NOT join.
 * SECURITY:
 * - Only the actual invited user (invitedUserId) can accept or reject.
 * - Prevents responding to expired or already processed invitations.
 */
async function respondToInvitation(userId, invitationId, action) {
  if (!mongoose.isValidObjectId(invitationId)) throw new ApiError(400, 'Invalid invitation id');
  if (!['ACCEPT', 'REJECT'].includes(action)) throw new ApiError(400, 'Action must be ACCEPT or REJECT');

  const invite = await GroupInvitation.findById(invitationId);
  if (!invite) throw new ApiError(404, 'Invitation not found');

  if (invite.invitedUserId.toString() !== userId.toString()) {
    throw new ApiError(403, 'You cannot respond to an invitation sent to another user');
  }

  if (invite.status !== 'PENDING') {
    throw new ApiError(400, `This invitation has already been ${invite.status.toLowerCase()}`);
  }

  const convo = await Conversation.findById(invite.conversationId);
  if (!convo || convo.deletedAt) {
    invite.status = 'REJECTED';
    invite.respondedAt = new Date();
    await invite.save();
    throw new ApiError(404, 'The group for this invitation no longer exists');
  }

  invite.status = action === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
  invite.respondedAt = new Date();
  await invite.save();

  let populatedConvo = null;
  let systemMessage = null;

  if (action === 'ACCEPT') {
    const isNewMember = !convo.hasMember(userId);
    const userIdStr = userId.toString();
    const existingRoles = Array.isArray(convo.memberRoles) ? convo.memberRoles : [];
    if (!existingRoles.some((r) => (r.userId?._id || r.userId).toString() === userIdStr)) {
      existingRoles.push({ userId, role: 'Member' });
      convo.memberRoles = existingRoles;
    }
    if (!convo.members.some((m) => (m._id || m).toString() === userIdStr)) {
      convo.members.push(userId);
    }
    // Remove from past members if previously left or removed
    if (Array.isArray(convo.pastMembers)) {
      convo.pastMembers = convo.pastMembers.filter((p) => (p.userId?._id || p.userId).toString() !== userIdStr);
    }
    await convo.save();

    populatedConvo = await Conversation.findById(convo._id)
      .populate('members', 'username displayName avatarId avatarUrl presence lastSeen status role customStatus bio')
      .populate('pastMembers.userId', 'username displayName avatarId avatarUrl')
      .populate('createdBy', 'username displayName avatarId avatarUrl');

    if (isNewMember) {
      const joiningUser = await User.findById(userId).select('username displayName avatarId');
      if (joiningUser) {
        systemMessage = await messageService.createSystemJoinMessage({
          conversationId: convo._id,
          actor: joiningUser,
        }).catch((err) => {
          console.warn('[respondToInvitation] System message note:', err.message);
          return null;
        });
      }
    }
  }

  return {
    success: true,
    action,
    invitation: invite,
    conversation: populatedConvo,
    systemMessage,
  };
}

/*
 * UPLOAD GROUP PROFILE PHOTO (CLOUDINARY)
 * WHAT: Uploads custom group avatar images up to 25MB to Cloudinary CDN.
 * WHY: Allows group administrators to customize their group photo with crop & gallery support.
 * SECURITY: Enforces image file formats, MIME validation, and keeps API secrets server-side.
 */
async function uploadGroupAvatar(fileBuffer) {
  if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
    throw new ApiError(400, 'No file buffer provided for group photo upload.');
  }

  const result = await cloudinaryService.uploadImageBuffer(fileBuffer, 'pixeltalk/group_avatars');
  return {
    url: result.secure_url,
    publicId: result.public_id,
  };
}

async function removeMember(actorId, conversationId, targetUserId) {
  const convo = await Conversation.findById(conversationId);
  if (!convo || convo.deletedAt) throw new ApiError(404, 'Conversation not found');
  if (convo.type !== 'group') throw new ApiError(400, 'Members can only be removed from group conversations');

  const isSelf = actorId.toString() === targetUserId.toString();
  if (!isSelf && !convo.canUser(actorId, 'removeMembers') && !convo.hasAdmin(actorId)) {
    throw new ApiError(403, 'Only room admins and moderators can remove members');
  }

  const targetRole = convo.getMemberRole(targetUserId);
  if (targetRole === 'Owner' && !isSelf) {
    throw new ApiError(403, 'The group owner cannot be removed');
  }

  await Conversation.updateOne(
    { _id: conversationId },
    {
      $pull: {
        members: targetUserId,
        admins: targetUserId,
        memberRoles: { userId: targetUserId },
        pastMembers: { userId: targetUserId },
      },
    },
  );

  const updated = await Conversation.findByIdAndUpdate(
    conversationId,
    {
      $push: {
        pastMembers: {
          userId: targetUserId,
          action: isSelf ? 'LEFT' : 'REMOVED',
          removedBy: isSelf ? null : actorId,
          leftAt: new Date(),
        },
      },
    },
    { new: true },
  )
    .populate('members', 'username displayName avatarId presence lastSeen status role customStatus bio')
    .populate('pastMembers.userId', 'username displayName avatarId avatarUrl')
    .populate('createdBy', 'username displayName avatarId');

  let systemMessage = null;
  try {
    const actorUser = await User.findById(actorId).select('username displayName avatarId');
    const targetUser = await User.findById(targetUserId).select('username displayName avatarId');
    const actorName = actorUser?.displayName || actorUser?.username || 'Admin';
    const targetName = targetUser?.displayName || targetUser?.username || 'Player';

    if (isSelf) {
      systemMessage = await messageService.createSystemMessage({
        conversationId,
        actor: targetUser || { _id: targetUserId, username: targetName },
        eventType: 'member_left',
        content: `${targetName} left the room`,
      });
    } else {
      systemMessage = await messageService.createSystemMessage({
        conversationId,
        actor: actorUser,
        targetUser: targetUser || { _id: targetUserId, username: targetName },
        eventType: 'member_removed',
        content: `${targetName} was removed from the room by ${actorName}`,
      });
    }
  } catch (err) {
    console.warn('[removeMember] System message generation notice:', err.message);
  }

  return { convo: updated, removedId: targetUserId, selfRemoved: isSelf, systemMessage };
}

async function joinGroup(user, conversationId, passcode) {
  const convo = await Conversation.findById(conversationId).select('+passcodeHash');
  if (!convo || convo.deletedAt) throw new ApiError(404, 'Room not found');
  if (convo.type !== 'group') throw new ApiError(400, 'Only group conversations can be joined');

  if (convo.hasMember(user._id)) {
    const existingPopulated = await Conversation.findById(conversationId)
      .populate('members', 'username displayName avatarId presence lastSeen status role customStatus bio')
      .populate('pastMembers.userId', 'username displayName avatarId avatarUrl')
      .populate('createdBy', 'username displayName avatarId');
    return { convo: existingPopulated, systemMessage: null, newlyJoined: false };
  }

  if (convo.privacy === 'private' && convo.passcodeHash) {
    if (!passcode) throw new ApiError(403, 'This room requires a passcode');
    const okPass = await bcrypt.compare(String(passcode), convo.passcodeHash);
    if (!okPass) throw new ApiError(403, 'Incorrect room passcode.');
  }

  const updated = await Conversation.findByIdAndUpdate(
    conversationId,
    {
      $addToSet: { members: user._id },
      $push: { memberRoles: { userId: user._id, role: 'Member' } },
      $pull: { pastMembers: { userId: user._id } },
    },
    { new: true },
  )
    .populate('members', 'username displayName avatarId presence lastSeen status role customStatus bio')
    .populate('pastMembers.userId', 'username displayName avatarId avatarUrl')
    .populate('createdBy', 'username displayName avatarId');

  const systemMessage = await messageService.createSystemJoinMessage({
    conversationId: convo._id,
    actor: user,
  }).catch((err) => {
    console.warn('[joinGroup] System message note:', err.message);
    return null;
  });

  return { convo: updated, systemMessage, newlyJoined: true };
}

async function leave(user, conversationId) {
  const convo = await Conversation.findById(conversationId);
  if (!convo || convo.deletedAt) throw new ApiError(404, 'Conversation not found');
  if (convo.type !== 'group') throw new ApiError(400, 'You cannot leave a direct conversation');
  if (!convo.hasMember(user._id)) throw new ApiError(400, 'You are not a member of this group');
  if (convo.createdBy.toString() === user._id.toString()) {
    throw new ApiError(403, 'The room owner cannot leave the group — transfer ownership or delete it instead');
  }

  await Conversation.updateOne(
    { _id: conversationId },
    {
      $pull: {
        members: user._id,
        admins: user._id,
        memberRoles: { userId: user._id },
        pastMembers: { userId: user._id },
      },
    },
  );

  const updated = await Conversation.findByIdAndUpdate(
    conversationId,
    {
      $push: {
        pastMembers: {
          userId: user._id,
          action: 'LEFT',
          removedBy: null,
          leftAt: new Date(),
        },
      },
    },
    { new: true },
  )
    .populate('members', 'username displayName avatarId presence lastSeen status role customStatus bio')
    .populate('pastMembers.userId', 'username displayName avatarId avatarUrl')
    .populate('createdBy', 'username displayName avatarId');

  let systemMessage = null;
  try {
    const username = user.displayName || user.username || 'Player';
    systemMessage = await messageService.createSystemMessage({
      conversationId,
      actor: user,
      eventType: 'member_left',
      content: `${username} left the room`,
    });
  } catch (err) {
    console.warn('[leave] System message generation notice:', err.message);
  }

  return { convo: updated, systemMessage };
}

async function remove(actorId, conversationId) {
  const convo = await Conversation.findById(conversationId);
  if (!convo || convo.deletedAt) throw new ApiError(404, 'Conversation not found');
  if (convo.createdBy.toString() !== actorId.toString()) {
    throw new ApiError(403, 'Only the room owner can delete this conversation');
  }
  const updated = await Conversation.findByIdAndUpdate(conversationId, { deletedAt: new Date() }, { new: true });
  return updated;
}

async function clearConversationForUser(conversationId, userId) {
  if (!mongoose.isValidObjectId(conversationId)) throw new ApiError(400, 'Invalid conversation id');
  const convo = await Conversation.findById(conversationId);
  if (!convo || convo.deletedAt) throw new ApiError(404, 'Conversation not found');
  if (!convo.hasMember(userId)) throw new ApiError(403, 'You are not a member of this conversation');

  const now = new Date();
  const uid = new mongoose.Types.ObjectId(userId);

  // Check if memberStates entry already exists
  const hasEntry = (convo.memberStates || []).some(
    (s) => (s.userId?._id || s.userId).toString() === userId.toString(),
  );

  if (hasEntry) {
    await Conversation.updateOne(
      { _id: conversationId, 'memberStates.userId': uid },
      { $set: { 'memberStates.$.clearedAt': now } },
    );
  } else {
    await Conversation.updateOne(
      { _id: conversationId },
      { $push: { memberStates: { userId: uid, clearedAt: now, deletedAt: null } } },
    );
  }

  return { conversationId: String(conversationId), clearedAt: now };
}

async function deleteChatForUser(conversationId, userId) {
  if (!mongoose.isValidObjectId(conversationId)) throw new ApiError(400, 'Invalid conversation id');
  const convo = await Conversation.findById(conversationId);
  if (!convo || convo.deletedAt) throw new ApiError(404, 'Conversation not found');
  if (!convo.hasMember(userId)) throw new ApiError(403, 'You are not a member of this conversation');

  const now = new Date();
  const uid = new mongoose.Types.ObjectId(userId);

  const hasEntry = (convo.memberStates || []).some(
    (s) => (s.userId?._id || s.userId).toString() === userId.toString(),
  );

  if (hasEntry) {
    await Conversation.updateOne(
      { _id: conversationId, 'memberStates.userId': uid },
      { $set: { 'memberStates.$.deletedAt': now, 'memberStates.$.clearedAt': now } },
    );
  } else {
    await Conversation.updateOne(
      { _id: conversationId },
      { $push: { memberStates: { userId: uid, deletedAt: now, clearedAt: now } } },
    );
  }

  return { conversationId: String(conversationId), deletedAt: now };
}

async function exportChatForUser(conversationId, userId) {
  if (!mongoose.isValidObjectId(conversationId)) throw new ApiError(400, 'Invalid conversation id');
  const convo = await Conversation.findById(conversationId)
    .populate('members', 'username displayName')
    .lean();
  if (!convo || convo.deletedAt) throw new ApiError(404, 'Conversation not found');

  const isMember = (convo.members || []).some(
    (m) => (m._id || m).toString() === userId.toString(),
  );
  if (!isMember) throw new ApiError(403, 'You are not authorized to export this conversation');

  const memberStates = Array.isArray(convo.memberStates) ? convo.memberStates : [];
  const myState = memberStates.find(
    (s) => (s.userId?._id || s.userId).toString() === userId.toString(),
  );
  const cutoffTime = Math.max(
    myState?.clearedAt ? new Date(myState.clearedAt).getTime() : 0,
    myState?.deletedAt ? new Date(myState.deletedAt).getTime() : 0,
  );

  const messageFilter = { conversationId, deletedAt: null };
  if (cutoffTime > 0) {
    messageFilter.createdAt = { $gt: new Date(cutoffTime) };
  }

  // Fetch messages with safe projection (oldest first for chronological reading)
  const msgs = await Message.find(messageFilter)
    .sort({ createdAt: 1, _id: 1 })
    .select('conversationId senderId content messageType media linkPreview replyTo reactions edited editedAt systemEvent createdAt')
    .populate('senderId', 'username displayName')
    .lean();

  const exportedMessages = msgs.map((m) => ({
    id: m._id.toString(),
    senderId: m.senderId?._id ? m.senderId._id.toString() : (m.senderId?.toString() || ''),
    senderUsername: m.senderId?.username || 'unknown',
    senderDisplayName: m.senderId?.displayName || 'Unknown',
    content: m.content || '',
    messageType: m.messageType || 'text',
    systemEvent: m.systemEvent || null,
    media: m.media?.url ? {
      url: m.media.url,
      type: m.media.type,
      fileName: m.media.fileName,
      size: m.media.size,
    } : null,
    linkPreview: m.linkPreview?.url ? {
      url: m.linkPreview.url,
      title: m.linkPreview.title,
      description: m.linkPreview.description,
    } : null,
    replyTo: m.replyTo ? m.replyTo.toString() : null,
    edited: !!m.edited,
    editedAt: m.editedAt || null,
    reactions: (m.reactions || []).map((r) => ({
      emoji: r.emoji,
      createdAt: r.createdAt,
    })),
    createdAt: m.createdAt,
  }));

  const participants = (convo.members || []).map((m) => ({
    id: m._id.toString(),
    username: m.username,
    displayName: m.displayName,
  }));

  return {
    exportVersion: '1.0',
    exportedAt: new Date().toISOString(),
    conversation: {
      id: convo._id.toString(),
      type: convo.type,
      name: convo.name || (convo.type === 'direct' ? 'Direct Conversation' : 'Lounge'),
      description: convo.description || '',
    },
    participants,
    messages: exportedMessages,
  };
}

module.exports = {
  listForUser,
  getByIdForUser,
  searchRooms,
  getOrCreateDirect,
  createGroup,
  updateSettings,
  getMembers,
  updateMemberRole,
  addMembers,
  inviteMembers,
  getMyInvitations,
  getGroupInvitations,
  respondToInvitation,
  uploadGroupAvatar,
  removeMember,
  joinGroup,
  leave,
  remove,
  clearConversationForUser,
  deleteChatForUser,
  exportChatForUser,
};
