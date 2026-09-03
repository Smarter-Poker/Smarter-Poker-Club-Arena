import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessPaths, isDenied, isAllowedForAutoMerge } from './policy.mjs';

test('denylists engine paths', () => {
  assert.equal(isDenied('CA/src/engine/holdem.ts'), true);
  assert.equal(isDenied('server/src/engine/pot.ts'), true);
});

test('denylists migrations + middleware + auth', () => {
  assert.equal(isDenied('supabase/migrations/20260420_x.sql'), true);
  assert.equal(isDenied('middleware.ts'), true);
  assert.equal(isDenied('pages/api/auth/login.js'), true);
});

test('denylists admin/debug/emergency APIs', () => {
  assert.equal(isDenied('pages/api/admin/health.js'), true);
  assert.equal(isDenied('pages/api/debug/foo.js'), true);
  assert.equal(isDenied('pages/api/emergency/reset.js'), true);
});

test('denylists own tooling (no self-rewrite)', () => {
  assert.equal(isDenied('services/sentry-autofix/src/server.mjs'), true);
  assert.equal(isDenied('scripts/sentry-autofix/run.mjs'), true);
});

test('does not denylist ordinary component', () => {
  assert.equal(isDenied('components/Profile.jsx'), false);
  assert.equal(isDenied('pages/hub/index.jsx'), false);
});

test('allowlist only covers low-risk UI paths', () => {
  assert.equal(isAllowedForAutoMerge('components/Profile.jsx'), true);
  assert.equal(isAllowedForAutoMerge('pages/hub/feed.jsx'), true);
  assert.equal(isAllowedForAutoMerge('pages/api/users.js'), false);
});

test('assessPaths: all denylisted → ok=false', () => {
  const r = assessPaths(['supabase/migrations/x.sql', 'middleware.ts']);
  assert.equal(r.ok, false);
  assert.equal(r.denied.length, 2);
});

test('assessPaths: all allowlisted → ok=true, allowMerge=true', () => {
  const r = assessPaths(['components/A.jsx', 'components/B.jsx']);
  assert.equal(r.ok, true);
  assert.equal(r.allowMerge, true);
});

test('assessPaths: mixed safe but non-allowlisted → ok=true, allowMerge=false', () => {
  const r = assessPaths(['pages/api/users.js', 'components/A.jsx']);
  assert.equal(r.ok, true);
  assert.equal(r.allowMerge, false);
});

test('assessPaths: empty → ok=true, allowMerge=false', () => {
  const r = assessPaths([]);
  assert.equal(r.ok, true);
  assert.equal(r.allowMerge, false);
});
