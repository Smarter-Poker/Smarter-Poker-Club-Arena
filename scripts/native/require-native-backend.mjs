/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN APP BUNDLE WITHOUT ITS BACKEND IS A BRICK - refuse to build one
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-29, the first on-device walkthrough: an Android build booted to
 * "Loading Failed" and the log said `supabaseUrl is required`. The checkout
 * it was built from had no .env (a git worktree does not copy untracked
 * files), `npm run build:native` succeeded anyway, and the bundle it produced
 * could not reach anything. On a phone that is not a bug report, it is a
 * one-star review: the app opens to an error and stays there. The same bundle
 * is what `publish-to-app` uploads over the air to every installed copy.
 *
 * The web build is not guarded here on purpose: CI builds the web bundle in
 * jobs that never talk to a backend, and the website has its own deploy
 * checks. The native bundle is only ever built to be installed, so there is
 * no case in which building one without its backend is what anyone wanted.
 *
 * vite.config.ts calls assertNativeBackend() when VITE_NATIVE=1, with the
 * same variables Vite itself will read (.env files, then the environment).
 */

export const NATIVE_BACKEND_KEYS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];

/** Everything wrong with the backend settings a native bundle would ship with. */
export function nativeBackendProblems(env) {
  const problems = [];
  for (const key of NATIVE_BACKEND_KEYS) {
    if (!String(env?.[key] ?? '').trim()) problems.push(`${key} is empty`);
  }
  const url = String(env?.VITE_SUPABASE_URL ?? '').trim();
  if (url) {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      problems.push('VITE_SUPABASE_URL is not a URL');
    }
    if (parsed && parsed.protocol !== 'https:') problems.push('VITE_SUPABASE_URL is not https');
  }
  return problems;
}

export function assertNativeBackend(env) {
  const problems = nativeBackendProblems(env);
  if (problems.length === 0) return;
  throw new Error(
    `[build:native] Refusing to build an app bundle that cannot reach its backend: ${problems.join('; ')}. ` +
      'The app would open to "Loading Failed" on every phone it reaches. Build from a checkout with a .env ' +
      '(a git worktree does not copy it: cp <main checkout>/.env .), or export the variables first.'
  );
}
