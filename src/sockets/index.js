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
const activeCalls = new Map(); // callId -> callSession (1-to-1)
const userActiveCall = new Map(); // userId -> callId (1-to-1)
const lastCallInitiated = new Map(); // userId -> timestamp

// Group Call State Engine
const activeGroupCalls = new Map(); // conversationId -> groupCallSession
const userActiveGroupCall = new Map(); // userId -> conversationId

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

function serializeGroupCall(call) {
  if (!call) return null;
  const participantsArr = Array.from(call.participants.values()).map((p) => ({
    userId: String(p.user?._id || p.user?.id),
    user: p.user,
    isMuted: !!p.isMuted,
    isVideoOff: !!p.isVideoOff,
    isScreenSharing: !!p.isScreenSharing,
    joinedAt: p.joinedAt,
  }));
  return {
    callId: call.id,
    id: call.id,
    conversationId: String(call.conversationId),
    callType: call.callType,
    type: call.callType,
    initiatorId: String(call.initiatorId),
    initiator: call.initiator,
    startedAt: call.startedAt,
    participantCount: participantsArr.length,
    participants: participantsArr,
  };
}

function broadcastGroupCallState(io, conversationId) {
  const call = activeGroupCalls.get(String(conversationId));
  const serialized = serializeGroupCall(call);
  io.to(roomFor(conversationId)).emit('call:group_active_state', {
    conversationId: String(conversationId),
    activeCall: serialized,
  });
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

    if ((status === 'missed' || status === 'rejected' || status === 'cancelled') && !call.connectedAt) {
      const notificationService = require('../services/notificationService');
      notificationService.createNotification({
        recipientId: call.receiverId,
        actorId: call.callerId,
        type: 'call_missed',
        category: 'calls',
        title: 'Missed Call',
        body: `Missed ${call.callType || 'voice'} call from ${call.caller?.displayName || call.caller?.username || 'User'}`,
        targetType: 'conversation',
        targetId: String(call.conversationId),
        data: {
          callType: call.callType || 'voice',
        },
        io,
      }).catch(() => {});
    }
  } catch (err) {
    console.warn('[sockets] Call message log note:', err.message);
  }
}

