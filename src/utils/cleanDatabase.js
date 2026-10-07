/**
 * PixelTalk Database Reset & Cleanup Utility
 *
 * Responsibility:
 * Securely deletes all documents from all active PixelTalk collections
 * (Users, Conversations, Messages, OTP Tokens, and Admin Audit Logs).
 *
 * Preserves collection schemas and indexes (compound indexes, unique constraints,
 * TTL expiration indexes) so the application can immediately accept fresh registrations.
 */

const mongoose = require('mongoose');
const config = require('../config');

const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const OtpToken = require('../models/OtpToken');
const AdminAuditLog = require('../models/AdminAuditLog');

async function cleanDatabase() {
  console.log('[cleanDatabase] Connecting to MongoDB at:', config.mongoUri);
  await mongoose.connect(config.mongoUri);

  console.log('[cleanDatabase] Clearing all PixelTalk collections...');

  const [usersRes, convosRes, msgsRes, otpsRes, auditRes] = await Promise.all([
    User.deleteMany({}),
    Conversation.deleteMany({}),
    Message.deleteMany({}),
    OtpToken.deleteMany({}),
    AdminAuditLog.deleteMany({}),
  ]);

  console.log(`[cleanDatabase] Cleared:
  - Users: ${usersRes.deletedCount}
  - Conversations: ${convosRes.deletedCount}
  - Messages: ${msgsRes.deletedCount}
  - OTP Tokens: ${otpsRes.deletedCount}
  - Admin Audit Logs: ${auditRes.deletedCount}`);

  console.log('[cleanDatabase] Database is now completely clean and ready for initial user setup!');
  await mongoose.disconnect();
}

cleanDatabase().catch((err) => {
  console.error('[cleanDatabase] Error during database reset:', err);
  process.exit(1);
});
