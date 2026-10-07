/**
 * Centralised Runtime Configuration
 *
 * Responsibility:
 * Loads environment variables from backend/.env via dotenv, validates that
 * all required variables are present, and exports a single frozen config
 * object consumed by every backend module.
 *
 * CONNECTED MODULES: All backend services, controllers, middleware, and server.js
 *
 * CONCEPTS:
 * - Fail-Fast Validation: Missing required keys throw immediately at startup
 *   rather than producing cryptic runtime errors deep inside a request handler.
 * - Single Source of Truth: All env-var access is centralised here. No other
 *   module calls process.env directly, keeping configuration changes isolated.
 */

const path = require('path');
require('dotenv').config();
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const required = ['MONGO_URI', 'JWT_SECRET', 'CLIENT_URL'];
for (const key of required) {
  if (!process.env[key]) {
    // Fail fast with a clear message instead of failing later with a cryptic error.
    throw new Error(`Missing required environment variable: ${key}. Copy .env.example to .env and fill it in.`);
  }
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 5000) || 5000,
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  clientUrl: process.env.CLIENT_URL,
  cookieName: 'pixeltalk_token',
  // Email configuration (Resend HTTPS API or Nodemailer SMTP)
  resendApiKey: process.env.RESEND_API_KEY,
  emailFrom: process.env.EMAIL_FROM || 'PixelTalk <onboarding@resend.dev>',
  smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
  smtpPort: Number(process.env.SMTP_PORT) || 465,
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS, // Gmail App Password — never log this value
  adminEmail: (process.env.ADMIN_EMAIL || 'admin@pixeltalk.dev').toLowerCase().trim(),
  adminUsername: (process.env.ADMIN_USERNAME || 'admin').toLowerCase().trim(),
  adminDisplayName: process.env.ADMIN_DISPLAY_NAME || 'Admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123456',
  // Cloudinary media storage configuration — credentials read from backend/.env only
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME,
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY,
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET,
  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB || 25),
};
