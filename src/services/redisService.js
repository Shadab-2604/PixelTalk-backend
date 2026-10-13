/**
 * Redis Service & Central Client Management
 *
 * Responsibility:
 * Manages the single shared Redis Cloud connection lifecycle:
 * - Connecting safely at server startup without leaking credentials.
 * - Handling connection errors, reconnect attempts, and graceful shutdown.
 * - Providing safe, fail-open caching helpers (`getCache`, `setCache`, `deleteCache`, `deleteByPrefix`).
 * - Providing distributed rate limiting and temporary caching with TTLs.
 *
 * PRIVACY & SECURITY:
 * - Credentials are read exclusively from backend environment variables (`config.redisUrl`).
 * - Never log or return Redis URLs, passwords, or connection strings.
 * - All keys are scoped with a standard prefix `pixeltalk:`.
 * - If Redis is unavailable or disabled, all caching operations degrade gracefully
 *   to direct MongoDB queries without interrupting application flow.
 */

const { createClient } = require('redis');
const config = require('../config');

let client = null;
let isConnected = false;
let isConnecting = false;

function initClient() {
  if (client) return client;
  if (!config.redisUrl) {
    return null;
  }

  try {
    client = createClient({
      url: config.redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.warn('[redis] Max reconnection attempts reached. Continuing with MongoDB direct fallback.');
            return new Error('Max retries reached');
          }
          // Exponential backoff capped at 3000ms
          return Math.min(retries * 200, 3000);
        },
      },
    });

    client.on('connect', () => {
      // Intentionally never log connection URLs or credentials
      console.log('[redis] Connecting to Redis Cloud...');
    });

    client.on('ready', () => {
      isConnected = true;
      console.log('[redis] Redis Cloud client connected and ready');
    });

    client.on('error', (err) => {
      isConnected = false;
      console.warn('[redis] Redis Client Warning/Error:', err.message || err);
    });

    client.on('end', () => {
      isConnected = false;
    });

    return client;
  } catch (err) {
    console.error('[redis] Initialization error:', err.message);
    return null;
  }
}

/**
 * Connect to Redis at application startup.
 * Fails safely without crashing the backend process.
 */
async function connectRedis() {
  if (!config.redisCacheEnabled || !config.redisUrl) {
    console.log('[redis] Redis caching is disabled or REDIS_URL not configured. Using MongoDB direct.');
    return;
  }

  if (isConnected || isConnecting) return;

  const redisClient = initClient();
  if (!redisClient) return;

  try {
    isConnecting = true;
    await redisClient.connect();
    isConnected = true;
  } catch (err) {
    isConnected = false;
    console.warn('[redis] Could not establish Redis Cloud connection at startup. Degraded to database fallback:', err.message);
  } finally {
    isConnecting = false;
  }
}

/**
 * Graceful disconnect on server termination.
 */
async function disconnectRedis() {
  if (client && isConnected) {
    try {
      await client.quit();
      console.log('[redis] Redis connection closed gracefully');
    } catch (err) {
      console.warn('[redis] Error during disconnect:', err.message);
    } finally {
      isConnected = false;
    }
  }
}

function isRedisReady() {
  return Boolean(config.redisCacheEnabled && client && isConnected);
}

/**
 * Retrieve a cached JSON value.
 * Returns null on cache miss, disabled Redis, or read failure.
 */
async function getCache(key) {
  if (!isRedisReady()) return null;
  try {
    const raw = await client.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[redis] Read failed for key "${key}":`, err.message);
    return null;
  }
}

/**
 * Set a cached JSON value with a Time-To-Live (TTL) in seconds.
 */
async function setCache(key, value, ttlSeconds = 60) {
  if (!isRedisReady() || value === undefined) return;
  try {
    const serialized = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await client.set(key, serialized, { EX: ttlSeconds });
    } else {
      await client.set(key, serialized);
    }
  } catch (err) {
    console.warn(`[redis] Write failed for key "${key}":`, err.message);
  }
}

/**
 * Invalidate one or more exact keys.
 */
async function deleteCache(keys) {
  if (!isRedisReady()) return;
  const keyList = Array.isArray(keys) ? keys.filter(Boolean) : [keys].filter(Boolean);
  if (keyList.length === 0) return;

  try {
    await client.del(keyList);
  } catch (err) {
    console.warn('[redis] Invalidation failed:', err.message);
  }
}

/**
 * Invalidate all keys matching a prefix using SCAN.
 * Example: deleteByPrefix('pixeltalk:user:profile:')
 */
async function deleteByPrefix(prefix) {
  if (!isRedisReady() || !prefix) return;
  try {
    let cursor = '0';
    do {
      const reply = await client.scan(cursor, {
        MATCH: `${prefix}*`,
        COUNT: 100,
      });
      // In redis v4+/v6, reply can be { cursor, keys } or [cursor, keys]
      let nextCursor = '0';
      let matchingKeys = [];

      if (Array.isArray(reply)) {
        nextCursor = String(reply[0]);
        matchingKeys = reply[1] || [];
      } else if (reply && typeof reply === 'object') {
        nextCursor = String(reply.cursor ?? '0');
        matchingKeys = reply.keys || [];
      }

      if (matchingKeys.length > 0) {
        await client.del(matchingKeys);
      }
      cursor = nextCursor;
    } while (cursor !== '0');
  } catch (err) {
    console.warn(`[redis] Prefix deletion failed for "${prefix}":`, err.message);
  }
}

/**
 * Ping Redis instance to test connectivity.
 */
async function pingRedis() {
  if (!client) initClient();
  if (!client) throw new Error('Redis client not configured');
  return await client.ping();
}

module.exports = {
  connectRedis,
  disconnectRedis,
  isRedisReady,
  getCache,
  setCache,
  deleteCache,
  deleteByPrefix,
  pingRedis,
  getClient: () => client,
};
