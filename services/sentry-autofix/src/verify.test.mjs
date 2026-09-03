import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySentrySignature } from './verify.mjs';

const secret = 'test-secret-xyz';
const body = JSON.stringify({ action: 'created', issue: { id: '42' } });
const sig = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');

test('verifySentrySignature accepts valid signature', () => {
  assert.equal(verifySentrySignature(body, sig, secret), true);
});

test('verifySentrySignature rejects wrong secret', () => {
  assert.equal(verifySentrySignature(body, sig, 'wrong'), false);
});

test('verifySentrySignature rejects tampered body', () => {
  assert.equal(verifySentrySignature(body + 'x', sig, secret), false);
});

test('verifySentrySignature rejects empty signature', () => {
  assert.equal(verifySentrySignature(body, '', secret), false);
});

test('verifySentrySignature rejects length mismatch without timing leak', () => {
  assert.equal(verifySentrySignature(body, 'deadbeef', secret), false);
});
