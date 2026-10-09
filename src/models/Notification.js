/**
 * Notification Model (models/Notification.js)
 *
 * Responsibility:
 * Persistent data model for user notifications across messages, social follows,
 * group invitations, calls, and security alerts.
 *
 * CONNECTED MODULES:
 * - Services: backend/src/services/notificationService.js
 * - Controllers: backend/src/controllers/notificationController.js
 * - Sockets: backend/src/sockets/index.js
 */

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    type: {
      type: String,
      enum: [
        'message_direct',
        'message_group',
        'group_invitation',
        'group_joined',
        'group_call_started',
        'call_incoming',
        'call_missed',
        'follow_request',
        'follow_accepted',
        'new_follower',
        'security_alert',
        'system_alert',
      ],
      required: true,
    },
    category: {
      type: String,
      enum: ['messages', 'social', 'groups', 'calls', 'account'],
      default: 'messages',
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    targetType: {
      type: String,
      enum: ['conversation', 'group', 'user', 'profile', 'call', 'settings', 'none'],
      default: 'none',
    },
    targetId: {
      type: String,
      default: null,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for chronological and filtered retrieval
notificationSchema.index({ recipientId: 1, createdAt: -1 });
notificationSchema.index({ recipientId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ recipientId: 1, category: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
