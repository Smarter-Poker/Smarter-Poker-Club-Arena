/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LOG OUT ACTUALLY LOGS OUT (Dan 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "WHEN YOU CLICK THE HAMBURGER MENU, THEN CLICK 'LOG OUT' IT
 * SILENTLY FAILS."
 *
 * Three separate branches could swallow the click, and the drawer's own e2e
 * spec never caught any of them because it asserts Log Out is *visible* and
 * never clicks it.
 *
 *  1. supabase.auth.signOut() FAILS BY RETURN VALUE. GoTrue resolves with
 *     { error } rather than throwing for anything that is not 401/403/404 —
 *     offline, 5xx, a 429 — and on that path returns BEFORE _removeSession().
 *     So `smarter-poker-auth` survived in localStorage and no SIGNED_OUT event
 *     was ever emitted. Worse, AuthGuard reads exactly that key and, finding
 *     it, logs "re-hydrating instead of redirecting" and deliberately stays
 *     put: the safety net signed the user back in.
 *
 *  2. THE REDIRECT WAS SOMEONE ELSE'S JOB. handleLogOut delegated it to
 *     AuthGuard, but the legal routes this very drawer links to (/legal,
 *     /legal/tos, /legal/privacy, /legal/fair-gaming, /legal/promotions) are
 *     declared without one. Sign out there and nothing moved.
 *
 *  3. THE BREADCRUMB WAS NEVER CLEARED. 'club-arena-auth-breadcrumb' was
 *     written on every auth and removed by nothing, so AuthGuard treated every
 *     real sign-out as "recently authenticated" and delayed it by 800ms of
 *     visible nothing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const MENU = read('src/components/navigation/HamburgerMenu.tsx');
const GUARD = read('src/components/auth/AuthGuard.tsx');
const AUTH_UTILS = read('src/lib/authUtils.ts');
const IDENTITY = read('src/core/IdentityDNA.ts');

/** The handler body, comments stripped — the comments quote the old bug. */
const logOutBody = (() => {
  const start = MENU.indexOf('const handleLogOut = async () => {');
  expect(start, 'handleLogOut must exist').toBeGreaterThan(-1);
  const end = MENU.indexOf('\n  };', start);
  expect(end, 'handleLogOut must be a closed arrow function').toBeGreaterThan(start);
  return MENU.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
})();

describe('1. the sign-out does not depend on the network call succeeding', () => {
  it('clears the session key itself, in a finally', () => {
    expect(logOutBody, 'the clear must run on every path').toMatch(/finally\s*\{/);
    expect(
      logOutBody,
      'handleLogOut must remove AUTH_STORAGE_KEY itself. It is the only ' +
        'evidence AuthGuard consults, and a failed signOut leaves it in place.'
    ).toMatch(/removeItem\(AUTH_STORAGE_KEY\)/);
  });

  it('imports the key from the shared auth module rather than retyping it', () => {
    expect(MENU).toMatch(
      /import\s*\{[^}]*\bAUTH_STORAGE_KEY\b[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/authUtils'/
    );
  });
});

describe('2. the redirect belongs to the handler, not to whoever happens to be mounted', () => {
  it('navigates unconditionally', () => {
    expect(
      logOutBody,
      'AuthGuard is absent on /legal, /legal/tos, /legal/privacy, ' +
        '/legal/fair-gaming and /legal/promotions — all five linked from this ' +
        'same drawer. The redirect must not be delegated.'
    ).toMatch(/window\.location\.href\s*=/);
    // 2026-09-07: the URL comes from src/lib/signIn.ts - /auth/login?redirect=
    // on the web, the in-app AuthPage in the native build.
    expect(logOutBody).toMatch(/window\.location\.href = signInUrl\(/);
  });
});

describe('3. the breadcrumb has one owner and is cleared on the way out', () => {
  it('lives in lib/authUtils so writer and clearer share a constant', () => {
    expect(AUTH_UTILS).toMatch(/export const SPA_AUTH_BREADCRUMB = 'club-arena-auth-breadcrumb';/);
    expect(GUARD, 'AuthGuard must import the constant, not declare its own copy').toMatch(
      /import\s*\{[^}]*\bSPA_AUTH_BREADCRUMB\b[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/authUtils'/
    );
    expect(GUARD).not.toMatch(/const SPA_AUTH_BREADCRUMB\s*=\s*'/);
  });

  it('the sign-out path clears it', () => {
    expect(logOutBody).toMatch(/removeItem\(SPA_AUTH_BREADCRUMB\)/);
  });

  it("IdentityDNA's SIGNED_OUT branch clears it too", () => {
    const i = IDENTITY.indexOf("case 'SIGNED_OUT':");
    expect(i, 'the SIGNED_OUT branch must exist').toBeGreaterThan(-1);
    const branch = IDENTITY.slice(i, IDENTITY.indexOf('break;', i));
    expect(
      branch,
      'a sign-out triggered from anywhere else must not leave the breadcrumb behind'
    ).toMatch(/removeItem\(SPA_AUTH_BREADCRUMB\)/);
  });
});

describe('4. one click, one sign-out', () => {
  it('latches so a double tap cannot fire twice', () => {
    expect(logOutBody).toMatch(/signingOutRef\.current/);
    expect(MENU).toMatch(/const signingOutRef = useRef\(false\)/);
  });
});
