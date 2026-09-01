/**
 * TournamentManager, layer 3/3 — table balancing, satellites, late reg.
 *
 * Split out of the 4,096-line `src/GameServer.ts` monolith on 2026-07-28
 * (engine audit D21 — god-class decomposition). Behavior is preserved
 * line-for-line: the only edits are module boundaries, `private` widened to
 * `protected` where a member is reached across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { supabase } from '../services/supabase.js';
import { planSatelliteAwards } from './satelliteAwardPlan.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { isSatelliteTargetOpen, satelliteTicketCost } from './satelliteTargetOpen.js';
import { type BalancerTable, type MoveInstruction } from '../engine/TableBalancer.js';
import { reportError } from '../services/errorReporter.js';
import { tableStateHub } from '../transport/TableStateHub.js';
import { TournamentManagerEliminations } from './TournamentManagerEliminations.js';
// The DECK is the tournament ceiling, never the cash seat law — see the note on
// the same import in TournamentManagerBase.ts. Reused from the engine's own
// VariantRules rather than copied, so the seating path and the deal path read
// the same number.
import { maxSeatsFor as maxSeatsTheDeckAllows } from '../engine/VariantRules.js';
import { mayTakeSeat } from './seatClaim.js';

export class TournamentManager extends TournamentManagerEliminations {
  protected async checkTableBalance(): Promise<void> {
    // Check for final table (table_size or fewer players remaining, 2026-08-22
    // parity: was hardcoded 9) — only announce once
    if (!this.isFinalTable) {
      const { count: remainingPlayers } = await supabase
        .from('tournament_players')
        .select('*', { count: 'exact', head: true })
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'playing');

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
       * the same shape) opened voting, and `fn_final_table_deal` would chop
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
      if ((remainingPlayers || 0) <= finalTableSize) {
        const liveTables = await this.countLiveTablesWithPlayers();
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
          if (flagErr) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] could not persist final_table_triggered (${flagErr.message}) - the announcement still went out, but a reconnecting client will not see the final-table theme`
              ),
              'Tournament.final_table_flag_write_failed'
            );
          }
          await this.broadcast('final_table', { playerCount: remainingPlayers || 0 });
        } else if (liveTables !== null && liveTables > 1) {
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] ${remainingPlayers} players left but still spread over ${liveTables} tables - NOT the final table until the balancer consolidates`
          );
        }
      }
    }

    if (this.tableEngines.size <= 1) return;

    // ── FIX 154: Build BalancerTable[] from live DB state ──
    const balancerTables: BalancerTable[] = [];
    for (const tableId of this.tableEngines.keys()) {
      const { data: seats } = await supabase
        .from('table_seats')
        .select('user_id, stack, seat_number')
        .eq('table_id', tableId)
        .is('left_at', null);

      const { data: tableRow } = await supabase
        .from('tables')
        .select('max_players')
        .eq('id', tableId)
        .maybeSingle();

      balancerTables.push({
        tableId,
        playerCount: (seats || []).length,
        maxSeats: tableRow?.max_players || 9,
        // B6: current button seat (0 before the first hand) so the balancer can
        // move the big-blind-due-next player instead of the smallest stack.
        buttonSeat: this.tableEngines.get(tableId)?.getCurrentButtonSeat() ?? 0,
        players: (seats || []).map((s: any) => ({
          userId: s.user_id,
          stack: s.stack || 0,
          seat: s.seat_number || 0,
        })),
      });
    }

    // ── STEP 1: Check if any table should be broken (merged into others) ──
    for (const bt of balancerTables) {
      if (this.tableBalancer.shouldBreakTable(bt, balancerTables)) {
        const otherTables = balancerTables.filter((t) => t.tableId !== bt.tableId);
        const breakMoves = this.tableBalancer.breakTable(bt, otherTables);

        if (breakMoves.length > 0 && breakMoves.length === bt.playerCount) {
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
            if (!safe) {
              // TOURNEY-AUDIT 2026-07-24 (sweep 4): never move players mid-hand.
              console.warn(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Table ${bt.tableId.slice(0, 8)} still in-hand after 60s - deferring break to next balance cycle`
              );
              continue;
            }
          }

          const movedCount = await this.executePlayerMoves(breakMoves);

          // LIVE E2E FIX 2026-08-15: the table was previously closed even when
          // some moves FAILED — the unmoved players kept 'playing' status and
          // chips but pointed at a closed table no balance pass ever looks at
          // again (checkTableBalance iterates tableEngines only). Seen live on
          // 3 frozen tournaments + "Late Night Grind", where the stall ended in
          // a force-complete that paid 1st place to an already-eliminated
          // player. Close ONLY when every player actually arrived; otherwise
          // keep the table alive and let the next cycle retry the remainder.
          if (movedCount < breakMoves.length) {
            console.warn(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Table break of ${bt.tableId.slice(0, 8)} incomplete - ${movedCount}/${breakMoves.length} moved. Deferring close to next balance cycle.`
            );
            this.breakOccurredThisCycle = true;
            break;
          }

          // Close the broken table's engine
          if (engine) {
            await engine.stop();
          }
          this.tableEngines.delete(bt.tableId);
          tableStateHub.dropTable(bt.tableId); // Phase 1.1 PR-2: release hub room
          await supabase.from('tables').update({ status: 'closed' }).eq('id', bt.tableId);

          await this.broadcast('table_rebalance', {
            closedTableId: bt.tableId,
            movedPlayers: breakMoves.length,
            reason: 'table_break',
          });

          // Round 51 RE-RUN-2: signal expansion to skip this cycle so we
          // don't immediately re-create the table we just broke.
          this.breakOccurredThisCycle = true;

          break; // One break per cycle to avoid stale data
        }
      }
    }

    // ── STEP 2: Standard gap-1 rebalancing across remaining tables ──
    // Re-fetch after potential break (tables may have changed)
    if (this.tableEngines.size > 1) {
      const freshTables: BalancerTable[] = [];
      for (const tableId of this.tableEngines.keys()) {
        const { data: seats } = await supabase
          .from('table_seats')
          .select('user_id, stack, seat_number')
          .eq('table_id', tableId)
          .is('left_at', null);

        const { data: tableRow } = await supabase
          .from('tables')
          .select('max_players')
          .eq('id', tableId)
          .maybeSingle();

        freshTables.push({
          tableId,
          playerCount: (seats || []).length,
          maxSeats: tableRow?.max_players || 9,
          // B6: current button seat (0 before the first hand) so the balancer
          // can move the big-blind-due-next player instead of the smallest stack.
          buttonSeat: this.tableEngines.get(tableId)?.getCurrentButtonSeat() ?? 0,
          players: (seats || []).map((s: any) => ({
            userId: s.user_id,
            stack: s.stack || 0,
            seat: s.seat_number || 0,
          })),
        });
      }

      if (this.tableBalancer.shouldRebalance(freshTables)) {
        const moves = this.tableBalancer.calculateMoves(freshTables);
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
            if (!safe) unsafeTables.add(t);
          }
          // TOURNEY-AUDIT 2026-07-24 (sweep 4): drop moves from tables still
          // in-hand instead of moving players with stale mid-hand stacks.
          const safeMoves = moves.filter((m) => !unsafeTables.has(m.fromTableId));
          if (unsafeTables.size > 0) {
            console.warn(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Deferring ${moves.length - safeMoves.length} rebalance move(s) - source table(s) still in-hand`
            );
          }
          if (safeMoves.length > 0) {
            await this.executePlayerMoves(safeMoves);

            await this.broadcast('table_rebalance', {
              moveCount: safeMoves.length,
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
  protected async executePlayerMoves(moves: MoveInstruction[]): Promise<number> {
    let moved = 0;
    for (const move of moves) {
      try {
        // SWEEP #4 P1-4 FIX (2026-07-23): read the source stack BEFORE marking the
        // old seat left. The old order marked left first, then read the (now-left)
        // seat with .order('left_at' desc).maybeSingle(); on a transient read error
        // or empty result oldSeat was null → the player was re-seated with `stack: 0`
        // → eliminated on the next checker pass. MoveInstruction carries no stack, so
        // if we cannot read a real source stack we ABORT this move (leave the player
        // at the source table) and let the next rebalance pass retry — never seat at 0.
        const { data: oldSeat, error: readErr } = await supabase
          .from('table_seats')
          .select('stack')
          .eq('table_id', move.fromTableId)
          .eq('user_id', move.playerId)
          .is('left_at', null)
          .maybeSingle();

        if (readErr || oldSeat == null || oldSeat.stack == null) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Aborting move for ${move.playerId.slice(0, 8)} - could not read source stack (readErr=${readErr?.message ?? 'none'}, seat=${oldSeat ? 'found' : 'null'}). Leaving player at source table to avoid 0-stack elimination; will retry next rebalance.`
            ),
            'Tournament.Move_aborted_no_source_stack'
          );
          continue;
        }

        /**
         * A MOVE MUST NOT COMPOUND A DUPLICATE (2026-08-25).
         *
         * Vacating the source seat, below, only guarantees ONE live seat if
         * the source is the only one the player holds. On `bae46dbf` 72
         * players were holding two live seats each before any move was
         * attempted; moving one of them writes a THIRD live row and carries
         * the source stack to it, while the other seat keeps being dealt.
         *
         * Checked BEFORE anything is stamped, so a refusal leaves the player
         * exactly where they were and touches nothing. Which of two diverged
         * stacks is the real one is a money decision — it is not this
         * balancer's to make, so it reports and stands down.
         */
        const moveClaim = await mayTakeSeat(
          supabase,
          this.tournamentId,
          move.playerId,
          move.fromTableId
        );
        if (!moveClaim.allowed) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Aborting move for ${move.playerId.slice(0, 8)} - ${moveClaim.reason}. The player stays at table ${move.fromTableId.slice(0, 8)}; moving them would leave a third live seat.`
            ),
            moveClaim.unknown
              ? 'Tournament.Move_aborted_seat_claim_unreadable'
              : 'Tournament.Move_aborted_player_already_seated_twice'
          );
          continue;
        }

        // Mark old seat as left (now that we have the real stack) to prevent duplicate active seats
        await supabase
          .from('table_seats')
          .update({ left_at: new Date().toISOString() })
          .eq('table_id', move.fromTableId)
          .eq('user_id', move.playerId)
          .is('left_at', null);

        // LIVE E2E FIX 2026-08-15: table_seats keeps ONE ROW PER (table_id,
        // seat_number) — seats are reused by UPDATE, never re-INSERT. The old
        // blind INSERT here died on unique-violation 23505 whenever the
        // destination seat number had EVER been occupied before (i.e. on
        // almost every table with history), was never error-checked, and the
        // player was left seatless with the old seat already marked left.
        // Update-first (reusing the left row), insert only if the seat row
        // has never existed, and on ANY failure restore the source seat so
        // the player is never seatless.
        const nowIso = new Date().toISOString();
        const { data: reusedRows, error: reuseErr } = await supabase
          .from('table_seats')
          .update({
            user_id: move.playerId,
            stack: oldSeat.stack,
            left_at: null,
            joined_at: nowIso,
            // Seat turnover: never inherit the previous occupant's sit-out
            // flag (trg_clear_sitout_on_turnover backstops every writer).
            is_sitting_out: false,
          })
          .eq('table_id', move.toTableId)
          .eq('seat_number', move.toSeat)
          .not('left_at', 'is', null)
          .select('id');

        let seatWriteErr: { message?: string } | null = reuseErr;

        if (!seatWriteErr && reusedRows && reusedRows.length > 0) {
          // Un-assign the old occupant whose seat we just reused, avoiding the ghost seat bug
          // (which can crash the engine with deck_capacity_exceeded if 11 players point to a 9-max table).
          await supabase
            .from('tournament_players')
            .update({ table_id: null, seat_number: null })
            .eq('tournament_id', this.tournamentId)
            .eq('table_id', move.toTableId)
            .eq('seat_number', move.toSeat)
            .neq('user_id', move.playerId);
        }

        if (!seatWriteErr && (!reusedRows || reusedRows.length === 0)) {
          const { error: insErr } = await supabase.from('table_seats').insert({
            table_id: move.toTableId,
            user_id: move.playerId,
            seat_number: move.toSeat,
            stack: oldSeat.stack,
            joined_at: nowIso,
          });
          seatWriteErr = insErr;
        }

        if (seatWriteErr) {
          // DUPLICATE-SEAT FIX 2026-08-20: do NOT restore the source seat
          // without first checking whether the destination write actually
          // landed.
          //
          // A write that fails CLIENT-side may well have COMMITTED
          // server-side -- a statement timeout or a dropped connection
          // returns an error for a transaction the database already
          // applied. Restoring the source seat on top of a destination
          // seat that exists leaves the player holding TWO live seats.
          //
          // Five players in production are in exactly that state, and the
          // signature is unmistakable: both rows carry the SAME stack
          // (Late Night Grind 1113/1113, 796/796, 1950/1950), i.e. the
          // destination copy succeeded and the source was revived anyway.
          //
          // Two live seats is not cosmetic. The chip sync and the rebuy /
          // add-on RPC both had to pick one, and picking the stale one
          // either erases a purchase or reports the wrong stack outright --
          // in Union Grand Championship the stale seat held 15,000 against
          // a real stack of 2,728,737.
          const { data: destSeat } = await supabase
            .from('table_seats')
            .select('id')
            .eq('table_id', move.toTableId)
            .eq('seat_number', move.toSeat)
            .eq('user_id', move.playerId)
            .is('left_at', null)
            .maybeSingle();

          if (destSeat) {
            // The write did land. The move is complete; leave the source
            // seat closed and carry on rather than manufacturing a duplicate.
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Destination seat write for ${move.playerId.slice(0, 8)} reported an error (${seatWriteErr.message ?? 'unknown'}) but COMMITTED. Treating the move as successful and leaving the source seat closed, so the player is not left holding two live seats.`
              ),
              'Tournament.Move_dest_seat_write_false_negative'
            );
            continue;
          }

          // Genuinely not written. Re-activate the source seat so the player
          // stays seated at the (not yet closed) source table and the next
          // cycle retries.
          await supabase
            .from('table_seats')
            .update({ left_at: null })
            .eq('table_id', move.fromTableId)
            .eq('user_id', move.playerId)
            .eq('seat_number', move.fromSeat);
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Destination seat write failed for ${move.playerId.slice(0, 8)} → table ${move.toTableId.slice(0, 8)} seat ${move.toSeat}: ${seatWriteErr.message ?? 'unknown'}. Source seat restored; will retry next cycle.`
            ),
            'Tournament.Move_dest_seat_write_failed'
          );
          continue;
        }

        // Update tournament_players table_id
        await supabase
          .from('tournament_players')
          .update({ table_id: move.toTableId })
          .eq('tournament_id', this.tournamentId)
          .eq('user_id', move.playerId);

        moved++;
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Moved ${move.playerId.slice(0, 8)}: table ${move.fromTableId.slice(0, 8)} seat ${move.fromSeat} → table ${move.toTableId.slice(0, 8)} seat ${move.toSeat}`
        );
      } catch (moveErr) {
        reportError(moveErr, 'TournamentthistournamentIdslic.Move_failed_for_moveplayerIdsl');
      }
    }
    return moved;
  }

  /**
   * Wait for any active hand on a table to complete before stopping engine.
   * Polls every 2s, up to 30s timeout.
   */
  /**
   * TOURNEY-AUDIT 2026-07-24 (sweep 4): two fixes.
   * (a) WIRING: the old check queried hand_history with ended_at IS NULL —
   *     but hand_history rows are only INSERTED at hand COMPLETION (always
   *     with ended_at stamped), so the query never matched and the "wait"
   *     was a no-op: every table break / rebalance proceeded immediately,
   *     including mid-hand. The live in-flight-hand tracker is
   *     hand_state_snapshots (is_complete = false) — used now.
   * (b) Returns whether the table is actually SAFE to move players from.
   *     After the 60s budget, callers now SKIP the move for this cycle
   *     instead of proceeding mid-hand (chips created/destroyed).
   */
  protected async waitForHandComplete(tableId: string): Promise<boolean> {
    const isIdle = async (): Promise<boolean> => {
      const { data: snap } = await supabase
        .from('hand_state_snapshots')
        .select('id')
        .eq('table_id', tableId)
        .eq('is_complete', false)
        .limit(1)
        .maybeSingle();
      return !snap;
    };

    if (await isIdle()) return true;
    let waited = 0;
    while (waited < 60000 && this.running) {
      await new Promise((r) => setTimeout(r, 2000));
      waited += 2000;
      if (await isIdle()) return true;
    }
    return false;
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
  protected async processSatelliteAwards(tournament: any): Promise<void> {
    const pool = Math.round(Number(tournament?.prize_pool || 0) * 100) / 100;
    if (pool <= 0) return;

    const targetId = tournament?.satellite_target_id as string | null;
    interface SatelliteTarget {
      id: string;
      name: string | null;
      buy_in_amount: number;
      buy_in_fee: number;
      status: string;
      max_players: number | null;
      current_players: number | null;
      current_level: number | null;
      late_reg_levels: number | null;
      rebuy_levels: number | null;
      prize_pool_finalized: boolean | null;
    }
    let target: SatelliteTarget | null = null;
    if (targetId) {
      const { data, error: targetErr } = await supabase
        .from('tournaments')
        .select(
          'id, name, buy_in_amount, buy_in_fee, status, max_players, current_players, current_level, late_reg_levels, rebuy_levels, prize_pool_finalized'
        )
        .eq('id', targetId)
        .maybeSingle();

      /**
       * ═══════════════════════════════════════════════════════════════════
       *  AN UNREADABLE TARGET IS NOT A MISSING TARGET (2026-08-29)
       * ═══════════════════════════════════════════════════════════════════
       *
       * The error was discarded, and the consequences of that are not
       * subtle. `target === null` drives `ticketCost` to 0, which drives
       * `seats` to 0, which sends the WHOLE PRIZE POOL down the cash path
       * below and pays it to `ranked[0]`.
       *
       * So a 200ms blip reading one row turns an N-seat satellite into
       * winner-take-all cash. On the Sunday Major Satellite that is five
       * promised seats collapsing into one cash payment to one player, and
       * the event then completes, so there is nothing left to retry.
       *
       * A row that is genuinely absent (`targetId` set, no error, no data) is
       * a different thing and still falls through to cash on purpose:
       * advertised seats into a vanished target would otherwise pay nothing
       * at all. What must never happen is DECIDING on a read that failed.
       */
      if (targetErr) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] satellite target ${targetId.slice(0, 8)} unreadable (${targetErr.message}) - awarding nothing this pass rather than paying the pool out as cash`
          ),
          'Tournament.satellite_target_unreadable'
        );
        return;
      }
      target = (data as SatelliteTarget | null) ?? null;
    }
    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  A RUNNING TARGET IN LATE REG IS OPEN, AND AN UNSPENDABLE TICKET IS
     *  WORTH NOTHING (2026-08-30)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Both rules, and the incident that produced them, are documented on
     * `satelliteTargetOpen.ts`. They live there rather than here because this
     * method needs four Supabase round trips and a running tournament to
     * enter, which is precisely why the bug survived: a decision that hands
     * out real chips had nothing able to test it.
     *
     * In short: a satellite normally ends AFTER its target has started, so
     * refusing a RUNNING target cashed out tickets while late registration
     * stood open; and pricing the ticket off the target row merely EXISTING
     * (rather than being enterable) paid those cashed tickets at full face
     * value out of a pool that never held it — 3,582.50 chips across fifteen
     * satellites, one of them paying 1,000 from a pool of 108.
     */
    const targetOpen = isSatelliteTargetOpen(target);
    const ticketCost = satelliteTicketCost(target, targetOpen);

    // Finishers ordered best-first
    const { data: finishers, error: finishersErr } = await supabase
      .from('tournament_players')
      .select('user_id, username, position, status')
      .eq('tournament_id', this.tournamentId)
      .not('position', 'is', null)
      .order('position', { ascending: true });

    /**
     * The same rule, the other way up (2026-08-29). This read's error was
     * discarded too, and an unreadable list became an EMPTY list -- which
     * returns here and leaves the entire satellite pool undistributed, with
     * the event completing anyway. Nobody is paid at all.
     *
     * An empty list with no error is a real answer (nobody reached a paid
     * place) and still returns. A failed read is UNKNOWN and says so.
     */
    if (finishersErr) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] satellite finishers unreadable (${finishersErr.message}) - awarding nothing this pass rather than treating it as an empty field`
        ),
        'Tournament.satellite_finishers_unreadable'
      );
      return;
    }
    const ranked = finishers ?? [];
    if (ranked.length === 0) return;

    // 2026-08-23 parity follow-up: satellite_seats is the ADVERTISED seat
    // count and wins when set (the 2026-08-22 template stores it; the Sunday
    // Major Satellite promises 5). floor(pool / ticket) remains the fallback
    // for legacy satellites created before the column existed. With no open
    // target (ticketCost 0) seats stay 0 so the whole pool falls through to
    // the cash path below — advertised seats into a vanished target would
    // otherwise pay nothing at all.
    /* THE ARITHMETIC LIVES IN satelliteAwardPlan.ts (2026-08-26).
       Same numbers, same order, now reachable without a database. This method
       needs four Supabase round trips and a running tournament to enter, which
       is why the decisions that hand out real chips had no test coverage at
       all while carrying three separate fixed money bugs. It is a function
       now, pinned by satelliteAwardPlan.test.ts. */
    const plan = planSatelliteAwards({
      pool,
      ticketCost,
      configuredSeats: Number((tournament as { satellite_seats?: unknown })?.satellite_seats ?? 0),
      finisherCount: ranked.length,
    });
    const awardCount = plan.awardCount;
    const remainder = plan.remainder;

    /* A GUARANTEE THAT THE FIELD DID NOT FUND IS THE HOUSE PAYING, and that
       should be visible rather than inferred from a ledger later. This is the
       exposure a `satelliteSeats` promise deliberately accepts. */
    if (plan.overlay > 0) {
      console.log(
        `[Satellite:${this.tournamentId.slice(0, 8)}] guarantee overlay ${plan.overlay} chips: ${awardCount} seat(s) at ${ticketCost} against a ${pool} pool`
      );
    }

    // A3 FIX (2026-07-28): satellite cash payouts are re-driveable. Errors are
    // swallowed by the caller, which leaves the tournament stuck in COMPLETING;
    // the watchdog (`recoverStuckCompletingTournaments`) then re-pays finishers
    // under `tourney:{id}:prize:{user}:{position}` - keys this path never wrote.
    // Every payCash call site now supplies a key, and the position-prize sites
    // use the watchdog's exact format so the two paths dedupe against each other.
    const payCash = async (
      userId: string,
      amount: number,
      desc: string,
      idempotencyKey: string
    ) => {
      if (amount <= 0) return;
      // LEDGER-INTEGRITY 2026-08-22: credit and ledger row under one key.
      // These sites share `tourney:{id}:prize:{user}:{place}` with the
      // stuck-COMPLETING watchdog deliberately, so the credit deduped — but
      // the log used to run regardless and wrote a prize row for money that
      // was never moved.
      const { error } = await supabase.rpc('fn_credit_and_log', {
        p_user_id: userId,
        p_amount: amount,
        p_idempotency_key: idempotencyKey,
        p_category: 'prize',
        p_description: desc,
        p_related_entity_id: this.tournamentId,
      });
      if (error) {
        reportError(
          new Error(
            `[Satellite:${this.tournamentId.slice(0, 8)}] cash credit failed: ${error.message}`
          ),
          'Tournament.satellite_cash_failed'
        );
        return;
      }
    };

    if (awardCount === 0) {
      // No target / pool below one ticket — whole pool is cash to 1st place
      await payCash(
        ranked[0].user_id,
        pool,
        `Satellite payout (no target seats available): ${tournament?.name || 'satellite'}`,
        `tourney:${this.tournamentId}:prize:place:${ranked[0].position}`
      );
      await supabase
        .from('tournament_players')
        .update({ prize: pool })
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', ranked[0].user_id);
      return;
    }

    for (let i = 0; i < awardCount; i++) {
      const w = ranked[i];
      if (targetOpen && target) {
        /**
         * THE MONEY FOLLOWS THE PLAYER (2026-08-23).
         *
         * This was a raw INSERT of a tournament_players row at chips 0. It
         * seated the winner and moved nothing else: the target's prize_pool
         * never grew, no rake row was written, and the satellite's own
         * collected pool was never disbursed to anybody. So the chips players
         * paid into the satellite were destroyed, and the target went on to
         * pay a pool one buy-in short for every seat it took in.
         *
         * fn_award_satellite_seat does the seating and the money in one
         * transaction under a row lock — prize_pool += target buy-in, rake
         * row for the target fee — which is exactly where a direct buy-in
         * would have landed, funded by the ticket the satellite pool just
         * bought. It is idempotent: the movement happens only when the seat
         * row is genuinely inserted, so a recovery re-drive seats nobody
         * twice and credits nothing twice.
         */
        const { data: seatRes, error: seatErr } = await supabase.rpc('fn_award_satellite_seat', {
          p_satellite_id: this.tournamentId,
          p_target_id: target.id,
          p_user_id: w.user_id,
          p_username: w.username || 'Player',
          // PHASE 5: the finishing place, so the payout record this function
          // now writes for the seat can say WHICH place won it. Everything
          // else about the award was already recorded; the place was not.
          p_position: w.position,
        });
        const seat = seatRes as {
          ok?: boolean;
          awarded?: boolean;
          reason?: string;
          /** true / false / null, where NULL means "cannot tell". See below. */
          held_from_this_satellite?: boolean | null;
          origin_unknown?: boolean;
        } | null;
        const regErr =
          seatErr || (seat?.ok === false ? { message: seat?.reason || 'seat_refused' } : null);
        if (regErr && !/duplicate|unique|already_registered/i.test(regErr.message || '')) {
          // Registration failed for a real reason — pay ticket value in cash
          await payCash(
            w.user_id,
            ticketCost,
            `Satellite seat fallback (registration failed): ${target.name || 'target'}`,
            `tourney:${this.tournamentId}:prize:place:${w.position}`
          );
        } else if (
          seat?.ok === true &&
          seat?.awarded === false &&
          seat?.held_from_this_satellite === false
        ) {
          /**
           * A SECOND WIN IS NEVER WORTH ZERO (2026-08-30 satellite audit).
           *
           * `awarded: false` means the player already holds the target seat.
           * When THIS satellite is the one that seated them, this is a
           * recovery re-drive and paying again would be a double payment —
           * stay silent. When a DIFFERENT satellite (or a direct buy-in)
           * seated them, this satellite collected their buy-in, promised a
           * seat it cannot deliver, and used to hand them NOTHING: four
           * winners across 1a6f53a4, acb14548 and e3d3bd1e received neither
           * seat nor cash (back-paid in the same migration that taught
           * fn_award_satellite_seat to report `held_from_this_satellite`).
           * The ticket value is paid as cash instead, under the same stable
           * place key, so a re-drive of THIS pass dedupes to nothing.
           *
           * An old fn without the flag returns `undefined`, which lands in
           * neither branch — the conservative pre-migration behaviour.
           */
          await payCash(
            w.user_id,
            ticketCost,
            `Satellite seat already held - ticket value paid in cash: ${target.name || 'target'}`,
            `tourney:${this.tournamentId}:prize:place:${w.position}`
          );
          console.log(
            `[Satellite:${this.tournamentId.slice(0, 8)}] Seat already held elsewhere - ticket cashed: ${w.user_id.slice(0, 8)}`
          );
        } else if (seat?.ok === true && seat?.awarded === false && seat?.origin_unknown === true) {
          /**
           * WE CANNOT TELL WHO SEATED THEM, SO WE DO NOT PAY (2026-08-31).
           *
           * `held_from_this_satellite` is NULL when the seat row predates
           * fn_award_satellite_seat writing `source_satellite_id`, which it
           * only began doing on 2026-08-30. 19 seats are in that state.
           *
           * The branch above pays the ticket value in cash on `=== false`,
           * meaning "a DIFFERENT satellite seated them". NULL is not that; it
           * is "unknown", and answering it with the branch that moves money
           * would hand the ticket value to a player who may already hold the
           * seat THIS satellite bought them.
           *
           * So nothing is paid, and it is said out loud. A missed payment is
           * visible and recoverable; a double payment is neither. If the alert
           * shows a player who really is owed, the ticket can be paid by hand
           * under this satellite's own place key, which still dedupes.
           */
          await raiseFinancialAlert(
            'warning',
            'Satellite.seat_origin_unknown',
            `Satellite winner already holds the target seat and the seat predates origin tracking, so it cannot be told whether THIS satellite seated them. No cash paid; needs a human.`,
            {
              tournament_id: this.tournamentId,
              target_id: target.id,
              user_id: w.user_id,
              position: w.position,
              ticket_value: ticketCost,
            }
          );
          console.warn(
            `[Satellite:${this.tournamentId.slice(0, 8)}] Seat origin UNKNOWN for ${w.user_id.slice(0, 8)} - paid nothing, alert raised`
          );
        } else {
          console.log(
            `[Satellite:${this.tournamentId.slice(0, 8)}] Seat awarded: ${w.user_id.slice(0, 8)} -> ${target.name || target.id.slice(0, 8)}`
          );
        }
      } else {
        // Target closed/missing — ticket value in cash
        await payCash(
          w.user_id,
          ticketCost,
          `Satellite ticket cashed (target unavailable): ${tournament?.name || 'satellite'}`,
          `tourney:${this.tournamentId}:prize:place:${w.position}`
        );
      }
      const { error: prizeStampErr } = await supabase
        .from('tournament_players')
        .update({ prize: ticketCost })
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', w.user_id);
      if (prizeStampErr) {
        // 2026-08-30: this write failed silently during the Supabase
        // degradation and left every e3d3bd1e winner recorded at prize 0
        // while holding a funded seat. The stamp is a RECORD, not money —
        // report it, never abort the loop over it.
        reportError(
          new Error(
            `[Satellite:${this.tournamentId.slice(0, 8)}] prize stamp failed for ${w.user_id.slice(0, 8)}: ${prizeStampErr.message}`
          ),
          'Tournament.satellite_prize_stamp_failed'
        );
      }
    }

    // Remainder → next finisher as cash (or last seat winner if field exhausted)
    if (remainder > 0) {
      const nextFinisher = ranked[awardCount] || ranked[awardCount - 1];
      await payCash(
        nextFinisher.user_id,
        remainder,
        `Satellite remainder payout: ${tournament?.name || 'satellite'}`,
        // Deliberately a DIFFERENT namespace from the position prize above:
        // `nextFinisher` falls back to `ranked[awardCount - 1]`, who may already
        // have been paid under `prize:{user}:{position}`. Reusing that key would
        // silently swallow the remainder instead of deduping a double-pay.
        `tourney:${this.tournamentId}:satremainder:${nextFinisher.user_id}:${nextFinisher.position}`
      );
    }
    if (targetOpen && target && awardCount > 0) {
      // MULTI-TABLE AUDIT 2026-08-19: was
      //   current_players: Number(target.current_players || 0) + awardCount
      // — a read-modify-write on a snapshot taken BEFORE all the payout
      // awaits above (the same bug shape the 2026-07-21 union-rake fix in
      // TournamentManagerEliminations closed). Any human registering into the
      // target through fn_register_for_tournament (which increments
      // current_players atomically under a row lock) between our read and
      // this write was ERASED from the count; it also counted seats whose
      // insert deduped as already_registered or fell back to a cash payout.
      // Recount from tournament_players — the table fn_register/unregister
      // themselves insert into/delete from — so the write converges on truth
      // instead of compounding a stale snapshot.
      const { count: targetCount, error: countErr } = await supabase
        .from('tournament_players')
        .select('user_id', { count: 'exact', head: true })
        .eq('tournament_id', target.id);
      if (countErr || typeof targetCount !== 'number') {
        reportError(
          new Error(
            `[Satellite:${this.tournamentId.slice(0, 8)}] target recount failed: ${countErr?.message ?? 'no count'} - leaving current_players untouched`
          ),
          'Tournament.satellite_target_recount_failed'
        );
      } else {
        await supabase
          .from('tournaments')
          .update({ current_players: targetCount })
          .eq('id', target.id);
      }
    }
  }

  protected async ensureLateRegSeated(): Promise<void> {
    try {
      if (this.tournamentCache?.status && this.tournamentCache.status !== 'RUNNING') return;
      const { data: entrants } = await supabase
        .from('tournament_players')
        .select('user_id, username, status, chips')
        .eq('tournament_id', this.tournamentId)
        .in('status', ['registered', 'playing']);
      if (!entrants || entrants.length === 0) return;

      // Active tables of THIS tournament (DB-grounded, not the in-memory map)
      const { data: tourneyTables } = await supabase
        .from('tables')
        .select('id, max_players')
        .eq('tournament_id', this.tournamentId)
        .in('status', ['waiting', 'running', 'RUNNING', 'active']);
      if (!tourneyTables || tourneyTables.length === 0) return;
      const tableIds = tourneyTables.map((t) => t.id);

      const { data: seatRows } = await supabase
        .from('table_seats')
        .select('user_id, table_id, seat_number')
        .in('table_id', tableIds)
        .is('left_at', null);
      const seatedUsers = new Set((seatRows ?? []).map((s) => s.user_id));
      const unseated = entrants.filter((e) => !seatedUsers.has(e.user_id));
      if (unseated.length === 0) return;

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
          // a new table spawns this same cycle and we seat next cycle.
          if (player.status === 'registered') {
            await supabase
              .from('tournament_players')
              .update({ status: 'playing', chips: playerChips })
              .eq('tournament_id', this.tournamentId)
              .eq('user_id', player.user_id)
              .eq('status', 'registered');
          }
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
         * five-second cycle; seating them twice double-counts their stack for
         * the rest of the tournament.
         */
        const claim = await mayTakeSeat(supabase, this.tournamentId, player.user_id);
        if (!claim.allowed) {
          if (claim.unknown) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Not seating ${player.user_id.slice(0, 8)} - ${claim.reason}. The sweep retries in 5s.`
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
                `[Tournament:${this.tournamentId.slice(0, 8)}] Could not reuse seat ${seatNumber} at table ${best.tableId.slice(0, 8)} for ${player.user_id.slice(0, 8)}: ${reuseErr.message}. Player is registered and UNSEATED; the sweep will retry in 5s.`
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
                  `[Tournament:${this.tournamentId.slice(0, 8)}] Could not seat ${player.user_id.slice(0, 8)} at table ${best.tableId.slice(0, 8)} seat ${seatNumber}: ${seatErr.message}. Player is registered and UNSEATED; the sweep will retry in 5s.`
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
    }
  }

  /**
   * FIX 155: Dynamic table creation during rebuy/re-entry/late-reg period.
   * When player count exceeds (tableCount × maxPerTable), create new tables
   * and rebalance players across all tables using TableBalancer.
   *
   * Called from the elimination checker cycle so it runs every 5s.
   */
  // Round 51 RE-RUN-2 fix: when a table was just broken in the same
  // elimination-loop cycle, skip expansion. Otherwise the broken table's
  // close → reduces dbActiveTableCount → triggers fresh expansion → and
  // the next cycle breaks ANOTHER empty table → loop creates 12 new
  // tables/minute. Verified live on "Union PKO Afternoon" with 12 playing
  // / 2 active / 109 closed: 12 tables/min churn rate continued for 8+
  // minutes after the first defensive cap deployed.
  protected breakOccurredThisCycle = false;

  protected async checkDynamicTableExpansion(): Promise<void> {
    // Skip expansion in the same 5-second cycle as a break — gives
    // executePlayerMoves time to actually seat players to remaining tables
    // before we evaluate "are we over capacity?"
    if (this.breakOccurredThisCycle) {
      this.breakOccurredThisCycle = false;
      return;
    }

    // Only expand during rebuy/late-reg period (before prize pool is finalized)
    if (this.prizePoolFinalized) return;

    const lateRegLevelCap =
      this.tournamentCache?.late_reg_levels ?? this.tournamentCache?.rebuy_levels ?? 0;
    if (lateRegLevelCap <= 0) return; // No late reg/rebuy configured
    if (this.currentLevel >= lateRegLevelCap) return; // Past the cutoff

    // Count active playing players across all tables
    const { count: totalPlaying } = await supabase
      .from('tournament_players')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'playing');

    if (!totalPlaying || totalPlaying <= 0) return;

    // Determine max per table from tournament config
    const tType = (this.tournamentCache?.tournament_type || '').toUpperCase();
    const variant = (this.tournamentCache?.variant || '').toLowerCase();
    let maxPerTable = this.tournamentCache?.max_players || 9;
    if (variant === 'spin' || tType === 'SPIN') {
      maxPerTable = 3;
    } else if (variant === 'sng' || tType === 'SNG') {
      maxPerTable = Math.min(this.tournamentCache?.max_players || 6, 9);
    } else {
      // table_size (2026-08-22 parity): same clamp as createTablesAndSeatPlayers.
      maxPerTable = Math.min(10, Math.max(2, Number(this.tournamentCache?.table_size) || 9));
    }
    // Deck capacity wins over table_size - see the note in
    // TournamentManagerBase.createTablesAndSeatPlayers. An expansion table has
    // to be dealable for the same reason the original ones do. The ceiling is
    // the deck, floor((deck - 5) / holeCards), NOT the cash seat law: that law
    // is tuned to leave Run It Twice three boards, and Run It Twice is disabled
    // on tournament tables.
    maxPerTable = Math.min(
      maxPerTable,
      maxSeatsTheDeckAllows((this.tournamentCache?.game_type || '').toLowerCase())
    );

    // Round 51 RE-RUN fix: ground currentTableCount in the DB, not the
    // in-memory map. The in-memory map is volatile across engine restarts
    // and any code path that bypasses tableEngines.set(). Live evidence:
    // some tournaments accumulated 1000+ closed orphan rows (e.g. "Union
    // Mystery Bounty (PLO5)": 22 players, 1 active table in map, 1075
    // closed rows in DB — 600 created/hour during restart-heavy windows).
    // Using max(map.size, db_active_count) prevents creating duplicates
    // of tables that already exist in the DB; subsequent rebalance can
    // adopt them via the existing resume() path.
    const { count: dbActiveTableCount } = await supabase
      .from('tables')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', this.tournamentId)
      .in('status', ['running', 'waiting']);
    const currentTableCount = Math.max(this.tableEngines.size, dbActiveTableCount || 0);
    const totalCapacity = currentTableCount * maxPerTable;

    // Only create new tables when we're actually over capacity
    if (totalPlaying <= totalCapacity) return;

    const neededTables = Math.ceil(totalPlaying / maxPerTable);
    const tablesToCreate = neededTables - currentTableCount;
    if (tablesToCreate <= 0) return;

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] DYNAMIC TABLE EXPANSION: ${totalPlaying} players across ${currentTableCount} tables (capacity ${totalCapacity}) - creating ${tablesToCreate} new table(s)`
    );

    const blindStructure = this.tournamentCache?.blind_structure || [];
    // resolveBlindLevel, not a clamped index: past the end of the structure the
    // clamp built the new table at the last PERSISTED level while every other
    // table played an escalated one — a table joining a deep MTT with blinds
    // several levels behind the field.
    const currentLevelData = this.resolveBlindLevel(blindStructure, this.currentLevel) || {
      smallBlind: 10,
      bigBlind: 20,
      ante: 0,
    };

    const newTableIds: string[] = [];
    for (let i = 0; i < tablesToCreate; i++) {
      const tableNumber = currentTableCount + i + 1;

      const { data: newTable, error: createErr } = await supabase
        .from('tables')
        .insert({
          club_id: this.tournamentCache?.club_id,
          tournament_id: this.tournamentId,
          name: `${this.tournamentCache?.name || 'Tournament'} - Table ${tableNumber}`,
          game_type: 'tournament',
          game_variant: this.tournamentCache?.game_type?.toLowerCase() || 'nlh',
          stakes: `${currentLevelData.smallBlind}/${currentLevelData.bigBlind}`,
          small_blind: currentLevelData.smallBlind,
          big_blind: currentLevelData.bigBlind,
          ante: currentLevelData.ante || 0,
          min_buy_in: 0,
          max_buy_in: 0,
          max_players: maxPerTable,
          current_players: 0,
          status: 'running',
          // 2026-08-22 parity: expansion tables carry the same per-tournament
          // table settings as the ones built at start.
          action_time_seconds: this.tournamentCache?.action_time_seconds || 15,
          big_blind_ante_enabled: this.tournamentCache?.big_blind_ante === true,
          all_in_or_fold: this.tournamentCache?.all_in_or_fold === true,
        })
        .select()
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

      if (createErr || !newTable) {
        reportError(createErr, 'TournamentthistournamentIdslic.Failed_to_create_expansion_tab');
        continue;
      }

      // Create engine + register with game server
      const engine = new ServerTableEngine(newTable.id);
      engine.setHub(tableStateHub); // Phase 1.1 PR-2
      this.tableEngines.set(newTable.id, engine);
      this.gameServer.registerTableEngine(newTable.id, engine);
      engine
        .start()
        .catch((err) =>
          reportError(err, 'TournamentthistournamentIdslic.Expansion_table_engine_error')
        );
      newTableIds.push(newTable.id);

      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Created expansion table ${newTable.id.slice(0, 8)} (Table ${tableNumber})`
      );
    }

    if (newTableIds.length === 0) return;

    // Now rebalance players across ALL tables (existing + new) using TableBalancer
    // Build fresh BalancerTable snapshot
    const allTables: BalancerTable[] = [];
    for (const tableId of this.tableEngines.keys()) {
      const { data: seats } = await supabase
        .from('table_seats')
        .select('user_id, stack, seat_number')
        .eq('table_id', tableId)
        .is('left_at', null);

      allTables.push({
        tableId,
        playerCount: (seats || []).length,
        maxSeats: maxPerTable,
        // B6: current button seat (0 before the first hand) so the balancer can
        // move the big-blind-due-next player instead of the smallest stack.
        buttonSeat: this.tableEngines.get(tableId)?.getCurrentButtonSeat() ?? 0,
        players: (seats || []).map((s: any) => ({
          userId: s.user_id,
          stack: s.stack || 0,
          seat: s.seat_number || 0,
        })),
      });
    }

    // Calculate optimal moves to balance all tables
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
          if (!safe) unsafeTables.add(t);
        }
        const safeMoves = moves.filter((m) => !unsafeTables.has(m.fromTableId));
        if (unsafeTables.size > 0) {
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Deferring ${moves.length - safeMoves.length} post-expansion move(s) - source table(s) still in-hand`
          );
        }
        if (safeMoves.length > 0) {
          await this.executePlayerMoves(safeMoves);
        }
      }
    }

    // Broadcast expansion event
    await this.broadcast('table_expansion', {
      newTableIds,
      totalTables: this.tableEngines.size,
      totalPlayers: totalPlaying,
      reason: 'rebuy_reentry_overflow',
    });
  }
}
