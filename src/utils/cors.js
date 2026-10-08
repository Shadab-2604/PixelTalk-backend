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

  const normalized = origin.replace(/\/+$/, '').toLowerCase();
  if (allowedOrigins.some((ao) => ao.toLowerCase() === normalized) || allowedOrigins.includes('*')) {
    return true;
  }

  // Support all Vercel deployments (*.vercel.app) and PixelTalk domains
  if (normalized.endsWith('.vercel.app') || normalized.includes('pixel-talk') || normalized.includes('pixeltalk')) {
    return true;
  }

  // Support Render hosting domains (*.onrender.com)
  if (normalized.endsWith('.onrender.com')) {
    return true;
  }

  // Allow localhost and local IP origins for testing
  if (normalized.includes('localhost') || normalized.includes('127.0.0.1') || normalized.startsWith('http://192.168.')) {
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
