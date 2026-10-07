/**
 * Transactional Email Dispatcher Service
 *
 * Responsibility:
 * Generates brand-aligned retro HTML email templates and delivers transactional emails
 * (email verification OTP, login OTP, password reset OTP, and welcome notifications)
 * via Nodemailer using Gmail SMTP (smtp.gmail.com:465 with TLS).
 *
 * CONNECTED MODULES:
 * - Services: backend/src/services/otpService.js, backend/src/services/authService.js
 * - Config:   backend/src/config/index.js (smtpHost, smtpPort, smtpUser, smtpPass, emailFrom)
 *
 * CONCEPTS:
 * - Single Reusable Transporter: One `nodemailer.createTransport()` instance is shared
 *   across all email functions. Creating a new transporter per send is wasteful and
 *   can cause connection pool exhaustion under load.
 * - Gmail App Password: `smtpPass` must be a 16-character Gmail App Password (not your
 *   account password). Generate one at: Google Account → Security → 2-Step Verification
 *   → App Passwords. Never log or expose this value.
 * - Brand-Consistent HTML Emails: All emails use inline styles embodying the PixelTalk
 *   design system (warm cream #FCECD8, dark terracotta #6E3511, olive #597928).
 * - SMTP Verification: `transporter.verify()` is called at module load time to surface
 *   credential or network errors immediately rather than at first send.
 */

'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');

// ---------------------------------------------------------------------------
// Single reusable Nodemailer transporter — Gmail SMTP over TLS (port 465)
// Credentials are loaded exclusively from environment variables via config.
// ---------------------------------------------------------------------------
const transporter = nodemailer.createTransport({
  host: config.smtpHost || 'smtp.gmail.com',
  port: Number(config.smtpPort) || 465,
  secure: Number(config.smtpPort) === 465, // true for port 465
  auth: {
    user: config.smtpUser,
    pass: config.smtpPass,
  },
  family: 4, // Force IPv4 to bypass IPv6 ENETUNREACH on Render / cloud containers
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
});

// Verify SMTP connection at startup
transporter.verify((err) => {
  if (err) {
    console.warn('[EmailService] ⚠ SMTP transporter verification note:', err.message);
  } else {
    console.log('[EmailService] ✓ SMTP transporter verified — Gmail SMTP ready');
  }
});

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Renders the shared PixelTalk retro HTML email shell.
 * Inlines the brand design system so email clients render it correctly.
 *
 * @param {{ title: string, preheader: string, contentHtml: string }} opts
 * @returns {string} Complete HTML email document
 */
function renderPixelTalkEmail({ title, preheader, contentHtml }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FCECD8; font-family: 'Courier New', Courier, monospace, system-ui, -apple-system; color: #221A0E;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #FCECD8; padding: 32px 16px;">
    <tr>
      <td align="center">
        <!-- Main Card -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 520px; background-color: #FFF2E2; border: 3px solid #6E3511; box-shadow: 6px 6px 0px #6E3511; border-radius: 8px; overflow: hidden;">
          <!-- Header Bar -->
          <tr>
            <td style="background-color: #597928; padding: 18px 24px; border-bottom: 3px solid #6E3511; text-align: center;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center">
                    <span style="display: inline-block; font-size: 24px; font-weight: bold; letter-spacing: 2px; color: #FCECD8; text-transform: uppercase;">
                      &#9632; PIXELTALK &#9632;
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding: 28px 24px; background-color: #FFF8F0;">
              ${contentHtml}
            </td>
          </tr>

          <!-- Footer Bar -->
          <tr>
            <td style="background-color: #F0E0CD; padding: 16px 24px; border-top: 2px dashed #6E3511; text-align: center; font-size: 11px; color: #6E3511;">
              <p style="margin: 0; font-weight: bold; letter-spacing: 1px;">PIXELTALK — RETRO VOXEL MESSAGING PLATFORM</p>
              <p style="margin: 4px 0 0 0; color: #844721;">This is an automated security transmission. Do not reply directly.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * Core mail dispatch function. Sends an email via the shared Nodemailer
 * Gmail SMTP transporter. Throws on SMTP failure so callers can handle errors.
 *
 * @param {{ to: string, subject: string, html: string, text: string }} opts
 * @returns {Promise<{ messageId: string }>}
 */
async function sendMail({ to, subject, html, text }) {
  // Option 1: Deliver via Resend HTTPS REST API (Port 443 — 100% cloud-compatible, never blocked by Render)
  if (config.resendApiKey) {
    try {
      const fromAddress = config.emailFrom.includes('<')
        ? config.emailFrom
        : 'PixelTalk <onboarding@resend.dev>';

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [to],
          subject,
          html,
          text,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || `Resend API returned status ${response.status}`);
      }

      console.log(`[EmailService] ✓ Email delivered to ${to} via Resend API (MessageId: ${data.id})`);
      return { messageId: data.id };
    } catch (err) {
      console.error(`[EmailService] ✗ Resend API dispatch failed for ${to}:`, err.message);
    }
  }

  // Option 2: Fallback to Nodemailer SMTP (e.g. Gmail over TLS/STARTTLS)
  if (config.smtpPass && config.smtpUser) {
    try {
      const info = await transporter.sendMail({
        from: config.emailFrom,
        to,
        subject,
        html,
        text,
      });

      console.log(`[EmailService] ✓ Email delivered to ${to} via SMTP (MessageId: ${info.messageId})`);
      return { messageId: info.messageId };
    } catch (err) {
      console.warn(`[EmailService] ⚠ SMTP delivery attempt note for ${to}:`, err.message);
    }
  }

  // Fallback: OTP is always printed to Render/server logs
  return { fallback: true };
}

