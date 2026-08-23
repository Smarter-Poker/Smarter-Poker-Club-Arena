/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENGINE LEADERSHIP — a crash must not take the platform down
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One container runs every table. When it dies, nothing deals until it comes
 * back -- measured at about two minutes on a normal deploy, and unbounded if
 * the boot itself is what is broken.
 *
 * WHY NOT ACTIVE/ACTIVE. Two instances CAN safely split the fleet; the table
 * and tournament leases guarantee one owner each. What they cannot do is serve
 * each other's traffic. Every client connects to one hostname, Caddy sends it
 * to one container, and a request for a table owned by the other answers
 * `404 Table engine not found` (POST /action) or close 4404 (the websocket).
 *
 * That was not theory. On 2026-08-23 a second container held 14 of 44 tables
 * that no player could reach -- invisible only because horses are server-side
 * and kept dealing them perfectly. A human sitting down would have found a dead
 * table roughly one time in three.
 *
 * Making active/active work needs owner-aware routing, which means proxying
 * player websocket frames through a second hop in the hottest path in the
 * product. It buys throughput headroom, which was never the problem.
 *
 * So: LEADER/STANDBY. Exactly one instance owns everything. The standby holds
 * no tables and serves no traffic, and takes the whole fleet when the leader's
 * lease goes stale. Recovery is the staleness window, not a cold start. No
 * routing, no proxy, no client change.
 *
 * ── HOW A STANDBY STAYS OUT OF THE WAY ──────────────────────────────────────
 *
 * It never calls discovery, so it claims no table and no tournament, and it
 * reports 503 on /health. Caddy's active health check then marks it down and
 * sends every request to the leader; Docker's healthcheck reads `liveness`,
 * which is 'standby' rather than 'dead', so the container is NOT restarted.
 * Two different consumers of the same endpoint, each getting the right answer.
 *
 * ── FAIL-OPEN, LIKE EVERY OTHER LEASE HERE ──────────────────────────────────
 *
 * A leadership check gates whether ANY table deals, so a bug here could stop
 * the platform outright. Therefore, on any RPC error the answer is "carry on
 * as leader". A database blip must never leave the fleet with nobody running
 * it -- and the worst case of being wrong is the state we are in today anyway,
 * one instance doing everything.
 */

import { supabase } from './supabase/client.js';
import { INSTANCE_ID, INSTANCE_VERSION } from './tableLease.js';
import { reportError } from './errorReporter.js';

/** Matches the table lease and the RPC default. */
export const LEADERSHIP_STALE_SECONDS = 30;
/** How often leadership is renewed / retried. Must be well under the staleness. */
export const LEADERSHIP_RENEW_MS = 10_000;

export type EngineRole = 'leader' | 'standby';

let role: EngineRole = 'leader';
let holder: string | null = null;
let holderAgeSeconds: number | null = null;
let becameLeaderAt: number | null = null;
let errors = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** True unless we positively know another instance holds leadership. */
export function isLeader(): boolean {
  return role === 'leader';
}

export function leadershipDiagnostics() {
  return {
    instanceId: INSTANCE_ID,
    role,
    holder,
    holderAgeSeconds,
    becameLeaderAt,
    errors,
  };
}

/**
 * Claim or renew. Returns the resulting role.
 *
 * Exported for tests and for the one-shot call at boot, before the interval
 * starts -- a standby must know what it is BEFORE it would otherwise start
 * discovery.
 */
export async function renewLeadership(): Promise<EngineRole> {
  try {
    const { data, error } = await supabase.rpc('claim_engine_leadership', {
      p_instance_id: INSTANCE_ID,
      p_version: INSTANCE_VERSION,
      p_stale_seconds: LEADERSHIP_STALE_SECONDS,
    });
    if (error) {
      errors++;
      if (errors <= 3) {
        console.warn(`[leadership] claim failed (${error.message}) — carrying on as leader`);
      }
      // Fail open: nobody running the fleet is the worst outcome available.
      role = 'leader';
      return role;
    }
    const row = (
      data as Array<{ granted: boolean; holder: string | null; holder_age_seconds: number | null }>
    )?.[0];
    if (!row || row.granted) {
      if (role !== 'leader') {
        console.log(`[leadership] ${INSTANCE_ID} is now the LEADER — taking the fleet`);
        becameLeaderAt = Date.now();
      } else if (becameLeaderAt === null) {
        becameLeaderAt = Date.now();
      }
      role = 'leader';
      holder = INSTANCE_ID;
      holderAgeSeconds = 0;
      return role;
    }
    holder = row.holder;
    holderAgeSeconds = row.holder_age_seconds;
    if (role === 'leader' && becameLeaderAt !== null) {
      /**
       * We were leading and lost it. That can only happen if our own heartbeat
       * lapsed past the staleness window, which means this process was wedged
       * or paused long enough for another instance to take over. Two engines
       * believing they lead is the one outcome worse than a restart, and our
       * in-memory state is already suspect, so stand down hard and let the
       * supervisor bring us back as a standby.
       */
      reportError(
        new Error(`Lost engine leadership to ${row.holder} — standing down`),
        'Leadership.lost'
      );
      console.error('[leadership] LOST LEADERSHIP — exiting so we restart as a standby');
      role = 'standby';
      setTimeout(() => process.exit(0), 250).unref?.();
      return role;
    }
    role = 'standby';
    return role;
  } catch (err) {
    errors++;
    if (errors <= 3) {
      console.warn(`[leadership] claim threw (${(err as Error)?.message}) — carrying on as leader`);
    }
    role = 'leader';
    return role;
  }
}

export function startLeadershipRenewal(): void {
  if (timer) return;
  timer = setInterval(() => void renewLeadership(), LEADERSHIP_RENEW_MS);
  (timer as { unref?: () => void }).unref?.();
}

export function stopLeadershipRenewal(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** Hand leadership back on a clean shutdown so the standby promotes at once. */
export async function releaseLeadership(): Promise<void> {
  try {
    await supabase.rpc('release_engine_leadership', { p_instance_id: INSTANCE_ID });
  } catch {
    // Shutdown path: worst case the standby waits out the staleness window.
  }
}

/** Test seam. */
export function __resetLeadership(): void {
  role = 'leader';
  holder = null;
  holderAgeSeconds = null;
  becameLeaderAt = null;
  errors = 0;
  stopLeadershipRenewal();
}
