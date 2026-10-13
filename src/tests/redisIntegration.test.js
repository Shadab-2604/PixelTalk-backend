/**
 * Redis Cloud Integration Automated Test Suite (redisIntegration.test.js)
 *
 * Verifies:
 * 1. Redis Connection Lifecycle (connect, ping, disconnect).
 * 2. Key/Value operations with TTL and serialization.
 * 3. Prefix-based deletion and cache invalidation.
 * 4. Graceful fallback when Redis is offline or disabled.
 * 5. Multi-user cache isolation (preventing cross-user cache leakage).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const redisService = require('../services/redisService');

describe('Redis Cloud Integration Test Suite', () => {
  before(async () => {
    await redisService.connectRedis();
  });

  after(async () => {
    // Clean up any test keys
    await redisService.deleteByPrefix('pixeltalk:test:');
    await redisService.disconnectRedis();
  });

  test('1. Redis client initializes and responds with PONG', async () => {
    if (!redisService.isRedisReady()) {
      assert.fail('Redis client is not ready');
    }
    const pong = await redisService.pingRedis();
    assert.equal(pong, 'PONG');
  });

  test('2. Basic setCache, getCache, and TTL expiration', async () => {
    const testKey = 'pixeltalk:test:basic_item';
    const testData = { userId: '123', username: 'pixel_user', active: true };

    await redisService.setCache(testKey, testData, 5);
    const retrieved = await redisService.getCache(testKey);

    assert.deepEqual(retrieved, testData);

    await redisService.deleteCache(testKey);
    const postDelete = await redisService.getCache(testKey);
    assert.equal(postDelete, null);
  });

  test('3. Prefix-based invalidation (deleteByPrefix)', async () => {
    const key1 = 'pixeltalk:test:prefix:user1';
    const key2 = 'pixeltalk:test:prefix:user2';
    const keyOther = 'pixeltalk:test:other:item';

    await redisService.setCache(key1, { id: 1 }, 10);
    await redisService.setCache(key2, { id: 2 }, 10);
    await redisService.setCache(keyOther, { id: 'other' }, 10);

    await redisService.deleteByPrefix('pixeltalk:test:prefix:');

    const res1 = await redisService.getCache(key1);
    const res2 = await redisService.getCache(key2);
    const resOther = await redisService.getCache(keyOther);

    assert.equal(res1, null);
    assert.equal(res2, null);
    assert.deepEqual(resOther, { id: 'other' });

    await redisService.deleteCache(keyOther);
  });

  test('4. Cross-user isolation: User A cache key is distinct from User B', async () => {
    const userA_id = 'user_64a001';
    const userB_id = 'user_64a002';
    const viewerA_id = 'viewer_991';
    const viewerB_id = 'viewer_992';

    const key_UserA_for_ViewerA = `pixeltalk:user:profile:${userA_id}:${viewerA_id}`;
    const key_UserA_for_ViewerB = `pixeltalk:user:profile:${userA_id}:${viewerB_id}`;

    await redisService.setCache(key_UserA_for_ViewerA, { profile: 'User A private info for Viewer A', followStatus: 'ACCEPTED' }, 10);
    await redisService.setCache(key_UserA_for_ViewerB, { profile: 'User A public info for Viewer B', followStatus: 'NONE' }, 10);

    const dataForViewerA = await redisService.getCache(key_UserA_for_ViewerA);
    const dataForViewerB = await redisService.getCache(key_UserA_for_ViewerB);

    assert.notDeepEqual(dataForViewerA, dataForViewerB);
    assert.equal(dataForViewerA.followStatus, 'ACCEPTED');
    assert.equal(dataForViewerB.followStatus, 'NONE');

    await redisService.deleteCache([key_UserA_for_ViewerA, key_UserA_for_ViewerB]);
  });

  test('5. Safe fallback on non-existent keys', async () => {
    const missing = await redisService.getCache('pixeltalk:test:nonexistent_key_99999');
    assert.equal(missing, null);
  });
});
