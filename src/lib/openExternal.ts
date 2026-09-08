/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OPEN EXTERNAL — leaving this bundle, on each target
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * On the web, a World Hub page (/hub/messenger, /hub/marketplace, the avatar
 * creator) is one navigation away on the same origin, and a third-party page
 * is a window.open. Inside the native app neither works: a `/hub/...` path
 * resolves against capacitor://localhost, where it is index.html and the app
 * reboots into a 404, and window.open in a webview goes nowhere. The audit
 * lists the six window.open calls and five Hub handoffs as tier-1 blockers.
 *
 * Two functions cover every case, and on the web they do EXACTLY what the
 * call they replaced did:
 *
 *   leaveForHub(path)   web: window.location.href = path (or .replace)
 *                       native: opens https://smarter.poker + path in the
 *                       in-app browser (SFSafariViewController / Custom Tab),
 *                       so the player comes back with the tables still open.
 *
 *   openInBrowser(url)  web: window.open(url, '_blank', features)
 *                       native: same in-app browser.
 *
 * The Capacitor import stays inside src/lib/native/ (law: the web bundle does
 * not know the app exists) and is loaded only when the bridge says native.
 */

import { isNativePlatform, publicOrigin } from './appBase';
import { reportError } from '../utils/errorReporter';

function absolute(pathOrUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl)) return pathOrUrl;
  const p = pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl;
  return `${publicOrigin()}${p}`;
}

async function nativeOpen(url: string): Promise<void> {
  const { openInAppBrowser } = await import('./native/browser');
  await openInAppBrowser(url);
}

export interface LeaveOptions {
  /** Use history.replace semantics on the web (window.location.replace). */
  replace?: boolean;
}

/** Navigate to a World Hub page (web) or open it beside the app (native). */
export function leaveForHub(pathOrUrl: string, opts: LeaveOptions = {}): void {
  if (isNativePlatform()) {
    void nativeOpen(absolute(pathOrUrl)).catch((err) =>
      reportError(err, 'openExternal.leaveForHub_native_failed')
    );
    return;
  }
  if (opts.replace) window.location.replace(pathOrUrl);
  else window.location.href = pathOrUrl;
}

/** window.open on the web; the in-app browser on native. */
export function openInBrowser(url: string, features = 'noopener,noreferrer'): void {
  if (isNativePlatform()) {
    void nativeOpen(absolute(url)).catch((err) =>
      reportError(err, 'openExternal.openInBrowser_native_failed')
    );
    return;
  }
  window.open(url, '_blank', features);
}
