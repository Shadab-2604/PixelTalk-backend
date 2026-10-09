/**
 * Master API Router
 *
 * Responsibility:
 * Central dispatch table defining all RESTful API endpoints for PixelTalk.
 * Applies endpoint-specific rate limiters, session authentication middleware,
 * and passes request execution safely to dedicated controllers via `asyncHandler`.
 *
 * CONNECTED MODULES:
 * - Server: backend/src/server.js (mounted at `/api`)
 * - Controllers:
 *   - backend/src/controllers/authController.js
 *   - backend/src/controllers/userController.js
 *   - backend/src/controllers/conversationController.js
 *   - backend/src/controllers/messageController.js
 *   - backend/src/controllers/adminController.js
 * - Middleware: backend/src/middleware/auth.js (requireAuth, requireAdmin)
 *
 * CONCEPTS:
 * - Granular Rate Limiting: Authentication and OTP endpoints are aggressively rate-limited
 *   (authLimiter: 50 requests / 15 minutes) to mitigate credential stuffing and email bombing.
 * - Layer Separation: Route definitions contain zero business logic or direct database queries.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const auth = require('../controllers/authController');
const users = require('../controllers/userController');
const convos = require('../controllers/conversationController');
const messages = require('../controllers/messageController');
const admin = require('../controllers/adminController');
const follow = require('../controllers/followController');
const chatSections = require('../controllers/chatSectionController');
const notifications = require('../controllers/notificationController');
const { requireAuth, optionalAuth, requireAdmin } = require('../middleware/auth');
const { uploadAvatar, uploadBanner, uploadMedia } = require('../middleware/upload');
const { asyncHandler, ApiError } = require('../utils/apiResponse');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts, please try again later' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Rate limit exceeded' },
});

// ---------------- Auth ----------------
router.post('/auth/register', authLimiter, asyncHandler(auth.register));
router.post('/auth/login', authLimiter, asyncHandler(auth.login));
router.post('/auth/logout', authLimiter, asyncHandler(auth.logout));
router.get('/auth/me', requireAuth, asyncHandler(auth.me));
router.post('/auth/change-password', requireAuth, authLimiter, asyncHandler(auth.changePassword));

// ---------------- Auth OTP Flows ----------------
router.post('/auth/otp/send-verification', authLimiter, asyncHandler(auth.sendVerificationOtp));
router.post('/auth/otp/verify-email', authLimiter, asyncHandler(auth.verifyEmailOtp));
router.post('/auth/otp/send-login-code', authLimiter, asyncHandler(auth.sendLoginOtp));
router.post('/auth/otp/login', authLimiter, asyncHandler(auth.verifyLoginOtp));
router.post('/auth/otp/send-password-reset', authLimiter, asyncHandler(auth.sendPasswordResetOtp));
router.post('/auth/otp/reset-password', authLimiter, asyncHandler(auth.resetPasswordWithOtp));

// ---------------- Users ----------------
router.get('/users/me', requireAuth, asyncHandler(users.getMe));
router.patch('/users/me', requireAuth, asyncHandler(users.patchMe));
router.post('/users/me/avatar', requireAuth, uploadAvatar, asyncHandler(users.uploadAvatar));
router.delete('/users/me/avatar', requireAuth, asyncHandler(users.deleteAvatar));
router.post('/users/me/banner', requireAuth, uploadBanner, asyncHandler(users.uploadBanner));
router.delete('/users/me/banner', requireAuth, asyncHandler(users.deleteBanner));
router.patch('/users/me/password', requireAuth, authLimiter, asyncHandler(users.patchMyPassword));
router.get('/users/check-username', optionalAuth, asyncHandler(users.checkUsername));
router.get('/users/search', requireAuth, asyncHandler(users.search));
router.patch('/users/pin/:conversationId', requireAuth, asyncHandler(users.togglePin));
router.patch('/users/mute/:conversationId', requireAuth, asyncHandler(users.toggleMute));
router.patch('/users/vibrate/:conversationId', requireAuth, asyncHandler(users.toggleVibrate));

// ---------------- Follow System & Privacy ----------------
router.get('/users/follow-requests/pending', requireAuth, asyncHandler(follow.getPendingRequests));
router.post('/users/follow-requests/:followerId/respond', requireAuth, asyncHandler(follow.respondFollowRequest));
router.post('/users/:id/follow', requireAuth, asyncHandler(follow.followUser));
router.post('/users/:id/unfollow', requireAuth, asyncHandler(follow.unfollowUser));
router.get('/users/:id/followers', requireAuth, asyncHandler(follow.getFollowers));
router.get('/users/:id/following', requireAuth, asyncHandler(follow.getFollowing));
router.get('/users/by-username/:username', requireAuth, asyncHandler(users.getUserByUsername));
router.get('/users/:id', requireAuth, asyncHandler(users.getUser));

// ---------------- Notifications ----------------
router.get('/notifications', requireAuth, apiLimiter, asyncHandler(notifications.list));
router.get('/notifications/unread-count', requireAuth, apiLimiter, asyncHandler(notifications.getUnreadCount));
router.patch('/notifications/:id/read', requireAuth, asyncHandler(notifications.markRead));
router.post('/notifications/read-all', requireAuth, asyncHandler(notifications.markAllRead));
router.delete('/notifications/:id', requireAuth, asyncHandler(notifications.deleteNotification));

// ---------------- Chat Sections (Personal Folders) ----------------
router.get('/chat-sections', requireAuth, asyncHandler(chatSections.listSections));
router.post('/chat-sections', requireAuth, asyncHandler(chatSections.createSection));
router.patch('/chat-sections/:id', requireAuth, asyncHandler(chatSections.renameSection));
router.post('/chat-sections/:id/unlock', requireAuth, asyncHandler(chatSections.unlockSection));
router.post('/chat-sections/:id/lock', requireAuth, asyncHandler(chatSections.setLock));
router.post('/chat-sections/:id/remove-lock', requireAuth, asyncHandler(chatSections.removeLock));
router.delete('/chat-sections/:id', requireAuth, asyncHandler(chatSections.deleteSection));
router.post('/chat-sections/reorder', requireAuth, asyncHandler(chatSections.reorderSections));
router.post('/conversations/:id/move-section', requireAuth, asyncHandler(chatSections.moveConversation));

// ---------------- Conversations ----------------
router.get('/conversations', requireAuth, apiLimiter, asyncHandler(convos.list));
router.get('/conversations/search', requireAuth, asyncHandler(convos.search));
router.get('/conversations/invitations/my', requireAuth, asyncHandler(convos.getMyInvitations));
router.post('/conversations/invitations/:id/respond', requireAuth, asyncHandler(convos.respondInvitation));
router.post('/conversations/upload-avatar', requireAuth, uploadAvatar, asyncHandler(convos.uploadGroupAvatar));
router.post('/conversations/direct', requireAuth, asyncHandler(convos.startDirect));
router.post('/conversations/groups', requireAuth, asyncHandler(convos.createGroup));
router.get('/conversations/:id', requireAuth, apiLimiter, asyncHandler(convos.getOne));
router.patch('/conversations/:id', requireAuth, asyncHandler(convos.patchSettings));
router.patch('/conversations/:id/settings', requireAuth, asyncHandler(convos.patchSettings));
router.get('/conversations/:id/members', requireAuth, asyncHandler(convos.getMembers));
router.patch('/conversations/:id/members/:userId', requireAuth, asyncHandler(convos.updateMemberRole));
router.post('/conversations/:id/members', requireAuth, asyncHandler(convos.addMembers));
router.delete('/conversations/:id/members/:userId', requireAuth, asyncHandler(convos.removeMember));
router.get('/conversations/:id/invitations', requireAuth, asyncHandler(convos.getGroupInvitations));
router.post('/conversations/:id/invitations', requireAuth, asyncHandler(convos.invite));
router.post('/conversations/:id/invitations/:invitationId/respond', requireAuth, asyncHandler(convos.respondInvitation));
router.post('/conversations/:id/pin', requireAuth, asyncHandler(convos.pinConversation));
router.post('/conversations/:id/join', requireAuth, asyncHandler(convos.join));
router.post('/conversations/:id/leave', requireAuth, asyncHandler(convos.leave));
router.delete('/conversations/:id', requireAuth, asyncHandler(convos.remove));
router.post('/conversations/:id/clear', requireAuth, asyncHandler(convos.clearConversation));
router.post('/conversations/:id/delete-chat', requireAuth, asyncHandler(convos.deleteChat));
router.get('/conversations/:id/export', requireAuth, asyncHandler(convos.exportChat));
router.post('/conversations/:conversationId/read', requireAuth, asyncHandler(messages.markRead));
router.post('/conversations/:conversationId/unread', requireAuth, asyncHandler(messages.markUnread));

// ---------------- Messages ----------------
router.get('/messages/:conversationId', requireAuth, apiLimiter, asyncHandler(messages.list));
router.post('/messages/upload-media', requireAuth, uploadMedia, asyncHandler(messages.uploadMedia));
router.post('/messages', requireAuth, apiLimiter, asyncHandler(messages.create));
router.patch('/messages/:id', requireAuth, asyncHandler(messages.edit));
router.delete('/messages/:id', requireAuth, asyncHandler(messages.remove));
router.post('/messages/:id/react', requireAuth, asyncHandler(messages.react));

// ---------------- Admin (requireAuth + requireAdmin on every route) ----------------
const adminRouter = express.Router();
adminRouter.use(requireAuth, requireAdmin);
adminRouter.get('/stats', asyncHandler(admin.stats));
adminRouter.get('/users', asyncHandler(admin.listUsers));
adminRouter.get('/users/:id', asyncHandler(admin.getUser));
adminRouter.patch('/users/:id/status', asyncHandler(admin.patchUserStatus));
adminRouter.patch('/users/:id/role', asyncHandler(admin.patchUserRole));
adminRouter.delete('/users/:id', asyncHandler(admin.deleteUser));
adminRouter.get('/groups', asyncHandler(admin.listGroups));
adminRouter.get('/groups/:id', asyncHandler(admin.getGroup));
adminRouter.delete('/groups/:id', asyncHandler(admin.deleteGroup));
// Privacy enforcement: Platform admins cannot read private messages
adminRouter.get('/messages', (req, res, next) => {
  next(new ApiError(403, 'Platform administrators are prohibited from reading private message content.'));
});
adminRouter.delete('/messages/:id', asyncHandler(admin.deleteMessage));
adminRouter.get('/audit-logs', asyncHandler(admin.listAuditLogs));

router.use('/admin', adminRouter);

module.exports = router;
