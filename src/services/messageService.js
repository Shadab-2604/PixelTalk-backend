/**
 * Message Service
 *
 * Responsibility:
 * Encapsulates message persistence, membership verification before creation/listing,
 * cursor-based pagination, message editing, and authorization-aware soft-deletion.
 *
 * CONNECTED MODULES:
 * - Controllers: backend/src/controllers/messageController.js
 * - Sockets: backend/src/sockets/index.js (handles send_message socket events)
 * - Models: backend/src/models/Message.js, backend/src/models/Conversation.js
 * - Frontend: frontend/services/messageService.js, frontend/features/messages/*
 *
 * CONCEPT: Reverse Cursor Pagination
 * Query executes `{ createdAt: -1 }` to scan the newest records first using the compound index.
 * Results are reversed (`docs.reverse()`) before serialization so the client receives
 * an intuitive oldest-to-newest timeline ready for immediate chat rendering.
 */

const mongoose = require('mongoose');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const { ApiError } = require('../utils/apiResponse');

const PAGE_SIZE = 50;

function assertValidId(id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid id');
}

async function assertMember(conversationId, userId) {
  const convo = await Conversation.findById(conversationId);
  if (!convo || convo.deletedAt) throw new ApiError(404, 'Conversation not found');
  if (!convo.hasMember(userId)) {
    throw new ApiError(403, 'You are not a member of this conversation');
  }
  return convo;
}

const cloudinaryService = require('./cloudinaryService');
const linkPreviewService = require('./linkPreviewService');

/**
 * Cursor pagination: newest first in storage, returned oldest -> newest for the UI.
 * Pass `cursor` (the createdAt ISO string of the oldest loaded message) to page backwards.
 * Batch size default: 50. Respects user-specific clear & delete timestamps.
 */
async function listForConversation(conversationId, userId, { cursor, before, limit } = {}) {
  assertValidId(conversationId);
  const convo = await assertMember(conversationId, userId);

  // Retrieve user-specific clear/delete state
  const memberState = convo.getMemberState(userId);
  const cutoffTime = Math.max(
    memberState?.clearedAt ? new Date(memberState.clearedAt).getTime() : 0,
    memberState?.deletedAt ? new Date(memberState.deletedAt).getTime() : 0,
  );

  const query = { conversationId };

  if (cutoffTime > 0) {
    query.createdAt = { $gt: new Date(cutoffTime) };
  }

  const cursorParam = before || cursor;
  let cursorDate = null;
  if (cursorParam) {
    if (typeof cursorParam === 'string' && /^[0-9a-fA-F]{24}$/.test(cursorParam)) {
      const cursorMsg = await Message.findById(cursorParam).select('createdAt').lean();
      if (cursorMsg) cursorDate = cursorMsg.createdAt;
    } else {
      const d = new Date(cursorParam);
      if (!Number.isNaN(d.getTime())) cursorDate = d;
      else throw new ApiError(400, 'Invalid cursor');
    }
  }

  if (cursorDate) {
    query.createdAt = query.createdAt ? { ...query.createdAt, $lt: cursorDate } : { $lt: cursorDate };
  }

  const n = Math.min(Math.max(Number.parseInt(limit, 10) || PAGE_SIZE, 1), 100);
  const rawDocs = await Message.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(n)
    .select('conversationId senderId content messageType media linkPreview replyTo reactions edited editedAt deletedAt deliveredTo readBy status systemEvent createdAt')
    .populate('senderId', 'username displayName avatarId avatarUrl')
    .populate({
      path: 'replyTo',
      select: 'content messageType media senderId edited editedAt deletedAt',
      populate: { path: 'senderId', select: 'username displayName' },
    })
    .populate('reactions.userId', 'username displayName avatarId')
    .lean();

  const docs = rawDocs.map((doc) => ({ ...doc, id: doc._id.toString() }));
  const nextCursor = docs.length === n ? docs[docs.length - 1].createdAt.toISOString() : null;

  return {
    messages: docs.reverse(),
    nextCursor,
    hasMore: Boolean(nextCursor),
  };
}

