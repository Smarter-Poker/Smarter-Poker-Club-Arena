/**
 * HOW LONG TO WAIT BEFORE REBUILDING A TABLE'S ENGINE AGAIN (2026-10-17).
 *
 * Both engine owners (GameServer for cash, TournamentManager for its tables)
 * already backed off between rebuilds: 250 ms, doubling, capped at 15 s. Both
 * forgot the backoff at the wrong moment. The attempt count was cleared when
 * a replacement reported READY - and ready is the EARLY edge: the table row
 * and the waiting snapshot are loaded, the table can still be minutes from
 * dealing and seconds from failing. A table that died after ready was
 * therefore always on its first attempt, 250 ms, for ever.
 *
 * Measured on production, 2026-10-13 13:16-13:53Z: 35 tournament tables,
 * each rebuilt about every 1.8 s for 37 minutes - 1,100 to 1,190 engine kills
 * a minute, every one `start_failed:start_wait_for_players`, every one on
 * attempt 1. 2026-10-13 07:18-07:36Z was the same loop on 17 tables at
 * `start_load_table`, 130 to 150 kills a minute.
 *
 * This record is the one place a table's failure streak lives, and it ends
 * the streak only on proof: a replacement that stayed up STABLE_MS after
 * ready. It is driven only by the owner's own causal edges - a generation
 * failed, a generation became ready - and it never schedules anything itself.
 *
 * It is deliberately separate from the owners' existing `...RecoveryAttempts`
 * maps. TournamentManager reads that map's KEYS as "a replacement is in
 * flight" (the hand-for-hand roster and the stage-end gate both do), so
 * keeping an entry there after ready would hold a stage end on a healthy
 * table. Those maps keep their meaning; the backoff lives here.
 */

type Streak = {
  /** Generations of this table that failed since it last proved stable. */
  failures: number;
  /** When the latest replacement became ready; null while none has. */
  readyAtMs: number | null;
};

export class TableRestartBackoff {
  /** First rebuild after a failure: fast, a player barely notices. */
  static readonly BASE_MS = 250;
  /** A table that keeps failing is retried at most this far apart. */
  static readonly CAP_MS = 30_000;
  /** A replacement that stays up this long after ready ends the streak. */
  static readonly STABLE_MS = 120_000;

  private readonly streaks = new Map<string, Streak>();
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: { now?: () => number; random?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /**
   * Has this table failed and NOT yet proved a replacement stable? A runtime
   * death on such a table is a repeat, and waits its turn instead of being
   * rebuilt on the spot.
   */
  isRepeating(tableId: string): boolean {
    const streak = this.streaks.get(tableId);
    if (!streak) return false;
    return (
      streak.readyAtMs === null || this.now() - streak.readyAtMs < TableRestartBackoff.STABLE_MS
    );
  }

  /**
   * One generation of this table failed. Returns how many have failed in this
   * streak and how long to wait before building the next one.
   *
   * The wait doubles per failure up to CAP_MS, and is drawn between half and
   * all of that ceiling: a slow database fails every table in the same
   * second, and identical waits would send them all back in the same second.
   */
  recordFailure(tableId: string): { failures: number; delayMs: number } {
    const previous = this.streaks.get(tableId);
    const stable =
      previous !== undefined &&
      previous.readyAtMs !== null &&
      this.now() - previous.readyAtMs >= TableRestartBackoff.STABLE_MS;
    const failures = (previous && !stable ? previous.failures : 0) + 1;
    this.streaks.set(tableId, { failures, readyAtMs: null });
    const ceiling = Math.min(
      TableRestartBackoff.BASE_MS * 2 ** Math.min(failures - 1, 16),
      TableRestartBackoff.CAP_MS
    );
    const draw = Math.min(Math.max(this.random(), 0), 1);
    return { failures, delayMs: Math.round(ceiling / 2 + (ceiling / 2) * draw) };
  }

  /** A replacement for this table became ready; its stability clock starts. */
  recordReady(tableId: string): void {
    const streak = this.streaks.get(tableId);
    if (streak) streak.readyAtMs = this.now();
  }

  /** The table is no longer this owner's (closed, retired, owner stopping). */
  forget(tableId: string): void {
    this.streaks.delete(tableId);
  }

  clear(): void {
    this.streaks.clear();
  }

  /** Read-only view for /health and tests. */
  failuresFor(tableId: string): number {
    return this.streaks.get(tableId)?.failures ?? 0;
  }
}
