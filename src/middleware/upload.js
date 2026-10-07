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
const DANGEROUS_EXTENSIONS = ['.exe', '.sh', '.bat', '.cmd', '.dll', '.js', '.msi', '.vbs', '.ps1', '.scr', '.jar', '.com', '.pif', '.app'];

const MAX_SIZE_BYTES = (config.maxFileSizeMb || 25) * 1024 * 1024; // 25 MB

const storage = multer.memoryStorage();

const profileFileFilter = (req, file, cb) => {
  if (!file || !file.mimetype) {
    return cb(new ApiError(400, 'No file uploaded or file format missing.'));
  }

  const mime = file.mimetype.toLowerCase();
  if (ALLOWED_MIME_TYPES.includes(mime)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, 'Invalid file type. Only JPG, JPEG, PNG, and WEBP images are allowed.'));
  }
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
      next();
    });
  };
}

module.exports = {
  uploadAvatar: handleSingleUpload(profileUpload, 'avatar'),
  uploadBanner: handleSingleUpload(profileUpload, 'banner'),
  uploadMedia: handleSingleUpload(mediaUpload, 'file'),
};
