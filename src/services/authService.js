/**
 * Authentication Service
 *
 * Responsibility:
 * Encapsulates core identity and session security logic:
 * - JWT issuance and cryptographic verification
 * - User registration and duplicate uniqueness checking
 * - Credential comparison and account status verification
 * - Session cookie configuration options
 *
 * CONNECTED MODULES:
 * - Controllers: backend/src/controllers/authController.js
 * - Middleware: backend/src/middleware/auth.js (uses verifyToken)
 * - Models: backend/src/models/User.js
 * - Services: backend/src/services/otpService.js, backend/src/services/emailService.js
 *
 * CONCEPT: Stateless Claims with Revocable Session State
 * Tokens encode the user's ID (`sub`) and `role` to permit stateless verification,
 * while controllers cross-reference with the database to ensure deleted or suspended
 * users cannot access protected APIs with unexpired tokens.
 */

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { ApiError } = require('../utils/apiResponse');
const config = require('../config');
const otpService = require('./otpService');
const emailService = require('./emailService');

/**
 * Signs a JWT containing user subject and role claims.
 *
 * @param {import('../models/User')} user
 * @returns {string} Signed JWT
 */
function issueToken(user) {
  return jwt.sign({ sub: user._id.toString(), role: user.role }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.jwtExpiresIn,
  });
}

/**
 * Verifies a JWT's cryptographic signature against the backend secret.
 *
 * @param {string} token
 * @returns {object} Decoded JWT payload
 */
function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret, {
    algorithms: ['HS256'],
  });
}

function authCookieOptions() {
  return {
    httpOnly: true,
    sameSite: config.isProd ? 'none' : 'lax',
    secure: config.isProd,
    maxAge: config.cookieMaxAgeMs,
    path: '/',
  };
}

async function register({ username, displayName, email, password, avatarId }) {
  const existing = await User.findOne({ $or: [{ email }, { username }] });
  if (existing) {
    throw new ApiError(409, existing.email === email ? 'Email is already registered' : 'Username is already taken');
  }
  // All public registrations are assigned standard 'user' role. Only .env credentials are admin.
  const user = await User.create({ username, displayName, email, passwordHash: password, avatarId, role: 'user' });

  // Send welcome email upon registration
  try {
    await emailService.sendWelcomeEmail({
      email: user.email,
      displayName: user.displayName,
      username: user.username,
    });
  } catch (err) {
    console.warn('[AuthService] Welcome email send error:', err.message);
  }

  return { user, token: issueToken(user) };
}

const AdminAuditLog = require('../models/AdminAuditLog');

async function login({ identifier, password, ip = 'unknown' }) {
  const cleanId = String(identifier || '').toLowerCase().trim();
  const user = await User.findOne({ $or: [{ email: cleanId }, { username: cleanId }] }).select('+passwordHash');
  
  if (!user) {
    // If an attempted login targeted the configured admin identifier, log the failure
    if (cleanId === config.adminUsername || cleanId === config.adminEmail) {
      AdminAuditLog.create({
        adminId: null,
        action: 'ADMIN_LOGIN_FAILED',
        targetType: 'security',
        metadata: { identifier: cleanId, reason: 'Account not found', ip },
      }).catch(() => {});
    }
    throw new ApiError(401, 'Invalid credentials');
  }

  const matches = await user.comparePassword(password);
  if (!matches) {
    if (user.role === 'admin') {
      AdminAuditLog.create({
        adminId: user._id,
        action: 'ADMIN_LOGIN_FAILED',
        targetType: 'security',
        metadata: { username: user.username, reason: 'Invalid password', ip },
      }).catch(() => {});
    }
    throw new ApiError(401, 'Invalid credentials');
  }

  if (user.status === 'banned') throw new ApiError(403, 'This account has been banned');
  if (user.status === 'suspended') throw new ApiError(403, 'This account is suspended');

  if (user.role === 'admin') {
    AdminAuditLog.create({
      adminId: user._id,
      action: 'ADMIN_LOGIN_SUCCESS',
      targetType: 'security',
      metadata: { username: user.username, ip },
    }).catch(() => {});
  }

  return { user, token: issueToken(user) };
}

