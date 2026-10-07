/**
 * Cloudinary Media Storage Service
 *
 * Responsibility:
 * Provides centralized media asset management for PixelTalk. Handles uploading file buffers
 * to Cloudinary CDN, generating secure HTTPS URLs, assigning structured folder hierarchies,
 * and deleting obsolete assets when user profile images or banners are updated or removed.
 *
 * CONNECTED MODULES:
 * - Config: backend/src/config/index.js (Reads Cloudinary credentials safely from environment)
 * - Services: backend/src/services/userService.js
 * - Controllers: backend/src/controllers/userController.js
 *
 * CONCEPTS & SECURITY:
 * - Zero Secret Leakage: Cloudinary API secret is held strictly server-side in backend memory.
 * - Streamed Buffer Upload: Uploads raw file buffer directly from Multer memory storage
 *   to Cloudinary via upload_stream to avoid disk writes.
 * - Managed Asset Destruction: Old Cloudinary assets are deleted asynchronously upon profile image
 *   replacement or removal to prevent storage leakages.
 */

const cloudinary = require('cloudinary').v2;
const config = require('../config');
const { ApiError } = require('../utils/apiResponse');

// Configure Cloudinary SDK using credentials loaded strictly from backend/.env
cloudinary.config({
  cloud_name: config.cloudinaryCloudName,
  api_key: config.cloudinaryApiKey,
  api_secret: config.cloudinaryApiSecret,
  secure: true,
});

/**
 * Upload a raw file buffer to Cloudinary within a specified folder.
 *
 * @param {Buffer} buffer - Raw file buffer from Multer memory storage
 * @param {string} folder - Target Cloudinary folder (e.g. 'pixeltalk/profiles' or 'pixeltalk/banners')
 * @returns {Promise<{ secure_url: string, public_id: string }>} Upload result containing URL and asset public_id
 */
async function uploadImageBuffer(buffer, folder) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new ApiError(400, 'Invalid image buffer provided for upload.');
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
      },
      (error, result) => {
        if (error) {
          console.error('[Cloudinary] Upload stream error:', error.message || error);
          return reject(new ApiError(500, 'Failed to upload image to cloud storage.'));
        }
        if (!result || !result.secure_url) {
          return reject(new ApiError(500, 'Cloud storage returned incomplete response.'));
        }
        resolve({
          secure_url: result.secure_url,
          public_id: result.public_id,
        });
      },
    );

    uploadStream.end(buffer);
  });
}

/**
 * Upload a raw file buffer to Cloudinary within a specified folder for media messages.
 * Supports image, video, audio, and raw document formats.
 *
 * @param {Buffer} buffer - Raw file buffer from Multer memory storage
 * @param {string} folder - Target Cloudinary folder (e.g. 'pixeltalk/chat_media')
 * @param {string} resourceType - Cloudinary resource type: 'image' | 'video' | 'raw' | 'auto'
 * @param {string} fileName - Original file name
 * @returns {Promise<{ secure_url: string, public_id: string, resource_type: string, format: string, bytes: number, duration: number }>}
 */
async function uploadMediaBuffer(buffer, folder = 'pixeltalk/chat_media', resourceType = 'auto', fileName = 'upload') {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new ApiError(400, 'Invalid file buffer provided for media upload.');
  }

  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder,
      resource_type: resourceType,
      use_filename: true,
      unique_filename: true,
    };

    const uploadStream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error) {
        console.error('[Cloudinary] Media upload stream error:', error.message || error);
        return reject(new ApiError(500, `Failed to upload media to cloud storage: ${error.message || 'Error'}`));
      }
      if (!result || !result.secure_url) {
        return reject(new ApiError(500, 'Cloud storage returned incomplete media response.'));
      }

      resolve({
        secure_url: result.secure_url,
        public_id: result.public_id,
        resource_type: result.resource_type || resourceType,
        format: result.format || '',
        bytes: result.bytes || buffer.length,
        duration: result.duration || 0,
      });
    });

    uploadStream.end(buffer);
  });
}

/**
 * Safely delete an existing asset from Cloudinary by its public ID.
 *
 * @param {string} publicId - Cloudinary asset public ID (e.g. 'pixeltalk/profiles/sample')
 * @param {string} resourceType - Asset resource type ('image' | 'video' | 'raw')
 * @returns {Promise<boolean>} True if deletion succeeded or skipped safely
 */
async function deleteImage(publicId, resourceType = 'image') {
  if (!publicId || typeof publicId !== 'string') return false;

  try {
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    return result.result === 'ok';
  } catch (err) {
    // Log error but do not fail parent flow if old image cleanup encounters a network blip
    console.warn(`[Cloudinary] Could not delete old asset ${publicId}:`, err.message || err);
    return false;
  }
}

module.exports = {
  uploadImageBuffer,
  uploadMediaBuffer,
  deleteImage,
};
