/**
 * TournamentManager, layer 3/3 — table balancing, satellites, late reg.
 *
 * Split out of the 4,096-line `src/GameServer.ts` monolith on 2026-07-28
 * (engine audit D21 — god-class decomposition). Behavior is preserved
 * line-for-line: the only edits are module boundaries, `private` widened to
 * `protected` where a member is reached across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { supabase } from '../services/supabase.js';
import { type BalancerTable, type MoveInstruction } from '../engine/TableBalancer.js';
import type { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { reportError } from '../services/errorReporter.js';
import { selectInChunks } from '../services/supabase/chunkedIn.js';
import { tableStateHub } from '../transport/TableStateHub.js';
import { TournamentManagerEliminations } from './TournamentManagerEliminations.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { mayTakeSeat } from './seatClaim.js';
import {
  planOrphanReseats,
  planSeatlessReseats,
  describeUnmovableOrphans,
  type OrphanTableRow,
  type OrphanSeatRow,
  type SeatlessRosterRow,
} from './orphanedSeatRepair.js';

interface LateRegistrationCapacityResult {
  ok: boolean;
  created: boolean;
  reason?: string;
  table_id?: string;
  table_number?: number;
  table_capacity?: number;
  active_entries?: number;
  remaining_deficit?: number;
  pending_table_ids?: string[];
  pending_table_count?: number;
}

interface TournamentTableCloseResult {
  ok?: boolean;
  reason?: string;
  table_id?: string;
  tournament_id?: string;
  status?: string;
  current_players?: number;
}

export class TournamentManager extends TournamentManagerEliminations {
  /**
   * Read a complete balancer picture in bounded ID-list chunks. The former
   * implementation issued two sequential requests per table, twice per pass;
   * a four-slot scheduler therefore still let four 1,000-table tournaments
   * hold every physical slot for minutes. This is O(chunks), fail closed, and
   * never releases a live scheduler promise while work remains.
   */
  private async loadBalancerTables(
    tableIds: string[],
    label: string
  ): Promise<BalancerTable[] | null> {
    if (!this.eliminationMutationAllowed()) return null;
    const tableRead = await selectInChunks<{ id: string; max_players: number | null }>(
      tableIds,
      (batch) => supabase.from('tables').select('id, max_players').in('id', batch),
      `Tournament.${label}.tables(${this.tournamentId.slice(0, 8)})`
    );
    if (!this.eliminationMutationAllowed()) return null;
    if (!tableRead.complete) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return null;
    }
    const seatRead = await selectInChunks<{
      table_id: string;
      user_id: string;
      stack: number | null;
      seat_number: number | null;
    }>(
      tableIds,
      (batch) =>
        supabase
          .from('table_seats')
          .select('table_id, user_id, stack, seat_number')
          .in('table_id', batch)
          .is('left_at', null),
      `Tournament.${label}.seats(${this.tournamentId.slice(0, 8)})`
    );
    if (!this.eliminationMutationAllowed()) return null;
    if (!seatRead.complete) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return null;
    }

    const tableById = new Map(tableRead.rows.map((row) => [row.id, row]));
    if (tableById.size !== new Set(tableIds).size) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] ${label} table snapshot was incomplete`
        ),
        'Tournament.balance_table_snapshot_incomplete'
      );
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return null;
    }
    const seatsByTable = new Map<string, typeof seatRead.rows>();
    for (const seat of seatRead.rows) {
      const seats = seatsByTable.get(seat.table_id) ?? [];
      seats.push(seat);
      seatsByTable.set(seat.table_id, seats);
    }
    return tableIds.map((tableId) => {
      const seats = seatsByTable.get(tableId) ?? [];
      return {
        tableId,
        playerCount: seats.length,
        maxSeats: tableById.get(tableId)?.max_players || 9,
        buttonSeat: this.tableEngines.get(tableId)?.getCurrentButtonSeat() ?? 0,
        players: seats.map((seat) => ({
          userId: seat.user_id,
          stack: seat.stack || 0,
          seat: seat.seat_number || 0,
        })),
      };
    });
  }

  /**
   * Complete one table-break retirement without losing the object that owns
   * the unfinished work.  The database RPC serializes a close against live
   * seat acquisition and returns the exact durable row.  Only after that
   * receipt exists do we remove the same engine generation from GameServer,
   * this manager, the hub, and hand-for-hand.
   *
   * Any refusal leaves both registries pointing at the stopped/quarantined
   * engine.  The already-empty table is a deterministic break candidate on
   * the next shared scheduler pass, so the exact operation is retried without
   * a fleet sweep or a timer owned by this manager.
   */
  protected async closeBrokenTableAndReleaseEngine(
    tableId: string,
    engine: ServerTableEngine
  ): Promise<boolean> {
    if (this.tableEngines.get(tableId) !== engine) return false;

    try {
      await engine.stop();
    } catch (error) {
      if (!engine.hasReleasedProcessOwnership()) {
        reportError(error, 'Tournament.broken_table_engine_stop_failed', {
          tournamentId: this.tournamentId,
          tableId,
        });
        return false;
      }
      // Ownership is already gone; a trailing cleanup diagnostic must not
      // strand an empty table forever.
      reportError(error, 'Tournament.broken_table_engine_stop_cleanup_failed', {
        tournamentId: this.tournamentId,
        tableId,
      });
    }
    if (!this.eliminationMutationAllowed() || this.tableEngines.get(tableId) !== engine) {
      return false;
    }

    const leaseGeneration = this.getTournamentLeaseGeneration();
    if (!leaseGeneration) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] cannot close broken table ${tableId.slice(0, 8)} without exact protocol-2 authority`
        ),
        'Tournament.broken_table_close_unverified'
      );
      return false;
    }

    const { data, error } = await supabase.rpc('fn_close_empty_tournament_table', {
      p_tournament_id: this.tournamentId,
      p_table_id: tableId,
      p_lease_generation: leaseGeneration,
    });
    if (!this.eliminationMutationAllowed() || this.tableEngines.get(tableId) !== engine) {
      return false;
    }
    const receipt = data as TournamentTableCloseResult | null;
    const closed =
      !error &&
      receipt?.ok === true &&
      receipt.table_id === tableId &&
      receipt.tournament_id === this.tournamentId &&
      String(receipt.status).toLowerCase() === 'closed' &&
      Number(receipt.current_players) === 0;
    if (!closed) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] broken table ${tableId.slice(0, 8)} close was not durably proven (${error?.message ?? receipt?.reason ?? 'malformed receipt'})`
        ),
        'Tournament.broken_table_close_unproven'
      );
      return false;
    }

    if (!this.gameServer.unregisterTournamentTableEngine(tableId, engine)) {
      const ownershipError = new Error(
        `[Tournament:${this.tournamentId.slice(0, 8)}] broken table ${tableId.slice(0, 8)} changed global engine generation before retirement CAS`
      );
      reportError(ownershipError, 'Tournament.broken_table_unregister_lost_ownership');
      // An independent generation owns the process slot.  Fence this manager
      // synchronously; stop() is intentionally detached because this method is
      // itself running inside the scheduler that stop() must drain.
      void this.stop().catch((stopError) =>
        reportError(stopError, 'Tournament.broken_table_ownership_loss_cleanup_failed', {
          tableId,
        })
      );
      return false;
    }

    if (this.tableEngines.get(tableId) === engine) this.tableEngines.delete(tableId);
    this.retireManagedTableFromHandForHand(tableId);
    return true;
  }

  protected async checkTableBalance(): Promise<void> {
    if (!this.eliminationMutationAllowed()) return;
    // Check for final table (table_size or fewer players remaining, 2026-08-22
    // parity: was hardcoded 9) — only announce once
    if (!this.isFinalTable) {
      const { count: remainingPlayers, error: remainingPlayersErr } = await supabase
        .from('tournament_players')
        .select('*', { count: 'exact', head: true })
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'playing');
      if (!this.eliminationMutationAllowed()) return;

      const finalTableSize = Math.min(
        10,
        Math.max(2, Number(this.tournamentCache?.table_size) || 9)
      );
      /**
       * ═══════════════════════════════════════════════════════════════════
       *  A HEADCOUNT IS NOT A FINAL TABLE (2026-08-27, P0)
       * ═══════════════════════════════════════════════════════════════════
       *
       * This was `remaining <= finalTableSize` and nothing else, so nine
       * players sitting three-three-three across three felts were declared a
       * final table: everyone got the overlay, the deal poll (which shared
       * the same shape) opened voting, and `fn_settle_final_table_deal_atomic` would chop
       * the pool between nine players who were never at the same table.
       *
       * The count stays as the CHEAP first test — it is what keeps this off
       * the table-count query for the whole life of a big field — but the
       * declaration now also requires exactly ONE live table still holding
       * players. Consolidating the field is the balancer's job and happens
       * further down this same method; this is only the gate, so a field that
       * is short enough but not yet merged waits one cycle for the balancer
       * and is declared on the next.
       *
       * `countLiveTablesWithPlayers()` returns null for UNKNOWN, which is
       * treated as "not yet".
       */
      if (remainingPlayersErr || remainingPlayers === null) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] final-table headcount unreadable (${remainingPlayersErr?.message ?? 'null count'}) - final-table state left unchanged`
          ),
          'Tournament.final_table_count_unavailable'
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      } else if (remainingPlayers <= finalTableSize) {
        const liveTables = await this.countLiveTablesWithPlayers();
        if (!this.eliminationMutationAllowed()) return;
        if (liveTables === 1) {
          this.isFinalTable = true;
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] FINAL TABLE reached with ${remainingPlayers} players on one table`
          );
          /**
           * ═══════════════════════════════════════════════════════════════
           *  A ONE-SHOT BROADCAST IS NOT A STATE (Dan 2026-08-28, bug 7)
           * ═══════════════════════════════════════════════════════════════
           *
           * Reported: "you can not see the final table background either."
           *
           * `this.isFinalTable` is an in-memory flag on this process and the
           * announcement below is sent ONCE. Anyone not listening at that
           * instant never learns the tournament reached its final table:
           * a player who reconnects (which is exactly what happened — see
           * bug 1), a second device, a spectator arriving later, or every
           * client at once if the engine restarts.
           *
           * The client had a fallback, and it was a REGEX ON THE TABLE NAME:
           *   /\bfinal table\b/i.test(table.name)
           * on the stated grounds that "TournamentService canonically names
           * the consolidated table 'Final Table'". Production disagrees —
           * 4f42d847's final table is named "Union PKO Afternoon (PLO4) -
           * Table 2" — so the fallback matched nothing and the background
           * never loaded.
           *
           * `tournaments.final_table_triggered` has existed as a column the
           * whole time and NOTHING EVER WROTE IT: 0 of 1,286 completed MTTs
           * in thirty days had it set. Writing it makes the state durable and
           * lets any client, at any time, ask the tournament rather than
           * guess from a name.
           *
           * A failed write is logged and nothing else: the broadcast below
           * still goes out, so the live table is unaffected, and the next
           * sweep re-enters this branch only if the process restarts —
           * `.eq('final_table_triggered', false)` keeps that idempotent.
           */
          const { error: flagErr } = await supabase
            .from('tournaments')
            .update({ final_table_triggered: true })
            .eq('id', this.tournamentId)
            .eq('final_table_triggered', false);
          if (!this.eliminationMutationAllowed()) return;
          if (flagErr) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] could not persist final_table_triggered (${flagErr.message}) - the announcement still went out, but a reconnecting client will not see the final-table theme`
              ),
              'Tournament.final_table_flag_write_failed'
            );
          }
          await this.broadcast('final_table', { playerCount: remainingPlayers });
          if (!this.eliminationMutationAllowed()) return;
        } else if (liveTables !== null && liveTables > 1) {
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] ${remainingPlayers} players left but still spread over ${liveTables} tables - NOT the final table until the balancer consolidates`
          );
        }
      }
    }

    if (this.tableEngines.size <= 1) return;

    // ── FIX 154: Build BalancerTable[] from a bounded live DB snapshot ──
    const balancerTables = await this.loadBalancerTables(
      [...this.tableEngines.keys()],
      'balanceInitial'
    );
    if (!balancerTables) return;

    // ── STEP 1: Check if any table should be broken (merged into others) ──
    for (const bt of balancerTables) {
      if (this.tableBalancer.shouldBreakTable(bt, balancerTables)) {
        const otherTables = balancerTables.filter((t) => t.tableId !== bt.tableId);
        const breakMoves = this.tableBalancer.breakTable(bt, otherTables);

        // The balancer says this table should close but cannot yet place its
        // full roster. That is outstanding work, not a balanced state. Keep a
        // single coalesced retry due without reviving the old per-manager poll.
        // An empty table is already fully moved and must proceed to the durable
        // close. Treating its intentionally-empty move plan as failure left a
        // table whose prior close response was lost stuck forever.
        if (bt.playerCount > 0 && breakMoves.length !== bt.playerCount) {
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          continue;
        }

        if (breakMoves.length === bt.playerCount) {
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Breaking table ${bt.tableId.slice(0, 8)} - moving ${breakMoves.length} players`
          );

          // AUDIT FIX 2026-07-19: wait for the source table's current hand to
          // finish (so syncStacks has persisted final stacks) BEFORE moving
          // players. Previously executePlayerMoves ran first and read the
          // pre-hand stack, so a player who won/lost the in-flight hand arrived
          // at the new table with the wrong stack (chips created/destroyed).
          const engine = this.tableEngines.get(bt.tableId);
          if (engine) {
            const safe = await this.waitForHandComplete(bt.tableId);
            if (!this.eliminationMutationAllowed()) return;
            if (!safe) {
              // TOURNEY-AUDIT 2026-07-24 (sweep 4): never move players mid-hand.
              console.warn(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Table ${bt.tableId.slice(0, 8)} still in-hand after 60s - deferring break to next balance cycle`
              );
              this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
              continue;
            }
          }

          const movedCount = await this.executePlayerMoves(breakMoves);
          if (!this.eliminationMutationAllowed()) return;

          // LIVE E2E FIX 2026-08-15: the table was previously closed even when
          // some moves FAILED — the unmoved players kept 'playing' status and
          // chips but pointed at a closed table no balance pass ever looks at
          // again (checkTableBalance iterates tableEngines only). Seen live on
          // 3 frozen tournaments + "Late Night Grind", where the stall ended in
          // a force-complete that paid 1st place to an already-eliminated
          // player. Close ONLY when every player actually arrived; otherwise
          // keep the table alive and let the next cycle retry the remainder.
          if (movedCount !== breakMoves.length) {
            console.warn(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Table break of ${bt.tableId.slice(0, 8)} incomplete - ${movedCount}/${breakMoves.length} moved. Deferring close to next balance cycle.`
            );
            this.breakOccurredThisCycle = true;
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
            break;
          }

          if (!engine) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] cannot retire broken table ${bt.tableId.slice(0, 8)} because its exact engine generation is missing`
              ),
              'Tournament.broken_table_engine_missing'
            );
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
            continue;
          }

          const retired = await this.closeBrokenTableAndReleaseEngine(bt.tableId, engine);
          if (!this.eliminationMutationAllowed()) return;
          if (!retired) {
            // The stopped generation remains in both registries and in the
            // hand-for-hand roster. The next scheduler pass sees the empty
            // table and retries this exact durable close; no successor may
            // overlap an unproved retirement.
            this.breakOccurredThisCycle = true;
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
            break;
          }

          await this.broadcast('table_rebalance', {
            closedTableId: bt.tableId,
            movedPlayers: breakMoves.length,
            reason: 'table_break',
          });
          if (!this.eliminationMutationAllowed()) return;

          // Round 51 RE-RUN-2: signal expansion to skip this cycle so we
          // don't immediately re-create the table we just broke.
          this.breakOccurredThisCycle = true;

          // One break per pass is intentional because balancerTables is now
          // stale. Re-enter promptly with fresh rows (also announces a final
          // table immediately when this break collapsed the field to one).
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);

          break; // One break per cycle to avoid stale data
        }
      }
    }

    // ── STEP 2: Standard gap-1 rebalancing across remaining tables ──
    // Re-fetch after potential break (tables may have changed)
    if (this.tableEngines.size > 1) {
      const freshTables = await this.loadBalancerTables(
        [...this.tableEngines.keys()],
        'balanceFresh'
      );
      if (!freshTables) return;

      if (this.tableBalancer.shouldRebalance(freshTables)) {
        const moves = this.tableBalancer.calculateMoves(freshTables);
        if (moves.length === 0) {
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
        }
        if (moves.length > 0) {
          const score = this.tableBalancer.evaluateBalance(freshTables);
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Rebalancing: ${moves.length} moves (gap was ${score.gap}, target ≤1)`
          );

          // AUDIT FIX 2026-07-19: gap rebalance previously moved players with no
          // regard for in-flight hands. Wait for each source table's current
          // hand to complete (final stacks persisted) before moving.
          const sourceTables = [...new Set(moves.map((m) => m.fromTableId))] as string[];
          const unsafeTables = new Set<string>();
          for (const t of sourceTables) {
            const safe = await this.waitForHandComplete(t);
            if (!this.eliminationMutationAllowed()) return;
            if (!safe) unsafeTables.add(t);
          }
          // TOURNEY-AUDIT 2026-07-24 (sweep 4): drop moves from tables still
          // in-hand instead of moving players with stale mid-hand stacks.
          const safeMoves = moves.filter((m) => !unsafeTables.has(m.fromTableId));
          if (unsafeTables.size > 0) {
            console.warn(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Deferring ${moves.length - safeMoves.length} rebalance move(s) - source table(s) still in-hand`
            );
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          }
          if (safeMoves.length > 0) {
            const movedCount = await this.executePlayerMoves(safeMoves);
            if (!this.eliminationMutationAllowed()) return;
            if (movedCount < safeMoves.length) {
              console.warn(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Rebalance incomplete - ${movedCount}/${safeMoves.length} move(s) landed. Deferring remainder.`
              );
            }

            // A move changes the shape the planner read. Verify from fresh DB
            // state in one coalesced follow-up; balanced tournaments never arm
            // this path because shouldRebalance is false.
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);

            await this.broadcast('table_rebalance', {
              moveCount: movedCount,
              reason: 'gap_balance',
            });
          }
        }
      }
    }
  }

  /**
   * FIX 154: Execute a set of player move instructions (used by both table break + rebalance).
   * Moves player seats in DB: marks old seat as left, inserts new seat, updates tournament_players.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  A PLAYER LEFT ON A CLOSED TABLE IS BROUGHT BACK TO THE FELT
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The evidence and every rule are in `orphanedSeatRepair.ts`. The short
   * version: `checkTableBalance` iterates `tableEngines`, a closed table has
   * no engine, so a live seat left behind on one is invisible to the balancer
   * forever - and the tournament counts that player as still in the game and
   * waits for an action nobody can take.
   *
   * This reads the tournament's own tables and live seats, asks the pure
   * planner what to do, and hands the answer to `executePlayerMoves`. Since
   * 2026-09-09 that method is a single call to `fn_ca_move_tournament_seat`,
   * so every protection the move has earned - the source stack read under
   * lock, the refusal to guess between two live seats, seat reuse, the
   * destination checks - now lives in one database transaction and applies to
   * this repair unchanged, because this adds no second way to move a player.
   *
   * Both reads fail CLOSED. An unreadable board is UNKNOWN, never "nobody is
   * stranded" and never "everybody is".
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  A PLAYER WITH CHIPS AND NO CHAIR IS BROUGHT BACK TO THE FELT
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The sibling of `absorbOrphanedSeats`, and the half nothing answered. That
   * one repairs a live seat on a table that cannot deal; this one repairs a
   * player who holds no live seat AT ALL while the roster still has them
   * playing. Their chips stand on the chair they left, outside every reader
   * that counts open seats, and they cannot be dealt a hand.
   *
   * Measured 2026-09-09: eight players across four running events holding
   * 673,500 chips, one of them out of their chair since 04:48 the day before.
   *
   * Every read fails CLOSED - an unreadable board is UNKNOWN, never "nobody is
   * stranded" - and the move goes through `executePlayerMoves`, so the
   * duplicate-seat claim, the mid-hand deferral, the update-first seat reuse
   * and the false-negative destination check all apply unchanged.
   */
  public async absorbSeatlessPlayers(): Promise<number> {
    const { data: tableRows, error: tableErr } = await supabase
      .from('tables')
      .select('id, status, is_deleted, max_players')
      .eq('tournament_id', this.tournamentId);
    if (tableErr || !tableRows || tableRows.length === 0) return 0;

    const tableIds = tableRows.map((r) => String((r as { id: string }).id));

    const { data: liveSeats, error: seatErr } = await supabase
      .from('table_seats')
      .select('table_id, user_id, seat_number, stack')
      .in('table_id', tableIds)
      .is('left_at', null);
    if (seatErr || !liveSeats) return 0;

    const { data: roster, error: rosterErr } = await supabase
      .from('tournament_players')
      .select('user_id, status')
      .eq('tournament_id', this.tournamentId)
      .neq('status', 'eliminated');
    if (rosterErr || !roster) return 0;

    const seated = new Set(liveSeats.map((s) => String((s as { user_id: string }).user_id)));
    const seatlessIds = roster
      .map((r) => String((r as { user_id: string }).user_id))
      .filter((id) => !seated.has(id));
    if (seatlessIds.length === 0) return 0;

    // Where does each of them stand? The most recent chair they left.
    const { data: leftSeats, error: leftErr } = await supabase
      .from('table_seats')
      .select('table_id, user_id, seat_number, stack, left_at')
      .in('table_id', tableIds)
      .in('user_id', seatlessIds)
      .not('left_at', 'is', null)
      .order('left_at', { ascending: false });
    if (leftErr || !leftSeats) return 0;

    const latest = new Map<string, SeatlessRosterRow>();
    for (const row of leftSeats as Array<{
      table_id: string;
      user_id: string;
      seat_number: number | null;
      stack: number | string | null;
    }>) {
      const id = String(row.user_id);
      if (latest.has(id)) continue; // ordered newest first
      latest.set(id, {
        user_id: id,
        last_table_id: String(row.table_id),
        last_seat_number: row.seat_number,
        last_stack: row.stack,
      });
    }

    const moves = planSeatlessReseats(
      tableRows as OrphanTableRow[],
      liveSeats as OrphanSeatRow[],
      Array.from(latest.values())
    );
    if (moves.length === 0) return 0;

    console.warn(
      `[Tournament:${this.tournamentId.slice(0, 8)}] ${moves.length} player(s) are on the roster holding chips with no chair anywhere - seating them so they can be dealt in again`
    );
    return this.executePlayerMoves(moves);
  }

  public async absorbOrphanedSeats(): Promise<number> {
    const { data: tableRows, error: tableErr } = await supabase
      .from('tables')
      .select('id, status, is_deleted, max_players')
      .eq('tournament_id', this.tournamentId);
    if (tableErr || !tableRows || tableRows.length === 0) return 0;

    const tableIds = tableRows.map((r) => String((r as { id: string }).id));
    const { data: seatRows, error: seatErr } = await supabase
      .from('table_seats')
      .select('table_id, user_id, seat_number, stack')
      .in('table_id', tableIds)
      .is('left_at', null);
    if (seatErr || !seatRows) return 0;

    const moves = planOrphanReseats(tableRows as OrphanTableRow[], seatRows as OrphanSeatRow[]);

    const { duplicateSeat, noChips } = describeUnmovableOrphans(
      tableRows as OrphanTableRow[],
      seatRows as OrphanSeatRow[]
    );
    if (duplicateSeat.length > 0) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] ${duplicateSeat.length} player(s) hold a live seat on BOTH a closed table and an open one. Which stack is real is a money decision, so nothing was moved: ${duplicateSeat.map((id) => id.slice(0, 8)).join(', ')}`
        ),
        'Tournament.orphan_seat_duplicate_not_moved'
      );
    }
    if (noChips.length > 0) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] ${noChips.length} stranded seat(s) on a closed table hold no chips, so the elimination path owns them rather than this repair: ${noChips.map((id) => id.slice(0, 8)).join(', ')}`
        ),
        'Tournament.orphan_seat_no_chips_not_moved'
      );
    }

    /* BOTH STRANDS OF ONE FAILURE, ONE SWEEP (2026-09-09). A player left on a
       closed table and a player left with no chair at all are the same event -
       a move that did not finish - and they are repaired on the same cadence
       so neither waits on the other's discovery. */
    const seatless = await this.absorbSeatlessPlayers();

    if (moves.length === 0) return seatless;

    console.warn(
      `[Tournament:${this.tournamentId.slice(0, 8)}] ${moves.length} player(s) stranded on a closed table - moving them to open felt so the tournament can deal again`
    );
    return (await this.executePlayerMoves(moves)) + seatless;
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  A SEAT MOVES IN ONE TRANSACTION, OR IT DOES NOT MOVE
   * ═══════════════════════════════════════════════════════════════════════
   *
   * This used to be four round trips: read the source stack, stamp `left_at`
   * on the source seat, write the destination seat, and - when that failed -
   * a fifth to put `left_at` back. Every protection it grew over a year was
   * real, and none of them could close the hole, because the hole is between
   * trip two and trip three: for as long as that gap is open the player holds
   * no seat anywhere and their chips are off the felt.
   *
   * MEASURED IN PRODUCTION, 2026-09-09. The gap held 1,673,900 tournament
   * chips belonging to 24 players across 12 running events. Three separate
   * refusals fed it:
   *
   *   - the destination write was refused by the four-table limit, because a
   *     player mid-move holds no seat in the event they are playing, so their
   *     other bookings filled the quota (fixed in the database by
   *     ca_the_cap_is_at_the_door_not_at_the_chair);
   *   - the compensating restore was refused by
   *     ab_refuse_live_seat_on_closed_tournament_table, because a broken
   *     table is closed by the time the restore runs;
   *   - a maintenance freeze at :55 refuses either write on its own.
   *
   * And neither the vacate nor the restore checked its result, so the engine
   * logged "source seat restored" for a rollback the database had refused.
   *
   * A COMPENSATING WRITE IS NOT A ROLLBACK. It is a second write that can
   * fail on its own, and when it does there is nothing left to compensate
   * with. So this no longer tries to be careful inside the gap - it hands the
   * whole move to `fn_ca_move_tournament_seat`, which vacates the source,
   * writes the destination, carries the stack, asserts that the chips that
   * arrived are the chips that left, and repoints the roster INSIDE ONE
   * TRANSACTION. A refusal at any step unwinds all of it and the player is
   * still sitting where they were. There is no window, so nothing can arrive
   * in it, and a process that dies mid-move leaves nothing half-done.
   *
   * Every check this method used to make by hand now lives in that function,
   * where it is enforced for every caller rather than for this one:
   * the source stack is read under lock, a player holding two live seats is
   * refused as a money decision, the destination is verified to belong to
   * this event and to be open, an occupied chair is refused rather than
   * overwritten, and a player already sitting at the destination is a replay
   * rather than a second move.
   *
   * THE RESULT IS CHECKED. That is the other half of the bug.
   */
  protected async executePlayerMoves(moves: MoveInstruction[]): Promise<number> {
    let moved = 0;
    const batch = moves.slice(0, TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE);
    if (moves.length > batch.length) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
    }
    for (const move of batch) {
      if (!this.eliminationMutationAllowed()) return moved;
      try {
        /**
         * NEVER MOVE A PLAYER MID-HAND - RE-CHECKED HERE, NOT ONLY AT PLAN TIME
         * (2026-09-09).
         *
         * Both callers already probe `waitForHandComplete` before handing a
         * batch to this loop, and the intent has been written down since
         * 2026-07-24: "never move players mid-hand". But that probe is taken
         * ONCE PER BATCH, and the loop then spends an awaited round trip per
         * move. The engine keeps dealing throughout, so by the time move N
         * runs, the boundary that was checked before move 1 is long gone.
         *
         * Measured 2026-09-08/09: 32 fully dealt tournament hands were thrown
         * away. `fn_ca_settle_hand_stacks_absolute` finds the seat gone at
         * commit time and raises `seat missing or left for <uuid> - hand write
         * rejected whole`, which aborts the whole atomic commit; the engine
         * files a critical alert and calls `killForRestart`. EVERY player at
         * that table loses the hand they just played, not only the mover. The
         * leave/join pairs sit 0.17-0.37s apart - inside the hand.
         *
         * ONE TRANSACTION DOES NOT MAKE THIS UNNECESSARY. Atomicity protects
         * the MOVER: the move either happens whole or not at all. It says
         * nothing about the hand the other eight players are in the middle of,
         * which lives in the engine and not in the database. So the probe
         * stays, and it sits immediately before the only destructive call -
         * which is now the move RPC itself.
         */
        if (!(await this.waitForHandComplete(move.fromTableId))) {
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Deferring move for ${move.playerId.slice(0, 8)} - table ${move.fromTableId.slice(0, 8)} began a hand after this batch was planned. The player stays put and the next rebalance retries; moving now would discard the hand for everyone at that table.`
          );
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          continue;
        }
        if (!this.eliminationMutationAllowed()) return moved;

        const { data, error } = await supabase.rpc('fn_ca_move_tournament_seat', {
          p_tournament_id: this.tournamentId,
          p_user_id: move.playerId,
          p_to_table_id: move.toTableId,
          p_to_seat: move.toSeat,
          p_reason: move.reason ?? 'balance',
        });

        if (error) {
          /**
           * A REFUSAL IS SAFE AND IS NOT SILENT. The transaction unwound, so
           * the player is still at their source table with their stack; the
           * next balance cycle will retry. It is still reported, because a
           * refusal that repeats is a condition somebody has to see - that is
           * exactly how the four-table refusal ran unseen for as long as it
           * did.
           */
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Move refused for ${move.playerId.slice(0, 8)}: table ${move.fromTableId.slice(0, 8)} seat ${move.fromSeat} -> table ${move.toTableId.slice(0, 8)} seat ${move.toSeat}: ${error.message}. Nothing moved; the player keeps their seat and the next cycle retries.`
            ),
            'Tournament.Move_refused'
          );
          continue;
        }

        const result = (data ?? {}) as {
          moved?: boolean;
          replayed?: boolean;
          stack?: number | string | null;
          reason?: string;
        };

        if (result.replayed) {
          // Somebody already made this exact move. Not an error, not a second
          // move, and not a failure to count - the player is where we wanted
          // them.
          moved++;
          continue;
        }

        if (!result.moved) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Move for ${move.playerId.slice(0, 8)} returned no result and raised nothing - treating it as not moved: ${JSON.stringify(data)}`
            ),
            'Tournament.Move_returned_nothing'
          );
          continue;
        }

        moved++;
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Moved ${move.playerId.slice(0, 8)} with ${result.stack ?? '?'}: table ${move.fromTableId.slice(0, 8)} seat ${move.fromSeat} -> table ${move.toTableId.slice(0, 8)} seat ${move.toSeat}`
        );
      } catch (moveErr) {
        reportError(moveErr, 'Tournament.Move_threw');
      }
    }
    return moved;
  }

  /**
   * Is this table safe to move from RIGHT NOW?
   *
   * This used to poll hand_state_snapshots every two seconds for up to sixty
   * seconds. Under the process-wide scheduler, four ordinary in-hand tables
   * could therefore occupy all four physical sweep slots and starve an urgent
   * bust for a full minute-the same fan-out in a different shape. The engine
   * already owns the authoritative boundary: no hand controller and no
   * settlement promise in flight. Probe it once, fail closed, and let the
   * caller arm one coalesced BALANCE_REDRIVE_MS wake.
   *
   * Kept async to avoid widening every established caller; it never waits.
   */
  protected async waitForHandComplete(tableId: string): Promise<boolean> {
    const engine = this.tableEngines.get(tableId);
    return Boolean(engine && engine.isBetweenHands() && !engine.hasSettlementInFlight());
  }

  /**
   * TOURNEY-AUDIT 2026-07-24 (sweep 6): server-authoritative seating for late
   * registrants and re-entries. Dan's rule: an MTT entrant is NEVER waiting.
   * Every 5s cycle:
   *   1. Find tournament_players rows (registered/playing) with NO active seat
   *      at any of this tournament's tables.
   *   2. Seat each at the table with the most open seats (stack = their chips,
   *      or starting_chips for fresh 'registered' rows, which are promoted to
   *      'playing').
   *   3. If no table has an open seat, promote them to 'playing' anyway so
   *      checkDynamicTableExpansion (next call in the same cycle) counts them,
   *      spawns a new table, and the TableBalancer redraws seats.
   * Idempotent per cycle; the unique (table_id, user_id) WHERE left_at IS NULL
   * index makes double-seating impossible even under races.
   */
  /** TOURNEY-AUDIT 2026-07-24 (sweep 6): satellite seat distribution. */
  /**
   * Settle a satellite's entire frozen entitlement plan in one database
   * transaction. The RPC is the sole authority for seat delivery, cash
   * fallback, prize stamps, its immutable batch receipt, and COMPLETED.
   * A refusal is causal retry work; this caller never guesses through it.
   */
  protected async processSatelliteAwards(_tournament: any): Promise<boolean> {
    type AtomicSatelliteFinishResult = {
      ok?: boolean;
      settled?: boolean;
      already_settled?: boolean;
      rows_updated?: number;
      award_depth?: number;
      amount_settled?: number;
      reason?: string;
      sqlstate?: string;
      detail?: string;
      retryable?: boolean;
    };

    try {
      const { data, error } = await supabase.rpc('fn_settle_satellite_finish_atomic', {
        p_tournament_id: this.tournamentId,
        p_source: 'engine.finishTournament',
      });
      const result = data as AtomicSatelliteFinishResult | null;
      if (error || result?.ok !== true || result?.settled !== true) {
        const reason = error?.message ?? result?.reason ?? 'satellite_settlement_refused';
        const detail = result?.detail ? `: ${result.detail}` : '';
        reportError(
          new Error(
            `[Satellite:${this.tournamentId.slice(0, 8)}] atomic settlement refused (${reason}${detail}); event remains COMPLETING and re-drivable`
          ),
          'Tournament.atomic_satellite_finish_failed'
        );
        return false;
      }

      console.log(
        `[Satellite:${this.tournamentId.slice(0, 8)}] atomic settlement ${result.already_settled ? 'replayed' : 'committed'}: ${Number(result.award_depth ?? 0)} award place(s), ${Number(result.amount_settled ?? 0)} total value`
      );
      return true;
    } catch (error) {
      reportError(error, 'Tournament.atomic_satellite_finish_threw');
      return false;
    }
  }

  protected async ensureLateRegSeated(): Promise<void> {
    try {
      if (!this.eliminationMutationAllowed()) return;
      if (this.tournamentCache?.status && this.tournamentCache.status !== 'RUNNING') return;
      const { data: entrants, error: entrantsErr } = await supabase
        .from('tournament_players')
        .select('user_id, username, status, chips')
        .eq('tournament_id', this.tournamentId)
        .in('status', ['registered', 'playing']);
      if (!this.eliminationMutationAllowed()) return;
      if (entrantsErr) {
        reportError(entrantsErr, 'Tournament.late_reg_entrants_unreadable');
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.LATE_REG_REDRIVE_MS);
        return;
      }
      if (!entrants || entrants.length === 0) return;

      // Active tables of THIS tournament (DB-grounded, not the in-memory map)
      const { data: tourneyTables, error: tourneyTablesErr } = await supabase
        .from('tables')
        .select('id, max_players')
        .eq('tournament_id', this.tournamentId)
        .in('status', ['waiting', 'running', 'RUNNING', 'active']);
      if (!this.eliminationMutationAllowed()) return;
      if (tourneyTablesErr) {
        reportError(tourneyTablesErr, 'Tournament.late_reg_tables_unreadable');
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.LATE_REG_REDRIVE_MS);
        return;
      }
      if (!tourneyTables || tourneyTables.length === 0) {
        // checkDynamicTableExpansion runs later in this sweep. Re-enter with
        // fresh rows after it has created the first table (or retry if it did
        // not), including for a player already promoted to `playing` whom the
        // registered-only global lane intentionally cannot see.
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.LATE_REG_REDRIVE_MS);
        return;
      }
      const tableIds = tourneyTables.map((t) => t.id);

      /* CHUNKED, AND A FAILED READ MUST NOT MEAN "NOBODY IS SEATED" (2026-09-03).
         `tableIds` is every live table of this tournament and the largest field
         on record here is 1,076 tables, so one `.in()` goes past the ~675-id
         ceiling PostgREST accepts in a URL and answers HTTP 400. The error was
         discarded, `seatedUsers` came back EMPTY, and every entrant in the
         field then read as unseated - a seat-write storm every five seconds
         across the whole tournament, and `best` never null so nobody is ever
         promoted to 'playing' and table expansion never fires. Declining the
         pass is the safe answer: seatClaim still fails closed, and the next
         cycle tries again. */
      const seatRead = await selectInChunks<{
        user_id: string;
        table_id: string;
        seat_number: number;
      }>(
        tableIds,
        (batch) =>
          supabase
            .from('table_seats')
            .select('user_id, table_id, seat_number')
            .in('table_id', batch)
            .is('left_at', null),
        `Tournament.lateRegSeated(${this.tournamentId.slice(0, 8)})`
      );
      if (!this.eliminationMutationAllowed()) return;
      if (!seatRead.complete) {
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.LATE_REG_REDRIVE_MS);
        return;
      }
      const seatRows = seatRead.rows;
      const seatedUsers = new Set(seatRows.map((s) => s.user_id));
      const allUnseated = entrants.filter((e) => !seatedUsers.has(e.user_id));
      if (allUnseated.length === 0) return;
      const unseated = allUnseated.slice(0, TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE);
      if (allUnseated.length > unseated.length) this.requestEliminationSweep();

      // Keep one manager-scoped retry due for as long as a paid entrant is
      // known to be seatless. This includes status='playing' rebuys and rows
      // promoted for expansion, which the registered-only global RPC cannot
      // and must not claim. One clean tail pass observes zero and stops.
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.LATE_REG_REDRIVE_MS);

      const startingChips = Number(this.tournamentCache?.starting_chips || 0);

      // Build per-table occupancy
      const occupancy = new Map<string, { max: number; taken: Set<number> }>();
      for (const t of tourneyTables) {
        occupancy.set(t.id, { max: t.max_players || 9, taken: new Set() });
      }
      for (const s of seatRows ?? []) {
        occupancy.get(s.table_id)?.taken.add(s.seat_number);
      }

      for (const player of unseated) {
        if (!this.eliminationMutationAllowed()) return;
        // Choose the active table with the most open seats
        let best: { tableId: string; openSeats: number } | null = null;
        for (const [tid, occ] of occupancy) {
          const open = occ.max - occ.taken.size;
          if (open > 0 && (!best || open > best.openSeats)) {
            best = { tableId: tid, openSeats: open };
          }
        }

        // EARLY BIRD (2026-08-22 parity): a 'registered' row's chips column is
        // the pre-credited early-bird bonus (fn_register_for_tournament writes
        // it at registration). Seating ADDS the starting stack to it — never
        // overwrites it.
        /**
         * A ZERO-CHIP 'playing' ENTRANT IS NOT SEATABLE (2026-08-30).
         *
         * That state now has a precise meaning: they busted and their rebuy
         * decision window is open (the bust vacates the seat immediately —
         * Dan 2026-08-30 — and the elimination sweep holds their entry for
         * REBUY_DECISION_GRACE_MS). The old fallback here handed such a
         * player a FREE startingChips stack, which was unreachable while
         * busted players kept their seats and becomes a chip mint the moment
         * they do not. A landed rebuy raises their chips and the next pass
         * seats them normally; a declined/expired window eliminates them.
         */
        if (player.status !== 'registered' && Number(player.chips || 0) <= 0) {
          continue;
        }
        const playerChips =
          player.status === 'registered'
            ? startingChips + Math.max(0, Math.floor(Number(player.chips) || 0))
            : Number(player.chips);

        if (!best) {
          // All tables full — promote to 'playing' so expansion counts them;
          // a new table spawns this same cycle and we seat next cycle. Once
          // promoted, the service-role recovery RPC no longer sees this row
          // (it correctly owns only `registered` entrants), so explicitly
          // re-drive it through the scheduler's one global timer. This also
          // retries expansion promptly if the create call fails.
          if (player.status === 'registered') {
            await supabase
              .from('tournament_players')
              .update({ status: 'playing', chips: playerChips })
              .eq('tournament_id', this.tournamentId)
              .eq('user_id', player.user_id)
              .eq('status', 'registered');
            if (!this.eliminationMutationAllowed()) return;
          }
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.LATE_REG_REDRIVE_MS);
          continue;
        }

        const occ = occupancy.get(best.tableId)!;
        let seatNumber = 1;
        while (occ.taken.has(seatNumber) && seatNumber <= occ.max) seatNumber++;
        if (seatNumber > occ.max) continue;

        /**
         * THE SNAPSHOT IS NOT THE CHECK (2026-08-25).
         *
         * `seatedUsers` is read once at the top of this pass. The pass then
         * walks the whole field one player at a time, and the start-seating
         * loop in createTablesAndSeatPlayers is doing the same thing beside
         * it — five minutes of writes on a 497-entrant freeroll. Anyone seated
         * by the other writer inside that window is still on this pass's
         * `unseated` list, and the per-TABLE unique index does not stop a
         * second seat at a DIFFERENT table.
         *
         * Re-read immediately before the write. Refusing costs this player one
         * scheduler retry; seating them twice double-counts their stack for
         * the rest of the tournament.
         */
        const claim = await mayTakeSeat(supabase, this.tournamentId, player.user_id);
        if (!this.eliminationMutationAllowed()) return;
        if (!claim.allowed) {
          if (claim.unknown) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Not seating ${player.user_id.slice(0, 8)} - ${claim.reason}. The coalesced manager retry will re-read the claim.`
              ),
              'Tournament.late_reg_seat_claim_unreadable'
            );
          }
          continue;
        }

        // LIVE E2E FIX 2026-08-15: same one-row-per-seat rule as
        // executePlayerMoves — `occ.taken` only tracks ACTIVE seats, so the
        // chosen seat number often has a LEFT row and a blind INSERT hits
        // 23505 every cycle, making this self-heal skip the player forever.
        // Reuse the left seat row first; insert only if it never existed.
        const { data: reusedRows, error: reuseErr } = await supabase
          .from('table_seats')
          .update({
            user_id: player.user_id,
            stack: playerChips,
            left_at: null,
            joined_at: new Date().toISOString(),
            // Seat turnover: never inherit the previous occupant's sit-out
            // flag (trg_clear_sitout_on_turnover backstops every writer).
            is_sitting_out: false,
          })
          .eq('table_id', best.tableId)
          .eq('seat_number', seatNumber)
          .not('left_at', 'is', null)
          .select('id');
        /**
         * A PAID PLAYER WHO NEVER GETS A SEAT MUST NOT BE SILENT (2026-08-25).
         *
         * Both of these branches were a bare `continue`. This method is the
         * self-heal that guarantees Dan's rule that an MTT entrant is NEVER
         * waiting, and it runs every five seconds — so an error here does not
         * retry into success, it retries into the SAME failure, forever, with
         * nothing written anywhere. A player who paid a buy-in and holds no
         * seat is the failure shape this estate keeps hitting, and it was
         * reaching production with no report attached to it at all.
         *
         * A genuine unique-index race — the player was seated by another pass
         * in the same instant — is the one expected outcome and stays quiet;
         * the resolved state is correct, so a report would be pure noise.
         * Everything else is now reported and the sweep moves to the next
         * player rather than abandoning the pass.
         */
        const quietRace = (msg?: string) => /duplicate|unique|23505|already/i.test(msg || '');
        if (reuseErr) {
          if (!quietRace(reuseErr.message)) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Could not reuse seat ${seatNumber} at table ${best.tableId.slice(0, 8)} for ${player.user_id.slice(0, 8)}: ${reuseErr.message}. Player is UNSEATED; the coalesced manager retry remains armed.`
              ),
              'Tournament.late_reg_seat_reuse_failed'
            );
          }
          continue;
        }
        if (!reusedRows || reusedRows.length === 0) {
          const { error: seatErr } = await supabase.from('table_seats').insert({
            table_id: best.tableId,
            user_id: player.user_id,
            seat_number: seatNumber,
            stack: playerChips,
          });
          if (seatErr) {
            if (!quietRace(seatErr.message)) {
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] Could not seat ${player.user_id.slice(0, 8)} at table ${best.tableId.slice(0, 8)} seat ${seatNumber}: ${seatErr.message}. Player is UNSEATED; the coalesced manager retry remains armed.`
                ),
                'Tournament.late_reg_seat_insert_failed'
              );
            }
            continue;
          }
        }
        occ.taken.add(seatNumber);

        if (reusedRows && reusedRows.length > 0) {
          // The old occupant has been overwritten in `table_seats`, but their `tournament_players`
          // row still falsely points to this table. This is how 11 players can get assigned to
          // a 9-max table and crash the Table Engine with `deck_capacity_exceeded`. Clear it.
          await supabase
            .from('tournament_players')
            .update({ table_id: null, seat_number: null })
            .eq('tournament_id', this.tournamentId)
            .eq('table_id', best.tableId)
            .eq('seat_number', seatNumber)
            .neq('user_id', player.user_id);
        }

        await supabase
          .from('tournament_players')
          .update({
            status: 'playing',
            chips: playerChips,
            table_id: best.tableId,
            seat_number: seatNumber,
          })
          .eq('tournament_id', this.tournamentId)
          .eq('user_id', player.user_id);
        await supabase
          .from('tables')
          .update({ current_players: occ.taken.size })
          .eq('id', best.tableId);

        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Late-reg seated ${player.user_id.slice(0, 8)} at table ${best.tableId.slice(0, 8)} seat ${seatNumber} (${playerChips} chips)`
        );
      }
    } catch (err) {
      reportError(err, 'Tournament.ensureLateRegSeated');
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.LATE_REG_REDRIVE_MS);
    }
  }

  /**
   * FIX 155: Dynamic table creation during rebuy/re-entry/late-reg period.
   * When player count exceeds (tableCount × maxPerTable), create new tables
   * and rebalance players across all tables using TableBalancer.
   *
   * Called from bounded elimination scheduling: immediately for a detected
   * seatless registrant or bust, on manager admission, and after any failed
   * capacity attempt at its explicit retry deadline.
   */
  // Round 51 RE-RUN-2 fix: when a table was just broken in the same
  // elimination-loop cycle, skip expansion. Otherwise the broken table's
  // close → reduces dbActiveTableCount → triggers fresh expansion → and
  // the next cycle breaks ANOTHER empty table → loop creates 12 new
  // tables/minute. Verified live on "Union PKO Afternoon" with 12 playing
  // / 2 active / 109 closed: 12 tables/min churn rate continued for 8+
  // minutes after the first defensive cap deployed.
  protected breakOccurredThisCycle = false;

  protected async checkDynamicTableExpansion(): Promise<boolean> {
    if (!this.eliminationMutationAllowed()) return false;
    // Skip expansion in the same scheduler pass as a break - gives
    // executePlayerMoves time to actually seat players to remaining tables
    // before we evaluate "are we over capacity?"
    if (this.breakOccurredThisCycle) {
      this.breakOccurredThisCycle = false;
      return true;
    }

    // Registration and every manager process enter through ONE database
    // authority. The RPC locks the tournament row and then re-counts active
    // entrants and live capacity. No count made in this process authorizes an
    // insert, and this class never inserts a tournament table directly.
    const newTableIds: string[] = [];
    let admittedCapacity = false;
    let totalPlaying = 0;
    let remainingDeficit = 0;
    for (let i = 0; i < TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE; i++) {
      if (!this.eliminationMutationAllowed()) return false;
      const { data, error: createErr } = await supabase.rpc(
        'fn_ensure_late_registration_capacity',
        { p_tournament_id: this.tournamentId, p_reserved_entries: 0 }
      );

      if (!this.eliminationMutationAllowed()) return false;

      if (createErr) {
        reportError(createErr, 'Tournament.dynamic_expansion_capacity_authority_unavailable');
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.LATE_REG_REDRIVE_MS);
        return false;
      }

      const result = data as LateRegistrationCapacityResult | null;
      if (!result || result.ok !== true || typeof result.created !== 'boolean') {
        reportError(
          new Error('late-registration capacity RPC returned an invalid contract'),
          'Tournament.dynamic_expansion_capacity_contract_invalid'
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.LATE_REG_REDRIVE_MS);
        return false;
      }

      totalPlaying = Number.isFinite(Number(result.active_entries))
        ? Number(result.active_entries)
        : totalPlaying;
      remainingDeficit = Number.isFinite(Number(result.remaining_deficit))
        ? Math.max(0, Number(result.remaining_deficit))
        : 0;

      if (result.reason === 'tournament_not_running') return true;
      const rawPendingTableIds = result.pending_table_ids;
      const pendingTableIds = Array.isArray(rawPendingTableIds)
        ? rawPendingTableIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      const pendingTableCount = Number(result.pending_table_count);
      const createdTableId = typeof result.table_id === 'string' ? result.table_id : '';
      if (
        !Array.isArray(rawPendingTableIds) ||
        pendingTableIds.length !== rawPendingTableIds.length ||
        new Set(pendingTableIds).size !== pendingTableIds.length ||
        !Number.isSafeInteger(pendingTableCount) ||
        pendingTableCount < pendingTableIds.length ||
        (result.created && (!createdTableId || !pendingTableIds.includes(createdTableId)))
      ) {
        reportError(
          new Error('capacity RPC returned an invalid durable table hand-off'),
          'Tournament.dynamic_expansion_table_handoff_invalid'
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.LATE_REG_REDRIVE_MS);
        return false;
      }

      // The pending set includes tables created by a registration transaction,
      // whose HTTP response can never safely mutate this process. Admit every
      // exact receipt before acknowledging any of them; a lost acknowledgement
      // simply returns the same idempotent hand-off to this manager or its
      // successor after a crash.
      for (const tableId of pendingTableIds) {
        if (!this.eliminationMutationAllowed()) return false;
        if (!this.tableEngines.has(tableId)) {
          const engine = this.createManagedTableEngine(tableId);
          engine.setHub(tableStateHub); // Phase 1.1 PR-2
          this.wireEliminationWake(engine);
          this.tableEngines.set(tableId, engine);
          this.admitManagedTableEngine(tableId, engine);
          this.startManagedTableEngine(engine, 'Tournament.dynamic_expansion_table_engine_error', {
            tableId,
          });
          newTableIds.push(tableId);
        }
        admittedCapacity = true;
      }

      if (pendingTableIds.length > 0) {
        // Queue the seating pass before the acknowledgement RPC. If its response
        // is lost after the database commits, the admitted engine still gets a
        // causal seating pass in this lifecycle.
        this.requestUrgentEliminationSweepAfter(0);
        const { data: ackData, error: ackError } = await supabase.rpc(
          'fn_ack_tournament_capacity_tables',
          { p_tournament_id: this.tournamentId, p_table_ids: pendingTableIds }
        );
        if (!this.eliminationMutationAllowed()) return false;
        const acknowledgement = (ackData ?? {}) as {
          ok?: boolean;
          reason?: string;
          requested?: number;
        };
        if (
          ackError ||
          acknowledgement.ok !== true ||
          Number(acknowledgement.requested) !== pendingTableIds.length
        ) {
          reportError(
            new Error(
              `capacity table admission acknowledgement failed: ${ackError?.message ?? acknowledgement.reason ?? 'invalid contract'}`
            ),
            'Tournament.dynamic_expansion_table_handoff_ack_failed'
          );
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.LATE_REG_REDRIVE_MS);
          return false;
        }
      }

      if (result.created) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Capacity authority created table ${createdTableId.slice(0, 8)} ` +
            `(Table ${Number(result.table_number) || '?'}, ${Number(result.table_capacity) || '?'} seats, ` +
            `${remainingDeficit} seat deficit remaining)`
        );
      }

      // Drain a bounded receipt backlog before this captured durable wake can
      // be acknowledged. Otherwise a process crash between wake-ack and the
      // next local pass could leave a committed table with no dealer.
      if (pendingTableCount > pendingTableIds.length) {
        if (i === TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE - 1) {
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.LATE_REG_REDRIVE_MS);
          return false;
        }
        continue;
      }

      // A sufficient-capacity result is a successful no-op after all durable
      // table hand-offs have been admitted. A created table loops once more so
      // the locked authority, not this process, decides whether another is due.
      if (!result.created) break;
    }

    if (!admittedCapacity) return true;
    if (remainingDeficit > 0) this.requestEliminationSweep('capacity_deficit_remains');

    // ensureLateRegSeated runs before expansion in the sweep. Requeue this
    // manager now that real capacity exists so the entrant promoted to
    // `playing` above cannot disappear after this causal pass completes.
    this.requestUrgentEliminationSweepAfter(0);

    // Now rebalance players across ALL tables using the same bounded snapshot
    // path as ordinary balancing; never return to two requests per table.
    const allTables = await this.loadBalancerTables([...this.tableEngines.keys()], 'postExpansion');
    if (!allTables) return false;

    // Calculate optimal moves to balance all tables
    let rebalanceComplete = true;
    if (this.tableBalancer.shouldRebalance(allTables)) {
      const moves = this.tableBalancer.calculateMoves(allTables);
      if (moves.length > 0) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Post-expansion rebalance: ${moves.length} player moves`
        );
        // 2026-08-18: this was the one move site with no hand-boundary wait.
        // The table-break path (above) and the gap-rebalance path both wait,
        // with a comment saying why: executePlayerMoves reads table_seats.stack,
        // which is only written at settlement, so moving a player mid-hand
        // carries their PRE-hand stack to the new table while the old table
        // still pays out the pot. An all-in player moved this way is cloned —
        // their chips arrive at the new table and are also collected by whoever
        // wins the hand they left behind. Late registration overflowing table
        // capacity is exactly when this fires.
        const sourceTables = [...new Set(moves.map((m) => m.fromTableId))] as string[];
        const unsafeTables = new Set<string>();
        for (const t of sourceTables) {
          const safe = await this.waitForHandComplete(t);
          if (!this.eliminationMutationAllowed()) return false;
          if (!safe) unsafeTables.add(t);
        }
        const safeMoves = moves.filter((m) => !unsafeTables.has(m.fromTableId));
        if (unsafeTables.size > 0) {
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Deferring ${moves.length - safeMoves.length} post-expansion move(s) - source table(s) still in-hand`
          );
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          rebalanceComplete = false;
        }
        if (safeMoves.length > 0) {
          const movedCount = await this.executePlayerMoves(safeMoves);
          if (!this.eliminationMutationAllowed()) return false;
          if (movedCount < safeMoves.length) {
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
            rebalanceComplete = false;
          }
        }
      }
    }

    if (newTableIds.length > 0) {
      await this.broadcast('table_expansion', {
        newTableIds,
        totalTables: this.tableEngines.size,
        totalPlayers: totalPlaying,
        reason: 'rebuy_reentry_overflow',
      });
    }
    if (remainingDeficit > 0 || !rebalanceComplete) return false;
    return true;
  }
}
