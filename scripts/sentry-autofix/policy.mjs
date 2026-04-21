// Code-modification policy for the Club Arena autofix runner.
//
// Club Arena is the Vite + React 19 poker SPA. Critical surfaces are:
//   - server/src/engine/        — V8 Bible-governed game engine (Hetzner)
//   - server/src/transport/     — WebSocket + HTTP contract
//   - src/engine/ + src/engines/ — client-side legacy engine being ripped out
//   - supabase/migrations/      — irreversible
//   - any money/ledger/wallet path
//
// Per V8 Bible + Migration Law, engine changes require explicit human review.
// DENYLIST = Claude may NEVER touch. ALLOWLIST (for Phase 5.2.2 auto-merge).
// Phase 5.2.1 is dry-run only → every fix lands as a draft PR.

const DENYLIST = [
  // V8 Bible-governed game engine — server + client copies.
  'server/src/engine/',
  'server/src/transport/',
  'server/src/services/',
  'src/engine/',
  'src/engines/',
  'src/sim/',

  // Money / balance surface — never auto-fix.
  '/ledger/',
  '/wallet/',
  '/rake/',
  '/purchase/',
  '/diamonds/',
  '/payouts/',
  '/chip-pool',
  '/kyc/',
  '/mfa/',

  // Auth + session surfaces.
  'src/services/auth',
  'src/lib/auth',
  'src/lib/supabaseAdmin',
  'src/lib/supabase-admin',
  'src/lib/serviceRole',

  // Database migrations (irreversible).
  'supabase/migrations/',
  'sql/',

  // Infra configs.
  'vite.config',
  'vitest.config',
  'tsconfig',
  '.github/workflows/',
  '.husky/',
  'infra/',

  // Dependency manifests.
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',

  // Env + secrets.
  '.env',
  '.env.local',
  '.env.production',

  // Autofix pipeline self-modification (loop risk).
  'scripts/sentry-autofix/',

  // V8 Bible skill surface — not code.
  'skills/',
  'AGENT_SKILLS/',

  // Build outputs.
  'dist/',
  'dist-fix/',
  'dist-fix2/',
  'dist.dead',
];

const ALLOWLIST = [
  // UI layer only.
  'src/pages/',
  'src/components/',
  'src/hooks/',
  'src/stores/',
  'src/i18n/',
  'src/styles/',
  'src/utils/',
  'src/core/',            // Sentry init + ErrorBoundary; OK for non-security fixes
  'src/content-engine/',  // GTO content generation, not money

  // Generic config surfaces (non-security).
  'src/constants/',
  'src/types/',

  // Tests.
  'tests/',
  'e2e/',
];

export function isDenied(path) {
  return DENYLIST.some(p => path.includes(p));
}

export function isAllowedForAutoMerge(path) {
  return ALLOWLIST.some(p => path.includes(p));
}

/**
 * @param {string[]} paths
 * @returns {{ok:boolean, denied:string[], allowMerge:boolean}}
 */
export function assessPaths(paths) {
  const denied = paths.filter(isDenied);
  if (denied.length) return { ok: false, denied, allowMerge: false };
  const allowMerge = paths.length > 0 && paths.every(isAllowedForAutoMerge);
  return { ok: true, denied: [], allowMerge };
}

export { DENYLIST, ALLOWLIST };
