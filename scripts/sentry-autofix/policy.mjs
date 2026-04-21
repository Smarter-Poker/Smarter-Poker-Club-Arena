// Code-modification policy for the Club Arena autofix runner.
//
// CA surface includes: React 19 + Vite 6 SPA client (src/), server engine
// (server/src/), and the legacy CA/src/engine/ tree. The engine is money-
// critical and MUST NEVER be auto-fixed.
//
// DENYLIST: paths Claude may NEVER touch. Substring match. If any changed
// file matches, the PR is opened as diagnostic-only with no code changes,
// labeled `sentry-autofix-blocked`.
//
// ALLOWLIST (for Phase 5.2.2 auto-merge): if every changed file matches,
// the PR may be auto-merged after CI. Otherwise PR waits for human merge.
// Phase 5.2.0 runs dry-run regardless → every fix is a draft PR.

const DENYLIST = [
  // Engine core — stake/pot/showdown correctness. Never auto-fix.
  'CA/src/engine/',
  'server/src/engine/',

  // Database migrations (irreversible).
  'supabase/migrations/',

  // Middleware / RLS / auth surface.
  'middleware.ts',
  '/auth/',
  '/ledger/',

  // Money / balance surface — never auto-fix.
  '/wallet/',
  '/rake/',
  '/purchase/',
  '/diamonds/',
  '/payouts/',
  '/chip-pool',
  '/kyc/',
  '/mfa/',
  '/step-up/',

  // Admin / debug / emergency / webhooks / cron endpoints.
  'pages/api/admin/',
  'pages/api/debug/',
  'pages/api/emergency/',
  'pages/api/webhooks/',
  'pages/api/cron/',

  // Infra configs.
  'vercel.json',
  'next.config',
  '.github/workflows/',
  '.husky/',

  // Dependency manifests.
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',

  // Env + secrets.
  '.env',
  '.env.local',
  '.env.production',

  // Service-role Supabase clients — admin privilege leak risk.
  'lib/supabaseAdmin',
  'lib/supabase-admin',
  'lib/serviceRole',
  'lib/stripe',

  // Autofix pipeline self-modification (loop risk).
  'services/sentry-autofix/',
  'scripts/sentry-autofix/',
];

const ALLOWLIST = [
  // Club Arena SPA — user-facing UI only.
  'src/components/',
  'src/hooks/',
  'src/lib/',
  'src/styles/',
  'src/pages/',      // CA's Vite-routed pages layer (not Next.js).
  'src/context/',
  'src/store/',
  'src/utils/',

  // Next-hub projections of CA (if a CA fix lands in the hub repo via
  // the shared surface — rare, but supported).
  'pages/hub/',

  // Generic static / docs / component roots.
  'components/',
  'styles/',
  'public/hub/club-arena/',
  'docs/',
];

export function isDenied(path) {
  return DENYLIST.some(p => path.includes(p));
}

export function isAllowedForAutoMerge(path) {
  return ALLOWLIST.some(p => path.includes(p));
}

/**
 * @param {string[]} paths  file paths Claude's patch touches
 * @returns {{ok:boolean, denied:string[], allowMerge:boolean}}
 */
export function assessPaths(paths) {
  const denied = paths.filter(isDenied);
  if (denied.length) return { ok: false, denied, allowMerge: false };
  const allowMerge = paths.length > 0 && paths.every(isAllowedForAutoMerge);
  return { ok: true, denied: [], allowMerge };
}

export { DENYLIST, ALLOWLIST };
