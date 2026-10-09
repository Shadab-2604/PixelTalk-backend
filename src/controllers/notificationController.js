/**
 * Notification Controller (controllers/notificationController.js)
 *
 * Responsibility:
 * Express route handlers for listing notifications, fetching unread counts,
 * marking individual or all notifications as read, and deleting notifications.
 *
 * CONNECTED MODULES:
 * - Service: backend/src/services/notificationService.js
 * - Router: backend/src/routes/index.js
 */

const notificationService = require('../services/notificationService');
const { ok } = require('../utils/apiResponse');

async function list(req, res) {
  const recipientId = req.user._id;
  const { category, isRead, before, limit } = req.query;

  const result = await notificationService.listNotifications(recipientId, {
    category,
    isRead,
    before,
    limit,
  });

  return ok(res, result);
}

async function getUnreadCount(req, res) {
  const recipientId = req.user._id;
  const result = await notificationService.getUnreadCount(recipientId);
  return ok(res, result);
}

async function markRead(req, res) {
  const recipientId = req.user._id;
  const { id } = req.params;
  const io = req.app.get('io');

  const result = await notificationService.markAsRead(recipientId, id, io);
  return ok(res, result);
}

async function markAllRead(req, res) {
  const recipientId = req.user._id;
  const io = req.app.get('io');

  const result = await notificationService.markAllAsRead(recipientId, io);
  return ok(res, result);
}

async function deleteNotification(req, res) {
  const recipientId = req.user._id;
  const { id } = req.params;
  const io = req.app.get('io');

  const result = await notificationService.deleteNotification(recipientId, id, io);
  return ok(res, result);
}

module.exports = {
  list,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
};
