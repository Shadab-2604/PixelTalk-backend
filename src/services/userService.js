/**
 * User Service
 *
 * Responsibility:
 * Encapsulates user profile business logic:
 * - Sanitizing user records into public-safe objects (`publicUser`)
 * - Validating username uniqueness during profile changes
 * - Managing appearance, audio, and notification preferences
 * - Managing per-user conversation personalization (pinning, muting, vibration)
 * - User search by username and display name
 *
 * CONNECTED MODULES:
 * - Controllers: backend/src/controllers/userController.js, backend/src/controllers/authController.js
 * - Models: backend/src/models/User.js, backend/src/models/Conversation.js
 * - Sockets: backend/src/sockets/index.js (presence updates)
 * - Frontend: frontend/services/userService.js, frontend/features/profile/*
 *
 * CONCEPT: Idempotent Array Mutation ($addToSet / $pull)
 * Pinning, muting, and vibrating use atomic MongoDB array operators to guarantee
 * consistent state without race conditions.
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const { ApiError } = require('../utils/apiResponse');
const { requireString, validEmail, validUsername, validAvatarId, sanitizeLimit } = require('../utils/validation');
const redisService = require('./redisService');

const cloudinaryService = require('./cloudinaryService');

/**
 * Invalidate user profile and lookup caches across Redis
 */
async function invalidateUserCache(userId, username) {
  if (!redisService.isRedisReady()) return;
  try {
    const promises = [];
    if (userId) {
      promises.push(redisService.deleteCache(`pixeltalk:user:byid:${userId}`));
      promises.push(redisService.deleteByPrefix(`pixeltalk:user:profile:${userId}`));
    }
    if (username) {
      promises.push(redisService.deleteByPrefix(`pixeltalk:user:profile:${username}`));
    }
    await Promise.all(promises);
  } catch (err) {
    // Non-blocking fallback
    console.warn('[userService] Redis cache invalidation error:', err.message);
  }
}


function publicUser(u, viewerId = null, followStatus = null) {
  if (!u) return null;
  const o = u.toJSON ? u.toJSON() : u;
  const isOwner = viewerId && String(o._id || o.id) === String(viewerId);

  // If requesting own profile, return complete details
  if (isOwner) {
    return {
      _id: o._id || o.id,
      id: o._id || o.id,
      username: o.username,
      displayName: o.displayName,
      email: o.email,
      avatarId: o.avatarId,
      avatarUrl: o.avatarUrl || '',
      avatarPublicId: o.avatarPublicId || '',
      bannerUrl: o.bannerUrl || '',
      bannerPublicId: o.bannerPublicId || '',
      bannerId: o.bannerId || 'banner-01',
      bio: o.bio || '',
      customStatus: o.customStatus || '',
      role: o.role,
      status: o.status,
      presence: o.presence,
      lastSeen: o.lastSeen,
      preferences: o.preferences || {
        theme: 'system',
        soundEnabled: true,
        soundVolume: 80,
        notificationsEnabled: true,
        notificationMode: 'normal',
        density: 'comfortable',
      },
      privacy: o.privacy || { accountType: 'public' },
      isPrivate: o.privacy?.accountType === 'private',
      canMessage: true,
      pinnedConversations: Array.isArray(o.pinnedConversations)
        ? o.pinnedConversations.map((id) => (id?._id ? id._id.toString() : id?.toString()))
        : [],
      mutedConversations: Array.isArray(o.mutedConversations)
        ? o.mutedConversations.map((id) => (id?._id ? id._id.toString() : id?.toString()))
        : [],
      vibrateConversations: Array.isArray(o.vibrateConversations)
        ? o.vibrateConversations.map((id) => (id?._id ? id._id.toString() : id?.toString()))
        : [],
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    };
  }

  const isPrivate = o.privacy?.accountType === 'private';
  const isApprovedFollower = followStatus === 'ACCEPTED';

  // Strict Private Account Protection:
  // If private and requester is not an approved follower, return ONLY minimal discovery fields.
  if (isPrivate && !isApprovedFollower) {
    return {
      _id: o._id || o.id,
      id: o._id || o.id,
      username: o.username,
      displayName: o.displayName,
      avatarId: o.avatarId,
      avatarUrl: o.avatarUrl || '',
      presence: o.presence,
      privacy: { accountType: 'private' },
      isPrivate: true,
      followStatus: followStatus || 'NONE',
      canMessage: false,
    };
  }

  // Public account or approved follower on private account
  return {
    _id: o._id || o.id,
    id: o._id || o.id,
    username: o.username,
    displayName: o.displayName,
    avatarId: o.avatarId,
    avatarUrl: o.avatarUrl || '',
    bannerUrl: o.bannerUrl || '',
    bannerId: o.bannerId || 'banner-01',
    bio: o.bio || '',
    customStatus: o.customStatus || '',
    presence: o.presence,
    lastSeen: o.lastSeen,
    privacy: o.privacy || { accountType: 'public' },
    isPrivate,
    followStatus: followStatus || 'NONE',
    canMessage: true,
    createdAt: o.createdAt,
  };
}

