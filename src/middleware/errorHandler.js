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

function errorHandler(err, req, res, next) {
  let status = err.statusCode || 500;
  let message = err.message || 'Internal server error';

  // Handle Mongoose Validation Error
  if (err.name === 'ValidationError') {
    status = 400;
    const errors = Object.values(err.errors || {}).map((e) => e.message);
    message = errors.length > 0 ? errors.join(', ') : 'Validation error';
  } else if (err.name === 'CastError') {
    status = 400;
    message = `Invalid ${err.path || 'ID'} format`;
  } else if (err.code === 11000) {
    status = 409;
    const field = Object.keys(err.keyPattern || {})[0] || 'field';
    message = `A record with this ${field} already exists`;
  } else if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    status = 401;
    message = 'Authentication session has expired or is invalid';
  } else if (!err.isOperational && status === 500) {
    message = 'Internal server error';
  }

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
