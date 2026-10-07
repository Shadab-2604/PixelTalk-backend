/**
 * Database Connection Manager
 *
 * Responsibility:
 * Connects to MongoDB with connection reuse / caching to support both persistent
 * Node.js server environments and stateless/serverless function runtimes (Vercel).
 */

const mongoose = require('mongoose');
const dns = require('dns');

try {
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch {
  /* Ignore if restricted */
}

const config = require('../config');

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectDb() {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(config.mongoUri, {
        maxPoolSize: 100,
        minPoolSize: 5,
        serverSelectionTimeoutMS: 5000,
      })
      .then((mongooseInstance) => {
        console.log('[backend] MongoDB connected successfully');
        return mongooseInstance;
      });
  }

  try {
    cached.conn = await cached.promise;
  } catch (e) {
    cached.promise = null;
    throw e;
  }

  return cached.conn;
}

module.exports = { connectDb };
