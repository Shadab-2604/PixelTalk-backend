/**
 * Input Validation & Data Sanitization Library
 *
 * Responsibility:
 * Provides defensive input parsing, boundary checks, regular expression validation,
 * and canonical normalization (e.g. lowercase emails, stripped `@` prefixes from usernames).
 *
 * CONNECTED MODULES:
 * - Controllers: All controllers in backend/src/controllers/*
 * - Sockets: backend/src/sockets/index.js (validMessageContent sanitization)
 * - Services: backend/src/services/authService.js, backend/src/services/conversationService.js
 *
 * CONCEPT: Defense-in-Depth & Normalization
 * Client-side validation exists for user experience, but server-side validation is authoritative.
 * All usernames and emails are converted to lowercase before database interaction to ensure
 * case-insensitive uniqueness and prevent account-spoofing vectors.
 */

const { ApiError } = require('./apiResponse');

const AVATAR_IDS = Array.from({ length: 10 }, (_, i) => `avatar-${String(i + 1).padStart(2, '0')}`);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

function requireString(value, field, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new ApiError(400, `${field} is required and must be between ${min} and ${max} characters`);
  }
  return value.trim();
}

function validEmail(value) {
  if (typeof value !== 'string' || !EMAIL_RE.test(value.trim()) || value.length > 254) {
    throw new ApiError(400, 'A valid email address is required');
  }
  return value.trim().toLowerCase();
}

function validUsername(value) {
  const clean = typeof value === 'string' ? value.trim().replace(/^@+/, '') : '';
  if (!USERNAME_RE.test(clean)) {
    throw new ApiError(400, 'Username must be 3–30 characters (letters, numbers, and underscores only)');
  }
  return clean.toLowerCase();
}

function validPassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new ApiError(400, 'Password must be at least 8 characters');
  }
  return value;
}

function validAvatarId(value) {
  if (!AVATAR_IDS.includes(value)) {
    throw new ApiError(400, 'A valid avatarId is required (avatar-01 … avatar-10)');
  }
  return value;
}

function validMessageContent(value) {
  const content = requireString(value, 'Message content', { min: 1, max: 2000 });
  return content;
}

function sanitizeLimit(value, fallback = 50, max = 100) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

module.exports = {
  AVATAR_IDS,
  requireString,
  validEmail,
  validUsername,
  validPassword,
  validAvatarId,
  validMessageContent,
  sanitizeLimit,
};
