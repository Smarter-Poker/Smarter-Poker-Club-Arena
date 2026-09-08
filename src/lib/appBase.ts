/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  APP BASE — where this bundle lives, and what shell is running it
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Club Arena ships to TWO places from one source tree:
 *
 *   web     https://smarter.poker/hub/club-arena/   base '/hub/club-arena/'
 *   native  Capacitor webview (capacitor://localhost, https://localhost)
 *           where the copied dist-native/ IS the document root, base '/'
 *
 * Every path that used to be the literal '/hub/club-arena' is derived from
 * here, so the two targets cannot drift: on the web this module resolves to
 * byte-identical values to the literals it replaced, and on native it resolves
 * to the root. A basename that does not match the URL is a WHITE SCREEN with
 * no error in React Router v7 (an empty tree, not a 404), which is why this
 * is the first file the native build depends on.
 *
 * Compile-time vs runtime:
 *   - IS_NATIVE_BUILD is a build constant (VITE_NATIVE=1). Vite inlines it,
 *     so `if (IS_NATIVE_BUILD)` branches are dead-code-eliminated from the web
 *     bundle and the web ships exactly what it shipped before.
 *   - isNativePlatform() asks the Capacitor bridge at runtime. It is the
 *     check for anything that must also work when a native bundle is opened
 *     in a plain browser (Capgo previews, `vite preview` of dist-native).
 *
 * CHANGELOG: docs/changelog/2026-09-07-capacitor-shell.md
 */

/** The bundle's public base, with a trailing slash. Web: '/hub/club-arena/'. Native: '/'. */
export const APP_BASE_URL: string = normaliseBase(import.meta.env.BASE_URL);

/** What <BrowserRouter basename> gets. Web: '/hub/club-arena'. Native: '/'. */
export const ROUTER_BASENAME: string = routerBasenameFrom(APP_BASE_URL);

/** True only in a bundle built with VITE_NATIVE=1 (`npm run build:native`). */
export const IS_NATIVE_BUILD: boolean = import.meta.env.VITE_NATIVE === '1';

/**
 * The canonical public home of Club Arena on the web. Share links, invite
 * links, QR codes, password-reset redirects and every other URL that leaves
 * the device must be built from THIS, never from window.location.origin: in
 * a webview that origin is capacitor://localhost, which nobody else can open.
 */
export const WEB_ORIGIN = 'https://smarter.poker';
export const WEB_APP_BASE_URL = `${WEB_ORIGIN}/hub/club-arena/`;
export const WEB_APP_URL = `${WEB_ORIGIN}/hub/club-arena`;

export function normaliseBase(base: string | undefined): string {
  const b = (base || '').trim();
  if (!b || b === '/' || b === './' || b === '.') return '/';
  return b.endsWith('/') ? b : `${b}/`;
}

export function routerBasenameFrom(base: string): string {
  const b = normaliseBase(base);
  return b === '/' ? '/' : b.replace(/\/$/, '');
}

/**
 * Absolute URL, on the public web origin, for a path inside the app.
 *   webAppUrl('/clubs/abc')  -> 'https://smarter.poker/hub/club-arena/clubs/abc'
 *   webAppUrl('hand-history?hand=x') -> '.../hub/club-arena/hand-history?hand=x'
 */
export function webAppUrl(path = ''): string {
  const p = path.replace(/^\//, '');
  return p ? `${WEB_APP_BASE_URL}${p}` : WEB_APP_URL;
}

/**
 * The origin to use for a link that must open OUTSIDE this bundle on the
 * web: the web origin when running natively, the current origin otherwise
 * (so dev servers and preview deployments keep pointing at themselves).
 */
export function publicOrigin(): string {
  if (isNativePlatform()) return WEB_ORIGIN;
  if (typeof window === 'undefined') return WEB_ORIGIN;
  const o = window.location?.origin;
  if (!o || o === 'null' || o.startsWith('capacitor:') || o.startsWith('file:')) return WEB_ORIGIN;
  return o;
}

type CapacitorBridge = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
};

function bridge(): CapacitorBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { Capacitor?: CapacitorBridge };
  return w.Capacitor;
}

/** True when the Capacitor bridge says we are inside the iOS or Android app. */
export function isNativePlatform(): boolean {
  try {
    const cap = bridge();
    return !!cap?.isNativePlatform?.();
  } catch {
    return false;
  }
}

/** 'ios' | 'android' | 'web' */
export function nativePlatform(): 'ios' | 'android' | 'web' {
  try {
    const p = bridge()?.getPlatform?.();
    return p === 'ios' || p === 'android' ? p : 'web';
  } catch {
    return 'web';
  }
}