async function checkUsernameAvailability(username, currentUserId) {
  const clean = typeof username === 'string' ? username.trim().replace(/^@+/, '').toLowerCase() : '';
  if (!clean || clean.length < 3 || clean.length > 30 || !/^[a-zA-Z0-9_]+$/.test(clean)) {
    return { available: false, reason: 'Must be 3–30 letters, numbers, or underscores' };
  }
  const query = { username: clean };
  if (currentUserId) query._id = { $ne: currentUserId };
  const existing = await User.findOne(query);
  if (existing) {
    return { available: false, reason: 'Username already taken.' };
  }
  return { available: true, username: clean };
}

async function updateMe(user, body) {
  const updates = {};
  if (body.displayName !== undefined) updates.displayName = requireString(body.displayName, 'Display name', { min: 1, max: 32 });
  if (body.username !== undefined) updates.username = validUsername(body.username);
  if (body.email !== undefined) updates.email = validEmail(body.email);
  if (body.avatarId !== undefined) updates.avatarId = validAvatarId(body.avatarId);
  if (body.bannerId !== undefined) {
    const validBannerIds = Array.from({ length: 10 }, (_, i) => `banner-${String(i + 1).padStart(2, '0')}`);
    if (validBannerIds.includes(body.bannerId)) {
      updates.bannerId = body.bannerId;
    }
  }
  if (body.bio !== undefined) updates.bio = String(body.bio).slice(0, 240);
  if (body.customStatus !== undefined) updates.customStatus = String(body.customStatus).slice(0, 100);

  if (body.privacy && typeof body.privacy === 'object') {
    if (['public', 'private'].includes(body.privacy.accountType)) {
      updates['privacy.accountType'] = body.privacy.accountType;
    }
  }

  if (body.preferences && typeof body.preferences === 'object') {
    const p = body.preferences;
    updates.preferences = {
      ...(user.preferences || {}),
      ...(p.theme && ['light', 'dark', 'system'].includes(p.theme) ? { theme: p.theme } : {}),
      ...(typeof p.soundEnabled === 'boolean' ? { soundEnabled: p.soundEnabled } : {}),
      ...(typeof p.soundVolume === 'number' ? { soundVolume: Math.max(0, Math.min(100, p.soundVolume)) } : {}),
      ...(typeof p.notificationsEnabled === 'boolean' ? { notificationsEnabled: p.notificationsEnabled } : {}),
      ...(p.notificationMode && ['normal', 'vibrate', 'silent'].includes(p.notificationMode) ? { notificationMode: p.notificationMode } : {}),
      ...(p.density && ['compact', 'comfortable', 'spacious'].includes(p.density) ? { density: p.density } : {}),
    };
  }

  if (Object.keys(updates).length === 0) {
    throw new ApiError(400, 'No valid fields to update');
  }

  if (updates.username || updates.email) {
    const clashConditions = [
      ...(updates.username ? [{ username: updates.username }] : []),
      ...(updates.email ? [{ email: updates.email }] : []),
    ];
    const clash = await User.findOne({
      _id: { $ne: user._id },
      $or: clashConditions,
    });
    if (clash) {
      throw new ApiError(409, clash.email === updates.email ? 'Email is already registered' : 'Username already taken.');
    }
  }

  const updated = await User.findByIdAndUpdate(user._id, updates, { new: true, runValidators: true });
  await invalidateUserCache(user._id, user.username);
  if (updates.username && updates.username !== user.username) {
    await invalidateUserCache(user._id, updates.username);
  }
  return updated;
}

