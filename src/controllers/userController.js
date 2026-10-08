/**
 * User Controller
 *
 * Responsibility:
 * Coordinates user profile queries, identity mutations (bio, avatar, preferences),
 * username availability checks, and per-user conversation personalization (pin, mute, vibrate).
 *
 * CONNECTED MODULES:
 * - Routes: backend/src/routes/index.js (/api/users/*)
 * - Services: backend/src/services/userService.js, backend/src/services/authService.js
 * - Models: backend/src/models/User.js
 * - Frontend: frontend/services/userService.js, frontend/features/profile/*
 *
 * CONCEPT: Sanitized Serialization
 * All user objects returned to clients are routed through `userService.publicUser()`,
 * guaranteeing that sensitive security fields (e.g. passwordHash) are never leaked.
 */

const { ok } = require('../utils/apiResponse');
const userService = require('../services/userService');

async function getMe(req, res, next) {
  try {
    const followService = require('../services/followService');
    const counts = await followService.getFollowCounts(req.user._id);
    ok(res, { user: { ...userService.publicUser(req.user, req.user._id), ...counts } });
  } catch (err) {
    next(err);
  }
}

async function patchMe(req, res, next) {
  try {
    const updated = await userService.updateMe(req.user, req.body);
    ok(res, { user: userService.publicUser(updated, req.user._id) });
  } catch (err) {
    next(err);
  }
}

async function patchMyPassword(req, res, next) {
  try {
    const authService = require('../services/authService');
    const { validPassword } = require('../utils/validation');
    const currentPassword = validPassword(req.body.currentPassword);
    const newPassword = validPassword(req.body.newPassword);
    await authService.changePassword(req.user, { currentPassword, newPassword });
    ok(res, { message: 'Password updated' });
  } catch (err) {
    next(err);
  }
}

async function checkUsername(req, res, next) {
  try {
    const result = await userService.checkUsernameAvailability(req.query.username, req.user?._id);
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function togglePin(req, res, next) {
  try {
    const result = await userService.togglePinConversation(req.user._id, req.params.conversationId);
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function toggleMute(req, res, next) {
  try {
    const result = await userService.toggleMuteConversation(req.user._id, req.params.conversationId);
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function toggleVibrate(req, res, next) {
  try {
    const result = await userService.toggleVibrateConversation(req.user._id, req.params.conversationId);
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function getUser(req, res, next) {
  try {
    const user = await userService.getProfile(req.params.id, req.user?._id);
    ok(res, { user });
  } catch (err) {
    next(err);
  }
}

async function getUserByUsername(req, res, next) {
  try {
    const user = await userService.getProfile(req.params.username, req.user?._id);
    ok(res, { user });
  } catch (err) {
    next(err);
  }
}

async function search(req, res, next) {
  try {
    const users = await userService.searchUsers(req.query.q, req.query.limit, req.user?._id);
    ok(res, { users });
  } catch (err) {
    next(err);
  }
}

async function uploadAvatar(req, res, next) {
  try {
    const updated = await userService.updateAvatar(req.user._id, req.file.buffer);
    ok(res, { user: userService.publicUser(updated) });
  } catch (err) {
    next(err);
  }
}

async function deleteAvatar(req, res, next) {
  try {
    const updated = await userService.deleteAvatar(req.user._id);
    ok(res, { user: userService.publicUser(updated) });
  } catch (err) {
    next(err);
  }
}

async function uploadBanner(req, res, next) {
  try {
    const updated = await userService.updateBanner(req.user._id, req.file.buffer);
    ok(res, { user: userService.publicUser(updated) });
  } catch (err) {
    next(err);
  }
}

async function deleteBanner(req, res, next) {
  try {
    const updated = await userService.deleteBanner(req.user._id);
    ok(res, { user: userService.publicUser(updated) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getMe,
  patchMe,
  patchMyPassword,
  checkUsername,
  togglePin,
  toggleMute,
  toggleVibrate,
  getUser,
  getUserByUsername,
  search,
  uploadAvatar,
  deleteAvatar,
  uploadBanner,
  deleteBanner,
};
