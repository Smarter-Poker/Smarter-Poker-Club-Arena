// Code-modification policy for the autofix runner.
//
// DENYLIST: paths Claude may NEVER touch. Matches by glob substring.
// If *any* changed file matches, the PR is opened as diagnostic-only
// (explanation + Sentry link) with no code changes, labelled
// `sentry-autofix-blocked` for human attention.
//
// ALLOWLIST (for future auto-merge): if every changed file matches,
// the PR may be auto-merged after CI passes. Otherwise PR waits for
// human merge. Controlled by AUTOFIX_MODE env — 'dry-run' forces PR
// regardless. (Phase 5.2.0 sets AUTOFIX_MODE=dry-run in the workflow.)

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
  // Admin / debug / emergency API endpoints.
  'pages/api/admin/',
  'pages/api/debug/',
  'pages/api/emergency/',
  // Infra configs.
  'vercel.json',
  '.github/workflows/',
  // Dependency manifests.
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  // Env + secrets.
  '.env',
  '.env.local',
  '.env.production',
  // Supabase admin helpers.
  'lib/supabaseAdmin',
  'lib/supabase-admin',
  // Webhook secrets verifiers (security-critical).
  'services/sentry-autofix/',
  'scripts/sentry-autofix/',
];

const ALLOWLIST = [
  'pages/hub/',
  'components/',
  'styles/',
  'public/hub/club-arena/',
  'docs/',
  'src/components/',
  'src/pages/',
  'src/hooks/',
  'src/lib/',
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
