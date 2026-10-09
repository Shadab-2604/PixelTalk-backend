/**
 * CORS Origin Resolution Utility
 *
 * Responsibility:
 * Centralizes origin validation for both Express HTTP requests and Socket.IO handshakes.
 * Supports comma-separated origin lists in CLIENT_URL and strips trailing slashes.
 * Only EXPLICITLY listed origins are trusted in production; localhost/loopback origins
 * are additionally accepted outside production for local development.
 */

const config = require('../config');

function parseAllowedOrigins(clientUrl) {
  if (!clientUrl) return ['http://localhost:3000'];
  return clientUrl
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

const allowedOrigins = parseAllowedOrigins(config.clientUrl);

function isOriginAllowed(origin) {
  // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
  if (!origin) return true;

  const normalized = origin.replace(/\/+$/, '').toLowerCase();

  // Exact match against the explicit CLIENT_URL allowlist (single source of truth)
  if (allowedOrigins.includes('*')) return true;
  if (allowedOrigins.some((ao) => ao.toLowerCase() === normalized)) return true;

  // Local development convenience (localhost / loopback / LAN IPs) is only granted
  // outside production so credentialed cross-site requests from arbitrary local
  // origins cannot reach production data.
  if (!config.isProd) {
    if (
      normalized.startsWith('http://localhost:') ||
      normalized.startsWith('http://127.0.0.1:') ||
      normalized.startsWith('http://[::1]:') ||
      normalized.startsWith('http://192.168.')
    ) {
      return true;
    }
  }

  return false;
}

function expressCorsOrigin(origin, callback) {
  if (isOriginAllowed(origin)) {
    return callback(null, true);
  }
  return callback(null, false);
}

function socketCorsOrigin(origin, callback) {
  if (isOriginAllowed(origin)) {
    return callback(null, true);
  }
  return callback(new Error('Origin not allowed by CORS'));
}

module.exports = {
  allowedOrigins,
  isOriginAllowed,
  expressCorsOrigin,
  socketCorsOrigin,
};
