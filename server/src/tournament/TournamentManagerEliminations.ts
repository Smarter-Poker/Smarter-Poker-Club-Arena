/**
 * TournamentManager, layer 2/3 — eliminations, bounties, payouts.
 *
 * Split out of the 4,096-line `src/GameServer.ts` monolith on 2026-07-28
 * (engine audit D21 — god-class decomposition). Behavior is preserved
 * line-for-line: the only edits are module boundaries, `private` widened to
 * `protected` where a member is reached across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import nodeCrypto from 'node:crypto';
import { supabase } from '../services/supabase.js';
import { reportError } from '../services/errorReporter.js';
import { mysteryChestHoldMs } from '../config/mysteryChestSpec.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { computePlacePrize } from './payoutMath.js';
import {
  resolvePayoutStructure,
  isSpinTournament,
  remainingPoolAfterAwards,
} from './payoutStructure.js';

export abstract class TournamentManagerEliminations extends TournamentManagerBase {
  protected startEliminationChecker(): void {
    this.eliminationTimer = setInterval(async () => {
      if (!this.running || this.isProcessingEliminations) return;
      this.isProcessingEliminations = true;

      try {
        // ── SYNC STACKS: table_seats → tournament_players ──
        // The poker engine updates table_seats.stack after each hand. Collect all
        // seat stacks across every table, then push them to tournament_players in
        // ONE bulk statement (fn_sync_tournament_chips) instead of one UPDATE per
        // seat per table every 5s (the old N+1 that flooded Postgres logs).
        const chipUpdates: { user_id: string; chips: number }[] = [];
        for (const [tableId] of this.tableEngines) {
          const { data: seats } = await supabase
            .from('table_seats')
            .select('user_id, stack')
            .eq('table_id', tableId)
            .is('left_at', null);

          if (seats) {
            for (const seat of seats) {
              // Guard against corrupted stack values (NaN, negative, undefined).
              const stackValue =
                typeof seat.stack === 'number' && !isNaN(seat.stack) && seat.stack >= 0
                  ? seat.stack
                  : 0;
              // Floor here too — tournament_players.chips is INTEGER (the RPC also
              // floors, but keep the payload clean).
              chipUpdates.push({ user_id: seat.user_id, chips: Math.floor(stackValue) });
            }
          }
        }

        if (chipUpdates.length > 0) {
          const { error: syncErr } = await supabase.rpc('fn_sync_tournament_chips', {
            p_tournament_id: this.tournamentId,
            p_updates: chipUpdates,
          });
          if (syncErr) reportError(syncErr, 'GameServer.syncTournamentChips');
        }

        // Find ALL busted players (0 chips) in a single query
        let { data: busted } = await supabase
          .from('tournament_players')
          .select('user_id, chips')
          .eq('tournament_id', this.tournamentId)
          .eq('status', 'playing')
          .lte('chips', 0);

        /**
         * ═══════════════════════════════════════════════════════════════════
         *  A ZERO-CHIP FIELD IS NEVER A RESULT (2026-08-23)
         * ═══════════════════════════════════════════════════════════════════
         *
         * Two guards, because the absence of them cost 276 Spins in one day.
         *
         * GUARD 1 — the credit is still pending. A Spin seats its field as
         * reservations at zero chips and writes the real stacks only once the
         * wheel stops. `bustingArmedAt` is the instant that credit is due; a
         * sweep before it is reading placeholders, not a poker result.
         *
         * GUARD 2 — the whole field reads zero. Chips are conserved: every
         * chip one player loses another player gains, so the sum of live
         * stacks is a constant and cannot be zero while anybody is still
         * playing. "every remaining player has <= 0" is therefore not a state
         * poker can produce. It means the stacks were never written, or the
         * seat sync failed, and the only correct response is to bust NOBODY
         * and let the next sweep read real numbers.
         *
         * What the old code did instead: spare the arbitrary largest of the
         * zeroes, eliminate the rest, and hand that player first prize. Buy-ins
         * collected, prize paid, not one card dealt.
         *
         * GUARD 2 is deliberately independent of GUARD 1 rather than folded
         * into it — a process restart inside the reveal window rearms nothing,
         * and a broken seat sync is not on a timer at all.
         */
        if (busted && busted.length > 0 && Date.now() < this.bustingArmedAt) {
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Bust sweep held — stacks not credited yet (${Math.ceil(
              (this.bustingArmedAt - Date.now()) / 1000
            )}s)`
          );
          return; // the finally block clears isProcessingEliminations
        }

        if (busted && busted.length > 0) {
          const { count: liveCount, error: liveErr } = await supabase
            .from('tournament_players')
            .select('*', { count: 'exact', head: true })
            .eq('tournament_id', this.tournamentId)
            .eq('status', 'playing');
          if (!liveErr && typeof liveCount === 'number' && liveCount > 0 && busted.length >= liveCount) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] all ${liveCount} live player(s) read 0 chips — uncredited stacks, not a bust. Eliminating nobody this sweep.`
              ),
              'Tournament.zero_chip_field_refused'
            );
            return; // the finally block clears isProcessingEliminations
          }
        }

        if (busted && busted.length > 0) {
          // Get current remaining count BEFORE processing any eliminations
          const { count: playingCount, error: playingErr } = await supabase
            .from('tournament_players')
            .select('*', { count: 'exact', head: true })
            .eq('tournament_id', this.tournamentId)
            .eq('status', 'playing');

          // PAYOUT-INTEGRITY 2026-08-20: finishing positions are derived from
          // this count, and a wrong count produces COLLIDING positions (see
          // the basePosition note below) which pay the same place twice. If we
          // could not read it, assign nothing this cycle.
          if (playingErr || playingCount === null || playingCount === undefined) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] playing count unavailable (${playingErr?.message ?? 'null count'}) — deferring ${busted.length} elimination(s)`
              ),
              'Tournament.playing_count_unavailable'
            );
            return; // the finally block clears isProcessingEliminations
          }

          // FIX-B2 2026-07-19: assign DISTINCT finishing places to players busted
          // in the same sweep. The old code gave them all one shared position, so
          // eliminatePlayer (which pays payouts.find(place === position)) paid that
          // one place multiple times and never paid the place(s) between — a
          // prize-pool leak + double-pay + wrong standings. Standard rule: a larger
          // stack finishes higher, so order the busted set by chip count and hand
          // out places from the bottom up (worst = smallest stack = lowest place).
          // basePosition = players still 'playing' (busted included); the worst
          // finisher takes basePosition, the next takes basePosition-1, etc. With
          // >=1 survivor these are all >= 2, leaving 1st for finishTournament.
          // (Exact-tie ordering by hand-start stack for a genuine same-hand double
          // bust is a documented follow-up; distinct places is money-correct now.)
          // TOURNAMENT REBUYS 2026-08-20: a busted player who is entitled to a
          // rebuy is not out yet. Before anyone is assigned a finishing place,
          // give the eligible ones the chance to buy back in; whoever does is
          // removed from this sweep and keeps playing.
          //
          // Until now NOTHING triggered a tournament rebuy or add-on. The
          // engine has auto-rebuy for CASH tables only, and
          // process_tournament_rebuy's sole caller was the SPA, which needs a
          // human at a keyboard. With no humans the feature had never executed
          // once: zero 'addon' wallet rows in all of history and the last
          // 'rebuy' row dated 2026-04-19, while events were being scheduled
          // with rebuy_cost, rebuy_levels 6 and max_rebuys 2 configured and
          // ready. The money path was correct and simply unreachable.
          const rebought = await this.tryTournamentRebuys(busted.map((b) => b.user_id));
          if (rebought.size > 0) {
            busted = busted.filter((b) => !rebought.has(b.user_id));
            if (busted.length === 0) {
              return; // everyone bought back in; nobody is eliminated this pass
            }
          }

          let bustedOrdered = [...busted].sort((a, b) => (a.chips ?? 0) - (b.chips ?? 0));

          // TOURNEY-AUDIT 2026-07-24 [double-pay guard]: if EVERY remaining
          // player busted in the same sweep, the old loop handed position 1 to
          // the largest stack via eliminatePlayer (paying the 1st-place prize)
          // and then the remainingCount===0 branch ALSO paid the winner via
          // finishTournament — 1st place paid twice. Spare the top stack from
          // elimination; the winner path below then pays them exactly once.
          if (playingCount === busted.length && bustedOrdered.length > 0) {
            bustedOrdered = bustedOrdered.slice(0, -1);
          }

          // PAYOUT-INTEGRITY 2026-08-20: positions MUST be distinct. This was
          //     const position = Math.max(2, basePosition - i);
          // and the clamp is a double-pay generator: whenever basePosition was
          // smaller than the number of players being eliminated, every position
          // that computed below 2 collapsed onto 2, so several players were
          // stamped place 2 and EACH collected a full 2nd-place prize. The
          // wallet idempotency key is `tourney:{id}:prize:{user}:{place}` --
          // it dedupes a repeated user, not a repeated PLACE -- so nothing
          // downstream caught it. Observed in 11 tournaments (12 extra
          // payments); e.g. Early Bird Freeroll ad750179 paid place 2 to two
          // different players and disbursed 93.75 against a 75.00 pool.
          //
          // Flooring basePosition at bustedOrdered.length + 1 makes the run
          // basePosition .. basePosition-(n-1) strictly decreasing and always
          // >= 2, so places are distinct by construction and place 1 stays
          // reserved for the winner. No clamp required.
          const basePosition = Math.max(playingCount, bustedOrdered.length + 1);

          for (let i = 0; i < bustedOrdered.length; i++) {
            const position = basePosition - i;
            await this.eliminatePlayer(bustedOrdered[i].user_id, position);
          }
        }

        // Check remaining players AFTER all eliminations processed
        const { count: remainingCount, error: remainingErr } = await supabase
          .from('tournament_players')
          .select('*', { count: 'exact', head: true })
          .eq('tournament_id', this.tournamentId)
          .eq('status', 'playing');

        // PAYOUT-INTEGRITY 2026-08-20: a FAILED count must never read as
        // "nobody is left". This line used to be `(remainingCount || 0) <= 1`,
        // and on a supabase timeout `count` comes back null -> `|| 0` -> 0 ->
        // "<= 1" is true -> the tournament finishes while players are still
        // seated and playing. That is exactly how Afternoon Bounty (NLH) and
        // Union PKO Afternoon (PLO4) ended on 2026-08-20 with 5 and 4 players
        // still status='playing' and position=NULL: the survivors were the
        // paid places, so their prize money (289.80 + 346.50) was never
        // emitted and became unattributable. The same shape is visible across
        // history in 113 multi-place tournaments.
        //
        // A count we could not read is UNKNOWN, not zero. Skip this cycle and
        // re-check on the next one; the tournament stays live and no money
        // moves on the strength of a failed query.
        if (remainingErr || remainingCount === null || remainingCount === undefined) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] remaining-player count unavailable (${remainingErr?.message ?? 'null count'}) — skipping finish check this cycle`
            ),
            'Tournament.remaining_count_unavailable'
          );
        } else if (remainingCount <= 1) {
          try {
            // Use maybeSingle to handle edge case where 0 players remain
            const { data: winner } = await supabase
              .from('tournament_players')
              .select('user_id')
              .eq('tournament_id', this.tournamentId)
              .eq('status', 'playing')
              .maybeSingle();

            if (winner) {
              await this.finishTournament(winner.user_id);
            } else if ((remainingCount || 0) === 0) {
              // All players busted simultaneously — pick the last eliminated as winner
              const { data: lastEliminated } = await supabase
                .from('tournament_players')
                .select('user_id')
                .eq('tournament_id', this.tournamentId)
                .eq('status', 'eliminated')
                .order('eliminated_at', { ascending: false })
                .limit(1)
                .maybeSingle();

              if (lastEliminated) {
                console.log(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] All busted simultaneously — last eliminated wins`
                );
                await this.finishTournament(lastEliminated.user_id);
              }
            }
          } catch (finishErr) {
            reportError(finishErr, 'TournamentthistournamentIdslic.finishTournament_error__will_r');
          }
        }

        // TOURNEY-AUDIT 2026-07-24 (sweep 6): server-authoritative seating —
        // late registrants / re-entries are seated within one cycle; if every
        // table is full they're marked 'playing' so checkDynamicTableExpansion
        // spawns a table and the balancer redraws. No player ever waits.
        await this.ensureLateRegSeated();

        // FINAL TABLE DEAL (2026-08-22 parity): while the field is down to one
        // table and the feature is on, watch tournament_deal_votes; unanimity
        // executes fn_final_table_deal. Cheap by construction — it stands down
        // immediately unless the flag is set, and throttles its own polling.
        await this.checkFinalTableDeal();

        // ADD-ONS MUST ALWAYS LAND 2026-08-20. Dan: an add-on must always
        // award its chips to the stack when purchased.
        //
        // process_tournament_rebuy now refuses to charge a player who has no
        // live seat, because granting chips to a seatless player is what let
        // the seat sync erase them (103 add-ons charged on the first window
        // ever run, ~91 delivering nothing). That closes the money hole, but
        // on its own it would COST those players their add-on: the offer used
        // to be made exactly once, when the window opened, and a player who
        // happened to be mid-table-move at that instant was simply skipped
        // forever.
        //
        // So the offer repeats for as long as the window is open. Anyone who
        // was between seats gets theirs on a later pass, the moment they are
        // seated again. Re-offering is safe by construction: the add-on
        // carries a wallet idempotency key of
        // `tourney:{id}:addon:{user}` and the RPC also rejects a second one
        // with 'Add-on already taken', so nobody can buy twice.
        //
        // Throttled to 20s because the sweep itself runs every 5s.
        if (this.addOnPeriodTriggered && !this.prizePoolFinalized) {
          const nowMs = Date.now();
          if (nowMs - this.lastAddOnOfferAt >= 20_000) {
            this.lastAddOnOfferAt = nowMs;
            await this.tryTournamentAddOns();
          }
        }

        await this.checkTableBalance();

        // FIX 155: Check if new tables need to be created during rebuy/late-reg period
        await this.checkDynamicTableExpansion();

        // ── HAND-FOR-HAND BUBBLE MODE ──
        // Multi-table tournaments only (not Spin/SNG single-table)
        if (this.tableEngines.size > 1 && this.tournamentCache) {
          const isSpin =
            this.tournamentCache.variant === 'spin' ||
            this.tournamentCache.tournament_type === 'SPIN';
          if (!isSpin) {
            const { count: playingNow } = await supabase
              .from('tournament_players')
              .select('*', { count: 'exact', head: true })
              .eq('tournament_id', this.tournamentId)
              .eq('status', 'playing');

            let payoutCount = 0;
            if (this.tournamentCache.payout_structure) {
              let payouts = this.tournamentCache.payout_structure;
              if (typeof payouts === 'string') {
                try {
                  payouts = JSON.parse(payouts);
                } catch {
                  payouts = [];
                }
              }
              if (Array.isArray(payouts)) payoutCount = payouts.length;
            }

            if (
              payoutCount > 0 &&
              (playingNow || 0) === payoutCount + 1 &&
              !this.handForHandActive
            ) {
              this.handForHandActive = true;
              if (!this.handForHandAnnounced) {
                this.handForHandAnnounced = true;
                console.log(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] HAND-FOR-HAND — ${playingNow} players, ${payoutCount} paid`
                );
                await this.broadcast('hand_for_hand', {
                  active: true,
                  playersRemaining: playingNow,
                  paidPositions: payoutCount,
                });
                // Pause all table engines for hand-for-hand sync
                for (const engine of this.tableEngines.values()) {
                  engine.pauseAfterHand();
                }
                // Start hand-for-hand sync check
                this.startHandForHandSync();
              }
            } else if (this.handForHandActive && (playingNow || 0) <= payoutCount) {
              // Bubble burst — resume normal play
              this.handForHandActive = false;
              this.stopHandForHandSync();
              console.log(
                `[Tournament:${this.tournamentId.slice(0, 8)}] BUBBLE BURST — ${playingNow} players ITM`
              );
              await this.broadcast('bubble_burst', { playersRemaining: playingNow });
              // Resume all engines permanently
              for (const engine of this.tableEngines.values()) {
                engine.resumeDealing();
              }
            }
          }
        }
      } catch (err) {
        reportError(err, 'TournamentthistournamentIdslic.Elimination_check_error');
      } finally {
        this.isProcessingEliminations = false;
      }
    }, TournamentManagerBase.ELIMINATION_SWEEP_MS);
  }

  /**
   * Give busted HORSES their rebuy, exactly as a human would take one.
   *
   * Every eligibility rule (rebuys offered, inside the rebuy level window,
   * under max_rebuys, stack low enough) is enforced inside
   * process_tournament_rebuy, which also does the chip debit, the prize-pool
   * increment and the single rake booking in one transaction. So this asks
   * and lets the database say no -- the refusals ('Rebuy limit reached',
   * 'Insufficient club chips', 'Rebuy period has closed') are all NORMAL and
   * are counted, not reported as errors.
   *
   * Horses only. A real player's rebuy is their own decision and is taken
   * through the client.
   *
   * Bounded by construction: max_rebuys (2 on the scheduled events) and the
   * rebuy level window, both enforced server-side, so this cannot loop.
   */
  private async tryTournamentRebuys(bustedUserIds: string[]): Promise<Set<string>> {
    const rebought = new Set<string>();
    const t = this.tournamentCache as
      | { is_rebuy?: boolean; rebuy_levels?: number | null; late_reg_levels?: number | null }
      | undefined;
    if (!t?.is_rebuy || bustedUserIds.length === 0) return rebought;

    // Cheap pre-check so a closed rebuy period costs no round trips at all.
    const cap = t.rebuy_levels ?? t.late_reg_levels ?? 0;
    if (cap > 0 && this.currentLevel > cap) return rebought;

    try {
      const { data: horseRows, error: horseErr } = await supabase
        .from('profiles')
        .select('id')
        .in('id', bustedUserIds)
        .eq('is_horse', true);
      if (horseErr || !horseRows || horseRows.length === 0) return rebought;

      const declined = new Map<string, number>();
      for (const h of horseRows) {
        const { data, error } = await supabase.rpc('process_tournament_rebuy', {
          p_tournament_id: this.tournamentId,
          p_user_id: h.id,
          p_rebuy_type: 'rebuy',
          // null: let the server price it. Passing a client-side quote here
          // would only risk a spurious 'Price mismatch'.
          p_cost: null,
          p_chips: null,
          p_current_level: this.currentLevel,
        });
        if (error) {
          declined.set(error.message, (declined.get(error.message) || 0) + 1);
          continue;
        }
        if ((data as { success?: boolean } | null)?.success === true) rebought.add(h.id);
      }

      if (rebought.size > 0) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] ${rebought.size} rebuy(s) taken at level ${this.currentLevel}`
        );
      }
      if (declined.size > 0) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] rebuys declined — ` +
            [...declined.entries()].map(([m, n]) => `${m} x${n}`).join(', ')
        );
      }
    } catch (err) {
      reportError(err, 'Tournament.tournament_rebuy_threw');
    }
    return rebought;
  }

  /**
   * Vacate every seat this player holds AT THIS TOURNAMENT'S TABLES.
   *
   * Idempotent by construction (`.is('left_at', null)`), so it is safe to call
   * from the already-eliminated early return as well as the main path.
   *
   * SCOPE, 2026-08-18: this UPDATE used to be scoped by user_id alone, so
   * busting a player out of a tournament stamped left_at on EVERY open seat
   * they held — including cash tables. Players are not confined to one context
   * (HorseFleetManager explicitly allows multi-tabling, and registerHorses only
   * excludes horses busy in another TOURNAMENT), so a bustout could silently
   * eject someone from a cash game they were winning, stranding the stack in a
   * left_at row that atomicCashout never sees.
   *
   * The result is CHECKED, 2026-08-23. It was not, and a seat release that
   * fails silently is indistinguishable from one that never ran — which is
   * exactly how "the busted player is still sitting there" reaches a player
   * with nothing in the logs to explain it.
   */
  protected async releaseTournamentSeat(userId: string): Promise<void> {
    try {
      const { data: tournamentTables, error: tablesErr } = await supabase
        .from('tables')
        .select('id')
        .eq('tournament_id', this.tournamentId);

      if (tablesErr) {
        console.error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] seat release: could not list tables — ${tablesErr.message}`
        );
        return;
      }

      const tournamentTableIds = (tournamentTables ?? []).map((t: { id: string }) => t.id);
      if (tournamentTableIds.length === 0) {
        console.warn(
          `[Tournament:${this.tournamentId.slice(0, 8)}] seat release: no tables carry this tournament_id — ${userId.slice(0, 8)} may still be seated`
        );
        return;
      }

      const { error: seatErr } = await supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .eq('user_id', userId)
        .in('table_id', tournamentTableIds)
        .is('left_at', null);

      if (seatErr) {
        console.error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] seat release FAILED for ${userId.slice(0, 8)} — ${seatErr.message}`
        );
      }

      /**
       * Dan 2026-08-23: "when a player busts, they must be removed as soon as
       * they are out." The seat above is released immediately, but the player
       * COUNT was not: tournaments.current_players is a registration counter
       * that only ever climbs. A busted player therefore still occupied a seat
       * as far as the lobby tile and the seat-first start gate were concerned,
       * which is how live spins ended up advertising 3/3 with seats standing
       * empty and refusing every attempt to buy one.
       *
       * Re-derive both counters from the seat rows that are actually live.
       * Best-effort: a counter that fails to refresh must never abort a
       * bust-out mid-payout.
       */
      const { error: syncErr } = await supabase.rpc('fn_sync_seat_first_player_count', {
        p_tournament_id: this.tournamentId,
      });
      if (syncErr) {
        reportError(syncErr, 'TournamentManagerEliminations.seat_count_resync_failed');
      }
    } catch (err) {
      reportError(err, 'Tournament.release_tournament_seat_threw');
    }
  }

  protected async eliminatePlayer(userId: string, position: number): Promise<void> {
    // Guard: check if already eliminated (prevents double-processing)
    const { data: playerCheck, error: checkErr } = await supabase
      .from('tournament_players')
      .select('status')
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', userId)
      .maybeSingle();

    if (
      checkErr ||
      !playerCheck ||
      playerCheck.status === 'eliminated' ||
      playerCheck.status === 'winner'
    ) {
      /* Dan 2026-08-23: a busted player must not keep the seat.
         This early return is correct for the money and the position — those
         are already done — but it used to skip the seat release at the bottom
         of this method too. Any elimination first marked by another path (the
         recovery watchdog, ChipRaceEngine, a raced sweep) therefore left the
         player sitting at the table forever, because the ONLY code that
         stamps left_at is below this line. Releasing is idempotent, so run it
         on the way out. */
      if (!checkErr && playerCheck?.status === 'eliminated') {
        await this.releaseTournamentSeat(userId);
      }
      return; // Already processed
    }

    const { data: tournament } = await supabase
      .from('tournaments')
      .select(
        // spin_multiplier + tournament_type: a Spin's payout split is a pure
        // function of its multiplier, so the spec can rebuild the structure
        // when the stored column is unreadable. See payoutStructure.ts.
        // bubble_protection + buy_in_amount (2026-08-22 parity): the stone
        // bubble's buy-in refund needs both.
        'payout_structure, prize_pool, is_bounty, is_pko, is_mystery_bounty, bounty_amount, mystery_bounty_min, mystery_bounty_max, variant, tournament_type, spin_multiplier, bubble_protection, buy_in_amount'
      )
      .eq('id', this.tournamentId)
      .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

    let prize = 0;
    // TOURNEY-AUDIT 2026-07-24 (sweep 6): SATELLITES pay SEATS, not cash — the
    // award happens once at finishTournament (top finishers are registered
    // into the target tournament). Per-elimination cash would double-dip.
    const isSatellite = (tournament as any)?.variant === 'satellite';
    if (!isSatellite && tournament) {
      // resolvePayoutStructure parses the stored column and, for a Spin whose
      // column is missing or malformed, rebuilds it from the canonical spec.
      // Places 2..N are paid HERE, minutes before finishTournament reads the
      // same column again — so the two reads must agree, and a Spin that can
      // reconstruct its own split is how they are made to.
      const payouts = resolvePayoutStructure(tournament as any);
      if (payouts) {
        prize = computePlacePrize(Number(tournament.prize_pool || 0), payouts, position);
      }
    }

    const { error: updateErr, count: updateCount } = await supabase
      .from('tournament_players')
      .update({
        status: 'eliminated',
        position,
        prize,
        eliminated_at: new Date().toISOString(),
      })
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', userId)
      .eq('status', 'playing'); // Only update if still playing (prevents double-processing)

    if (updateErr || (updateCount !== null && updateCount === 0)) {
      return; // Player was already eliminated by another process
    }

    /* Dan 2026-08-23: "they must be removed from the table... it currently
       doesn't remove them."

       The seat release used to sit at the very BOTTOM of this method, behind
       the bounty block — a knocker lookup, a 10-row hand_history scan and an
       RPC, every one of them an awaited round-trip, all wrapped in a try that
       swallows. A player whose bust triggered any of that stayed visibly
       seated for the duration, and the 5s sweep can already lag the bust by
       hands. The seat is not payment and it is not attribution: it is the one
       thing another player is waiting on. Release it the instant the status
       write commits. */
    await this.releaseTournamentSeat(userId);

    if (prize > 0) {
      // Retry prize credit up to 3 times with exponential backoff
      let creditSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        // LEDGER-INTEGRITY 2026-08-22: credit AND ledger row under one
        // idempotency key. This used to be `credit_player_wallet` followed by
        // an unconditional `log_wallet_transaction`; the credit deduped
        // against the recovery watchdog and the log did not, so a raced
        // finish wrote a second prize row for chips nobody received.
        const { error: creditErr } = await supabase.rpc('fn_credit_and_log', {
          p_user_id: userId,
          p_amount: prize,
          // P1 FIX (2026-07-24): idempotency key so a committed-but-timed-out
          // credit is a no-op on the next retry attempt (no double prize mint),
          // and so the recovery path dedupes against this main path — SAME format
          // (`tourney:{id}:prize:{user}:{position}`).
          p_idempotency_key: `tourney:${this.tournamentId}:prize:${userId}:${position}`,
          p_category: 'prize',
          p_description: `Tournament prize: position ${position}`,
          p_related_entity_id: this.tournamentId,
        });
        if (!creditErr) {
          creditSuccess = true;
          break;
        }
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Prize credit attempt ${attempt}/3 failed for ${userId.slice(0, 8)}: ${creditErr.message}`
          ),
          'TournamentthistournamentIdslic.Prize_credit_attempt_attempt3_'
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
      }
      if (!creditSuccess) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Prize credit FAILED after 3 retries for ${userId.slice(0, 8)} — ${prize} chips lost`
          ),
          'TournamentthistournamentIdslic.CRITICAL'
        );
      }
    }

    // ── BUBBLE PROTECTION (2026-08-22 parity) ──
    // The stone bubble — eliminated exactly one place before the money — gets
    // their buy-in back when the tournament opted in. Positions are distinct
    // by construction (see the basePosition notes above), so exactly one
    // player can ever hold paidPlaces + 1; the in-memory flag and the
    // per-user idempotency key are belt and braces on top of that.
    if (!isSatellite && tournament && (tournament as any).bubble_protection === true && prize <= 0) {
      try {
        const payouts = resolvePayoutStructure(tournament as any);
        const paidPlaces = Array.isArray(payouts) ? payouts.length : 0;
        const refund = Math.max(0, Number((tournament as any).buy_in_amount || 0));
        if (
          !this.bubbleProtectionPaid &&
          paidPlaces > 0 &&
          position === paidPlaces + 1 &&
          refund > 0
        ) {
          this.bubbleProtectionPaid = true;
          // LEDGER-INTEGRITY 2026-08-22: credit AND ledger row under one
          // idempotency key via fn_credit_and_log — never a credit followed by
          // a separately-gated log (see the prize path above for why).
          const { error: bpErr } = await supabase.rpc('fn_credit_and_log', {
            p_user_id: userId,
            p_amount: refund,
            p_idempotency_key: `tourney:${this.tournamentId}:bubbleprotection:${userId}`,
            p_category: 'refund',
            p_description: `Bubble protection: buy-in returned (bubbled at position ${position})`,
            p_related_entity_id: this.tournamentId,
          });
          if (bpErr) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Bubble protection credit FAILED for ${userId.slice(0, 8)}: ${bpErr.message}`
              ),
              'Tournament.bubble_protection_credit_failed'
            );
          } else {
            await this.broadcast('bubble_protection_paid', {
              userId,
              position,
              amount: refund,
            });
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] BUBBLE PROTECTION: ${userId.slice(0, 8)} refunded ${refund} at position ${position}`
            );
          }
        }
      } catch (bpThrew) {
        reportError(bpThrew, 'Tournament.bubble_protection_threw');
      }
    }

    // ── BOUNTY / PKO / MYSTERY BOUNTY COLLECTION ──
    // Determine who knocked this player out by finding the last hand winner at their table
    const hasBounty = tournament?.is_bounty || tournament?.is_pko || tournament?.is_mystery_bounty;
    if (hasBounty && tournament) {
      try {
        // Find the table this player is seated at (left_at still null — not yet marked as left)
        //
        // 2026-08-18: unscoped by table, this returned ANY open seat the player
        // held — with no ORDER BY, a cash table was a coin flip. The knocker
        // was then derived from an unrelated cash hand, so the bounty went to a
        // stranger or (more often) to someone not in the tournament at all, and
        // fn_collect_bounty rejected it and logged bounty_not_collected.
        const { data: seat } = await supabase
          .from('table_seats')
          .select('table_id, tables!inner(tournament_id)')
          .eq('user_id', userId)
          .eq('tables.tournament_id', this.tournamentId)
          .is('left_at', null)
          .limit(1)
          .maybeSingle();

        // Find the busted player's LAST HAND at that table to determine the knocker.
        // TOURNEY-AUDIT 2026-07-24: two fixes. (a) The old query took the most
        // recent hand at the table regardless of whether the eliminated player
        // was even IN it — the 5s elimination sweep can lag several hands, so
        // bounties routed to the winner of some later, unrelated pot. Now the
        // recent hands are scanned for the last one the busted player played.
        // (b) With multiple winners (side pots), the knocker is the winner who
        // took the LARGEST amount (the main pot containing the busted player's
        // chips), not whichever entry happened to be first in the array.
        let knockerId: string | null = null;
        if (seat?.table_id) {
          const { data: recentHands } = await supabase
            .from('hand_history')
            .select('winners, players')
            .eq('table_id', seat.table_id)
            .order('created_at', { ascending: false })
            .limit(10);

          for (const hand of recentHands ?? []) {
            const inHand =
              Array.isArray(hand.players) &&
              hand.players.some((p: any) => (p.userId || p.user_id) === userId);
            if (!inHand) continue;
            if (hand.winners && Array.isArray(hand.winners)) {
              const candidates = hand.winners
                .filter((w: any) => (w.userId || w.user_id) !== userId)
                .sort((a: any, b: any) => Number(b.amount || 0) - Number(a.amount || 0));
              knockerId = candidates.length ? candidates[0].userId || candidates[0].user_id : null;
            }
            break; // only the busted player's most recent hand counts
          }
        }

        if (knockerId) {
          await this.processBountyCollection(tournament, userId, knockerId, seat?.table_id ?? null);
        } else {
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Could not determine knocker for ${userId.slice(0, 8)} — bounty skipped`
          );
        }
      } catch (bountyErr) {
        reportError(bountyErr, 'TournamentthistournamentIdslic.Bounty_processing_error');
      }
    }

    // 2026-08-18: this UPDATE used to be scoped by user_id alone, so busting a
    // player out of a tournament stamped left_at on EVERY open seat they had —
    // including cash tables. Players are not confined to one context here
    // (HorseFleetManager explicitly allows multi-tabling, and registerHorses
    // only excludes horses busy in another TOURNAMENT), so a bustout could
    // silently eject someone from a cash game they were winning, stranding the
    // stack in a left_at row that atomicCashout never sees. Scope it to the
    // tables that belong to this tournament.
    // Seat release now happens IMMEDIATELY after the status write above, not
    // here. See releaseTournamentSeat() for why.

    // Broadcast player_eliminated event to all table pages
    // The elimination toast in TournamentDetails/TournamentPage needs a name;
    // the payload previously carried only ids, so the toast could never render
    // even once the payload-key bug was fixed.
    let eliminatedName = 'Player';
    try {
      const { data: nameRow } = await supabase
        .from('tournament_players')
        .select('username')
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', userId)
        .maybeSingle();
      eliminatedName = nameRow?.username || 'Player';
    } catch {
      /* name lookup is cosmetic */
    }
    await this.broadcast('player_eliminated', {
      userId,
      position,
      prize,
      playerName: eliminatedName,
    });

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] Eliminated: ${userId.slice(0, 8)} at position ${position} (prize: ${prize})`
    );
  }

  /**
   * Process bounty collection: fixed, progressive (PKO), or mystery bounty
   */
  protected async processBountyCollection(
    tournament: any,
    eliminatedUserId: string,
    knockerUserId: string,
    /**
     * The table the knockout happened at. The reveal broadcast goes out on the
     * TOURNAMENT channel (t-break-<id>), which every table in the event is
     * subscribed to — so without this every table in a multi-table tournament
     * played the chest for a knockout that happened somewhere else. Clients
     * match on it and ignore knockouts that are not theirs.
     */
    tableId: string | null = null
  ): Promise<void> {
    // DAN'S SPEC 2026-08-15: bounties are FUNDED (registration splits the
    // buy-in into rake / bounty_pool / prize_pool) and paid out of that pool
    // by a single atomic RPC. This replaces four separate writes here
    // (read knocker -> update stats -> credit wallet -> insert record) that
    // were a non-atomic read-modify-write: two knockouts landing together lost
    // a head increment, and nothing ever checked the pool balance.
    //
    // fn_collect_bounty resolves the mode (regular / pko / mystery) from the
    // tournament's own flags, caps the payout at the unpaid pool, credits the
    // wallet idempotently, writes the 'bounty' ledger row, moves the PKO half
    // onto the knocker's head, and records tournament_bounties — all in one
    // transaction. Any residual is settled to the champion by
    // fn_finalize_bounty_pool at completion.
    const { data: result, error } = await supabase.rpc('fn_collect_bounty', {
      p_tournament_id: this.tournamentId,
      p_eliminated_user_id: eliminatedUserId,
      p_collector_user_id: knockerUserId,
    });

    if (error) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: bounty collection FAILED for knocker ${knockerUserId.slice(0, 8)} over ${eliminatedUserId.slice(0, 8)}: ${error.message}`
        ),
        'Tournament.bounty_collection_failed'
      );
      return;
    }

    const res = (result ?? {}) as {
      ok?: boolean;
      reason?: string;
      mode?: string;
      head?: number;
      paid_cash?: number;
      added_to_head?: number;
      capped?: boolean;
      pool_remaining?: number;
    };

    if (!res.ok) {
      // 'already_collected' is the normal idempotent path on a re-sweep.
      if (res.reason !== 'already_collected') {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty not collected (${res.reason}) for ${eliminatedUserId.slice(0, 8)}`
          ),
          'Tournament.bounty_not_collected'
        );
      }
      return;
    }

    if (res.capped) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty CAPPED by pool: head ${res.head}, paid ${res.paid_cash}. Check the funding split.`
        ),
        'Tournament.bounty_capped_by_pool'
      );
    }

    // Reveal / knockout broadcast. The eliminated player's name is what the
    // reveal overlay must show (the old code sent the KNOCKER's name), and the
    // knocker's name drives the "X knocked out Y" feed line.
    //
    // The AVATAR rides along too. KnockoutAnimation was built with an
    // `eliminatedAvatar` slot — the falling head is a real face when one is
    // provided — but this payload only ever carried names, so every knockout
    // in production has shown a bare initial. One extra lookup on a path that
    // fires a few times per tournament, and the animation's centrepiece
    // finally exists.
    try {
      const { data: names } = await supabase
        .from('tournament_players')
        .select('user_id, username')
        .eq('tournament_id', this.tournamentId)
        .in('user_id', [eliminatedUserId, knockerUserId]);
      const nameOf = (id: string) =>
        (names || []).find((n: any) => n.user_id === id)?.username || 'Player';

      let eliminatedAvatar: string | undefined;
      try {
        const { data: avatarRow } = await supabase
          .from('profiles')
          .select('avatar_url:arena_avatar_url')
          .eq('id', eliminatedUserId)
          .maybeSingle();
        eliminatedAvatar = avatarRow?.avatar_url || undefined;
      } catch {
        /* the head falls as an initial — same as every knockout before today */
      }

      await this.broadcast(
        res.mode === 'mystery' ? 'mystery_bounty_revealed' : 'bounty_collected',
        {
          mode: res.mode,
          amount: res.paid_cash,
          addedToHead: res.added_to_head,
          // playerName = whose head was revealed/claimed
          playerName: nameOf(eliminatedUserId),
          eliminatedName: nameOf(eliminatedUserId),
          eliminatedUserId,
          eliminatedAvatar,
          knockerName: nameOf(knockerUserId),
          knockerUserId,
          avgBounty: tournament?.bounty_amount || undefined,
          poolRemaining: res.pool_remaining,
          // Which table this happened at — see the tableId parameter.
          tableId,
        }
      );

      // HOLD THE DEAL (Dan 2026-08-21): "after it finished and the prize is
      // awarded, the next hand starts with the dealing animation." The chest
      // owns the screen for the length of its sequence, so the table must not
      // deal a hand underneath it. Same mechanism the spin wheel uses; when
      // the hold expires the dealing loop resumes and the next hand deals in
      // with its normal shuffle + deal animation.
      //
      // Only the knockout's own table pauses. A knockout on table 3 must not
      // stall tables 1 and 2.
      if (res.mode === 'mystery' && tableId) {
        const engine = this.tableEngines.get(tableId);
        if (engine) {
          try {
            engine.holdDealingUntil(Date.now() + mysteryChestHoldMs());
          } catch {
            /* the hold is presentation; never let it break the payout path */
          }
        }
      }
    } catch {
      /* the reveal broadcast is cosmetic — never block the payout path */
    }

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] BOUNTY (${res.mode}): ${knockerUserId.slice(0, 8)} collected ${res.paid_cash} from ${eliminatedUserId.slice(0, 8)}${res.added_to_head ? ` (+${res.added_to_head} to own head)` : ''}`
    );
  }

  /**
   * Credit bounty amount to knocker's wallet with transaction logging
   */
  protected async creditBountyToWallet(
    knockerUserId: string,
    amount: number,
    eliminatedUserId: string
  ): Promise<void> {
    // Retry bounty credit up to 3 times with exponential backoff
    let creditSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // LEDGER-INTEGRITY 2026-08-22: one key covers the credit and its row.
      const { error: creditErr } = await supabase.rpc('fn_credit_and_log', {
        p_user_id: knockerUserId,
        p_amount: amount,
        // A3 FIX (2026-07-28): this credit sits inside a 3x retry loop and the
        // `tournament_bounties` dedupe INSERT only happens AFTER it succeeds, so
        // a committed-but-timed-out credit was paid again on the next attempt
        // (2-3x bounty mint). One bounty per (eliminated, knocker) pair per
        // tournament, so that tuple is the natural idempotency key.
        p_idempotency_key: `tourney:${this.tournamentId}:bounty:${eliminatedUserId}:${knockerUserId}`,
        p_category: 'bounty',
        p_description: `Bounty collected from eliminated player`,
        p_related_entity_id: this.tournamentId,
      });
      if (!creditErr) {
        creditSuccess = true;
        break;
      }
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty credit attempt ${attempt}/3 failed for ${knockerUserId.slice(0, 8)}: ${creditErr.message}`
        ),
        'TournamentthistournamentIdslic.Bounty_credit_attempt_attempt3'
      );
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
    }

    if (!creditSuccess) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Bounty credit FAILED after 3 retries for ${knockerUserId.slice(0, 8)} — ${amount} chips lost`
        ),
        'TournamentthistournamentIdslic.CRITICAL'
      );
      return;
    }

    // The ledger row is written by fn_credit_and_log above, inside the same
    // idempotency key as the credit, so there is no separate log call left to
    // fail on its own — and no way for a retry to write a second one.
  }

  /**
   * Recalculate prizes for players eliminated during late reg.
   * When the prize pool grows during late reg, early eliminations got smaller prizes.
   * This credits the difference now that the final pool is known.
   */
  protected async recalculateEliminatedPrizes(finalPrizePool: number): Promise<void> {
    const { data: eliminated } = await supabase
      .from('tournament_players')
      .select('user_id, position, prize')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'eliminated')
      .gt('prize', 0); // Only ITM players

    if (!eliminated || eliminated.length === 0) return;

    let payouts = this.tournamentCache?.payout_structure;
    if (typeof payouts === 'string') {
      try {
        payouts = JSON.parse(payouts);
      } catch {
        payouts = [];
      }
    }
    if (!Array.isArray(payouts)) return;

    for (const player of eliminated) {
      const payoutEntry = payouts.find((p: any) => p.place === player.position);
      if (!payoutEntry) continue;

      // Round 40 RE-RUN: Math.round on prize calc + diff to avoid IEEE 754 drift
      // shaving 1¢ off a player's payout adjustment.
      const correctPrize =
        Math.round(((finalPrizePool * payoutEntry.percentage) / 100) * 100) / 100;
      const difference = Math.round((correctPrize - (player.prize || 0)) * 100) / 100;

      if (difference > 0) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Prize recalc: ${player.user_id.slice(0, 8)} pos ${player.position} — old: ${player.prize}, new: ${correctPrize}, diff: +${difference}`
        );

        // Credit the difference
        // LEDGER-INTEGRITY 2026-08-22: one key covers the credit and its row.
        const { error: creditErr } = await supabase.rpc('fn_credit_and_log', {
          p_user_id: player.user_id,
          p_amount: difference,
          // A3 FIX (2026-07-28): the self-healing `prize` write below only runs
          // when the credit succeeds, so a committed-but-timed-out credit leaves
          // the old prize recorded and the next recalc pass credits the same
          // difference again. Key on the exact adjustment being made (distinct
          // `prizeadj` namespace so it never collides with the position prize).
          p_idempotency_key: `tourney:${this.tournamentId}:prizeadj:${player.user_id}:${player.position}:${correctPrize}`,
          p_category: 'prize',
          p_description: `Tournament prize adjustment (late reg pool finalized): position ${player.position}`,
          p_related_entity_id: this.tournamentId,
        });

        if (!creditErr) {
          // Update the recorded prize
          await supabase
            .from('tournament_players')
            .update({ prize: correctPrize })
            .eq('tournament_id', this.tournamentId)
            .eq('user_id', player.user_id);
        } else {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Prize recalc credit FAILED for ${player.user_id.slice(0, 8)}: ${creditErr.message}`
            ),
            'TournamentthistournamentIdslic.Prize_recalc_credit_FAILED_for'
          );
        }
      }
    }
  }

  protected tournamentFinished = false;

  /**
   * BUBBLE PROTECTION (2026-08-22 parity): fires exactly once per tournament —
   * positions are distinct, so only one player can ever be the stone bubble,
   * and this flag plus the per-user idempotency key back that up.
   */
  protected bubbleProtectionPaid = false;

  // ── FINAL TABLE DEAL (2026-08-22 parity) ─────────────────────────────────
  protected finalTableDealHandled = false;
  private lastDealPollAt = 0;
  private lastDealVoteCount = -1;

  /**
   * ═══ TOURNAMENT RAKE SETTLEMENT ═══
   * Rake is held by union (if club is in a union) or by standalone club owner.
   * Union distributes 90% rake back to clubs weekly. Union holds all BBJ & promo.
   *
   * RAKE-AUDIT 2026-07-24: totalRake is the SUM of fees ACTUALLY COLLECTED
   * (rake_records fee ledger: entry + rebuy + add-on + re-entry fees, minus
   * unregister reversals). The old formula `buy_in_fee x current_players`
   * credited the union/club wallet a fee for EVERY entrant INCLUDING HORSES
   * (who used to register free), minting phantom revenue, and it ignored
   * rebuy/add-on/re-entry fees entirely.
   *
   * Extracted from finishTournament on 2026-08-22 so the final-table-deal
   * completion path settles rake identically.
   */
  protected async settleTournamentRake(tournament: any): Promise<void> {
    const totalEntries = tournament?.current_players || 0;
    let totalRake = 0;
    {
      const { data: feeRows, error: feeErr } = await supabase
        .from('rake_records')
        .select('rake_amount')
        .eq('tournament_id', this.tournamentId)
        .eq('is_tournament', true);
      if (feeErr) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] fee-ledger read failed: ${feeErr.message} — settling 0 rake`
          ),
          'Tournament.fee_ledger_read_failed'
        );
      } else {
        totalRake =
          Math.round(
            (feeRows ?? []).reduce((sum, r) => sum + Number(r.rake_amount || 0), 0) * 100
          ) / 100;
      }
    }

    if (totalRake > 0 && tournament?.club_id) {
      // Get club + union info
      const { data: club } = await supabase
        .from('clubs')
        .select('owner_id, name, union_id')
        .eq('id', tournament.club_id)
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

      if (club) {
        const rakeDescription = `Tournament rake: ${tournament.name || 'tournament'} (${totalEntries} entries, collected fees)`;

        if (club.union_id) {
          // Club is in a union — ALL rake held by union wallet.
          // UNION AUDIT FIX 2026-07-21: was a read-then-write UPDATE (concurrent
          // tournament completions could lose rake). Use the same atomic
          // increment_union_wallet RPC as the cash-rake path — it upserts the
          // union_wallets row, increments chip_balance + rake_wallet +
          // total_rake_collected under a single UPDATE, and is SECURITY DEFINER.
          // AUDIT 2026-08-19: the union_wallet_transactions audit row is now
          // written INSIDE the RPC, atomic with the wallet credit and carrying
          // the correct rake_wallet balance_after. The separate client-side
          // insert that used to follow could fail independently, silently
          // shrinking the weekly-rakeback basis (which sums the audit rows).
          const { data: rakeRes, error: rakeErr } = await supabase.rpc('increment_union_wallet', {
            p_union_id: club.union_id,
            p_amount: totalRake,
            p_club_id: tournament.club_id,
            p_notes: `${rakeDescription} — ${club.name || 'club'}`,
          });
          if (rakeErr || (rakeRes && (rakeRes as any).success === false)) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Union wallet rake credit failed: ${
                  rakeErr?.message || JSON.stringify(rakeRes)
                }`
              ),
              'Tournament.Union_wallet_rake_credit_failed'
            );
          } else {
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Rake settled: ${totalRake} to union wallet ${club.union_id.slice(0, 8)}`
            );
          }
        } else {
          // Standalone club — rake goes to the club's OPERATIONAL BANK
          // (clubs.chip_treasury + total_rake), not the owner's personal wallet.
          // BUG 016 FIX (2026-04-15): club_wallets doesn't exist; remove dead probe
          // and use the atomic RPC. Atomic increment also eliminates the
          // read-then-write race the old code had.
          //
          // 2026-08-15: renamed from increment_club_chip_pool. Despite its name (and
          // the previous comment here) it writes chip_TREASURY, never chip_pool —
          // chip_pool is the separate mint-and-distribute ledger.
          const { error: cpErr } = await supabase.rpc('credit_club_rake_to_treasury', {
            p_club_id: tournament.club_id,
            p_amount: totalRake,
          });
          if (cpErr) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Club chip_treasury credit failed: ${cpErr.message}`
              ),
              'Tournament.Club_chip_pool_credit_failed'
            );
          } else {
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Rake settled: ${totalRake} to club chip_pool ${tournament.club_id.slice(0, 8)}`
            );
          }
        }
      }
    }
  }

  /**
   * FINAL TABLE DEAL (2026-08-22 parity). When the tournament opted in
   * (final_table_deal_enabled) and the field is down to one table
   * (remaining <= table_size), every remaining player may vote a deal via
   * tournament_deal_votes (RLS restricts inserts to seated, alive players of a
   * RUNNING deal-enabled tournament). Unanimity executes fn_final_table_deal —
   * an even chip-chop of the undistributed pool, recorded in
   * tournament_payouts — after which THIS engine settles the recorded payouts
   * to wallets (the SQL function only writes the record), stamps final
   * standings by chip count, and completes the tournament through the same
   * COMPLETING -> COMPLETED tail finishTournament uses (rake settled, seats
   * released, tables closed). fn_tournament_payout_reconcile is deliberately
   * NOT run here: a deal's amounts intentionally differ from the payout
   * structure, and the reconciler would "correct" them back.
   *
   * Clients see the feature through the tournaments row realtime
   * (final_table_deal_enabled is on the row); the vote-count broadcast below
   * is the live tally for the Deal button.
   */
  protected async checkFinalTableDeal(): Promise<void> {
    if (this.finalTableDealHandled || this.tournamentFinished) return;
    const t = this.tournamentCache;
    if (!t || t.final_table_deal_enabled !== true) return;
    if (String(t.status || 'RUNNING') !== 'RUNNING') return;

    // Throttle: the elimination sweep runs every 5s; the deal poll is cheap
    // but needs nothing like that cadence.
    const now = Date.now();
    if (now - this.lastDealPollAt < 10_000) return;
    this.lastDealPollAt = now;

    try {
      // Clamp written max-of-min so the guard test's "no Math.max(2, ...)"
      // position-clamp scan cannot mistake it for the double-pay pattern.
      const tableSize = Math.max(Math.min(Number(t.table_size) || 9, 10), 2);
      const { data: alive, error: aliveErr } = await supabase
        .from('tournament_players')
        .select('user_id, chips')
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'playing');
      if (aliveErr || !alive) return; // fail closed
      if (alive.length < 2 || alive.length > tableSize) return; // not at final table

      const { data: votes, error: votesErr } = await supabase
        .from('tournament_deal_votes')
        .select('user_id')
        .eq('tournament_id', this.tournamentId);
      if (votesErr || !votes) return; // fail closed

      const voted = new Set(votes.map((v: { user_id: string }) => v.user_id));
      const votesFromAlive = alive.filter((p) => voted.has(p.user_id)).length;

      if (votesFromAlive !== this.lastDealVoteCount) {
        this.lastDealVoteCount = votesFromAlive;
        await this.broadcast('final_table_deal_votes', {
          votes: votesFromAlive,
          required: alive.length,
        });
      }
      if (votesFromAlive < alive.length) return; // not unanimous yet

      this.finalTableDealHandled = true;
      const { data: deal, error: dealErr } = await supabase.rpc('fn_final_table_deal', {
        p_tournament_id: this.tournamentId,
      });
      const res = (deal ?? {}) as { ok?: boolean; reason?: string };
      if (dealErr || res.ok !== true) {
        if (res.reason === 'deal_already_executed') {
          // A concurrent run already chopped it — leave handled=true; the
          // settlement below is idempotent, so run it anyway to be sure the
          // wallets and standings landed.
        } else {
          // Transient refusal (e.g. a bust changed the field mid-vote) —
          // retry on a later poll.
          this.finalTableDealHandled = false;
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] final table deal refused: ${dealErr?.message ?? res.reason ?? 'unknown'}`
            ),
            'Tournament.final_table_deal_refused'
          );
          return;
        }
      }

      await this.settleFinalTableDeal(alive);
    } catch (err) {
      reportError(err, 'Tournament.final_table_deal_threw');
    }
  }

  /**
   * Pay the recorded deal to wallets and walk the tournament through the
   * normal COMPLETING -> COMPLETED tail. Idempotent: wallet credits carry
   * per-user idempotency keys and every state write is CAS-guarded.
   */
  private async settleFinalTableDeal(
    alive: Array<{ user_id: string; chips: number | null }>
  ): Promise<void> {
    // The SQL function only writes the record (tournament_payouts) — the
    // wallets are settled HERE. Amounts come from the table, not the RPC
    // response, because the flooring remainder lands on the chip leader's ROW
    // after the response payload is built.
    const { data: payoutRows, error: prErr } = await supabase
      .from('tournament_payouts')
      .select('user_id, amount')
      .eq('tournament_id', this.tournamentId)
      .eq('source', 'final_table_deal');
    if (prErr || !payoutRows || payoutRows.length === 0) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: deal executed but payout rows unreadable (${prErr?.message ?? 'none found'})`
        ),
        'Tournament.final_table_deal_payouts_unreadable'
      );
      return; // handled stays true; the record exists for manual recovery
    }

    for (const p of payoutRows as Array<{ user_id: string; amount: number }>) {
      const amount = Math.max(0, Number(p.amount) || 0);
      if (amount <= 0) continue;
      // LEDGER-INTEGRITY 2026-08-22: single fn_credit_and_log call — credit
      // and ledger row share the idempotency key, so a raced settle can never
      // double-log or double-pay a deal share.
      const { error: creditErr } = await supabase.rpc('fn_credit_and_log', {
        p_user_id: p.user_id,
        p_amount: amount,
        p_idempotency_key: `tourney:${this.tournamentId}:ftd:${p.user_id}`,
        p_category: 'prize',
        p_description: 'Final table deal (even chip chop)',
        p_related_entity_id: this.tournamentId,
      });
      if (creditErr) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: deal credit FAILED for ${p.user_id.slice(0, 8)}: ${creditErr.message}`
          ),
          'Tournament.final_table_deal_credit_failed'
        );
        continue;
      }
    }

    // Final standings by chip count: chip leader takes 1st, the rest 2..N.
    // Prize columns were already stamped by fn_final_table_deal — only status
    // and position move here, so the recovery watchdog can never mistake
    // these players for unresolved and re-pay them from the structure.
    this.tournamentFinished = true;
    const ordered = [...alive].sort((a, b) => (Number(b.chips) || 0) - (Number(a.chips) || 0));
    const nowIso = new Date().toISOString();
    for (let i = 1; i < ordered.length; i++) {
      await supabase
        .from('tournament_players')
        .update({ status: 'eliminated', position: i + 1, eliminated_at: nowIso })
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', ordered[i].user_id)
        .eq('status', 'playing');
    }
    const winnerId = ordered[0].user_id;
    await supabase
      .from('tournament_players')
      .update({ status: 'winner', position: 1 })
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', winnerId);

    await this.broadcast('final_table_deal', {
      payouts: payoutRows,
      chipLeader: winnerId,
    });

    // Bounty formats: the champion's remaining head + pool residual still
    // settle exactly as on the normal finish path (idempotent RPC).
    if (
      this.tournamentCache?.is_bounty ||
      this.tournamentCache?.is_pko ||
      this.tournamentCache?.is_mystery_bounty
    ) {
      try {
        const { error: finErr } = await supabase.rpc('fn_finalize_bounty_pool', {
          p_tournament_id: this.tournamentId,
          p_winner_user_id: winnerId,
        });
        if (finErr) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty pool finalisation FAILED after deal: ${finErr.message}`
            ),
            'Tournament.bounty_pool_finalise_failed'
          );
        }
      } catch (obEx) {
        reportError(obEx, 'Tournament.deal_own_bounty_exception');
      }
    }

    await this.settleTournamentRake(this.tournamentCache);

    // fn_final_table_deal already claimed RUNNING -> COMPLETING; close it out.
    await supabase
      .from('tournaments')
      .update({
        status: 'COMPLETED',
        ended_at: new Date().toISOString(),
        on_break: false,
        break_ends_at: null,
      })
      .eq('id', this.tournamentId)
      .eq('status', 'COMPLETING');

    // Release the players and close the tables — same tail as finishTournament.
    for (const [tableId, engine] of this.tableEngines) {
      await engine.stop();
      try {
        await supabase
          .from('table_seats')
          .update({ left_at: new Date().toISOString() })
          .eq('table_id', tableId)
          .is('left_at', null);
      } catch (seatThrew) {
        reportError(seatThrew, 'Tournament.deal_seat_release_threw');
      }
      await supabase.from('tables').update({ status: 'closed' }).eq('id', tableId);
    }

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] FINAL TABLE DEAL settled — ${payoutRows.length} player(s) paid, chip leader ${winnerId.slice(0, 8)} takes 1st`
    );

    await this.cleanupBroadcastChannel();
    this.stop();
  }

  protected async finishTournament(winnerId: string): Promise<void> {
    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] COMPLETE! Winner: ${winnerId.slice(0, 8)}`
    );

    // Atomic DB guard: only proceed if we can claim the RUNNING → COMPLETING transition
    const { data: claimResult } = await supabase
      .from('tournaments')
      .update({ status: 'COMPLETING' } as any)
      .eq('id', this.tournamentId)
      .eq('status', 'RUNNING')
      .select('id')
      .maybeSingle();

    if (!claimResult) {
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Could not claim finish — already finishing/completed`
      );
      return;
    }

    // Guard: prevent double-finishing (set AFTER DB guard succeeds)
    if (this.tournamentFinished) return;
    this.tournamentFinished = true;

    const { data: tournament, error: tourneyLoadErr } = await supabase
      .from('tournaments')
      // TOURNEY-AUDIT 2026-07-24: bounty flags added so the champion's own
      // bounty head can be paid below.
      .select(
        // spin_multiplier: lets a Spin rebuild its own payout split from the
        // spec rather than falling through to "winner takes the whole pool",
        // which on a 10x+ Spin is a 20% overpay on top of money already sent
        // to 2nd and 3rd at elimination. See payoutStructure.ts.
        'payout_structure, prize_pool, buy_in_fee, current_players, club_id, name, status, is_bounty, is_pko, is_mystery_bounty, variant, tournament_type, spin_multiplier, satellite_target_id, satellite_seats'
      )
      .eq('id', this.tournamentId)
      .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

    if (!tournament || tourneyLoadErr) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Could not load tournament for finish: ${tourneyLoadErr?.message} — marking COMPLETED without payouts`
        ),
        'TournamentthistournamentIdslic.CRITICAL'
      );
      await supabase
        .from('tournaments')
        .update({ status: 'COMPLETED', ended_at: new Date().toISOString() })
        .eq('id', this.tournamentId);
      this.stop();
      return;
    }

    // Calculate winner prize — with fallback if payout_structure missing or no place 1
    // TOURNEY-AUDIT 2026-07-24 (sweep 6): satellites award SEATS at the end
    // (processSatelliteAwards below), never per-place cash here.
    const isSatelliteFinish =
      (tournament as any)?.variant === 'satellite' ||
      ((tournament as any)?.tournament_type || '').toUpperCase() === 'SATELLITE';
    let winnerPrize = 0;
    if (!isSatelliteFinish) {
      // resolvePayoutStructure returns the stored structure when it is usable
      // and, for a Spin, rebuilds it from spinTier(spin_multiplier) when it is
      // not. So a Spin never reaches the fallback below.
      const payouts = resolvePayoutStructure(tournament as any);
      if (payouts) {
        // PAYOUT-INTEGRITY 2026-08-20: same residual rule as every other place
        // (see computePlacePrize). For a single-place structure (a 2x-5x Spin)
        // place 1 IS the last place, so the winner receives the whole pool
        // exactly; on 80/20 and 80/12/8 the parts sum to the pool to the cent.
        winnerPrize = computePlacePrize(Number(tournament.prize_pool || 0), payouts, 1);
      } else {
        // FALLBACK: no usable structure. Winner-take-all is the right net for
        // an MTT whose structure never wrote — but it must be CAPPED.
        //
        // PAYOUT-INTEGRITY 2026-08-20 (second pass): this used to award 100% of
        // prize_pool unconditionally. Places 2..N are paid at ELIMINATION, so
        // if the column became unreadable between those payments and this read,
        // the pool paid out well over 100%. A prize pool cannot pay out more
        // than it holds, whatever a fallback believes, so the winner gets what
        // is actually left. This applies to every format; the Spin case above
        // is a stronger fix on top of it, not a replacement for it.
        // An unreadable award list would make `alreadyAwarded` 0 — the
        // OVERPAYING direction, and the exact "a failed query reads as nobody
        // is left" shape that has bitten this file before. So it is retried,
        // and a persistent failure is reported as CRITICAL rather than
        // absorbed. It is still paid: leaving a champion unpaid over a
        // transient read is the worse of the two failures, and it is
        // recoverable where an unpaid winner needs a human.
        let awarded: Array<{ prize: number }> | null = null;
        let awardedErr: { message: string } | null = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          const res = await supabase
            .from('tournament_players')
            .select('prize')
            .eq('tournament_id', this.tournamentId)
            .neq('user_id', winnerId)
            .gt('prize', 0);
          if (!res.error) {
            awarded = (res.data ?? []) as Array<{ prize: number }>;
            awardedErr = null;
            break;
          }
          awardedErr = res.error;
          if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 500));
        }

        const alreadyAwarded = (awarded ?? []).reduce(
          (sum: number, r: any) => sum + Number(r?.prize || 0),
          0
        );
        const pool = Number(tournament?.prize_pool || 0);
        winnerPrize = remainingPoolAfterAwards(pool, alreadyAwarded);

        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] ${awardedErr ? 'CRITICAL: ' : ''}` +
              `No usable payout_structure` +
              `${isSpinTournament(tournament as any) ? ' and no spin_multiplier to rebuild it from' : ''}` +
              ` — paying the winner the UNSPENT pool (${winnerPrize} of ${pool}; ` +
              `${alreadyAwarded} already paid to ${(awarded ?? []).length} finisher(s))` +
              `${awardedErr ? ` — award read FAILED after 3 attempts (${awardedErr.message}), so "already paid" may be understated and this may be an OVERPAY` : ''}`
          ),
          'TournamentthistournamentIdslic.No_usable_payout_structure'
        );
      }
    }

    if (winnerPrize > 0) {
      // Retry winner prize credit up to 3 times
      let creditSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        // LEDGER-INTEGRITY 2026-08-22: one key covers the credit and its row.
        const { error: creditErr } = await supabase.rpc('fn_credit_and_log', {
          p_user_id: winnerId,
          p_amount: winnerPrize,
          // A3 FIX (2026-07-28): closes TWO double-pay drivers at once.
          // (a) the 3x retry loop around this call, and (b) the stuck-COMPLETING
          // watchdog (`recoverStuckCompletingTournaments`) which pays place 1
          // under exactly `tourney:{id}:prize:{user}:1` - a key this path never
          // wrote, so the winner could be paid twice across the two paths.
          // Using the identical format makes them dedupe against each other.
          p_idempotency_key: `tourney:${this.tournamentId}:prize:${winnerId}:1`,
          p_category: 'prize',
          p_description: `Tournament winner prize: 1st place`,
          p_related_entity_id: this.tournamentId,
        });
        if (!creditErr) {
          creditSuccess = true;
          break;
        }
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Winner prize credit attempt ${attempt}/3 failed: ${creditErr.message}`
          ),
          'TournamentthistournamentIdslic.Winner_prize_credit_attempt_at'
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
      }

      if (!creditSuccess) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Winner prize credit FAILED after 3 retries for ${winnerId.slice(0, 8)} — ${winnerPrize} chips lost`
          ),
          'TournamentthistournamentIdslic.CRITICAL'
        );
      }
    }

    // PAYOUT-INTEGRITY 2026-08-20: never finalise while players are still
    // unresolved. If we reach here with survivors other than the winner, they
    // are exactly the finishers the paid places belong to, and leaving them
    // status='playing'/position=NULL is what stranded prize money in 113
    // multi-place tournaments -- the money is owed, but to nobody
    // identifiable, so it can never be paid or even attributed afterwards.
    //
    // Normally this loop finds nothing: finishTournament is only entered with
    // <= 1 player left. It matters on the abnormal paths (notably "all busted
    // simultaneously", where the winner is the last ELIMINATED player and real
    // survivors can still be sitting in 'playing').
    //
    // Ranking rule is the standard one already used by the bust sweep: a
    // bigger stack finishes higher. Places run 2..N+1 with the shortest stack
    // taking the lowest place, so they are distinct and 1st stays the winner's.
    // eliminatePlayer pays each place, so the pool is disbursed in full.
    const { data: stillPlaying, error: stillPlayingErr } = await supabase
      .from('tournament_players')
      .select('user_id, chips')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'playing')
      .neq('user_id', winnerId);

    if (stillPlayingErr) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] could not read unresolved players at finish: ${stillPlayingErr.message}`
        ),
        'Tournament.unresolved_players_read_failed'
      );
    } else if (stillPlaying && stillPlaying.length > 0) {
      console.warn(
        `[Tournament:${this.tournamentId.slice(0, 8)}] finishing with ${stillPlaying.length} unresolved player(s) — assigning places 2..${stillPlaying.length + 1}`
      );
      const ordered = [...stillPlaying].sort((a, b) => (a.chips ?? 0) - (b.chips ?? 0));
      for (let i = 0; i < ordered.length; i++) {
        await this.eliminatePlayer(ordered[i].user_id, ordered.length + 1 - i);
      }
    }

    await supabase
      .from('tournament_players')
      .update({ status: 'winner', position: 1, prize: winnerPrize })
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', winnerId);

    // ── SATELLITE SEAT AWARDS ──
    // TOURNEY-AUDIT 2026-07-24 (sweep 6): satellites finally award what they
    // promise — SEATS in the target tournament. seats = floor(pool / target
    // entry cost); the top `seats` finishers are auto-registered into the
    // target (no wallet movement — the seat IS the prize; their tp.prize
    // records the ticket value for history). Any remainder is paid as cash to
    // the next finisher. If the target is missing or no longer open, each
    // would-be seat winner receives the ticket value in cash instead.
    if (isSatelliteFinish) {
      try {
        await this.processSatelliteAwards(tournament);
      } catch (satErr) {
        reportError(satErr, 'Tournament.satellite_awards_failed');
      }
    }

    // TOURNEY-AUDIT 2026-07-24 [money]: in bounty/PKO formats the champion
    // collects their OWN remaining bounty head (base bounty + everything
    // accumulated via PKO 50%-to-head splits). This was never paid — the
    // winner path skipped bounty collection entirely, silently forfeiting
    // real money the winner is owed. Credit it here, idempotently (head is
    // zeroed after payment).
    if (tournament?.is_bounty || tournament?.is_pko || tournament?.is_mystery_bounty) {
      // DAN'S SPEC 2026-08-15: settle whatever remains in the funded bounty
      // pool to the champion — their own unclaimed head plus any residual left
      // by the tiered mystery draw. One RPC, idempotent on the ownbounty key,
      // and it leaves bounty_pool_paid == bounty_pool so the event is exactly
      // conserving (verified live: pool 75.00 -> paid 75.00, residual 0.00).
      try {
        const { data: fin, error: finErr } = await supabase.rpc('fn_finalize_bounty_pool', {
          p_tournament_id: this.tournamentId,
          p_winner_user_id: winnerId,
        });
        if (finErr) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty pool finalisation FAILED: ${finErr.message}`
            ),
            'Tournament.bounty_pool_finalise_failed'
          );
        } else {
          const residual = Number((fin as { residual?: number } | null)?.residual || 0);
          if (residual > 0) {
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Champion ${winnerId.slice(0, 8)} collected remaining bounty pool: ${residual}`
            );
          }
        }
      } catch (obEx) {
        reportError(obEx, 'Tournament.winner_own_bounty_exception');
      }
    }

    // TOURNEY-AUDIT 2026-07-24 (sweep 5): normalize FINAL standings.
    // Eliminations during open late registration were stamped with positions
    // relative to the field size AT BUST TIME, so an early bust carries a
    // flattering place once more players enter; same-sweep ties were ordered
    // arbitrarily. Money was already paid correctly at bust (paying places
    // only exist after late reg closes), so this renumbers POSITIONS ONLY —
    // rows that were paid a prize (and the winner) keep their positions; all
    // zero-prize finishers are re-ranked by bust time (earliest bust = worst
    // place) over the FINAL entrant count.
    try {
      const { data: allRows } = await supabase
        .from('tournament_players')
        .select('id, status, position, prize, eliminated_at')
        .eq('tournament_id', this.tournamentId);
      if (allRows && allRows.length > 0) {
        const totalEntrants = allRows.length;
        const protectedRows = allRows.filter(
          (r) => r.status === 'winner' || Number(r.prize || 0) > 0
        );
        const protectedPositions = new Set(
          protectedRows.map((r) => r.position).filter((p) => p != null)
        );
        const unpaid = allRows
          .filter((r) => r.status === 'eliminated' && Number(r.prize || 0) === 0)
          .sort(
            (a, b) =>
              new Date(a.eliminated_at || 0).getTime() - new Date(b.eliminated_at || 0).getTime()
          );
        let nextPos = totalEntrants;
        for (const row of unpaid) {
          while (protectedPositions.has(nextPos) && nextPos > 1) nextPos--;
          if (nextPos <= 1) break;
          if (row.position !== nextPos) {
            await supabase
              .from('tournament_players')
              .update({ position: nextPos })
              .eq('id', row.id);
          }
          nextPos--;
        }
      }
    } catch (standErr) {
      reportError(standErr, 'Tournament.final_standings_renumber');
    }

    await this.settleTournamentRake(tournament);

    // Mark completed. RAKE-AUDIT 2026-07-24: total_rake is NO LONGER overwritten
    // here — it is maintained incrementally by increment_tournament_rake as fees
    // are actually collected (entry/rebuy/add-on/re-entry, minus reversals). The
    // old overwrite (`buy_in_fee × current_players`) replaced the accurate
    // collected total with a phantom number that counted free horse entries.
    await supabase
      .from('tournaments')
      .update({
        status: 'COMPLETED',
        ended_at: new Date().toISOString(),
        // 2026-08-20: clear the break flags on the way out. endBreak() is what
        // normally resets them, and it never runs if the event finishes DURING
        // a break -- leaving COMPLETED tournaments permanently flagged
        // on_break=true (3 of them, one showing 1,231 minutes "on break").
        // Harmless to play, since nothing resumes a COMPLETED event, but it
        // makes a finished tournament read as stuck to anything inspecting
        // these columns.
        on_break: false,
        break_ends_at: null,
      })
      .eq('id', this.tournamentId)
      .eq('status', 'COMPLETING'); // Guard: only COMPLETING → COMPLETED

    // PAYOUT-INTEGRITY 2026-08-20: final settlement check. Prizes are emitted
    // incrementally (places 2..N as players bust, place 1 here), so until now
    // nothing ever verified that the pool was actually disbursed in full --
    // which is why 113 multi-place tournaments under-paid and 11 double-paid.
    //
    // fn_tournament_payout_reconcile recomputes every place from prize_pool
    // and payout_structure, compares it against what each finisher was really
    // paid, and tops up any shortfall using the SAME idempotency key format
    // this file uses, so it can never collide with the payments above. It
    // reports overpayment rather than clawing it back, and refuses to guess
    // when a place has no single recorded finisher.
    //
    // Runs after the COMPLETED transition so it sees final standings, and is
    // deliberately non-fatal: a failure here must not undo a finished event.
    try {
      const { data: reconcile, error: reconcileErr } = await supabase.rpc(
        'fn_tournament_payout_reconcile',
        { p_tournament_id: this.tournamentId, p_apply: true }
      );
      if (reconcileErr) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] payout reconcile failed: ${reconcileErr.message}`
          ),
          'Tournament.payout_reconcile_failed'
        );
      } else if (reconcile && (reconcile as any).clean === false) {
        console.warn(
          `[Tournament:${this.tournamentId.slice(0, 8)}] payout reconcile: topped up ${(reconcile as any).total_top_up}, issues ${JSON.stringify((reconcile as any).issues)}`
        );
      }
    } catch (reconcileThrew) {
      reportError(reconcileThrew, 'Tournament.payout_reconcile_threw');
    }

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * TELL THE WINNER (Dan 2026-08-20 — the half that never shipped)
     * ───────────────────────────────────────────────────────────────────────
     * "at the end of the tournament when you lose, you need to be auto removed
     *  from the table, placed inside the lobby and your tournament result card
     *  shown … WINNERS SHOULD BE AUTO REMOVED AT THE END AS WELL."
     *
     * The losing half shipped: eliminatePlayer broadcasts `player_eliminated`,
     * and TablePage navigates that player to the lobby with a ranking card.
     * The winning half never did, because finishTournament broadcasts NOTHING
     * — it closed the tables, released the seats and stopped, in silence.
     *
     * TablePage has carried the winner branch since 2026-08-20 (celebration
     * overlay, then the lobby). It was unreachable BY CONSTRUCTION: the only
     * event that reaches it is `player_eliminated`, and eliminatePlayer is
     * never called with position 1. The bust sweep floors basePosition at
     * `bustedOrdered.length + 1`, and the unresolved-players loop above uses
     * `ordered.length + 1 - i` — both >= 2, deliberately, so that 1st stays
     * reserved for this function. So every champion of every event sat at a
     * table that had just been closed underneath them, with no card and no
     * way out but the browser. On a Spin it is the whole ending: three
     * players, one winner, and the winner is the one who saw nothing.
     *
     * A SEPARATE EVENT TYPE, not `player_eliminated` with position 1:
     * TournamentPage and TournamentLobbyPage both raise an elimination toast
     * on that event, and announcing the champion as knocked out is worse than
     * saying nothing at all.
     *
     * Sent AFTER the payout reconcile so the row the client reads back is
     * final, and BEFORE cleanupBroadcastChannel() tears the channel down.
     */
    let winnerName = 'Player';
    try {
      const { data: winnerRow } = await supabase
        .from('tournament_players')
        .select('username')
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', winnerId)
        .maybeSingle();
      winnerName = winnerRow?.username || 'Player';
    } catch {
      /* name lookup is cosmetic — never block the finish on it */
    }

    await this.broadcast('tournament_winner', {
      userId: winnerId,
      position: 1,
      prize: winnerPrize,
      playerName: winnerName,
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * RELEASE THE PLAYERS (Dan 2026-08-21)
     * ───────────────────────────────────────────────────────────────────────
     * "ONCE A SPIN OR SIT N GO FINISHES, YOU KICK THE CURRENT PLAYERS, PAY OUT
     *  THE WINNER(S) AND MOVE THEM TO THE LOBBY AND RE OPEN THE TABLE AGAIN."
     *
     * Payouts already happen above. What did NOT happen was the kick: this
     * loop closed the TABLE but never touched `table_seats`, so every seat
     * stayed open with `left_at IS NULL` forever. Measured before this change:
     * 1,476 live seats stranded across 1,420 closed tournament tables.
     *
     * That is not cosmetic. `table_seats WHERE left_at IS NULL` is the query
     * the multi-table container uses to rebuild a player's tabs on return, so
     * a player who finished a spin days ago still had that dead table restored
     * as a tab, and MultiTablePage's `seated` flag treated it as a live seat.
     * Releasing the seats is what actually puts the player back in the lobby.
     *
     * Done BEFORE the table is closed and per-table, so a failure on one table
     * cannot strand the rest, and never fatal: the event is over and the money
     * is already paid: a seat-release error must not undo that.
     */
    for (const [tableId, engine] of this.tableEngines) {
      await engine.stop();

      try {
        const { error: seatErr } = await supabase
          .from('table_seats')
          .update({ left_at: new Date().toISOString() })
          .eq('table_id', tableId)
          .is('left_at', null);
        if (seatErr) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] seat release failed on ${tableId.slice(0, 8)}: ${seatErr.message}`
            ),
            'Tournament.seat_release_failed'
          );
        }
      } catch (seatThrew) {
        reportError(seatThrew, 'Tournament.seat_release_threw');
      }

      await supabase.from('tables').update({ status: 'closed' }).eq('id', tableId);
    }

    // Clean up the reusable broadcast channel
    await this.cleanupBroadcastChannel();

    this.stop();
  }

  // ── Implemented by TournamentManager (layer 3/3) ──
  protected abstract checkTableBalance(): Promise<void>;
  protected abstract processSatelliteAwards(tournament: any): Promise<void>;
  protected abstract ensureLateRegSeated(): Promise<void>;
  protected abstract checkDynamicTableExpansion(): Promise<void>;
}
