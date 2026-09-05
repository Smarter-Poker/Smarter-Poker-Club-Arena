/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE CLUSTER CONTROLLER (Operation Table Stakes, Slice 6 - OPORD 1.4
 *  section 18). 2026-09-05.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * "How do tables open and close with no human?" This. Every 5 s on the
 * leader it makes ONE call, fn_cash_clusters_tick_all(eligible_by_main1), and
 * the SQL runs the worklist itself: for every due game it calls
 * fn_cash_cluster_tick(game_id, eligible_horses), which locks the game row and
 * derives every decision from rows - must-move plans, a feeder opening, a
 * feeder promoted, a table breaking, roles renumbered, live or dormant. The
 * SQL is the brain; this file is the clock and the two things only the engine
 * side knows:
 *
 *   1. how many HORSES could sit at each Main 1 this cycle (a horse is a
 *      buyer, Law 10.5) - the fleet's whole census, keyed by table id;
 *   2. that a Main 1 with a seat needs a DEALER - woken through
 *      ensureCashTableEngine, the same door the Start button uses.
 *
 * ONE RPC PER PASS (2026-09-05). The first cut made one worklist RPC and then
 * one tick RPC per game through an eight-wide pool: 149 games, 12 passes a
 * minute, ~86,000 PostgREST round trips an hour, nearly all of which read the
 * rows and changed nothing. The pass is now one call (~0.7 s server-side for
 * 120 games, measured before applying) and the worklist decides which games
 * are due: a live, disabled, occupied or horse-wanted game every pass, a
 * dormant empty game every 30 s.
 *
 * A WAKE (2026-09-05). The engine already runs every table, so it tells the
 * controller when a seat changes or a hand ends on a cluster table:
 * `wakeCluster(gameId)`, in-process, no LISTEN/NOTIFY. The controller then
 * ticks THAT game once, through the per-game RPC, debounced 500 ms and
 * coalesced, so a game reacts inside a second rather than at the next pass -
 * and a dormant game's 30 s rest never delays a seat that just filled. A wake
 * is a no-op on a non-leader (no controller running) and never throws into
 * the engine.
 *
 * Nothing is remembered between ticks that decides anything. A tick that
 * throws is reported and the next tick starts from rows. Two leaders cannot
 * both act: every mutation is inside the SQL row lock and idempotent. The
 * maintenance freeze is honoured twice - here before any I/O (CLAUDE.md 13.5)
 * and again inside the SQL.
 *
 * Pre-cutover scope: cash_games rows with must_move = true only. The fleet's
 * DEFAULT_TABLES and every hand-made table (R9 manual) are not touched.
 */

import { supabase } from '../services/supabase.js';
import { reportError } from '../services/errorReporter.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';

export const CLUSTER_TICK_MS = 5000;

/**
 * A wake is held this long so a burst of seat changes on one game (a feeder
 * filling from the lobby, a break moving four players at one hand boundary)
 * becomes one tick, not four. Half a second is well under the 5 s pass and
 * still far quicker than a human notices.
 */
export const CLUSTER_WAKE_DEBOUNCE_MS = 500;

/**
 * How long a dormant, enabled, EMPTY game with no horse eligible may go
 * between ticks. The decision lives in the SQL worklist
 * (fn_cash_clusters_tick_all); this constant is the documented value the law
 * test pins against the migration. Anything seated, any horse wanted, or a
 * wake bypasses it.
 */
export const CLUSTER_DORMANT_REST_S = 30;

/**
 * A pass still open after this long is reported and the latch released. A real
 * pass is one RPC, well under a second. The only honest way past two minutes
 * is a database outage where the RPC hangs past the client's 15 s deadline -
 * and that is worth a `tick_stalled` report too; the overlapping pass it
 * allows is safe because every game's tick locks its own row.
 */
export const CLUSTER_TICK_STALL_MS = 120_000;

export interface ClusterRow {
  game_id: string;
  club_id?: string;
  main1_table_id: string | null;
  state?: string;
  enabled: boolean;
}

export interface ClusterTickResult {
  ok: boolean;
  game_id?: string;
  skipped?: string;
  reason?: string;
  seated_total?: number;
  tables?: number;
  buyers?: number;
  actions?: unknown[];
}

