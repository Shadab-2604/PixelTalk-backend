/*
 * ============================================================
 * PIXELTALK — BACKEND REAL-TIME SOCKET.IO ENGINE (sockets/index.js)
 * ============================================================
 *
 * WHAT:
 * This file powers all real-time instant messaging, typing indicators, online player presence,
 * read/delivery ticks, and live room event broadcasts across PixelTalk.
 *
 * WHY:
 * HTTP requests (REST API) are request-response only. Real-time chat requires the server
 * to push new messages, typing status, and read ticks to other connected users instantly
 * without waiting for them to refresh their browser.
 *
 * REAL-TIME EVENT FLOW (CLIENT <-> SERVER <-> CLIENT):
 * 1. Handshake Auth: When a client connects, the server verifies the user's HTTP-only JWT cookie.
 * 2. Room Subscriptions:
 *    - `user:<id>`: Personal notification channel for background alerts.
 *    - `conversation:<id>`: Room channel for active in-chat message streams.
 * 3. Event Handling:
 *    - `send_message`: Saves message to MongoDB -> Broadcasts `new_message` to active chat room
 *      AND to offline/background members' `user:<id>` personal rooms.
 *    - `mark_read` / `mark_delivered`: Updates message status -> Broadcasts `message_read` /
 *      `message_delivered` to update double-ticks (✓ / ✓✓).
 *    - `typing_start` / `typing_stop`: Broadcasts animated typing dots to chat participants.
 *    - `edit_message` / `delete_message`: Updates message content -> Broadcasts live UI updates.
 *    - Presence: Automatically detects socket connection/disconnection and updates player
 *      online/offline status in real time.
 *
 * SECURITY & AUTHENTICATION:
 * - Handshake middleware verifies JWT token from cookies or handshake headers.
 * - Never trusts client-provided user IDs (uses `socket.data.user._id` verified by JWT).
 * - Verifies conversation membership before allowing message creation or event broadcasts.
 * - Caps incoming payloads at 1MB to prevent socket memory exhaustion attacks.
 * ============================================================
 */

const { Server } = require('socket.io');
const cookie = require('cookie');
const config = require('../config');
const { userFromToken } = require('../middleware/auth');
const messageService = require('../services/messageService');
const conversationService = require('../services/conversationService');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const { validMessageContent } = require('../utils/validation');
const { socketCorsOrigin } = require('../utils/cors');

const onlineUsers = new Map(); // userId -> Set<socketId>
const activeCalls = new Map(); // callId -> callSession
const userActiveCall = new Map(); // userId -> callId

function cleanupCall(callId) {
  if (!callId) return;
  const call = activeCalls.get(callId);
  if (call) {
    activeCalls.delete(callId);
    userActiveCall.delete(String(call.callerId));
    userActiveCall.delete(String(call.receiverId));
  } else {
    for (const [uid, cId] of userActiveCall.entries()) {
      if (cId === callId) userActiveCall.delete(uid);
    }
  }
}

function roomFor(conversationId) {
  return `conversation:${conversationId}`;
}

function emitToUser(io, userId, event, payload) {
  const sockets = onlineUsers.get(String(userId));
  if (sockets) for (const sid of sockets) io.to(sid).emit(event, payload);
}

async function setPresence(io, userId, presence) {
  await User.findByIdAndUpdate(userId, { presence, ...(presence === 'offline' ? { lastSeen: new Date() } : {}) });
  io.emit('presence_updated', { userId: String(userId), presence, lastSeen: new Date().toISOString() });
}

function initSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: socketCorsOrigin, credentials: true },
    pingTimeout: 20000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6, // 1MB payload ceiling prevents memory DOS
    perMessageDeflate: false, // Disables CPU-heavy zlib compression during high message broadcast spikes
    transports: ['websocket', 'polling'],
  });

  // --- Handshake authentication (never trust client-provided userId) ---
  io.use(async (socket, next) => {
    try {
      let token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) {
        const cookies = cookie.parse(socket.handshake.headers.cookie || '');
        token = cookies[config.cookieName];
      }
      const user = await userFromToken(token);
      if (!user) return next(new Error('Authentication required'));
      if (user.status !== 'active') return next(new Error('Account is not active'));
      socket.data.user = user;
      next();
    } catch (err) {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', async (socket) => {
    const user = socket.data.user;
    const userId = user._id.toString();

    // --- Personal room for user-targeted events & notifications ---
    socket.join(`user:${userId}`);

    // --- Presence ---
    const sockets = onlineUsers.get(userId) || new Set();
    const wasOffline = sockets.size === 0;
    sockets.add(socket.id);
    onlineUsers.set(userId, sockets);

    if (wasOffline) {
      await setPresence(io, userId, 'online');
      io.emit('user_online', { userId, user: { id: userId, username: user.username, displayName: user.displayName, avatarId: user.avatarId } });
    }

    socket.emit('connected', { userId });

    // --- Conversation rooms ---
    socket.on('join_conversation', async ({ conversationId } = {}, ack) => {
      try {
        if (!conversationId) throw new Error('conversationId required');
        const convo = await Conversation.findById(conversationId).select('members deletedAt');
        if (!convo || convo.deletedAt) throw new Error('Conversation not found');
        if (!convo.hasMember(userId)) throw new Error('Not a member of this conversation');

        socket.join(roomFor(conversationId));
        if (typeof ack === 'function') ack({ success: true });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
        else socket.emit('error_event', { message: err.message });
      }
    });

    socket.on('leave_conversation', ({ conversationId } = {}) => {
      if (conversationId) socket.leave(roomFor(conversationId));
    });

    // --- Messaging ---
    socket.on('send_message', async (payload = {}, ack) => {
      try {
        const { conversationId, content, messageType, media, replyTo } = payload;
        const message = await messageService.create({
          conversationId,
          senderId: user._id,
          content,
          messageType,
          media,
          replyTo,
        });

        const convo = await Conversation.findById(conversationId).select('type name privacy avatarId members');
        const isPrivateRoom = convo?.privacy === 'private';
        const rawContent = String(message.content || (message.media ? `Sent ${message.media.type || 'media'}` : 'New message'));
        const messagePreview = isPrivateRoom ? 'New message' : (rawContent.length > 100 ? `${rawContent.slice(0, 100)}...` : rawContent);

        const eventData = {
          message,
          messageId: message._id,
          conversationId,
          sender: {
            id: user._id,
            _id: user._id,
            displayName: user.displayName,
            username: user.username,
            avatarId: user.avatarId,
          },
          conversation: convo ? {
            id: convo._id,
            _id: convo._id,
            type: convo.type,
            name: convo.name,
            privacy: convo.privacy,
            avatarId: convo.avatarId,
          } : null,
          isPrivateRoom,
          preview: messagePreview,
          messagePreview,
          createdAt: message.createdAt,
        };

        // 3. broadcast to everyone in the conversation room
        io.to(roomFor(conversationId)).emit('new_message', eventData);

        // 4. broadcast to all conversation members' personal rooms who are not in the active chat room
        if (convo && Array.isArray(convo.members)) {
          for (const m of convo.members) {
            const memberId = String(m._id || m);
            io.to(`user:${memberId}`).except(roomFor(conversationId)).emit('new_message', eventData);
          }
        }

        // Auto mark delivered for connected room members
        messageService.markDelivered(conversationId, user._id).then((deliveredIds) => {
          if (deliveredIds.length) {
            io.to(roomFor(conversationId)).emit('message_delivered', { conversationId, userId, messageIds: deliveredIds });
          }
        }).catch(() => {});

        socket.emit('typing_stop', { conversationId, userId });
        if (typeof ack === 'function') ack({ success: true, data: { message } });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
        else socket.emit('error_event', { message: err.message });
      }
    });

    socket.on('mark_read', async ({ conversationId } = {}, ack) => {
      if (!conversationId) return;
      try {
        const readIds = await messageService.markRead(conversationId, user._id);
        if (readIds.length) {
          io.to(roomFor(conversationId)).emit('message_read', { conversationId, userId, messageIds: readIds, readAt: new Date().toISOString() });
        }
        if (typeof ack === 'function') ack({ success: true, readIds });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    socket.on('mark_delivered', async ({ conversationId } = {}, ack) => {
      if (!conversationId) return;
      try {
        const deliveredIds = await messageService.markDelivered(conversationId, user._id);
        if (deliveredIds.length) {
          io.to(roomFor(conversationId)).emit('message_delivered', { conversationId, userId, messageIds: deliveredIds });
        }
        if (typeof ack === 'function') ack({ success: true, deliveredIds });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    socket.on('typing_start', async ({ conversationId } = {}) => {
      if (!conversationId) return;
      try {
        await messageService.assertMember(conversationId, user._id);
        socket.to(roomFor(conversationId)).emit('typing_start', {
          conversationId,
          userId,
          user: { id: userId, displayName: user.displayName },
        });
      } catch {
        /* membership failures are silently ignored for typing */
      }
    });

    socket.on('typing_stop', ({ conversationId } = {}) => {
      if (!conversationId) return;
      socket.to(roomFor(conversationId)).emit('typing_stop', { conversationId, userId });
    });

    // --- Message edit / delete ---
    socket.on('edit_message', async (payload = {}, ack) => {
      try {
        const message = await messageService.edit(payload.messageId, user._id, payload.content);
        io.to(roomFor(message.conversationId)).emit('message_updated', { message });

        const convo = await Conversation.findById(message.conversationId).select('members');
        if (convo && Array.isArray(convo.members)) {
          for (const m of convo.members) {
            const memberId = String(m._id || m);
            io.to(`user:${memberId}`).except(roomFor(message.conversationId)).emit('message_updated', { message });
          }
        }

        if (typeof ack === 'function') ack({ success: true, data: { message } });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    socket.on('delete_message', async (payload = {}, ack) => {
      try {
        const message = await messageService.remove(payload.messageId, user);
        io.to(roomFor(message.conversationId)).emit('message_deleted', { messageId: message._id, message });

        const convo = await Conversation.findById(message.conversationId).select('members');
        if (convo && Array.isArray(convo.members)) {
          for (const m of convo.members) {
            const memberId = String(m._id || m);
            io.to(`user:${memberId}`).except(roomFor(message.conversationId)).emit('message_deleted', { messageId: message._id, message });
          }
        }

        if (typeof ack === 'function') ack({ success: true });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    socket.on('react_message', async (payload = {}, ack) => {
      try {
        const message = await messageService.toggleReaction(payload.messageId, user._id, payload.emoji);
        io.to(roomFor(message.conversationId)).emit('message_updated', { message });
        io.to(roomFor(message.conversationId)).emit('message_reaction_updated', {
          messageId: message._id,
          reactions: message.reactions,
          message,
        });

        const convo = await Conversation.findById(message.conversationId).select('members');
        if (convo && Array.isArray(convo.members)) {
          for (const m of convo.members) {
            const memberId = String(m._id || m);
            io.to(`user:${memberId}`).except(roomFor(message.conversationId)).emit('message_updated', { message });
          }
        }

        if (typeof ack === 'function') ack({ success: true, data: { message } });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    // --- Group lifecycle (REST drives the mutation; sockets rebroadcast) ---
    socket.on('group_updated', async ({ conversationId } = {}, ack) => {
      try {
        await messageService.assertMember(conversationId, user._id);
        const convo = await Conversation.findById(conversationId)
          .populate('members', 'username displayName avatarId presence lastSeen status role customStatus bio')
          .populate('createdBy', 'username displayName avatarId');
        io.to(roomFor(conversationId)).emit('group_updated', { conversation: convo });
        io.to(roomFor(conversationId)).emit('room_updated', { conversation: convo });
        if (typeof ack === 'function') ack({ success: true, data: { conversation: convo } });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    socket.on('role_updated', async ({ conversationId, targetUserId, newRole } = {}, ack) => {
      try {
        await messageService.assertMember(conversationId, user._id);
        io.to(roomFor(conversationId)).emit('role_updated', { conversationId, targetUserId, newRole });
        if (typeof ack === 'function') ack({ success: true });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    // --- 1-to-1 WebRTC Calling Signaling ---
    const lastCallInitiated = new Map();

    async function logCallMessage(call, status) {
      try {
        if (!call || !call.conversationId) return;
        const isVideo = call.callType === 'video' || call.type === 'video';
        let content = '';
        if (status === 'completed' && call.connectedAt) {
          const durSec = Math.max(1, Math.round((Date.now() - call.connectedAt) / 1000));
          const m = Math.floor(durSec / 60);
          const s = durSec % 60;
          const durStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
          content = isVideo ? `📹 Video call • ${durStr}` : `📞 Voice call • ${durStr}`;
        } else if (status === 'missed' || status === 'rejected' || status === 'cancelled') {
          content = isVideo ? '📹 Missed video call' : '📞 Missed voice call';
        }
        if (!content) return;

        const msg = await Message.create({
          conversationId: call.conversationId,
          senderId: call.callerId,
          content,
          messageType: 'text',
          status: 'sent',
        });

        await Conversation.findByIdAndUpdate(call.conversationId, {
          lastMessageAt: msg.createdAt,
          updatedAt: msg.createdAt,
        });

        const populatedMsg = await Message.findById(msg._id)
          .populate('senderId', 'username displayName avatarId avatarUrl')
          .lean();

        io.to(roomFor(call.conversationId)).emit('new_message', {
          message: populatedMsg,
          conversationId: call.conversationId,
        });
        io.to(`user:${call.callerId}`).emit('new_message', {
          message: populatedMsg,
          conversationId: call.conversationId,
        });
        io.to(`user:${call.receiverId}`).emit('new_message', {
          message: populatedMsg,
          conversationId: call.conversationId,
        });
      } catch (err) {
        console.warn('Call message log note:', err.message);
      }
    }

    socket.on('call:initiate', async (payload = {}, ack) => {
      try {
        const targetUserId = payload.targetUserId || payload.toUserId;
        const conversationId = payload.conversationId;
        const callType = payload.callType || payload.type || 'audio';

        if (!targetUserId || !conversationId) throw new Error('targetUserId and conversationId required');
        if (String(userId) === String(targetUserId)) throw new Error('Cannot call yourself');

        // Spam prevention: 2 second cooldown between call initiations
        const lastTime = lastCallInitiated.get(userId) || 0;
        if (Date.now() - lastTime < 2000) {
          throw new Error('Please wait before starting another call');
        }
        lastCallInitiated.set(userId, Date.now());

        await messageService.assertMember(conversationId, user._id);
        await messageService.assertMember(conversationId, targetUserId);

        // Clean stale active call mappings if any
        const existingCallerCall = userActiveCall.get(userId);
        if (existingCallerCall && !activeCalls.has(existingCallerCall)) {
          userActiveCall.delete(userId);
        }
        const existingTargetCall = userActiveCall.get(String(targetUserId));
        if (existingTargetCall && !activeCalls.has(existingTargetCall)) {
          userActiveCall.delete(String(targetUserId));
        }

        if (userActiveCall.has(userId)) {
          throw new Error('You are already on an active call');
        }

        if (userActiveCall.has(String(targetUserId))) {
          if (typeof ack === 'function') ack({ success: false, reason: 'BUSY', message: 'User is currently on another call' });
          socket.emit('call:busy', { targetUserId: String(targetUserId) });
          return;
        }

        const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const callSession = {
          id: callId,
          callId,
          callerId: userId,
          caller: {
            _id: userId,
            id: userId,
            username: user.username,
            displayName: user.displayName,
            avatarId: user.avatarId,
            avatarUrl: user.avatarUrl || '',
          },
          fromUser: {
            _id: userId,
            id: userId,
            username: user.username,
            displayName: user.displayName,
            avatarId: user.avatarId,
            avatarUrl: user.avatarUrl || '',
          },
          receiverId: String(targetUserId),
          conversationId: String(conversationId),
          callType: callType === 'video' ? 'video' : 'audio',
          type: callType === 'video' ? 'video' : 'audio',
          status: 'RINGING',
          startedAt: Date.now(),
        };

        activeCalls.set(callId, callSession);
        userActiveCall.set(userId, callId);
        userActiveCall.set(String(targetUserId), callId);

        // Notify receiver in personal room
        io.to(`user:${targetUserId}`).emit('call:incoming', callSession);
        // Acknowledge caller
        if (typeof ack === 'function') ack({ success: true, callId, callSession });
        socket.emit('call:ringing', { callId, targetUserId: String(targetUserId) });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
        else socket.emit('call:failed', { message: err.message });
      }
    });

    socket.on('call:accept', ({ callId } = {}, ack) => {
      const call = activeCalls.get(callId);
      if (!call || String(call.receiverId) !== String(userId)) {
        if (typeof ack === 'function') ack({ success: false, message: 'Call not found or unauthorized' });
        return;
      }
      call.status = 'CONNECTED';
      call.connectedAt = Date.now();
      io.to(`user:${call.callerId}`).emit('call:accepted', { callId, by: userId, callSession: call });
      io.to(`user:${call.receiverId}`).emit('call:accepted', { callId, by: userId, callSession: call });
      if (typeof ack === 'function') ack({ success: true, callSession: call });
    });

    socket.on('call:reject', async ({ callId, reason = 'REJECTED' } = {}, ack) => {
      const call = activeCalls.get(callId);
      if (!call) return;
      cleanupCall(callId);
      await logCallMessage(call, 'rejected');
      io.to(`user:${call.callerId}`).emit('call:rejected', { callId, reason });
      io.to(`user:${call.receiverId}`).emit('call:rejected', { callId, reason });
      if (typeof ack === 'function') ack({ success: true });
    });

    socket.on('call:cancel', async ({ callId } = {}, ack) => {
      const call = activeCalls.get(callId);
      if (!call) return;
      cleanupCall(callId);
      await logCallMessage(call, 'cancelled');
      io.to(`user:${call.receiverId}`).emit('call:cancelled', { callId });
      if (typeof ack === 'function') ack({ success: true });
    });

    socket.on('call:signal', (payload = {}) => {
      const { callId, signal } = payload;
      const targetUserId = String(payload.targetUserId || payload.toUserId || '');
      if (!targetUserId || !signal) return;
      // Socket.IO is signaling only: relays SDP offers/answers and ICE candidates
      io.to(`user:${targetUserId}`).emit('call:signal', {
        callId,
        fromUserId: String(userId),
        signal,
      });
    });

    socket.on('call:end', async ({ callId } = {}, ack) => {
      const call = activeCalls.get(callId);
      if (call) {
        const wasConnected = call.status === 'CONNECTED';
        cleanupCall(callId);
        await logCallMessage(call, wasConnected ? 'completed' : 'cancelled');
        io.to(`user:${call.callerId}`).emit('call:ended', { callId, by: userId });
        io.to(`user:${call.receiverId}`).emit('call:ended', { callId, by: userId });
      }
      if (typeof ack === 'function') ack({ success: true });
    });

    // --- Disconnect / presence ---
    socket.on('disconnect', async () => {
      // Clean up any ongoing calls for disconnected socket
      const currentCallId = userActiveCall.get(userId);
      if (currentCallId) {
        const call = activeCalls.get(currentCallId);
        if (call) {
          cleanupCall(currentCallId);
          const otherId = call.callerId === userId ? call.receiverId : call.callerId;
          io.to(`user:${otherId}`).emit('call:ended', { callId: currentCallId, by: userId, reason: 'DISCONNECTED' });
        }
      }

      const set = onlineUsers.get(userId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          onlineUsers.delete(userId);
          await setPresence(io, userId, 'offline');
          io.emit('user_offline', { userId, lastSeen: new Date().toISOString() });
        }
      }
    });
  });

  // Let REST controllers broadcast conversation membership changes
  io.emitMemberAdded = (conversation, addedUser) => {
    io.to(roomFor(conversation._id)).emit('member_added', {
      conversationId: String(conversation._id),
      user: addedUser,
      conversation,
    });
  };
  io.emitMemberRemoved = (conversation, removedUserId) => {
    io.to(roomFor(conversation._id)).emit('member_removed', {
      conversationId: String(conversation._id),
      userId: String(removedUserId),
      conversation,
    });
  };

  return io;
}

module.exports = { initSockets, onlineUsers, emitToUser, roomFor };
