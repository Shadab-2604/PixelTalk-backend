/**
 * CSRF / Cross-Origin Request Protection (csrf.js)
 *
 * Responsibility:
 * Rejects state-changing (POST/PATCH/PUT/DELETE) HTTP requests whose browser-supplied
 * `Origin` header is not an explicitly trusted origin (or the backend's own origin).
 *
 * WHY:
 * The session JWT is delivered in an HttpOnly cookie. In production that cookie is issued
 * with `SameSite=None; Secure` so the separately-hosted frontend can use it, which means a
 * malicious website could otherwise trigger credentialed requests to this API. Browsers
 * always attach an `Origin` header to non-GET/HEAD/OPTIONS cross-site requests, so verifying
 * it closes classic CSRF without changing the existing cookie/token architecture.
 *
 * Requests without an `Origin` header (curl, mobile clients, server-to-server, Bearer-token
 * tooling) cannot be forged by a browser and are allowed through.
 *
 * CONNECTED MODULES:
 * - server.js / app.js (mounted globally before routes)
 * - backend/src/utils/cors.js (single source of truth for trusted origins)
 */

const { isOriginAllowed } = require('../utils/cors');
const { ApiError } = require('../utils/apiResponse');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originMatchesRequestHost(origin, req) {
  try {
    const host = req.headers.host;
    if (!host) return false;
    return new URL(origin).host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;
  }
}

function csrfOriginGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  // Non-browser clients (no Origin header) cannot be driven by a third-party page.
  if (!origin) return next();

  if (originMatchesRequestHost(origin, req) || isOriginAllowed(origin)) return next();

  return next(new ApiError(403, 'Cross-origin request blocked'));
}

module.exports = { csrfOriginGuard };