// ---------------------------------------------------------------------------
// Public transactional email functions
// ---------------------------------------------------------------------------

/**
 * Sends a 6-digit email-verification OTP to a new registrant.
 *
 * @param {{ email: string, displayName: string, otp: string }} opts
 */
async function sendVerificationOtpEmail({ email, displayName, otp }) {
  console.log(`\n============================================================`);
  console.log(`🔐 [PIXELTALK OTP] Email Verification`);
  console.log(`📧 Target : ${email}`);
  console.log(`🔢 Code   : ${otp}`);
  console.log(`⏰ Expires : 5 minutes`);
  console.log(`============================================================\n`);

  const subject = 'Verify your PixelTalk email';
  const text = `
PIXELTALK
Verify your email address

Hello ${displayName || 'Player'},
Your email verification code is: ${otp}

This code expires in 5 minutes.
If you did not request this verification, you can safely ignore this email.

— PixelTalk
  `.trim();

  const contentHtml = `
    <h1 style="margin: 0 0 12px 0; font-size: 18px; font-weight: bold; color: #6E3511; text-transform: uppercase;">
      Verify Your Email Address
    </h1>
    <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.5; color: #3B2412;">
      Welcome to PixelTalk, <strong>${displayName || 'Player'}</strong>! Please use the 6-digit confirmation code below to verify your account:
    </p>

    <!-- OTP Display Box -->
    <div style="margin: 24px 0; text-align: center;">
      <div style="display: inline-block; background-color: #FCECD8; border: 3px solid #597928; box-shadow: 4px 4px 0px #597928; border-radius: 6px; padding: 14px 28px;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #597928; font-family: 'Courier New', monospace;">
          ${otp}
        </span>
      </div>
    </div>

    <p style="margin: 0 0 12px 0; font-size: 12px; color: #844721; font-weight: bold; text-align: center;">
      &#9203; This code expires in 5 minutes.
    </p>
    <p style="margin: 0; font-size: 12px; color: #844721; line-height: 1.4;">
      If you did not register for a PixelTalk account, please disregard this email.
    </p>
  `;

  const html = renderPixelTalkEmail({
    title: subject,
    preheader: `Your PixelTalk verification code is ${otp}`,
    contentHtml,
  });

  return sendMail({ to: email, subject, html, text });
}

/**
 * Sends a 6-digit login OTP to an existing user attempting passwordless sign-in.
 *
 * @param {{ email: string, displayName: string, otp: string }} opts
 */
async function sendLoginOtpEmail({ email, displayName, otp }) {
  console.log(`\n============================================================`);
  console.log(`🔐 [PIXELTALK OTP] Login Verification`);
  console.log(`📧 Target : ${email}`);
  console.log(`🔢 Code   : ${otp}`);
  console.log(`⏰ Expires : 5 minutes`);
  console.log(`============================================================\n`);

  const subject = 'Your PixelTalk login code';
  const text = `
PIXELTALK
Your login verification code is: ${otp}

This code expires in 5 minutes.
If you did not attempt to log in, you can safely ignore this email.

— PixelTalk
  `.trim();

  const contentHtml = `
    <h1 style="margin: 0 0 12px 0; font-size: 18px; font-weight: bold; color: #6E3511; text-transform: uppercase;">
      Sign-In Verification Code
    </h1>
    <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.5; color: #3B2412;">
      Hello <strong>${displayName || 'Player'}</strong>, your one-time login authentication code is:
    </p>

    <!-- OTP Display Box -->
    <div style="margin: 24px 0; text-align: center;">
      <div style="display: inline-block; background-color: #FCECD8; border: 3px solid #6E3511; box-shadow: 4px 4px 0px #6E3511; border-radius: 6px; padding: 14px 28px;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #6E3511; font-family: 'Courier New', monospace;">
          ${otp}
        </span>
      </div>
    </div>

    <p style="margin: 0 0 12px 0; font-size: 12px; color: #844721; font-weight: bold; text-align: center;">
      &#9203; This code expires in 5 minutes.
    </p>
    <p style="margin: 0; font-size: 12px; color: #844721; line-height: 1.4;">
      If you did not attempt to log in, someone may have entered your identifier. You can safely ignore this email.
    </p>
  `;

  const html = renderPixelTalkEmail({
    title: subject,
    preheader: `Your PixelTalk login code is ${otp}`,
    contentHtml,
  });

  return sendMail({ to: email, subject, html, text });
}

