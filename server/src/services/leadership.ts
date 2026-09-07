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
 * the platform outright. But "always fail to leader" is WRONG, and dangerously
 * so, because the table lease fails open too:
 *
 *   database outage -> standby cannot reach the RPC -> it promotes itself
 *                   -> claimTable() also fails open and answers true
 *                   -> TWO engines dealing the same table.
 *
 * That is the exact corruption the leases exist to prevent, and a fail-open
 * standby would manufacture it during every outage. Live evidence this is not
 * hypothetical: with the engine up 48 minutes, `engine_table_leases` had ZERO
 * rows heartbeated in the last 45 seconds -- the lease RPCs were failing on
 * database timeouts while the engine ran perfectly.
 *
 * So the rule is RETAIN THE CURRENT ROLE on any error:
 *
 *   leader,  cannot ask -> stay leader   (never stop the platform)
 *   standby, cannot ask -> stay standby  (never create a second leader)
 *
 * The boot default is 'leader', so a single instance during an outage behaves
 * exactly as it does today.
 */

import { supabase } from './supabase/client.js';
import { INSTANCE_ID, INSTANCE_VERSION } from './tableLease.js';
import { reportError } from './errorReporter.js';

/** Matches the table lease and the RPC default. */
export const LEADERSHIP_STALE_SECONDS = 30;
/** How often leadership is renewed / retried. Must be well under the staleness. */
export const LEADERSHIP_RENEW_MS = 10_000;

export type EngineRole = 'leader' | 'standby';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A FRESH PROCESS HAS NOT BEEN GRANTED ANYTHING, SO IT STARTS AS A STANDBY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This was 'leader'. On 2026-08-23 two containers served engine.smarter.poker
 * at once, BOTH reporting leadership.role='leader', with the fleet split 14
 * tables to 10 — which is the 404 / close-4404 state the Caddyfile exists to
 * prevent, and it ran for hours.
 *
 * The mechanism is this line plus the fail-open below. Every path here is
 * written to "retain, never assume", and the comment on the error branch even
 * says a standby must not promote itself because it cannot reach the database.
 * But a BOOTING process had already assumed it: role was 'leader' from the
 * first instruction, so between process start and the first successful claim
 * it answered /health with 200 and Caddy routed to it. With the database
 * saturated — it was, statement timeouts on every hand insert — that window
 * was not milliseconds, it was as long as the outage.
 *
 * The asymmetry the rest of this file describes only works if the starting
 * point is the humble one: an INCUMBENT holds leadership through a blip
 * because it was granted it and its heartbeat is still fresh; a NEWCOMER holds
 * STANDBY through the same blip because nobody has granted it anything.
 *
 * See PROMOTE_AFTER_UNKNOWN for the one case where a newcomer may still
 * promote itself.
 */
let role: EngineRole = 'standby';

/**
 * A brand-new engine on a database it cannot reach would otherwise stay a
 * standby for ever and serve 503, turning "degraded" into "down" for a
 * single-engine deployment. After this many consecutive claims that resolve
 * to neither a grant nor a known holder, a standby promotes itself.
 *
 * Deliberately consecutive-and-unknown: if any answer named a holder, that
 * holder exists and this instance stays down. Only genuine silence promotes,
 * and only after ~30 seconds of it.
 */
const PROMOTE_AFTER_UNKNOWN = 3;
let unknownStreak = 0;
/**
 * True when GameServer.start() took the standby early-return, meaning this
 * process has NO discovery loop, NO fleet manager and NO stale-data cleanup.
 */
let bootedAsStandby = false;
/** Guards restartIntoLeaderBoot against a second renewal re-entering it. */
let restartScheduled = false;
let holder: string | null = null;
let holderAgeSeconds: number | null = null;
let becameLeaderAt: number | null = null;
let errors = 0;
let timer: ReturnType<typeof setInterval> | null = null;
export type LeadershipShutdownHandler = (reason: string) => Promise<void>;
let shutdownHandler: LeadershipShutdownHandler | null = null;

