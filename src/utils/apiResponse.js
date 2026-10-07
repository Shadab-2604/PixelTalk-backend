/**
 * API Response Envelope & Exception Utilities
 *
 * Responsibility:
 * Enforces a strict, predictable JSON envelope across all PixelTalk endpoints:
 * - Success: { success: true, data: ... }
 * - Failure: { success: false, message: ... }
 *
 * CONNECTED MODULES:
 * - Controllers: All controllers in backend/src/controllers/*
 * - Middleware: backend/src/middleware/errorHandler.js
 * - Routes: backend/src/routes/index.js (asyncHandler wrapping)
 *
 * CONCEPT: Express Async Exception Forwarding (asyncHandler)
 * Prior to Express 5, async route handlers that throw unhandled Promise rejections
 * would hang the request or crash the process. `asyncHandler` wraps the async function
 * and transparently forwards any rejection to `catch(next)`.
 */

class ApiError extends Error {
  /**
   * Constructs an operational error that can safely display its message to the client.
   *
   * @param {number} statusCode - HTTP status code (e.g. 400, 401, 403, 404).
   * @param {string} message - Human-readable error description.
   */
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
  }
}

const ok = (res, data = {}, status = 200) => res.status(status).json({ success: true, data });

const fail = (res, message, status = 400) => res.status(status).json({ success: false, message });

const notFound = (res, message = 'Not found') => fail(res, message, 404);

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { ApiError, ok, fail, notFound, asyncHandler };
