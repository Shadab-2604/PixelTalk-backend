/*
 * ============================================================
 * PIXELTALK — DATABASE MODEL: CONVERSATION (Conversation.js)
 * ============================================================
 *
 * WHAT DATA IS STORED?
 * Stores metadata for communication channels in PixelTalk:
 * - Direct DMs (`type: 'direct'`) between 2 players.
 * - Community Group Lounges (`type: 'group'`) with custom room names, descriptions,
 *   passcodes for private rooms, member lists, and role permissions (Owner, Admin, Moderator, Member).
 *
 * WHY IS IT STORED?
 * To organize messages into channels, manage room privacy/passcodes, track player memberships,
 * and enforce role-based moderation privileges (kicking members, changing passcodes, deleting messages).
 *
 * COLLECTION RELATIONSHIPS:
 * Conversation
 *  ├── createdBy   ──► References [User]
 *  ├── members     ──► References array of [User]
 *  ├── admins      ──► References array of [User]
 *  └── memberRoles ──► Embedded array linking userId [User] to role ('Owner'|'Admin'|'Moderator'|'Member')
 *
 * INDEXES & PERFORMANCE:
 * - `{ members: 1 }`: Fast lookup of all active chats belonging to a player.
 * - `{ nameNormalized: 1 }`: Unique index on normalized lower-case room names (e.g. `#lounge`),
 *   scoped via a `partialFilterExpression` only for active groups (`{ type: 'group', deletedAt: null }`).
 *
 * SECURITY:
 * Private room passcodes (`passcodeHash`) are hashed with bcrypt and marked `select: false`
 * so plain text passcodes or hashes are never exposed over API responses.
 * ============================================================
 */