/**
 * GameServer owns the actual table/tournament teardown; the process entrypoint
 * owns its index-started services and transports. Leadership may request that
 * single authoritative shutdown, but must never release/exit around it.
 */
export function registerLeadershipShutdownHandler(handler: LeadershipShutdownHandler): () => void {
  shutdownHandler = handler;
  return () => {
    if (shutdownHandler === handler) shutdownHandler = null;
  };
}

function hardExitAfterRejectedShutdown(reason: string, error?: unknown): void {
  reportError(
    error instanceof Error
      ? error
      : new Error(`Leadership shutdown could not be certified (${reason})`),
    'Leadership.shutdown_failed'
  );
  // Keep this timer referenced. If the authoritative owner is absent or
  // rejects, allowing Node to fall off the event loop would report a clean
  // exit even though ownership release was never certified.
  setTimeout(() => process.exit(1), 250);
}

function requestAuthoritativeShutdown(reason: string): void {
  if (restartScheduled) return;
  restartScheduled = true;
  stopLeadershipRenewal();
  const handler = shutdownHandler;
  if (!handler) {
    hardExitAfterRejectedShutdown(reason);
    return;
  }
  try {
    void handler(reason).catch((error) => hardExitAfterRejectedShutdown(reason, error));
  } catch (error) {
    hardExitAfterRejectedShutdown(reason, error);
  }
}

/** True unless we positively know another instance holds leadership. */
/**
 * Called by GameServer.start() when it takes the standby early-return.
 *
 * That return is the whole point of a standby - it claims nothing, cleans
 * nothing and hydrates nothing - but it also means the process never started
 * the discovery loops, the horse fleet, or lifecycle monitoring. Every promotion
 * path below flips `role` in memory, and before this existed that produced a
 * LEADER THAT DOES NOTHING: it holds the lease so no healthy instance can take
 * over, reports role 'leader' on /health, and because it has no discovery loop
 * its discoveryLoopStalledMs climbs in lockstep with uptime until liveness goes
 * 'dead' and Docker kills it. Observed in production on 2026-08-24 as
 * up=188s activeTables=0 liveness=dead discStall=188115ms - discStall equal to
 * uptime is the signature: the loop never ran once.
 *
 * The standby branch's own comment already promised "will take the fleet if
 * that lease goes stale". This is the part that makes that true.
 */
export function markBootedAsStandby(): void {
  bootedAsStandby = true;
}

/**
 * A standby cannot become a working leader in place, so it restarts into one.
 *
 * Re-running the boot sequence live is the alternative and it is worse: start()
 * is not idempotent, and the standby contract is specifically that it must not
 * mutate shared state while another instance is live - cleanupStaleData() cashes
 * out seats and resets table counts. Exiting reuses the proven path this file
 * already takes when leadership is LOST, and the supervisor brings the process
 * straight back through the full leader boot.
 */
