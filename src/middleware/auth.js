/**
 * Authentication & Authorization Middleware
 *
 * Responsibility:
 * Authenticates incoming HTTP requests and WebSocket handshakes, validates JWT claims,
 * enforces active account status (blocking suspended/banned users), and checks RBAC permissions.
 *
 * CONNECTED MODULES:
 * - Routes: backend/src/routes/index.js (attached to all protected endpoints)
 * - Sockets: backend/src/sockets/index.js (used in io.use handshake auth)
 * - Models: backend/src/models/User.js (retrieves active account status)
 * - Services: backend/src/services/authService.js (cryptographic token verification)
 *
 * CONCEPT: Hybrid Stateless/Stateful Authentication
 * While the JWT signature proves authenticity statelessly, querying the User record
 * ensures real-time revocation if an administrator bans or suspends an account mid-session.
 */

const cookie = require('cookie');
const User = require('../models/User');
const { verifyToken } = require('../services/authService');
const { ApiError } = require('../utils/apiResponse');
const config = require('../config');

/**
 * Extracts JWT from either the Authorization header or the secure HTTP-only session cookie.
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {string|null} Extracted JWT string or null if not present.
 */
function extractToken(req) {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    return req.headers.authorization.slice(7).trim();
  }
  const cookies = cookie.parse(req.headers.cookie || '');
  return cookies[config.cookieName] || null;
}

async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw new ApiError(401, 'Authentication required');

    const payload = verifyToken(token);
    const user = await User.findById(payload.sub);
    if (!user) throw new ApiError(401, 'Session is no longer valid');
    if (user.status === 'banned') throw new ApiError(403, 'This account has been banned');
    if (user.status === 'suspended') throw new ApiError(403, 'This account is suspended');

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Optional authentication middleware: populates req.user if a valid token is present,
 * but does not reject anonymous requests (crucial for public username uniqueness checks).
 */
async function optionalAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (token) {
      const payload = verifyToken(token);
      const user = await User.findById(payload.sub);
      if (user && user.status === 'active') {
        req.user = user;
      }
    }
  } catch {
    // Proceed without req.user if token is invalid or expired
  }
  next();
}

const AdminAuditLog = require('../models/AdminAuditLog');

/*
 * PLATFORM ADMIN AUTHORIZATION
 * WHAT: Enforces platform-level administration privileges.
 * WHY: Only global platform admins can manage users, system settings, or view audit logs.
 * SECURITY: Being a Group Admin does NOT grant platform admin access.
 */
function requirePlatformAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    if (req.user) {
      // Asynchronously record unauthorized administrative access attempt
      AdminAuditLog.create({
        adminId: req.user._id,
        action: 'UNAUTHORIZED_ADMIN_ACCESS_ATTEMPT',
        targetType: 'security',
        metadata: {
          ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
          path: req.originalUrl,
          method: req.method,
          username: req.user.username,
        },
      }).catch((err) => {
        console.warn('[Audit] Failed to log unauthorized admin access:', err.message);
      });
    }
    return next(new ApiError(403, 'Platform Administrator access required'));
  }
  next();
}

const requireAdmin = requirePlatformAdmin; // Backward-compatible alias

/*
 * GROUP AUTHORIZATION HELPERS
 * WHAT: Reusable middleware generators for checking group-level permissions.
 * WHY: Consolidates authorization checks; prevents repeating lookup and permission checks across controllers.
 * SECURITY: Database-backed; checks actual memberRoles and ownership in MongoDB, ignoring client input.
 */
const Conversation = require('../models/Conversation');
const mongoose = require('mongoose');

function requireGroupMember(paramName = 'id') {
  return async (req, res, next) => {
    try {
      const convoId = req.params[paramName] || req.params.conversationId;
      if (!mongoose.isValidObjectId(convoId)) throw new ApiError(400, 'Invalid conversation id');

      const convo = await Conversation.findById(convoId);
      if (!convo || convo.deletedAt) throw new ApiError(404, 'Conversation not found');

      if (!convo.hasMember(req.user._id)) {
        throw new ApiError(403, 'You are not a member of this conversation');
      }

      req.conversation = convo;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function requireGroupAdmin(paramName = 'id') {
  return async (req, res, next) => {
    try {
      const convoId = req.params[paramName] || req.params.conversationId;
      if (!mongoose.isValidObjectId(convoId)) throw new ApiError(400, 'Invalid conversation id');

      const convo = await Conversation.findById(convoId);
      if (!convo || convo.deletedAt) throw new ApiError(404, 'Conversation not found');

      if (!convo.hasAdmin(req.user._id)) {
        throw new ApiError(403, 'Group Owner or Group Admin privileges required');
      }

      req.conversation = convo;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function requireGroupOwner(paramName = 'id') {
  return async (req, res, next) => {
    try {
      const convoId = req.params[paramName] || req.params.conversationId;
      if (!mongoose.isValidObjectId(convoId)) throw new ApiError(400, 'Invalid conversation id');

      const convo = await Conversation.findById(convoId);
      if (!convo || convo.deletedAt) throw new ApiError(404, 'Conversation not found');

      if (!convo.isOwner(req.user._id)) {
        throw new ApiError(403, 'Only the Group Owner has permission to perform this action');
      }

      req.conversation = convo;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Resolve a user from a raw token (Socket.IO handshake). Returns null when invalid. */
async function userFromToken(token) {
  try {
    if (!token) return null;
    const payload = verifyToken(token);
    return User.findById(payload.sub);
  } catch {
    return null;
  }
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireAdmin,
  requirePlatformAdmin,
  requireGroupMember,
  requireGroupAdmin,
  requireGroupOwner,
  extractToken,
  userFromToken,
};
