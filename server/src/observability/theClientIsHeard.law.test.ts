/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: THE CLIENT IS HEARD (Realtime programme Phase 2, 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-09-03 Dan's tables said "Reconnecting To The Table" for twenty-two
 * hours. Every close code, every retry and every twenty-second auto-reload
 * happened inside his browser and reached this platform as nothing, so every
 * dashboard was green while nobody could play. This is the half that was
 * missing.
 *
 * PINS
 *   1. Per-user counting stays OFF Prometheus. Dan asked for "one player
 *      reconnecting more than N times an hour"; a counter labelled by user id
 *      is 1,300+ series and grows with the player base. Only bounded numbers
 *      are exposed, and no user id ever appears in the exposition.
 *   2. The rolling window is real: events age out after an hour, and the
 *      "badly" count is users OVER the threshold, not at it.
 *   3. Memory is bounded. A flood evicts the stalest user rather than growing.
 *   4. 'auto_reload' is a symptom report, not a reconnect: it is counted but
 *      must not inflate the per-user number the alert reads.
 *   5. The ingest route takes the user from the VERIFIED TOKEN, never the
 *      body, so nobody can report events as somebody else.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordClientConnectionEvent,
  clientConnectionSummary,
  clientConnectionPrometheusLines,
  normalizeReason,
  _resetClientConnectionEvents,
  WINDOW_MS,
  BADLY_THRESHOLD,
  MAX_TRACKED_USERS,
  SERVER_THROTTLE_MS,
} from './ClientConnectionEvents.js';
import { handleClientEvent } from '../handlers/clientEvent.js';

beforeEach(() => _resetClientConnectionEvents());

