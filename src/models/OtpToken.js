/*
 * ============================================================
 * PIXELTALK — DATABASE MODEL: OTP TOKEN (OtpToken.js)
 * ============================================================
 *
 * WHAT DATA IS STORED?
 * Stores short-lived One-Time Password (OTP) verification tokens:
 * - Target player email address (`email`).
 * - Hashed 6-digit OTP code (`otpHash`).
 * - Purpose (`'verify_email'` | `'login_otp'` | `'reset_password'`).
 * - Attempt counter (`attempts`, `maxAttempts = 5`).
 * - Cooldown timestamp (`resendCooldownUntil = 60s`) & expiration timestamp (`expiresAt = 5 mins`).
 *
 * WHY IS IT STORED?
 * To securely authenticate user registration, email verification, and self-service password reset
 * without storing unhashed codes in MongoDB.
 *
 * AUTOMATIC EXPIRATION (TTL INDEX):
 * Uses MongoDB's background Time-To-Live index: `{ expiresAt: 1 }, { expireAfterSeconds: 0 }`.
 * When a token reaches its 5-minute `expiresAt` deadline, MongoDB automatically purges it.
 *
 * SECURITY:
 * - 6-digit OTP codes are hashed with SHA-256 before saving (`otpHash`). Plaintext codes are NEVER stored.
 * - Brute-force protection: After 5 invalid code attempts (`attempts >= maxAttempts`), the token is locked.
 * - Rate limiting: Enforces a 60-second cooldown between resend requests to prevent spam.
 * ============================================================
 */

const mongoose = require('mongoose');

const otpTokenSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    otpHash: { type: String, required: true },
    purpose: {
      type: String,
      required: true,
      enum: ['verify_email', 'login_otp', 'reset_password'],
      index: true,
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    resendCooldownUntil: { type: Date, default: () => new Date(Date.now() + 60 * 1000) },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 5 * 60 * 1000), // 5 minutes TTL
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// TTL index to automatically clean up expired OTP records
otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpTokenSchema.index({ email: 1, purpose: 1 });

module.exports = mongoose.model('OtpToken', otpTokenSchema);
