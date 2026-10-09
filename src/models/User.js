/*
 * ============================================================
 * PIXELTALK — DATABASE MODEL: USER (User.js)
 * ============================================================
 *
 * WHAT DATA IS STORED?
 * Stores user account credentials (email, username, encrypted password), profile identity
 * (displayName, bio, retro avatar selection, custom status), Cloudinary image URLs
 * (avatarUrl, bannerUrl), user preferences (theme, audio, notification mode), and
 * lists of pinned/muted conversation IDs.
 *
 * WHY IS IT STORED?
 * To authenticate users, authorize access to direct chats and community lounges, display
 * player profiles, enforce role permissions (user vs admin), and persist user sound/theme settings.
 *
 * COLLECTION RELATIONSHIPS:
 * User
 *  ├── pinnedConversations  ──► References [Conversation]
 *  ├── mutedConversations   ──► References [Conversation]
 *  └── vibrateConversations ──► References [Conversation]
 *
 * SECURITY:
 * - Passwords are NEVER stored in plain text. A pre-save hook automatically converts
 *   passwords into a 10-round salted bcrypt hash before writing to MongoDB.
 * - `passwordHash` is configured with `select: false` so standard database queries never leak hashes.
 * - `toJSON` transformation permanently deletes `passwordHash` before sending objects to the client.
 * ============================================================
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true, minlength: 3, maxlength: 30 },
    displayName: { type: String, required: true, trim: true, maxlength: 32 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    avatarId: { type: String, required: true, enum: Array.from({ length: 10 }, (_, i) => `avatar-${String(i + 1).padStart(2, '0')}`) },
    avatarUrl: { type: String, default: '' },
    avatarPublicId: { type: String, default: '' },
    bannerUrl: { type: String, default: '' },
    bannerPublicId: { type: String, default: '' },
    bannerId: {
      type: String,
      default: 'banner-01',
      enum: Array.from({ length: 10 }, (_, i) => `banner-${String(i + 1).padStart(2, '0')}`),
    },
    bio: { type: String, trim: true, maxlength: 240, default: '' },
    customStatus: { type: String, trim: true, maxlength: 100, default: '' },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    status: { type: String, enum: ['active', 'suspended', 'banned'], default: 'active' },
    presence: { type: String, enum: ['online', 'offline', 'away'], default: 'offline' },
    lastSeen: { type: Date, default: Date.now },
    preferences: {
      theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
      soundEnabled: { type: Boolean, default: true },
      soundVolume: { type: Number, default: 80, min: 0, max: 100 },
      notificationsEnabled: { type: Boolean, default: true },
      notificationMode: { type: String, enum: ['normal', 'vibrate', 'silent'], default: 'normal' },
      density: { type: String, enum: ['compact', 'comfortable', 'spacious'], default: 'comfortable' },
    },
    privacy: {
      accountType: { type: String, enum: ['public', 'private'], default: 'public' },
    },
    pinnedConversations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' }],
    mutedConversations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' }],
    vibrateConversations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' }],
  },
  { timestamps: true },
);

// Hash whenever the password field is set or changed (unless already a valid bcrypt hash)
userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('passwordHash')) return;
  // If the value is already a valid 60-character bcrypt hash (e.g. from ADMIN_PASSWORD_HASH in .env), do not re-hash
  if (typeof this.passwordHash === 'string' && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(this.passwordHash)) {
    return;
  }
  const salt = await bcrypt.genSalt(10);
  this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
});

userSchema.methods.comparePassword = async function comparePassword(candidate) {
  if (!this.passwordHash || !candidate) return false;
  return bcrypt.compare(candidate, this.passwordHash);
};


/*
 * PLATFORM ROLE SEPARATION
 * WHAT: Explicit virtual returning 'PLATFORM_ADMIN' or 'USER'.
 * WHY: Disambiguates platform-level authority (Platform Admin) from group-level authority (Group Admin).
 * A Platform Admin manages the overall application but has no intrinsic group privileges or private chat access.
 */
userSchema.virtual('platformRole').get(function getPlatformRole() {
  return this.role === 'admin' ? 'PLATFORM_ADMIN' : 'USER';
});

// Never expose the hash
userSchema.set('toJSON', {
  virtuals: true,
  transform(doc, ret) {
    delete ret.passwordHash;
    delete ret.__v;
    return ret;
  },
});

userSchema.set('toObject', { getters: true });

module.exports = mongoose.model('User', userSchema);
