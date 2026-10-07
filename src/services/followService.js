/*
 * ============================================================
 * PIXELTALK — FOLLOW SERVICE (services/followService.js)
 * ============================================================
 *
 * WHAT:
 * Business logic for following, unfollowing, follow requests, and follow approvals.
 *
 * RULES:
 * 1. Self-follow is strictly prohibited.
 * 2. Public accounts: Following creates or sets status = 'ACCEPTED' immediately.
 * 3. Private accounts: Following creates or sets status = 'PENDING'.
 * 4. Private account owners can ACCEPT or REJECT pending follow requests.
 * 5. Followers/Following lists for private accounts are restricted to approved followers and the owner.
 *
 * REALTIME:
 * Emits user-targeted Socket.IO events to personal rooms (`user:<id>`) on request and response.
 * ============================================================
 */

const mongoose = require('mongoose');
const Follow = require('../models/Follow');
const User = require('../models/User');
const { ApiError } = require('../utils/apiResponse');

/**
 * Follow a target user (immediate if public, pending request if private).
 */
async function followUser(followerId, targetUserId, io = null) {
  if (String(followerId) === String(targetUserId)) {
    throw new ApiError(400, 'You cannot follow yourself');
  }

  if (!mongoose.isValidObjectId(targetUserId)) {
    throw new ApiError(400, 'Invalid user ID');
  }

  const targetUser = await User.findById(targetUserId).select('username displayName avatarId privacy status');
  if (!targetUser || targetUser.status !== 'active') {
    throw new ApiError(404, 'User not found or account is inactive');
  }

  const followerUser = await User.findById(followerId).select('username displayName avatarId');

  const isPrivate = targetUser.privacy?.accountType === 'private';
  const targetStatus = isPrivate ? 'PENDING' : 'ACCEPTED';

  let follow = await Follow.findOne({ followerId, followingId: targetUserId });
  if (follow) {
    if (follow.status === 'ACCEPTED') {
      return { follow, status: 'ACCEPTED', alreadyFollowing: true };
    }
    follow.status = targetStatus;
    await follow.save();
  } else {
    follow = await Follow.create({
      followerId,
      followingId: targetUserId,
      status: targetStatus,
    });
  }

  // Socket notification
  if (io) {
    if (isPrivate) {
      io.to(`user:${targetUserId}`).emit('follow_requested', {
        follower: {
          _id: followerUser._id,
          id: followerUser._id,
          username: followerUser.username,
          displayName: followerUser.displayName,
          avatarId: followerUser.avatarId,
        },
        followId: follow._id,
      });
    } else {
      io.to(`user:${targetUserId}`).emit('new_follower', {
        follower: {
          _id: followerUser._id,
          id: followerUser._id,
          username: followerUser.username,
          displayName: followerUser.displayName,
          avatarId: followerUser.avatarId,
        },
      });
    }
  }

  return { follow, status: targetStatus, alreadyFollowing: false };
}

/**
 * Unfollow a user or cancel a pending request.
 */
async function unfollowUser(followerId, targetUserId, io = null) {
  if (String(followerId) === String(targetUserId)) {
    throw new ApiError(400, 'Invalid operation');
  }

  await Follow.findOneAndDelete({ followerId, followingId: targetUserId });

  if (io) {
    io.to(`user:${targetUserId}`).emit('follower_removed', { followerId: String(followerId) });
  }

  return { success: true };
}

/**
 * Accept or reject a pending follow request (only the private account owner can do this).
 */
async function respondFollowRequest(targetUserId, followerId, action, io = null) {
  const normAction = String(action || '').toUpperCase();
  if (!['ACCEPT', 'REJECT'].includes(normAction)) {
    throw new ApiError(400, "Action must be 'ACCEPT' or 'REJECT'");
  }

  const follow = await Follow.findOne({
    followerId,
    followingId: targetUserId,
    status: 'PENDING',
  });

  if (!follow) {
    throw new ApiError(404, 'Pending follow request not found');
  }

  if (normAction === 'ACCEPT') {
    follow.status = 'ACCEPTED';
    await follow.save();
  } else {
    follow.status = 'REJECTED';
    await follow.save();
  }

  if (io) {
    const owner = await User.findById(targetUserId).select('username displayName avatarId');
    io.to(`user:${followerId}`).emit('follow_responded', {
      targetUser: {
        _id: owner._id,
        id: owner._id,
        username: owner.username,
        displayName: owner.displayName,
        avatarId: owner.avatarId,
      },
      status: follow.status,
    });
  }

  return { success: true, status: follow.status };
}

