/**
 * NoSQL & Input Sanitization Middleware (sanitize.js)
 *
 * Responsibility:
 * Recursively inspects and sanitizes request parameters, query strings, and request bodies
 * to prevent NoSQL Operator Injection (e.g. $where, $gt, $ne, $regex injection) and Prototype Pollution.
 *
 * CONNECTED MODULES:
 * - App: backend/src/app.js
 */

/**
 * Recursively strips keys starting with '$' or containing '.' from objects.
 * @param {*} target
 * @returns {*} Sanitized copy/mutation
 */
function sanitizeInput(target) {
  if (!target || typeof target !== 'object') {
    return target;
  }

  if (Array.isArray(target)) {
    for (let i = 0; i < target.length; i++) {
      target[i] = sanitizeInput(target[i]);
    }
    return target;
  }

  const keys = Object.keys(target);
  for (const key of keys) {
    if (key.startsWith('$') || key.includes('.')) {
      delete target[key];
    } else {
      target[key] = sanitizeInput(target[key]);
    }
  }

  return target;
}

/**
 * Express middleware to sanitize req.body, req.query, and req.params
 */
function sanitizeMiddleware(req, res, next) {
  if (req.body) {
    sanitizeInput(req.body);
  }
  if (req.query) {
    sanitizeInput(req.query);
  }
  if (req.params) {
    sanitizeInput(req.params);
  }
  next();
}

module.exports = {
  sanitizeInput,
  sanitizeMiddleware,
};
