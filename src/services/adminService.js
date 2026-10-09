/**
 * Admin Service
 *
 * Responsibility:
 * Encapsulates administrative business logic:
 * - Aggregating high-level system metrics (active users, online status, rooms, daily volume, audit entries)
 * - Filtering and moderating user accounts (suspension, banning, role escalation, account deletion)
 * - Moderating, inspecting metadata, and soft-deleting group lounges
 * - Redacting abusive or policy-violating messages (soft-delete without exposing text)
 * - Recording immutable, tamper-evident audit logs (`AdminAuditLog`)
 *
 * PRIVACY GUARANTEE:
 * - Platform Administrators manage server infrastructure, user safety, and room configurations.
 * - Under NO circumstances do Admin APIs return private message text, media payloads, or chat transcripts.
 * - All user & group detail queries project strictly safe metadata.
 *
 * CONNECTED MODULES:
 * - Controllers: backend/src/controllers/adminController.js
 * - Models: backend/src/models/AdminAuditLog.js, backend/src/models/User.js,
 *           backend/src/models/Conversation.js, backend/src/models/Message.js
 * - Frontend: frontend/app/admin/*, frontend/services/adminService.js
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const AdminAuditLog = require('../models/AdminAuditLog');
const { ApiError } = require('../utils/apiResponse');
const { sanitizeLimit } = require('../utils/validation');

async function log(adminId, action, targetType, targetId, metadata = {}) {
  try {
    await AdminAuditLog.create({ adminId, action, targetType, targetId, metadata });
  } catch (err) {
    console.warn('[AdminService] Audit log write note:', err.message);
  }
}

async function escapeRx(term) {
  return String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function stats() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [
    totalUsers,
    activeUsers,
    onlineUsers,
    suspendedUsers,
    bannedUsers,
    totalConvos,
    totalGroups,
    messagesToday,
    totalAuditLogs,
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ status: 'active' }),
    User.countDocuments({ presence: 'online' }),
    User.countDocuments({ status: 'suspended' }),
    User.countDocuments({ status: 'banned' }),
    Conversation.countDocuments({ type: 'direct', deletedAt: null }),
    Conversation.countDocuments({ type: 'group', deletedAt: null }),
    Message.countDocuments({ createdAt: { $gte: startOfDay }, deletedAt: null }),
    AdminAuditLog.countDocuments({}),
  ]);

  return {
    totalUsers,
    activeUsers,
    onlineUsers,
    suspendedUsers,
    bannedUsers,
    totalConversations: totalConvos,
    totalGroups,
    messagesToday,
    totalAuditLogs,
  };
}

async function listUsers({ q, status, role, page = 1, limit = 20 }) {
  const query = {};
  if (q) {
    const rx = new RegExp(await escapeRx(q), 'i');
    query.$or = [{ username: rx }, { displayName: rx }, { email: rx }];
  }
  if (status && ['active', 'suspended', 'banned'].includes(status)) query.status = status;
  if (role && ['user', 'admin'].includes(role)) query.role = role;

  const lim = sanitizeLimit(limit, 20, 100);
  const skip = (Math.max(1, Number(page) || 1) - 1) * lim;
  const [users, total] = await Promise.all([
    User.find(query)
      .select('-__v')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(lim),
    User.countDocuments(query),
  ]);
  return { users, total, page: Math.max(1, Number(page) || 1), pages: Math.max(1, Math.ceil(total / lim)) };
}

async function getUser(id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid user id');
  const user = await User.findById(id).select('-__v');
  if (!user) throw new ApiError(404, 'User not found');
  return user;
}

async function countOtherAdmins(excludeId) {
  return User.countDocuments({ role: 'admin', _id: { $ne: excludeId } });
}

async function setUserStatus(admin, userId, status) {
  if (!['active', 'suspended', 'banned'].includes(status)) throw new ApiError(400, 'Invalid status');
  const user = await getUser(userId);

  if (user._id.toString() === admin._id.toString()) {
    throw new ApiError(400, 'Admins cannot change their own status');
  }
  if (user.role === 'admin' && status !== 'active') {
    const otherAdmins = await countOtherAdmins(user._id);
    if (otherAdmins === 0) throw new ApiError(400, 'Cannot suspend/ban the final admin account');
  }

  const previousStatus = user.status;
  user.status = status;
  await user.save();

  const action =
    status === 'active'
      ? (previousStatus === 'banned' ? 'USER_UNBANNED' : 'USER_UNSUSPENDED')
      : status === 'suspended'
        ? 'USER_SUSPENDED'
        : 'USER_BANNED';
  await log(admin._id, action, 'user', user._id, { username: user.username, previousStatus, status });

  if (status !== 'active') {
    // Force presence offline for banned/suspended users
    await User.findByIdAndUpdate(user._id, { presence: 'offline' });
  }
  return user;
}

async function setUserRole(admin, userId, role) {
  if (!['user', 'admin'].includes(role)) throw new ApiError(400, 'Invalid role');
  const user = await getUser(userId);

  if (user.role === 'admin' && role === 'user') {
    const otherAdmins = await countOtherAdmins(user._id);
    if (otherAdmins === 0) throw new ApiError(400, 'Cannot demote the final admin account');
  }

  const previousRole = user.role;
  user.role = role;
  await user.save();
  await log(admin._id, 'USER_ROLE_CHANGED', 'user', user._id, { username: user.username, previousRole, role });
  return user;
}

async function deleteUser(admin, userId) {
  const user = await getUser(userId);
  if (user._id.toString() === admin._id.toString()) {
    throw new ApiError(400, 'Admins cannot delete their own account');
  }
  if (user.role === 'admin') {
    const otherAdmins = await countOtherAdmins(user._id);
    if (otherAdmins === 0) throw new ApiError(400, 'Cannot delete the final admin account');
  }

  // Safely remove user from all conversation memberships without cascade-deleting conversation history
  await Conversation.updateMany(
    { members: user._id },
    {
      $pull: {
        members: user._id,
        admins: user._id,
        memberRoles: { userId: user._id },
        memberStates: { userId: user._id },
      },
    },
  );

  await log(admin._id, 'USER_DELETED', 'user', user._id, { username: user.username, email: user.email });
  await User.findByIdAndDelete(user._id);
  return { success: true, message: `Account @${user.username} deleted permanently` };
}

async function listGroups({ q, page = 1, limit = 20 }) {
  const query = { type: 'group', deletedAt: null };
  if (q) query.name = new RegExp(await escapeRx(q), 'i');

  const lim = sanitizeLimit(limit, 20, 100);
  const skip = (Math.max(1, Number(page) || 1) - 1) * lim;
  const [groups, total] = await Promise.all([
    Conversation.find(query)
      .select('name description avatarId avatarUrl privacy createdBy members memberRoles createdAt updatedAt')
      .populate('createdBy', 'username displayName avatarId')
      .populate('members', 'username displayName avatarId presence lastSeen')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(lim),
    Conversation.countDocuments(query),
  ]);
  return { groups, total, page: Math.max(1, Number(page) || 1), pages: Math.max(1, Math.ceil(total / lim)) };
}

async function getGroup(id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid group id');
  const group = await Conversation.findById(id)
    .select('type name description avatarId avatarUrl privacy settings createdBy members memberRoles createdAt updatedAt deletedAt')
    .populate('createdBy', 'username displayName avatarId')
    .populate('members', 'username displayName avatarId presence lastSeen');
  if (!group || group.type !== 'group' || group.deletedAt) throw new ApiError(404, 'Group not found');
  return group;
}

async function deleteGroup(admin, id, restore = false) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid group id');
  const group = await Conversation.findById(id);
  if (!group || group.type !== 'group') throw new ApiError(404, 'Group not found');

  if (restore) {
    group.deletedAt = null;
    await group.save();
    await log(admin._id, 'GROUP_RESTORED', 'group', group._id, { name: group.name });
    return group;
  }

  group.deletedAt = new Date();
  await group.save();
  await log(admin._id, 'GROUP_DELETED', 'group', group._id, { name: group.name });
  return group;
}

/*
 * PLATFORM ADMIN PRIVACY ENFORCEMENT
 * WHAT: Hard rejection for message reading requests by Platform Admins.
 * WHY: PixelTalk guarantees zero-knowledge user message privacy. Platform Administrators manage platform
 * operations, user accounts, and system health, but MUST NOT inspect private chats or message streams.
 * SECURITY: Hard-blocks access regardless of client UI requests.
 */
