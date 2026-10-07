/**
 * Conversation Controller
 *
 * Responsibility:
 * Coordinates HTTP requests for conversation listing, public room discovery,
 * idempotent direct chat initialization, room settings mutations, and membership management.
 *
 * CONNECTED MODULES:
 * - Routes: backend/src/routes/index.js (/api/conversations/*)
 * - Services: backend/src/services/conversationService.js
 * - Models: backend/src/models/Conversation.js
 * - Frontend: frontend/services/conversationService.js, frontend/features/conversations/*
 *
 * CONCEPT: Idempotent Direct Chat Start
 * `startDirect` utilizes an idempotent pattern where multiple requests between the same
 * pair of users will always resolve to the existing direct conversation without duplication.
 */

const { ok } = require('../utils/apiResponse');
const conversationService = require('../services/conversationService');
const userService = require('../services/userService');

async function list(req, res, next) {
  try {
    const convos = await conversationService.listForUser(req.user._id);
    ok(res, { conversations: convos });
  } catch (err) {
    next(err);
  }
}

async function search(req, res, next) {
  try {
    const rooms = await conversationService.searchRooms(req.query.q, req.query.limit);
    ok(res, { rooms });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const convo = await conversationService.getByIdForUser(req.params.id, req.user._id);
    ok(res, { conversation: convo });
  } catch (err) {
    next(err);
  }
}

async function createGroup(req, res, next) {
  try {
    const convo = await conversationService.createGroup(req.user, req.body);

    // If initial player invitations were sent, notify them via sockets
    const io = req.app.get('io');
    if (io && req.body.memberIds && Array.isArray(req.body.memberIds)) {
      for (const uid of req.body.memberIds) {
        io.to(`user:${uid}`).emit('group_invitation_received', {
          conversation: {
            id: convo._id,
            _id: convo._id,
            name: convo.name,
            description: convo.description,
            avatarId: convo.avatarId,
            avatarUrl: convo.avatarUrl,
            type: convo.type,
          },
          inviter: {
            id: req.user._id,
            _id: req.user._id,
            username: req.user.username,
            displayName: req.user.displayName,
            avatarId: req.user.avatarId,
          },
          message: `${req.user.displayName || req.user.username} invited you to join #${convo.name}`,
        });
      }
    }

    res.status(201).json({ success: true, data: { conversation: convo } });
  } catch (err) {
    next(err);
  }
}

