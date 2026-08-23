/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DEAL-RATE VERIFIER — liveness the engine cannot fake
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 *
 * Every freeze detector in this engine is the engine judging itself.
 * `/health` decides the process is alive from `msSinceProgress()`, which is
 * set by `markProgress()`, which the engine calls about its own work. Docker's
 * healthcheck trusts /health, autoheal trusts Docker, and the host supervisor
 * trusts autoheal. Four layers, one belief underneath all of them.
 *
 * On 2026-08-22 that belief was wrong for six hours. The dealing loop's
 * watchdog concluded 1,603 times that healthy tables were dead and killed them
 * — every running cash table, 22-30 times each — and nothing above it could
 * disagree, because everything above it was reading the same number.
 *
 * A self-check cannot catch a wrong self-assessment. So this one does not ask
 * the engine anything. It asks the DATABASE a question the engine cannot
 * answer wrongly:
 *
 *     I own N tables that should be dealing right now.
 *     How many hands did you actually record for them?
 *
 * If N is meaningful and the answer is zero for several minutes, the process
 * is not dealing, whatever its timers believe. That is true for a wedged event
 * loop, a broken write path, a lie in markProgress, and for failure modes
 * nobody has thought of yet — because it measures the PRODUCT, not a
 * mechanism.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT WILL NOT RESTART A HEALTHY FLEET
 *
 * A false positive here restarts every table at once, so every branch below
 * fails SAFE — silence is only ever concluded from a positive answer:
 *
 *  1. A THROWN QUERY IS NOT EVIDENCE. If the database is unreachable the
 *     counter RESETS. "We could not ask" must never be read as "nothing is
 *     happening" — the same inversion `heartbeatTables` avoids when it returns
 *     [] rather than "we lost every table". Notably a real Supabase outage
 *     happened during this work, at 02:16 UTC, and this is the branch that
 *     keeps it from becoming a fleet-wide restart on top of an outage.
 *
 *  2. IT ONLY JUDGES A FLEET BIG ENOUGH TO JUDGE. Below MIN_TABLES_TO_JUDGE
 *     dealable tables it stands down. One table between hands is not evidence
 *     of anything; forty silent ones are.
 *
 *  3. PAUSED IS NOT DEAD. Tables parked by design — synchronized breaks,
 *     hand-for-hand — are excluded, the same rule the turn watchdog and the
 *     zombie reaper already follow.
 *
 *  4. IT NEEDS SUSTAINED SILENCE. One quiet minute is normal; the counter
 *     needs CONSECUTIVE_TO_DECLARE_DEAD consecutive confirmations, and any
 *     single hand anywhere resets it to zero.
 *
 *  5. IT ONLY REPORTS. It sets a flag on /health. Restarting is Docker's
 *     decision, through the same path it already uses — this adds evidence,
 *     never a new way to kill the process.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

/** How often to ask the database. */
const CHECK_INTERVAL_MS = 60_000;
/** The window each check looks back over. */
const LOOKBACK_MS = 3 * 60_000;
/** Below this many dealable tables, the sample is too small to mean anything. */
const MIN_TABLES_TO_JUDGE = 3;
/** Consecutive confirmed-silent checks before the process is called dead. */
const CONSECUTIVE_TO_DECLARE_DEAD = 3;

export interface DealRateSnapshot {
  /** Consecutive checks where the DB confirmed zero hands on a dealing fleet. */
  silentChecks: number;
  /** True once silence is sustained enough to be a verdict. */
  dbConfirmedDead: boolean;
  /** Dealable tables seen at the last check. */
  tablesExpectedDealing: number;
  /** Hands the DB reported at the last check; null when it could not be asked. */
  handsInWindow: number | null;
  /** When the last check completed. 0 = never run. */
  lastCheckedAt: number;
}

export class DealRateVerifier {
  private timer: ReturnType<typeof setInterval> | null = null;
  private silentChecks = 0;
  private tablesExpectedDealing = 0;
  private handsInWindow: number | null = null;
  private lastCheckedAt = 0;

  /**
   * @param dealingTableIds returns the tables this process believes it owns
   *        AND believes should be dealing right now. The verifier's job is to
   *        find out whether that belief is producing hands.
   */
  constructor(private readonly dealingTableIds: () => string[]) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    (this.timer as { unref?: () => void }).unref?.();
    console.log('[DealRateVerifier] watching the fleet from the database');
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): DealRateSnapshot {
    return {
      silentChecks: this.silentChecks,
      dbConfirmedDead: this.silentChecks >= CONSECUTIVE_TO_DECLARE_DEAD,
      tablesExpectedDealing: this.tablesExpectedDealing,
      handsInWindow: this.handsInWindow,
      lastCheckedAt: this.lastCheckedAt,
    };
  }

  /** Exposed for tests; the timer calls this. */
  async check(): Promise<void> {
    const tableIds = this.dealingTableIds();
    this.tablesExpectedDealing = tableIds.length;

    // Guard 2: too small a fleet to conclude anything from.
    if (tableIds.length < MIN_TABLES_TO_JUDGE) {
      this.silentChecks = 0;
      this.handsInWindow = null;
      this.lastCheckedAt = Date.now();
      return;
    }

    const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
    try {
      const { count, error } = await supabase
        .from('hand_history')
        .select('id', { count: 'exact', head: true })
        .in('table_id', tableIds)
        .gt('created_at', since);

      // Guard 1: an error is NOT evidence of silence.
      if (error) {
        this.silentChecks = 0;
        this.handsInWindow = null;
        this.lastCheckedAt = Date.now();
        return;
      }

      const hands = count ?? 0;
      this.handsInWindow = hands;
      this.lastCheckedAt = Date.now();

      if (hands > 0) {
        // Guard 4: a single hand anywhere clears the alarm.
        this.silentChecks = 0;
        return;
      }

      this.silentChecks++;
      reportError(
        new Error(
          'Database confirms ZERO hands in ' +
            Math.round(LOOKBACK_MS / 60_000) +
            'min across ' +
            tableIds.length +
            ' tables this process says should be dealing (' +
            this.silentChecks +
            '/' +
            CONSECUTIVE_TO_DECLARE_DEAD +
            ')'
        ),
        'DealRateVerifier.fleet_silent',
        { tables: tableIds.length, silentChecks: this.silentChecks }
      );
    } catch (err) {
      // Guard 1 again, for a throw rather than a returned error.
      this.silentChecks = 0;
      this.handsInWindow = null;
      this.lastCheckedAt = Date.now();
      reportError(err, 'DealRateVerifier.check_threw');
    }
  }
}