describe('LAW 1 - bounded cardinality, no user id in the exposition', () => {
  it('publishes only bounded series and never a user id', () => {
    for (let i = 0; i < 50; i++) recordClientConnectionEvent(`user-${i}`, 'closed');
    const text = clientConnectionPrometheusLines().join('\n');
    expect(text).toContain('poker_ws_client_reconnects_total{reason="closed"} 50');
    expect(text).toContain('poker_ws_clients_reconnecting_badly');
    expect(text).toContain('poker_ws_worst_client_reconnects');
    expect(text).not.toMatch(/user-\d/);
    expect(text).not.toContain('user_id');
    // Reason labels are a closed set, so the counter cannot grow unbounded.
    const reasons = [...text.matchAll(/reason="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(reasons.length).toBeLessThanOrEqual(8);
  });

  it('an unknown reason folds into "other" rather than minting a label', () => {
    expect(normalizeReason('something-new')).toBe('other');
    expect(normalizeReason(undefined)).toBe('other');
    expect(normalizeReason('AUTH_FAILED')).toBe('auth_failed');
  });
});

describe('LAW 2 - the rolling window is real', () => {
  it('counts a player over the threshold, and forgets them an hour later', () => {
    const t0 = 1_000_000_000;
    // Spaced past SERVER_THROTTLE_MS: since the 2026-09-05 audit the server
    // accepts one event per user per reason per minute, so a burst inside one
    // minute is deliberately a single reconnect (see LAW 6).
    for (let i = 0; i <= BADLY_THRESHOLD; i++) {
      recordClientConnectionEvent('dan', 'closed', t0 + i * SERVER_THROTTLE_MS);
    }
    const now = t0 + BADLY_THRESHOLD * SERVER_THROTTLE_MS;
    const s = clientConnectionSummary(now);
    expect(s.worst).toBe(BADLY_THRESHOLD + 1);
    expect(s.badly, 'strictly more than the threshold counts as badly').toBe(1);

    // An hour and a bit later every one of those has aged out.
    const later = clientConnectionSummary(
      t0 + BADLY_THRESHOLD * SERVER_THROTTLE_MS + WINDOW_MS + 60_000
    );
    expect(later.worst).toBe(0);
    expect(later.badly).toBe(0);
    expect(later.trackedUsers).toBe(0);
  });

  it('exactly at the threshold is not yet "badly"', () => {
    const t0 = 2_000_000_000;
    for (let i = 0; i < BADLY_THRESHOLD; i++) {
      recordClientConnectionEvent('x', 'closed', t0 + i * SERVER_THROTTLE_MS);
    }
    expect(clientConnectionSummary(t0 + BADLY_THRESHOLD * SERVER_THROTTLE_MS).badly).toBe(0);
  });
});

describe('LAW 3 - memory is bounded', () => {
  it('evicts rather than growing past the ceiling', () => {
    const t0 = 3_000_000_000;
    for (let i = 0; i < MAX_TRACKED_USERS + 25; i++) {
      recordClientConnectionEvent(`u${i}`, 'closed', t0 + i);
    }
    expect(clientConnectionSummary(t0 + MAX_TRACKED_USERS + 25).trackedUsers).toBeLessThanOrEqual(
      MAX_TRACKED_USERS
    );
  });
});

describe('LAW 4 - auto_reload is a symptom, not a reconnect', () => {
  it('is counted, but does not inflate the per-user number the alert reads', () => {
    const t0 = 4_000_000_000;
    // Spaced past the server throttle so all twenty are accepted; the point of
    // this law is that auto_reload never becomes a RECONNECT, whatever its count.
    for (let i = 0; i < 20; i++) {
      recordClientConnectionEvent('dan', 'auto_reload', t0 + i * SERVER_THROTTLE_MS);
    }
    const s = clientConnectionSummary(t0 + 20 * SERVER_THROTTLE_MS);
    expect(s.worst, 'auto_reload must not count as a reconnect').toBe(0);
    expect(s.badly).toBe(0);
    expect(clientConnectionPrometheusLines().join('\n')).toContain(
      'poker_ws_client_reconnects_total{reason="auto_reload"} 20'
    );
  });
});

describe('LAW 6 - a player cannot raise an alarm about themselves', () => {
  // AUDIT 2026-09-05. The client throttles itself to one beacon per reason per
  // minute, and trusting that is not enough: the client is the thing being
  // measured. Without a server-side rule, an authenticated player could POST
  // /client-event in a loop and drive poker_ws_clients_reconnecting_badly over
  // the line, paging about themselves. A monitor a player can trigger on
  // demand is worse than no monitor - the first false page teaches everyone to
  // ignore the real one.
  it('a flood from one player counts once per reason per minute', () => {
    const t0 = 5_000_000_000;
    for (let i = 0; i < 500; i++) recordClientConnectionEvent('flooder', 'closed', t0 + i);
    const s = clientConnectionSummary(t0 + 500);
    expect(s.worst, '500 posts must not become 500 reconnects').toBe(1);
    expect(s.badly).toBe(0);
    const text = clientConnectionPrometheusLines(t0 + 500).join('\n');
    expect(text).toContain('poker_ws_client_reconnects_total{reason="closed"} 1');
    expect(text).toMatch(/poker_ws_client_events_throttled_total 499/);
  });

  it('the throttle is per reason, so a genuinely broken client still reports each kind', () => {
    const t0 = 6_000_000_000;
    recordClientConnectionEvent('dan', 'closed', t0);
    recordClientConnectionEvent('dan', 'stale', t0 + 1);
    recordClientConnectionEvent('dan', 'auth_failed', t0 + 2);
    expect(clientConnectionSummary(t0 + 3).worst).toBe(3);
  });

  it('and it lets the same reason through again after the window', () => {
    const t0 = 7_000_000_000;
    recordClientConnectionEvent('dan', 'closed', t0);
    recordClientConnectionEvent('dan', 'closed', t0 + SERVER_THROTTLE_MS - 1);
    expect(clientConnectionSummary(t0 + SERVER_THROTTLE_MS).worst).toBe(1);
    recordClientConnectionEvent('dan', 'closed', t0 + SERVER_THROTTLE_MS + 1);
    expect(clientConnectionSummary(t0 + SERVER_THROTTLE_MS + 2).worst).toBe(2);
  });

  it('a real player over the threshold is still caught (the throttle does not hide them)', () => {
    const t0 = 8_000_000_000;
    // Seven genuine reconnects, each a minute apart - the shape the alert is for.
    for (let i = 0; i <= BADLY_THRESHOLD; i++) {
      recordClientConnectionEvent('unlucky', 'closed', t0 + i * SERVER_THROTTLE_MS);
    }
    const s = clientConnectionSummary(t0 + BADLY_THRESHOLD * SERVER_THROTTLE_MS);
    expect(s.worst).toBe(BADLY_THRESHOLD + 1);
    expect(s.badly).toBe(1);
  });
});

describe('LAW 5 - the user comes from the token, never the body', () => {
  function res() {
    const r: { code?: number; body?: string; headers?: unknown } = {};
    return {
      writeHead: (c: number, h?: unknown) => {
        r.code = c;
        r.headers = h;
      },
      end: (b?: string) => {
        r.body = b;
      },
      _r: r,
    } as never as import('http').ServerResponse & { _r: typeof r };
  }

  it('records against the authenticated user and ignores a spoofed body', async () => {
    const seen: Array<[string, string]> = [];
    const r = res();
    await handleClientEvent(
      {} as never,
      r,
      { reason: 'stale', userId: 'somebody-else', user_id: 'somebody-else' },
      {
        authenticate: async () => ({ userId: 'real-user' }),
        record: ((u: string, reason: string) => seen.push([u, reason])) as never,
      }
    );
    expect(seen).toEqual([['real-user', 'stale']]);
    expect(r._r.code).toBe(204);
  });

  it('unauthenticated is 401 and records nothing', async () => {
    const seen: unknown[] = [];
    const r = res();
    await handleClientEvent(
      {} as never,
      r,
      { reason: 'closed' },
      {
        authenticate: async () => null,
        record: (() => seen.push(1)) as never,
      }
    );
    expect(r._r.code).toBe(401);
    expect(seen).toEqual([]);
  });
});
