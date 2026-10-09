/**
 * Notification Service (services/notificationService.js)
 *
 * Responsibility:
 * Central business logic for creating, delivering, querying, marking read,
 * and deleting notifications across PixelTalk.
 *
 * CONNECTED MODULES:
 * - Model: backend/src/models/Notification.js, backend/src/models/User.js, backend/src/models/Conversation.js
 * - Sockets: backend/src/sockets/index.js
 * - Controllers: backend/src/controllers/notificationController.js
 */

const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const { ApiError } = require('../utils/apiResponse');

/**
 * Creates and delivers a persistent notification.
 */
async function createNotification({
  recipientId,
  actorId = null,
  type,
  category = 'messages',
  title,
  body,
  targetType = 'none',
  targetId = null,
  data = {},
  io = null,
}) {
  if (!recipientId) return null;

  // Avoid self-notifications
  if (actorId && String(recipientId) === String(actorId)) {
    return null;
  }

  // Fetch recipient to check preferences & existence
  const recipient = await User.findById(recipientId).select('notificationsEnabled notificationMode mutedConversations status');
  if (!recipient || recipient.status !== 'active') {
    return null;
  }

  // If target is a conversation, verify mute status & privacy
  let isMuted = false;
  if (targetType === 'conversation' && targetId) {
    if (Array.isArray(recipient.mutedConversations)) {
      isMuted = recipient.mutedConversations.some((cId) => String(cId) === String(targetId));
    }
  }

  // Sanitize title & body limits
  const cleanTitle = String(title || 'Notification').slice(0, 120);
  const cleanBody = String(body || '').slice(0, 500);

  const notification = await Notification.create({
    recipientId,
    actorId: actorId ? new mongoose.Types.ObjectId(actorId) : null,
    type,
    category,
    title: cleanTitle,
    body: cleanBody,
    targetType,
    targetId: targetId ? String(targetId) : null,
    data: {
      ...data,
      isMuted,
    },
    isRead: false,
  });

  const populated = await Notification.findById(notification._id)
    .populate('actorId', 'username displayName avatarId avatarUrl')
    .lean();

  // Realtime Socket delivery to the user's private notification channel
  if (io) {
    try {
      const unreadCount = await Notification.countDocuments({
        recipientId,
        isRead: false,
      });

      io.to(`user:${recipientId}`).emit('notification_received', {
        notification: populated,
        unreadCount,
        isMuted,
      });
    } catch (err) {
      console.warn('[notificationService] Socket broadcast notice:', err.message);
    }
  }

  return populated;
}

/**
 * Lists notifications for a recipient with category filters and pagination.
 */
async function listNotifications(recipientId, { category, isRead, before, limit = 20 } = {}) {
  const query = { recipientId };

  if (category && category !== 'all') {
    query.category = category;
  }

  if (typeof isRead === 'boolean') {
    query.isRead = isRead;
  } else if (isRead === 'true' || isRead === 'false') {
    query.isRead = isRead === 'true';
  }

  if (before && mongoose.isValidObjectId(before)) {
    const beforeDoc = await Notification.findById(before).select('createdAt');
    if (beforeDoc) {
      query.createdAt = { $lt: beforeDoc.createdAt };
    }
  }

  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

  const [notifications, totalUnread] = await Promise.all([
    Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(parsedLimit + 1)
      .populate('actorId', 'username displayName avatarId avatarUrl')
      .lean(),
    Notification.countDocuments({ recipientId, isRead: false }),
  ]);

  const hasMore = notifications.length > parsedLimit;
  const items = hasMore ? notifications.slice(0, parsedLimit) : notifications;
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]._id : null;

  return {
    notifications: items,
    totalUnread,
    hasMore,
    nextCursor,
  };
}

/**
 * Gets total unread notification count for a user.
 */
async function getUnreadCount(recipientId) {
  const unreadCount = await Notification.countDocuments({
    recipientId,
    isRead: false,
  });
  return { unreadCount };
}

/**
 * Marks a single notification as read (strictly authorized by recipientId).
 */
async function markAsRead(recipientId, notificationId, io = null) {
  if (!mongoose.isValidObjectId(notificationId)) {
    throw new ApiError(400, 'Invalid notification ID');
  }

  const notification = await Notification.findOne({
    _id: notificationId,
    recipientId,
  });

  if (!notification) {
    throw new ApiError(404, 'Notification not found or access denied');
  }

  if (!notification.isRead) {
    notification.isRead = true;
    notification.readAt = new Date();
    await notification.save();
  }

  const unreadCount = await Notification.countDocuments({
    recipientId,
    isRead: false,
  });

  if (io) {
    io.to(`user:${recipientId}`).emit('notification_read', {
      notificationId: String(notification._id),
      unreadCount,
    });
  }

  return { success: true, notification, unreadCount };
}

/**
 * Marks all notifications for a user as read.
 */
async function markAllAsRead(recipientId, io = null) {
  await Notification.updateMany(
    { recipientId, isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );

  if (io) {
    io.to(`user:${recipientId}`).emit('notification_all_read', {
      unreadCount: 0,
    });
  }

  return { success: true, unreadCount: 0 };
}

/**
 * Deletes a single notification (strictly authorized by recipientId).
 */
async function deleteNotification(recipientId, notificationId, io = null) {
  if (!mongoose.isValidObjectId(notificationId)) {
    throw new ApiError(400, 'Invalid notification ID');
  }

  const notification = await Notification.findOneAndDelete({
    _id: notificationId,
    recipientId,
  });

  if (!notification) {
    throw new ApiError(404, 'Notification not found or access denied');
  }

  const unreadCount = await Notification.countDocuments({
    recipientId,
    isRead: false,
  });

  if (io) {
    io.to(`user:${recipientId}`).emit('notification_deleted', {
      notificationId: String(notificationId),
      unreadCount,
    });
  }

  return { success: true, unreadCount };
}

module.exports = {
  createNotification,
  listNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
};
