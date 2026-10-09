/*
 * ============================================================
 * PIXELTALK — DATABASE MODEL: ADMIN AUDIT LOG (AdminAuditLog.js)
 * ============================================================
 *
 * WHAT DATA IS STORED?
 * Stores immutable governance audit records of every administrative & security action on PixelTalk:
 * - Admin or actor account ID (`adminId`), nullable for unauthenticated access attempts.
 * - Action type (`USER_BANNED`, `USER_SUSPENDED`, `USER_DELETED`, `GROUP_DELETED`, `ADMIN_LOGIN_SUCCESS`,
 *   `ADMIN_LOGIN_FAILED`, `UNAUTHORIZED_ADMIN_ACCESS_ATTEMPT`, etc.).
 * - Target resource type (`'user'` | `'group'` | `'message'` | `'system'` | `'security'`) and optional ID (`targetId`).
 * - Sanitized metadata details (ipAddress, reason, affected fields, previous state).
 *
 * WHY IS IT STORED?
 * To guarantee complete administrative accountability, security compliance, and auditing
 * of all platform moderation and access events without storing sensitive credentials or private message content.
 *
 * PRIVACY GUARANTEE:
 * - Audit logs MUST NEVER contain passwords, hashes, tokens, OTPs, or private chat message bodies.
 *
 * COLLECTION RELATIONSHIPS:
 * AdminAuditLog
 *  └── adminId ──► References [User] (the actor/administrator performing or attempting the action)
 *
 * INDEXES & PERFORMANCE:
 * - `{ createdAt: -1 }`: Fast timestamp index for chronological audit log rendering in the Admin Console.
 * - `{ action: 1, createdAt: -1 }`: Fast index for filtering by event type.
 * ============================================================
 */

const mongoose = require('mongoose');

const adminAuditLogSchema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false, default: null },
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
        'ADMIN_LOGIN_SUCCESS',
        'ADMIN_LOGIN_FAILED',
        'UNAUTHORIZED_ADMIN_ACCESS_ATTEMPT',
        'ADMIN_ACTION_OTHER',
      ],
    },
    targetType: {
      type: String,
      enum: ['user', 'group', 'message', 'system', 'security'],
      default: 'system',
      required: true,
    },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: false, default: null },
    metadata: { type: Object, default: {} },
  },
  { timestamps: true },
);

adminAuditLogSchema.index({ createdAt: -1 });
adminAuditLogSchema.index({ action: 1, createdAt: -1 });
adminAuditLogSchema.index({ adminId: 1 });

adminAuditLogSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);

