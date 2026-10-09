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
 *
 * HOW IT WORKS:
 * 1. Security Setup: Helmet sets secure HTTP headers, CORS restricts access to trusted frontend URLs,
 *    and body-parser caps JSON payloads at 100KB to protect against Denial of Service (DoS) attacks.
 * 2. Database Connection: Connects to MongoDB with connection pooling (10-100 sockets) for fast queries.
 * 3. Environment Admin Seeding: Ensures the system administrator specified in `.env` exists in MongoDB.
 * 4. API & Sockets: Mounts Express routes on `/api` and boots Socket.IO on top of the HTTP server.
 * 5. Graceful Shutdown: Listens for `SIGINT` signals to safely close database connections.
 *
 * CONNECTED MODULES:
 * - backend/src/config/index.js (environment variables & credentials)
 * - backend/src/routes/index.js (all REST API endpoints)
 * - backend/src/sockets/index.js (real-time chat event handlers)
 * - backend/src/middleware/errorHandler.js (centralized error handling)
 * - backend/src/models/User.js (admin seeding & account management)
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const dns = require('dns');

try {
  // Ensure reliable DNS resolution for MongoDB Atlas SRV connection strings
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch {
  /* Ignore in case custom dns is restricted */
}

const config = require('./config');
const routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { initSockets } = require('./sockets');
const { expressCorsOrigin } = require('./utils/cors');
const { sanitizeMiddleware } = require('./middleware/sanitize');
const { csrfOriginGuard } = require('./middleware/csrf');
const { migrateLegacyUsers } = require('./utils/migrateLegacyUsers');

const app = express();

// Trust reverse proxies (Render, Cloudflare, etc.) for secure cookies & client IP rate limiting
app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  cors({
    origin: expressCorsOrigin,
    credentials: true,
  }),
);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
// Strip NoSQL operators ($… / dotted keys) from all inbound params & reject
// cross-origin state-changing requests before any route handler runs.
app.use(sanitizeMiddleware);
app.use(csrfOriginGuard);

// Root & Health check endpoints
app.get('/', (req, res) =>
  res.json({
    success: true,
    message: 'PixelTalk Backend API is online and operational',
    data: { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() },
  }),
);

app.get('/api', (req, res) =>
  res.json({
    success: true,
    message: 'PixelTalk REST API Gateway',
    data: { status: 'ok', uptime: process.uptime() },
  }),
);

app.get('/api/health', (req, res) =>
  res.json({
    success: true,
    data: { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() },
  }),
);

// Silence Chrome DevTools and browser automatic well-known probing
app.get('/.well-known/*', (req, res) => res.status(204).end());

app.use('/api', routes);
app.use(notFoundHandler);
app.use(errorHandler);

const User = require('./models/User');

async function ensureAdminUser() {
  const adminSecret = config.adminPasswordHash || config.adminPassword;
  if (!config.adminEmail || !adminSecret) return;

  const adminQuery = {
    $or: [{ email: config.adminEmail }, { username: config.adminUsername }],
  };

  let admin = await User.findOne(adminQuery).select('+passwordHash');
  if (admin) {
    let modified = false;
    if (admin.role !== 'admin') {
      admin.role = 'admin';
      modified = true;
    }
    if (admin.status !== 'active') {
      admin.status = 'active';
      modified = true;
    }
    if (admin.displayName !== (config.adminDisplayName || admin.displayName)) {
      admin.displayName = config.adminDisplayName || admin.displayName;
      modified = true;
    }
    // Only update password hash if it has changed
    if (config.adminPasswordHash && admin.passwordHash !== config.adminPasswordHash) {
      admin.passwordHash = config.adminPasswordHash;
      modified = true;
    } else if (config.adminPassword && !config.adminPasswordHash) {
      // Check if current password matches candidate plaintext
      const matches = await admin.comparePassword(config.adminPassword);
      if (!matches) {
        admin.passwordHash = config.adminPassword;
        modified = true;
      }
    }

    if (modified) {
      await admin.save();
      console.log(`[backend] Synchronized platform admin account from .env: @${admin.username}`);
    } else {
      console.log(`[backend] Platform admin account verified: @${admin.username}`);
    }
  } else {
    admin = await User.create({
      username: config.adminUsername,
      displayName: config.adminDisplayName,
      email: config.adminEmail,
      passwordHash: adminSecret,
      avatarId: 'avatar-05',
      role: 'admin',
      status: 'active',
    });
    console.log(`[backend] Seeded initial platform admin account from .env: @${admin.username}`);
  }

  // Demote any other account that may have been given role 'admin'
  const demoteResult = await User.updateMany({ _id: { $ne: admin._id }, role: 'admin' }, { role: 'user' });
  if (demoteResult.modifiedCount > 0) {
    console.log(`[backend] Demoted ${demoteResult.modifiedCount} non-env account(s) back to standard user role`);
  }
}

async function start() {
  await mongoose.connect(config.mongoUri, {
    maxPoolSize: 100,
    minPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
  });
  // Normalize any legacy database records
  await migrateLegacyUsers();

  // Ensure admin user from .env exists and has admin authority
  await ensureAdminUser();

  const server = app.listen(config.port, '0.0.0.0', () => {
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
