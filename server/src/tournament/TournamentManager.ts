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
import { type BalancerTable, type MoveInstruction } from '../engine/TableBalancer.js';
import { reportError } from '../services/errorReporter.js';
import { tableStateHub } from '../transport/TableStateHub.js';
import { TournamentManagerEliminations } from './TournamentManagerEliminations.js';
import { clampSeatsForVariant } from '../config/tableSeating.js';

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
      if ((remainingPlayers || 0) <= finalTableSize) {
        this.isFinalTable = true;
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] FINAL TABLE reached with ${remainingPlayers} players`
        );
        await this.broadcast('final_table', { playerCount: remainingPlayers || 0 });
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
            `[Tournament:${this.tournamentId.slice(0, 8)}] Breaking table ${bt.tableId.slice(0, 8)} — moving ${breakMoves.length} players`
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
                `[Tournament:${this.tournamentId.slice(0, 8)}] Table ${bt.tableId.slice(0, 8)} still in-hand after 60s — deferring break to next balance cycle`
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
              `[Tournament:${this.tournamentId.slice(0, 8)}] Table break of ${bt.tableId.slice(0, 8)} incomplete — ${movedCount}/${breakMoves.length} moved. Deferring close to next balance cycle.`
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
              `[Tournament:${this.tournamentId.slice(0, 8)}] Deferring ${moves.length - safeMoves.length} rebalance move(s) — source table(s) still in-hand`
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
              `[Tournament:${this.tournamentId.slice(0, 8)}] Aborting move for ${move.playerId.slice(0, 8)} — could not read source stack (readErr=${readErr?.message ?? 'none'}, seat=${oldSeat ? 'found' : 'null'}). Leaving player at source table to avoid 0-stack elimination; will retry next rebalance.`
            ),
            'Tournament.Move_aborted_no_source_stack'
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
    }
    let target: SatelliteTarget | null = null;
    if (targetId) {
      const { data } = await supabase
        .from('tournaments')
        .select('id, name, buy_in_amount, buy_in_fee, status, max_players, current_players')
        .eq('id', targetId)
        .maybeSingle();
      target = (data as SatelliteTarget | null) ?? null;
    }
    const targetOpen =
      !!target && ['ANNOUNCED', 'REGISTERING'].includes((target.status || '').toUpperCase());
    const ticketCost = target
      ? Math.round((Number(target.buy_in_amount || 0) + Number(target.buy_in_fee || 0)) * 100) / 100
      : 0;

    // Finishers ordered best-first
    const { data: finishers } = await supabase
      .from('tournament_players')
      .select('user_id, username, position, status')
      .eq('tournament_id', this.tournamentId)
      .not('position', 'is', null)
      .order('position', { ascending: true });
    const ranked = finishers ?? [];
    if (ranked.length === 0) return;

    // 2026-08-23 parity follow-up: satellite_seats is the ADVERTISED seat
    // count and wins when set (the 2026-08-22 template stores it; the Sunday
    // Major Satellite promises 5). floor(pool / ticket) remains the fallback
    // for legacy satellites created before the column existed. With no open
    // target (ticketCost 0) seats stay 0 so the whole pool falls through to
    // the cash path below — advertised seats into a vanished target would
    // otherwise pay nothing at all.
    const configuredSeats = Math.max(
      0,
      Math.floor(Number((tournament as { satellite_seats?: unknown })?.satellite_seats) || 0)
    );
    const seats =
      ticketCost > 0 ? (configuredSeats > 0 ? configuredSeats : Math.floor(pool / ticketCost)) : 0;
    const awardCount = Math.min(seats, ranked.length);
    const remainder = Math.round((pool - awardCount * ticketCost) * 100) / 100;

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
        `tourney:${this.tournamentId}:prize:${ranked[0].user_id}:${ranked[0].position}`
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
        });
        const seat = seatRes as { ok?: boolean; reason?: string } | null;
        // A refusal that is simply "they already hold this seat" is success.
        const regErr =
          seatErr || (seat?.ok === false ? { message: seat?.reason || 'seat_refused' } : null);
        if (regErr && !/duplicate|unique|already_registered/i.test(regErr.message || '')) {
          // Registration failed for a real reason — pay ticket value in cash
          await payCash(
            w.user_id,
            ticketCost,
            `Satellite seat fallback (registration failed): ${target.name || 'target'}`,
            `tourney:${this.tournamentId}:prize:${w.user_id}:${w.position}`
          );
        } else {
          console.log(
            `[Satellite:${this.tournamentId.slice(0, 8)}] Seat awarded: ${w.user_id.slice(0, 8)} → ${target.name || target.id.slice(0, 8)}`
          );
        }
      } else {
        // Target closed/missing — ticket value in cash
        await payCash(
          w.user_id,
          ticketCost,
          `Satellite ticket cashed (target unavailable): ${tournament?.name || 'satellite'}`,
          `tourney:${this.tournamentId}:prize:${w.user_id}:${w.position}`
        );
      }
      await supabase
        .from('tournament_players')
        .update({ prize: ticketCost })
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', w.user_id);
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
            `[Satellite:${this.tournamentId.slice(0, 8)}] target recount failed: ${countErr?.message ?? 'no count'} — leaving current_players untouched`
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
        const playerChips =
          player.status === 'registered'
            ? startingChips + Math.max(0, Math.floor(Number(player.chips) || 0))
            : Number(player.chips || 0) <= 0
              ? startingChips
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
        if (reuseErr) continue;
        if (!reusedRows || reusedRows.length === 0) {
          const { error: seatErr } = await supabase.from('table_seats').insert({
            table_id: best.tableId,
            user_id: player.user_id,
            seat_number: seatNumber,
            stack: playerChips,
          });
          if (seatErr) {
            // Unique-index race (already seated elsewhere this instant) — skip
            continue;
          }
        }
        occ.taken.add(seatNumber);

        await supabase
          .from('tournament_players')
          .update({ status: 'playing', chips: playerChips, table_id: best.tableId })
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
    // to be dealable for the same reason the original ones do.
    maxPerTable = clampSeatsForVariant(
      (this.tournamentCache?.game_type || '').toLowerCase(),
      maxPerTable
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
      `[Tournament:${this.tournamentId.slice(0, 8)}] DYNAMIC TABLE EXPANSION: ${totalPlaying} players across ${currentTableCount} tables (capacity ${totalCapacity}) — creating ${tablesToCreate} new table(s)`
    );

    const blindStructure = this.tournamentCache?.blind_structure || [];
    const currentLevelData = blindStructure[
      Math.min(this.currentLevel, blindStructure.length - 1)
    ] || { smallBlind: 10, bigBlind: 20, ante: 0 };

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
            `[Tournament:${this.tournamentId.slice(0, 8)}] Deferring ${moves.length - safeMoves.length} post-expansion move(s) — source table(s) still in-hand`
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
