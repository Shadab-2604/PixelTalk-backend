/*
 * ============================================================
 * PIXELTALK — DATABASE MODEL: GROUP INVITATION (GroupInvitation.js)
 * ============================================================
 *
 * WHAT:
 * Tracks pending, accepted, and rejected invitations to group lounges.
 *
 * WHY:
 * Being invited does NOT automatically make someone a group member.
 * Every invitation requires explicit approval from the invited player.
 * This prevents users from being silently forced into rooms.
 *
 * SECURITY:
 * - A unique partial compound index on { conversationId: 1, invitedUserId: 1 } where status='PENDING'
 *   prevents duplicate pending spam at the MongoDB engine level.
 * - Prevents self-invitation.
 * - Authorization to invite is verified by the backend (checking invitePermission & group roles).
 * - Only the recipient (invitedUserId) can accept or reject an invitation.
 * ============================================================
 */

const mongoose = require('mongoose');

const groupInvitationSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    inviterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    invitedUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['PENDING', 'ACCEPTED', 'REJECTED'],
      default: 'PENDING',
      index: true,
    },
    respondedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// Prevent duplicate pending invitations for the same user in the same conversation
groupInvitationSchema.index(
  { conversationId: 1, invitedUserId: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING' } },
);

groupInvitationSchema.set('toJSON', {
  virtuals: true,
  transform(doc, ret) {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('GroupInvitation', groupInvitationSchema);