async function uploadGroupAvatar(req, res, next) {
  try {
    if (!req.file || !req.file.buffer) throw new ApiError(400, 'Please select an image file to upload.');
    const result = await conversationService.uploadGroupAvatar(req.file.buffer);
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function startDirect(req, res, next) {
  try {
    const targetUserId = req.body.userId || req.body.targetUserId;
    const { convo, created } = await conversationService.getOrCreateDirect(req.user._id, targetUserId);
    res.status(created ? 201 : 200).json({ success: true, data: { conversation: convo } });
  } catch (err) {
    next(err);
  }
}

async function patchSettings(req, res, next) {
  try {
    const convo = await conversationService.updateSettings(req.user._id, req.params.id, req.body);

    // Realtime synchronization: broadcast update to conversation room & members
    const io = req.app.get('io');
    if (io) {
      const convoId = String(convo._id);
      io.to(`conversation:${convoId}`).emit('group_updated', { conversation: convo });
      io.to(`conversation:${convoId}`).emit('room_updated', { conversation: convo });
      if (Array.isArray(convo.members)) {
        for (const m of convo.members) {
          const mid = String(m._id || m);
          io.to(`user:${mid}`).emit('group_updated', { conversation: convo });
        }
      }
    }

    res.json({ success: true, data: { conversation: convo } });
  } catch (err) {
    next(err);
  }
}

async function getMembers(req, res, next) {
  try {
    const data = await conversationService.getMembers(req.params.id, req.user._id);
    ok(res, data);
  } catch (err) {
    next(err);
  }
}

async function updateMemberRole(req, res, next) {
  try {
    const result = await conversationService.updateMemberRole(
      req.user._id,
      req.params.id,
      req.params.userId,
      req.body.role,
    );

    // Realtime broadcast of role updates
    const io = req.app.get('io');
    if (io) {
      const convoId = String(req.params.id);
      io.to(`conversation:${convoId}`).emit('role_updated', {
        conversationId: convoId,
        targetUserId: req.params.userId,
        newRole: result.newRole,
      });
      io.to(`conversation:${convoId}`).emit('group_updated', { conversation: result.convo });
    }

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function addMembers(req, res, next) {
  try {
    const { convo, invitations, errors } = await conversationService.addMembers(req.user._id, req.params.id, req.body.userIds || [req.body.userId]);

    // Realtime notifications for invited players
    const io = req.app.get('io');
    if (io && Array.isArray(invitations)) {
      for (const inv of invitations) {
        const invitedId = String(inv.invitedUserId?._id || inv.invitedUserId);
        io.to(`user:${invitedId}`).emit('group_invitation_received', {
          invitation: inv,
          conversation: inv.conversationId,
          inviter: inv.inviterId,
          message: `${inv.inviterId?.displayName || inv.inviterId?.username || 'A player'} invited you to join #${inv.conversationId?.name || 'group'}`,
        });
      }
    }

    res.json({ success: true, data: { conversation: convo, invitations, errors } });
  } catch (err) {
    next(err);
  }
}

async function invite(req, res, next) {
  try {
    const userIds = req.body.userIds || (req.body.userId ? [req.body.userId] : []);
    const { invitations, errors, conversation } = await conversationService.inviteMembers(req.user._id, req.params.id, userIds);

    const io = req.app.get('io');
    if (io && Array.isArray(invitations)) {
      for (const inv of invitations) {
        const invitedId = String(inv.invitedUserId?._id || inv.invitedUserId);
        io.to(`user:${invitedId}`).emit('group_invitation_received', {
          invitation: inv,
          conversation: inv.conversationId,
          inviter: inv.inviterId,
          message: `${inv.inviterId?.displayName || inv.inviterId?.username || 'A player'} invited you to join #${inv.conversationId?.name || 'group'}`,
        });
      }
    }

    res.status(201).json({ success: true, data: { invitations, errors, conversation } });
  } catch (err) {
    next(err);
  }
}

async function getMyInvitations(req, res, next) {
  try {
    const invitations = await conversationService.getMyInvitations(req.user._id);
    ok(res, { invitations });
  } catch (err) {
    next(err);
  }
}

async function getGroupInvitations(req, res, next) {
  try {
    const invitations = await conversationService.getGroupInvitations(req.user._id, req.params.id);
    ok(res, { invitations });
  } catch (err) {
    next(err);
  }
}

async function respondInvitation(req, res, next) {
  try {
    const { action } = req.body;
    const result = await conversationService.respondToInvitation(
      req.user._id,
      req.params.invitationId || req.params.id,
      action,
    );

    const io = req.app.get('io');
    if (io) {
      if (action === 'ACCEPT' && result.conversation) {
        const convoId = String(result.conversation._id);
        io.to(`conversation:${convoId}`).emit('member_added', {
          conversationId: convoId,
          user: req.user,
          conversation: result.conversation,
        });
        io.to(`user:${req.user._id}`).emit('group_joined', { conversation: result.conversation });
      }
    }

    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function removeMember(req, res, next) {
  try {
    const { convo, removedId, selfRemoved } = await conversationService.removeMember(
      req.user._id,
      req.params.id,
      req.params.userId,
    );

    const io = req.app.get('io');
    if (io) {
      const convoId = String(req.params.id);
      io.to(`conversation:${convoId}`).emit('member_removed', {
        conversationId: convoId,
        userId: String(removedId),
        conversation: convo,
      });
      io.to(`user:${removedId}`).emit('member_removed', {
        conversationId: convoId,
        userId: String(removedId),
      });
    }

    res.json({ success: true, data: { conversation: convo, removedId, selfRemoved } });
  } catch (err) {
    next(err);
  }
}

async function pinConversation(req, res, next) {
  try {
    const result = await userService.togglePinConversation(req.user._id, req.params.id);
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function join(req, res, next) {
  try {
    const convo = await conversationService.joinGroup(req.user, req.params.id, req.body.passcode);
    res.json({ success: true, data: { conversation: convo } });
  } catch (err) {
    next(err);
  }
}

async function leave(req, res, next) {
  try {
    const convo = await conversationService.leave(req.user, req.params.id);
    res.json({ success: true, data: { conversation: convo } });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const convo = await conversationService.remove(req.user._id, req.params.id);
    res.json({ success: true, data: { conversation: convo } });
  } catch (err) {
    next(err);
  }
}

async function clearConversation(req, res, next) {
  try {
    const result = await conversationService.clearConversationForUser(req.params.id, req.user._id);
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${req.user._id}`).emit('chat_cleared', { conversationId: req.params.id });
    }
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function deleteChat(req, res, next) {
  try {
    const result = await conversationService.deleteChatForUser(req.params.id, req.user._id);
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${req.user._id}`).emit('chat_deleted', { conversationId: req.params.id });
    }
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function exportChat(req, res, next) {
  try {
    const data = await conversationService.exportChatForUser(req.params.id, req.user._id);
    const safeName = (data.conversation.name || 'Chat').replace(/[^a-zA-Z0-9_-]/g, '_');
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `PixelTalk-${safeName}-${dateStr}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(JSON.stringify(data, null, 2));
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list,
  search,
  getOne,
  createGroup,
  uploadGroupAvatar,
  startDirect,
  patchSettings,
  getMembers,
  updateMemberRole,
  addMembers,
  invite,
  getMyInvitations,
  getGroupInvitations,
  respondInvitation,
  removeMember,
  pinConversation,
  join,
  leave,
  remove,
  clearConversation,
  deleteChat,
  exportChat,
};
