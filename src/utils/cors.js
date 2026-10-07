/**
 * CORS Origin Resolution Utility
 *
 * Responsibility:
 * Centralizes origin validation for both Express HTTP requests and Socket.IO handshakes.
 * Supports comma-separated origin lists in CLIENT_URL, strips trailing slashes,
 * supports Vercel preview deployments (*.vercel.app), and allows local dev fallbacks.
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

  const normalized = origin.replace(/\/+$/, '');
  if (allowedOrigins.includes(normalized) || allowedOrigins.includes('*')) {
    return true;
  }

  // Support Vercel preview deployments (*.vercel.app) if any vercel.app domain is configured
  const hasVercelInConfig = allowedOrigins.some((url) => url.includes('vercel.app'));
  if (hasVercelInConfig && (normalized.endsWith('.vercel.app') || normalized.startsWith('https://pixel-talk'))) {
    return true;
  }

  // In non-production, allow localhost and loopback origins
  if (!config.isProd && (normalized.includes('localhost') || normalized.includes('127.0.0.1'))) {
    return true;
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