/** One entry of fn_cash_clusters_tick_all's `results`. */
export interface ClusterTickAllEntry {
  game_id: string;
  main1_table_id: string | null;
  enabled: boolean;
  result?: ClusterTickResult;
  error?: { sqlstate?: string; message?: string };
}

export interface ClusterTickAllResult {
  ok: boolean;
  skipped?: string;
  games: number;
  ticked: number;
  errors: number;
  rested: number;
  results: ClusterTickAllEntry[];
}

/** What the controller needs from the outside; injected so it can be tested. */
export interface ClusterControllerDeps {
  /** How many horses could sit at this table this cycle (fleet's last census). */
  eligibleHorseCount(tableId: string): number;
  /** The whole census, table id -> eligible horses. Sent with every pass. */
  eligibleCounts(): ReadonlyMap<string, number>;
  /** Give a table a dealer if it has none. Returns true when an engine exists. */
  ensureEngine(tableId: string): Promise<boolean>;
  /** Which tables already have an engine in this process. */
  hasEngine(tableId: string): boolean;
  /** Seated count at a table, from rows; the wake decision needs it. */
  seatedCount(tableId: string): Promise<number>;
  /** Injected for tests. */
  frozen?: () => boolean;
  rpc?: typeof supabase.rpc;
}

export interface ClusterTickSummary {
  games: number;
  ticked: number;
  /** Games the worklist let rest this pass (dormant, empty, no horse wanted). */
  rested: number;
  woken: number;
  errors: number;
  skippedFrozen: boolean;
  /** PostgREST round trips this pass made. The law says one. */
  rpcs: number;
  /** Wall time of the pass, ms. Logged when it exceeds the cadence. */
  elapsedMs: number;
  actions: Array<{ game_id: string; actions: unknown[] }>;
}

/**
 * The controller this process is running, if it is the leader. `wakeCluster`
 * reaches it from the engine without the engine holding a reference.
 */
let activeController: ClusterController | null = null;

/**
 * Tell the running controller a game's seats changed (or a hand ended) so it
 * ticks that game now instead of at the next pass. A no-op when no controller
 * is running in this process (non-leader). NEVER throws: this is called from
 * inside the dealing loop and a controller fault must not become a table fault.
 */
export function wakeCluster(gameId: string): void {
  try {
    activeController?.wake(gameId);
  } catch (err) {
    reportError(err, 'ClusterController.wake_threw', { game_id: gameId });
  }
}

