// Tests for the Club Arena sentry-autofix policy.
// Run: node --test policy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessPaths, isDenied, isAllowedForAutoMerge, DENYLIST, ALLOWLIST } from './policy.mjs';

// ══════════════════ DENYLIST ══════════════════

test('denylists engine paths', () => {
  assert.equal(isDenied('CA/src/engine/holdem.ts'), true);
  assert.equal(isDenied('server/src/engine/pot.ts'), true);
});

test('denylists migrations + middleware + auth + ledger', () => {
  assert.equal(isDenied('supabase/migrations/20260420_x.sql'), true);
  assert.equal(isDenied('middleware.ts'), true);
  assert.equal(isDenied('pages/api/auth/login.js'), true);
  assert.equal(isDenied('lib/poker/ledger/reconcile.js'), true);
});

test('denylists admin/debug/emergency/webhooks/cron APIs', () => {
  assert.equal(isDenied('pages/api/admin/health.js'), true);
  assert.equal(isDenied('pages/api/debug/foo.js'), true);
  assert.equal(isDenied('pages/api/emergency/reset.js'), true);
  assert.equal(isDenied('pages/api/webhooks/stripe.js'), true);
  assert.equal(isDenied('pages/api/cron/reconcile.js'), true);
});

test('denylists money substrings (wallet/rake/purchase/diamonds/payouts/chip-pool/kyc/mfa/step-up)', () => {
  for (const p of [
    'pages/api/wallet/balance.js',
    'src/components/wallet/DynamicWallet.tsx',
    'pages/api/rake/collect.js',
    'pages/api/purchase/confirm.js',
    'pages/api/diamonds/mint.js',
    'pages/api/payouts/process.js',
    'server/src/chip-pool/transfer.ts',
    'pages/api/kyc/verify.js',
    'pages/api/mfa/enroll.js',
    'pages/api/step-up/challenge.js',
  ]) {
    assert.equal(isDenied(p), true, `expected ${p} denied`);
  }
});

test('denylists infra configs (vercel.json, next.config, workflows, husky)', () => {
  assert.equal(isDenied('vercel.json'), true);
  assert.equal(isDenied('next.config.js'), true);
  assert.equal(isDenied('next.config.mjs'), true);
  assert.equal(isDenied('.github/workflows/sentry-autofix.yml'), true);
  assert.equal(isDenied('.husky/pre-commit'), true);
});

test('denylists dep manifests + env', () => {
  assert.equal(isDenied('package.json'), true);
  assert.equal(isDenied('package-lock.json'), true);
  assert.equal(isDenied('yarn.lock'), true);
  assert.equal(isDenied('pnpm-lock.yaml'), true);
  assert.equal(isDenied('.env'), true);
  assert.equal(isDenied('.env.local'), true);
  assert.equal(isDenied('.env.production'), true);
});

test('denylists service-role helpers', () => {
  assert.equal(isDenied('lib/supabaseAdmin.js'), true);
  assert.equal(isDenied('lib/supabase-admin.ts'), true);
  assert.equal(isDenied('lib/serviceRole.js'), true);
  assert.equal(isDenied('lib/stripe.js'), true);
});

test('denylists own tooling (no self-rewrite)', () => {
  assert.equal(isDenied('services/sentry-autofix/src/server.mjs'), true);
  assert.equal(isDenied('scripts/sentry-autofix/run.mjs'), true);
});

test('does not denylist ordinary components or pages', () => {
  assert.equal(isDenied('components/Profile.jsx'), false);
  assert.equal(isDenied('pages/hub/index.jsx'), false);
  assert.equal(isDenied('src/components/Button.tsx'), false);
  assert.equal(isDenied('src/hooks/useTimer.ts'), false);
});

// ══════════════════ ALLOWLIST ══════════════════

test('allowlist covers safe UI paths', () => {
  assert.equal(isAllowedForAutoMerge('src/components/Profile.tsx'), true);
  assert.equal(isAllowedForAutoMerge('src/hooks/useAuth.ts'), true);
  assert.equal(isAllowedForAutoMerge('src/lib/format.ts'), true);
  assert.equal(isAllowedForAutoMerge('src/pages/Lobby.tsx'), true);
  assert.equal(isAllowedForAutoMerge('src/utils/date.ts'), true);
  assert.equal(isAllowedForAutoMerge('src/context/Auth.tsx'), true);
  assert.equal(isAllowedForAutoMerge('src/store/user.ts'), true);
  assert.equal(isAllowedForAutoMerge('components/Profile.jsx'), true);
  assert.equal(isAllowedForAutoMerge('pages/hub/feed.jsx'), true);
  assert.equal(isAllowedForAutoMerge('styles/theme.css'), true);
  assert.equal(isAllowedForAutoMerge('public/hub/club-arena/logo.png'), true);
});

test('allowlist does NOT cover API or engine paths', () => {
  assert.equal(isAllowedForAutoMerge('pages/api/users.js'), false);
  assert.equal(isAllowedForAutoMerge('server/src/engine/pot.ts'), false);
  assert.equal(isAllowedForAutoMerge('CA/src/engine/holdem.ts'), false);
});

// ══════════════════ assessPaths ══════════════════

test('assessPaths: all denylisted → ok=false', () => {
  const r = assessPaths(['supabase/migrations/x.sql', 'middleware.ts']);
  assert.equal(r.ok, false);
  assert.equal(r.denied.length, 2);
  assert.equal(r.allowMerge, false);
});

test('assessPaths: all allowlisted → ok=true, allowMerge=true', () => {
  const r = assessPaths(['src/components/A.tsx', 'src/hooks/useX.ts']);
  assert.equal(r.ok, true);
  assert.equal(r.allowMerge, true);
});

test('assessPaths: mixed safe but non-allowlisted → ok=true, allowMerge=false', () => {
  const r = assessPaths(['pages/api/users.js', 'src/components/A.tsx']);
  assert.equal(r.ok, true);
  assert.equal(r.allowMerge, false);
});

test('assessPaths: empty → ok=true, allowMerge=false', () => {
  const r = assessPaths([]);
  assert.equal(r.ok, true);
  assert.equal(r.allowMerge, false);
});

test('assessPaths: one denied amongst many blocks everything', () => {
  const r = assessPaths(['src/components/A.tsx', 'server/src/engine/pot.ts', 'src/hooks/useX.ts']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.denied, ['server/src/engine/pot.ts']);
});

test('nested money substring denied even deep in tree', () => {
  assert.equal(isDenied('src/features/checkout/purchase/flow.ts'), true);
  assert.equal(isDenied('components/deep/wallet/card.jsx'), true);
});

// ══════════════════ Integrity ══════════════════

test('DENYLIST and ALLOWLIST are both non-empty arrays', () => {
  assert.ok(Array.isArray(DENYLIST) && DENYLIST.length > 0);
  assert.ok(Array.isArray(ALLOWLIST) && ALLOWLIST.length > 0);
});

test('DENYLIST contains engine entries (CA critical)', () => {
  assert.ok(DENYLIST.some(p => p.includes('engine')));
});

test('DENYLIST contains self-modification guards', () => {
  assert.ok(DENYLIST.some(p => p.includes('scripts/sentry-autofix')));
  assert.ok(DENYLIST.some(p => p.includes('services/sentry-autofix')));
});
