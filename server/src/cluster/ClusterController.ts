/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE CLUSTER CONTROLLER (Operation Table Stakes, Slice 6 - OPORD 1.4
 *  section 18). 2026-09-05.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * "How do tables open and close with no human?" This. Every 5 s on the
 * leader, for every enabled must-move game, it calls ONE SQL function,
 * fn_cash_cluster_tick(game_id, eligible_horses), which locks the game row and
 * derives every decision from rows: must-move plans, a feeder opening, a
 * feeder promoted, a table breaking, roles renumbered, live or dormant. The
 * SQL is the brain; this file is the clock and the two things only the engine
 * side knows:
 *
 *   1. how many HORSES could sit at the game this cycle (a horse is a buyer,
 *      Law 10.5) - asked of the fleet, which computed it to seed;
 *   2. that a Main 1 with a seat needs a DEALER - woken through
 *      ensureCashTableEngine, the same door the Start button uses.
 *
 * Nothing is remembered between ticks. A tick that throws is reported and the
 * next tick starts from rows. Two leaders cannot both act: every mutation is
 * inside the SQL row lock and idempotent. The maintenance freeze is honoured
 * twice - here before any I/O (CLAUDE.md 13.5) and again inside the SQL.
 *
 * Pre-cutover scope: cash_games rows with must_move = true only. The fleet's
 * DEFAULT_TABLES and every hand-made table (R9 manual) are not touched.
 */

import { supabase } from '../services/supabase.js';
import { reportError } from '../services/errorReporter.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';

export const CLUSTER_TICK_MS = 5000;

/**
 * Games ticked at once. Measured live 2026-09-05 00:08 UTC: one tick RPC is
 * ~0.85 s from Hetzner (PostgREST round trip plus the census), so 78 games
 * one after another was a 66 s pass - a "5-second" controller that noticed a
 * seat opening a minute late. Every game's tick locks only its own row and
 * touches only its own tables, so eight in flight share nothing. Eight keeps
 * a pass at ~10 s and the connection pool untroubled.
 */
export const CLUSTER_TICK_CONCURRENCY = 8;

/**
 * A pass still open after this long is reported and the latch released. A real
 * pass is ~10 s (78 games, eight in flight). The only honest way past two
 * minutes is a database outage where every RPC hits the client's 15 s
 * deadline (ceil(games / concurrency) x 2 x 15 s) - and that is worth a
 * `tick_stalled` report too; the overlapping pass it allows is safe because
 * every game's tick locks its own row.
 */
export const CLUSTER_TICK_STALL_MS = 120_000;

export interface ClusterRow {
  game_id: string;
  club_id: string;
  main1_table_id: string | null;
  state: string;
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

/** What the controller needs from the outside; injected so it can be tested. */
export interface ClusterControllerDeps {
  /** How many horses could sit at this table this cycle (fleet's last census). */
  eligibleHorseCount(tableId: string): number;
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
  woken: number;
  errors: number;
  skippedFrozen: boolean;
  /** Wall time of the pass, ms. Logged when it exceeds the cadence. */
  elapsedMs: number;
  actions: Array<{ game_id: string; actions: unknown[] }>;
}

export class ClusterController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inTick = false;
  private tickStartedAt = 0;
  private lastSummary: ClusterTickSummary | null = null;

  constructor(private readonly deps: ClusterControllerDeps) {}

  start(): void {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => reportError(err, 'ClusterController.tick_error'));
    }, CLUSTER_TICK_MS);
    console.log(`[ClusterController] Running - every ${CLUSTER_TICK_MS / 1000}s on the leader`);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get summary(): ClusterTickSummary | null {
    return this.lastSummary;
  }

  /**
   * One pass over every must-move game. Public so a test (and the acceptance
   * probe) can drive it without the clock.
   */
  async tick(): Promise<ClusterTickSummary> {
    const frozen = this.deps.frozen ?? isMaintenanceFrozen;
    const summary: ClusterTickSummary = {
      games: 0,
      ticked: 0,
      woken: 0,
      errors: 0,
      skippedFrozen: false,
      elapsedMs: 0,
      actions: [],
    };
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
      const { data, error } = await rpc('fn_cash_clusters_to_tick');
      if (error) {
        reportError(error, 'ClusterController.worklist_failed');
        summary.errors++;
        return summary;
      }
      const games = (data ?? []) as ClusterRow[];
      summary.games = games.length;

      const tickOne = async (g: ClusterRow): Promise<void> => {
        try {
          // A horse is a buyer. The fleet counted, this cycle, how many could
          // sit at Main 1; that is the game's horse demand.
          const eligible = g.main1_table_id ? this.deps.eligibleHorseCount(g.main1_table_id) : 0;
          const { data: res, error: tickErr } = await rpc('fn_cash_cluster_tick', {
            p_game_id: g.game_id,
            p_eligible_horses: eligible,
          });
          if (tickErr) {
            reportError(tickErr, 'ClusterController.tick_rpc_failed', { game_id: g.game_id });
            summary.errors++;
            return;
          }
          const result = (res ?? {}) as ClusterTickResult;
          summary.ticked++;
          if (Array.isArray(result.actions) && result.actions.length > 0) {
            summary.actions.push({ game_id: g.game_id, actions: result.actions });
            console.log(
              `[ClusterController] ${g.game_id.slice(0, 8)} ${JSON.stringify(result.actions)}`
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
      };

      // A bounded pool: CLUSTER_TICK_CONCURRENCY games in flight, the rest
      // queued, every game ticked exactly once per pass.
      let next = 0;
      const workers = Array.from(
        { length: Math.min(CLUSTER_TICK_CONCURRENCY, games.length) },
        async () => {
          while (next < games.length) {
            const g = games[next++];
            await tickOne(g);
          }
        }
      );
      await Promise.all(workers);

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

  get isRunning(): boolean {
    return this.running;
  }
}