/**
 * Get current follow status between two users.
 * Returns 'ACCEPTED' | 'PENDING' | 'REJECTED' | 'NONE'
 */
async function getFollowStatus(followerId, targetUserId) {
  if (!followerId || !targetUserId || String(followerId) === String(targetUserId)) {
    return 'NONE';
  }

  const record = await Follow.findOne({ followerId, followingId: targetUserId }).select('status').lean();
  return record ? record.status : 'NONE';
}

/**
 * Count followers and following for a user.
 */
async function getFollowCounts(userId) {
  const [followersCount, followingCount] = await Promise.all([
    Follow.countDocuments({ followingId: userId, status: 'ACCEPTED' }),
    Follow.countDocuments({ followerId: userId, status: 'ACCEPTED' }),
  ]);
  return { followersCount, followingCount };
}

/**
 * List pending follow requests for the authenticated owner of a private account.
 */
async function getPendingRequests(userId) {
  const requests = await Follow.find({
    followingId: userId,
    status: 'PENDING',
  })
    .sort({ createdAt: -1 })
    .populate('followerId', 'username displayName avatarId avatarUrl presence lastSeen')
    .lean();

  return requests.map((r) => ({
    followId: r._id,
    follower: r.followerId,
    createdAt: r.createdAt,
  }));
}

/**
 * List followers of a user with privacy protection.
 */
async function getFollowers(userId, viewerId, { page = 1, limit = 20 } = {}) {
  const targetUser = await User.findById(userId).select('privacy status');
  if (!targetUser || targetUser.status !== 'active') throw new ApiError(404, 'User not found');

  const isOwner = String(userId) === String(viewerId);
  const isPrivate = targetUser.privacy?.accountType === 'private';

  if (isPrivate && !isOwner) {
    const isAccepted = await Follow.findOne({ followerId: viewerId, followingId: userId, status: 'ACCEPTED' });
    if (!isAccepted) {
      throw new ApiError(403, 'This account is private. You must follow them to view their followers list.');
    }
  }

  const skip = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const docs = await Follow.find({ followingId: userId, status: 'ACCEPTED' })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('followerId', 'username displayName avatarId avatarUrl presence lastSeen')
    .lean();

  const total = await Follow.countDocuments({ followingId: userId, status: 'ACCEPTED' });

  return {
    followers: docs.map((d) => d.followerId).filter(Boolean),
    total,
    page: Number(page),
    hasMore: skip + docs.length < total,
  };
}

/**
 * List following accounts of a user with privacy protection.
 */
async function getFollowing(userId, viewerId, { page = 1, limit = 20 } = {}) {
  const targetUser = await User.findById(userId).select('privacy status');
  if (!targetUser || targetUser.status !== 'active') throw new ApiError(404, 'User not found');

  const isOwner = String(userId) === String(viewerId);
  const isPrivate = targetUser.privacy?.accountType === 'private';

  if (isPrivate && !isOwner) {
    const isAccepted = await Follow.findOne({ followerId: viewerId, followingId: userId, status: 'ACCEPTED' });
    if (!isAccepted) {
      throw new ApiError(403, 'This account is private. You must follow them to view their following list.');
    }
  }

  const skip = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const docs = await Follow.find({ followerId: userId, status: 'ACCEPTED' })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('followingId', 'username displayName avatarId avatarUrl presence lastSeen')
    .lean();

  const total = await Follow.countDocuments({ followerId: userId, status: 'ACCEPTED' });

  return {
    following: docs.map((d) => d.followingId).filter(Boolean),
    total,
    page: Number(page),
    hasMore: skip + docs.length < total,
  };
}

module.exports = {
  followUser,
  unfollowUser,
  respondFollowRequest,
  getFollowStatus,
  getFollowCounts,
  getPendingRequests,
  getFollowers,
  getFollowing,
};
