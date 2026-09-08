/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DEEP LINKS — a URL opened the app; route it (native only)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two shapes reach the app:
 *
 *   clubarena://clubs/abc?x=1                  the custom scheme (works with
 *                                              no store account; registered
 *                                              in Info.plist / AndroidManifest)
 *   https://smarter.poker/hub/club-arena/...   a universal / app link (needs
 *                                              apple-app-site-association and
 *                                              assetlinks.json on smarter.poker,
 *                                              which need Dan's Team ID and
 *                                              signing certificate - phase 6)
 *
 * Both reduce to an in-app path and go through the router bridge, so the app
 * routes in place: no reload, every open table kept.
 *
 * Auth links are the special case. Supabase sends password-reset and email
 * confirmation links to `redirectTo`; when that lands here the tokens are in
 * the URL and no page load happened, so detectSessionInUrl never saw them.
 * They are handed to the SDK explicitly:
 *   #access_token=..&refresh_token=..[&type=recovery]   -> setSession()
 *   ?code=..                                            -> exchangeCodeForSession()
 * and a recovery link then opens the "set a new password" form.
 */

import { appNavigate } from '../routerBridge';
import { toInAppPath } from '../signIn';

const WEB_PREFIX = '/hub/club-arena';
const SCHEME = 'clubarena';

export interface ParsedAppUrl {
  /** In-app path plus search, e.g. '/clubs/abc?x=1'. */
  path: string;
  hashParams: URLSearchParams;
  searchParams: URLSearchParams;
}

/** Pure: turn either URL shape into an in-app path. null = not ours. */
export function parseAppUrl(raw: string): ParsedAppUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  const searchParams = url.searchParams;

  if (url.protocol === `${SCHEME}:`) {
    // clubarena://clubs/abc -> host 'clubs', pathname '/abc'
    const joined = `/${url.host}${url.pathname}`.replace(/\/+$/, '') || '/';
    return { path: `${joined === '' ? '/' : joined}${url.search}`, hashParams, searchParams };
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    const p = url.pathname;
    const ours = url.hostname === 'smarter.poker' || url.hostname === 'www.smarter.poker';
    if (ours && (p === WEB_PREFIX || p.startsWith(WEB_PREFIX + '/'))) {
      return { path: `${toInAppPath(p)}${url.search}`, hashParams, searchParams };
    }
    // capacitor://localhost and https://localhost are the webview itself.
    if (url.hostname === 'localhost') {
      return { path: `${p}${url.search}`, hashParams, searchParams };
    }
    return null;
  }
  if (url.protocol === 'capacitor:') {
    return { path: `${url.pathname}${url.search}`, hashParams, searchParams };
  }
  return null;
}

let lastHandled = '';

/** Entry point for App.addListener('appUrlOpen') and App.getLaunchUrl(). */
export async function handleAppUrl(raw: string | null | undefined): Promise<void> {
  if (!raw || raw === lastHandled) return;
  lastHandled = raw;
  const parsed = parseAppUrl(raw);
  if (!parsed) return;
  const { path, hashParams, searchParams } = parsed;

  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');
  const code = searchParams.get('code');
  const errorDescription =
    hashParams.get('error_description') || searchParams.get('error_description');

  if (errorDescription) {
    appNavigate(`/auth?authError=${encodeURIComponent(errorDescription)}`, { replace: true });
    return;
  }

  if ((accessToken && refreshToken) || code) {
    const { supabase } = await import('../supabase');
    try {
      if (accessToken && refreshToken) {
        await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      } else if (code) {
        await supabase.auth.exchangeCodeForSession(code);
      }
    } catch {
      appNavigate('/auth?authError=link_expired', { replace: true });
      return;
    }
    const isRecovery =
      hashParams.get('type') === 'recovery' || searchParams.get('mode') === 'update';
    if (isRecovery) {
      appNavigate('/auth?mode=update', { replace: true });
      return;
    }
    appNavigate(stripAuthRoute(path), { replace: true });
    return;
  }

  appNavigate(path);
}

function stripAuthRoute(path: string): string {
  return path === '/auth' || path.startsWith('/auth?') ? '/' : path;
}
