/**
 * File Upload Middleware (Multer Memory Storage + Validation)
 *
 * Responsibility:
 * Intercepts multipart/form-data requests, enforces MIME-type filtering (JPG, JPEG, PNG, WEBP),
 * enforces file size constraints (max 25MB), and loads file data into `req.file.buffer`.
 *
 * CONNECTED MODULES:
 * - Config: backend/src/config/index.js (maxFileSizeMb)
 * - Routes: backend/src/routes/index.js
 * - Controllers: backend/src/controllers/userController.js
 *
 * CONCEPT & SECURITY:
 * - Memory Storage: Files are buffered strictly in RAM; no persistent temporary files on disk.
 * - Strict MIME & Extension Verification: Prevents executable files or arbitrary uploads.
 * - Centralized Express Error Handling: Catches file size errors and formats clean JSON error envelopes.
 */

const multer = require('multer');
const config = require('../config');
const { ApiError } = require('../utils/apiResponse');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const DANGEROUS_EXTENSIONS = ['.exe', '.sh', '.bat', '.cmd', '.dll', '.js', '.msi', '.vbs', '.ps1', '.scr', '.jar', '.com', '.pif', '.app', '.html', '.htm', '.svg', '.php'];

const MAX_SIZE_BYTES = (config.maxFileSizeMb || 25) * 1024 * 1024; // 25 MB

const storage = multer.memoryStorage();

/**
 * Validates the initial bytes (magic numbers) of a file buffer
 * to ensure that the file payload is genuinely an image (JPEG, PNG, GIF, WEBP).
 * @param {Buffer} buffer
 * @returns {boolean} True if buffer matches supported image magic bytes.
 */
function isValidImageMagicBytes(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 12) {
    return false;
  }

  // JPEG: 0xFF 0xD8 0xFF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }

  // PNG: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return true;
  }

  // GIF: 'GIF87a' (0x47 0x49 0x46 0x38 0x37 0x61) or 'GIF89a' (0x47 0x49 0x46 0x38 0x39 0x61)
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return true;
  }

  // WEBP: 'RIFF' at 0..3 and 'WEBP' at 8..11
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return true;
  }

  return false;
}

const profileFileFilter = (req, file, cb) => {
  if (!file || !file.mimetype) {
    return cb(new ApiError(400, 'No file uploaded or file format missing.'));
  }

  const mime = file.mimetype.toLowerCase();
  const name = (file.originalname || '').toLowerCase();
  const hasDangerousExt = DANGEROUS_EXTENSIONS.some((ext) => name.endsWith(ext));

  if (hasDangerousExt || !ALLOWED_MIME_TYPES.includes(mime)) {
    return cb(new ApiError(400, 'Invalid file type. Only JPG, JPEG, PNG, and WEBP images are allowed.'));
  }

  cb(null, true);
};

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];

const mediaFileFilter = (req, file, cb) => {
  if (!file || !file.mimetype) {
    return cb(new ApiError(400, 'No file uploaded or file metadata missing.'));
  }

  const mime = file.mimetype.toLowerCase();
  const name = (file.originalname || '').toLowerCase();
  const hasDangerousExt = DANGEROUS_EXTENSIONS.some((ext) => name.endsWith(ext));

  if (hasDangerousExt || !ALLOWED_IMAGE_MIME_TYPES.includes(mime)) {
    return cb(new ApiError(400, 'Invalid file type. Only JPG, JPEG, PNG, WEBP, and GIF images are allowed.'));
  }

  cb(null, true);
};

const profileUpload = multer({
  storage,
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: profileFileFilter,
});

const mediaUpload = multer({
  storage,
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: mediaFileFilter,
});

/**
 * Single file upload middleware wrapper with error handling for Multer errors (e.g. LIMIT_FILE_SIZE)
 * and deep inspection of file payload magic bytes.
 */
function handleSingleUpload(uploader, fieldName) {
  return (req, res, next) => {
    uploader.single(fieldName)(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return next(new ApiError(400, `File size exceeds the maximum limit of ${config.maxFileSizeMb || 25}MB.`));
          }
          return next(new ApiError(400, `File upload error: ${err.message}`));
        }
        return next(err);
      }
      if (!req.file) {
        return next(new ApiError(400, 'Please select a file to upload.'));
      }

      // Deep inspection: verify file buffer signature (magic bytes)
      if (!isValidImageMagicBytes(req.file.buffer)) {
        return next(new ApiError(400, 'Invalid or corrupted image file content. File signature does not match expected image format.'));
      }

      next();
    });
  };
}

module.exports = {
  isValidImageMagicBytes,
  uploadAvatar: handleSingleUpload(profileUpload, 'avatar'),
  uploadBanner: handleSingleUpload(profileUpload, 'banner'),
  uploadMedia: handleSingleUpload(mediaUpload, 'file'),
};