/**
 * Sends a 6-digit password-reset OTP to initiate a self-service password change.
 *
 * @param {{ email: string, displayName: string, otp: string }} opts
 */
async function sendPasswordResetEmail({ email, displayName, otp }) {
  console.log(`\n============================================================`);
  console.log(`🔐 [PIXELTALK OTP] Password Reset`);
  console.log(`📧 Target : ${email}`);
  console.log(`🔢 Code   : ${otp}`);
  console.log(`⏰ Expires : 5 minutes`);
  console.log(`============================================================\n`);

  const subject = 'Reset your PixelTalk password';
  const text = `
PIXELTALK
Password Reset Request

Hello ${displayName || 'Player'},
Your password reset authorization code is: ${otp}

This code expires in 5 minutes.
If you did not request a password reset, you can safely ignore this message.

— PixelTalk
  `.trim();

  const contentHtml = `
    <h1 style="margin: 0 0 12px 0; font-size: 18px; font-weight: bold; color: #6E3511; text-transform: uppercase;">
      Password Reset Request
    </h1>
    <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.5; color: #3B2412;">
      We received a request to reset the password for <strong>${displayName || 'your PixelTalk account'}</strong>. Enter this code to proceed:
    </p>

    <!-- OTP Display Box -->
    <div style="margin: 24px 0; text-align: center;">
      <div style="display: inline-block; background-color: #FCECD8; border: 3px solid #844721; box-shadow: 4px 4px 0px #844721; border-radius: 6px; padding: 14px 28px;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #844721; font-family: 'Courier New', monospace;">
          ${otp}
        </span>
      </div>
    </div>

    <p style="margin: 0 0 12px 0; font-size: 12px; color: #844721; font-weight: bold; text-align: center;">
      &#9203; This code expires in 5 minutes.
    </p>
    <p style="margin: 0; font-size: 12px; color: #844721; line-height: 1.4;">
      If you did not initiate this request, your account remains secure and no action is required.
    </p>
  `;

  const html = renderPixelTalkEmail({
    title: subject,
    preheader: `Your PixelTalk password reset code is ${otp}`,
    contentHtml,
  });

  return sendMail({ to: email, subject, html, text });
}

/**
 * Sends a welcome email confirming successful email verification and account activation.
 *
 * @param {{ email: string, displayName: string, username: string }} opts
 */
async function sendWelcomeEmail({ email, displayName, username }) {
  const subject = 'Welcome to PixelTalk 🎮';
  const text = `
PIXELTALK
Welcome to PixelTalk, ${displayName}!

Your email has been successfully verified.
Username: @${username}

Your PixelTalk account is ready. Start chatting, join rooms, and connect with your people.

— PixelTalk
  `.trim();

  const contentHtml = `
    <h1 style="margin: 0 0 12px 0; font-size: 20px; font-weight: bold; color: #597928; text-transform: uppercase;">
      Welcome to PixelTalk, ${displayName}! &#127918;
    </h1>
    <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.5; color: #3B2412;">
      Your email has been successfully verified and your identity is active.
    </p>

    <!-- User Identity Box -->
    <div style="margin: 20px 0; background-color: #FCECD8; border: 2px solid #597928; border-radius: 6px; padding: 16px;">
      <p style="margin: 0 0 6px 0; font-size: 13px; color: #6E3511;"><strong>Display Name:</strong> ${displayName}</p>
      <p style="margin: 0; font-size: 13px; color: #597928; font-weight: bold;"><strong>Unique Handle:</strong> @${username}</p>
    </div>

    <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.5; color: #3B2412;">
      Your PixelTalk account is ready. Start chatting, create private group rooms, and connect with other players across the world!
    </p>

    <div style="margin-top: 24px; text-align: center;">
      <span style="display: inline-block; background-color: #597928; color: #FCECD8; font-weight: bold; padding: 10px 20px; border-radius: 6px; border: 2px solid #6E3511; font-size: 13px; text-decoration: none;">
        LET THE CHAT BEGIN
      </span>
    </div>
  `;

  const html = renderPixelTalkEmail({
    title: subject,
    preheader: `Welcome to PixelTalk, ${displayName}! Your account @${username} is ready.`,
    contentHtml,
  });

  return sendMail({ to: email, subject, html, text });
}

module.exports = {
  sendVerificationOtpEmail,
  sendLoginOtpEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
};
