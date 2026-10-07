/*
 * ============================================================
 * PIXELTALK — CHAT SECTION SERVICE (services/chatSectionService.js)
 * ============================================================
 *
 * WHAT:
 * Business logic for personal conversation folders/sections:
 * - Creating, renaming, deleting, and reordering personal sections.
 * - Moving direct chats and group lounges into / between sections.
 * - Removing conversations from a section back to the default "All" view.
 *
 * PRIVACY GUARANTEE:
 * Chat sections belong EXCLUSIVELY to the user who created them.
 * Section assignments are stored per-user in `Conversation.memberStates` and are
 * never visible or leaked to other conversation participants.
 * ============================================================
 */

const mongoose = require('mongoose');
const ChatSection = require('../models/ChatSection');
const Conversation = require('../models/Conversation');
const { ApiError } = require('../utils/apiResponse');
const { requireString } = require('../utils/validation');

/**
 * List all chat sections for the authenticated user, sorted by personal display order.
 */
async function listSections(userId) {
  return ChatSection.find({ userId }).sort({ order: 1, createdAt: 1 }).lean();
}

/**
 * Create a new personal chat section with duplicate-name validation.
 */
async function createSection(userId, rawName) {
  const name = requireString(rawName, 'Section name', { min: 1, max: 40 });
  const nameNormalized = name.toLowerCase().trim();

  const existing = await ChatSection.findOne({ userId, nameNormalized });
  if (existing) {
    throw new ApiError(409, `You already have a section named "${name}"`);
  }

  const count = await ChatSection.countDocuments({ userId });
  const section = await ChatSection.create({
    userId,
    name: name.trim(),
    nameNormalized,
    order: count,
  });

  return section;
}

/**
 * Rename an existing chat section.
 */
async function renameSection(userId, sectionId, rawName) {
  if (!mongoose.isValidObjectId(sectionId)) throw new ApiError(400, 'Invalid section ID');
  const name = requireString(rawName, 'Section name', { min: 1, max: 40 });
  const nameNormalized = name.toLowerCase().trim();

  const section = await ChatSection.findOne({ _id: sectionId, userId });
  if (!section) throw new ApiError(404, 'Section not found');

  const duplicate = await ChatSection.findOne({
    userId,
    nameNormalized,
    _id: { $ne: sectionId },
  });
  if (duplicate) {
    throw new ApiError(409, `You already have a section named "${name}"`);
  }

  section.name = name.trim();
  section.nameNormalized = nameNormalized;
  await section.save();

  return section;
}

/**
 * Delete a chat section.
 * CRITICAL: Does NOT delete conversations or messages!
 * Simply resets the user's `sectionId` in their conversation `memberStates` to null.
 */
async function deleteSection(userId, sectionId) {
  if (!mongoose.isValidObjectId(sectionId)) throw new ApiError(400, 'Invalid section ID');

  const section = await ChatSection.findOneAndDelete({ _id: sectionId, userId });
  if (!section) throw new ApiError(404, 'Section not found');

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
 * Reorder sections for the user.
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
 * Move a conversation into a section (or remove from section if sectionId is null).
 */
async function moveConversationToSection(userId, conversationId, sectionId = null) {
  if (!mongoose.isValidObjectId(conversationId)) throw new ApiError(400, 'Invalid conversation ID');

  const convo = await Conversation.findOne({ _id: conversationId, members: userId });
  if (!convo) throw new ApiError(404, 'Conversation not found or you are not a member');

  let validSectionId = null;
  if (sectionId) {
    if (!mongoose.isValidObjectId(sectionId)) throw new ApiError(400, 'Invalid section ID');
    const section = await ChatSection.findOne({ _id: sectionId, userId });
    if (!section) throw new ApiError(404, 'Section not found');
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
  deleteSection,
  reorderSections,
  moveConversationToSection,
};
