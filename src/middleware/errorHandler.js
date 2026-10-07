/**
 * Centralized Error & 404 Middleware
 *
 * Responsibility:
 * Catches all operational and unexpected application exceptions across the Express pipeline.
 * Formats errors into a predictable JSON envelope while strictly safeguarding against
 * sensitive stack trace or database credential exposure in production environments.
 *
 * CONNECTED MODULES:
 * - Server: backend/src/server.js (mounted at the end of the middleware chain)
 * - Utilities: backend/src/utils/apiResponse.js (ApiError class)
 *
 * CONCEPT: Operational vs Programmer Errors
 * Operational errors (ApiError with isOperational: true) return user-facing error messages.
 * Uncaught programmer/infrastructure exceptions fall back to a generic 500 message to protect internal details.
 */

const config = require('../config');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.statusCode || 500;
  const message = err.isOperational || status !== 500 ? err.message : 'Internal server error';

  if (status >= 500) {
    // Log details server-side only; never leak stack traces to clients.
    console.error('[error]', err.message, config.isProd ? '' : '\n' + err.stack);
  }

  res.status(status).json({ success: false, message });
}

// Simple 404 for unknown API routes
function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: 'API route not found' });
}

module.exports = { errorHandler, notFoundHandler };
