/**
 * File: seed.js
 *
 * Responsibility:
 * Development database seeder utility generating initial test fixtures:
 * 1 administrator, 4 standard testing accounts, direct conversations,
 * sample chat messages, and public/private group lounges.
 *
 * Layer:
 * Backend / Database Utilities
 *
 * Connected to:
 * - backend/src/models/User.js
 * - backend/src/models/Conversation.js
 * - backend/src/models/Message.js
 * - backend/src/config/index.js
 *
 * Important behavior:
 * - Upserts users idempotently without duplicating existing usernames.
 * - Enforces environment-configured administrator credentials.
 */
const mongoose = require('mongoose');
const config = require('../config');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

const PASSWORD = 'password123';

const USERS = [
  { username: 'shad', displayName: 'Shad', email: 'shad@pixeltalk.dev', avatarId: 'avatar-01', role: 'user' },
  { username: 'rahul_dev', displayName: 'Rahul', email: 'rahul@pixeltalk.dev', avatarId: 'avatar-02', role: 'user' },
  { username: 'alex_ui', displayName: 'Alex', email: 'alex@pixeltalk.dev', avatarId: 'avatar-03', role: 'user' },
  { username: 'elena_art', displayName: 'Elena', email: 'elena@pixeltalk.dev', avatarId: 'avatar-04', role: 'user' },
];

async function upsertUser(u, extra = {}) {
  const found = await User.findOne({ username: u.username });
  if (found) return found;
  return User.create({ ...u, passwordHash: PASSWORD, ...extra });
}

async function seedAdminFromEnv() {
  const { ADMIN_EMAIL, ADMIN_USERNAME, ADMIN_DISPLAY_NAME, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log('[seed] ADMIN_EMAIL/ADMIN_PASSWORD not set — skipping env admin creation');
    return;
  }
  const existing = await User.findOne({ $or: [{ email: ADMIN_EMAIL }, { username: ADMIN_USERNAME || 'admin' }] });
  if (existing) {
    existing.role = 'admin';
    existing.status = 'active';
    existing.passwordHash = ADMIN_PASSWORD;
    await existing.save();
    console.log(`[seed] admin account ensured: ${existing.email}`);
    return;
  }
  await User.create({
    username: ADMIN_USERNAME || 'admin',
    displayName: ADMIN_DISPLAY_NAME || 'Admin',
    email: ADMIN_EMAIL,
    passwordHash: ADMIN_PASSWORD,
    avatarId: 'avatar-05',
    role: 'admin',
  });
  console.log(`[seed] admin account created: ${ADMIN_EMAIL}`);
}

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log('[seed] connected');

  // Wipe dev collections so re-runs are deterministic
  await Promise.all([User.deleteMany({}), Conversation.deleteMany({}), Message.deleteMany({})]);

  const users = {};
  for (const u of USERS) users[u.username] = await upsertUser(u);

  await seedAdminFromEnv();
  const admin = await User.findOne({ role: 'admin' });

  const [shad, rahul, alex, elena] = [users.shad, users.rahul_dev, users.alex_ui, users.elena_art];

  // Direct conversations
  const d1 = await Conversation.create({ type: 'direct', members: [shad._id, rahul._id], admins: [shad._id], createdBy: shad._id });
  const d2 = await Conversation.create({ type: 'direct', members: [shad._id, alex._id], admins: [shad._id], createdBy: shad._id });

  // Groups — one open (invite), one passcode-protected
  const g1 = await Conversation.create({
    type: 'group',
    name: 'Dev Survivors',
    description: 'Official squad room for surviving production releases without rollback.',
    avatarId: 'avatar-06',
    members: [shad._id, rahul._id, alex._id, elena._id],
    admins: [shad._id],
    createdBy: shad._id,
    privacy: 'invite',
  });
  const g2 = await Conversation.create({
    type: 'group',
    name: 'Weekend Squad',
    description: 'Gaming, memes and questionable decisions.',
    avatarId: 'avatar-07',
    members: [shad._id, rahul._id],
    admins: [shad._id],
    createdBy: shad._id,
    privacy: 'private',
  });
  // Hash the passcode "gameon" for the private group
  const bcrypt = require('bcryptjs');
  g2.passcodeHash = await bcrypt.hash('gameon', 10);
  await g2.save();

  const t = (min) => new Date(Date.now() - min * 60 * 1000);
  const messages = [
    { c: d1._id, s: rahul._id, at: t(9), content: 'Bro look at this 💀' },
    { c: d1._id, s: shad._id, at: t(8), content: 'Did you actually deploy that?' },
    { c: d1._id, s: rahul._id, at: t(7), content: 'Unfortunately.' },
    { c: d2._id, s: alex._id, at: t(30), content: 'Production is finally working. The pixel shader pipeline compiles cleanly on web now! 🚀' },
    { c: g1._id, s: rahul._id, at: t(6), content: 'Meeting starts in 10. Bring your sprint demo links ready.' },
    { c: g1._id, s: alex._id, at: t(5), content: 'We are cooked.' },
    { c: g1._id, s: shad._id, at: t(4), content: 'Not on a Friday. Please.' },
    { c: g2._id, s: rahul._id, at: t(3), content: 'Who is joining tonight? 👾' },
  ];
  for (const m of messages) {
    await Message.create({ conversationId: m.c, senderId: m.s, content: m.content, createdAt: m.at, updatedAt: m.at });
  }
  console.log(`[seed] ${messages.length} messages planted`);

  console.log('\n[seed] Done. Development accounts (all password: password123):');
  for (const u of Object.values(users)) console.log(`  ${u.email} — @${u.username} (${u.role})`);
  if (admin) console.log(`  ${admin.email} — @${admin.username} (admin)`);
  console.log('\n[seed] Private group "Weekend Squad" passcode: gameon\n');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
