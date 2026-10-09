/**
 * Message Controller
 *
 * Responsibility:
 * Coordinates HTTP requests for cursor-paginated chat history retrieval,
 * message creation, editing, and soft-deletion.
 *
 * CONNECTED MODULES:
 * - Routes: backend/src/routes/index.js (/api/conversations/:id/messages, /api/messages/*)
 * - Services: backend/src/services/messageService.js
 * - Sockets: backend/src/sockets/index.js
 * - Frontend: frontend/services/messageService.js, frontend/features/messages/*
 *
 * CONCEPT: Cursor Pagination
 * The `list` action receives an opaque `cursor` (ISO timestamp) and returns an incremental
 * window of older messages, enabling infinite scrolling without deep offset performance penalties.
 */

const { ok } = require('../utils/apiResponse');
const messageService = require('../services/messageService');

async function list(req, res, next) {
  try {
    const result = await messageService.listForConversation(req.params.conversationId, req.user._id, {
      before: req.query.before || req.query.cursor,
      cursor: req.query.cursor || req.query.before,
      limit: req.query.limit,
    });
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const msg = await messageService.create({
      conversationId: req.params.conversationId || req.body.conversationId,
      senderId: req.user._id,
      content: req.body.content,
      messageType: req.body.messageType,
      media: req.body.media,
      replyTo: req.body.replyTo,
    });
    res.status(201).json({ success: true, data: { message: msg } });
  } catch (err) {
    next(err);
  }
}

async function uploadMedia(req, res, next) {
  try {
    const media = await messageService.uploadMedia(req.file, req.user._id);
    ok(res, media);
  } catch (err) {
    next(err);
  }
}

async function markRead(req, res, next) {
  try {
    const messageIds = await messageService.markRead(req.params.conversationId, req.user._id);
    ok(res, { messageIds });
  } catch (err) {
    next(err);
  }
}

async function markUnread(req, res, next) {
  try {
    const result = await messageService.markUnread(req.params.conversationId, req.user._id);
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function edit(req, res, next) {
  try {
    const msg = await messageService.edit(req.params.id, req.user._id, req.body.content);
    ok(res, { message: msg });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const msg = await messageService.remove(req.params.id, req.user);
    ok(res, { message: msg });
  } catch (err) {
    next(err);
  }
}

async function react(req, res, next) {
  try {
    const msg = await messageService.toggleReaction(req.params.id, req.user._id, req.body.emoji);
    const io = req.app.get('io');
    if (io) {
      const room = `conversation:${msg.conversationId}`;
      io.to(room).emit('message_updated', { message: msg });
      io.to(room).emit('message_reaction_updated', { messageId: msg._id, reactions: msg.reactions, message: msg });
    }
    ok(res, { message: msg });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, uploadMedia, markRead, markUnread, edit, remove, react };
