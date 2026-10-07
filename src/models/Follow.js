/*
 * ============================================================
 * PIXELTALK — DATABASE MODEL: FOLLOW (Follow.js)
 * ============================================================
 *
 * WHAT:
 * Manages follow relationships and follow requests between users.
 * Supports public immediate follows and private account approval flows.
 *
 * WHY:
 * Private accounts require explicit authorization before a requester
 * can view full profile details (bio, banner) or initiate direct messaging.
 *
 * STATUSES:
 * - PENDING: Follow requested on a private account, awaiting approval.
 * - ACCEPTED: Mutual follow access granted (immediate for public, approved for private).
 * - REJECTED: Follow request rejected by private account owner.
 *
 * INDEXES & PERFORMANCE:
 * - `{ followerId: 1, followingId: 1 }`: Unique compound index preventing duplicate entries.
 * - `{ followingId: 1, status: 1 }`: Fast lookup of a user's followers or pending requests.
 * - `{ followerId: 1, status: 1 }`: Fast lookup of accounts a user is following.
 * ============================================================
 */

const mongoose = require('mongoose');

const followSchema = new mongoose.Schema(
  {
    followerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    followingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['PENDING', 'ACCEPTED', 'REJECTED'],
      required: true,
      default: 'PENDING',
      index: true,
    },
  },
  { timestamps: true },
);

// Prevent duplicate follow records between the same pair
followSchema.index({ followerId: 1, followingId: 1 }, { unique: true });
followSchema.index({ followingId: 1, status: 1 });
followSchema.index({ followerId: 1, status: 1 });

module.exports = mongoose.model('Follow', followSchema);
