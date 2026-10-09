/*
 * ============================================================
 * PIXELTALK — DATABASE MODEL: MESSAGE (Message.js)
 * ============================================================
 *
 * WHAT DATA IS STORED?
 * Stores individual chat message documents sent within conversations:
 * - Text content & OpenGraph link preview metadata (`url`, `title`, `description`, `image`, `domain`).
 * - Cloudinary uploaded image details (`url`, `publicId`, `fileName`, `size`, `mimeType`).
 * - Quoted reply references (`replyTo`).
 * - Message delivery & read tick status (`deliveredTo`, `readBy`, `status`: `'sent'|'delivered'|'read'`).
 * - Edit history flags (`edited`, `editedAt`) and soft-delete timestamp (`deletedAt`).
 *
 * WHY IS IT STORED?
 * To persist chat history, render historical messages during pagination, display status ticks (✓ / ✓✓),
 * link preview cards, and maintain an immutable record of player communication.
 *
 * COLLECTION RELATIONSHIPS:
 * Message
 *  ├── conversationId ──► References [Conversation]
 *  ├── senderId       ──► References [User]
 *  ├── replyTo        ──► References parent [Message] (for quoted replies)
 *  ├── deliveredTo    ──► References array of [User]
 *  └── readBy         ──► References array of [User]
 *
 * INDEXES & PERFORMANCE:
 * - `{ conversationId: 1, createdAt: -1 }`: Fast index powering cursor-based message pagination.
 *   Enables instantaneous history loading for active chat rooms regardless of collection size.
 * ============================================================
 */

const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, trim: true, maxlength: 2000, default: '' },
    messageType: {
      type: String,
      enum: ['text', 'image', 'video', 'audio', 'file', 'system'],
      default: 'text',
    },
    systemEvent: {
      eventType: {
        type: String,
        enum: ['member_joined', 'member_left', 'room_created'],
        default: null,
      },
      actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      actorUsername: { type: String, default: '' },
    },
    media: {
      url: { type: String, default: '' },
      publicId: { type: String, default: '' },
      type: { type: String, enum: ['image', 'video', 'audio', 'file'] },
      mimeType: { type: String, default: '' },
      fileName: { type: String, default: '' },
      size: { type: Number, default: 0 },
      duration: { type: Number, default: 0 },
    },
    linkPreview: {
      url: { type: String, default: '' },
      title: { type: String, default: '' },
      description: { type: String, default: '' },
      image: { type: String, default: '' },
      domain: { type: String, default: '' },
    },
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    reactions: [
      {
        emoji: { type: String, required: true, trim: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    edited: { type: Boolean, default: false },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    deliveredTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  },
  { timestamps: true },
);

messageSchema.index({ conversationId: 1, createdAt: -1, _id: -1 });
messageSchema.index({ senderId: 1 });
messageSchema.index({ replyTo: 1 });

messageSchema.set('toJSON', {
  virtuals: true,
  transform(doc, ret) {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Message', messageSchema);
