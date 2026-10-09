/*
 * ============================================================
 * PIXELTALK — DATABASE MODEL: CHAT SECTION (ChatSection.js)
 * ============================================================
 *
 * WHAT:
 * Defines custom personal chat folders/categories created by a user
 * (e.g. "Family", "Friends", "Work", "Gaming", "Projects").
 *
 * WHY:
 * Chat sections are strictly personal. Assigning a conversation to a section
 * organizes it ONLY for the user who created the section. It does NOT affect
 * how other participants view or organize the conversation.
 *
 * COLLECTION RELATIONSHIPS:
 * ChatSection
 *  └── userId ──► References [User] (Owner of this personal folder)
 *
 * Conversation.memberStates
 *  └── sectionId ──► References [ChatSection] (Per-user section assignment)
 *
 * INDEXES & PERFORMANCE:
 * - `{ userId: 1, nameNormalized: 1 }`: Unique index preventing duplicate section names per user.
 * - `{ userId: 1, order: 1 }`: Fast retrieval ordered by personal folder preference.
 * ============================================================
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const chatSectionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
    },
    nameNormalized: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 40,
    },
    order: {
      type: Number,
      default: 0,
    },
    isLocked: {
      type: Boolean,
      default: false,
    },
    hasPasscode: {
      type: Boolean,
      default: false,
    },
    passcodeHash: {
      type: String,
      select: false,
    },
  },
  { timestamps: true },
);

// Prevent duplicate section/folder names for the same user
chatSectionSchema.index({ userId: 1, nameNormalized: 1 }, { unique: true });
chatSectionSchema.index({ userId: 1, order: 1 });

chatSectionSchema.methods.comparePasscode = async function comparePasscode(candidate) {
  if (!this.passcodeHash) return false;
  return bcrypt.compare(candidate, this.passcodeHash);
};

chatSectionSchema.set('toJSON', {
  virtuals: true,
  transform(doc, ret) {
    delete ret.passcodeHash;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('ChatSection', chatSectionSchema);