const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['direct', 'group'], required: true },
    name: { type: String, trim: true, maxlength: 64 }, // required for groups (enforced in service)
    nameNormalized: { type: String, trim: true, lowercase: true, maxlength: 64 },
    description: { type: String, trim: true, maxlength: 240, default: '' },
    avatarId: { type: String, default: 'avatar-06' }, // group avatar uses the 10 retro avatar frames
    avatarUrl: { type: String, default: '' }, // custom uploaded group avatar photo (Cloudinary)
    avatarPublicId: { type: String, default: '' }, // Cloudinary publicId for management
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    admins: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    memberRoles: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        role: { type: String, enum: ['Owner', 'Admin', 'Moderator', 'Member', 'OWNER', 'ADMIN', 'MODERATOR', 'MEMBER'], default: 'Member' },
      },
    ],
    /*
     * USER-SPECIFIC CONVERSATION STATES:
     * - clearedAt: Timestamp when user cleared their message history view. Messages created before this timestamp are hidden from this user.
     * - deletedAt: Timestamp when user deleted this chat from their conversation list. The chat remains hidden from their inbox until a new message arrives.
     * Note: Does NOT delete actual Message documents or affect other participants.
     */
    memberStates: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        clearedAt: { type: Date, default: null },
        deletedAt: { type: Date, default: null },
        sectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatSection', default: null },
      },
    ],
    pastMembers: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        action: { type: String, enum: ['LEFT', 'REMOVED'], default: 'LEFT' },
        removedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        leftAt: { type: Date, default: Date.now },
      },
    ],
    /*
     * MASTER GROUP SETTINGS:
     * - adminOnlyChat: When true, only group OWNER and ADMIN can post messages.
     *   Normal members can read and receive notifications, but cannot send.
     * - invitePermission:
     *   'ANY_MEMBER': Any room member can invite friends to join.
     *   'ADMINS_ONLY': Only OWNER and GROUP ADMIN can invite new players.
     */
    settings: {
      adminOnlyChat: { type: Boolean, default: false },
      invitePermission: { type: String, enum: ['ANY_MEMBER', 'ADMINS_ONLY'], default: 'ANY_MEMBER' },
    },
    permissions: {
      sendMessages: { type: Boolean, default: true },
      editRoom: { type: Boolean, default: false },
      manageMembers: { type: Boolean, default: false },
      manageRoles: { type: Boolean, default: false },
      deleteMessages: { type: Boolean, default: false },
      inviteMembers: { type: Boolean, default: true },
      removeMembers: { type: Boolean, default: false },
      managePasscode: { type: Boolean, default: false },
    },
    privacy: { type: String, enum: ['public', 'private', 'invite'], default: 'public' },
    passcodeHash: { type: String, select: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

conversationSchema.index({ members: 1 });
conversationSchema.index({ type: 1 });
conversationSchema.index({ name: 1 });
conversationSchema.index({ createdBy: 1 });
conversationSchema.index(
  { nameNormalized: 1 },
  { unique: true, partialFilterExpression: { type: 'group', deletedAt: null } },
);

conversationSchema.methods.hasMember = function hasMember(userId) {
  if (!userId || !this.members) return false;
  const uid = userId._id ? userId._id.toString() : userId.toString();
  return this.members.some((m) => {
    if (!m) return false;
    const mid = m._id ? m._id.toString() : m.toString();
    return mid === uid;
  });
};

/*
 * GET MEMBER STATE
 * WHAT: Returns user-specific state ({ clearedAt, deletedAt }) for this conversation.
 * WHY: Enables isolated, user-specific Clear Conversation and Delete Chat without mutating global data.
 */
conversationSchema.methods.getMemberState = function getMemberState(userId) {
  if (!userId) return { clearedAt: null, deletedAt: null };
  const uid = userId._id ? userId._id.toString() : userId.toString();
  if (Array.isArray(this.memberStates)) {
    const entry = this.memberStates.find((s) => {
      const sid = s.userId?._id ? s.userId._id.toString() : s.userId?.toString();
      return sid === uid;
    });
    if (entry) return entry;
  }
  return { clearedAt: null, deletedAt: null };
};

/*
 * GET MEMBER ROLE
 * WHAT: Determines a user's role in this group ('Owner', 'Admin', 'Moderator', 'Member').
 * WHY: Role hierarchy dictates group-level authorities (assigning roles, room edits, invitations).
 * SECURITY: Database-backed authority check; never trusts client-supplied roles.
 */
conversationSchema.methods.getMemberRole = function getMemberRole(userId) {
  if (!userId) return 'Member';
  const uid = userId._id ? userId._id.toString() : userId.toString();
  const ownerId = this.createdBy?._id ? this.createdBy._id.toString() : this.createdBy?.toString();
  if (ownerId && ownerId === uid) return 'Owner';

  if (Array.isArray(this.memberRoles)) {
    const entry = this.memberRoles.find((r) => {
      const rid = r.userId?._id ? r.userId._id.toString() : r.userId?.toString();
      return rid === uid;
    });
    if (entry && entry.role) {
      // Normalize role capitalization
      const normalized = entry.role.charAt(0).toUpperCase() + entry.role.slice(1).toLowerCase();
      return normalized === 'Owner' ? 'Owner' : normalized === 'Admin' ? 'Admin' : normalized === 'Moderator' ? 'Moderator' : 'Member';
    }
  }

  if (Array.isArray(this.admins)) {
    const isAdmin = this.admins.some((m) => {
      if (!m) return false;
      const mid = m._id ? m._id.toString() : m.toString();
      return mid === uid;
    });
    if (isAdmin) return 'Admin';
  }

  return 'Member';
};

/*
 * GROUP ADMIN CHECK
 * WHAT: Verifies if a user is an Owner or Group Admin for THIS specific group.
 * WHY: Group Admins have moderation and configuration rights over their own group.
 * SECURITY: Platform Admin does NOT automatically inherit Group Admin privileges.
 */
conversationSchema.methods.hasAdmin = function hasAdmin(userId) {
  if (!userId) return false;
  const role = this.getMemberRole(userId);
  return role === 'Owner' || role === 'Admin';
};

/*
 * GROUP OWNER CHECK
 * WHAT: Verifies if user is the Owner (highest group authority).
 */
conversationSchema.methods.isOwner = function isOwner(userId) {
  if (!userId) return false;
  return this.getMemberRole(userId) === 'Owner';
};

/*
 * CAN SEND MESSAGE PERMISSION CHECK
 * WHAT: Backend enforcement for group messaging permissions.
 * WHY: When adminOnlyChat is enabled, only OWNER and GROUP ADMIN can post messages.
 * SECURITY: Prevents unauthorized messaging directly at the database/service layer.
 */
conversationSchema.methods.canSendMessage = function canSendMessage(userId) {
  if (!userId) return false;
  if (!this.hasMember(userId)) return false;
  if (this.type !== 'group') return true;

  // If Admin-Only Chat is ON, strictly limit to Owner & Admin
  if (this.settings && this.settings.adminOnlyChat === true) {
    return this.hasAdmin(userId);
  }

  // Otherwise check default permission
  if (this.permissions && typeof this.permissions.sendMessages === 'boolean') {
    return this.permissions.sendMessages;
  }
  return true;
};

/*
 * CAN INVITE MEMBERS CHECK
 * WHAT: Checks if user can create invitations for this group.
 * WHY: If invitePermission is 'ADMINS_ONLY', normal members cannot invite users.
 * SECURITY: Backend must enforce this so API/socket calls cannot bypass frontend UI.
 */
conversationSchema.methods.canInvite = function canInvite(userId) {
  if (!userId) return false;
  if (!this.hasMember(userId)) return false;
  if (this.type !== 'group') return false;

  if (this.settings && this.settings.invitePermission === 'ADMINS_ONLY') {
    return this.hasAdmin(userId);
  }

  if (this.permissions && typeof this.permissions.inviteMembers === 'boolean') {
    return this.permissions.inviteMembers;
  }
  return true;
};

conversationSchema.methods.canUser = function canUser(userId, action) {
  if (!userId) return false;
  const role = this.getMemberRole(userId);
  if (role === 'Owner') return true;
  if (role === 'Admin') {
    if (action === 'deleteRoom' || action === 'transferOwnership') return false;
    return true;
  }
  if (role === 'Moderator') {
    if (['deleteMessages', 'removeMembers'].includes(action)) return true;
    return false;
  }
  // Member role checks
  if (action === 'sendMessages') return this.canSendMessage(userId);
  if (action === 'inviteMembers') return this.canInvite(userId);

  if (this.permissions && typeof this.permissions[action] === 'boolean') {
    return this.permissions[action];
  }
  return false;
};

conversationSchema.set('toJSON', {
  virtuals: true,
  transform(doc, ret) {
    delete ret.passcodeHash;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Conversation', conversationSchema);
