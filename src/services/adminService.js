/**
 * Admin Service
 *
 * Responsibility:
 * Encapsulates administrative business logic:
 * - Aggregating high-level system metrics (active users, online status, rooms, daily volume)
 * - Filtering and moderating user accounts (suspension, banning, role escalation)
 * - Moderating and soft-deleting group lounges
 * - Redacting abusive or policy-violating messages
 * - Recording tamper-evident audit logs (`AdminAuditLog`)
 *
 * CONNECTED MODULES:
 * - Controllers: backend/src/controllers/adminController.js
 * - Models: backend/src/models/AdminAuditLog.js, backend/src/models/User.js,
 *           backend/src/models/Conversation.js, backend/src/models/Message.js
 * - Frontend: frontend/app/admin/*, frontend/services/adminService.js
 *
 * CONCEPTS:
 * - Concurrent Metric Aggregation: `stats()` executes independent `countDocuments()` queries
 *   in parallel using `Promise.all` for minimal database round-trip latency.
 * - ReDoS Defense: Administrative search terms are passed through `escapeRx()` before compilation
 *   into regular expressions to eliminate RegExp Denial-of-Service attacks.
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const AdminAuditLog = require('../models/AdminAuditLog');
const { ApiError } = require('../utils/apiResponse');
const { sanitizeLimit } = require('../utils/validation');

async function log(adminId, action, targetType, targetId, metadata = {}) {
  await AdminAuditLog.create({ adminId, action, targetType, targetId, metadata });
}

async function escapeRx(term) {
  return String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function stats() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [totalUsers, activeUsers, onlineUsers, suspendedUsers, bannedUsers, totalConvos, totalGroups, messagesToday] =
    await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ status: 'active' }),
      User.countDocuments({ presence: 'online' }),
      User.countDocuments({ status: 'suspended' }),
      User.countDocuments({ status: 'banned' }),
      Conversation.countDocuments({ type: 'direct', deletedAt: null }),
      Conversation.countDocuments({ type: 'group', deletedAt: null }),
      Message.countDocuments({ createdAt: { $gte: startOfDay }, deletedAt: null }),
    ]);

  return { totalUsers, activeUsers, onlineUsers, suspendedUsers, bannedUsers, totalConversations: totalConvos, totalGroups, messagesToday };
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
    User.find(query).sort({ createdAt: -1 }).skip(skip).limit(lim),
    User.countDocuments(query),
  ]);
  return { users, total, page: Math.max(1, Number(page) || 1), pages: Math.max(1, Math.ceil(total / lim)) };
}

async function getUser(id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid user id');
  const user = await User.findById(id);
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
  await log(admin._id, action, 'user', user._id, { previousStatus, status });

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

  user.role = role;
  await user.save();
  await log(admin._id, 'USER_ROLE_CHANGED', 'user', user._id, { role });
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

  // Remove user from all conversations
  await Conversation.updateMany(
    { members: user._id },
    { $pull: { members: user._id, admins: user._id } }
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
      .populate('createdBy', 'username displayName')
      .populate('members', 'username displayName avatarId presence')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(lim),
    Conversation.countDocuments(query),
  ]);
  return { groups, total, page: Math.max(1, Number(page) || 1), pages: Math.max(1, Math.ceil(total / lim)) };
}

async function getGroup(id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid group id');
  const group = await Conversation.findById(id).populate('createdBy', 'username displayName').populate('members', 'username displayName avatarId presence');
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
 * WHAT: Rejects generic message inspection requests by Platform Admins.
 * WHY: PixelTalk guarantees user message privacy. Platform Administrators manage platform
 * operations, user accounts, and system health, but MUST NOT inspect private chats or message streams.
 * SECURITY: Backend hard-blocks access regardless of client UI requests.
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
  await log(admin._id, 'MESSAGE_DELETED', 'message', msg._id, { conversationId: msg.conversationId, reason: reason || null, messageType: msg.messageType });
  return msg;
}

async function listAuditLogs({ page = 1, limit = 30 }) {
  const lim = sanitizeLimit(limit, 30, 100);
  const skip = (Math.max(1, Number(page) || 1) - 1) * lim;
  const [logs, total] = await Promise.all([
    AdminAuditLog.find({}).sort({ createdAt: -1 }).skip(skip).limit(lim).populate('adminId', 'username displayName'),
    AdminAuditLog.countDocuments({}),
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