export class ClusterController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inTick = false;
  private tickStartedAt = 0;
  private lastSummary: ClusterTickSummary | null = null;
  /** Debounce handles, one per game with a wake pending. */
  private wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Wakes that reached the RPC (for the summary line and tests). */
  private wakesFiredCount = 0;
  private wakesCoalescedCount = 0;
  /**
   * The Main 1 and enabled flag of each game as the LAST PASS reported them.
   * A hint, not a decision: the wake needs the game's Main 1 to look up its
   * horse demand and to wake its dealer, and the per-game RPC is keyed by
   * game. Missing (a game the controller has not seen yet) means the wake
   * ticks with zero horses and leaves the dealer to the next pass.
   */
  private rowByGame = new Map<string, { main1_table_id: string | null; enabled: boolean }>();

  constructor(private readonly deps: ClusterControllerDeps) {}

  start(): void {
    if (this.timer) return;
    this.running = true;
    activeController = this;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => reportError(err, 'ClusterController.tick_error'));
    }, CLUSTER_TICK_MS);
    console.log(`[ClusterController] Running - every ${CLUSTER_TICK_MS / 1000}s on the leader`);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.wakeTimers.values()) clearTimeout(t);
    this.wakeTimers.clear();
    if (activeController === this) activeController = null;
  }

  get summary(): ClusterTickSummary | null {
    return this.lastSummary;
  }

  get wakeStats(): { fired: number; coalesced: number; pending: number } {
    return {
      fired: this.wakesFiredCount,
      coalesced: this.wakesCoalescedCount,
      pending: this.wakeTimers.size,
    };
  }

  /**
   * A seat changed or a hand ended on one of this game's tables. Tick it
   * soon - once, however many times this is called inside the debounce
   * window. No-op unless the controller is running (leader only).
   */
  wake(gameId: string): void {
    if (!this.running || !gameId) return;
    if (this.wakeTimers.has(gameId)) {
      this.wakesCoalescedCount++;
      return;
    }
    const handle = setTimeout(() => {
      this.wakeTimers.delete(gameId);
      void this.tickGame(gameId).catch((err) =>
        reportError(err, 'ClusterController.wake_tick_error', { game_id: gameId })
      );
    }, CLUSTER_WAKE_DEBOUNCE_MS);
    this.wakeTimers.set(gameId, handle);
  }

  /**
   * One game, now, through the per-game RPC. The frozen check is the same as
   * the pass's; the SQL repeats it. Never overlaps itself for the same game
   * because the debounce map holds one handle per game.
   */
  private async tickGame(gameId: string): Promise<void> {
    const frozen = this.deps.frozen ?? isMaintenanceFrozen;
    if (frozen() || !this.running) return;
    const rpc = this.deps.rpc ?? supabase.rpc.bind(supabase);
    const row = this.rowByGame.get(gameId);
    // A horse is a buyer. The fleet counted, this cycle, how many could sit
    // at Main 1; that is the game's horse demand.
    const eligible = row?.main1_table_id ? this.deps.eligibleHorseCount(row.main1_table_id) : 0;
    this.wakesFiredCount++;
    const { data, error } = await rpc('fn_cash_cluster_tick', {
      p_game_id: gameId,
      p_eligible_horses: eligible,
    });
    if (error) {
      reportError(error, 'ClusterController.wake_rpc_failed', { game_id: gameId });
      return;
    }
    const result = (data ?? {}) as ClusterTickResult;
    const summary = this.emptySummary();
    await this.afterGameTick(
      {
        game_id: gameId,
        main1_table_id: row?.main1_table_id ?? null,
        enabled: row?.enabled ?? false,
      },
      result,
      summary,
      'wake'
    );
  }

  private emptySummary(): ClusterTickSummary {
    return {
      games: 0,
      ticked: 0,
      rested: 0,
      woken: 0,
      errors: 0,
      skippedFrozen: false,
      rpcs: 0,
      elapsedMs: 0,
      actions: [],
    };
  }

  /**
   * One pass over every must-move game: ONE RPC. Public so a test (and the
   * acceptance probe) can drive it without the clock.
   */
  async tick(): Promise<ClusterTickSummary> {
    const frozen = this.deps.frozen ?? isMaintenanceFrozen;
    const summary = this.emptySummary();
    const startedAt = Date.now();
    // THE FREEZE (CLAUDE.md 13): a tick moves seats and opens tables; not
    // during the break. Emitted as a summary so the log says it was skipped
    // rather than merely silent.
    if (frozen()) {
      summary.skippedFrozen = true;
      this.lastSummary = summary;
      return summary;
    }
    // A slow tick never overlaps the next one (the same guard the fleet uses)
    // - but a STUCK one is released, loudly. Every await inside a pass is
    // bounded (the Supabase client times out at 15 s and the wake is not
    // awaited), so a pass that is still open past the stall ceiling is a
    // defect, and the right response to a defect is to keep ticking and say
    // so, not to go silent forever. Each game's tick locks its own row, so an
    // overlapping pass is safe.
    if (this.inTick) {
      const heldMs = Date.now() - this.tickStartedAt;
      if (heldMs < CLUSTER_TICK_STALL_MS) return this.lastSummary ?? summary;
      reportError(
        new Error(`ClusterController pass still open after ${heldMs}ms; releasing the latch`),
        'ClusterController.tick_stalled'
      );
    }
    this.inTick = true;
    this.tickStartedAt = startedAt;
    try {
      const rpc = this.deps.rpc ?? supabase.rpc.bind(supabase);

      // The fleet's whole census, keyed by table id. Only the tables a horse
      // could actually sit at are sent; the SQL reads a missing key as 0.
      const eligible: Record<string, number> = {};
      for (const [tableId, n] of this.deps.eligibleCounts()) {
        if (n > 0) eligible[tableId] = n;
      }

      summary.rpcs++;
      const { data, error } = await rpc('fn_cash_clusters_tick_all', { p_eligible: eligible });
      if (error) {
        reportError(error, 'ClusterController.pass_failed');
        summary.errors++;
        summary.elapsedMs = Date.now() - startedAt;
        this.lastSummary = summary;
        return summary;
      }
      const pass = (data ?? {}) as Partial<ClusterTickAllResult>;
      if (pass.skipped === 'frozen') {
        // The SQL saw the break start between our check and its own.
        summary.skippedFrozen = true;
        this.lastSummary = summary;
        return summary;
      }
      summary.games = Number(pass.games ?? 0);
      summary.rested = Number(pass.rested ?? 0);
      const results = Array.isArray(pass.results) ? pass.results : [];

      for (const entry of results) {
        if (!entry || typeof entry.game_id !== 'string') continue;
        const row: ClusterRow = {
          game_id: entry.game_id,
          main1_table_id: entry.main1_table_id ?? null,
          enabled: entry.enabled === true,
        };
        this.rowByGame.set(row.game_id, {
          main1_table_id: row.main1_table_id,
          enabled: row.enabled,
        });
        if (entry.error) {
          // The SQL caught it, rolled that game back, wrote the
          // controller_tick_error row and carried on. Reported here too so
          // Sentry sees the same thing the table does.
          reportError(
            new Error(
              `fn_cash_cluster_tick failed for ${row.game_id.slice(0, 8)}: ${entry.error.sqlstate ?? '?'} ${entry.error.message ?? ''}`
            ),
            'ClusterController.tick_rpc_failed',
            { game_id: row.game_id, sqlstate: entry.error.sqlstate }
          );
          summary.errors++;
          continue;
        }
        summary.ticked++;
        await this.afterGameTick(row, (entry.result ?? {}) as ClusterTickResult, summary, 'pass');
      }

      summary.elapsedMs = Date.now() - startedAt;
      if (summary.elapsedMs > CLUSTER_TICK_MS) {
        console.warn(
          `[ClusterController] pass over ${summary.games} games took ${summary.elapsedMs}ms (cadence ${CLUSTER_TICK_MS}ms)`
        );
      }
      this.lastSummary = summary;
      return summary;
    } finally {
      this.inTick = false;
    }
  }

  /**
   * What happens after one game's tick has returned, whether it came back in
   * the pass or from a wake: log the actions, and 18.4 WAKE the dealer.
   */
  private async afterGameTick(
    g: ClusterRow,
    result: ClusterTickResult,
    summary: ClusterTickSummary,
    via: 'pass' | 'wake'
  ): Promise<void> {
    try {
      if (Array.isArray(result.actions) && result.actions.length > 0) {
        summary.actions.push({ game_id: g.game_id, actions: result.actions });
        console.log(
          `[ClusterController] ${g.game_id.slice(0, 8)} ${via === 'wake' ? '(wake) ' : ''}${JSON.stringify(result.actions)}`
        );
      }

      // 18.4 WAKE: a Main 1 with anyone seated needs a dealer. The
      // discovery loop only adopts a table with a seat row, and only every
      // 5 s; the Start button wakes it from the browser. The controller
      // wakes it from here so a game that filled from the lobby never
      // sits engine-less. The tick already said whether anyone is seated
      // in the game at all, so an empty game costs no second query.
      if (
        g.enabled &&
        g.main1_table_id &&
        Number(result.seated_total ?? 0) > 0 &&
        !this.deps.hasEngine(g.main1_table_id)
      ) {
        const seated = await this.deps.seatedCount(g.main1_table_id);
        if (seated > 0) {
          // NEVER AWAITED. ensureEngine resolves when engine.start()
          // resolves, and start() returns only once the table has enough
          // players to deal - a Main 1 with one player seated keeps that
          // promise open until a second one sits. Live 2026-09-04 22:10
          // UTC: one such wake parked a worker, the pass never ended, and
          // the inTick latch silenced every tick after it for 11 minutes
          // with no error and no log line. The engine is in the map from
          // the moment it is constructed, so hasEngine() is true on the
          // next pass and nothing is started twice.
          const tableId = g.main1_table_id;
          summary.woken++;
          void this.deps
            .ensureEngine(tableId)
            .then((ok) => {
              if (!ok)
                console.warn(
                  `[ClusterController] ${g.game_id.slice(0, 8)} wake refused for ${tableId.slice(0, 8)}`
                );
            })
            .catch((err) =>
              reportError(err, 'ClusterController.wake_failed', {
                game_id: g.game_id,
                table_id: tableId,
              })
            );
        }
      }
    } catch (err) {
      reportError(err, 'ClusterController.game_tick_error', { game_id: g.game_id });
      summary.errors++;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }
}
