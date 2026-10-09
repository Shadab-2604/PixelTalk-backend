/**
 * Security Hardening Automated Test Suite (securityHardening.test.js)
 *
 * Verifies critical security controls:
 * 1. SSRF Prevention (link preview private host & DNS check)
 * 2. Upload Magic Byte / Signature Validation
 * 3. JWT Algorithm Enforcement (HS256)
 * 4. NoSQL Operator & Prototype Pollution Sanitization
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateHost, isPrivateIp, fetchPreview } = require('../services/linkPreviewService');
const { isValidImageMagicBytes } = require('../middleware/upload');
const { sanitizeInput } = require('../middleware/sanitize');
const authService = require('../services/authService');
const jwt = require('jsonwebtoken');

describe('Security Hardening Test Suite', () => {
  describe('1. SSRF Prevention & Link Preview Hardening', () => {
    test('identifies loopback, private IPv4, and metadata IPs as private', () => {
      assert.equal(isPrivateIp('127.0.0.1'), true);
      assert.equal(isPrivateIp('10.0.0.1'), true);
      assert.equal(isPrivateIp('172.16.0.5'), true);
      assert.equal(isPrivateIp('192.168.1.1'), true);
      assert.equal(isPrivateIp('169.254.169.254'), true);
      assert.equal(isPrivateIp('0.0.0.0'), true);
    });

    test('identifies loopback and local IPv6 addresses as private', () => {
      assert.equal(isPrivateIp('::1'), true);
      assert.equal(isPrivateIp('::'), true);
      assert.equal(isPrivateIp('fe80::1'), true);
      assert.equal(isPrivateIp('fc00::1'), true);
      assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
    });

    test('allows legitimate public IP addresses', () => {
      assert.equal(isPrivateIp('8.8.8.8'), false);
      assert.equal(isPrivateIp('1.1.1.1'), false);
      assert.equal(isPrivateIp('142.250.190.46'), false);
    });

    test('identifies internal and local hostnames', () => {
      assert.equal(isPrivateHost('localhost'), true);
      assert.equal(isPrivateHost('app.local'), true);
      assert.equal(isPrivateHost('service.internal'), true);
      assert.equal(isPrivateHost('server.lan'), true);
      assert.equal(isPrivateHost('metadata.google.internal'), true);
    });

    test('fetchPreview returns null immediately for dangerous SSRF URLs', async () => {
      const loopbackResult = await fetchPreview('http://127.0.0.1:8080/admin');
      assert.equal(loopbackResult, null);

      const metaResult = await fetchPreview('http://169.254.169.254/latest/meta-data/');
      assert.equal(metaResult, null);

      const localResult = await fetchPreview('http://localhost:5000/api/users');
      assert.equal(localResult, null);
    });
  });

  describe('2. Upload Magic Byte / Signature Validation', () => {
    test('accepts valid JPEG buffer signature', () => {
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
      assert.equal(isValidImageMagicBytes(jpegBuffer), true);
    });

    test('accepts valid PNG buffer signature', () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      assert.equal(isValidImageMagicBytes(pngBuffer), true);
    });

    test('accepts valid GIF buffer signature', () => {
      const gifBuffer = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00', 'binary');
      assert.equal(isValidImageMagicBytes(gifBuffer), true);
    });

    test('accepts valid WEBP buffer signature', () => {
      const webpBuffer = Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
        Buffer.from('WEBP'),
      ]);
      assert.equal(isValidImageMagicBytes(webpBuffer), true);
    });

    test('rejects executable / script / plain text buffer spoofing an image', () => {
      const scriptBuffer = Buffer.from('<script>alert(1)</script>', 'utf8');
      assert.equal(isValidImageMagicBytes(scriptBuffer), false);

      const elfBuffer = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
      assert.equal(isValidImageMagicBytes(elfBuffer), false);

      const tinyBuffer = Buffer.from([0xff, 0xd8]);
      assert.equal(isValidImageMagicBytes(tinyBuffer), false);
    });
  });

  describe('3. JWT Algorithm Enforcement', () => {
    test('issues and verifies token using explicit HS256', () => {
      const dummyUser = { _id: '507f1f77bcf86cd799439011', role: 'user' };
      const token = authService.issueToken(dummyUser);
      assert.equal(typeof token, 'string');

      const decodedHeader = jwt.decode(token, { complete: true });
      assert.equal(decodedHeader.header.alg, 'HS256');

      const verified = authService.verifyToken(token);
      assert.equal(verified.sub, '507f1f77bcf86cd799439011');
      assert.equal(verified.role, 'user');
    });

    test('rejects token signed with none algorithm', () => {
      // Forge a "none" algorithm token
      const noneToken = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiIxMjM0NTYiLCJyb2xlIjoiYWRtaW4ifQ.';
      assert.throws(() => authService.verifyToken(noneToken));
    });
  });

  describe('4. NoSQL Operator & Parameter Sanitization', () => {
    test('strips keys starting with $ or containing . from objects and nested arrays', () => {
      const maliciousBody = {
        username: { $gt: '' },
        password: 'password123',
        nested: {
          'config.env': 'hacked',
          safeField: 'hello',
          arr: [{ $where: 'sleep(1000)' }, { normal: 123 }],
        },
      };

      const sanitized = sanitizeInput(maliciousBody);
      assert.deepEqual(sanitized.username, {});
      assert.equal(sanitized.password, 'password123');
      assert.equal(sanitized.nested['config.env'], undefined);
      assert.equal(sanitized.nested.safeField, 'hello');
      assert.equal(sanitized.nested.arr[0].$where, undefined);
      assert.equal(sanitized.nested.arr[1].normal, 123);
    });
  });
});
