/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TELL THE SERVER WHAT THIS BROWSER SAW (Realtime Phase 2, 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan's tables said "Reconnecting To The Table" for twenty-two hours on
 * 2026-09-03. Every close code, every retry and every twenty-second
 * auto-reload happened in his browser and reached the platform as nothing at
 * all, so every dashboard stayed green while nobody could play.
 *
 * This posts a single word - why the socket went away - to POST /client-event.
 * The server counts it; no user id is sent, because the server takes that
 * from the verified token instead.
 *
 * THE RULES THIS FOLLOWS, because it runs beside a live table:
 *
 *   - IT CAN NEVER AFFECT PLAY. Fire and forget, every error swallowed, no
 *     await on any path a hand depends on.
 *   - A RECONNECT STORM IS NOT A REQUEST STORM. At most one beacon per
 *     THROTTLE_MS per reason. The outage this exists for produced a retry
 *     every few seconds for a day; that must cost a handful of requests an
 *     hour, not thousands.
 *   - IT NEVER RETRIES. Telemetry that retries competes with the reconnect
 *     it is describing, on the same connection that is already failing.
 *   - IT STAYS QUIET WHEN SIGNED OUT. With no token there is nobody to
 *     attribute the event to and the server would 401 anyway.
 */
import { getFreshAccessToken } from '../lib/authToken';

const ENGINE_BASE_URL =
  (import.meta as unknown as { env: Record<string, string> }).env?.VITE_ENGINE_URL ??
  'https://engine.smarter.poker';

/** One beacon per reason per this many ms. */
export const THROTTLE_MS = 60_000;

/**
 * `reload_suppressed` (Phase 3, 2026-09-05) is the failsafe NOT firing: the
 * page would have reloaded, and did not, because the socket died for auth and
 * a reload cannot fix that. It is the one signal that separates a bad network
 * from a player who cannot authenticate to a table, which is the distinction
 * nobody could make during the 2026-09-03 outage.
 */
export type BeaconReason =
  | 'auth_failed'
  | 'stale'
  | 'handshake_timeout'
  | 'closed'
  | 'auto_reload'
  | 'reload_suppressed';

const lastSentAt = new Map<BeaconReason, number>();

/** Test seam. */
export function _resetBeaconThrottle(): void {
  lastSentAt.clear();
}

/**
 * Report one connection event. Returns immediately; the caller never waits
 * and never learns whether it worked, by design.
 */
export function reportConnectionEvent(reason: BeaconReason): void {
  try {
    const now = Date.now();
    const last = lastSentAt.get(reason) ?? 0;
    if (now - last < THROTTLE_MS) return;
    lastSentAt.set(reason, now);

    void (async () => {
      try {
        const token = await getFreshAccessToken();
        if (!token) return; // signed out: nobody to attribute it to
        await fetch(`${ENGINE_BASE_URL}/client-event`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ reason }),
          keepalive: true,
        });
      } catch {
        /* telemetry never retries and never complains */
      }
    })();
  } catch {
    /* nothing here may ever reach the table */
  }
}
