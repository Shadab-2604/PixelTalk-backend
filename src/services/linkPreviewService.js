/**
 * Link Preview Service (Secure OpenGraph & HTML Metadata Extractor)
 *
 * Responsibility:
 * Safely fetches metadata (title, description, image, domain) for HTTP/HTTPS links
 * embedded in user chat messages while protecting against SSRF, internal network leaks,
 * and malicious protocol execution.
 *
 * CONNECTED MODULES:
 * - Services: backend/src/services/messageService.js
 * - Models: backend/src/models/Message.js
 * - Controllers: backend/src/controllers/messageController.js
 *
 * SECURITY GUARANTEES:
 * - Strict Protocol Enforcement: Accepts only http: and https: schemes.
 * - Anti-SSRF Guard: Rejects loopback (127.0.0.1, localhost), private IP subnets
 *   (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.169.254), and local TLDs.
 * - Resource Capping: Hard 3.5s HTTP timeout and 500KB response body ceiling.
 * - Non-Blocking: Failures safely resolve to null without impeding message transmission.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function isPrivateHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return true;
  const h = hostname.toLowerCase().trim();

  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h === '169.254.169.254') {
    return true;
  }
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.localhost')) {
    return true;
  }

  // IPv4 private ranges check
  const ipParts = h.split('.').map((p) => Number.parseInt(p, 10));
  if (ipParts.length === 4 && !ipParts.some(Number.isNaN)) {
    const [a, b] = ipParts;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
  }

  return false;
}

function extractMetaTag(html, propertyOrName) {
  const rx = new RegExp(`<meta\\s+(?:property|name)=["']${propertyOrName}["']\\s+content=["']([^"']+)["']`, 'i');
  let match = html.match(rx);
  if (match && match[1]) return match[1].trim();

  // Try reverse attribute ordering: content="..." property="..."
  const rxRev = new RegExp(`<meta\\s+content=["']([^"']+)["']\\s+(?:property|name)=["']${propertyOrName}["']`, 'i');
  match = html.match(rxRev);
  if (match && match[1]) return match[1].trim();

  return '';
}

function extractTitle(html) {
  const ogTitle = extractMetaTag(html, 'og:title') || extractMetaTag(html, 'twitter:title');
  if (ogTitle) return ogTitle;
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match && match[1] ? match[1].trim() : '';
}

function extractDescription(html) {
  return (
    extractMetaTag(html, 'og:description') ||
    extractMetaTag(html, 'description') ||
    extractMetaTag(html, 'twitter:description') ||
    ''
  );
}

function extractImage(html, baseUrl) {
  let img = extractMetaTag(html, 'og:image') || extractMetaTag(html, 'twitter:image');
  if (!img) {
    const iconMatch = html.match(/<link\s+[^>]*rel=["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]*href=["']([^"']+)["']/i);
    if (iconMatch && iconMatch[1]) img = iconMatch[1];
  }
  if (!img) return '';

  try {
    return new URL(img, baseUrl).href;
  } catch {
    return img.startsWith('http') ? img : '';
  }
}

async function fetchPreview(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  const cleanUrl = urlStr.trim();

  let parsed;
  try {
    parsed = new URL(cleanUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  if (isPrivateHost(parsed.hostname)) {
    return null;
  }

  return new Promise((resolve) => {
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(
      cleanUrl,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PixelTalkBot/1.0',
          Accept: 'text/html,application/xhtml+xml',
        },
        timeout: 3500,
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 400) {
          res.resume();
          return resolve(null);
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 500000) {
            // Cap body reading at 500KB
            res.destroy();
          }
        });
        res.on('end', () => {
          try {
            const title = extractTitle(body);
            const description = extractDescription(body);
            const image = extractImage(body, cleanUrl);
            const domain = parsed.hostname.replace(/^www\./, '');

            if (!title && !description && !image) {
              return resolve(null);
            }

            resolve({
              url: cleanUrl,
              title: title.slice(0, 150),
              description: description.slice(0, 300),
              image,
              domain,
            });
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

module.exports = {
  fetchPreview,
  isPrivateHost,
};
