/**
 * Authentication Controller
 *
 * Responsibility:
 * Handles incoming authentication and OTP requests, sanitizes user inputs,
 * coordinates with `authService` for business operations, manages HTTP-only session cookies,
 * and formats standardized responses.
 *
 * CONNECTED MODULES:
 * - Routes: backend/src/routes/index.js (/api/auth/*)
 * - Services: backend/src/services/authService.js, backend/src/services/userService.js
 * - Utils: backend/src/utils/validation.js, backend/src/utils/apiResponse.js
 * - Frontend: frontend/services/authService.js, frontend/features/auth/AuthForm.jsx
 *
 * CONCEPT: Controller-as-Coordinator
 * This controller contains zero direct database queries. It validates input parameters,
 * delegates state mutations to the service layer, and writes session cookies.
 */

const { ok } = require('../utils/apiResponse');
const authService = require('../services/authService');
const userService = require('../services/userService');
const { validEmail, validPassword, validUsername, validAvatarId, requireString } = require('../utils/validation');
const config = require('../config');

function setAuthCookie(res, token) {
  res.cookie(config.cookieName, token, authService.authCookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    sameSite: config.isProd ? 'none' : 'lax',
    secure: config.isProd,
    path: '/',
  });
}

async function register(req, res, next) {
  try {
    const username = validUsername(req.body.username);
    const displayName = requireString(req.body.displayName, 'Display name', { min: 1, max: 32 });
    const email = validEmail(req.body.email);
    const password = validPassword(req.body.password);
    const avatarId = validAvatarId(req.body.avatarId);

    const { user, token } = await authService.register({ username, displayName, email, password, avatarId });
    setAuthCookie(res, token);
    ok(res, { user: userService.publicUser(user, user._id), token }, 201);
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const identifier = requireString(req.body.identifier || req.body.email || req.body.username, 'Email or username', { min: 3, max: 254 });
    const password = validPassword(req.body.password);
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const { user, token } = await authService.login({ identifier, password, ip });
    setAuthCookie(res, token);
    ok(res, { user: userService.publicUser(user, user._id), token });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    clearAuthCookie(res);
    ok(res, { message: 'Logged out' });
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    ok(res, { user: userService.publicUser(req.user, req.user._id) });
  } catch (err) {
    next(err);
  }
}

async function changePassword(req, res, next) {
  try {
    const currentPassword = validPassword(req.body.currentPassword);
    const newPassword = validPassword(req.body.newPassword);
    await authService.changePassword(req.user, { currentPassword, newPassword });
    ok(res, { message: 'Password updated' });
  } catch (err) {
    next(err);
  }
}

// ---------------- OTP Handlers ----------------

async function sendVerificationOtp(req, res, next) {
  try {
    const email = validEmail(req.body.email);
    const displayName = req.body.displayName ? String(req.body.displayName).slice(0, 32) : 'Player';
    const result = await authService.sendVerificationOtp({ email, displayName });
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function verifyEmailOtp(req, res, next) {
  try {
    const email = validEmail(req.body.email);
    const otp = requireString(req.body.otp, 'OTP code', { min: 6, max: 6 });
    const result = await authService.verifyEmailOtp({ email, otp });
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function sendLoginOtp(req, res, next) {
  try {
    const identifier = requireString(req.body.identifier || req.body.email || req.body.username, 'Identifier', { min: 3, max: 254 });
    const result = await authService.sendLoginOtp({ identifier });
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function verifyLoginOtp(req, res, next) {
  try {
    const identifier = req.body.identifier ? String(req.body.identifier).trim() : null;
    const email = req.body.email ? validEmail(req.body.email) : null;
    const otp = requireString(req.body.otp, 'OTP code', { min: 6, max: 6 });
    const { user, token } = await authService.verifyLoginOtp({ email, identifier, otp });
    setAuthCookie(res, token);
    ok(res, { user: userService.publicUser(user), token });
  } catch (err) {
    next(err);
  }
}

async function sendPasswordResetOtp(req, res, next) {
  try {
    const email = validEmail(req.body.email);
    const result = await authService.sendPasswordResetOtp({ email });
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function resetPasswordWithOtp(req, res, next) {
  try {
    const email = validEmail(req.body.email);
    const otp = requireString(req.body.otp, 'OTP code', { min: 6, max: 6 });
    const newPassword = validPassword(req.body.newPassword);
    const result = await authService.resetPasswordWithOtp({ email, otp, newPassword });
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  register,
  login,
  logout,
  me,
  changePassword,
  setAuthCookie,
  clearAuthCookie,
  sendVerificationOtp,
  verifyEmailOtp,
  sendLoginOtp,
  verifyLoginOtp,
  sendPasswordResetOtp,
  resetPasswordWithOtp,
};
