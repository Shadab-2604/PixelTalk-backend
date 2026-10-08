/**
 * Database Migration Utility: Legacy User Schema Normalizer
 *
 * Responsibility:
 * Automatically normalizes any legacy or partially-populated user documents in MongoDB:
 * - Maps `name` -> `displayName`
 * - Generates unique fallback `username` from email
 * - Maps `password` -> `passwordHash`
 * - Sets default `avatarId` ('avatar-01')
 * - Ensures active account status & valid platform role
 */

const mongoose = require('mongoose');

async function migrateLegacyUsers() {
  try {
    const rawUsers = await mongoose.connection.collection('users').find({}).toArray();

    for (const u of rawUsers) {
      const updates = {};

      if (!u.displayName) {
        updates.displayName = u.name || u.email.split('@')[0] || 'Player';
      }

      if (!u.username) {
        let base = (u.email.split('@')[0] || 'player').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
        if (base.length < 3) base = base.padEnd(3, '0');
        // Check collision
        let candidate = base;
        let counter = 1;
        while (await mongoose.connection.collection('users').findOne({ username: candidate, _id: { $ne: u._id } })) {
          candidate = `${base}${counter}`;
          counter += 1;
        }
        updates.username = candidate;
      }

      if (!u.passwordHash && u.password) {
        updates.passwordHash = u.password;
      }

      if (!u.avatarId) {
        updates.avatarId = 'avatar-01';
      }

      if (!u.status) {
        updates.status = u.isActive === false ? 'suspended' : 'active';
      }

      if (!u.role) {
        updates.role = 'user';
      }

      if (Object.keys(updates).length > 0) {
        await mongoose.connection.collection('users').updateOne(
          { _id: u._id },
          { $set: updates }
        );
        console.log(`[migration] Normalized legacy user: ${u.email} -> @${updates.username || u.username}`);
      }
    }
  } catch (err) {
    console.warn('[migration] Legacy user migration notice:', err.message);
  }
}

module.exports = { migrateLegacyUsers };