async function changePassword(user, { currentPassword, newPassword }) {
  const fresh = await User.findById(user._id).select('+passwordHash');
  const matches = await fresh.comparePassword(currentPassword);
  if (!matches) throw new ApiError(400, 'Current password is incorrect');
  fresh.passwordHash = newPassword;
  await fresh.save(); // triggers bcrypt pre-save hook
  return fresh;
}

// ---------------- OTP Authentication Flow Methods ----------------

/**
 * 1. Send Email Verification OTP
 */
async function sendVerificationOtp({ email, displayName }) {
  return otpService.requestOtp({
    email,
    displayName: displayName || 'Player',
    purpose: 'verify_email',
  });
}

/**
 * 2. Verify Email OTP & Send Welcome Email
 */
async function verifyEmailOtp({ email, otp }) {
  const result = await otpService.verifyOtp({ email, otp, purpose: 'verify_email' });

  // If user already exists in DB, trigger welcome email and mark verified
  const user = await User.findOne({ email: result.email });
  if (user) {
    try {
      await emailService.sendWelcomeEmail({
        email: user.email,
        displayName: user.displayName,
        username: user.username,
      });
    } catch (err) {
      console.warn('[AuthService] Welcome email send error:', err.message);
    }
  }

  return { verified: true, email: result.email };
}

/**
 * 3. Send Login OTP
 */
async function sendLoginOtp({ identifier }) {
  const user = await User.findOne({
    $or: [{ email: identifier.toLowerCase().trim() }, { username: identifier.toLowerCase().trim() }],
  });
  if (!user) throw new ApiError(404, 'No account found with that email or username');

  if (user.status === 'banned') throw new ApiError(403, 'This account has been banned');
  if (user.status === 'suspended') throw new ApiError(403, 'This account is suspended');

  return otpService.requestOtp({
    email: user.email,
    displayName: user.displayName,
    purpose: 'login_otp',
    userId: user._id,
  });
}

/**
 * 4. Verify Login OTP & Issue Session Token
 */
async function verifyLoginOtp({ email, identifier, otp }) {
  const targetEmail = email
    ? email.toLowerCase().trim()
    : (await User.findOne({
        $or: [{ email: identifier.toLowerCase().trim() }, { username: identifier.toLowerCase().trim() }],
      }))?.email;

  if (!targetEmail) throw new ApiError(404, 'User not found');

  const result = await otpService.verifyOtp({ email: targetEmail, otp, purpose: 'login_otp' });
  const user = await User.findOne({ email: result.email });
  if (!user) throw new ApiError(404, 'Account not found');

  if (user.status === 'banned') throw new ApiError(403, 'This account has been banned');
  if (user.status === 'suspended') throw new ApiError(403, 'This account is suspended');

  return { user, token: issueToken(user) };
}

/**
 * 5. Send Password Reset OTP
 */
async function sendPasswordResetOtp({ email }) {
  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user) {
    // For security, do not reveal if email exists, but return success structure
    return { success: true, email: email.toLowerCase().trim(), expiresInSeconds: 300 };
  }

  return otpService.requestOtp({
    email: user.email,
    displayName: user.displayName,
    purpose: 'reset_password',
    userId: user._id,
  });
}

/**
 * 6. Reset Password with OTP
 */
async function resetPasswordWithOtp({ email, otp, newPassword }) {
  const result = await otpService.verifyOtp({ email, otp, purpose: 'reset_password' });
  const user = await User.findOne({ email: result.email }).select('+passwordHash');
  if (!user) throw new ApiError(404, 'Account not found');

  user.passwordHash = newPassword;
  await user.save();

  return { success: true, message: 'Password reset successfully' };
}

module.exports = {
  issueToken,
  verifyToken,
  authCookieOptions,
  register,
  login,
  changePassword,
  sendVerificationOtp,
  verifyEmailOtp,
  sendLoginOtp,
  verifyLoginOtp,
  sendPasswordResetOtp,
  resetPasswordWithOtp,
};
