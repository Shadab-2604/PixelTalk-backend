/**
 * Transactional Email Dispatcher Service
 *
 * Responsibility:
 * Generates brand-aligned retro HTML email templates and delivers transactional emails
 * (email verification OTP, login OTP, password reset OTP, and welcome notifications)
 * via the Brevo HTTPS REST API (api.brevo.com/v3/smtp/email).
 *
 * CONNECTED MODULES:
 * - Services: backend/src/services/otpService.js, backend/src/services/authService.js
 * - Config:   backend/src/config/index.js (brevoApiKey, emailFrom)
 *
 * CONCEPTS:
 * - Cloud-Native HTTPS API: Uses port 443 (HTTPS REST API via fetch), bypassing all outbound
 *   SMTP port restrictions on cloud hosting platforms like Render.
 * - Zero-Dependency: No SMTP transporter or heavy nodemailer library required.
 * - Always-Visible OTP Fallback: Every generated OTP is logged directly to the server
 *   console so development and testing can proceed seamlessly even without an API key.
 * - Brand-Consistent HTML Emails: All templates use inline styles embodying the PixelTalk
 *   design system (warm cream #FCECD8, dark terracotta #6E3511, olive #597928).
 */

'use strict';

const config = require('../config');

/**
 * Parses a "Name <email@domain.com>" or "email@domain.com" string into Brevo sender object.
 *
 * @param {string} fromStr
 * @returns {{ name: string, email: string }}
 */
function parseSender(fromStr) {
  if (!fromStr) {
    return { name: 'PixelTalk', email: 'skgamerpro123@gmail.com' };
  }
  const match = fromStr.match(/^(.*?)\s*<(.+?)>$/);
  if (match) {
    return {
      name: match[1].trim() || 'PixelTalk',
      email: match[2].trim(),
    };
  }
  return {
    name: 'PixelTalk',
    email: fromStr.trim(),
  };
}

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
 * Core mail dispatch function using Brevo (Sendinblue) Transactional REST API.
 * Uses HTTPS port 443 — guaranteed to work in cloud container environments.
 *
 * @param {{ to: string, recipientName?: string, subject: string, html: string, text: string }} opts
 * @returns {Promise<{ messageId?: string, fallback?: boolean }>}
 */
async function sendMail({ to, recipientName = 'Player', subject, html, text }) {
  if (config.brevoApiKey) {
    try {
      const sender = parseSender(config.emailFrom);

      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': config.brevoApiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          sender: {
            name: sender.name,
            email: sender.email,
          },
          to: [
            {
              email: to,
              name: recipientName || 'Player',
            },
          ],
          subject,
          htmlContent: html,
          textContent: text,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        console.error(`[EmailService] ✗ Brevo API error (${response.status}):`, data.message || data);
      } else {
        const messageId = data.messageId || 'sent';
        console.log(`[EmailService] ✓ Email delivered to ${to} via Brevo API (MessageId: ${messageId})`);
        return { messageId };
      }
    } catch (err) {
      console.error(`[EmailService] ✗ Brevo API dispatch exception for ${to}:`, err.message);
    }
  } else {
    console.warn(`[EmailService] ⚠ BREVO_API_KEY is not set. Email delivery skipped; code is logged above.`);
  }

  // Fallback: OTP is always logged to the server terminal
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

  return sendMail({ to: email, recipientName: displayName, subject, html, text });
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

  return sendMail({ to: email, recipientName: displayName, subject, html, text });
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

  return sendMail({ to: email, recipientName: displayName, subject, html, text });
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

  return sendMail({ to: email, recipientName: displayName, subject, html, text });
}

module.exports = {
  sendVerificationOtpEmail,
  sendLoginOtpEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
};
