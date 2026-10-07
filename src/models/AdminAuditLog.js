/*
 * ============================================================
 * PIXELTALK — DATABASE MODEL: ADMIN AUDIT LOG (AdminAuditLog.js)
 * ============================================================
 *
 * WHAT DATA IS STORED?
 * Stores immutable governance audit records of every administrative action taken on PixelTalk:
 * - Admin account ID (`adminId`).
 * - Moderation action type (`USER_BANNED`, `USER_SUSPENDED`, `GROUP_DELETED`, `USER_ROLE_CHANGED`, etc.).
 * - Target resource type (`'user'` | `'group'` | `'message'` | `'system'`) and ID (`targetId`).
 * - Action metadata details (ipAddress, reason, previous state).
 *
 * WHY IS IT STORED?
 * To guarantee complete administrative accountability, security compliance, and auditing
 * of all moderation interventions across players and community lounges.
 *
 * COLLECTION RELATIONSHIPS:
 * AdminAuditLog
 *  └── adminId ──► References [User] (the administrator performing the action)
 *
 * INDEXES & PERFORMANCE:
 * - `{ createdAt: -1 }`: Fast timestamp index for chronological audit log rendering in the Admin Console.
 * ============================================================
 */

const mongoose = require('mongoose');

const adminAuditLogSchema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: {
      type: String,
      required: true,
      enum: [
        'USER_SUSPENDED',
        'USER_UNSUSPENDED',
        'USER_BANNED',
        'USER_UNBANNED',
        'USER_DELETED',
        'USER_ROLE_CHANGED',
        'GROUP_DELETED',
        'GROUP_RESTORED',
        'ADMIN_CHANGED_ROOM_NAME',
        'ADMIN_CHANGED_USER_ROLE',
        'ADMIN_CHANGED_PASSWORD',
        'ADMIN_SETTINGS_UPDATED',
        'MESSAGE_DELETED',
        'ADMIN_ACTION_OTHER',
      ],
    },
    targetType: { type: String, enum: ['user', 'group', 'message', 'system'], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    metadata: { type: Object, default: {} },
  },
  { timestamps: true },
);

adminAuditLogSchema.index({ createdAt: -1 });
adminAuditLogSchema.index({ adminId: 1 });

adminAuditLogSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);