async function togglePinConversation(userId, conversationId) {
  if (!mongoose.isValidObjectId(conversationId)) throw new ApiError(400, 'Invalid conversation id');
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'User not found');

  const convoIdStr = conversationId.toString();
  const existingPins = (user.pinnedConversations || []).map((id) => id.toString());
  const isPinned = existingPins.includes(convoIdStr);

  const updatedPins = isPinned
    ? existingPins.filter((id) => id !== convoIdStr)
    : [convoIdStr, ...existingPins];

  user.pinnedConversations = updatedPins;
  await user.save();
  await invalidateUserCache(userId, user.username);
  return { pinned: !isPinned, pinnedConversations: updatedPins };
}

async function toggleMuteConversation(userId, conversationId) {
  if (!mongoose.isValidObjectId(conversationId)) throw new ApiError(400, 'Invalid conversation id');
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'User not found');

  const convoIdStr = conversationId.toString();
  const existingMutes = (user.mutedConversations || []).map((id) => id.toString());
  const isMuted = existingMutes.includes(convoIdStr);

  const updatedMutes = isMuted
    ? existingMutes.filter((id) => id !== convoIdStr)
    : [convoIdStr, ...existingMutes];

  user.mutedConversations = updatedMutes;
  await user.save();
  await invalidateUserCache(userId, user.username);
  return { muted: !isMuted, mutedConversations: updatedMutes };
}

async function toggleVibrateConversation(userId, conversationId) {
  if (!mongoose.isValidObjectId(conversationId)) throw new ApiError(400, 'Invalid conversation id');
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'User not found');

  const convoIdStr = conversationId.toString();
  const existingVibrate = (user.vibrateConversations || []).map((id) => id.toString());
  const willVibrate = existingVibrate.includes(convoIdStr);

  const updatedVibrate = willVibrate
    ? existingVibrate.filter((id) => id !== convoIdStr)
    : [convoIdStr, ...existingVibrate];

  user.vibrateConversations = updatedVibrate;
  await user.save();
  await invalidateUserCache(userId, user.username);
  return { vibrate: !willVibrate, vibrateConversations: updatedVibrate };
}

async function searchUsers(q, limit, viewerId = null) {
  const term = String(q || '').trim().replace(/^@+/, '');
  if (!term) return [];
  const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const users = await User.find({
    status: 'active',
    $or: [{ username: rx }, { displayName: rx }],
  })
    .limit(sanitizeLimit(limit, 20, 50))
    .sort({ displayName: 1 });

  const followService = require('./followService');
  const results = await Promise.all(
    users.map(async (u) => {
      const followStatus = viewerId ? await followService.getFollowStatus(viewerId, u._id) : 'NONE';
      return publicUser(u, viewerId, followStatus);
    }),
  );
  return results;
}

async function getById(id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid user id');
  const cacheKey = `pixeltalk:user:byid:${id}`;
  const cached = await redisService.getCache(cacheKey);
  if (cached) return cached;

  const user = await User.findById(id);
  if (!user) throw new ApiError(404, 'User not found');
  await redisService.setCache(cacheKey, user, 60);
  return user;
}