async function create({ conversationId, senderId, content, messageType = 'text', media = null, replyTo = null }) {
  if (messageType === 'system') {
    throw new ApiError(400, 'Cannot send system messages directly');
  }
  assertValidId(conversationId);
  const convo = await assertMember(conversationId, senderId);

  /*
   * ADMIN-ONLY CHAT ENFORCEMENT
   * WHAT: Validates whether sender has permission to post in this room.
   * WHY: When adminOnlyChat is enabled, only OWNER and GROUP ADMIN can post messages.
   * SECURITY: Backend is the final authority. Rejects unauthorized HTTP & Socket.IO requests.
   */
  if (!convo.canSendMessage(senderId)) {
    if (convo.settings?.adminOnlyChat) {
      throw new ApiError(403, 'Only group admins can send messages.');
    }
    throw new ApiError(403, 'You do not have permission to send messages in this room');
  }

  const clean = String(content || '').trim().slice(0, 2000);
  if (!clean && !media) throw new ApiError(400, 'Message content or image media attachment is required');

  const finalType = messageType === 'image' || media?.type === 'image' ? 'image' : 'text';

  // Generate link preview if message contains a text URL
  let linkPreview = null;
  if (clean) {
    try {
      linkPreview = await linkPreviewService.fetchPreview(clean);
    } catch (e) {
      // Non-blocking: fail silently to standard text link
      linkPreview = null;
    }
  }

  const msg = await Message.create({
    conversationId,
    senderId,
    content: clean,
    messageType: finalType,
    media: media || undefined,
    linkPreview: linkPreview || undefined,
    replyTo: replyTo && mongoose.isValidObjectId(replyTo) ? replyTo : null,
    deliveredTo: [senderId],
    readBy: [senderId],
    status: 'sent',
  });

  const populated = await msg.populate([
    { path: 'senderId', select: 'username displayName avatarId avatarUrl' },
    {
      path: 'replyTo',
      select: 'content messageType media senderId edited editedAt deletedAt',
      populate: { path: 'senderId', select: 'username displayName' },
    },
  ]);

  // Bump conversation updatedAt so lists re-sort
  await Conversation.findByIdAndUpdate(conversationId, { updatedAt: new Date() });
  return populated;
}

async function uploadMedia(file, userId) {
  if (!file || !file.buffer) throw new ApiError(400, 'No file buffer provided for upload.');

  const mime = (file.mimetype || '').toLowerCase();
  if (!mime.startsWith('image/')) {
    throw new ApiError(400, 'Only image files (JPG, PNG, WEBP, GIF) up to 25MB are allowed.');
  }

  const result = await cloudinaryService.uploadImageBuffer(file.buffer, 'pixeltalk/chat_media');

  return {
    url: result.secure_url,
    publicId: result.public_id,
    type: 'image',
    mimeType: file.mimetype || 'image/jpeg',
    fileName: file.originalname || 'image.jpg',
    size: file.size || file.buffer.length,
  };
}

async function edit(messageId, userId, content) {
  assertValidId(messageId);
  const clean = String(content || '').trim().slice(0, 2000);
  if (!clean) throw new ApiError(400, 'Message content is required');

  const msg = await Message.findById(messageId);
  if (!msg || msg.deletedAt) throw new ApiError(404, 'Message not found');
  if (msg.senderId.toString() !== userId.toString()) {
    throw new ApiError(403, 'You can only edit your own messages');
  }

  msg.content = clean;
  msg.edited = true;
  msg.editedAt = new Date();
  await msg.save();

  return msg.populate([
    { path: 'senderId', select: 'username displayName avatarId avatarUrl' },
    {
      path: 'replyTo',
      select: 'content messageType media senderId edited editedAt deletedAt',
      populate: { path: 'senderId', select: 'username displayName' },
    },
    { path: 'reactions.userId', select: 'username displayName avatarId' },
  ]);
}

async function remove(messageId, actor) {
  assertValidId(messageId);
  const msg = await Message.findById(messageId);
  if (!msg || msg.deletedAt) throw new ApiError(404, 'Message not found');

  const isAuthor = msg.senderId.toString() === actor._id.toString();
  const isAdmin = actor.role === 'admin';

  if (!isAuthor && !isAdmin) throw new ApiError(403, 'You can only delete your own messages');

  msg.deletedAt = new Date();
  await msg.save();
  return msg;
}

