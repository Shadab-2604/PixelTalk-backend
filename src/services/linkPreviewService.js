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
const dns = require('dns');
const { URL } = require('url');

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254',
  'metadata.google.internal',
  'instance-data',
]);

/**
 * Validates whether an IP address (IPv4 or IPv6) is private, loopback, link-local, or reserved.
 * @param {string} ip
 * @returns {boolean} True if IP is private/reserved, false otherwise.
 */
function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const cleanIp = ip.trim().toLowerCase();

  // IPv4-mapped IPv6 check (e.g. ::ffff:127.0.0.1)
  if (cleanIp.startsWith('::ffff:')) {
    const mappedIpv4 = cleanIp.slice(7);
    return isPrivateIp(mappedIpv4);
  }

  // IPv6 checks
  if (cleanIp.includes(':')) {
    if (cleanIp === '::' || cleanIp === '::1') return true;
    if (cleanIp.startsWith('fc') || cleanIp.startsWith('fd')) return true; // Unique Local Address (ULA) fc00::/7
    if (cleanIp.startsWith('fe80:')) return true; // Link-local fe80::/10
    if (cleanIp.startsWith('ff')) return true; // Multicast ff00::/8
    if (cleanIp.startsWith('2001:db8:')) return true; // Documentation
    return false;
  }

  // IPv4 checks
  const parts = cleanIp.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    return true;
  }

  const [a, b, c, d] = parts;
  if (a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255 || d < 0 || d > 255) {
    return true;
  }

  if (a === 0) return true; // 0.0.0.0/8 (Current network)
  if (a === 10) return true; // 10.0.0.0/8 (Private)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (Carrier-grade NAT)
  if (a === 127) return true; // 127.0.0.0/8 (Loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-local / Cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (Private)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (Private)
  if (a === 198 && b >= 18 && b <= 19) return true; // 198.18.0.0/15 (Network benchmark tests)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 (Multicast)
  if (a >= 240) return true; // 240.0.0.0/4 (Reserved)

  return false;
}

/**
 * Checks if a hostname or IP string resolves to a private or restricted destination.
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return true;
  const h = hostname.toLowerCase().trim();

  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.localhost')) {
    return true;
  }

  return isPrivateIp(h);
}

/**
 * Asynchronously verifies DNS records for a given hostname to guarantee
 * that none of the resolved A/AAAA records point to private or reserved subnets.
 * @param {string} hostname
 * @returns {Promise<boolean>} Resolves to true if safe, false if blocked.
 */
async function isSafeDestination(hostname) {
  if (isPrivateHost(hostname)) return false;

  try {
    const addresses = await dns.promises.lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) return false;

    for (const record of addresses) {
      if (isPrivateIp(record.address)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
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

async function fetchPreview(urlStr, redirectCount = 0) {
  if (!urlStr || typeof urlStr !== 'string' || redirectCount > 3) return null;
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

  const isSafe = await isSafeDestination(parsed.hostname);
  if (!isSafe) {
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
      async (res) => {
        // Handle safe redirects (301, 302, 303, 307, 308)
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          try {
            const nextUrl = new URL(res.headers.location, cleanUrl).href;
            const redirectedPreview = await fetchPreview(nextUrl, redirectCount + 1);
            return resolve(redirectedPreview);
          } catch {
            return resolve(null);
          }
        }

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
  isPrivateIp,
  isSafeDestination,
};