async function getProfile(idOrUsername, viewerId) {
  if (!idOrUsername) throw new ApiError(400, 'User identifier required');

  const identifier = String(idOrUsername).trim().replace(/^@+/, '').toLowerCase();
  const cacheKey = `pixeltalk:user:profile:${identifier}:${viewerId || 'anon'}`;
  const cached = await redisService.getCache(cacheKey);
  if (cached) return cached;

  let user = null;
  if (mongoose.isValidObjectId(idOrUsername)) {
    user = await User.findById(idOrUsername);
  }
  if (!user) {
    user = await User.findOne({ username: identifier });
  }

  if (!user || user.status !== 'active') throw new ApiError(404, 'User not found or account is inactive');

  const followService = require('./followService');
  const isOwner = viewerId && String(user._id) === String(viewerId);
  const followStatus = isOwner ? 'SELF' : await followService.getFollowStatus(viewerId, user._id);
  const counts = await followService.getFollowCounts(user._id);

  const base = publicUser(user, viewerId, followStatus);

  /**
   * Social context shown on another user's profile:
   * "Followed by" is derived from the existing follow graph:
   *   people followed by the viewer (viewerFollowing)
   *              INTERSECT
   *   followers of the viewed user (targetFollowers)
   *
   * Privacy filtering: Only calculated for non-owners when target profile is public
   * OR when the viewer is an approved follower of a private profile.
   */
  let socialContext = { followedBy: [], followedByCount: 0 };
  const isPrivate = user.privacy?.accountType === 'private';
  const canViewSocialContext = !isOwner && (!isPrivate || followStatus === 'ACCEPTED');

  if (canViewSocialContext && viewerId) {
    socialContext = await followService.getCommonFollowers(viewerId, user._id);
  }

  const profileData = {
    ...base,
    followersCount: counts.followersCount,
    followingCount: counts.followingCount,
    socialContext,
  };

  // Cache public/viewer profile response with a short TTL (60 seconds)
  await redisService.setCache(cacheKey, profileData, 60);

  return profileData;
}

async function updateAvatar(userId, fileBuffer) {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'User not found');

  const oldPublicId = user.avatarPublicId;
  const uploadResult = await cloudinaryService.uploadImageBuffer(fileBuffer, 'pixeltalk/profiles');

  user.avatarUrl = uploadResult.secure_url;
  user.avatarPublicId = uploadResult.public_id;
  await user.save();

  if (oldPublicId) {
    cloudinaryService.deleteImage(oldPublicId).catch(() => {});
  }

  await invalidateUserCache(userId, user.username);
  return user;
}

async function deleteAvatar(userId) {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'User not found');

  if (user.avatarPublicId) {
    await cloudinaryService.deleteImage(user.avatarPublicId);
  }

  user.avatarUrl = '';
  user.avatarPublicId = '';
  await user.save();

  await invalidateUserCache(userId, user.username);
  return user;
}

async function updateBanner(userId, fileBuffer) {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'User not found');

  const oldPublicId = user.bannerPublicId;
  const uploadResult = await cloudinaryService.uploadImageBuffer(fileBuffer, 'pixeltalk/banners');

  user.bannerUrl = uploadResult.secure_url;
  user.bannerPublicId = uploadResult.public_id;
  await user.save();

  if (oldPublicId) {
    cloudinaryService.deleteImage(oldPublicId).catch(() => {});
  }

  await invalidateUserCache(userId, user.username);
  return user;
}

async function deleteBanner(userId) {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'User not found');

  if (user.bannerPublicId) {
    await cloudinaryService.deleteImage(user.bannerPublicId);
  }

  user.bannerUrl = '';
  user.bannerPublicId = '';
  await user.save();

  await invalidateUserCache(userId, user.username);
  return user;
}

module.exports = {
  publicUser,
  checkUsernameAvailability,
  updateMe,
  togglePinConversation,
  toggleMuteConversation,
  toggleVibrateConversation,
  searchUsers,
  getById,
  getProfile,
  updateAvatar,
  deleteAvatar,
  updateBanner,
  deleteBanner,
};
