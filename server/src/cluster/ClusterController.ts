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
  actions: Array<{ game_id: string; actions: unknown[] }>;
}

export class ClusterController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inTick = false;
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
      actions: [],
    };
    // THE FREEZE (CLAUDE.md 13): a tick moves seats and opens tables; not
    // during the break. Emitted as a summary so the log says it was skipped
    // rather than merely silent.
    if (frozen()) {
      summary.skippedFrozen = true;
      this.lastSummary = summary;
      return summary;
    }
    // A slow tick never overlaps the next one (the same guard the fleet uses).
    if (this.inTick) return this.lastSummary ?? summary;
    this.inTick = true;
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

      for (const g of games) {
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
            continue;
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
          // sits engine-less.
          if (g.enabled && g.main1_table_id && !this.deps.hasEngine(g.main1_table_id)) {
            const seated = await this.deps.seatedCount(g.main1_table_id);
            if (seated > 0) {
              const ok = await this.deps.ensureEngine(g.main1_table_id);
              if (ok) summary.woken++;
            }
          }
        } catch (err) {
          reportError(err, 'ClusterController.game_tick_error', { game_id: g.game_id });
          summary.errors++;
        }
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
