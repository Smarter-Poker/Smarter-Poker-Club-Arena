// HMAC verification for Sentry webhooks.
//
// Sentry signs the raw request body with HMAC-SHA256(secret, body) and
// puts the hex digest in the `Sentry-Hook-Signature` header. We MUST
// verify the signature against the raw body (not the parsed JSON) because
// JSON round-tripping can change whitespace.

import crypto from 'node:crypto';

/**
 * @param {string} rawBody  The exact bytes Sentry POSTed.
 * @param {string} signature  `Sentry-Hook-Signature` header value.
 * @param {string} secret  `SENTRY_WEBHOOK_SECRET` env var.
 * @returns {boolean}
 */
export function verifySentrySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  // timingSafeEqual requires equal-length buffers.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
