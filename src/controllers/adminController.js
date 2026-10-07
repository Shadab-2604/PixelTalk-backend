/**
 * Admin Controller
 *
 * Responsibility:
 * Exposes administrative endpoints for system overview analytics, user moderation
 * (suspension, banning, role escalation), group lounge moderation, message redaction,
 * and immutable audit log inspection.
 *
 * CONNECTED MODULES:
 * - Routes: backend/src/routes/index.js (/api/admin/*)
 * - Middleware: backend/src/middleware/auth.js (requireAdmin guard)
 * - Services: backend/src/services/adminService.js
 * - Frontend: frontend/app/admin/*, frontend/services/adminService.js
 *
 * CONCEPT: Role-Based Administration
 * All endpoints routed through this controller require verified administrator privileges.
 * Moderation actions record a corresponding entry in `AdminAuditLog` to ensure accountability.
 */

const { ok } = require('../utils/apiResponse');
const adminService = require('../services/adminService');

async function stats(req, res, next) {
  try {
    ok(res, { stats: await adminService.stats() });
  } catch (err) {
    next(err);
  }
}

async function listUsers(req, res, next) {
  try {
    const result = await adminService.listUsers(req.query);
    res.json({ success: true, data: { ...result, users: result.users.map((u) => u.toJSON()) } });
  } catch (err) {
    next(err);
  }
}

async function getUser(req, res, next) {
  try {
    const user = await adminService.getUser(req.params.id);
    ok(res, { user: user.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function patchUserStatus(req, res, next) {
  try {
    const user = await adminService.setUserStatus(req.user, req.params.id, req.body.status);
    ok(res, { user: user.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function patchUserRole(req, res, next) {
  try {
    const user = await adminService.setUserRole(req.user, req.params.id, req.body.role);
    ok(res, { user: user.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function listGroups(req, res, next) {
  try {
    const result = await adminService.listGroups(req.query);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function getGroup(req, res, next) {
  try {
    const group = await adminService.getGroup(req.params.id);
    ok(res, { group });
  } catch (err) {
    next(err);
  }
}

async function deleteGroup(req, res, next) {
  try {
    const restore = req.query.restore === 'true' || (req.body && req.body.restore === true);
    const group = await adminService.deleteGroup(req.user, req.params.id, restore);
    ok(res, { group });
  } catch (err) {
    next(err);
  }
}

async function listMessages(req, res, next) {
  try {
    const result = await adminService.listMessages(req.query);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function deleteMessage(req, res, next) {
  try {
    const msg = await adminService.deleteMessage(req.user, req.params.id, req.body && req.body.reason);
    ok(res, { message: msg });
  } catch (err) {
    next(err);
  }
}

async function deleteUser(req, res, next) {
  try {
    const result = await adminService.deleteUser(req.user, req.params.id);
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function listAuditLogs(req, res, next) {
  try {
    const result = await adminService.listAuditLogs(req.query);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  stats,
  listUsers,
  getUser,
  patchUserStatus,
  patchUserRole,
  deleteUser,
  listGroups,
  getGroup,
  deleteGroup,
  listMessages,
  deleteMessage,
  listAuditLogs,
};
