/*
 * ============================================================
 * PIXELTALK — BACKEND REAL-TIME SOCKET.IO ENGINE (sockets/index.js)
 * ============================================================
 *
 * WHAT:
 * Powers all real-time instant messaging, typing indicators, online player presence,
 * read/delivery ticks, WebRTC voice/video call signaling, and room event broadcasts.
 *
 * WHY:
 * HTTP requests (REST API) are request-response only. Real-time chat requires the server
 * to push new messages, typing status, and call signals to other connected users instantly.
 *
 * REAL-TIME EVENT FLOW:
 * 1. Handshake Auth: Verifies JWT token from auth payload, query, headers, or cookies.
 * 2. Dynamic Authenticate: Allows post-connect authentication without requiring full socket teardown.
 * 3. Room Subscriptions:
 *    - `user:<id>`: Personal notification channel for background alerts and incoming call signals.
 *    - `conversation:<id>`: Room channel for active in-chat message streams and typing status.
 * 4. 1-to-1 WebRTC Signaling:
 *    - `call:initiate`, `call:accept`, `call:reject`, `call:cancel`, `call:signal`, `call:end`
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
const { socketCorsOrigin } = require('../utils/cors');

const onlineUsers = new Map(); // userId -> Set<socketId>
const activeCalls = new Map(); // callId -> callSession
const userActiveCall = new Map(); // userId -> callId
const lastCallInitiated = new Map(); // userId -> timestamp

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
  if (sockets) {
    for (const sid of sockets) {
      io.to(sid).emit(event, payload);
    }
  }
}

async function setPresence(io, userId, presence) {
  try {
    await User.findByIdAndUpdate(userId, {
      presence,
      ...(presence === 'offline' ? { lastSeen: new Date() } : {}),
    });
    io.emit('presence_updated', {
      userId: String(userId),
      presence,
      lastSeen: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[sockets] setPresence notice:', err.message);
  }
}

async function logCallMessage(io, call, status) {
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

    const eventPayload = {
      message: populatedMsg,
      conversationId: call.conversationId,
    };

    io.to(roomFor(call.conversationId)).emit('new_message', eventPayload);
    io.to(`user:${call.callerId}`).emit('new_message', eventPayload);
    io.to(`user:${call.receiverId}`).emit('new_message', eventPayload);
  } catch (err) {
    console.warn('[sockets] Call message log note:', err.message);
  }
}

function initSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: socketCorsOrigin, credentials: true },
    pingTimeout: 20000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6, // 1MB payload ceiling
    perMessageDeflate: false,
    transports: ['websocket', 'polling'],
  });

  // --- Handshake authentication ---
  io.use(async (socket, next) => {
    try {
      let token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token && socket.handshake.headers?.authorization) {
        const authHeader = socket.handshake.headers.authorization;
        if (authHeader.startsWith('Bearer ')) {
          token = authHeader.slice(7).trim();
        }
      }
      if (!token) {
        const cookies = cookie.parse(socket.handshake.headers?.cookie || '');
        token = cookies[config.cookieName];
      }
      if (token) {
        const user = await userFromToken(token);
        if (user && user.status === 'active') {
          socket.data.user = user;
        }
      }
      next();
    } catch {
      next();
    }
  });

  // --- Attach all event handlers for an authenticated user ---
  async function setupUserSocket(socket, user) {
    if (!user || !user._id) return;
    const userId = user._id.toString();

    // Join personal user room
    socket.join(`user:${userId}`);

    // Update presence
    const sockets = onlineUsers.get(userId) || new Set();
    const wasOffline = sockets.size === 0;
    sockets.add(socket.id);
    onlineUsers.set(userId, sockets);

    if (wasOffline) {
      await setPresence(io, userId, 'online');
      io.emit('user_online', {
        userId,
        user: {
          id: userId,
          _id: userId,
          username: user.username,
          displayName: user.displayName,
          avatarId: user.avatarId,
        },
      });
    }

    socket.emit('connected', { userId });

    // Avoid duplicate event listener attachment
    if (socket.data.handlersBound) return;
    socket.data.handlersBound = true;

    // --- Conversation Rooms ---
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
        const activeUser = socket.data.user || user;
        const currentUserId = activeUser._id;
        const { conversationId, content, messageType, media, replyTo } = payload;

        const message = await messageService.create({
          conversationId,
          senderId: currentUserId,
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
            id: activeUser._id,
            _id: activeUser._id,
            displayName: activeUser.displayName,
            username: activeUser.username,
            avatarId: activeUser.avatarId,
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

        // Broadcast to active chat room
        io.to(roomFor(conversationId)).emit('new_message', eventData);

        // Broadcast to offline/background members' personal rooms
        if (convo && Array.isArray(convo.members)) {
          for (const m of convo.members) {
            const memberId = String(m._id || m);
            io.to(`user:${memberId}`).except(roomFor(conversationId)).emit('new_message', eventData);
          }
        }

        // Auto mark delivered
        messageService.markDelivered(conversationId, currentUserId).then((deliveredIds) => {
          if (deliveredIds.length) {
            io.to(roomFor(conversationId)).emit('message_delivered', {
              conversationId,
              userId: currentUserId.toString(),
              messageIds: deliveredIds,
            });
          }
        }).catch(() => {});

        socket.emit('typing_stop', { conversationId, userId: currentUserId.toString() });
        if (typeof ack === 'function') ack({ success: true, data: { message } });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
        else socket.emit('error_event', { message: err.message });
      }
    });

    socket.on('mark_read', async ({ conversationId } = {}, ack) => {
      if (!conversationId) return;
      try {
        const activeUser = socket.data.user || user;
        const readIds = await messageService.markRead(conversationId, activeUser._id);
        if (readIds.length) {
          io.to(roomFor(conversationId)).emit('message_read', {
            conversationId,
            userId: activeUser._id.toString(),
            messageIds: readIds,
            readAt: new Date().toISOString(),
          });
        }
        if (typeof ack === 'function') ack({ success: true, readIds });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    socket.on('mark_delivered', async ({ conversationId } = {}, ack) => {
      if (!conversationId) return;
      try {
        const activeUser = socket.data.user || user;
        const deliveredIds = await messageService.markDelivered(conversationId, activeUser._id);
        if (deliveredIds.length) {
          io.to(roomFor(conversationId)).emit('message_delivered', {
            conversationId,
            userId: activeUser._id.toString(),
            messageIds: deliveredIds,
          });
        }
        if (typeof ack === 'function') ack({ success: true, deliveredIds });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    socket.on('typing_start', async ({ conversationId } = {}) => {
      if (!conversationId) return;
      try {
        const activeUser = socket.data.user || user;
        await messageService.assertMember(conversationId, activeUser._id);
        const typingPayload = {
          conversationId,
          userId: activeUser._id.toString(),
          user: { id: activeUser._id.toString(), displayName: activeUser.displayName },
        };
        socket.to(roomFor(conversationId)).emit('typing_start', typingPayload);

        const convo = await Conversation.findById(conversationId).select('members');
        if (convo && Array.isArray(convo.members)) {
          for (const m of convo.members) {
            const memberId = String(m._id || m);
            if (memberId !== activeUser._id.toString()) {
              io.to(`user:${memberId}`).except(roomFor(conversationId)).emit('typing_start', typingPayload);
            }
          }
        }
      } catch {}
    });

    socket.on('typing_stop', async ({ conversationId } = {}) => {
      if (!conversationId) return;
      try {
        const activeUser = socket.data.user || user;
        const stopPayload = {
          conversationId,
          userId: activeUser._id.toString(),
        };
        socket.to(roomFor(conversationId)).emit('typing_stop', stopPayload);

        const convo = await Conversation.findById(conversationId).select('members');
        if (convo && Array.isArray(convo.members)) {
          for (const m of convo.members) {
            const memberId = String(m._id || m);
            if (memberId !== activeUser._id.toString()) {
              io.to(`user:${memberId}`).except(roomFor(conversationId)).emit('typing_stop', stopPayload);
            }
          }
        }
      } catch {}
    });

    // --- Message Edit / Delete / React ---
    socket.on('edit_message', async (payload = {}, ack) => {
      try {
        const activeUser = socket.data.user || user;
        const message = await messageService.edit(payload.messageId, activeUser._id, payload.content);
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
        const activeUser = socket.data.user || user;
        const message = await messageService.remove(payload.messageId, activeUser);
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
        const activeUser = socket.data.user || user;
        const message = await messageService.toggleReaction(payload.messageId, activeUser._id, payload.emoji);
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

    // --- Group Room Lifecycle ---
    socket.on('group_updated', async ({ conversationId } = {}, ack) => {
      try {
        const activeUser = socket.data.user || user;
        await messageService.assertMember(conversationId, activeUser._id);
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
        const activeUser = socket.data.user || user;
        await messageService.assertMember(conversationId, activeUser._id);
        io.to(roomFor(conversationId)).emit('role_updated', { conversationId, targetUserId, newRole });
        if (typeof ack === 'function') ack({ success: true });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    // --- 1-to-1 WebRTC Calling Signaling ---
    socket.on('call:initiate', async (payload = {}, ack) => {
      try {
        const activeUser = socket.data.user || user;
        const currentUserId = activeUser._id.toString();
        const targetUserId = String(payload.targetUserId || payload.toUserId || '');
        const conversationId = String(payload.conversationId || '');
        const callType = payload.callType || payload.type || 'audio';

        if (!targetUserId || !conversationId) throw new Error('targetUserId and conversationId required');
        if (currentUserId === targetUserId) throw new Error('Cannot call yourself');

        // Spam prevention: 2 second cooldown
        const lastTime = lastCallInitiated.get(currentUserId) || 0;
        if (Date.now() - lastTime < 2000) {
          throw new Error('Please wait before starting another call');
        }
        lastCallInitiated.set(currentUserId, Date.now());

        await messageService.assertMember(conversationId, activeUser._id);
        await messageService.assertMember(conversationId, targetUserId);

        // Clean stale active call mappings
        const existingCallerCall = userActiveCall.get(currentUserId);
        if (existingCallerCall && !activeCalls.has(existingCallerCall)) {
          userActiveCall.delete(currentUserId);
        }
        const existingTargetCall = userActiveCall.get(targetUserId);
        if (existingTargetCall && !activeCalls.has(existingTargetCall)) {
          userActiveCall.delete(targetUserId);
        }

        if (userActiveCall.has(currentUserId)) {
          throw new Error('You are already on an active call');
        }

        if (userActiveCall.has(targetUserId)) {
          if (typeof ack === 'function') ack({ success: false, reason: 'BUSY', message: 'User is currently on another call' });
          socket.emit('call:busy', { targetUserId });
          return;
        }

        const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const callSession = {
          id: callId,
          callId,
          callerId: currentUserId,
          caller: {
            _id: currentUserId,
            id: currentUserId,
            username: activeUser.username,
            displayName: activeUser.displayName,
            avatarId: activeUser.avatarId,
            avatarUrl: activeUser.avatarUrl || '',
          },
          fromUser: {
            _id: currentUserId,
            id: currentUserId,
            username: activeUser.username,
            displayName: activeUser.displayName,
            avatarId: activeUser.avatarId,
            avatarUrl: activeUser.avatarUrl || '',
          },
          receiverId: targetUserId,
          conversationId,
          callType: callType === 'video' ? 'video' : 'audio',
          type: callType === 'video' ? 'video' : 'audio',
          status: 'RINGING',
          startedAt: Date.now(),
        };

        activeCalls.set(callId, callSession);
        userActiveCall.set(currentUserId, callId);
        userActiveCall.set(targetUserId, callId);

        // Notify receiver in personal room
        io.to(`user:${targetUserId}`).emit('call:incoming', callSession);
        // Acknowledge caller
        if (typeof ack === 'function') ack({ success: true, callId, callSession });
        socket.emit('call:ringing', { callId, targetUserId });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
        else socket.emit('call:failed', { message: err.message });
      }
    });

    socket.on('call:accept', ({ callId } = {}, ack) => {
      const activeUser = socket.data.user || user;
      const currentUserId = activeUser._id.toString();
      const call = activeCalls.get(callId);
      if (!call || String(call.receiverId) !== currentUserId) {
        if (typeof ack === 'function') ack({ success: false, message: 'Call not found or unauthorized' });
        return;
      }
      call.status = 'CONNECTED';
      call.connectedAt = Date.now();
      io.to(`user:${call.callerId}`).emit('call:accepted', { callId, by: currentUserId, callSession: call });
      io.to(`user:${call.receiverId}`).emit('call:accepted', { callId, by: currentUserId, callSession: call });
      if (typeof ack === 'function') ack({ success: true, callSession: call });
    });

    socket.on('call:reject', async ({ callId, reason = 'REJECTED' } = {}, ack) => {
      const call = activeCalls.get(callId);
      if (!call) return;
      cleanupCall(callId);
      await logCallMessage(io, call, 'rejected');
      io.to(`user:${call.callerId}`).emit('call:rejected', { callId, reason });
      io.to(`user:${call.receiverId}`).emit('call:rejected', { callId, reason });
      if (typeof ack === 'function') ack({ success: true });
    });

    socket.on('call:cancel', async ({ callId } = {}, ack) => {
      const call = activeCalls.get(callId);
      if (!call) return;
      cleanupCall(callId);
      await logCallMessage(io, call, 'cancelled');
      io.to(`user:${call.receiverId}`).emit('call:cancelled', { callId });
      if (typeof ack === 'function') ack({ success: true });
    });

    socket.on('call:signal', (payload = {}) => {
      const activeUser = socket.data.user || user;
      const currentUserId = activeUser._id.toString();
      const { callId, signal } = payload;
      const targetUserId = String(payload.targetUserId || payload.toUserId || '');
      if (!targetUserId || !signal) return;

      io.to(`user:${targetUserId}`).emit('call:signal', {
        callId,
        fromUserId: currentUserId,
        signal,
      });
    });

    socket.on('call:end', async ({ callId } = {}, ack) => {
      const activeUser = socket.data.user || user;
      const currentUserId = activeUser._id.toString();
      const call = activeCalls.get(callId);
      if (call) {
        const wasConnected = call.status === 'CONNECTED';
        cleanupCall(callId);
        await logCallMessage(io, call, wasConnected ? 'completed' : 'cancelled');
        io.to(`user:${call.callerId}`).emit('call:ended', { callId, by: currentUserId });
        io.to(`user:${call.receiverId}`).emit('call:ended', { callId, by: currentUserId });
      }
      if (typeof ack === 'function') ack({ success: true });
    });

    // --- Disconnect / Presence ---
    socket.on('disconnect', async () => {
      const currentUserId = (socket.data.user || user)._id.toString();

      // Clean up active call if disconnected mid-call
      const currentCallId = userActiveCall.get(currentUserId);
      if (currentCallId) {
        const call = activeCalls.get(currentCallId);
        if (call) {
          cleanupCall(currentCallId);
          const otherId = call.callerId === currentUserId ? call.receiverId : call.callerId;
          io.to(`user:${otherId}`).emit('call:ended', {
            callId: currentCallId,
            by: currentUserId,
            reason: 'DISCONNECTED',
          });
        }
      }

      const set = onlineUsers.get(currentUserId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          onlineUsers.delete(currentUserId);
          await setPresence(io, currentUserId, 'offline');
          io.emit('user_offline', { userId: currentUserId, lastSeen: new Date().toISOString() });
        }
      }
    });
  }

  // --- Main Connection Handler ---
  io.on('connection', async (socket) => {
    // Dynamic authenticate listener (always attached, works for guest or refreshed tokens)
    socket.on('authenticate', async ({ token } = {}, ack) => {
      try {
        const authedUser = await userFromToken(token);
        if (authedUser && authedUser.status === 'active') {
          socket.data.user = authedUser;
          await setupUserSocket(socket, authedUser);
          if (typeof ack === 'function') {
            ack({
              success: true,
              user: {
                id: authedUser._id.toString(),
                username: authedUser.username,
                displayName: authedUser.displayName,
              },
            });
          }
        } else {
          if (typeof ack === 'function') ack({ success: false, message: 'Invalid authentication token' });
        }
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    // If already authenticated during initial handshake, set up immediately
    if (socket.data.user) {
      await setupUserSocket(socket, socket.data.user);
    }
  });

  // REST controller helper broadcasters
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