async function listMessages() {
  throw new ApiError(403, 'Platform administrators are prohibited from reading private message content.');
}

async function deleteMessage(admin, messageId, reason) {
  if (!mongoose.isValidObjectId(messageId)) throw new ApiError(400, 'Invalid message id');
  const msg = await Message.findById(messageId);
  if (!msg || msg.deletedAt) throw new ApiError(404, 'Message not found');

  msg.deletedAt = new Date();
  await msg.save();
  // Privacy: Never record user chat text content in audit logs
  await log(admin._id, 'MESSAGE_DELETED', 'message', msg._id, {
    conversationId: msg.conversationId,
    reason: reason || null,
    messageType: msg.messageType,
  });
  return msg;
}

async function listAuditLogs({ action, targetType, page = 1, limit = 30 }) {
  const query = {};
  if (action) query.action = action;
  if (targetType) query.targetType = targetType;

  const lim = sanitizeLimit(limit, 30, 100);
  const skip = (Math.max(1, Number(page) || 1) - 1) * lim;
  const [logs, total] = await Promise.all([
    AdminAuditLog.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .populate('adminId', 'username displayName avatarId role'),
    AdminAuditLog.countDocuments(query),
  ]);
  return { logs, total, page: Math.max(1, Number(page) || 1), pages: Math.max(1, Math.ceil(total / lim)) };
}

module.exports = {
  log,
  stats,
  listUsers,
  getUser,
  setUserStatus,
  setUserRole,
  deleteUser,
  listGroups,
  getGroup,
  deleteGroup,
  listMessages,
  deleteMessage,
  listAuditLogs,
};

