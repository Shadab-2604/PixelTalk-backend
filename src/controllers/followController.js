/**
 * Follow Controller
 *
 * Coordinates follow requests, approvals, rejections, follower/following lists,
 * and user-targeted Socket.IO notifications.
 */

const { ok } = require('../utils/apiResponse');
const followService = require('../services/followService');

async function followUser(req, res, next) {
  try {
    const io = req.app.get('io');
    const result = await followService.followUser(req.user._id, req.params.id, io);
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function unfollowUser(req, res, next) {
  try {
    const io = req.app.get('io');
    const result = await followService.unfollowUser(req.user._id, req.params.id, io);
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function respondFollowRequest(req, res, next) {
  try {
    const io = req.app.get('io');
    const result = await followService.respondFollowRequest(
      req.user._id,
      req.params.followerId,
      req.body.action,
      io,
    );
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function getPendingRequests(req, res, next) {
  try {
    const requests = await followService.getPendingRequests(req.user._id);
    ok(res, { requests });
  } catch (err) {
    next(err);
  }
}

async function getFollowers(req, res, next) {
  try {
    const data = await followService.getFollowers(req.params.id, req.user._id, req.query);
    ok(res, data);
  } catch (err) {
    next(err);
  }
}

async function getFollowing(req, res, next) {
  try {
    const data = await followService.getFollowing(req.params.id, req.user._id, req.query);
    ok(res, data);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  followUser,
  unfollowUser,
  respondFollowRequest,
  getPendingRequests,
  getFollowers,
  getFollowing,
};
