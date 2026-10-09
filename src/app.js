/**
 * Express Application Configuration (app.js)
 *
 * Responsibility:
 * Configures Express middleware, security headers, CORS origin resolution,
 * request parsing, route mounts, and global error handling.
 *
 * Decoupled from HTTP server listener to support both persistent servers (server.js)
 * and serverless function deployments (api/index.js on Vercel).
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { expressCorsOrigin } = require('./utils/cors');
const { sanitizeMiddleware } = require('./middleware/sanitize');

const app = express();

// Trust reverse proxies (Vercel, Render, Railway, Cloudflare) for secure cookies & IPs
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
app.use(sanitizeMiddleware);

app.get('/api/health', (req, res) =>
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() } }),
);
app.use('/api', routes);
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
