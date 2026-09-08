/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SIGN IN — where an unauthenticated player is sent, on each target
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * On the web, sign-in is the World Hub's page at /auth/login: Club Arena and
 * the Hub share one origin and one session key, so the Hub's login page IS
 * Club Arena's login page. Every redirect there carries `redirect=` with the
 * full web path (/hub/club-arena/...) to come back to.
 *
 * Inside the native app there is no World Hub. /auth/login is a URL that does
 * not exist in the bundle, and a webview sent there has no way back - the
 * audit's tier-0 blocker "bring login back inside the app". The local
 * AuthPage (route /auth) is complete; it just used to bounce itself away.
 * On native, sign-in is that page, and `redirect=` carries the IN-APP path.
 *
 * One function decides, so no caller has to: signInUrl(). Feed it the web
 * path (with or without the /hub/club-arena prefix); it returns the right
 * URL for the target it is running on.
 *
 * CHANGELOG: docs/changelog/2026-09-07-native-auth-and-links.md
 */

import { IS_NATIVE_BUILD } from './appBase';

/** The World Hub's login page. The web target's sign-in. */
export const WEB_LOGIN_PATH = '/auth/login';
/** The in-app AuthPage route (react-router path, under the basename). */
export const NATIVE_LOGIN_PATH = '/auth';

const WEB_PREFIX = '/hub/club-arena';

/** '/table/abc?x=1' or '/hub/club-arena/table/abc?x=1' -> '/hub/club-arena/table/abc?x=1' */
export function toWebPath(pathAndSearch: string): string {
  const p = pathAndSearch.startsWith('/') ? pathAndSearch : '/' + pathAndSearch;
  if (p === WEB_PREFIX || p.startsWith(WEB_PREFIX + '/') || p.startsWith(WEB_PREFIX + '?'))
    return p;
  return WEB_PREFIX + p;
}

/** '/hub/club-arena/table/abc?x=1' or '/table/abc?x=1' -> '/table/abc?x=1' */
export function toInAppPath(pathAndSearch: string): string {
  const web = toWebPath(pathAndSearch);
  const inner = web.slice(WEB_PREFIX.length);
  return inner === '' || inner.startsWith('?') ? '/' + inner : inner;
}

export interface SignInUrlOptions {
  /** Passed through as `authError=` so the login page can say why. */
  authError?: string;
}

/**
 * The URL that takes a signed-out player to sign in, with a way back.
 *   web:    /auth/login?[authError=x&]redirect=%2Fhub%2Fclub-arena%2Ftable%2Fabc
 *   native: /auth?[authError=x&]redirect=%2Ftable%2Fabc
 * `returnTo` is the path (+ search/hash) to come back to, in either form.
 */
export function signInUrl(returnTo: string, opts: SignInUrlOptions = {}): string {
  const params: string[] = [];
  if (opts.authError) params.push(`authError=${encodeURIComponent(opts.authError)}`);
  if (IS_NATIVE_BUILD) {
    params.push(`redirect=${encodeURIComponent(toInAppPath(returnTo))}`);
    return `${NATIVE_LOGIN_PATH}?${params.join('&')}`;
  }
  params.push(`redirect=${encodeURIComponent(toWebPath(returnTo))}`);
  return `${WEB_LOGIN_PATH}?${params.join('&')}`;
}

/**
 * Where the player is sent after signing in on the in-app page, read from
 * its own `redirect=` param. Only ever an in-app path: a full URL or a
 * protocol-relative one is refused (an open redirect from a deep link).
 */
export function safeInAppRedirect(raw: string | null | undefined): string {
  if (!raw) return '/';
  let v = raw;
  try {
    v = decodeURIComponent(raw);
  } catch {
    return '/';
  }
  if (!v.startsWith('/') || v.startsWith('//') || /^\/[\\/]/.test(v)) return '/';
  const inApp = toInAppPath(v);
  if (inApp === '/auth' || inApp.startsWith('/auth?') || inApp.startsWith('/auth/')) return '/';
  return inApp;
}
