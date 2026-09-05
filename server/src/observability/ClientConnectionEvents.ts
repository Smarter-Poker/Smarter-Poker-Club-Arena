/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THE PLAYER'S BROWSER SEES (Realtime programme, Phase 2 - 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE GAP. On 2026-09-03 Dan's tables said "Reconnecting To The Table" for
 * twenty-two hours. Every reconnect, every close code, every one of the
 * client's twenty-second auto-reload failsafes happened inside his browser
 * and reached this server as exactly nothing. The engine's own view was
 * perfect throughout - it was dealing 5,700 hands per ten minutes - because
 * the half that was broken was the half nobody could see.
 *
 * This is the client-side twin of `poker_ws_auth_refused_total`: that counts
 * sockets the SERVER refused, this counts sockets the CLIENT lost.
 *
 * CARDINALITY IS THE WHOLE DESIGN. Dan asked for an alert on "one player
 * reconnecting more than N times an hour", and the obvious shape - a counter
 * labelled by user id - is 1,300+ series and grows with the player base.
 * Instead the per-user counting happens HERE, in a bounded rolling window,
 * and only three low-cardinality numbers are published:
 *
 *   poker_ws_client_reconnects_total{reason}   how often, and why
 *   poker_ws_clients_reconnecting_badly        how many users are over the line
 *   poker_ws_worst_client_reconnects           the worst single user's count
 *
 * The alert reads the gauges; the counter says what kind of failure it was.
 * No user id ever reaches Prometheus, which also keeps this out of the way
 * of anything that could identify a player from a dashboard.
 *
 * HORSES DO NOT APPEAR HERE AND THAT IS NOT AN EXCLUSION (CLAUDE.md 10.5).
 * A horse has no browser to lose a socket from; this measures a thing that
 * only exists for a human client. It grants horses nothing and denies them
 * nothing.
 */

/** Reasons we accept. Anything else is folded into 'other' - bounded on purpose. */
export const CLIENT_EVENT_REASONS = [
  'auth_failed', // 4401 - the session died under the socket
  'stale', // the client's watchdog tore down a silent socket
  'handshake_timeout', // never reached OPEN
  'closed', // any other close code
  'auto_reload', // TablePage's 20s failsafe actually fired
  'other',
] as const;
export type ClientEventReason = (typeof CLIENT_EVENT_REASONS)[number];

export function normalizeReason(raw: unknown): ClientEventReason {
  const s = String(raw ?? '')
    .toLowerCase()
    .trim();
  return (CLIENT_EVENT_REASONS as readonly string[]).includes(s)
    ? (s as ClientEventReason)
    : 'other';
}

/** One hour, the window Dan's question is asked over. */
export const WINDOW_MS = 60 * 60 * 1000;
/** More than this many reconnects in the window and a user is "reconnecting badly". */
export const BADLY_THRESHOLD = 6;
/**
 * Hard ceiling on tracked users. A flood - or an attempt to make this leak -
 * evicts the oldest rather than growing without bound. 5,000 is four times
 * the platform's entire user count as of 2026-09-05.
 */
export const MAX_TRACKED_USERS = 5000;

const counts = new Map<ClientEventReason, number>();
/** userId -> event timestamps inside the window. */
const perUser = new Map<string, number[]>();

/** Test seam. */
export function _resetClientConnectionEvents(): void {
  counts.clear();
  perUser.clear();
}

/**
 * Record one client-side connection event. Pure bookkeeping: it never throws
 * and never blocks, because it runs on a request path a player is waiting on.
 */
export function recordClientConnectionEvent(
  userId: string,
  reason: ClientEventReason,
  now: number = Date.now()
): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);

  // 'auto_reload' is a symptom report, not a reconnect; it must not inflate
  // the per-user reconnect count the alert reads.
  if (reason === 'auto_reload') return;

  if (!userId) return;
  let arr = perUser.get(userId);
  if (!arr) {
    if (perUser.size >= MAX_TRACKED_USERS) {
      // Evict the user whose most recent event is oldest.
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of perUser) {
        const last = v.length ? v[v.length - 1] : 0;
        if (last < oldestAt) {
          oldestAt = last;
          oldestKey = k;
        }
      }
      if (oldestKey) perUser.delete(oldestKey);
    }
    arr = [];
    perUser.set(userId, arr);
  }
  arr.push(now);
}

/** Drop everything older than the window, and forget users with nothing left. */
function prune(now: number): void {
  const cutoff = now - WINDOW_MS;
  for (const [k, v] of perUser) {
    let i = 0;
    while (i < v.length && v[i] < cutoff) i++;
    if (i > 0) v.splice(0, i);
    if (v.length === 0) perUser.delete(k);
  }
}

export function clientConnectionSummary(now: number = Date.now()): {
  badly: number;
  worst: number;
  trackedUsers: number;
} {
  prune(now);
  let badly = 0;
  let worst = 0;
  for (const v of perUser.values()) {
    if (v.length > worst) worst = v.length;
    if (v.length > BADLY_THRESHOLD) badly++;
  }
  return { badly, worst, trackedUsers: perUser.size };
}

/** Prometheus lines. Always present, so a zero is visible rather than absent. */
export function clientConnectionPrometheusLines(now: number = Date.now()): string[] {
  const { badly, worst } = clientConnectionSummary(now);
  const lines = [
    '# HELP poker_ws_client_reconnects_total Connection events reported by player browsers (label: reason)',
    '# TYPE poker_ws_client_reconnects_total counter',
  ];
  for (const r of CLIENT_EVENT_REASONS) {
    lines.push(`poker_ws_client_reconnects_total{reason="${r}"} ${counts.get(r) ?? 0}`);
  }
  lines.push(
    '# HELP poker_ws_clients_reconnecting_badly Distinct players with more than the threshold of reconnects in the last hour',
    '# TYPE poker_ws_clients_reconnecting_badly gauge',
    `poker_ws_clients_reconnecting_badly ${badly}`,
    '# HELP poker_ws_worst_client_reconnects Reconnects by the worst-affected single player in the last hour',
    '# TYPE poker_ws_worst_client_reconnects gauge',
    `poker_ws_worst_client_reconnects ${worst}`
  );
  return lines;
}
