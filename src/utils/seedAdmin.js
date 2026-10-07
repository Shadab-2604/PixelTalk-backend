/**
 * File: seedAdmin.js
 *
 * Responsibility:
 * Standalone CLI utility to provision or promote the administrator account
 * directly from ADMIN_EMAIL, ADMIN_USERNAME, and ADMIN_PASSWORD in backend/.env.
 *
 * Layer:
 * Backend / Database Utilities
 *
 * Connected to:
 * - backend/src/models/User.js
 * - backend/src/config/index.js
 *
 * Important behavior:
 * - Idempotently updates existing account with admin role or creates a new active admin.
 */
const mongoose = require('mongoose');
const config = require('../config');
const User = require('../models/User');

async function main() {
  const { ADMIN_EMAIL, ADMIN_USERNAME, ADMIN_DISPLAY_NAME, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('[seed:admin] ADMIN_EMAIL and ADMIN_PASSWORD must be set in backend/.env');
    process.exit(1);
  }

  await mongoose.connect(config.mongoUri);

  let user = await User.findOne({ $or: [{ email: ADMIN_EMAIL }, ...(ADMIN_USERNAME ? [{ username: ADMIN_USERNAME }] : [])] });
  if (user) {
    user.role = 'admin';
    user.status = 'active';
    user.passwordHash = ADMIN_PASSWORD;
    await user.save();
    console.log(`[seed:admin] updated admin account: ${user.email} (@${user.username})`);
  } else {
    await User.create({
      username: ADMIN_USERNAME || 'admin',
      displayName: ADMIN_DISPLAY_NAME || 'Admin',
      email: ADMIN_EMAIL,
      passwordHash: ADMIN_PASSWORD,
      avatarId: 'avatar-05',
      role: 'admin',
      status: 'active',
    });
    console.log(`[seed:admin] created admin: ${ADMIN_EMAIL}`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[seed:admin] failed:', err.message);
  process.exit(1);
});