async function markRead(conversationId, userId) {
  assertValidId(conversationId);
  await assertMember(conversationId, userId);

  const filter = {
    conversationId,
    senderId: { $ne: userId },
    readBy: { $ne: userId },
  };

  const unreadMsgs = await Message.find(filter).select('_id');
  if (!unreadMsgs.length) return [];

  const ids = unreadMsgs.map((m) => m._id);

  await Message.updateMany(filter, {
    $addToSet: { readBy: userId, deliveredTo: userId },
    $set: { status: 'read' },
  });

  return ids;
}

async function markDelivered(conversationId, userId) {
  assertValidId(conversationId);
  await assertMember(conversationId, userId);

  const filter = {
    conversationId,
    senderId: { $ne: userId },
    deliveredTo: { $ne: userId },
  };

  const undeliveredMsgs = await Message.find(filter).select('_id status');
  if (!undeliveredMsgs.length) return [];

  const ids = undeliveredMsgs.map((m) => m._id);

  await Message.updateMany(filter, {
    $addToSet: { deliveredTo: userId },
    $set: { status: 'delivered' },
  });

  return ids;
}

/**
 * Toggle emoji reaction on a message:
 * - If user already reacted with this emoji, removes the reaction (toggle off)
 * - If not, adds the reaction
 * - Re-populates and returns the updated message document
 */
async function toggleReaction(messageId, userId, emoji) {
  assertValidId(messageId);
  const cleanEmoji = String(emoji || '').trim();
  if (!cleanEmoji || cleanEmoji.length > 16) {
    throw new ApiError(400, 'A valid emoji is required');
  }

  const msg = await Message.findById(messageId);
  if (!msg || msg.deletedAt) throw new ApiError(404, 'Message not found');

  await assertMember(msg.conversationId, userId);

  if (!Array.isArray(msg.reactions)) {
    msg.reactions = [];
  }

  const existingIndex = msg.reactions.findIndex(
    (r) => String(r.userId?._id || r.userId) === String(userId) && r.emoji === cleanEmoji,
  );

  if (existingIndex > -1) {
    // Remove existing reaction
    msg.reactions.splice(existingIndex, 1);
  } else {
    // Add reaction
    msg.reactions.push({
      emoji: cleanEmoji,
      userId,
      createdAt: new Date(),
    });
  }

  await msg.save();

  return msg.populate([
    { path: 'senderId', select: 'username displayName avatarId avatarUrl' },
    {
      path: 'replyTo',
      select: 'content messageType media senderId edited editedAt deletedAt',
      populate: { path: 'senderId', select: 'username displayName' },
    },
    { path: 'reactions.userId', select: 'username displayName avatarId' },
  ]);
}

/**
 * Creates and persists an immutable join system message:
 * "{username} joined the room"
 *
 * Stored securely in the messages collection with messageType: 'system' and
 * systemEvent metadata. Updates conversation timestamp for chronological consistency.
 */
async function createSystemJoinMessage({ conversationId, actor }) {
  assertValidId(conversationId);
  const actorId = actor._id || actor.id;
  const username = actor.username || 'Player';

  const msg = await Message.create({
    conversationId,
    senderId: actorId,
    content: `${username} joined the room`,
    messageType: 'system',
    systemEvent: {
      eventType: 'member_joined',
      actorId,
      actorUsername: username,
    },
    deliveredTo: [actorId],
    readBy: [actorId],
    status: 'sent',
  });

  const populated = await Message.findById(msg._id)
    .populate('senderId', 'username displayName avatarId avatarUrl')
    .lean();

  await Conversation.findByIdAndUpdate(conversationId, {
    lastMessageAt: msg.createdAt,
    updatedAt: msg.createdAt,
  });

  return {
    ...populated,
    id: populated._id.toString(),
  };
}

module.exports = {
  listForConversation,
  create,
  createSystemJoinMessage,
  uploadMedia,
  edit,
  remove,
  markRead,
  markDelivered,
  toggleReaction,
  assertMember,
  PAGE_SIZE,
};
