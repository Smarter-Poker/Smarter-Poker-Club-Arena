/**
 * The request target of a WebSocket upgrade, parsed without throwing.
 *
 * `req.url` on an upgrade is whatever bytes the peer sent as its request
 * target, before authentication and before any route is matched. `new URL()`
 * THROWS on some of them (`//`, `///`, `//:80`), and an exception thrown
 * synchronously inside an `upgrade` listener is an uncaughtException, which
 * `index.ts` treats as fatal: the engine drains and restarts, voiding every
 * hand in flight on every table. One unauthenticated request could do that,
 * and repeat it (launch audit 2026-10-05).
 *
 * So the target is parsed here, once, and a target that cannot be parsed is a
 * value the caller refuses, never an exception.
 */
export function parseUpgradeTarget(rawTarget: string | undefined): URL | null {
  try {
    // `req.url` is path+query only, so it is resolved against a dummy host.
    return new URL(rawTarget || '/', 'http://localhost');
  } catch {
    return null;
  }
}