async function logGroupCallMessage(io, call) {
  try {
    if (!call || !call.conversationId) return;
    const isVideo = call.callType === 'video' || call.type === 'video';
    const durSec = Math.max(1, Math.round((Date.now() - call.startedAt) / 1000));
    const m = Math.floor(durSec / 60);
    const s = durSec % 60;
    const durStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
    const content = isVideo ? `📹 Group video call • ${durStr}` : `📞 Group voice call • ${durStr}`;

    const msg = await Message.create({
      conversationId: call.conversationId,
      senderId: call.initiatorId,
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
  } catch (err) {
    console.warn('[sockets] Group call message log notice:', err.message);
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
    const prevUserId = socket.data.currentAuthedUserId;

    // If socket re-authenticates to a different user, cleanly leave previous user room and presence
    if (prevUserId && prevUserId !== userId) {
      socket.leave(`user:${prevUserId}`);
      const prevSet = onlineUsers.get(prevUserId);
      if (prevSet) {
        prevSet.delete(socket.id);
        if (prevSet.size === 0) {
          onlineUsers.delete(prevUserId);
          await setPresence(io, prevUserId, 'offline');
          io.emit('user_offline', { userId: prevUserId, lastSeen: new Date().toISOString() });
        }
      }
    }
    socket.data.currentAuthedUserId = userId;

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

        // Broadcast to offline/background members' personal rooms & create persistent notification
        if (convo && Array.isArray(convo.members)) {
          const notificationService = require('../services/notificationService');
          const isDirect = convo.type === 'direct';
          for (const m of convo.members) {
            const memberId = String(m._id || m);
            if (memberId !== String(currentUserId)) {
              io.to(`user:${memberId}`).except(roomFor(conversationId)).emit('new_message', eventData);

              notificationService.createNotification({
                recipientId: memberId,
                actorId: currentUserId,
                type: isDirect ? 'message_direct' : 'message_group',
                category: 'messages',
                title: isDirect ? (activeUser.displayName || activeUser.username || 'Direct Message') : `#${convo.name || 'group'}`,
                body: messagePreview,
                targetType: 'conversation',
                targetId: String(conversationId),
                data: {
                  messageId: String(message._id),
                  conversationId: String(conversationId),
                },
                io,
              }).catch(() => {});
            }
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
        await messageService.assertMember(conversationId, activeUser._id);
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
      const activeUser = socket.data.user || user;
      const currentUserId = activeUser._id.toString();
      const call = activeCalls.get(callId);
      if (!call) return;
      // Only the caller or receiver of this call may reject it
      if (String(call.callerId) !== currentUserId && String(call.receiverId) !== currentUserId) return;
      cleanupCall(callId);
      await logCallMessage(io, call, 'rejected');
      io.to(`user:${call.callerId}`).emit('call:rejected', { callId, reason });
      io.to(`user:${call.receiverId}`).emit('call:rejected', { callId, reason });
      if (typeof ack === 'function') ack({ success: true });
    });

    socket.on('call:cancel', async ({ callId } = {}, ack) => {
      const activeUser = socket.data.user || user;
      const currentUserId = activeUser._id.toString();
      const call = activeCalls.get(callId);
      if (!call) return;
      // Only the caller or receiver of this call may cancel it
      if (String(call.callerId) !== currentUserId && String(call.receiverId) !== currentUserId) return;
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

      // Only participants of an existing 1-to-1 call may relay WebRTC signals,
      // and only to the counterparty of that call.
      const call = activeCalls.get(callId);
      if (!call) return;
      const isParticipant = String(call.callerId) === currentUserId || String(call.receiverId) === currentUserId;
      const isCounterparty = targetUserId === String(call.callerId) || targetUserId === String(call.receiverId);
      if (!isParticipant || !isCounterparty) return;

      io.to(`user:${targetUserId}`).emit('call:signal', {
        callId,
        fromUserId: currentUserId,
        signal,
      });
    });

    socket.on('call:media_state', (payload = {}) => {
      const activeUser = socket.data.user || user;
      const currentUserId = activeUser._id.toString();
      const { callId, isVideoOff, isMuted } = payload;
      const targetUserId = String(payload.targetUserId || payload.toUserId || '');
      if (!targetUserId) return;

      // Only participants of an existing call may broadcast media state changes
      const call = activeCalls.get(callId);
      if (!call) return;
      const isParticipant = String(call.callerId) === currentUserId || String(call.receiverId) === currentUserId;
      const isCounterparty = targetUserId === String(call.callerId) || targetUserId === String(call.receiverId);
      if (!isParticipant || !isCounterparty) return;

      io.to(`user:${targetUserId}`).emit('call:media_state', {
        callId,
        fromUserId: currentUserId,
        isVideoOff: !!isVideoOff,
        isMuted: !!isMuted,
      });
    });

    socket.on('call:end', async ({ callId } = {}, ack) => {
      const activeUser = socket.data.user || user;
      const currentUserId = activeUser._id.toString();
      const call = activeCalls.get(callId);
      if (call && (String(call.callerId) === currentUserId || String(call.receiverId) === currentUserId)) {
        const wasConnected = call.status === 'CONNECTED';
        cleanupCall(callId);
        await logCallMessage(io, call, wasConnected ? 'completed' : 'cancelled');
        io.to(`user:${call.callerId}`).emit('call:ended', { callId, by: currentUserId });
        io.to(`user:${call.receiverId}`).emit('call:ended', { callId, by: currentUserId });
      }
      if (typeof ack === 'function') ack({ success: true });
    });

function broadcastCallSystemMessage(io, conversationId, text, eventType) {
  try {
    const payload = {
      id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      conversationId: String(conversationId),
      text,
      event: eventType,
      timestamp: Date.now(),
    };
    io.to(roomFor(conversationId)).emit('call:system_message', payload);
  } catch (err) {
    console.warn('[sockets] broadcastCallSystemMessage note:', err.message);
  }
}

    // --- Group WebRTC Calling Signaling Engine ---
    socket.on('call:group_get_active', async ({ conversationId } = {}, ack) => {
      try {
        if (!conversationId) throw new Error('conversationId required');
        const activeUser = socket.data.user || user;
        await messageService.assertMember(conversationId, activeUser._id);
        const call = activeGroupCalls.get(String(conversationId));
        if (typeof ack === 'function') {
          ack({ success: true, activeCall: serializeGroupCall(call) });
        }
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    socket.on('call:group_start', async (payload = {}, ack) => {
      try {
        const activeUser = socket.data.user || user;
        const currentUserId = activeUser._id.toString();
        const conversationId = String(payload.conversationId || '');
        const callType = payload.callType || payload.type || 'audio';

        if (!conversationId) throw new Error('conversationId required');

        await messageService.assertMember(conversationId, activeUser._id);

        const convo = await Conversation.findById(conversationId).select('name type privacy members createdBy admins memberRoles');
        if (!convo) throw new Error('Group not found');

        let call = activeGroupCalls.get(conversationId);
        if (call) {
          // Check if user is banned from this call
          if (call.bannedUserIds && call.bannedUserIds.has(currentUserId)) {
            throw new Error('You are banned from this call room');
          }

          const participantObj = {
            socketId: socket.id,
            user: {
              _id: currentUserId,
              id: currentUserId,
              username: activeUser.username,
              displayName: activeUser.displayName,
              avatarId: activeUser.avatarId,
              avatarUrl: activeUser.avatarUrl || '',
            },
            isMuted: false,
            isVideoOff: false,
            isScreenSharing: false,
            joinedAt: Date.now(),
          };

          call.participants.set(currentUserId, participantObj);
          userActiveGroupCall.set(currentUserId, conversationId);

          // Broadcast participant joined event with full details
          socket.to(roomFor(conversationId)).emit('call:group_user_joined', {
            conversationId,
            user: participantObj.user,
            participant: {
              userId: currentUserId,
              user: participantObj.user,
              isMuted: false,
              isVideoOff: false,
              isScreenSharing: false,
              joinedAt: participantObj.joinedAt,
            },
          });

          // System message notification
          broadcastCallSystemMessage(
            io,
            conversationId,
            `${activeUser.displayName || activeUser.username} joined the call`,
            'CALL_USER_JOINED',
          );

          broadcastGroupCallState(io, conversationId);

          const serialized = serializeGroupCall(call);
          socket.emit('call:group_room_state', { conversationId, activeCall: serialized });
          if (typeof ack === 'function') ack({ success: true, callSession: serialized });
          return;
        }

        const groupCallId = `grpcall_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const participantsMap = new Map();
        participantsMap.set(currentUserId, {
          socketId: socket.id,
          user: {
            _id: currentUserId,
            id: currentUserId,
            username: activeUser.username,
            displayName: activeUser.displayName,
            avatarId: activeUser.avatarId,
            avatarUrl: activeUser.avatarUrl || '',
          },
          isMuted: false,
          isVideoOff: false,
          isScreenSharing: false,
          joinedAt: Date.now(),
        });

        call = {
          id: groupCallId,
          callId: groupCallId,
          conversationId,
          callType: callType === 'video' ? 'video' : 'audio',
          initiatorId: currentUserId,
          initiator: {
            _id: currentUserId,
            id: currentUserId,
            username: activeUser.username,
            displayName: activeUser.displayName,
            avatarId: activeUser.avatarId,
            avatarUrl: activeUser.avatarUrl || '',
          },
          startedAt: Date.now(),
          participants: participantsMap,
          bannedUserIds: new Set(),
          activeBanVotes: new Map(),
        };

        activeGroupCalls.set(conversationId, call);
        userActiveGroupCall.set(currentUserId, conversationId);

        const serialized = serializeGroupCall(call);

        // Broadcast to group room and personal rooms of group members
        io.to(roomFor(conversationId)).emit('call:group_started', {
          conversationId,
          activeCall: serialized,
          callSession: serialized,
          conversationName: convo.name || 'Group',
        });

        if (Array.isArray(convo.members)) {
          const notificationService = require('../services/notificationService');
          for (const m of convo.members) {
            const memberId = String(m._id || m);
            if (memberId !== currentUserId) {
              io.to(`user:${memberId}`).except(roomFor(conversationId)).emit('call:group_started', {
                conversationId,
                activeCall: serialized,
                callSession: serialized,
                conversationName: convo.name || 'Group',
              });

              notificationService.createNotification({
                recipientId: memberId,
                actorId: currentUserId,
                type: 'group_call_started',
                category: 'groups',
                title: 'Group Call Started',
                body: `${activeUser.displayName || activeUser.username} started a group call in #${convo.name || 'group'}`,
                targetType: 'conversation',
                targetId: String(conversationId),
                data: {
                  callType: callType === 'video' ? 'video' : 'audio',
                },
                io,
              }).catch(() => {});
            }
          }
        }

        broadcastCallSystemMessage(
          io,
          conversationId,
          `${activeUser.displayName || activeUser.username} started the call`,
          'CALL_USER_JOINED',
        );

        broadcastGroupCallState(io, conversationId);
        if (typeof ack === 'function') ack({ success: true, callSession: serialized });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
        else socket.emit('call:failed', { message: err.message });
      }
    });

    socket.on('call:group_join', async ({ conversationId } = {}, ack) => {
      try {
        if (!conversationId) throw new Error('conversationId required');
        const activeUser = socket.data.user || user;
        const currentUserId = activeUser._id.toString();

        await messageService.assertMember(conversationId, activeUser._id);

        let call = activeGroupCalls.get(String(conversationId));
        if (!call) {
          throw new Error('No active call in this room');
        }

        if (call.bannedUserIds && call.bannedUserIds.has(currentUserId)) {
          throw new Error('You are banned from this call room');
        }

        const participantObj = {
          socketId: socket.id,
          user: {
            _id: currentUserId,
            id: currentUserId,
            username: activeUser.username,
            displayName: activeUser.displayName,
            avatarId: activeUser.avatarId,
            avatarUrl: activeUser.avatarUrl || '',
          },
          isMuted: false,
          isVideoOff: false,
          isScreenSharing: false,
          joinedAt: Date.now(),
        };

        call.participants.set(currentUserId, participantObj);
        userActiveGroupCall.set(currentUserId, String(conversationId));

        // Notify other participants that someone joined
        socket.to(roomFor(conversationId)).emit('call:group_user_joined', {
          conversationId: String(conversationId),
          user: participantObj.user,
          participant: {
            userId: currentUserId,
            user: participantObj.user,
            isMuted: false,
            isVideoOff: false,
            isScreenSharing: false,
            joinedAt: participantObj.joinedAt,
          },
        });

        broadcastCallSystemMessage(
          io,
          conversationId,
          `${activeUser.displayName || activeUser.username} joined the call`,
          'CALL_USER_JOINED',
        );

        broadcastGroupCallState(io, conversationId);

        const serialized = serializeGroupCall(call);
        socket.emit('call:group_room_state', { conversationId: String(conversationId), activeCall: serialized });

        if (typeof ack === 'function') {
          ack({
            success: true,
            callSession: serialized,
          });
        }
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    socket.on('call:group_sync', async ({ conversationId } = {}, ack) => {
      try {
        if (!conversationId) throw new Error('conversationId required');
        const activeUser = socket.data.user || user;
        await messageService.assertMember(conversationId, activeUser._id);

        const call = activeGroupCalls.get(String(conversationId));
        const serialized = serializeGroupCall(call);

        socket.emit('call:group_room_state', {
          conversationId: String(conversationId),
          activeCall: serialized,
        });

        if (typeof ack === 'function') {
          ack({ success: true, activeCall: serialized });
        }
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    socket.on('call:group_signal', async (payload = {}) => {
      try {
        const activeUser = socket.data.user || user;
        const currentUserId = activeUser._id.toString();
        const { conversationId, targetUserId, signal } = payload;
        if (!conversationId || !targetUserId || !signal) return;

        const call = activeGroupCalls.get(String(conversationId));
        if (!call || !call.participants.has(currentUserId) || !call.participants.has(String(targetUserId))) {
          return;
        }

        io.to(`user:${targetUserId}`).emit('call:group_signal', {
          conversationId: String(conversationId),
          fromUserId: currentUserId,
          signal,
        });
      } catch (err) {
        console.warn('[sockets] group_signal error:', err.message);
      }
    });

    socket.on('call:group_media_state', async (payload = {}) => {
      try {
        const activeUser = socket.data.user || user;
        const currentUserId = activeUser._id.toString();
        const { conversationId, isMuted, isVideoOff, isScreenSharing } = payload;
        if (!conversationId) return;

        const call = activeGroupCalls.get(String(conversationId));
        if (call && call.participants.has(currentUserId)) {
          const p = call.participants.get(currentUserId);
          if (isMuted !== undefined) p.isMuted = !!isMuted;
          if (isVideoOff !== undefined) p.isVideoOff = !!isVideoOff;
          if (isScreenSharing !== undefined) p.isScreenSharing = !!isScreenSharing;

          socket.to(roomFor(conversationId)).emit('call:group_media_state', {
            conversationId: String(conversationId),
            fromUserId: currentUserId,
            isMuted: p.isMuted,
            isVideoOff: p.isVideoOff,
            isScreenSharing: p.isScreenSharing,
          });
        }
      } catch (err) {
        console.warn('[sockets] group_media_state error:', err.message);
      }
    });

    socket.on('call:group_leave', async ({ conversationId } = {}, ack) => {
      try {
        const activeUser = socket.data.user || user;
        const currentUserId = activeUser._id.toString();
        const convoId = String(conversationId || userActiveGroupCall.get(currentUserId) || '');
        if (!convoId) {
          if (typeof ack === 'function') ack({ success: true });
          return;
        }

        userActiveGroupCall.delete(currentUserId);
        const call = activeGroupCalls.get(convoId);
        if (call) {
          call.participants.delete(currentUserId);

          io.to(roomFor(convoId)).emit('call:group_user_left', {
            conversationId: convoId,
            userId: currentUserId,
          });

          broadcastCallSystemMessage(
            io,
            convoId,
            `${activeUser.displayName || activeUser.username} left the call`,
            'CALL_USER_LEFT',
          );

          if (call.participants.size === 0) {
            activeGroupCalls.delete(convoId);
            await logGroupCallMessage(io, call);
            io.to(roomFor(convoId)).emit('call:group_ended', {
              conversationId: convoId,
            });
            broadcastCallSystemMessage(io, convoId, 'Call ended', 'CALL_ENDED');
          } else {
            broadcastGroupCallState(io, convoId);
          }
        }
        if (typeof ack === 'function') ack({ success: true });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    // --- Admin Moderation: Remove User from Call ---
    socket.on('call:group_remove_user', async ({ conversationId, targetUserId } = {}, ack) => {
      try {
        if (!conversationId || !targetUserId) throw new Error('conversationId and targetUserId required');
        const activeUser = socket.data.user || user;
        const currentUserId = activeUser._id.toString();
        const tid = String(targetUserId);

        const convo = await Conversation.findById(conversationId);
        if (!convo) throw new Error('Conversation not found');
        if (!convo.hasAdmin(activeUser._id)) {
          throw new Error('Only room admins can remove participants');
        }

        const call = activeGroupCalls.get(String(conversationId));
        if (!call || !call.participants.has(tid)) {
          if (typeof ack === 'function') ack({ success: true, message: 'User not in call' });
          return;
        }

        const targetParticipant = call.participants.get(tid);
        const targetName = targetParticipant?.user?.displayName || targetParticipant?.user?.username || 'User';

        call.participants.delete(tid);
        userActiveGroupCall.delete(tid);

        // Notify target directly to terminate call stage
        io.to(`user:${tid}`).emit('call:group_user_removed', {
          conversationId: String(conversationId),
          reason: 'Removed from call by Admin',
        });

        // Notify room members
        io.to(roomFor(conversationId)).emit('call:group_user_left', {
          conversationId: String(conversationId),
          userId: tid,
          reason: 'REMOVED_BY_ADMIN',
        });

        broadcastCallSystemMessage(
          io,
          conversationId,
          `${targetName} was removed from the call by Admin`,
          'CALL_USER_REMOVED',
        );

        if (call.participants.size === 0) {
          activeGroupCalls.delete(String(conversationId));
          await logGroupCallMessage(io, call);
          io.to(roomFor(conversationId)).emit('call:group_ended', {
            conversationId: String(conversationId),
          });
        } else {
          broadcastGroupCallState(io, conversationId);
        }

        if (typeof ack === 'function') ack({ success: true });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    // --- Admin Moderation: Ban User from Call ---
    socket.on('call:group_ban_user', async ({ conversationId, targetUserId } = {}, ack) => {
      try {
        if (!conversationId || !targetUserId) throw new Error('conversationId and targetUserId required');
        const activeUser = socket.data.user || user;
        const tid = String(targetUserId);

        const convo = await Conversation.findById(conversationId);
        if (!convo) throw new Error('Conversation not found');
        if (!convo.hasAdmin(activeUser._id)) {
          throw new Error('Only room admins can ban participants');
        }

        const call = activeGroupCalls.get(String(conversationId));
        if (!call) throw new Error('No active call in room');

        call.bannedUserIds = call.bannedUserIds || new Set();
        call.bannedUserIds.add(tid);

        const targetParticipant = call.participants.get(tid);
        const targetName = targetParticipant?.user?.displayName || targetParticipant?.user?.username || 'User';

        if (call.participants.has(tid)) {
          call.participants.delete(tid);
          userActiveGroupCall.delete(tid);

          // Terminate target call
          io.to(`user:${tid}`).emit('call:group_user_banned', {
            conversationId: String(conversationId),
            reason: 'Banned from call by Admin',
          });

          // Notify room
          io.to(roomFor(conversationId)).emit('call:group_user_left', {
            conversationId: String(conversationId),
            userId: tid,
            reason: 'BANNED_BY_ADMIN',
          });
        }

        broadcastCallSystemMessage(
          io,
          conversationId,
          `${targetName} was banned from the call by Admin`,
          'CALL_USER_BANNED',
        );

        if (call.participants.size === 0) {
          activeGroupCalls.delete(String(conversationId));
          await logGroupCallMessage(io, call);
          io.to(roomFor(conversationId)).emit('call:group_ended', {
            conversationId: String(conversationId),
          });
        } else {
          broadcastGroupCallState(io, conversationId);
        }

        if (typeof ack === 'function') ack({ success: true });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    // --- Democratic Moderation: Start Majority Ban Vote ---
    socket.on('call:group_vote_ban_start', async ({ conversationId, targetUserId } = {}, ack) => {
      try {
        if (!conversationId || !targetUserId) throw new Error('conversationId and targetUserId required');
        const activeUser = socket.data.user || user;
        const currentUserId = activeUser._id.toString();
        const tid = String(targetUserId);

        if (currentUserId === tid) throw new Error('Cannot vote to ban yourself');

        const call = activeGroupCalls.get(String(conversationId));
        if (!call || !call.participants.has(currentUserId) || !call.participants.has(tid)) {
          throw new Error('Active call or participant not found');
        }

        const convo = await Conversation.findById(conversationId);
        // Regular members cannot initiate ban vote against group owner/admins
        if (convo && convo.hasAdmin(tid) && !convo.hasAdmin(currentUserId)) {
          throw new Error('Cannot vote to ban room owner or admins');
        }

        call.activeBanVotes = call.activeBanVotes || new Map();
        const targetParticipant = call.participants.get(tid);

        const voteObj = {
          conversationId: String(conversationId),
          targetUserId: tid,
          targetUser: targetParticipant.user,
          initiatedBy: currentUserId,
          initiatorName: activeUser.displayName || activeUser.username,
          voters: new Set([currentUserId]),
          startedAt: Date.now(),
        };

        call.activeBanVotes.set(tid, voteObj);

        // Calculate eligible voters: all participants except target
        const eligibleCount = Math.max(1, call.participants.size - 1);
        const majorityNeeded = Math.floor(eligibleCount / 2) + 1;

        if (voteObj.voters.size >= majorityNeeded) {
          // Immediate majority reached (e.g. 2 participants total, 1 vote)
          call.bannedUserIds = call.bannedUserIds || new Set();
          call.bannedUserIds.add(tid);
          call.participants.delete(tid);
          call.activeBanVotes.delete(tid);
          userActiveGroupCall.delete(tid);

          const targetName = targetParticipant.user?.displayName || targetParticipant.user?.username || 'User';

          io.to(`user:${tid}`).emit('call:group_user_banned', {
            conversationId: String(conversationId),
            reason: 'Banned by majority vote',
          });

          io.to(roomFor(conversationId)).emit('call:group_user_left', {
            conversationId: String(conversationId),
            userId: tid,
            reason: 'BANNED_BY_VOTE',
          });

          io.to(roomFor(conversationId)).emit('call:group_ban_vote_approved', {
            conversationId: String(conversationId),
            targetUserId: tid,
            targetUser: targetParticipant.user,
          });

          broadcastCallSystemMessage(
            io,
            conversationId,
            `${targetName} was banned from the call by community vote`,
            'CALL_USER_BANNED',
          );

          if (call.participants.size === 0) {
            activeGroupCalls.delete(String(conversationId));
            await logGroupCallMessage(io, call);
            io.to(roomFor(conversationId)).emit('call:group_ended', {
              conversationId: String(conversationId),
            });
          } else {
            broadcastGroupCallState(io, conversationId);
          }
        } else {
          // Broadcast ban vote started to all eligible room members
          io.to(roomFor(conversationId)).emit('call:group_ban_vote_started', {
            conversationId: String(conversationId),
            targetUserId: tid,
            targetUser: targetParticipant.user,
            initiatedBy: currentUserId,
            initiatorName: voteObj.initiatorName,
            votesCount: voteObj.voters.size,
            majorityNeeded,
            eligibleVoters: eligibleCount,
          });
        }

        if (typeof ack === 'function') ack({ success: true });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    // --- Democratic Moderation: Cast Ban Vote ---
    socket.on('call:group_vote_ban_cast', async ({ conversationId, targetUserId, vote = true } = {}, ack) => {
      try {
        if (!conversationId || !targetUserId) throw new Error('conversationId and targetUserId required');
        const activeUser = socket.data.user || user;
        const currentUserId = activeUser._id.toString();
        const tid = String(targetUserId);

        const call = activeGroupCalls.get(String(conversationId));
        if (!call || !call.participants.has(currentUserId)) {
          throw new Error('Call not active or not a participant');
        }

        const voteObj = call.activeBanVotes ? call.activeBanVotes.get(tid) : null;
        if (!voteObj) {
          throw new Error('No active ban vote for this user');
        }

        if (currentUserId === tid) {
          throw new Error('Target user cannot vote on their own ban');
        }

        if (vote) {
          voteObj.voters.add(currentUserId);
        }

        // Recalculate dynamic majority threshold
        const eligibleCount = Math.max(1, call.participants.size - 1);
        const majorityNeeded = Math.floor(eligibleCount / 2) + 1;

        if (voteObj.voters.size >= majorityNeeded) {
          // Ban approved!
          call.bannedUserIds = call.bannedUserIds || new Set();
          call.bannedUserIds.add(tid);
          const targetParticipant = call.participants.get(tid);
          call.participants.delete(tid);
          call.activeBanVotes.delete(tid);
          userActiveGroupCall.delete(tid);

          const targetName = targetParticipant?.user?.displayName || targetParticipant?.user?.username || 'User';

          io.to(`user:${tid}`).emit('call:group_user_banned', {
            conversationId: String(conversationId),
            reason: 'Banned by majority vote',
          });

          io.to(roomFor(conversationId)).emit('call:group_user_left', {
            conversationId: String(conversationId),
            userId: tid,
            reason: 'BANNED_BY_VOTE',
          });

          io.to(roomFor(conversationId)).emit('call:group_ban_vote_approved', {
            conversationId: String(conversationId),
            targetUserId: tid,
            targetUser: targetParticipant?.user,
          });

          broadcastCallSystemMessage(
            io,
            conversationId,
            `${targetName} was banned from the call by community vote`,
            'CALL_USER_BANNED',
          );

          if (call.participants.size === 0) {
            activeGroupCalls.delete(String(conversationId));
            await logGroupCallMessage(io, call);
            io.to(roomFor(conversationId)).emit('call:group_ended', {
              conversationId: String(conversationId),
            });
          } else {
            broadcastGroupCallState(io, conversationId);
          }
        } else {
          io.to(roomFor(conversationId)).emit('call:group_ban_vote_updated', {
            conversationId: String(conversationId),
            targetUserId: tid,
            votesCount: voteObj.voters.size,
            majorityNeeded,
            eligibleVoters: eligibleCount,
          });
        }

        if (typeof ack === 'function') ack({ success: true });
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, message: err.message });
      }
    });

    // --- Disconnect / Presence ---
    socket.on('disconnect', async () => {
      const currentUserId = (socket.data.user || user)._id.toString();

      // Clean up 1-to-1 active call if disconnected mid-call
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

      // Clean up active group call participation if disconnected mid-call
      const currentGroupConvoId = userActiveGroupCall.get(currentUserId);
      if (currentGroupConvoId) {
        userActiveGroupCall.delete(currentUserId);
        const gCall = activeGroupCalls.get(currentGroupConvoId);
        if (gCall) {
          gCall.participants.delete(currentUserId);
          io.to(roomFor(currentGroupConvoId)).emit('call:group_user_left', {
            conversationId: currentGroupConvoId,
            userId: currentUserId,
          });
          if (gCall.participants.size === 0) {
            activeGroupCalls.delete(currentGroupConvoId);
            await logGroupCallMessage(io, gCall);
            io.to(roomFor(currentGroupConvoId)).emit('call:group_ended', {
              conversationId: currentGroupConvoId,
            });
          } else {
            broadcastGroupCallState(io, currentGroupConvoId);
          }
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
