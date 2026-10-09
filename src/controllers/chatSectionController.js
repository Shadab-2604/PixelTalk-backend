/**
 * Chat Section / Folder Controller
 *
 * Coordinates personal conversation folder operations:
 * - Creating, renaming, deleting, and reordering chat folders.
 * - Locking, unlocking, and managing PINs/passcodes.
 * - Moving direct chats and group lounges into folders.
 */

const { ok } = require('../utils/apiResponse');
const chatSectionService = require('../services/chatSectionService');

async function listSections(req, res, next) {
  try {
    const sections = await chatSectionService.listSections(req.user._id);
    ok(res, { sections });
  } catch (err) {
    next(err);
  }
}

async function createSection(req, res, next) {
  try {
    const section = await chatSectionService.createSection(req.user._id, {
      name: req.body.name,
      isLocked: req.body.isLocked,
      passcode: req.body.passcode,
    });
    res.status(201).json({ success: true, data: { section } });
  } catch (err) {
    next(err);
  }
}

async function renameSection(req, res, next) {
  try {
    const section = await chatSectionService.renameSection(req.user._id, req.params.id, req.body.name);
    ok(res, { section });
  } catch (err) {
    next(err);
  }
}

async function unlockSection(req, res, next) {
  try {
    const result = await chatSectionService.unlockSection(req.user._id, req.params.id, req.body.passcode);
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function setLock(req, res, next) {
  try {
    const section = await chatSectionService.setLock(req.user._id, req.params.id, {
      currentPasscode: req.body.currentPasscode,
      newPasscode: req.body.newPasscode,
    });
    ok(res, { section });
  } catch (err) {
    next(err);
  }
}

async function removeLock(req, res, next) {
  try {
    const section = await chatSectionService.removeLock(
      req.user._id,
      req.params.id,
      req.body.currentPasscode || req.body.passcode,
    );
    ok(res, { section });
  } catch (err) {
    next(err);
  }
}

async function deleteSection(req, res, next) {
  try {
    const result = await chatSectionService.deleteSection(req.user._id, req.params.id);
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function reorderSections(req, res, next) {
  try {
    const sections = await chatSectionService.reorderSections(req.user._id, req.body.orderedIds);
    ok(res, { sections });
  } catch (err) {
    next(err);
  }
}

async function moveConversation(req, res, next) {
  try {
    const result = await chatSectionService.moveConversationToSection(
      req.user._id,
      req.params.id,
      req.body.sectionId || null,
    );
    ok(res, result);
  } catch (err) {
    next(err);
  }
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
  moveConversation,
};
