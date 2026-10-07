/*
 * ============================================================
 * PIXELTALK — BACKEND EXPRESS SERVER & SOCKET BOOTSTRAP (server.js)
 * ============================================================
 *
 * WHAT:
 * This file is the main entry point and engine room of the PixelTalk backend.
 * It boots up the Express web application, connects to MongoDB, mounts all API routes,
 * initializes the Socket.IO real-time engine, and enforces system security policies.
 *
 * WHY:
 * PixelTalk requires a central server to process HTTP requests (authentication, user profile,
 * image uploads, admin commands) and handle real-time WebSocket communication (0ms chat delivery,
 * typing indicators, online presence status).
 * ============================================================
 */

const mongoose = require('mongoose');
const config = require('./config');
const app = require('./app');
const { connectDb } = require('./utils/db');
const { initSockets } = require('./sockets');
const User = require('./models/User');

async function ensureAdminUser() {
  if (!config.adminEmail || !config.adminPassword) return;

  const adminQuery = {
    $or: [{ email: config.adminEmail }, { username: config.adminUsername }],
  };

  let admin = await User.findOne(adminQuery).select('+passwordHash');
  if (admin) {
    admin.role = 'admin';
    admin.status = 'active';
    admin.passwordHash = config.adminPassword;
    admin.displayName = config.adminDisplayName || admin.displayName;
    await admin.save();
    console.log(`[backend] Verified admin credentials from .env for: ${admin.email} (@${admin.username})`);
  } else {
    admin = await User.create({
      username: config.adminUsername,
      displayName: config.adminDisplayName,
      email: config.adminEmail,
      passwordHash: config.adminPassword,
      avatarId: 'avatar-05',
      role: 'admin',
      status: 'active',
    });
    console.log(`[backend] Seeded initial admin account from .env: ${admin.email} (@${admin.username})`);
  }

  // Demote any other account that may have been given role 'admin'
  const demoteResult = await User.updateMany({ _id: { $ne: admin._id }, role: 'admin' }, { role: 'user' });
  if (demoteResult.modifiedCount > 0) {
    console.log(`[backend] Demoted ${demoteResult.modifiedCount} non-env account(s) back to standard user role`);
  }
}

async function start() {
  await connectDb();

  // Ensure admin user from .env exists and has admin authority
  await ensureAdminUser();

  const server = app.listen(config.port, () => {
    console.log(`[backend] HTTP API ready on port ${config.port} (/api)`);
  });

  const io = initSockets(server);
  app.set('io', io);
  console.log('[backend] Socket.IO ready');
}

start().catch((err) => {
  console.error('[backend] Failed to start:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await mongoose.disconnect();
  process.exit(0);
});

module.exports = { app, start };
