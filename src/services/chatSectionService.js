/*
 * ============================================================
 * PIXELTALK — CHAT SECTION / FOLDER SERVICE (services/chatSectionService.js)
 * ============================================================
 *
 * WHAT:
 * Business logic for personal conversation folders/sections:
 * - Creating, renaming, deleting, and reordering personal folders.
 * - Setting, changing, removing, and verifying optional folder PIN/passcodes.
 * - Moving direct chats and group lounges into / between folders.
 * - Removing conversations from a folder back to the default unfiled view.
 *
 * PRIVACY & SECURITY GUARANTEE:
 * 1. Personal Scope: Folders belong EXCLUSIVELY to the user who created them.
 *    Folder assignments are stored per-user in `Conversation.memberStates` and are
 *    never visible or leaked to other conversation participants.
 * 2. Non-Destructive: Deleting a folder or moving chats NEVER deletes underlying
 *    conversations, memberships, or message histories.
 * 3. Protected Locks: Passcodes are cryptographically hashed using bcrypt with salt rounds.
 *    Passcode hashes are marked `select: false` and never exposed over API responses.
 * ============================================================
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const ChatSection = require('../models/ChatSection');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { ApiError } = require('../utils/apiResponse');
const { requireString } = require('../utils/validation');

/**
 * List all chat folders for the authenticated user, sorted by personal display order.
 */
async function listSections(userId) {
  return ChatSection.find({ userId }).sort({ order: 1, createdAt: 1 });
}

/**
 * Create a new personal chat folder with optional PIN/password locking.
 *
 * @param {string|ObjectId} userId
 * @param {object|string} payload - Object with { name, isLocked, passcode } or string name
 */
async function createSection(userId, payload) {
  const rawName = typeof payload === 'string' ? payload : payload?.name;
  const isLocked = Boolean(payload?.isLocked);
  const rawPasscode = payload?.passcode ? String(payload.passcode).trim() : '';

  const name = requireString(rawName, 'Folder name', { min: 1, max: 40 });
  const nameNormalized = name.toLowerCase().trim();

  const existing = await ChatSection.findOne({ userId, nameNormalized });
  if (existing) {
    throw new ApiError(409, `You already have a folder named "${name}"`);
  }

  let passcodeHash = undefined;
  if (isLocked) {
    if (!rawPasscode || rawPasscode.length < 4) {
      throw new ApiError(400, 'Folder PIN/password must be at least 4 characters');
    }
    passcodeHash = await bcrypt.hash(rawPasscode, 10);
  }

  const count = await ChatSection.countDocuments({ userId });
  const section = await ChatSection.create({
    userId,
    name: name.trim(),
    nameNormalized,
    order: count,
    isLocked: isLocked,
    hasPasscode: isLocked && Boolean(passcodeHash),
    passcodeHash: passcodeHash,
  });

  return section;
}

/**
 * Rename an existing chat folder.
 */
async function renameSection(userId, sectionId, rawName) {
  if (!mongoose.isValidObjectId(sectionId)) throw new ApiError(400, 'Invalid folder ID');
  const name = requireString(rawName, 'Folder name', { min: 1, max: 40 });
  const nameNormalized = name.toLowerCase().trim();

  const section = await ChatSection.findOne({ _id: sectionId, userId });
  if (!section) throw new ApiError(404, 'Folder not found');

  const duplicate = await ChatSection.findOne({
    userId,
    nameNormalized,
    _id: { $ne: sectionId },
  });
  if (duplicate) {
    throw new ApiError(409, `You already have a folder named "${name}"`);
  }

  section.name = name.trim();
  section.nameNormalized = nameNormalized;
  await section.save();

  return section;
}

/**
 * Unlock a protected folder by verifying its PIN/password.
 */
async function unlockSection(userId, sectionId, passcode) {
  if (!mongoose.isValidObjectId(sectionId)) throw new ApiError(400, 'Invalid folder ID');

  const section = await ChatSection.findOne({ _id: sectionId, userId }).select('+passcodeHash');
  if (!section) throw new ApiError(404, 'Folder not found');

  if (!section.isLocked || !section.hasPasscode) {
    return { success: true, unlocked: true, sectionId };
  }

  if (!passcode) {
    throw new ApiError(400, 'PIN or password is required to unlock this folder');
  }

  const isValid = await section.comparePasscode(String(passcode).trim());
  if (!isValid) {
    throw new ApiError(401, 'Incorrect folder PIN or password');
  }

  return { success: true, unlocked: true, sectionId };
}

