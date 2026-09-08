/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ROUTER BRIDGE — navigate from outside React
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A deep link arrives through the Capacitor bridge, a push tap through a
 * plugin listener: neither is a component, and useNavigate() is. This holds
 * the router's navigate() so those callers can route in-SPA - keeping the
 * warm client, its sockets and every open table alive - instead of reloading
 * the whole app with window.location.
 *
 * <RouterBridge/> (src/components/common/RouterBridge.tsx) registers it on
 * mount. Before it mounts, or if it never does, appNavigate() falls back to
 * pushState + a synthetic popstate, which BrowserRouter also listens to.
 */

export type AppNavigate = (to: string, opts?: { replace?: boolean }) => void;

let navigateRef: AppNavigate | null = null;
const pending: Array<[string, { replace?: boolean } | undefined]> = [];

export function setAppNavigate(fn: AppNavigate | null): void {
  navigateRef = fn;
  if (fn) {
    while (pending.length) {
      const [to, opts] = pending.shift()!;
      fn(to, opts);
    }
  }
}

/** Route in-SPA to an in-app path ('/clubs/abc?x=1'). Never a full URL. */
export function appNavigate(to: string, opts?: { replace?: boolean }): void {
  if (navigateRef) {
    navigateRef(to, opts);
    return;
  }
  if (typeof window === 'undefined') return;
  // Not mounted yet (a deep link that launched the app). Queue it for the
  // bridge, and also move the URL so a router mounting later starts there.
  pending.push([to, opts]);
  try {
    const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
    const url = `${base}${to.startsWith('/') ? to : '/' + to}`;
    if (opts?.replace) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  } catch {
    /* history unavailable */
  }
}