function restartIntoLeaderBoot(reason: string): void {
  if (!bootedAsStandby) return;
  /**
   * ONCE ONLY. renewLeadership() runs on an interval and the hard-exit backstop
   * below keeps this process alive for up to 5 seconds, so a renewal already in
   * flight when the first promotion landed can re-enter here and schedule a
   * second release plus a second pair of exit timers. Harmless today because
   * the process is leaving either way, but it double-releases the lease and
   * doubles the log, and the next reader of this function should not have to
   * work out whether that matters.
   */
  console.error(
    `[leadership] ${INSTANCE_ID} promoted (${reason}) but booted as a standby, so it has ` +
      'no discovery loop or fleet - exiting so the supervisor restarts it as a real leader.'
  );
  requestAuthoritativeShutdown(`promoted standby requires full leader boot: ${reason}`);
}

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
        console.warn(`[leadership] claim failed (${error.message}) - holding role '${role}'`);
      }
      // Retain, never assume. A standby that promotes itself because it cannot
      // reach the database is how two engines end up on one table.
      //
      // But a FRESH engine now starts as a standby, so "retain" would strand a
      // single-engine deployment at 503 for as long as the database is
      // unreachable. An unanswerable claim counts toward the unknown streak
      // for exactly that case: nobody has been named as holder, so after
      // PROMOTE_AFTER_UNKNOWN attempts this instance takes the fleet rather
      // than leave it unowned. An incumbent leader is unaffected — it is
      // already 'leader' and simply keeps the role.
      unknownStreak++;
      if (role === 'standby' && unknownStreak >= PROMOTE_AFTER_UNKNOWN && holder === null) {
        console.warn(
          `[leadership] ${unknownStreak} claims unanswerable and no holder known - promoting ${INSTANCE_ID}`
        );
        becameLeaderAt = Date.now();
        role = 'leader';
        holder = INSTANCE_ID;
        holderAgeSeconds = 0;
        restartIntoLeaderBoot('claims unanswerable');
      }
      return role;
    }
    const row = (
      data as Array<{ granted: boolean; holder: string | null; holder_age_seconds: number | null }>
    )?.[0];

    /**
     * NO ROW IS NOT A GRANT. This used to read `if (!row || row.granted)`, so
     * an empty result promoted the caller — the same "assume leadership on bad
     * news" that the error branch above is careful not to do. An empty answer
     * means the question did not get answered; it says nothing about whether
     * somebody else is leading.
     *
     * It is counted as unknown rather than simply ignored, so a genuinely
     * unclaimed fleet still gets a leader. See PROMOTE_AFTER_UNKNOWN.
     */
    if (!row) {
      unknownStreak++;
      if (role === 'standby' && unknownStreak >= PROMOTE_AFTER_UNKNOWN) {
        console.warn(
          `[leadership] ${unknownStreak} claims resolved to nobody - promoting ${INSTANCE_ID}`
        );
        becameLeaderAt = Date.now();
        role = 'leader';
        holder = INSTANCE_ID;
        holderAgeSeconds = 0;
        restartIntoLeaderBoot('claims resolved to nobody');
      }
      return role;
    }
    unknownStreak = 0;

    if (row.granted) {
      const wasStandby = role !== 'leader';
      if (wasStandby) {
        console.log(`[leadership] ${INSTANCE_ID} is now the LEADER - taking the fleet`);
        becameLeaderAt = Date.now();
      } else if (becameLeaderAt === null) {
        becameLeaderAt = Date.now();
      }
      role = 'leader';
      holder = INSTANCE_ID;
      holderAgeSeconds = 0;
      /**
       * The ordinary route into the bug, and the most common: a standby simply
       * outlives the previous leader's lease and its next renewal is granted.
       */
      if (wasStandby) restartIntoLeaderBoot('lease granted');
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
        new Error(`Lost engine leadership to ${row.holder} - standing down`),
        'Leadership.lost'
      );
      console.error('[leadership] LOST LEADERSHIP - exiting so we restart as a standby');
      role = 'standby';
      requestAuthoritativeShutdown(`lost leadership to ${row.holder}`);
      return role;
    }
    role = 'standby';
    return role;
  } catch (err) {
    errors++;
    if (errors <= 3) {
      console.warn(
        `[leadership] claim threw (${(err as Error)?.message}) - holding role '${role}'`
      );
    }
    unknownStreak++;
    if (role === 'standby' && unknownStreak >= PROMOTE_AFTER_UNKNOWN && holder === null) {
      console.warn(
        `[leadership] ${unknownStreak} claims threw and no holder known - promoting ${INSTANCE_ID}`
      );
      becameLeaderAt = Date.now();
      role = 'leader';
      holder = INSTANCE_ID;
      holderAgeSeconds = 0;
      restartIntoLeaderBoot('claims threw');
    }
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
  restartScheduled = false;
  bootedAsStandby = false;
  role = 'standby';
  unknownStreak = 0;
  holder = null;
  holderAgeSeconds = null;
  becameLeaderAt = null;
  errors = 0;
  shutdownHandler = null;
  stopLeadershipRenewal();
}
