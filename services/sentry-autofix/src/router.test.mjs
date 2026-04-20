import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRepo } from './router.mjs';

test('resolveRepo: JSON map resolves known slug', () => {
  const env = {
    SENTRY_PROJECT_REPOS: JSON.stringify({
      'club-arena-client': 'Smarter-Poker/Smarter-Poker-Club-Arena',
      'world-hub': 'Smarter-Poker/Smarter-Poker-World-Hub',
    }),
  };
  assert.deepEqual(resolveRepo('world-hub', env), { ok: true, repo: 'Smarter-Poker/Smarter-Poker-World-Hub' });
  assert.deepEqual(resolveRepo('club-arena-client', env), { ok: true, repo: 'Smarter-Poker/Smarter-Poker-Club-Arena' });
});

test('resolveRepo: unknown slug with JSON map returns reason', () => {
  const env = { SENTRY_PROJECT_REPOS: JSON.stringify({ 'world-hub': 'a/b' }) };
  const got = resolveRepo('club-arena-client', env);
  assert.equal(got.ok, false);
  assert.match(got.reason, /no repo mapping for project/);
});

test('resolveRepo: malformed JSON returns reason (no throw)', () => {
  const env = { SENTRY_PROJECT_REPOS: '{not json' };
  const got = resolveRepo('anything', env);
  assert.equal(got.ok, false);
  assert.match(got.reason, /not valid JSON/);
});

test('resolveRepo: non-object JSON returns reason', () => {
  const env = { SENTRY_PROJECT_REPOS: '["a","b"]' };
  const got = resolveRepo('anything', env);
  assert.equal(got.ok, false);
  assert.match(got.reason, /JSON object/);
});

test('resolveRepo: falls back to GITHUB_REPO when map absent', () => {
  const env = { GITHUB_REPO: 'Smarter-Poker/Smarter-Poker-Club-Arena' };
  assert.deepEqual(resolveRepo('club-arena-client', env), { ok: true, repo: 'Smarter-Poker/Smarter-Poker-Club-Arena' });
});

test('resolveRepo: returns error when nothing configured', () => {
  const got = resolveRepo('anything', {});
  assert.equal(got.ok, false);
  assert.match(got.reason, /neither SENTRY_PROJECT_REPOS nor GITHUB_REPO/);
});

test('resolveRepo: malformed GITHUB_REPO returns reason', () => {
  const got = resolveRepo('anything', { GITHUB_REPO: 'not-a-slug' });
  assert.equal(got.ok, false);
});

test('resolveRepo: malformed repo in map returns reason', () => {
  const env = { SENTRY_PROJECT_REPOS: JSON.stringify({ 'world-hub': 'not-a-slug' }) };
  const got = resolveRepo('world-hub', env);
  assert.equal(got.ok, false);
});
