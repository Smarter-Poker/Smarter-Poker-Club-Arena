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
import { TournamentManagerBase } from './TournamentManagerBase.js';

/**
 * The single rule for turning a prize pool + payout structure into one place's
 * prize. Both payout sites use it (eliminatePlayer for places 2..N,
 * finishTournament for place 1) so they can never disagree.
 *
 * PAYOUT-INTEGRITY 2026-08-20: every place used to be rounded independently,
 * so the rounded places need not add up to the pool. The 9-place structure on
 * a 483.00 pool rounds to 483.01 -- a one-cent overpay on every such event;
 * across the distinct (pool, structure) pairs actually used in production 8 of
 * 67 are off by a cent. It also put the engine permanently at odds with
 * fn_tournament_payout_reconcile, which would have reported a false "overpaid"
 * on each one and raised a critical alert.
 *
 * Rule: every place except the last is its own rounded percentage; the LAST
 * paid place takes whatever remains, so the places sum to the pool to the
 * cent. The adjustment lands on the smallest prize, never a headline one.
 * fn_tournament_payout_reconcile implements the identical rule.
 */
export function computePlacePrize(
  pool: number,
  payouts: Array<{ place?: number; percentage?: number }>,
  place: number
): number {
  if (!Array.isArray(payouts) || payouts.length === 0) return 0;
  if (!payouts.some((p) => Number(p?.place) === place)) return 0;

  const safePool = Number.isFinite(pool) && pool > 0 ? pool : 0;
  if (safePool === 0) return 0;

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const pctOf = (p: { percentage?: number }) =>
    round2((safePool * Number(p?.percentage ?? 0)) / 100);

  const lastPlace = payouts.reduce((m, p) => Math.max(m, Number(p?.place ?? 0)), 0);
  if (place !== lastPlace) {
    return pctOf(payouts.find((p) => Number(p?.place) === place)!);
  }

  const others = payouts
    .filter((p) => Number(p?.place) !== lastPlace)
    .reduce((sum, p) => sum + pctOf(p), 0);
  // Never exceed the pool and never go negative if a structure is malformed
  // (percentages summing past 100).
  return Math.max(0, round2(safePool - others));
}

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
        const { data: busted } = await supabase
          .from('tournament_players')
          .select('user_id, chips')
          .eq('tournament_id', this.tournamentId)
          .eq('status', 'playing')
          .lte('chips', 0);

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
    }, 5000);
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
      return; // Already processed
    }

    const { data: tournament } = await supabase
      .from('tournaments')
      .select(
        'payout_structure, prize_pool, is_bounty, is_pko, is_mystery_bounty, bounty_amount, mystery_bounty_min, mystery_bounty_max, variant'
      )
      .eq('id', this.tournamentId)
      .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

    let prize = 0;
    // TOURNEY-AUDIT 2026-07-24 (sweep 6): SATELLITES pay SEATS, not cash — the
    // award happens once at finishTournament (top finishers are registered
    // into the target tournament). Per-elimination cash would double-dip.
    const isSatellite = (tournament as any)?.variant === 'satellite';
    if (!isSatellite && tournament?.payout_structure) {
      let payouts = tournament.payout_structure;
      if (typeof payouts === 'string') {
        try {
          payouts = JSON.parse(payouts);
        } catch {
          payouts = [];
        }
      }
      if (Array.isArray(payouts)) {
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

    if (prize > 0) {
      // Retry prize credit up to 3 times with exponential backoff
      let creditSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { error: creditErr } = await supabase.rpc('credit_player_wallet', {
          p_user_id: userId,
          p_amount: prize,
          // P1 FIX (2026-07-24): idempotency key so a committed-but-timed-out
          // credit is a no-op on the next retry attempt (no double prize mint),
          // and so the recovery path dedupes against this main path — SAME format
          // (`tourney:{id}:prize:{user}:{position}`).
          p_idempotency_key: `tourney:${this.tournamentId}:prize:${userId}:${position}`,
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
      if (creditSuccess) {
        const { error: prizeLogErr } = await supabase.rpc('log_wallet_transaction', {
          p_user_id: userId,
          p_wallet_type: 'PLAYER',
          p_amount: prize,
          p_type: 'credit',
          p_category: 'prize',
          p_description: `Tournament prize: position ${position}`,
          p_table_id: null,
          p_hand_id: null,
          p_related_entity_id: this.tournamentId,
        });
        if (prizeLogErr)
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Prize log FAILED for ${userId.slice(0, 8)}: ${prizeLogErr.message}`
            ),
            'TournamentthistournamentIdslic.Prize_log_FAILED_for_userIdsli'
          );
      } else {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Prize credit FAILED after 3 retries for ${userId.slice(0, 8)} — ${prize} chips lost`
          ),
          'TournamentthistournamentIdslic.CRITICAL'
        );
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
          await this.processBountyCollection(tournament, userId, knockerId);
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
    const { data: tournamentTables } = await supabase
      .from('tables')
      .select('id')
      .eq('tournament_id', this.tournamentId);
    const tournamentTableIds = (tournamentTables ?? []).map((t: { id: string }) => t.id);
    if (tournamentTableIds.length > 0) {
      await supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .eq('user_id', userId)
        .in('table_id', tournamentTableIds)
        .is('left_at', null);
    }

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
    knockerUserId: string
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
    try {
      const { data: names } = await supabase
        .from('tournament_players')
        .select('user_id, username')
        .eq('tournament_id', this.tournamentId)
        .in('user_id', [eliminatedUserId, knockerUserId]);
      const nameOf = (id: string) =>
        (names || []).find((n: any) => n.user_id === id)?.username || 'Player';

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
          knockerName: nameOf(knockerUserId),
          knockerUserId,
          avgBounty: tournament?.bounty_amount || undefined,
          poolRemaining: res.pool_remaining,
        }
      );
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
      const { error: creditErr } = await supabase.rpc('credit_player_wallet', {
        p_user_id: knockerUserId,
        p_amount: amount,
        // A3 FIX (2026-07-28): this credit sits inside a 3x retry loop and the
        // `tournament_bounties` dedupe INSERT only happens AFTER it succeeds, so
        // a committed-but-timed-out credit was paid again on the next attempt
        // (2-3x bounty mint). One bounty per (eliminated, knocker) pair per
        // tournament, so that tuple is the natural idempotency key.
        p_idempotency_key: `tourney:${this.tournamentId}:bounty:${eliminatedUserId}:${knockerUserId}`,
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

    const { error: bountyLogErr } = await supabase.rpc('log_wallet_transaction', {
      p_user_id: knockerUserId,
      p_wallet_type: 'PLAYER',
      p_amount: amount,
      p_type: 'credit',
      p_category: 'bounty',
      p_description: `Bounty collected from eliminated player`,
      p_table_id: null,
      p_hand_id: null,
      p_related_entity_id: this.tournamentId,
    });
    if (bountyLogErr)
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty log FAILED for ${knockerUserId.slice(0, 8)}: ${bountyLogErr.message}`
        ),
        'TournamentthistournamentIdslic.Bounty_log_FAILED_for_knockerU'
      );
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
        const { error: creditErr } = await supabase.rpc('credit_player_wallet', {
          p_user_id: player.user_id,
          p_amount: difference,
          // A3 FIX (2026-07-28): the self-healing `prize` write below only runs
          // when the credit succeeds, so a committed-but-timed-out credit leaves
          // the old prize recorded and the next recalc pass credits the same
          // difference again. Key on the exact adjustment being made (distinct
          // `prizeadj` namespace so it never collides with the position prize).
          p_idempotency_key: `tourney:${this.tournamentId}:prizeadj:${player.user_id}:${player.position}:${correctPrize}`,
        });

        if (!creditErr) {
          // Update the recorded prize
          await supabase
            .from('tournament_players')
            .update({ prize: correctPrize })
            .eq('tournament_id', this.tournamentId)
            .eq('user_id', player.user_id);

          // Log the adjustment
          await supabase.rpc('log_wallet_transaction', {
            p_user_id: player.user_id,
            p_wallet_type: 'PLAYER',
            p_amount: difference,
            p_type: 'credit',
            p_category: 'prize',
            p_description: `Tournament prize adjustment (late reg pool finalized): position ${player.position}`,
            p_table_id: null,
            p_hand_id: null,
            p_related_entity_id: this.tournamentId,
          });
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
        'payout_structure, prize_pool, buy_in_fee, current_players, club_id, name, status, is_bounty, is_pko, is_mystery_bounty, variant, tournament_type, satellite_target_id'
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
    if (!isSatelliteFinish && tournament?.payout_structure) {
      let payouts = tournament.payout_structure;
      if (typeof payouts === 'string') {
        try {
          payouts = JSON.parse(payouts);
        } catch {
          payouts = [];
        }
      }
      const firstPlace = Array.isArray(payouts) ? payouts.find((p: any) => p.place === 1) : null;
      if (firstPlace) {
        // PAYOUT-INTEGRITY 2026-08-20: same residual rule as every other place
        // (see computePlacePrize). For a single-place structure (Spins) place 1
        // IS the last place, so the winner receives the whole pool exactly.
        winnerPrize = computePlacePrize(Number(tournament.prize_pool || 0), payouts, 1);
      } else {
        // FALLBACK: no place 1 in structure — award 100% of prize pool to winner
        // Round 53: Math.round, not trunc — same IEEE-drift family as the rest of Round 40.
        console.warn(
          `[Tournament:${this.tournamentId.slice(0, 8)}] payout_structure missing place 1 — awarding full prize pool to winner`
        );
        winnerPrize = Math.round((tournament.prize_pool || 0) * 100) / 100;
      }
    } else if (!isSatelliteFinish) {
      // No payout_structure at all — award full prize pool
      // Round 53: Math.round, not trunc — same IEEE-drift family as the rest of Round 40.
      console.warn(
        `[Tournament:${this.tournamentId.slice(0, 8)}] No payout_structure — awarding full prize pool to winner`
      );
      winnerPrize = Math.round((tournament?.prize_pool || 0) * 100) / 100;
    }

    if (winnerPrize > 0) {
      // Retry winner prize credit up to 3 times
      let creditSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { error: creditErr } = await supabase.rpc('credit_player_wallet', {
          p_user_id: winnerId,
          p_amount: winnerPrize,
          // A3 FIX (2026-07-28): closes TWO double-pay drivers at once.
          // (a) the 3x retry loop around this call, and (b) the stuck-COMPLETING
          // watchdog (`recoverStuckCompletingTournaments`) which pays place 1
          // under exactly `tourney:{id}:prize:{user}:1` - a key this path never
          // wrote, so the winner could be paid twice across the two paths.
          // Using the identical format makes them dedupe against each other.
          p_idempotency_key: `tourney:${this.tournamentId}:prize:${winnerId}:1`,
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

      if (creditSuccess) {
        const { error: prizeLogErr } = await supabase.rpc('log_wallet_transaction', {
          p_user_id: winnerId,
          p_wallet_type: 'PLAYER',
          p_amount: winnerPrize,
          p_type: 'credit',
          p_category: 'prize',
          p_description: `Tournament winner prize: 1st place`,
          p_table_id: null,
          p_hand_id: null,
          p_related_entity_id: this.tournamentId,
        });
        if (prizeLogErr)
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Prize log FAILED for ${winnerId.slice(0, 8)}: ${prizeLogErr.message}`
            ),
            'TournamentthistournamentIdslic.Prize_log_FAILED_for_winnerIds'
          );
      } else {
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

    // ── TOURNAMENT RAKE SETTLEMENT ──
    // Rake is held by union (if club is in a union) or by standalone club owner.
    // Union distributes 90% rake back to clubs weekly. Union holds all BBJ & promo.
    //
    // RAKE-AUDIT 2026-07-24: totalRake is now the SUM of fees ACTUALLY COLLECTED
    // (rake_records fee ledger: entry + rebuy + add-on + re-entry fees, minus
    // unregister reversals). The old formula `buy_in_fee × current_players`
    // credited the union/club wallet a fee for EVERY entrant INCLUDING HORSES —
    // who register free — minting phantom revenue backed by no collected chips
    // (all 974 registrations in the 7 days before this fix were horses), and it
    // ignored rebuy/add-on/re-entry fees entirely.
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

    for (const [tableId, engine] of this.tableEngines) {
      await engine.stop();
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