/**
 * Set or change the lock PIN/password for an existing folder.
 */
async function setLock(userId, sectionId, { currentPasscode, newPasscode }) {
  if (!mongoose.isValidObjectId(sectionId)) throw new ApiError(400, 'Invalid folder ID');

  const section = await ChatSection.findOne({ _id: sectionId, userId }).select('+passcodeHash');
  if (!section) throw new ApiError(404, 'Folder not found');

  // If already locked, require current passcode confirmation
  if (section.hasPasscode && section.passcodeHash) {
    if (!currentPasscode) {
      throw new ApiError(400, 'Current PIN or password is required to change lock');
    }
    const matches = await section.comparePasscode(String(currentPasscode).trim());
    if (!matches) {
      throw new ApiError(401, 'Current PIN or password does not match');
    }
  }

  const trimmedNew = String(newPasscode || '').trim();
  if (!trimmedNew || trimmedNew.length < 4) {
    throw new ApiError(400, 'New PIN or password must be at least 4 characters');
  }

  section.passcodeHash = await bcrypt.hash(trimmedNew, 10);
  section.isLocked = true;
  section.hasPasscode = true;
  await section.save();

  return section;
}

/**
 * Remove the lock from a folder.
 */
async function removeLock(userId, sectionId, currentPasscode) {
  if (!mongoose.isValidObjectId(sectionId)) throw new ApiError(400, 'Invalid folder ID');

  const section = await ChatSection.findOne({ _id: sectionId, userId }).select('+passcodeHash');
  if (!section) throw new ApiError(404, 'Folder not found');

  if (section.hasPasscode && section.passcodeHash) {
    if (!currentPasscode) {
      throw new ApiError(400, 'Current PIN or password is required to remove lock');
    }
    const matches = await section.comparePasscode(String(currentPasscode).trim());
    if (!matches) {
      throw new ApiError(401, 'Current PIN or password does not match');
    }
  }

  section.isLocked = false;
  section.hasPasscode = false;
  section.passcodeHash = undefined;
  await section.save();

  return section;
}

/**
 * Delete a chat folder.
 * CRITICAL: Does NOT delete conversations or messages!
 * Simply resets the user's `sectionId` in their conversation `memberStates` to null.
 */
async function deleteSection(userId, sectionId) {
  if (!mongoose.isValidObjectId(sectionId)) throw new ApiError(400, 'Invalid folder ID');

  const section = await ChatSection.findOneAndDelete({ _id: sectionId, userId });
  if (!section) throw new ApiError(404, 'Folder not found');

  // Reset sectionId for this user in all affected conversations
  await Conversation.updateMany(
    {
      members: userId,
      'memberStates.userId': userId,
      'memberStates.sectionId': sectionId,
    },
    {
      $set: { 'memberStates.$.sectionId': null },
    },
  );

  return { success: true, deletedId: sectionId };
}

/**
 * Reorder folders for the user.
 */
async function reorderSections(userId, orderedIds = []) {
  if (!Array.isArray(orderedIds)) throw new ApiError(400, 'orderedIds must be an array');

  const updates = orderedIds.map((id, index) =>
    ChatSection.updateOne({ _id: id, userId }, { $set: { order: index } }),
  );

  await Promise.all(updates);
  return listSections(userId);
}

/**
 * Move a conversation into a folder (or remove from folder if sectionId is null).
 */
async function moveConversationToSection(userId, conversationId, sectionId = null) {
  if (!mongoose.isValidObjectId(conversationId)) throw new ApiError(400, 'Invalid conversation ID');

  const convo = await Conversation.findOne({ _id: conversationId, members: userId });
  if (!convo) throw new ApiError(404, 'Conversation not found or you are not a member');

  let validSectionId = null;
  if (sectionId) {
    if (!mongoose.isValidObjectId(sectionId)) throw new ApiError(400, 'Invalid folder ID');
    const section = await ChatSection.findOne({ _id: sectionId, userId });
    if (!section) throw new ApiError(404, 'Folder not found');
    validSectionId = section._id;
  }

  // Update or insert user's memberState
  let state = convo.memberStates.find((m) => String(m.userId) === String(userId));
  if (!state) {
    convo.memberStates.push({
      userId,
      sectionId: validSectionId,
    });
  } else {
    state.sectionId = validSectionId;
  }

  await convo.save();
  return { success: true, conversationId, sectionId: validSectionId };
}

module.exports = {
  listSections,
  createSection,
  renameSection,
  unlockSection,
  setLock,
  removeLock,
  deleteSection,
  reorderSections,
  moveConversationToSection,
};
