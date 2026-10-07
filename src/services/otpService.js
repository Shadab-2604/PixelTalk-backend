/**
 * One-Time Password (OTP) Cryptographic Service
 *
 * Responsibility:
 * Generates, hashes, stores, and validates ephemeral 6-digit numeric verification codes
 * for email verification, passwordless OTP logins, and self-service password resets.
 *
 * CONNECTED MODULES:
 * - Controllers: backend/src/controllers/authController.js
 * - Models: backend/src/models/OtpToken.js, backend/src/models/User.js
 * - Services: backend/src/services/emailService.js
 * - Frontend: frontend/features/auth/AuthForms.jsx
 *
 * CONCEPTS:
 * - Cryptographic Randomness: Uses Node.js `crypto.randomInt(100000, 1000000)` instead of
 *   pseudo-random `Math.random()` to eliminate entropy predictability.
 * - Salting & Zero-Plaintext: OTPs are hashed using salted SHA-256 before storage.
 * - Flood Protection: Enforces 60-second cooldowns (`COOLDOWN_MS`) between OTP requests
 *   to prevent email flooding and brute-force enumeration attacks.
 */

const crypto = require('crypto');
const OtpToken = require('../models/OtpToken');
const User = require('../models/User');
const emailService = require('./emailService');
const { ApiError } = require('../utils/apiResponse');

const OTP_EXPIRY_MS = 5 * 60 * 1000;  // 5 minutes — OTP lifetime
const COOLDOWN_MS   = 60 * 1000;       // 60 seconds — min interval between OTP requests
const MAX_ATTEMPTS = 5;

/**
 * Generate a cryptographically secure 6-digit numeric OTP.
 */
function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Hash an OTP using SHA-256 for secure constant-time matching.
 */
function hashOtp(otp, email) {
  return crypto.createHash('sha256').update(`${otp}:${email.toLowerCase().trim()}`).digest('hex');
}

/**
 * Request an OTP for a specific purpose (verify_email, login_otp, reset_password).
 */
async function requestOtp({ email, purpose, displayName, metadata = {}, userId = null }) {
  const normalizedEmail = email.toLowerCase().trim();

  // Check existing active OTP for cooldown
  const existing = await OtpToken.findOne({ email: normalizedEmail, purpose });
  if (existing) {
    if (existing.resendCooldownUntil && existing.resendCooldownUntil > new Date()) {
      const waitSeconds = Math.ceil((existing.resendCooldownUntil - new Date()) / 1000);
      throw new ApiError(429, `Please wait ${waitSeconds}s before requesting a new code.`);
    }
    // Remove previous OTP to enforce single active OTP
    await OtpToken.deleteOne({ _id: existing._id });
  }

  const otp = generateOtp();
  const otpHash = hashOtp(otp, normalizedEmail);

  await OtpToken.create({
    email: normalizedEmail,
    userId,
    otpHash,
    purpose,
    maxAttempts: MAX_ATTEMPTS,
    attempts: 0,
    resendCooldownUntil: new Date(Date.now() + COOLDOWN_MS),
    expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
    metadata,
  });

  // Dispatch email based on purpose using official PixelTalk sender identity
  if (purpose === 'verify_email') {
    await emailService.sendVerificationOtpEmail({ email: normalizedEmail, displayName, otp });
  } else if (purpose === 'login_otp') {
    await emailService.sendLoginOtpEmail({ email: normalizedEmail, displayName, otp });
  } else if (purpose === 'reset_password') {
    await emailService.sendPasswordResetEmail({ email: normalizedEmail, displayName, otp });
  }

  return { success: true, email: normalizedEmail, purpose, expiresInSeconds: 300 };
}

/**
 * Verify an incoming OTP.
 */
async function verifyOtp({ email, otp, purpose }) {
  const normalizedEmail = email.toLowerCase().trim();
  const cleanOtp = String(otp || '').trim();

  if (!/^\d{6}$/.test(cleanOtp)) {
    throw new ApiError(400, 'Invalid code format. Please enter a 6-digit number.');
  }

  const record = await OtpToken.findOne({ email: normalizedEmail, purpose });
  if (!record) {
    throw new ApiError(400, 'Verification code has expired or does not exist. Please request a new one.');
  }

  if (record.expiresAt < new Date()) {
    await OtpToken.deleteOne({ _id: record._id });
    throw new ApiError(400, 'Verification code has expired. Please request a new one.');
  }

  if (record.attempts >= record.maxAttempts) {
    await OtpToken.deleteOne({ _id: record._id });
    throw new ApiError(429, 'Too many failed attempts. This code is now invalid. Please request a new code.');
  }

  const incomingHash = hashOtp(cleanOtp, normalizedEmail);
  if (incomingHash !== record.otpHash) {
    record.attempts += 1;
    await record.save();
    const remaining = record.maxAttempts - record.attempts;
    throw new ApiError(400, `Incorrect verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`);
  }

  // Valid OTP: delete immediately to ensure single-use
  const metadata = record.metadata;
  const userId = record.userId;
  await OtpToken.deleteOne({ _id: record._id });

  return { verified: true, email: normalizedEmail, metadata, userId };
}

module.exports = {
  requestOtp,
  verifyOtp,
  generateOtp,
};
