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
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { supabase } from '../services/supabase.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { reportError } from '../services/errorReporter.js';
import { IN_LIST_CHUNK } from '../services/supabase/chunkedIn.js';
import {
  mysteryChestHoldMs,
  mysteryChestPostRevealMs,
  MYSTERY_BOUNTY_QUEUE_COALESCE_MS,
} from '../config/mysteryChestSpec.js';
import { MYSTERY_BOUNTY_REVEAL_DELAY_MS, formatBountyTier } from '../config/mysteryBountySpec.js';
import { buildRecipientClaims } from './mysteryBountyDraw.js';
import { buildPrizeLadder, prizeRankOf, isMysteryCollectMode } from './mysteryPrizeLadder.js';
import { attributeKnockout } from './knockoutAttribution.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import {
  eliminationSweepMs,
  eliminationSweepsInflight,
  eliminationSweepOverrunsTotal,
} from '../observability/engineInstruments.js';
import {
  COMPLETED_FLIP_ATTEMPTS,
  COMPLETED_FLIP_BACKOFF_MS,
  isTransientFlipError,
} from './completedFlip.js';
import { computePlacePrize } from './payoutMath.js';
import { settleTournamentObligation, TRANSPORT_REFUSAL } from './settleObligation.js';
import {
  resolvePayoutStructure,
  parsePayoutStructure,
  isSpinTournament,
  remainingPoolAfterAwards,
} from './payoutStructure.js';

interface QueuedBountyReveal {
  awardId: string;
  tableId: string | null;
  eliminatedUserId: string;
  designatedRevealer: string;
  recipientUserIds: string[];
}

interface TableRevealQueue {
  /** Chests reserved and not yet on screen, in reserve order. */
  waiting: QueuedBountyReveal[];
  /** The chest currently owning the table, or null between chests. */
  active: QueuedBountyReveal | null;
  /** How many of this burst have been presented — the "1" in "1 OF 3". */
  presented: number;
  /** Open only until the first chest of a burst is presented. */
  coalesceTimer: ReturnType<typeof setTimeout> | null;
}

export abstract class TournamentManagerEliminations extends TournamentManagerBase {
  /** Dan 2026-08-30: how long a busted player's rebuy offer stays open before
   *  the elimination sweep may stamp a finishing place. The table itself never
   *  pauses; only the PLAYER'S elimination waits. */
  protected static readonly REBUY_DECISION_GRACE_MS = 30_000;
  /** userId -> epoch-ms deadline for an open rebuy decision. Self-clearing. */
  protected rebuyDecisionGraceUntil = new Map<string, number>();

  /** Epoch-ms of the last chip-cap input refresh; 0 = never. */
  protected lastChipCapRefreshAt = 0;

  /**
   * Refresh the inputs `capLevelToTournamentChips` measures a blind against:
   * how many players ever entered, and how many rebuys and add-ons have been
   * granted. Both raise the chip supply and therefore RELAX the cap.
   *
   * Every value is a high-water mark. An unreadable count leaves the previous
   * one in place rather than lowering it — a cap computed from a chip supply
   * that shrank would throttle the blinds mid-event, which is a worse failure
   * than not capping at all.
   */
  protected async refreshChipCapInputs(): Promise<void> {
    const now = Date.now();
    if (now - this.lastChipCapRefreshAt < 60_000) return;
    this.lastChipCapRefreshAt = now;

    try {
      const { count: entrants, error: entrantsErr } = await supabase
        .from('tournament_players')
        .select('*', { count: 'exact', head: true })
        .eq('tournament_id', this.tournamentId);
      if (!entrantsErr && typeof entrants === 'number' && entrants > this.entrantCountForChipCap) {
        this.entrantCountForChipCap = entrants;
      }

      const { count: rebuys, error: rebuysErr } = await supabase
        .from('wallet_transactions')
        .select('*', { count: 'exact', head: true })
        .eq('related_entity_id', this.tournamentId)
        .eq('category', 'rebuy');
      if (!rebuysErr && typeof rebuys === 'number' && rebuys > this.rebuysGrantedForChipCap) {
        this.rebuysGrantedForChipCap = rebuys;
      }

      const { count: addons, error: addonsErr } = await supabase
        .from('wallet_transactions')
        .select('*', { count: 'exact', head: true })
        .eq('related_entity_id', this.tournamentId)
        .eq('category', 'addon');
      if (!addonsErr && typeof addons === 'number' && addons > this.addonsGrantedForChipCap) {
        this.addonsGrantedForChipCap = addons;
      }
    } catch (err) {
      // Never let the cap's bookkeeping break the sweep that pays people.
      reportError(err, 'Tournament.refresh_chip_cap_inputs');
    }
  }

  /** SEATLESS-PHANTOM GUARD (2026-08-30): userId -> consecutive sweeps seen
   *  'playing' with chips > 0 while holding NO open seat anywhere in the
   *  tournament. See the block in the sweep for the full story. */
  protected seatlessPlayingStrikes = new Map<string, number>();
  /** ~2 minutes at the 5s sweep cadence — a live paid player is re-seated by
   *  ensureLateRegSeated within one or two cycles; only a vacated bust whose
   *  chips-zero write was lost stays seatless this long. */
  protected static readonly SEATLESS_PHANTOM_STRIKES = 24;

  /**
   * One reveal queue per table (sections 22 and 61 — only the affected table
   * pauses). Keyed by table id; the empty string is the degenerate "knockout
   * with no table" case, which still needs ordering so its broadcasts do not
   * interleave.
   */
  private bountyRevealQueues: Map<string, TableRevealQueue> = new Map();
  /**
   * Every award this manager has already put in a queue.
   *
   * `fn_mystery_bounty_reserve` is idempotent by design: a re-swept
   * elimination gets the SAME award id back with `already: true`. Without
   * this set, that reply would queue a second presentation of a chest that is
   * already on screen — and, in the worst case, a second `fn_mystery_bounty_pay`
   * for it. The RPC's own key makes the payment safe; this makes the
   * PRESENTATION safe (section 80/33).
   */
  private dispatchedBountyAwards: Set<string> = new Set();

  /**
   * The size of the field, once it can no longer grow.
   *
   * SHORT-FIELD RESIDUAL 2026-08-27. computePlacePrize gives the LAST place in
   * the structure the leftover, so the paid places sum to the pool exactly.
   * When fewer players entered than the structure pays, that place has no
   * finisher and the leftover was never awarded: a 9-place structure with 8
   * entrants stranded 250.00 of a 10,000.00 pool, and eight events did it in
   * thirty days. Trimming the structure to the field moves the residual onto
   * the last place that a player actually reached.
   *
   * TWO RULES MAKE THIS SAFE, and both are about the direction that overpays.
   *
   *   1. UNDEFINED UNTIL ENTRY IS CLOSED. While late registration is open the
   *      field can still grow, and a structure trimmed to a field that then
   *      grows would have promoted an earlier place to residual holder and
   *      overpaid it. Before prize_pool_finalized this returns undefined and
   *      every caller keeps today's behaviour exactly. Nothing is lost:
   *      recalculateEliminatedPrizes re-prices eliminated players through the
   *      same resolver after finalisation and tops up the difference.
   *
   *   2. EVERYONE WHO EVER ENTERED, never a live seat count. tournament_players
   *      rows are not deleted on elimination, only on an unregistration while
   *      registration is still open, so count(*) is the entrant count. A
   *      draining counter like current_players would shrink toward 1 and hand
   *      the whole pool to whoever busted next; that exact defect is why
   *      fn_spin_sweep_unbooked under-books its rake.
   *
   * Cached once resolved, because after finalisation the answer cannot change.
   * A failed count returns undefined rather than a guess.
   */
  private finalFieldSizeCache: number | undefined;

  protected async finalFieldSize(): Promise<number | undefined> {
    if (!this.prizePoolFinalized) return undefined;
    if (this.finalFieldSizeCache !== undefined) return this.finalFieldSizeCache;

    const { count, error } = await supabase
      .from('tournament_players')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', this.tournamentId);

    if (error || typeof count !== 'number' || count < 1) return undefined;
    this.finalFieldSizeCache = count;
    return count;
  }

  protected startEliminationChecker(): void {
    this.eliminationTimer = setInterval(async () => {
      if (!this.running) return;

      /**
       * ── THE LOCK IS NO LONGER HELD FOREVER (2026-08-29) ──
       *
       * See TournamentManagerBase's note on eliminationSweepStartedAt. In
       * short: `finally` cannot release a lock held by an await that never
       * settles, and a permanently held lock here means this tournament never
       * eliminates anybody again and never pays anybody out — silently, for
       * the life of the process.
       *
       * So a held lock is now inspected rather than simply obeyed.
       */
      if (this.isProcessingEliminations) {
        const heldForMs = this.eliminationSweepStartedAt
          ? Date.now() - this.eliminationSweepStartedAt
          : 0;
        const verdict = TournamentManagerBase.eliminationLockVerdict(heldForMs);

        if (verdict === 'force') {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] elimination sweep has held its lock for ${Math.round(
                heldForMs / 1000
              )}s - taking it back. The stalled sweep (generation ${this.eliminationSweepGeneration}) is superseded and will stand down at its next write. Eliminations were stopped for this tournament until now.`
            ),
            'Tournament.elimination_sweep_lock_forced'
          );
          eliminationSweepOverrunsTotal.inc(1, { outcome: 'forced' });
          this.isProcessingEliminations = false;
          this.eliminationSweepStartedAt = 0;
          this.eliminationSweepStuckReportedAt = 0;
          // The abandoned sweep will never reach its own `finally` (its
          // generation is superseded), so its inflight count is released here
          // or the gauge climbs for ever on a process that forces locks.
          eliminationSweepsInflight.dec();
          // Fall through and start a fresh sweep on this same tick: the field
          // has already waited five minutes.
        } else {
          // Not forcing yet, but say so — ONCE per episode, not once per tick.
          if (
            verdict === 'warn' &&
            this.eliminationSweepStuckReportedAt < this.eliminationSweepStartedAt
          ) {
            this.eliminationSweepStuckReportedAt = Date.now();
            // The 780-in-fifteen-minutes number, as a series rather than a
            // grep of the container log. See engineInstruments.
            eliminationSweepOverrunsTotal.inc(1, { outcome: 'warned' });
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] elimination sweep still running after ${Math.round(
                  heldForMs / 1000
                )}s - no player can be eliminated and the tournament cannot finish while it is held`
              ),
              'Tournament.elimination_sweep_overrunning'
            );
          }
          return;
        }
      }

      this.isProcessingEliminations = true;
      this.eliminationSweepStartedAt = Date.now();
      const sweepGeneration = ++this.eliminationSweepGeneration;
      // How many of these the single JS thread is carrying at once, and how
      // long one takes. Both are measurement only - see engineInstruments.
      const sweepStartedAt = Date.now();
      eliminationSweepsInflight.inc();

      try {
        // ── SYNC STACKS: table_seats → tournament_players ──
        // The poker engine updates table_seats.stack after each hand. Collect all
        // seat stacks across every table, then push them to tournament_players in
        // ONE bulk statement (fn_sync_tournament_chips) instead of one UPDATE per
        // seat per table every 5s (the old N+1 that flooded Postgres logs).
        /**
         * ═══════════════════════════════════════════════════════════════════
         *  ONE PLAYER, ONE STACK (2026-08-25)
         * ═══════════════════════════════════════════════════════════════════
         *
         * Two defects, both of which end with a live player's chip count being
         * set from a stack that is not theirs any more.
         *
         * (a) THE READ WAS NOT CHECKED. `if (seats)` skipped a table whose
         *     read failed exactly as if that table had no seats, so the sweep
         *     went on to bust players using a chip picture it knew was
         *     incomplete. Deciding who is out on a partial read is the same
         *     mistake as deciding a tournament is over on a failed count.
         *
         * (b) SEATS WERE NOT DEDUPED BY PLAYER. One entry was pushed per SEAT,
         *     and a player can hold more than one open seat: a table move that
         *     writes the destination seat but does not stamp `left_at` on the
         *     source leaves both rows live. Measured on production
         *     2026-08-25, one running MTT (Turbo Tuesday Graveyard): 502 open
         *     seats across 376 distinct players, 108 of them holding more than
         *     one, double-counting 1,461,180 chips. Postgres resolves
         *     `UPDATE ... FROM jsonb_to_recordset` against duplicate keys by
         *     picking an ARBITRARY row, so `fn_sync_tournament_chips` could
         *     overwrite a live stack with a dead one — and a dead seat's stack
         *     is frequently 0, which is precisely what the bust sweep below
         *     eliminates people for.
         *
         * The live seat is the one most recently joined, so keep that and drop
         * the rest. If two open seats claim the same `joined_at`, or it is
         * missing, there is no evidence for which is live: that player is
         * UNKNOWN and is left out of this sync entirely rather than guessed at.
         *
         * This does NOT fix the duplicate seats themselves — they are created
         * by the table-move path in TournamentManager, which this layer does
         * not own. It stops them from moving money here.
         */
        /**
         * ═══════════════════════════════════════════════════════════════════
         *  ONE READ FOR THE TOURNAMENT, NOT ONE PER TABLE (2026-08-28)
         * ═══════════════════════════════════════════════════════════════════
         *
         * This was a `for (const [tableId] of this.tableEngines)` loop issuing
         * one AWAITED round-trip per table, and it is why the "5-second"
         * elimination sweep is not a 5-second sweep on a big field.
         *
         * MEASURED. `$100 Freeroll 12:00 AM` on 2026-08-28: 326 entrants
         * across 37 tables. Thirty-seven sequential round-trips at even 150ms
         * apiece is 5.5 seconds — the sweep could not finish inside its own
         * interval, so `isProcessingEliminations` dropped the next tick, and
         * the next. That is the reported symptom exactly: a horse sitting at
         * 0 chips, not marked eliminated, for 22 minutes, in an event that had
         * recorded no eliminations at all. Nothing was stuck. The sweep was
         * simply arriving minutes late, and the bigger the field the later it
         * arrives — precisely backwards, because a big field is where busts
         * come fastest.
         *
         * One paged query over `tables.tournament_id` instead. Cost no longer
         * scales with table count, and the lag it was causing goes with it.
         *
         * IT ALSO CLOSES A BLIND SPOT. The old loop read `this.tableEngines`,
         * an IN-MEMORY map. A table this process holds no engine for — adopted
         * late, created by the balancer between hydrations, or orphaned by a
         * restart — was invisible: its players' chips were never synced, so
         * they could never appear in the bust list below, so they could never
         * be eliminated. Their seats sat there permanently. Reading by
         * tournament_id covers every table the tournament actually has,
         * whether or not this process happens to be dealing it.
         */
        // null = this player holds seats we cannot rank; skip them, do not guess.
        const bestSeat = new Map<string, { chips: number; joinedAt: number } | null>();
        const SEAT_PAGE = 1000;
        const seatRows: Array<{
          user_id: string;
          stack: number | null;
          joined_at: string | null;
        }> = [];
        /**
         * ===================================================================
         *  TWO INDEXED READS, NOT ONE SCAN OF EVERY LIVE SEAT (2026-09-01)
         * ===================================================================
         *
         * The read this replaces was right in intent and right in coverage. It
         * reads what the TOURNAMENT has rather than what this process happens to
         * hold engines for, which is the blind spot the block above closed. Its
         * SHAPE was the problem.
         *
         * `.select('...tables!inner(tournament_id)').eq('tables.tournament_id')`
         * compiles to a LATERAL join in which the OUTER table carries no
         * tournament predicate at all:
         *
         *   FROM table_seats
         *   INNER JOIN LATERAL (SELECT 1 FROM tables
         *                       WHERE tables.tournament_id = $1
         *                         AND tables.id = table_seats.table_id) ON true
         *   WHERE table_seats.left_at IS NULL
         *   ORDER BY table_seats.user_id LIMIT 1000
         *
         * So Postgres walks EVERY live seat on the platform and probes `tables`
         * once per seat, discarding the ones that belong to other tournaments.
         * Under an inner join with a LIMIT it cannot stop early either.
         *
         * MEASURED in production (pg_stat_statements, 2026-09-01): 68,049 calls
         * at 45ms mean, 3,085 seconds of database time - the largest single
         * component of the 6% of all DB time that table_seats reads account for.
         *
         * Replaced with the two reads the indexes were built for:
         *   tables      -> idx_tables_tournament_id (946,647 lifetime scans)
         *   table_seats -> idx_table_seats_table    (131,417 lifetime scans)
         * Coverage is IDENTICAL: still every table the tournament has, read from
         * the database rather than from this process's memory.
         *
         * PAGING IS ALSO DETERMINISTIC NOW, which is a correctness fix and not a
         * performance one. The old read paged with `.order('user_id')`, and
         * user_id IS NOT UNIQUE in table_seats - the block above exists precisely
         * because one user can hold several open seats. Two seats of the same
         * user straddling a 1000-row page boundary can be returned twice or not
         * at all depending on how Postgres breaks the tie, and this sweep is what
         * decides who is eliminated. Ordering on `id`, the primary key, makes
         * every page boundary unambiguous.
         */
        const TABLE_PAGE = 1000;
        const TABLE_ID_CHUNK = 200;

        // (1) Which tables does this tournament have? Indexed lookup.
        const tableIds: string[] = [];
        for (let page = 0; ; page++) {
          if (page > 10_000) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] table paging did not terminate - skipping this sweep`
              ),
              'Tournament.table_paging_runaway'
            );
            return; // the finally block clears isProcessingEliminations
          }
          const { data: tblChunk, error: tblErr } = await supabase
            .from('tables')
            .select('id')
            .eq('tournament_id', this.tournamentId)
            .order('id', { ascending: true })
            .range(page * TABLE_PAGE, page * TABLE_PAGE + TABLE_PAGE - 1);

          if (tblErr || !tblChunk) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] table read failed (${tblErr?.message ?? 'null chunk'}) - skipping the whole sweep rather than busting on a partial chip picture`
              ),
              'Tournament.table_read_failed'
            );
            return; // the finally block clears isProcessingEliminations
          }
          for (const row of tblChunk as Array<{ id: string }>) tableIds.push(row.id);
          if (tblChunk.length < TABLE_PAGE) break;
        }

        // (2) Live seats at those tables. Chunked, because the largest field on
        //     record is 1,076 tables and an unbounded IN list is its own outage.
        for (let start = 0; start < tableIds.length; start += TABLE_ID_CHUNK) {
          const idsForChunk = tableIds.slice(start, start + TABLE_ID_CHUNK);
          for (let page = 0; ; page++) {
            if (page > 10_000) {
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] seat paging did not terminate - skipping this sweep`
                ),
                'Tournament.seat_paging_runaway'
              );
              return; // the finally block clears isProcessingEliminations
            }
            const { data: chunk, error: seatsErr } = await supabase
              .from('table_seats')
              .select('user_id, stack, joined_at')
              .in('table_id', idsForChunk)
              .is('left_at', null)
              .order('id', { ascending: true })
              .range(page * SEAT_PAGE, page * SEAT_PAGE + SEAT_PAGE - 1);

            if (seatsErr || !chunk) {
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] seat read failed (${seatsErr?.message ?? 'null chunk'}) - skipping the whole sweep rather than busting on a partial chip picture`
                ),
                'Tournament.seat_read_failed'
              );
              return; // the finally block clears isProcessingEliminations
            }
            seatRows.push(...(chunk as unknown as typeof seatRows));
            if (chunk.length < SEAT_PAGE) break;
          }
        }

        {
          const seats = seatRows;
          for (const seat of seats ?? []) {
            // Guard against corrupted stack values (NaN, negative, undefined).
            const stackValue =
              typeof seat.stack === 'number' && !isNaN(seat.stack) && seat.stack >= 0
                ? seat.stack
                : 0;
            // Floor here too — tournament_players.chips is INTEGER (the RPC also
            // floors, but keep the payload clean).
            const chips = Math.floor(stackValue);
            const joinedAt = seat.joined_at ? new Date(seat.joined_at).getTime() : NaN;

            const held = bestSeat.get(seat.user_id);
            if (held === undefined) {
              bestSeat.set(seat.user_id, { chips, joinedAt });
              continue;
            }
            if (held === null) continue; // already ruled UNKNOWN this sweep
            if (!Number.isFinite(joinedAt) || !Number.isFinite(held.joinedAt)) {
              bestSeat.set(seat.user_id, null); // no evidence which seat is live
              continue;
            }
            if (joinedAt > held.joinedAt) {
              bestSeat.set(seat.user_id, { chips, joinedAt });
            } else if (joinedAt === held.joinedAt) {
              bestSeat.set(seat.user_id, null); // a tie is not evidence either
            }
          }
        }

        const chipUpdates: { user_id: string; chips: number }[] = [];
        const ambiguousSeatUsers: string[] = [];
        for (const [userId, seat] of bestSeat) {
          if (seat === null) {
            ambiguousSeatUsers.push(userId);
            continue;
          }
          chipUpdates.push({ user_id: userId, chips: seat.chips });
        }
        if (ambiguousSeatUsers.length > 0) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] ${ambiguousSeatUsers.length} player(s) hold multiple open seats with no usable joined_at - chip sync skipped for them this sweep: ${ambiguousSeatUsers.map((u) => u.slice(0, 8)).join(', ')}`
            ),
            'Tournament.ambiguous_live_seat'
          );
        }

        /**
         * ═══════════════════════════════════════════════════════════════════
         *  A PHANTOM IS NOT A PLAYER (2026-08-30)
         * ═══════════════════════════════════════════════════════════════════
         *
         * The bust-vacates-the-seat rule (Dan 2026-08-30) created a state this
         * sweep had never seen: a player 'playing' with STALE chips > 0 and no
         * open seat anywhere in the event. The chip sync above reads OPEN
         * seats, so it can never zero them; the bust query below reads
         * `chips <= 0`, so it can never eliminate them; ensureLateRegSeated
         * would seat them (chips > 0 looks live), except the seat rows that
         * proved their bust were reused or gone. Ten of sixteen RUNNING MTTs
         * hung exactly here, heads-up champion unseated-forever unpaid.
         *
         * The dealing engine now zeroes chips at the moment of the vacate;
         * this block is the backstop for the write that fails, the process
         * that restarts mid-bust, and the ten events already stranded.
         * A player seatless for SEATLESS_PHANTOM_STRIKES consecutive sweeps
         * (~2 minutes) while the self-heal seater runs every 5 seconds is not
         * between seats — their seat is gone because they busted. Zero their
         * chips through the same sync RPC so the ordinary elimination path
         * (rebuy window included) takes them from there. Strikes reset the
         * moment a player reappears in an open seat, and the map is
         * per-manager so a restart merely restarts the two-minute clock.
         */
        try {
          const { data: playingRows, error: playingRowsErr } = await supabase
            .from('tournament_players')
            .select('user_id, chips')
            .eq('tournament_id', this.tournamentId)
            .eq('status', 'playing')
            .gt('chips', 0);
          if (!playingRowsErr && playingRows) {
            const seatless = playingRows.filter((p) => !bestSeat.has(p.user_id));
            const seatlessIds = new Set(seatless.map((p) => p.user_id));
            for (const uid of this.seatlessPlayingStrikes.keys()) {
              if (!seatlessIds.has(uid)) this.seatlessPlayingStrikes.delete(uid);
            }
            for (const p of seatless) {
              const strikes = (this.seatlessPlayingStrikes.get(p.user_id) ?? 0) + 1;
              this.seatlessPlayingStrikes.set(p.user_id, strikes);
              // `>=`, not `===`: if the sync write fails on the firing sweep,
              // the next sweep must fire again. The zero is idempotent.
              if (strikes >= TournamentManagerEliminations.SEATLESS_PHANTOM_STRIKES) {
                chipUpdates.push({ user_id: p.user_id, chips: 0 });
                reportError(
                  new Error(
                    `[Tournament:${this.tournamentId.slice(0, 8)}] ${p.user_id.slice(0, 8)} has been 'playing' with ${p.chips} stale chips and NO open seat for ${strikes} sweeps - treating as a vacated bust and zeroing chips so the elimination path can finish the event`
                  ),
                  'Tournament.seatless_phantom_zeroed'
                );
              }
            }
          }
        } catch (phantomErr) {
          reportError(phantomErr, 'Tournament.seatless_phantom_guard');
        }

        if (chipUpdates.length > 0) {
          const { error: syncErr } = await supabase.rpc('fn_sync_tournament_chips', {
            p_tournament_id: this.tournamentId,
            p_updates: chipUpdates,
          });
          if (syncErr) reportError(syncErr, 'GameServer.syncTournamentChips');
        }

        // CHIP-CAP INPUTS (2026-08-31): entrants + rebuys/add-ons granted, so
        // capLevelToTournamentChips knows how many chips the event has issued.
        // Throttled to once a minute — the cap only needs to be roughly right,
        // and it is a high-water mark so a slow refresh can never tighten it.
        await this.refreshChipCapInputs();

        // Find ALL busted players (0 chips) in a single query
        // eslint-disable-next-line prefer-const
        let { data: busted, error: bustedErr } = await supabase
          .from('tournament_players')
          .select('user_id, chips')
          .eq('tournament_id', this.tournamentId)
          .eq('status', 'playing')
          .lte('chips', 0);

        // PAYOUT-INTEGRITY 2026-08-25: an unreadable bust list is UNKNOWN. The
        // error was discarded, so a failed read looked exactly like "nobody
        // busted" — and the sweep then fell straight through to the finish
        // check below and could complete the tournament on the strength of it.
        if (bustedErr) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] bust list unreadable (${bustedErr.message}) - skipping this sweep entirely`
            ),
            'Tournament.busted_list_unavailable'
          );
          return; // the finally block clears isProcessingEliminations
        }

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
            `[Tournament:${this.tournamentId.slice(0, 8)}] Bust sweep held - stacks not credited yet (${Math.ceil(
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
          if (
            !liveErr &&
            typeof liveCount === 'number' &&
            liveCount > 0 &&
            busted.length >= liveCount
          ) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] all ${liveCount} live player(s) read 0 chips - uncredited stacks, not a bust. Eliminating nobody this sweep.`
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
                `[Tournament:${this.tournamentId.slice(0, 8)}] playing count unavailable (${playingErr?.message ?? 'null count'}) - deferring ${busted.length} elimination(s)`
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
          const { rebought, answered } = await this.tryTournamentRebuys(
            busted.map((b) => b.user_id)
          );
          if (rebought.size > 0) {
            busted = busted.filter((b) => !rebought.has(b.user_id));
            if (busted.length === 0) {
              return; // everyone bought back in; nobody is eliminated this pass
            }
          }

          /**
           * THE REBUY DECISION WINDOW (Dan, 2026-08-30, verbatim): "REBUYS IN
           * A TOURNAMENT SHOULD NOT PAUSE THE ACTION, IT SHOUD TRIGGER THE
           * REBUY OFFER, THEN SIT THE PLAYER REBUYING AT ANY TABLE THAT NEEDS
           * TO BE BALANCED, OR AT ANY SEAT THAT IS OPEN OR WHERE A PLAYER IS
           * NEEDED FIRST, IF THEY TRULY SHOULD BE IN THE SAME TABLE, SAME
           * SEAT, ITS ALLOWED."
           *
           * The table no longer pauses (ServerTableEngineDealing skips the
           * rebuy pause on tournament tables), so the WINDOW moves here: a
           * busted player whose rebuy offer is still open is not eliminated
           * until they answer or the grace expires. Horses answer inside
           * tryTournamentRebuys in this same pass (`answered`), so the window
           * is identical for everyone — a horse simply replies immediately,
           * which is its input device, not a different deal. A rebuy that
           * lands mid-grace raises chips above zero, drops the player out of
           * the next bust snapshot, and ensureLateRegSeated re-seats them at
           * the table that most needs a player — same table and seat when
           * that is where the need is.
           *
           * If the rebuy window is CLOSED, there is nothing to wait for and
           * nobody is deferred. The grace map is per-manager and self-clears.
           */
          {
            const tt = this.tournamentCache as {
              is_rebuy?: boolean;
              rebuy_levels?: number | null;
              late_reg_levels?: number | null;
              addon_levels?: number | null;
              add_on_available?: boolean;
              prize_pool_finalized?: boolean;
            } | null;
            const nz = (v: unknown): number | null => {
              const n = Number(v);
              return Number.isFinite(n) && n !== 0 ? n : null;
            };
            let rebuyCap = nz(tt?.rebuy_levels) ?? nz(tt?.late_reg_levels) ?? 0;
            if (rebuyCap > 0 && tt?.add_on_available) {
              rebuyCap += nz(tt?.addon_levels) ?? 1;
            }
            const windowOpen =
              !!tt?.is_rebuy &&
              rebuyCap > 0 &&
              this.currentLevel < rebuyCap &&
              !tt?.prize_pool_finalized;
            if (windowOpen) {
              const now = Date.now();
              busted = busted.filter((b) => {
                if (answered.has(b.user_id)) {
                  this.rebuyDecisionGraceUntil.delete(b.user_id);
                  return true; // decision made this pass — eliminate the declines
                }
                const until = this.rebuyDecisionGraceUntil.get(b.user_id);
                if (until === undefined) {
                  this.rebuyDecisionGraceUntil.set(
                    b.user_id,
                    now + TournamentManagerEliminations.REBUY_DECISION_GRACE_MS
                  );
                  return false; // window just opened for them
                }
                if (now < until) return false; // still deciding
                this.rebuyDecisionGraceUntil.delete(b.user_id);
                return true; // window expired — they are out
              });
            } else if (this.rebuyDecisionGraceUntil.size > 0) {
              this.rebuyDecisionGraceUntil.clear();
            }
            // Anyone no longer busted (they rebought) sheds their entry.
            const stillBusted = new Set(busted.map((b) => b.user_id));
            for (const uid of this.rebuyDecisionGraceUntil.keys()) {
              if (!stillBusted.has(uid) && !answered.has(uid)) {
                // kept: they may re-bust later and deserve a fresh window then
                this.rebuyDecisionGraceUntil.delete(uid);
              }
            }
            if (busted.length === 0) return;
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
          // PAYOUT-INTEGRITY 2026-08-27: distinct WITHIN a sweep was not
          // enough. `playingCount` is a live count and is NOT monotonic —
          // ensureLateRegSeated promotes `registered` entrants to `playing`
          // after eliminations have begun — so a later sweep could compute a
          // basePosition at or above a place an earlier sweep already paid,
          // and the wallet key (`...:prize:{user}:{place}`) dedupes a repeated
          // USER, not a repeated PLACE. Confirmed live: 206 duplicated places
          // across 138 tournaments, e.g. Late Night Grind 03b76a64 paid place
          // 2 to two players and disbursed 107% of its pool.
          //
          // Places are now taken from the set that is actually still FREE,
          // walking down, so a collision is impossible by construction rather
          // than by arithmetic that assumed a stable count.
          /**
           * ═══════════════════════════════════════════════════════════════
           *  THE LADDER IS COUNTED FROM UNPLACED PLAYERS, AND IT NEVER
           *  RUNS OUT (2026-08-28)
           * ═══════════════════════════════════════════════════════════════
           *
           * Union PKO Afternoon (PLO4) 4f42d847 deadlocked heads-up and sat
           * there: 39 entrants, places 2..38 handed out with no gap and no
           * duplicate, place 39 never used, one player at 0 chips left
           * `status='playing'` forever. Blinds kept escalating through four
           * levels, the table stopped dealing after the final hand, the
           * champion was never crowned and nobody was paid first prize.
           *
           * TWO DEFECTS, and it takes both to hang an event.
           *
           * (a) THE SEED WAS A LIVE `playing` COUNT. `playingCount` reads
           *     `status='playing'`, and an entrant who has not yet been
           *     promoted out of `registered` by ensureLateRegSeated is not in
           *     it. On 4f42d847 the first bust was seeded at 38 while 39
           *     players were in the event, so the WHOLE ladder was short by
           *     one from that moment on. Nothing detected it, because a
           *     ladder that is uniformly one place high is gapless and
           *     collision-free — it looks perfect right up until the last
           *     busted player asks for a place and there is none left.
           *
           *     The count that cannot drift is the number of players who
           *     hold NO place yet: exactly the field still in contention
           *     plus the ones busting in this sweep, `registered` entrants
           *     included. If the ladder is healthy the free places are
           *     precisely 1..unplaced, so the worst finisher takes
           *     `unplaced`. Over-counting (a withdrawn row that keeps
           *     position NULL) is the SAFE direction: it leaves an unclaimed
           *     gap, which the payout trim already handles, instead of a
           *     collision that pays a place twice.
           *
           * (b) EXHAUSTION WAS A `break`. When the walk down found nothing
           *     free it logged and abandoned the player MID-SWEEP, leaving
           *     them `status='playing'` at 0 chips. `remainingCount` can then
           *     never reach 1, so finishTournament is unreachable — for the
           *     rest of the process's life, every 5 seconds, forever. One
           *     mislabelled place is a bookkeeping error a human can renumber.
           *     Refusing to eliminate anybody strands the entire field's
           *     money, the champion's included. So a busted player is ALWAYS
           *     eliminated: if no place is free at or below the seed, take
           *     the lowest free place above it and shout about it.
           *
           * (c) THE TAKEN-PLACES READ WAS UNCHECKED. `takenRows || []` turned
           *     a failed query into "every place is free", which is the
           *     collision this block exists to prevent. An unreadable list is
           *     UNKNOWN — defer the eliminations to the next sweep.
           */
          const { data: takenRows, error: takenErr } = await supabase
            .from('tournament_players')
            .select('position')
            .eq('tournament_id', this.tournamentId)
            .not('position', 'is', null);

          if (takenErr || !takenRows) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] taken-places list unreadable (${takenErr?.message ?? 'null rows'}) - deferring ${bustedOrdered.length} elimination(s) rather than assigning a place that may already be paid`
              ),
              'Tournament.taken_places_unavailable'
            );
            return; // the finally block clears isProcessingEliminations
          }

          const takenPositions = new Set<number>(
            takenRows
              .map((r) => Number((r as { position: unknown }).position))
              .filter((n) => Number.isFinite(n))
          );

          // Players who hold no finishing place yet. Monotonic, and immune to
          // the late-reg promotion that made `playingCount` drift.
          const { count: unplacedCount, error: unplacedErr } = await supabase
            .from('tournament_players')
            .select('*', { count: 'exact', head: true })
            .eq('tournament_id', this.tournamentId)
            .is('position', null);

          if (unplacedErr || unplacedCount === null || unplacedCount === undefined) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] unplaced-player count unavailable (${unplacedErr?.message ?? 'null count'}) - deferring ${bustedOrdered.length} elimination(s)`
              ),
              'Tournament.unplaced_count_unavailable'
            );
            return; // the finally block clears isProcessingEliminations
          }

          let nextPosition = Math.max(unplacedCount, playingCount, bustedOrdered.length + 1);
          for (let i = 0; i < bustedOrdered.length; i++) {
            /**
             * SUPERSEDED SWEEPS STAND DOWN (2026-08-29). This sweep may have
             * been declared stuck and had its lock taken back while it was
             * waiting on one of the reads above; a fresh sweep is then running
             * with a chip picture and a taken-places set newer than ours.
             *
             * `takenPositions` is a snapshot, so continuing from here would
             * hand out a place the live sweep may already have paid — and the
             * wallet idempotency key dedupes a repeated USER, not a repeated
             * PLACE, so nothing downstream would catch it. Stop before the
             * write. Every player left in `bustedOrdered` still has 0 chips
             * and is picked up by the sweep that replaced us.
             */
            if (sweepGeneration !== this.eliminationSweepGeneration) {
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] elimination sweep generation ${sweepGeneration} was superseded mid-run - standing down with ${
                    bustedOrdered.length - i
                  } elimination(s) unassigned rather than writing places from a stale ladder`
                ),
                'Tournament.elimination_sweep_superseded'
              );
              return; // the finally block leaves the live sweep's lock alone
            }

            // Place 1 belongs to the winner and is never handed out here.
            let place = nextPosition;
            while (place >= 2 && takenPositions.has(place)) place--;

            if (place < 2) {
              // The ladder is already corrupt — every place from the seed down
              // to 2 is spoken for. Do NOT abandon the player: that is the
              // deadlock. Take the lowest place above the seed that is free.
              let up = nextPosition + 1;
              const ceiling = nextPosition + takenPositions.size + 2;
              while (up <= ceiling && takenPositions.has(up)) up++;
              if (up > ceiling) {
                reportError(
                  new Error(
                    `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: no finishing place free in [2, ${ceiling}] for ${bustedOrdered[i].user_id.slice(0, 8)} - cannot eliminate, tournament will not finish without intervention`
                  ),
                  'TournamentManager.no_free_finishing_place'
                );
                break;
              }
              place = up;
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] finishing ladder exhausted downward at seed ${nextPosition} - ${bustedOrdered[i].user_id.slice(0, 8)} placed at ${place} instead. Places already handed out are one or more too high; the event will still finish but the standings need renumbering.`
                ),
                'TournamentManager.finishing_ladder_exhausted'
              );
            }

            await this.eliminatePlayer(bustedOrdered[i].user_id, place);
            takenPositions.add(place);
            nextPosition = Math.min(nextPosition, place) - 1;
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
              `[Tournament:${this.tournamentId.slice(0, 8)}] remaining-player count unavailable (${remainingErr?.message ?? 'null count'}) - skipping finish check this cycle`
            ),
            'Tournament.remaining_count_unavailable'
          );
        } else if (remainingCount > 1) {
          // MYSTERY BOUNTY ACTIVATION (2026-08-25). This is the only place in
          // the engine that knows, between hands and from a count it has just
          // verified, how many players can still be knocked out — which is
          // both halves of the activation predicate and the size of the chest
          // inventory. Guarded on `> 1` so the phase can never open on the
          // heads-up hand that ends the event.
          try {
            await this.maybeActivateMysteryBounty(remainingCount);
          } catch (mbErr) {
            reportError(mbErr, 'Tournament.mystery_bounty_activation_sweep');
          }
        }

        if (
          !remainingErr &&
          remainingCount !== null &&
          remainingCount !== undefined &&
          remainingCount <= 1
        ) {
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
                  `[Tournament:${this.tournamentId.slice(0, 8)}] All busted simultaneously - last eliminated wins`
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

        // THE FREEZE IS TOTAL (Dan 2026-09-01/03; measured 2026-09-07). A
        // table-balance move is a seat closed on one felt and opened on
        // another with the same stack, and the break is the one time the
        // platform has promised that nothing moves. This sweep kept moving
        // players between parked tables inside the freeze (26 seats / 571k
        // chips in the 17:55 break alone), which is both a promise broken and
        // the whole of the freeze-conservation drift the scorecard kept
        // reporting: a move caught mid-way by the :00 mark counts the stack
        // twice or not at all. Nothing is lost by waiting five minutes; the
        // next sweep after the thaw balances exactly as this one would have.
        if (!isMaintenanceFrozen()) {
          await this.checkTableBalance();

          // FIX 155: Check if new tables need to be created during rebuy/late-reg period
          await this.checkDynamicTableExpansion();
        }

        // ── HAND-FOR-HAND BUBBLE MODE ──
        // Multi-table tournaments only (not Spin/SNG single-table)
        if (this.tableEngines.size > 1 && this.tournamentCache) {
          const isSpin =
            this.tournamentCache.variant === 'spin' ||
            this.tournamentCache.tournament_type === 'SPIN';
          if (!isSpin) {
            const { count: playingNow, error: playingNowErr } = await supabase
              .from('tournament_players')
              .select('*', { count: 'exact', head: true })
              .eq('tournament_id', this.tournamentId)
              .eq('status', 'playing');

            // PAYOUT-INTEGRITY 2026-08-25: the third `(count || 0)` in this
            // file, and the last one. On a failed count `|| 0` reads as zero
            // players remaining, which satisfies `playingNow <= payoutCount`
            // and BURSTS THE BUBBLE — hand-for-hand is cancelled and every
            // engine resumes dealing while the field is still one elimination
            // from the money. Hand-for-hand exists precisely so that a player
            // on a slow table is not busted into the bubble by a fast one; a
            // supabase timeout must not be able to switch it off. An
            // unreadable count is UNKNOWN: leave the bubble state exactly as
            // it is and re-check on the next sweep.
            if (playingNowErr || playingNow === null || playingNow === undefined) {
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] hand-for-hand: playing count unavailable (${playingNowErr?.message ?? 'null count'}) - bubble state left unchanged this cycle`
                ),
                'Tournament.hand_for_hand_count_unavailable'
              );
              return; // the finally block clears isProcessingEliminations
            }

            // PAYOUT-INTEGRITY 2026-08-28: the guard immediately above says a
            // count we could not read is UNKNOWN and must not read as zero.
            // This block said the opposite about the payout STRUCTURE, four
            // lines later: an unparseable column was caught and rewritten to
            // `[]`, which is payoutCount 0, which is "no paid places" - and it
            // did it silently, with no log and no alert.
            //
            // It is worse than not starting hand-for-hand. If the column
            // becomes unreadable while the bubble is ALREADY active, the burst
            // test is `playingNow <= payoutCount` -> `playingNow <= 0`, which a
            // live field never satisfies. Line 591 is the only exit from
            // hand-for-hand for a running tournament (the only other reset is
            // on engine restart), so the event plays every remaining hand in
            // lock-step, through the money, to the finish.
            //
            // It also disagreed with the code that pays. Every other site in
            // this file resolves the structure through payoutStructure.ts,
            // which rejects an array with no place 1 or percentages summing to
            // zero - "valid JSON" and "a usable structure" are different
            // questions. This counted the length of whatever parsed, so the
            // bubble could be defended at a place count the payout path would
            // never honour. One parser now, and it is the strict one.
            const paidPlaces = parsePayoutStructure(this.tournamentCache.payout_structure);
            if (this.tournamentCache.payout_structure != null && paidPlaces === null) {
              if (!this.payoutStructureUnreadableReported) {
                this.payoutStructureUnreadableReported = true;
                reportError(
                  new Error(
                    `[Tournament:${this.tournamentId.slice(0, 8)}] hand-for-hand: payout_structure is present but unusable - bubble state left unchanged`
                  ),
                  'Tournament.payout_structure_unusable'
                );
              }
              return; // the finally block clears isProcessingEliminations
            }
            const payoutCount = paidPlaces?.length ?? 0;

            if (payoutCount > 0 && playingNow === payoutCount + 1 && !this.handForHandActive) {
              this.handForHandActive = true;
              if (!this.handForHandAnnounced) {
                this.handForHandAnnounced = true;
                console.log(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] HAND-FOR-HAND - ${playingNow} players, ${payoutCount} paid`
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
            } else if (this.handForHandActive && playingNow <= payoutCount) {
              // Bubble burst — resume normal play
              this.handForHandActive = false;
              this.stopHandForHandSync();
              console.log(
                `[Tournament:${this.tournamentId.slice(0, 8)}] BUBBLE BURST - ${playingNow} players ITM`
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
        // Only the CURRENT holder may release the lock. A sweep that was
        // declared stuck, superseded and then finally settled must not free a
        // lock that a live sweep is now holding — doing so would let a third
        // sweep start alongside the second, which is the collision the
        // generation check exists to prevent.
        if (sweepGeneration === this.eliminationSweepGeneration) {
          this.isProcessingEliminations = false;
          this.eliminationSweepStartedAt = 0;
          this.eliminationSweepStuckReportedAt = 0;
          // Only the current holder decrements. A superseded sweep was already
          // released where its lock was forced, and decrementing twice would
          // walk the gauge negative - a metric that lies about the direction
          // of the load is worse than no metric.
          eliminationSweepsInflight.dec();
        }
        eliminationSweepMs.observe(Date.now() - sweepStartedAt);
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
  private async tryTournamentRebuys(
    bustedUserIds: string[]
  ): Promise<{ rebought: Set<string>; answered: Set<string> }> {
    const rebought = new Set<string>();
    /** Players whose rebuy decision is FINAL this pass: horses that were asked
     *  (the RPC either granted or refused). Everyone else — humans, and any
     *  horse the profile read could not identify — still holds an open
     *  decision window and gets the elimination grace below instead. */
    const answered = new Set<string>();
    const t = this.tournamentCache as
      | { is_rebuy?: boolean; rebuy_levels?: number | null; late_reg_levels?: number | null }
      | undefined;
    if (!t?.is_rebuy || bustedUserIds.length === 0) return { rebought, answered };

    // Cheap pre-check so a closed rebuy period costs no round trips at all.
    const cap = t.rebuy_levels ?? t.late_reg_levels ?? 0;
    if (cap > 0 && this.currentLevel > cap) return { rebought, answered };

    try {
      const { data: horseRows, error: horseErr } = await supabase
        .from('profiles')
        .select('id')
        .in('id', bustedUserIds)
        .eq('is_horse', true);
      if (horseErr || !horseRows || horseRows.length === 0) return { rebought, answered };

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
          answered.add(h.id);
          continue;
        }
        answered.add(h.id);
        if ((data as { success?: boolean } | null)?.success === true) rebought.add(h.id);
      }

      if (rebought.size > 0) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] ${rebought.size} rebuy(s) taken at level ${this.currentLevel}`
        );
      }
      if (declined.size > 0) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] rebuys declined - ` +
            [...declined.entries()].map(([m, n]) => `${m} x${n}`).join(', ')
        );
      }
    } catch (err) {
      reportError(err, 'Tournament.tournament_rebuy_threw');
    }
    return { rebought, answered };
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
  /**
   * The table this user is LIVE at inside this tournament, or null.
   *
   * BOUNTY-INTEGRITY 2026-08-27. Knockout attribution needs the table the
   * busted player was sitting at, and the only place that fact exists is the
   * seat row that `releaseTournamentSeat` is about to stamp `left_at` on. This
   * is deliberately a separate call made BEFORE the release rather than a
   * `left_at`-filtered query made after it — the latter is what has been
   * returning null on every knockout since 2026-08-24.
   */
  protected async tournamentTableForUser(userId: string): Promise<string | null> {
    try {
      const { data, error } = await supabase
        .from('table_seats')
        .select('table_id, tables!inner(tournament_id)')
        .eq('user_id', userId)
        .eq('tables.tournament_id', this.tournamentId)
        .is('left_at', null)
        .limit(1)
        .maybeSingle(); // FIX 168: Bible safety rule — maybeSingle over single
      if (error) {
        reportError(error, 'Tournament.knockout_table_lookup_failed');
        return null;
      }
      return (data as { table_id?: string } | null)?.table_id ?? null;
    } catch (err) {
      reportError(err, 'Tournament.knockout_table_lookup_threw');
      return null;
    }
  }

  /**
   * Fallback for a player whose seat was already released by some other path
   * (the recovery watchdog, an admin removal, a raced sweep): the most
   * recently vacated seat this user held at a table of THIS tournament.
   *
   * Scoped to the tournament for the same reason the live lookup is — an
   * unscoped seat query returns any open cash seat, which is how bounties were
   * routed to strangers before 2026-08-18.
   */
  protected async lastTournamentTableForUser(userId: string): Promise<string | null> {
    try {
      const { data, error } = await supabase
        .from('table_seats')
        .select('table_id, left_at, tables!inner(tournament_id)')
        .eq('user_id', userId)
        .eq('tables.tournament_id', this.tournamentId)
        .order('left_at', { ascending: false, nullsFirst: true })
        .limit(1);
      if (error) {
        reportError(error, 'Tournament.knockout_table_fallback_failed');
        return null;
      }
      return (data?.[0] as { table_id?: string } | undefined)?.table_id ?? null;
    } catch (err) {
      reportError(err, 'Tournament.knockout_table_fallback_threw');
      return null;
    }
  }

  protected async releaseTournamentSeat(userId: string): Promise<void> {
    try {
      const { data: tournamentTables, error: tablesErr } = await supabase
        .from('tables')
        .select('id')
        .eq('tournament_id', this.tournamentId);

      if (tablesErr) {
        console.error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] seat release: could not list tables - ${tablesErr.message}`
        );
        return;
      }

      const tournamentTableIds = (tournamentTables ?? []).map((t: { id: string }) => t.id);
      if (tournamentTableIds.length === 0) {
        console.warn(
          `[Tournament:${this.tournamentId.slice(0, 8)}] seat release: no tables carry this tournament_id - ${userId.slice(0, 8)} may still be seated`
        );
        return;
      }

      /* CHUNKED, like the sweep 1,000 lines above in this same class - which
         defines its own chunk for exactly this reason and is pinned by
         eliminationSweepReadsAreIndexed.law.test.ts ("bounds the IN list so a
         1,076-table field cannot build an unbounded query"). This write was
         not, so on the biggest fields the busted player's seat was never
         stamped left_at: a ghost holding the felt, and a seat-first counter
         that reads left_at IS NULL counting it forever. Reported through
         reportError now as well - console.error alone never reaches the
         reporter. */
      let seatErr: { message: string } | null = null;
      for (let i = 0; i < tournamentTableIds.length; i += IN_LIST_CHUNK) {
        const { error: e } = await supabase
          .from('table_seats')
          .update({ left_at: new Date().toISOString() })
          .eq('user_id', userId)
          .in('table_id', tournamentTableIds.slice(i, i + IN_LIST_CHUNK))
          .is('left_at', null);
        if (e) {
          seatErr = e;
          break;
        }
      }

      if (seatErr) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] seat release FAILED for ${userId.slice(0, 8)} - ${seatErr.message}`
          ),
          'Tournament.seat_release_failed'
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

    const { data: tournament, error: tournamentErr } = await supabase
      .from('tournaments')
      .select(
        // spin_multiplier + tournament_type: a Spin's payout split is a pure
        // function of its multiplier, so the spec can rebuild the structure
        // when the stored column is unreadable. See payoutStructure.ts.
        // bubble_protection + buy_in_amount (2026-08-22 parity): the stone
        // bubble's buy-in refund needs both.
        'payout_structure, prize_pool, is_bounty, is_pko, is_mystery_bounty, bounty_amount, mystery_bounty_min, mystery_bounty_max, variant, tournament_type, satellite_target_id, spin_multiplier, bubble_protection, buy_in_amount'
      )
      .eq('id', this.tournamentId)
      .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

    /**
     * PAYOUT-INTEGRITY 2026-08-25: THE PRIZE IS COMPUTED FROM THIS ROW, SO A
     * ROW WE COULD NOT READ IS NOT A PRIZE OF ZERO.
     *
     * The error was discarded and `if (tournament)` then skipped the prize
     * calculation entirely, so a single failed read stamped the player
     * `eliminated`, position N, prize 0 — and everything downstream treats
     * that as settled. The early-return guard at the top of this method sees
     * status 'eliminated' and returns, so the normal path never revisits it;
     * the bounty is skipped for the same reason (`hasBounty` reads flags off
     * the same null row) and bubble protection with it. Only the recovery
     * watchdog would ever top it up, and only while the tournament is
     * COMPLETING.
     *
     * Not stamping anything is strictly recoverable: the player still has 0
     * chips and the next 5s sweep busts them again with a readable row.
     */
    if (tournamentErr || !tournament) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] cannot price place ${position} for ${userId.slice(0, 8)} - tournament row unreadable (${tournamentErr?.message ?? 'no row'}). Eliminating nobody; the next sweep retries.`
        ),
        'Tournament.elimination_tournament_unreadable'
      );
      return;
    }

    let prize = 0;
    // TOURNEY-AUDIT 2026-07-24 (sweep 6): SATELLITES pay SEATS, not cash — the
    // award happens once at finishTournament (top finishers are registered
    // into the target tournament). Per-elimination cash would double-dip.
    /* EVERY SPELLING OF A SATELLITE, NOT JUST THE VARIANT (2026-09-03).
       This read `variant === 'satellite'` alone while the finish path 1,860
       lines below reads `variant === 'satellite' || tournament_type ===
       'SATELLITE'`. The two halves of the same rule disagreed, and the whole
       point of the flag is that they must not: place 2..N is priced as CASH
       here, and processSatelliteAwards pays the remainder there. A row the
       first half misses and the second half catches is paid twice.

       Nothing had been paid twice yet, and only by luck of a constant: the
       satellite heads-up added today carries HEADS_UP_PAYOUTS, which is 100%
       to place 1, so place 2 priced to exactly 0. A two-place structure on
       any satellite would have turned that into live money.

       satellite_target_id is the column that actually means "this pays a
       seat" - it is what fn_award_satellite_seat, fn_satellite_conservation_audit
       and fn_tournament_conservation_delta all key on - so it is included
       here as the third and most durable spelling. */
    const isSatellite =
      (tournament as any)?.variant === 'satellite' ||
      String((tournament as any)?.tournament_type ?? '').toUpperCase() === 'SATELLITE' ||
      !!(tournament as any)?.satellite_target_id;
    if (!isSatellite && tournament) {
      // resolvePayoutStructure parses the stored column and, for a Spin whose
      // column is missing or malformed, rebuilds it from the canonical spec.
      // Places 2..N are paid HERE, minutes before finishTournament reads the
      // same column again — so the two reads must agree, and a Spin that can
      // reconstruct its own split is how they are made to.
      // SHORT-FIELD RESIDUAL 2026-08-27: pay by a structure the field can
      // actually fill, so the leftover lands on a place somebody reached. The
      // second belt, on top of finalFieldSize's own two: never trim below the
      // place being priced right now. A field smaller than the position being
      // paid could only mean the count is wrong, and acting on it would
      // promote this player to residual holder and overpay them.
      const field = await this.finalFieldSize();
      const safeField = field !== undefined && field >= position ? field : undefined;
      const payouts = resolvePayoutStructure(tournament as any, safeField);
      if (payouts) {
        prize = computePlacePrize(Number(tournament.prize_pool || 0), payouts, position);
      }
    }

    // PAYOUT-INTEGRITY 2026-08-25: `{ count: 'exact' }` added. PostgREST only
    // returns a row count when the request asks for one, so `updateCount` was
    // ALWAYS null here and the `updateCount === 0` half of the guard below
    // could never fire — the "another process already eliminated them" case
    // was being caught by luck (the earlier status re-read) rather than by
    // this CAS. Asking for the count is what makes the guard the guard.
    const {
      error: updateErr,
      count: updateCount,
      status: updateStatus,
    } = await supabase
      .from('tournament_players')
      .update(
        {
          status: 'eliminated',
          position,
          prize,
          eliminated_at: new Date().toISOString(),
        },
        { count: 'exact' }
      )
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', userId)
      .eq('status', 'playing') // Only update if still playing (prevents double-processing)
      /**
       * A LANDED REBUY OUTRANKS A STALE BUST SNAPSHOT (Dan, 2026-08-30).
       *
       * The bust list is read at the top of the sweep; process_tournament_rebuy
       * can land between that read and this write. It did, live, in the
       * restarted Sunday $200: rebuy debit 21:13:57.405, this UPDATE
       * 21:13:57.911 — the player paid 200, was granted 30,000 chips, and was
       * eliminated and unseated half a second later off the pre-rebuy
       * snapshot. Status alone cannot catch it (a rebuy leaves status
       * 'playing'); the chips CAN: a rebought player is no longer at zero, so
       * this CAS misses, updateCount is 0, and the sweep moves on.
       */
      .lte('chips', 0);

    if (updateErr) {
      // A DB error and "somebody else got there first" were both returned
      // silently, so an elimination that FAILED looked identical to one that
      // was already done — and this is the write that decides whether a prize
      // is ever paid for this place. Report the failure; the next sweep sees
      // the player still 'playing' with 0 chips and retries.
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] elimination write FAILED for ${userId.slice(0, 8)} at place ${position} (http ${updateStatus}): ${updateErr.message} - place unassigned, prize ${prize} unpaid`
        ),
        'Tournament.elimination_write_failed'
      );
      return;
    }
    if (updateCount !== null && updateCount === 0) {
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
       write commits.

       BOUNTY-INTEGRITY 2026-08-27: but READ THE SEAT FIRST. Moving the release
       up here (2026-08-23) silently killed every bounty on the platform. The
       bounty block below finds the knocker by looking up the busted player's
       table with `.is('left_at', null)` — and this call has just stamped
       `left_at` on that exact row, so the lookup returned null on every single
       knockout from 2026-08-24 onward. `knockerId` stayed null, the warn at
       the bottom of the bounty block fired instead, and 100% of every bounty
       pool was swept to the champion by fn_finalize_bounty_pool. Production
       confirms it: `tournament_bounties` has 0 rows since 2026-08-25 and
       `tournament_bounty_awards` has never had one.

       The seat still gets released here — that part was right. The table id is
       simply captured before it goes, so attribution survives the release. */
    const bustedTableId = await this.tournamentTableForUser(userId);

    await this.releaseTournamentSeat(userId);

    if (prize > 0) {
      // ONE SETTLE PATH (chip standard 3.2 step 5, 2026-09-02). This used to
      // be a 3x retry loop around `fn_credit_and_log` keyed
      // `tourney:{id}:prize:place:{position}` - place-scoped since 2026-08-28,
      // when Union PKO Afternoon (PLO4) 4f42d847 paid `position 2` twice to two
      // players and disbursed 720.00 against a 600.00 pool. The place-scoping
      // survives, but it now lives in the database: `tournament_obligations`
      // is UNIQUE on (tournament, 'place', N), the RPC pays only what that row
      // has not paid yet, and the recovery watchdog settles the same row. The
      // helper carries the transport retry (3 attempts, same back-off) and
      // never retries a refusal.
      const settled = await settleTournamentObligation(supabase, {
        tournamentId: this.tournamentId,
        kind: 'place',
        place: position,
        userId,
        amount: prize,
        source: 'engine.eliminatePlayer',
        memo: `Tournament prize: position ${position}`,
      });
      // A refusal (escrow short) has already raised its own critical alert in
      // the helper; the alert below is for the database never answering.
      if (!settled.ok && settled.refused_reason === TRANSPORT_REFUSAL) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Prize credit FAILED after 3 retries for ${userId.slice(0, 8)} - ${prize} chips lost`
          ),
          'TournamentthistournamentIdslic.CRITICAL'
        );
        /**
         * AND ESCALATE IT AS MONEY (2026-08-31).
         *
         * This was a Sentry report and nothing else. `raiseFinancialAlert`
         * exists precisely for "chips were owed and did not move", and every
         * one of its callers was a CASH settlement path — no tournament payout
         * path raised one, so a failed prize sat in an error tracker with the
         * stack traces rather than in the financial alerts queue with the
         * other money incidents.
         *
         * Awaited: the alert must be on disk before this process can be
         * recycled, which is the whole point of it for a payout.
         */
        await raiseFinancialAlert(
          'critical',
          'Tournament.prize_credit_failed',
          `Prize credit failed after 3 retries - ${prize} chips owed to ${userId} for place ${position} were never paid`,
          {
            tournament_id: this.tournamentId,
            user_id: userId,
            place: position,
            prize,
            obligation: { kind: 'place', place: position },
            transport_error: settled.transport_error ?? null,
          }
        );
      }
    }

    // ── BUBBLE PROTECTION (2026-08-22 parity) ──
    // The stone bubble — eliminated exactly one place before the money — gets
    // their buy-in back when the tournament opted in. Positions are distinct
    // by construction (see the basePosition notes above), so exactly one
    // player can ever hold paidPlaces + 1; the in-memory flag and the
    // per-user idempotency key are belt and braces on top of that.
    if (
      !isSatellite &&
      tournament &&
      (tournament as any).bubble_protection === true &&
      prize <= 0
    ) {
      try {
        // The same trimmed structure the prize above was priced from, so the
        // bubble is the place after the last place that can actually be paid.
        // In a field smaller than the structure everybody is already in the
        // money, there is no bubble, and this correctly never fires.
        const bubbleField = await this.finalFieldSize();
        const payouts = resolvePayoutStructure(
          tournament as any,
          bubbleField !== undefined && bubbleField >= position ? bubbleField : undefined
        );
        const paidPlaces = Array.isArray(payouts) ? payouts.length : 0;
        const refund = Math.max(0, Number((tournament as any).buy_in_amount || 0));
        if (
          !this.bubbleProtectionPaid &&
          paidPlaces > 0 &&
          position === paidPlaces + 1 &&
          refund > 0
        ) {
          // ONE SETTLE PATH (2026-09-02): a user-keyed obligation of kind
          // 'bubble_protection' - UNIQUE on (tournament, kind, user), so the
          // per-user dedupe the old `bubbleprotection:{user}` key gave is now
          // a database constraint rather than a string.
          const bp = await settleTournamentObligation(supabase, {
            tournamentId: this.tournamentId,
            kind: 'bubble_protection',
            userId,
            amount: refund,
            source: 'engine.eliminatePlayer',
            memo: `Bubble protection: buy-in returned (bubbled at position ${position})`,
          });
          if (!bp.ok) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Bubble protection credit FAILED for ${userId.slice(0, 8)}: ${bp.refused_reason}${bp.transport_error ? ` (${bp.transport_error})` : ''}`
              ),
              'Tournament.bubble_protection_credit_failed'
            );
          }
          if (bp.fully_settled === true) {
            this.bubbleProtectionPaid = true;
            await this.broadcast('bubble_protection_paid', {
              userId,
              position,
              amount: refund,
            });
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] BUBBLE PROTECTION: ${userId.slice(0, 8)} refunded ${refund} at position ${position}`
            );
          } else {
            await this.broadcast('bubble_protection_pending', {
              userId,
              position,
              amount: refund,
              paid: bp.paid,
              alreadyPaid: bp.already_paid,
              remaining: bp.remaining ?? null,
              obligationId: bp.obligation_id,
            });
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
        //
        // BOUNTY-INTEGRITY 2026-08-27: `bustedTableId` was captured ABOVE, before
        // releaseTournamentSeat() stamped `left_at`. The inline query that used
        // to live here filtered on `left_at IS NULL` and therefore always
        // returned null once the release moved ahead of it. The fallback below
        // reads the most recently vacated tournament seat, so a player released
        // by some other path (recovery, admin removal, a raced sweep) still gets
        // their knockout attributed instead of silently skipped.
        const knockoutTableId = bustedTableId ?? (await this.lastTournamentTableForUser(userId));

        // Find the busted player's LAST HAND at that table to determine the knocker.
        // TOURNEY-AUDIT 2026-07-24: (a) The old query took the most recent hand
        // at the table regardless of whether the eliminated player was even IN
        // it — the 5s elimination sweep can lag several hands, so bounties
        // routed to the winner of some later, unrelated pot. The recent hands
        // are scanned for the last one the busted player played.
        //
        // KNOCKOUT ATTRIBUTION 2026-08-25 (Dan section 29). (b) used to say
        // "the knocker is the winner who took the LARGEST amount (the main pot
        // containing the busted player's chips)". Those two things are not the
        // same thing, and the parenthesis was the bug: with a side pot, the
        // largest winner is usually the player who was NOT in the pot that
        // busted anybody. The credit belongs to the winner(s) of the pot that
        // contained the eliminated player's final chips, which is now a
        // recorded fact (`hand_history.pots`) rather than a guess about
        // amounts. See knockoutAttribution.ts for the full rule; it falls back
        // to the old heuristic on rows written before the column existed.
        let knockerId: string | null = null;
        // SPLIT KNOCKOUTS (Dan sections 27/28). A tied pot means every tied
        // winner shares one chest, equally.
        let claimants: Array<{ userId: string; weight: number }> = [];
        /**
         * The hand the knockout happened in. Stream B's reserve call has been
         * passing `p_hand_id: null` since it shipped, so `tournament_bounty_
         * awards.hand_id` — the only link between an award and the hand that
         * earned it — was empty on every row. Nothing could audit a bounty
         * back to its knockout. It is available right here and simply was not
         * being selected.
         */
        let knockoutHandId: string | null = null;
        if (knockoutTableId) {
          const { data: recentHands } = await supabase
            .from('hand_history')
            .select('id, winners, players, pots')
            .eq('table_id', knockoutTableId)
            .order('created_at', { ascending: false })
            .limit(10);

          for (const hand of recentHands ?? []) {
            const inHand =
              Array.isArray(hand.players) &&
              hand.players.some((p: any) => (p.userId || p.user_id) === userId);
            if (!inHand) continue;
            knockoutHandId = hand.id ? String(hand.id) : null;
            const attribution = attributeKnockout(hand as any, userId);
            knockerId = attribution.knockerUserId;
            claimants = attribution.claimants.map((c) => ({ ...c }));
            if (attribution.basis === 'largest_winner' && Array.isArray(hand.pots)) {
              // Pots were stored and still could not settle the question. Not
              // fatal — the fallback pays somebody — but it means the recorded
              // breakdown disagrees with the recorded winners, which is worth
              // a signal rather than a silent shrug.
              console.warn(
                `[Tournament:${this.tournamentId.slice(0, 8)}] knockout attribution fell back to ` +
                  `largest-winner for ${userId.slice(0, 8)} despite stored pots (hand ${knockoutHandId})`
              );
            }
            break; // only the busted player's most recent hand counts
          }
        }

        if (knockerId) {
          await this.processBountyCollection(
            tournament,
            userId,
            knockerId,
            knockoutTableId,
            claimants,
            knockoutHandId
          );
        } else {
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Could not determine knocker for ${userId.slice(0, 8)} - bounty skipped`
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
    tableId: string | null = null,
    /**
     * Everyone with a claim on this knockout and the weight of that claim.
     * Sections 27/28: the winners of the pot that held the busted player's
     * last chips, equally weighted when that pot was tied. Empty (or a single
     * entry) is the ordinary case: one knocker takes the whole bounty.
     */
    claimants: Array<{ userId: string; weight: number }> = [],
    /** The hand_history row this knockout happened in, for the audit link. */
    handId: string | null = null
  ): Promise<void> {
    // ── MYSTERY PHASE ──────────────────────────────────────────────────────
    // Once the chests are open, this knockout draws one. fn_collect_bounty
    // refuses in that state ('mystery_phase_active'), so this is not an
    // optimisation — it is the only path that pays.
    if (this.mysteryBountyStage === 'active' && tournament?.is_mystery_bounty) {
      await this.processMysteryBountyKnockout(
        eliminatedUserId,
        knockerUserId,
        tableId,
        claimants,
        handId
      );
      return;
    }

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
    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  A SPLIT POT SHARES THE CHEST BUT NOT THE BOUNTY (2026-08-29)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `claimants` carries everyone with a claim on this knockout and the
     * weight of that claim -- the winners of the pot that held the busted
     * player's last chips, equally weighted when that pot was tied. The
     * mystery path honours it (buildRecipientClaims splits the chest by
     * weight). This path does not: `fn_collect_bounty` takes ONE
     * `p_collector_user_id`, so on a tied pot one of the tied winners takes
     * the whole head -- the cash bounty AND, in a PKO, the half that
     * accumulates onto their own head -- and the other takes nothing.
     *
     * It is NOT fixed here, deliberately. Splitting a PKO head is not
     * arithmetic, it is a rule: whether each winner takes half the cash and
     * half the head increment, or the head passes whole to one of them, is a
     * decision about how the game plays and it belongs to Dan. Improvising it
     * inside a money RPC would be the same mistake as inventing the
     * horses-earn-nothing rule.
     *
     * What IS fixed is that it was silent. A tied pot on a bounty event now
     * says so, with the players and the weights, so the frequency is
     * measurable and the ruling can be made against real numbers instead of a
     * guess.
     */
    /* RULING MADE (2026-08-31, zero-drift phase 5): a tied pot splits the
       bounty BY CLAIM WEIGHT - cents, largest remainder, shares always sum to
       the payable bounty exactly; in a PKO each winner's share halves onto
       their own head as usual. fn_collect_bounty now takes the claimant list
       and does the split in one idempotent transaction; a single (or empty)
       list is byte-for-byte the old single-collector behaviour. The comment
       block above records why this waited for a ruling. */
    if (claimants.length > 1) {
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Split-pot knockout: ${claimants.length} winners share the bounty for ${eliminatedUserId.slice(0, 8)} by weight (${claimants
          .map((c) => `${c.userId.slice(0, 8)}:${c.weight}`)
          .join(', ')})`
      );
    }

    const { data: result, error } = await supabase.rpc('fn_collect_bounty', {
      p_tournament_id: this.tournamentId,
      p_eliminated_user_id: eliminatedUserId,
      p_collector_user_id: knockerUserId,
      p_claimants: claimants.map((c) => ({ user_id: c.userId, weight: c.weight })),
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
      /** True when a tied pot split this head between several winners. */
      split?: boolean;
      /** One entry per winner of the pot: what they were paid and, in a PKO,
       *  what went onto their own head. Sums to paid_cash / added_to_head. */
      shares?: Array<{ user_id: string; cash: number; to_head: number }>;
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
    // `eliminatedAvatar` used to ride along here (one `profiles` query per
    // knockout) for the full-screen KnockoutAnimation's falling head. That
    // overlay was deleted on 2026-08-28; the seat knockout that replaced it
    // draws on the busted player's own chair and never reads an avatar URL.
    // Removed 2026-09-04 (knockout audit): a query per knockout for a field
    // nothing consumes.
    try {
      /* Every winner of the pot gets a name, not just the first. On a tied pot
         `fn_collect_bounty` splits the head by claim weight and reports each
         winner's share; the client draws one bounty stream per winner, so it
         needs each one's name for the feed line and the accessibility label. */
      const shareRows = Array.isArray(res.shares) ? res.shares : [];
      const nameIds = Array.from(
        new Set<string>([
          eliminatedUserId,
          knockerUserId,
          ...shareRows.map((s) => String(s.user_id || '')).filter(Boolean),
        ])
      );
      const { data: names } = await supabase
        .from('tournament_players')
        .select('user_id, username')
        .eq('tournament_id', this.tournamentId)
        .in('user_id', nameIds);
      const nameOf = (id: string) =>
        (names || []).find((n: any) => n.user_id === id)?.username || 'Player';

      /* ── THE SHARES, ON THE WIRE (knockout audit 2026-09-04) ───────────────
         The 2026-08-31 split-pot ruling made the MONEY right — a tied pot pays
         each winner their weighted share and halves each share onto its own
         head in a PKO — but this broadcast kept sending the TOTAL under ONE
         `knockerUserId`. TablePage therefore flew the whole bounty to one of
         the two winners and showed the other nothing; in a PKO it also added
         the whole `addedToHead` to one head badge. Measured against
         production: 55 split knockouts between 08-30 and 09-04, every one
         animated for the wrong amount at one seat and not at all at the other.

         `shares` carries one row per winner. `amount`, `addedToHead`,
         `knockerUserId` and `knockerName` are UNCHANGED for the single-winner
         case and stay on the wire for it, so an older bundle that never reads
         `shares` behaves exactly as before. */
      const shares =
        shareRows.length > 1
          ? shareRows.map((s) => ({
              userId: String(s.user_id),
              name: nameOf(String(s.user_id)),
              amount: Number(s.cash) || 0,
              addedToHead: Number(s.to_head) || 0,
            }))
          : undefined;

      // NOTE: When an event is both PKO and mystery, `fn_collect_bounty` returns
      // 'pko'. In that case `res.paid_cash` is half a head, so ranking it against
      // the mystery ladder would report a rung nobody pulled.
      //
      // RESOLVED — Dan 2026-08-26, verbatim: "no, never pko+mystery bounty
      // ever." The hybrid is now IMPOSSIBLE to configure: the DB constraint
      // `tournaments_never_pko_and_mystery` (migration 20260826210000,
      // applied and probe-verified) refuses any row carrying both flags.
      // This branch is therefore defense-in-depth for a state the schema
      // forbids, and a PKO knockout correctly gets no mystery prize rank.
      const prizeRank = isMysteryCollectMode(res.mode)
        ? await this.preMysteryPrizeRank(res.paid_cash)
        : undefined;

      // ── THE EVENT NAME IS A CONSTANT, AND THAT IS THE FIX ────────────────
      //
      // This used to read:
      //
      //     res.mode === 'mystery' ? 'mystery_bounty_revealed' : 'bounty_collected'
      //
      // `fn_collect_bounty` never returns 'mystery' — it returns 'pko',
      // 'mystery_pre' or 'regular' (see mysteryPrizeLadder.ts, which quotes the
      // live CASE). So the ternary was dead in both directions, and worse: had
      // it ever fired it would have sent the CHEST event under a payload the
      // chest cannot read. `mystery_bounty_revealed` belongs to
      // settleMysteryBountyAward below and carries awardId / amountCents /
      // tier / recipients; TablePage feeds it straight into the chest queue and
      // useMysteryBounty refetches the mystery RPCs on it. A pre-phase knockout
      // has no award and no chest, so borrowing that name would have played a
      // full-screen reveal for a chest that does not exist.
      //
      // The celebration banner accepts `bounty_collected` and gates on the mode
      // — which is why it works at all today — so this name is the correct one
      // and the only one this path may send.
      await this.broadcast('bounty_collected', {
        mode: res.mode,
        amount: res.paid_cash,
        // THE RANK, FROM THE SERVER (Dan 2026-08-25). Which rung of this
        // event's prize ladder was just pulled, 1 being the largest. Only a
        // mystery pull gets one: on a pko knockout `paid_cash` is half the
        // head, and half a head has no rung. Undefined drops off the wire,
        // and the client falls back to deriving it, exactly as it does today.
        prizeRank,
        addedToHead: res.added_to_head,
        // playerName = whose head was revealed/claimed
        playerName: nameOf(eliminatedUserId),
        eliminatedName: nameOf(eliminatedUserId),
        eliminatedUserId,
        knockerName: nameOf(knockerUserId),
        knockerUserId,
        // Present ONLY on a split knockout (two or more winners of the pot).
        // Undefined drops off the wire for the ordinary single-winner case.
        shares,
        avgBounty: tournament?.bounty_amount || undefined,
        poolRemaining: res.pool_remaining,
        // Which table this happened at — see the tableId parameter.
        tableId,
      });

      // NO DEAL HOLD ON THIS PATH, DELIBERATELY (corrected 2026-08-26).
      //
      // A `holdDealingUntil(now + mysteryChestHoldMs())` used to sit here under
      // `res.mode === 'mystery'`. Like the event name above, that test could
      // never be true, so the hold never ran — and reviving it for the real
      // value ('mystery_pre') would have been the wrong fix twice over:
      //
      //   - the hold exists so a table does not deal a hand under a live CHEST
      //     sequence, and there is no chest before the mystery phase opens.
      //     Pausing every mystery event's tables for the length of an animation
      //     that never plays is a stall, not a fix;
      //   - the chest path already holds correctly and by a better mechanism.
      //     openBountyGate() calls beginBountyReveal() (a COUNT-based gate, so
      //     three chests in one hand hold for all three) plus holdDealingUntil()
      //     as the wall-clock failsafe. See ServerTableEngineBase's note on why
      //     a deadline alone is wrong here.
    } catch {
      /* the reveal broadcast is cosmetic — never block the payout path */
    }

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] BOUNTY (${res.mode}): ${knockerUserId.slice(0, 8)} collected ${res.paid_cash} from ${eliminatedUserId.slice(0, 8)}${res.added_to_head ? ` (+${res.added_to_head} to own head)` : ''}`
    );
  }

  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  MYSTERY BOUNTY KNOCKOUT — reserve, hold the deal, reveal, pay
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Four steps, in this order, and the order is the point.
   *
   * 1. RESERVE. `fn_mystery_bounty_reserve` takes the next chest atomically
   *    and writes the award and the recipient split. It deliberately does NOT
   *    return the amount: the surest way to keep a number out of a broadcast
   *    is for the code that builds the broadcast never to have seen it
   *    (section 19).
   *
   * 2. HOLD THE DEAL. The chest owns the screen for the length of its
   *    sequence, so the table must not deal a hand underneath it. Same
   *    mechanism the spin wheel uses, and only the knockout's own table
   *    pauses — a bustout on table 3 must not stall tables 1 and 2.
   *
   * 3. REVEAL, on a timer. The winner's client opens the chest at
   *    CHEST_AUTO_OPEN_MS whether they tap or not. A tap before then calls
   *    `fn_mystery_bounty_reveal` from the browser and shows THEM the number
   *    first, which is the whole reason there is a tap; the engine's call
   *    below is idempotent and returns the identical payload, so the private
   *    reveal and the table broadcast can never disagree.
   *
   * 4. PAY. Only after the reveal, and only through `fn_mystery_bounty_pay`,
   *    which credits every recipient through `fn_credit_and_log` under the key
   *    `mb:{award}:{user}` and moves `bounty_pool_paid`.
   *
   * NOTHING HERE THROWS INTO THE ELIMINATION SWEEP. A reveal that fails to
   * broadcast is a knockout with no animation; a reserve that throws would
   * stop the sweep processing every other bustout in the event.
   */
  protected async processMysteryBountyKnockout(
    eliminatedUserId: string,
    knockerUserId: string,
    tableId: string | null,
    claimants: Array<{ userId: string; weight: number }>,
    handId: string | null = null
  ): Promise<void> {
    const recipients = buildRecipientClaims(knockerUserId, claimants);
    if (recipients.length === 0) return;

    // op_id makes THIS call idempotent; the award's unique
    // (tournament, eliminated) key makes the whole knockout idempotent. The
    // op id is derived from the knockout rather than random so that a retry of
    // the same sweep pass presents the same id.
    const opId = nodeCrypto
      .createHash('sha256')
      .update(`mb:${this.tournamentId}:${eliminatedUserId}`)
      .digest('hex');
    const opUuid = [
      opId.slice(0, 8),
      opId.slice(8, 12),
      // Version 4 nibble and variant bits, so the value is a legal UUID and
      // Postgres accepts it. It is a name, not entropy — the entropy that
      // matters was spent on the inventory shuffle.
      '4' + opId.slice(13, 16),
      ((parseInt(opId.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + opId.slice(17, 20),
      opId.slice(20, 32),
    ].join('-');

    const { data: reserved, error: reserveErr } = await supabase.rpc('fn_mystery_bounty_reserve', {
      p_tournament_id: this.tournamentId,
      p_eliminated_user_id: eliminatedUserId,
      p_recipients: recipients,
      p_table_id: tableId,
      // AUDIT LINK 2026-08-25: this was hard-coded null, so
      // `tournament_bounty_awards.hand_id` — the only pointer from an award
      // back to the hand that earned it — was empty on every row ever
      // written. The eliminations sweep reads that hand three lines earlier;
      // it simply was not being selected or passed.
      p_hand_id: handId,
      p_op_id: opUuid,
      p_reveal_ms: MYSTERY_BOUNTY_REVEAL_DELAY_MS,
    });

    if (reserveErr) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: mystery bounty reserve FAILED for ${eliminatedUserId.slice(0, 8)}: ${reserveErr.message}`
        ),
        'Tournament.mystery_bounty_reserve_failed'
      );
      return;
    }

    const res = (reserved ?? {}) as {
      ok?: boolean;
      reason?: string;
      already?: boolean;
      status?: string;
      award_id?: string;
      queue_index?: number;
      queue_total?: number;
      designated_revealer?: string;
      recipient_user_ids?: string[];
    };

    if (!res.ok || !res.award_id) {
      if (res.reason === 'inventory_exhausted') {
        // Every chest is spoken for and a player was still knocked out. That
        // is a real accounting event, not a hiccup: the inventory is sized to
        // the field at activation, so it means more knockouts happened than
        // there were players.
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] mystery bounty INVENTORY EXHAUSTED at knockout of ${eliminatedUserId.slice(0, 8)}`
          ),
          'Tournament.mystery_bounty_inventory_exhausted'
        );
      } else if (res.reason !== 'mystery_phase_not_active') {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] mystery bounty not reserved (${res.reason}) for ${eliminatedUserId.slice(0, 8)}`
          ),
          'Tournament.mystery_bounty_not_reserved'
        );
      }
      return;
    }

    // Already completed on an earlier pass — nothing to re-announce.
    if (res.already && res.status === 'completed') return;

    // 2, 3 and 4 are the queue's job from here. Enqueueing CLOSES THE TABLE'S
    // REVEAL GATE IMMEDIATELY (sections 21-26): the table stops before the
    // first chest is even on screen, so a second knockout discovered a moment
    // later cannot find that a hand has already been dealt over it.
    this.enqueueBountyReveal({
      awardId: res.award_id,
      tableId,
      eliminatedUserId,
      designatedRevealer: res.designated_revealer ?? knockerUserId,
      recipientUserIds: res.recipient_user_ids ?? [],
    });
  }

  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  THE TABLE'S REVEAL QUEUE (Dan sections 21-26, 51-57, 61-65)
   * ═════════════════════════════════════════════════════════════════════════
   *
   * ONE CHEST AT A TIME, PER TABLE, IN ORDER.
   *
   * Three knockouts in one hand are three chests, shown as "MYSTERY BOUNTY
   * 1 OF 3", then 2 of 3, then 3 of 3 — and the dealer button may not move
   * until the last of them is finished (sections 25 and 64).
   *
   * WHAT THIS REPLACES. The reserve path used to fire a bare
   * `setTimeout(..., 9700)` per award. Three simultaneous knockouts therefore
   * revealed three chests AT THE SAME INSTANT, on top of each other, each
   * labelled with a queue counter the SQL had computed independently — the
   * first one reserved says "1 of 1", the second "2 of 2", the third "3 of 3",
   * because `fn_mystery_bounty_reserve` counts what is open at the moment IT
   * runs and cannot know about the two knockouts the sweep has not reached
   * yet. Right numbers to a question nobody asked.
   *
   * The counter is therefore computed HERE, where the whole burst is visible,
   * after a short coalescing window (MYSTERY_BOUNTY_QUEUE_COALESCE_MS). The
   * queue is keyed by table because section 22 and section 61 are explicit
   * that only the affected table pauses: the tournament clock, the blind-level
   * clock and every other table keep running, and they do not consult this.
   *
   * IDEMPOTENCE. `dispatchedBountyAwards` means a re-swept elimination (which
   * `fn_mystery_bounty_reserve` answers with the SAME award id) cannot enqueue
   * the same chest twice — section 80/33: a duplicate event cannot double-pay.
   */
  private enqueueBountyReveal(item: {
    awardId: string;
    tableId: string | null;
    eliminatedUserId: string;
    designatedRevealer: string;
    recipientUserIds: string[];
  }): void {
    if (this.dispatchedBountyAwards.has(item.awardId)) return;
    this.dispatchedBountyAwards.add(item.awardId);

    const key = item.tableId ?? '';
    let q = this.bountyRevealQueues.get(key);
    if (!q) {
      q = { waiting: [], active: null, presented: 0, coalesceTimer: null };
      this.bountyRevealQueues.set(key, q);
    }
    q.waiting.push(item);

    // CLOSE THE GATE NOW, not at presentation. The award exists and the money
    // is reserved; the table must not deal another hand in the seconds between
    // the reserve and the chest appearing.
    //
    // The deadline is a failsafe only — the gate is normally closed by
    // `finishBountyReveal` — so it is sized for this award's worst case: it
    // may have to wait out every chest queued ahead of it.
    const depth = q.waiting.length + (q.active ? 1 : 0);
    this.openBountyGate(
      item.tableId,
      item.awardId,
      Date.now() + MYSTERY_BOUNTY_QUEUE_COALESCE_MS + depth * mysteryChestHoldMs() + 15000
    );

    if (!q.active && !q.coalesceTimer) {
      q.coalesceTimer = setTimeout(() => {
        const live = this.bountyRevealQueues.get(key);
        if (live) live.coalesceTimer = null;
        void this.pumpBountyRevealQueue(key);
      }, MYSTERY_BOUNTY_QUEUE_COALESCE_MS);
      // A queue timer must never keep the process alive on its own.
      (q.coalesceTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /** Close the table's dealing gate for one award. Never throws. */
  private openBountyGate(tableId: string | null, awardId: string, deadlineMs: number): void {
    if (!tableId) return;
    const engine = this.tableEngines.get(tableId);
    if (!engine) return;
    try {
      engine.beginBountyReveal(awardId, deadlineMs);
      // The time-based hold as well, belt and braces: an older engine build
      // that predates the gate still stops on this one, and it is what the
      // spin wheel already uses so the two cannot fight.
      engine.holdDealingUntil(deadlineMs);
    } catch {
      /* the hold is presentation; never let it break the payout path */
    }
  }

  /** Re-open the table's dealing gate. */
  private closeBountyGate(tableId: string | null, awardId: string): void {
    if (!tableId) return;
    const engine = this.tableEngines.get(tableId);
    if (!engine) return;
    try {
      engine.endBountyReveal(awardId);
    } catch {
      /* nothing to release */
    }
  }

  /**
   * Put the next chest on screen, or declare the table's queue empty.
   *
   * Nothing in here is allowed to throw: it runs detached from the elimination
   * sweep (deliberately — the sweep must not sit for seventeen seconds holding
   * `isProcessingEliminations` while an animation plays, or every other bustout
   * in the event waits behind it), so an unhandled rejection here would be an
   * unhandled rejection in the engine process.
   */
  protected async pumpBountyRevealQueue(key: string): Promise<void> {
    const q = this.bountyRevealQueues.get(key);
    if (!q || q.active) return;

    const next = q.waiting.shift();
    if (!next) {
      // SECTION 63: the queue is empty, the overlay may clear, the button may
      // move, the next hand may deal. The gate is already open by now (each
      // award released its own on completion); this event is what tells the
      // clients the sequence is over.
      this.bountyRevealQueues.delete(key);
      q.presented = 0;
      try {
        await this.broadcast('mystery_bounty_complete', { tableId: key || null });
      } catch {
        /* the all-clear is cosmetic; the gate has already re-opened */
      }
      return;
    }

    q.active = next;
    q.presented += 1;
    const queueIndex = q.presented;
    const queueTotal = q.presented + q.waiting.length;

    // Re-arm this award's own failsafe from the moment it actually starts, so
    // a chest that waited a long time behind others still gets a full window.
    this.openBountyGate(
      next.tableId,
      next.awardId,
      Date.now() + mysteryChestHoldMs() + mysteryChestPostRevealMs()
    );

    // The pending broadcast. NO AMOUNT (section 19) — the number does not
    // leave the database until the chest is opened.
    try {
      const names = await this.resolveBountyNames([next.eliminatedUserId, next.designatedRevealer]);
      await this.broadcast('mystery_bounty_pending', {
        tableId: next.tableId,
        awardId: next.awardId,
        recipientUserIds: next.recipientUserIds,
        designatedRevealer: next.designatedRevealer,
        designatedRevealerName: names(next.designatedRevealer),
        eliminatedUserId: next.eliminatedUserId,
        eliminatedName: names(next.eliminatedUserId),
        queueIndex,
        queueTotal,
        deadlineMs: MYSTERY_BOUNTY_REVEAL_DELAY_MS,
      });
    } catch (err) {
      reportError(err, 'Tournament.mystery_bounty_pending_broadcast_failed');
    }

    // The reveal, on the deadline. The designated revealer's own tap normally
    // gets there first (from the browser, which is the drama); this call is
    // idempotent and returns the identical payload, so section 54's "auto
    // reveal so a table can never wedge" costs nothing when they did tap and
    // saves the table when they did not.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await this.settleMysteryBountyAward(
            next.awardId,
            next.tableId,
            next.eliminatedUserId,
            queueIndex,
            queueTotal
          );
        } catch (err) {
          reportError(err, 'Tournament.mystery_bounty_settle_threw');
        } finally {
          this.finishBountyReveal(key, next);
        }
      })();
    }, MYSTERY_BOUNTY_REVEAL_DELAY_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * One chest is done. Let its animation finish, THEN release the table and
   * start the next one.
   *
   * Section 63, in order: reveal, animation done, UI clears, button moves,
   * next hand. The reveal broadcast has just gone out; the clients are only
   * now playing the lid, the explosion and the count-up. Releasing the gate on
   * the broadcast would deal the next hand underneath all of that.
   */
  private finishBountyReveal(key: string, item: { awardId: string; tableId: string | null }): void {
    const settle = setTimeout(() => {
      this.closeBountyGate(item.tableId, item.awardId);
      const q = this.bountyRevealQueues.get(key);
      if (q && q.active?.awardId === item.awardId) q.active = null;
      void this.pumpBountyRevealQueue(key);
    }, mysteryChestPostRevealMs());
    (settle as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Usernames for a knockout, as one lookup.
   *
   * The chest names both players ("Alice Eliminated Bob"), and the pending
   * broadcast is the only chance to supply them — the reveal payload from
   * `fn_mystery_bounty_reveal` carries ids and money, deliberately, because it
   * is a money function. Failure returns 'Player' for everyone rather than
   * throwing: a nameless chest is a cosmetic loss, a thrown lookup is a
   * knockout with no bounty.
   */
  protected async resolveBountyNames(
    userIds: Array<string | null | undefined>
  ): Promise<(id: string) => string> {
    const ids = Array.from(new Set(userIds.filter((u): u is string => !!u)));
    if (ids.length === 0) return () => 'Player';
    try {
      const { data } = await supabase
        .from('tournament_players')
        .select('user_id, username')
        .eq('tournament_id', this.tournamentId)
        .in('user_id', ids);
      const map = new Map<string, string>(
        (data ?? []).map((r: any) => [String(r.user_id), String(r.username || 'Player')])
      );
      return (id: string) => map.get(id) || 'Player';
    } catch {
      return () => 'Player';
    }
  }

  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  HOW BIG WAS THAT, COMPARED TO EVERYTHING ELSE IN THE EVENT
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Two ladders, because a mystery event has two prize pools in sequence and
   * they are stored in different tables and different units:
   *
   *   - BEFORE the mystery phase opens, the prize is the head drawn at
   *     registration, in whole currency, living on `tournament_players.
   *     current_bounty` until it is claimed and on `tournament_bounties.
   *     bounty_amount` afterwards;
   *   - AFTER it opens, the prize is a chest from the sealed inventory, in
   *     cents, on `tournament_bounty_chests.amount_cents`.
   *
   * Both return `undefined` rather than a number they are not sure of, and
   * both swallow their own errors: a missing rank costs a celebration, and a
   * thrown lookup would cost a knockout its broadcast.
   *
   * THE TOP SLICE. Each read is ordered largest-first and capped, rather than
   * pulling a whole field. PostgREST caps an uncapped select at 1,000 rows in
   * an unspecified order, so a big field could have hidden the largest prize
   * from a query that looked complete. Ordering makes the slice the TOP of the
   * ladder by construction, which is the only part any of this decides on: a
   * prize outside the slice comes back ranked past the end of it, and every
   * consumer reads that as "not the top three".
   */
  private async preMysteryPrizeRank(amount: number | undefined): Promise<number | undefined> {
    try {
      const [live, claimed] = await Promise.all([
        supabase
          .from('tournament_players')
          .select('current_bounty')
          .eq('tournament_id', this.tournamentId)
          .order('current_bounty', { ascending: false })
          .limit(200),
        supabase
          .from('tournament_bounties')
          .select('bounty_amount')
          .eq('tournament_id', this.tournamentId)
          .order('bounty_amount', { ascending: false })
          .limit(200),
      ]);

      // The head just pulled is on this ladder either way: fn_collect_bounty
      // zeroes `current_bounty` and writes `tournament_bounties` in the same
      // transaction, which has committed by the time this runs.
      const ladder = buildPrizeLadder([
        ...((live.data ?? []) as Array<{ current_bounty: unknown }>).map((r) => r.current_bounty),
        ...((claimed.data ?? []) as Array<{ bounty_amount: unknown }>).map((r) => r.bounty_amount),
      ]);

      const rank = prizeRankOf(amount, ladder);
      return rank > 0 ? rank : undefined;
    } catch {
      /* no rank is a quiet celebration; a throw would be a lost knockout */
      return undefined;
    }
  }

  /**
   * The chest's rung, in CENTS, against the inventory seeded at activation.
   *
   * The inventory is immutable once seeded — `fn_mystery_bounty_reserve` only
   * ever moves a chest's `status` — so this ladder is the same on every call
   * and is deliberately not cached: a knockout is a rare event, and a cache
   * that survives a manager restart or a re-seeded event is a wrong answer
   * that nothing would ever notice.
   */
  private async chestPrizeRank(amountCents: number | undefined): Promise<number | undefined> {
    try {
      const { data } = await supabase
        .from('tournament_bounty_chests')
        .select('amount_cents')
        .eq('tournament_id', this.tournamentId)
        .order('amount_cents', { ascending: false })
        .limit(200);

      const ladder = buildPrizeLadder(
        ((data ?? []) as Array<{ amount_cents: unknown }>).map((r) => r.amount_cents)
      );
      const rank = prizeRankOf(amountCents, ladder);
      return rank > 0 ? rank : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * FINAL RECONCILIATION (Dan sections 46 and 71).
   *
   * Runs at completion, BEFORE fn_finalize_bounty_pool, on both finish paths
   * (the ordinary one and the final-table deal). Two jobs:
   *
   *   - settle every chest nobody claimed to the champion. The last player
   *     standing was never knocked out, so their own chest is theirs, and so
   *     is any chest a broken elimination left behind;
   *   - prove the event balances. `sum(paid) === mystery_bounty_pool_cents`,
   *     to the cent, or a critical error names the variance.
   *
   * Order matters: settle moves `bounty_pool_paid`, so fn_finalize_bounty_pool
   * afterwards pays the champion only the genuine residual of the REGULAR half
   * rather than the mystery money a second time.
   */
  protected async reconcileMysteryBounty(winnerId: string | null): Promise<void> {
    if (!this.tournamentCache?.is_mystery_bounty) return;
    if (this.mysteryBountyStage === 'pending') return;
    try {
      const { data, error } = await supabase.rpc('fn_mystery_bounty_settle', {
        p_tournament_id: this.tournamentId,
        p_winner_user_id: winnerId,
      });
      if (error) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: mystery bounty settlement FAILED: ${error.message}`
          ),
          'Tournament.mystery_bounty_settle_failed'
        );
        return;
      }
      const res = (data ?? {}) as {
        ok?: boolean;
        balanced?: boolean;
        pool_cents?: number;
        settled_cents?: number;
        unclaimed_cents?: number;
        variance_cents?: number;
      };
      this.mysteryBountyStage = 'complete';
      if (res.ok && res.balanced === false) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: mystery bounty DOES NOT RECONCILE - pool ${res.pool_cents}c, settled ${res.settled_cents}c, variance ${res.variance_cents}c`
          ),
          'Tournament.mystery_bounty_unbalanced'
        );
      } else if (res.ok) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Mystery bounty reconciled exactly: ${res.settled_cents}c of ${res.pool_cents}c (${res.unclaimed_cents}c unclaimed to champion)`
        );
      }
    } catch (err) {
      reportError(err, 'Tournament.mystery_bounty_settle_threw');
    }
  }

  /** Reveal (idempotently), pay, and tell the table what was in the chest. */
  protected async settleMysteryBountyAward(
    awardId: string,
    tableId: string | null,
    eliminatedUserId: string,
    queueIndex: number,
    queueTotal: number
  ): Promise<void> {
    try {
      const { data: revealed, error: revealErr } = await supabase.rpc('fn_mystery_bounty_reveal', {
        p_award_id: awardId,
        p_actor_user_id: null,
        p_auto: true,
      });
      if (revealErr || !(revealed as { ok?: boolean } | null)?.ok) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: mystery bounty reveal FAILED for award ${awardId}: ${revealErr?.message ?? 'refused'}`
          ),
          'Tournament.mystery_bounty_reveal_failed'
        );
        return;
      }
      const rev = revealed as {
        amount_cents: number;
        tier: string;
        is_jackpot: boolean;
        recipients: Array<{ user_id: string; amount_cents: number }>;
      };

      // PAY BEFORE BROADCASTING. If the credit fails, nobody should have been
      // shown a number they are not going to receive.
      const { error: payErr } = await supabase.rpc('fn_mystery_bounty_pay', {
        p_award_id: awardId,
      });
      if (payErr) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: mystery bounty PAY FAILED for award ${awardId} (${rev.amount_cents}c): ${payErr.message}`
          ),
          'Tournament.mystery_bounty_pay_failed'
        );
        return;
      }

      const recipients = (rev.recipients ?? []).map((r) => ({
        userId: r.user_id,
        amountCents: r.amount_cents,
      }));
      // The names the chest displays. The reveal RPC returns ids and money —
      // correctly, it is a money function — so they are resolved here.
      const names = await this.resolveBountyNames([
        eliminatedUserId,
        ...recipients.map((r) => r.userId),
      ]);

      // THE RANK OF THIS CHEST among the event's sealed inventory. This is the
      // path Dan's requirement is actually about: the top prizes in a mystery
      // bounty pool are drawn from the chests, not from the pre-phase heads.
      const prizeRank = await this.chestPrizeRank(rev.amount_cents);

      await this.broadcast('mystery_bounty_revealed', {
        tableId,
        awardId,
        amountCents: rev.amount_cents,
        /**
         * THE SAME FIGURE IN WHOLE CURRENCY (added 2026-08-26).
         *
         * Every other bounty payload on this channel calls the money `amount`,
         * and this one carried only `amountCents`. That is the whole reason the
         * celebration banner could never fire for its intended case: it reads
         * `amount`, got undefined, and bailed on `amount <= 0` before it ever
         * looked at the rank. The top prizes in the event are pulled here, so
         * "the top 3 prizes are pulled" was the one moment it stayed silent.
         *
         * Additive, and it cannot disturb anything: TablePage prefers
         * `amountCents` whenever it is a number and only falls back to `amount`
         * for engine builds older than 2026-08-25, so the chest reads exactly
         * what it read before.
         */
        amount: Math.round(rev.amount_cents) / 100,
        /** 1-based rung on the chest ladder, largest first. See the helper. */
        prizeRank,
        // SECTION 50: the tier is the SERVER'S, from the chest that was drawn.
        // The client used to infer it from `amount / avgBounty`, which meant
        // the same chest could be called a Mega Prize on one screen and a Huge
        // Prize on another as the average moved during the event.
        tier: rev.tier,
        tierLabel: formatBountyTier(rev.tier),
        isJackpot: rev.is_jackpot,
        recipients: recipients.map((r) => ({ ...r, name: names(r.userId) })),
        eliminatedUserId,
        eliminatedName: names(eliminatedUserId),
        knockerUserId: recipients[0]?.userId ?? null,
        knockerName: recipients[0] ? names(recipients[0].userId) : 'Player',
        queueIndex,
        queueTotal,
      });

      // NOTE: `mystery_bounty_complete` is NOT sent here. It belongs to the
      // table's reveal queue, which knows whether another chest is waiting
      // behind this one; a per-award count of open awards across the whole
      // TOURNAMENT (which is what used to run here) declared the sequence over
      // on table 1 whenever table 4 happened to be idle, and never declared it
      // over at all while any other table had a knockout in flight.

      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] MYSTERY CHEST ${rev.tier} ${rev.amount_cents}c over ${eliminatedUserId.slice(0, 8)}`
      );
    } catch (err) {
      reportError(err, 'Tournament.mystery_bounty_settle_threw');
    }
  }

  /* DEAD CODE REMOVED 2026-08-25: `creditBountyToWallet`.
   *
   * It was the client-side bounty payment path — credit the knocker, then
   * write the dedupe row — and DAN'S SPEC 2026-08-15 replaced it with
   * `fn_collect_bounty`, which does the whole thing in one transaction (see
   * processBountyCollection above). The method was left behind with ZERO
   * callers, verified across all of server/src.
   *
   * It is deleted rather than left "just in case" because a second, unused
   * money path is a live hazard: it credits `tourney:{id}:bounty:{e}:{k}` on
   * its own, outside fn_collect_bounty's pool cap and outside its
   * tournament_bounties accounting, so anything that ever called it again
   * would pay a bounty the funded pool has no record of. If a caller is ever
   * needed, call the RPC. */

  /**
   * Recalculate prizes for players eliminated during late reg.
   * When the prize pool grows during late reg, early eliminations got smaller prizes.
   * This credits the difference now that the final pool is known.
   */
  protected async recalculateEliminatedPrizes(finalPrizePool: number): Promise<void> {
    const { data: eliminated, error: eliminatedErr } = await supabase
      .from('tournament_players')
      .select('user_id, position, prize')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'eliminated')
      .gt('prize', 0); // Only ITM players

    // PAYOUT-INTEGRITY 2026-08-25: this runs exactly ONCE, when the pool is
    // finalised at the close of late registration. `!eliminated` swallowed a
    // read error as "no ITM players to adjust" and there is no second pass —
    // every early finisher simply keeps the prize computed against the smaller
    // pool, and nothing anywhere says why.
    if (eliminatedErr) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] prize recalc ABORTED - could not read ITM finishers (${eliminatedErr.message}); early busts keep their pre-late-reg prizes`
        ),
        'Tournament.prize_recalc_read_failed'
      );
      return;
    }
    if (!eliminated || eliminated.length === 0) return;

    // PAYOUT-INTEGRITY 2026-08-25: use the SHARED structure resolver, not a
    // bare parse of the cached column. resolvePayoutStructure rebuilds a
    // Spin's split from its multiplier when the stored column is unusable,
    // which is the same rule both live payout sites follow — parsing the
    // column here meant a top-up computed from a DIFFERENT structure than the
    // payment it is topping up.
    const payouts = resolvePayoutStructure(
      this.tournamentCache as any,
      await this.finalFieldSize()
    );
    if (!payouts || payouts.length === 0) return;

    for (const player of eliminated) {
      const payoutEntry = payouts.find((p: any) => Number(p.place) === Number(player.position));
      if (!payoutEntry) continue;

      /**
       * PAYOUT-INTEGRITY 2026-08-25: A FOURTH INDEPENDENT PRIZE FORMULA.
       *
       * This was `Math.round(((finalPrizePool * percentage) / 100) * 100) / 100`
       * — every place rounded on its own, which is exactly the scheme
       * computePlacePrize was written to replace (see payoutMath.ts). Two
       * consequences, both real money:
       *
       *   1. It DISAGREES with the payment it is adjusting. eliminatePlayer
       *      pays the last paid place the residual; this recomputed that same
       *      place as a raw rounded percentage, credited the difference, and
       *      then wrote its own number into `prize`. On the 9-place structure
       *      over a 483.00 pool the independent rounding sums to 483.01, so
       *      the pool pays out a cent more than it holds.
       *   2. It puts the row permanently at odds with
       *      fn_tournament_payout_reconcile, which implements the residual
       *      rule — so the reconciler reports a false overpay and raises a
       *      critical alert on a tournament that is fine.
       *
       * One rule, one helper, every site.
       */
      const correctPrize = computePlacePrize(finalPrizePool, payouts, Number(player.position));
      const difference = Math.round((correctPrize - (player.prize || 0)) * 100) / 100;

      if (difference > 0) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Prize recalc: ${player.user_id.slice(0, 8)} pos ${player.position} - old: ${player.prize}, new: ${correctPrize}, diff: +${difference}`
        );

        /**
         * ONE SETTLE PATH (2026-09-02): THE AMOUNT IS WHAT IS OWED, NOT THE
         * DIFFERENCE, AND IT IS NOT IN THE KEY.
         *
         * This used to credit `difference` under
         * `tourney:{id}:prizeadj:{user}:{place}:{correctPrize}` - the amount
         * baked into the key so a re-run with the same figure deduped. The
         * flip side (docs/CHIP-ACCOUNTING-STANDARD.md 2.2, payer 4) is that a
         * re-run with a DIFFERENT figure was a brand-new key and a brand-new
         * payment on top of the old one, and nothing reconciled the two.
         *
         * The obligation row for this place is keyed (tournament,
         * 'late_reg_adjustment', place). We tell it the NEW correct prize; it
         * raises `amount_owed` to that and pays only `owed - already paid`.
         * The database computes the delta, so there is no amount to put in a
         * key and no second key to invent.
         */
        const adj = await settleTournamentObligation(supabase, {
          tournamentId: this.tournamentId,
          kind: 'late_reg_adjustment',
          place: Number(player.position),
          userId: player.user_id,
          amount: correctPrize,
          source: 'engine.recalculateEliminatedPrizes',
          memo: `Tournament prize adjustment (late reg pool finalized): position ${player.position}`,
        });

        if (adj.fully_settled === true && (adj.amount_paid ?? 0) >= correctPrize) {
          // A successful partial credit does not fund the full corrected prize.
          // Only the authoritative cumulative receipt can justify this stamp.
          const { error: recordErr } = await supabase
            .from('tournament_players')
            .update({ prize: correctPrize })
            .eq('tournament_id', this.tournamentId)
            .eq('user_id', player.user_id);
          if (recordErr) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] prize recalc confirmed total ${adj.amount_paid} for ${player.user_id.slice(0, 8)} but could not record prize=${correctPrize}: ${recordErr.message}`
              ),
              'Tournament.prize_recalc_record_failed'
            );
          }
        } else {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Prize recalc payment remains unconfirmed or incomplete for ${player.user_id.slice(0, 8)}: ${adj.refused_reason ?? 'remaining obligation'}${adj.transport_error ? ` (${adj.transport_error})` : ''}`
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
    // SETTLEMENT INTEGRITY 2026-08-26. This used to sum the fee ledger and
    // credit the union/club wallet from HERE, in two separate client calls
    // with no idempotency marker. Two consequences, both measured live:
    //
    //   - a tournament finished by the recovery watchdog (which never called
    //     this) or whose wallet credit failed simply NEVER landed its rake —
    //     ~6,748 chips across ~940 events in the 30 days before the fix,
    //     debited from players and held by nothing;
    //   - any re-run of the finish path would have credited the wallet a
    //     second time, with nothing to say it already had.
    //
    // fn_settle_tournament_rake does the whole thing in ONE transaction:
    // claims the tournament_rake_settlements PK (so a second caller gets
    // already_settled instead of a second credit), sums the fee ledger, and
    // credits the union rake wallet or standalone club treasury. Retried
    // here because it is idempotent; anything that still fails is caught by
    // fn_sweep_unsettled_tournament_rake on the discovery loop.
    void tournament; // destination now resolves inside the RPC
    let lastErr = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { data, error } = await supabase.rpc('fn_settle_tournament_rake', {
          p_tournament_id: this.tournamentId,
          p_source: 'engine_finish',
        });
        if (!error && data?.ok) {
          if (data.already_settled) {
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Rake already settled (${data.amount} -> ${data.destination})`
            );
          } else {
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Rake settled: ${data.amount} -> ${data.destination}`
            );
          }
          return;
        }
        lastErr = error?.message || data?.reason || 'settle_failed';
      } catch (err: any) {
        lastErr = String(err?.message ?? err);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
    }
    // Not silent, and not fatal: the sweep re-drives it, so nothing is lost —
    // but a failing settle path is a signal someone should see.
    reportError(
      new Error(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Rake settlement FAILED after 3 attempts (${lastErr}) - fn_sweep_unsettled_tournament_rake will re-drive it`
      ),
      'Tournament.rake_settlement_failed'
    );
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

      /**
       * ═══════════════════════════════════════════════════════════════════
       *  A DEAL NEEDS ONE TABLE, NOT A SHORT HEADCOUNT (2026-08-27, P0)
       * ═══════════════════════════════════════════════════════════════════
       *
       * The count above is necessary and NOT sufficient. Nine players spread
       * three-three-three across three felts satisfy it, and unanimity among
       * those nine would then run `fn_final_table_deal` — an even chip-chop
       * of the whole undistributed pool — between players sitting at three
       * separate tables, mid-hand, with two thirds of them unaware the vote
       * was open. That is the most expensive single write in this file and it
       * cannot be undone.
       *
       * Same gate as the `final_table` announcement in TournamentManager, and
       * the same UNKNOWN rule: `null` means we could not read the table
       * layout, and an unreadable layout never authorizes a chop.
       */
      const liveTables = await this.countLiveTablesWithPlayers();
      if (liveTables !== 1) return; // fail closed: not one table, or unknown

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

    // Validate the entire recorded deal before paying anyone. A missing,
    // duplicate or foreign recipient is not evidence of a complete chop.
    const expectedRecipients = new Set(alive.map((p) => p.user_id));
    const seenRecipients = new Set<string>();
    const validRoster =
      expectedRecipients.size === alive.length &&
      payoutRows.length === expectedRecipients.size &&
      payoutRows.every((p: { user_id: string; amount: unknown }) => {
        const raw = p.amount;
        const amount = Number(raw);
        const cents = amount * 100;
        if (
          !expectedRecipients.has(p.user_id) ||
          seenRecipients.has(p.user_id) ||
          (typeof raw !== 'number' && typeof raw !== 'string') ||
          (typeof raw === 'string' && !/^[0-9]+(?:[.][0-9]+)?$/.test(raw)) ||
          !Number.isFinite(amount) ||
          amount < 0 ||
          !Number.isSafeInteger(Math.round(cents)) ||
          Math.round(cents) / 100 !== amount
        )
          return false;
        seenRecipients.add(p.user_id);
        return true;
      });
    if (!validRoster) {
      await raiseFinancialAlert(
        'critical',
        'Tournament.final_table_deal_payout_roster_invalid',
        'The recorded final table deal has invalid amounts or does not match its participants. Settlement was not attempted by this invocation; previous payment status is unconfirmed.',
        {
          tournament_id: this.tournamentId,
          expected_recipients: [...expectedRecipients],
          recorded_row_count: payoutRows.length,
        }
      );
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Invalid or incomplete final table deal payout roster`
        ),
        'Tournament.final_table_deal_payout_roster_invalid'
      );
      return;
    }

    let allSharesSettled = true;
    for (const p of payoutRows as Array<{ user_id: string; amount: number }>) {
      const amount = Math.max(0, Number(p.amount) || 0);
      if (amount <= 0) continue;
      // ONE SETTLE PATH (2026-09-02): a user-keyed 'final_table_deal'
      // obligation - UNIQUE on (tournament, kind, user) - replaces the
      // `tourney:{id}:ftd:{user}` key. A raced settle still cannot double-pay
      // a deal share; the guarantee is now a constraint, not a string.
      const share = await settleTournamentObligation(supabase, {
        tournamentId: this.tournamentId,
        kind: 'final_table_deal',
        userId: p.user_id,
        amount,
        source: 'engine.settleFinalTableDeal',
        memo: 'Final table deal (even chip chop)',
      });
      if (!share.ok || share.fully_settled !== true || (share.amount_paid ?? 0) < amount) {
        allSharesSettled = false;
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: deal credit FAILED for ${p.user_id.slice(0, 8)}: ${share.refused_reason ?? 'incomplete_settlement'}${share.transport_error ? ` (${share.transport_error})` : ''}`
          ),
          'Tournament.final_table_deal_credit_failed'
        );
        continue;
      }
    }

    // The recorded deal remains pending until every original share is confirmed paid.
    if (!allSharesSettled) return;

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
    // PAYOUT-INTEGRITY 2026-08-25: same rule as the normal finish path — an
    // unstamped winner row on a settled deal reads as an unresolved player to
    // the recovery watchdog, which would then re-rank the field and pay place
    // 1 from the PAYOUT STRUCTURE on top of the chop that was just settled.
    const { error: dealWinnerErr } = await supabase
      .from('tournament_players')
      .update({ status: 'winner', position: 1 })
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', winnerId);
    if (dealWinnerErr) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: deal winner row not stamped for ${winnerId.slice(0, 8)}: ${dealWinnerErr.message}`
        ),
        'Tournament.final_table_deal_winner_stamp_failed'
      );
    }

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
      // Mystery chests settle FIRST — see reconcileMysteryBounty.
      await this.reconcileMysteryBounty(winnerId);
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
    const { error: dealCompletedErr } = await supabase
      .from('tournaments')
      .update({
        status: 'COMPLETED',
        ended_at: new Date().toISOString(),
        on_break: false,
        break_ends_at: null,
      })
      .eq('id', this.tournamentId)
      .eq('status', 'COMPLETING');
    // PAYOUT-INTEGRITY 2026-08-25: a deal left in COMPLETING is picked up by
    // recoverStuckCompletingTournaments, which pays from the PAYOUT STRUCTURE
    // — the one thing this path's docblock says must never be applied to a
    // deal. Discarding this error made that silent; it must be loud.
    if (dealCompletedErr) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: deal settled but COMPLETING -> COMPLETED failed: ${dealCompletedErr.message} - the structure-based recovery watchdog can now reach a dealt event`
        ),
        'Tournament.final_table_deal_completed_transition_failed'
      );
    }

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
      `[Tournament:${this.tournamentId.slice(0, 8)}] FINAL TABLE DEAL settled - ${payoutRows.length} player(s) paid, chip leader ${winnerId.slice(0, 8)} takes 1st`
    );

    await this.cleanupBroadcastChannel();
    this.stop();
  }

  protected async finishTournament(winnerId: string): Promise<void> {
    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] Finishing tournament. Winner: ${winnerId.slice(0, 8)}`
    );

    // Atomic DB guard: only proceed if we can claim the RUNNING → COMPLETING transition
    const { data: claimResult, error: claimErr } = await supabase
      .from('tournaments')
      .update({ status: 'COMPLETING' } as any)
      .eq('id', this.tournamentId)
      .eq('status', 'RUNNING')
      .select('id')
      .maybeSingle();

    // PAYOUT-INTEGRITY 2026-08-25: not claiming is the SAFE outcome — nothing
    // is paid twice — but a failed CAS and a lost race were reported with the
    // same reassuring line, and only one of them is benign. A tournament whose
    // claim errors is still RUNNING with one player left and no bust to come,
    // so nothing retries it and it hangs there until a human notices.
    if (claimErr) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: could not claim RUNNING -> COMPLETING: ${claimErr.message} - tournament left RUNNING, winner ${winnerId.slice(0, 8)} unpaid`
        ),
        'Tournament.finish_claim_failed'
      );
      return;
    }

    if (!claimResult) {
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Could not claim finish - already finishing/completed`
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
        'payout_structure, prize_pool, guaranteed_prize, buy_in_fee, current_players, club_id, name, status, is_bounty, is_pko, is_mystery_bounty, variant, tournament_type, spin_multiplier, satellite_target_id, satellite_seats'
      )
      .eq('id', this.tournamentId)
      .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

    if (!tournament || tourneyLoadErr) {
      /**
       * PAYOUT-INTEGRITY 2026-08-25: DO NOT MARK IT COMPLETED.
       *
       * This branch used to do the worst possible thing with a failed read: it
       * wrote COMPLETED — with no CAS guard at all, so it overrode whatever the
       * status actually was — while stating in its own message that it was
       * paying nobody. That is not a recoverable state. The winner's prize and
       * every unpaid ITM place are gone, and they are gone FOR GOOD, because
       * `recoverStuckCompletingTournaments` only ever looks at COMPLETING; the
       * one mechanism built to rescue exactly this case can no longer see it.
       *
       * The tournament has already been claimed into COMPLETING above. Leaving
       * it there is what the watchdog is for: it re-reads the tournament, ranks
       * the survivors, pays every place from the structure and completes the
       * event. So on an unreadable row we stop and leave the claim standing —
       * a tournament that finishes a few minutes late, instead of a field that
       * is never paid.
       */
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Could not load tournament for finish: ${tourneyLoadErr?.message ?? 'no row'} - left in COMPLETING for recoverStuckCompletingTournaments to pay and close`
        ),
        'TournamentthistournamentIdslic.CRITICAL'
      );
      this.stop();
      return;
    }

    // Calculate winner prize — with fallback if payout_structure missing or no place 1
    // TOURNEY-AUDIT 2026-07-24 (sweep 6): satellites award SEATS at the end
    // (processSatelliteAwards below), never per-place cash here.
    const isSatelliteFinish =
      (tournament as any)?.variant === 'satellite' ||
      String((tournament as any)?.tournament_type ?? '').toUpperCase() === 'SATELLITE' ||
      !!(tournament as any)?.satellite_target_id;
    /**
     * THE GUARANTEE IS FUNDED HERE OR IT IS NEVER FUNDED (2026-08-31, phase 6).
     *
     * applyPrizeGuarantee had exactly two triggers, and between them they miss
     * an entire shape of event:
     *
     *   start()          only when late_reg_levels <= 0
     *   level change     only when currentLevel >= late_reg_levels
     *
     * An event with a late-reg window that FINISHES BELOW THAT LEVEL calls it
     * ZERO times. The pool is never topped up, and the finish path below then
     * prices every place off a pool the guarantee never reached.
     *
     * Measured before this was written: 12 completed events since 2026-08-29
     * short of their guarantee with no overlay row, and TWELVE OF FOURTEEN
     * died below their late-reg cap. Nine of them were freerolls, whose pool
     * is 0 by construction and whose guarantee is therefore the ONLY money
     * they ever have. Those nine ranked a full field - up to 326 players -
     * stamped a winner, and paid zero chips to anybody.
     *
     * TournamentManagerBase's own comment promises `fn_sweep_unfunded_guarantees`
     * as the safety net for exactly this. It was never written; the name
     * appears nowhere else in the repo or the database. This is that net, put
     * where it cannot be missed: the last moment before the money is priced.
     *
     * Deliberately NOT guarded on prize_pool > 0 or on buy_in_amount - those
     * two conditions are precisely what made a freeroll invisible to every
     * other check. The RPC is idempotent (it returns early on `finalized`) and
     * settles to greatest(pool, guarantee), so a re-drive of an event that was
     * already funded moves nothing.
     *
     * Winner pricing requires confirmed funding. Failure must not turn the
     * stale collected pool into the advertised final prize pool.
     */
    if (!isSatelliteFinish && Number(tournament.guaranteed_prize ?? 0) > 0) {
      let funded: number | null = null;
      try {
        funded = await this.applyPrizeGuarantee('finish_fallback');
      } catch (guaranteeErr) {
        reportError(guaranteeErr, 'Tournament.guarantee_finish_fallback_failed');
      }
      // The helper validates the RPC receipt. A successful but still-short
      // pool is not fulfillment of the published guarantee either.
      if (funded === null || funded < Number(tournament.guaranteed_prize)) {
        await raiseFinancialAlert(
          'critical',
          'Tournament.finish_guarantee_unconfirmed',
          'The tournament guarantee is not confirmed funded. Winner pricing and completion were not attempted by this invocation.',
          {
            tournament_id: this.tournamentId,
            guaranteed_prize: Number(tournament.guaranteed_prize),
            confirmed_pool: funded,
          }
        );
        return;
      }
      // Use the confirmed funding result. Another read can fail or return
      // the pre-funding snapshot, silently pricing the winner too low.
      tournament.prize_pool = funded;
    }

    let winnerPrize = 0;
    if (!isSatelliteFinish) {
      // resolvePayoutStructure returns the stored structure when it is usable
      // and, for a Spin, rebuilds it from spinTier(spin_multiplier) when it is
      // not. So a Spin never reaches the fallback below.
      const payouts = resolvePayoutStructure(tournament as any, await this.finalFieldSize());
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
        // and a persistent failure prevents residual pricing. Unknown prior
        // awards cannot authorize another payment from the full pool.
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
            awarded = res.data as Array<{ prize: number }> | null;
            awardedErr = null;
            break;
          }
          awardedErr = res.error;
          if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 500));
        }

        const readableAwards =
          Array.isArray(awarded) &&
          awarded.every((row) => {
            const raw = row?.prize;
            const amount = Number(raw);
            return (
              (typeof raw === 'number' ||
                (typeof raw === 'string' && /^[0-9]+(?:[.][0-9]+)?$/.test(raw))) &&
              Number.isFinite(amount) &&
              amount >= 0 &&
              Number.isSafeInteger(Math.round(amount * 100)) &&
              Math.round(amount * 100) / 100 === amount
            );
          });
        if (awardedErr || !readableAwards) {
          await raiseFinancialAlert(
            'critical',
            'Tournament.winner_prior_awards_unconfirmed',
            'Winner residual pricing requires readable prior awards. No residual payment or completion was attempted by this invocation.',
            {
              tournament_id: this.tournamentId,
              detail: awardedErr?.message ?? 'invalid award rows',
            }
          );
          return;
        }

        const alreadyAwarded = (awarded ?? []).reduce(
          (sum: number, r: any) => sum + Number(r?.prize || 0),
          0
        );
        const pool = Number(tournament?.prize_pool || 0);
        winnerPrize = remainingPoolAfterAwards(pool, alreadyAwarded);

        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] ` +
              `No usable payout_structure` +
              `${isSpinTournament(tournament as any) ? ' and no spin_multiplier to rebuild it from' : ''}` +
              ` - paying the winner the UNSPENT pool (${winnerPrize} of ${pool}; ` +
              `${alreadyAwarded} recorded for ${(awarded ?? []).length} finisher(s))`
          ),
          'TournamentthistournamentIdslic.No_usable_payout_structure'
        );
      }
    }

    /**
     * A WINNER PAID NOTHING MUST SAY SO (2026-08-31, phase 6).
     *
     * `if (winnerPrize > 0)` is the right guard for the credit and the wrong
     * place to stop thinking. Every alert this path added on 2026-08-31 -
     * winner_prize_credit_failed, prize_credit_failed - lives INSIDE this
     * block, so it can only escalate a credit that was ATTEMPTED AND FAILED.
     * A credit that is never attempted is silent.
     *
     * That silence is what let nine freerolls rank a full field (313 and 326
     * players among them), stamp a winner, and pay zero chips with not one
     * alert anywhere. Their pool was 0, so every price was 0, so this branch
     * was simply skipped - and the Phase 2 detector could not see them either,
     * because it filters on `prize_pool > 0`, the exact column the defect
     * zeroes.
     *
     * Zero is a legitimate outcome for a play-money or unfunded event, so this
     * is a WARNING, not a critical, and it never blocks the finish. But it is
     * no longer nothing.
     */
    if (winnerPrize <= 0 && !isSatelliteFinish) {
      const gtd = Number((tournament as { guaranteed_prize?: number }).guaranteed_prize ?? 0);
      await raiseFinancialAlert(
        gtd > 0 ? 'critical' : 'warning',
        'Tournament.winner_paid_nothing',
        gtd > 0
          ? 'A tournament with an advertised guarantee crowned a winner and paid them nothing. The guarantee was never funded into the prize pool.'
          : 'A tournament crowned a winner and paid them nothing, because its prize pool is zero.',
        {
          tournament_id: this.tournamentId,
          tournament_name: (tournament as { name?: string }).name ?? null,
          winner_id: winnerId,
          prize_pool: Number(tournament.prize_pool || 0),
          guaranteed_prize: gtd,
          field_size: await this.finalFieldSize(),
        }
      );
    }

    if (winnerPrize > 0) {
      // ONE SETTLE PATH (2026-09-02). The 3x retry loop around
      // `fn_credit_and_log` keyed `tourney:{id}:prize:place:1` is now the
      // obligation (tournament, 'place', 1): this path, the stuck-COMPLETING
      // watchdog and the reconciler all settle the SAME row, so the winner
      // cannot be paid twice across paths whatever key each of them used to
      // carry. Transport retry lives in the helper; a refusal is never retried.
      const settled = await settleTournamentObligation(supabase, {
        tournamentId: this.tournamentId,
        kind: 'place',
        place: 1,
        userId: winnerId,
        amount: winnerPrize,
        source: 'engine.finishTournament',
        memo: `Tournament winner prize: 1st place`,
      });

      if (!settled.ok && settled.refused_reason === TRANSPORT_REFUSAL) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Winner prize credit FAILED after 3 retries for ${winnerId.slice(0, 8)} - ${winnerPrize} chips lost`
          ),
          'TournamentthistournamentIdslic.CRITICAL'
        );
        // The champion's prize. See the note on the same escalation above:
        // until 2026-08-31 no tournament payout path raised a financial alert.
        await raiseFinancialAlert(
          'critical',
          'Tournament.winner_prize_credit_failed',
          `WINNER prize credit failed after 3 retries - ${winnerPrize} chips owed to ${winnerId} were never paid`,
          {
            tournament_id: this.tournamentId,
            user_id: winnerId,
            place: 1,
            prize: winnerPrize,
            obligation: { kind: 'place', place: 1 },
            transport_error: settled.transport_error ?? null,
          }
        );
      }
      // A transport-successful partial credit is still an unpaid obligation.
      // Do not stamp the requested prize or announce a completed tournament.
      if (!settled.ok || !settled.fully_settled || (settled.amount_paid ?? 0) < winnerPrize) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Winner obligation is not fully settled`
          ),
          'Tournament.winner_obligation_incomplete'
        );
        return;
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
        `[Tournament:${this.tournamentId.slice(0, 8)}] finishing with ${stillPlaying.length} unresolved player(s) - assigning places 2..${stillPlaying.length + 1}`
      );
      const ordered = [...stillPlaying].sort((a, b) => (a.chips ?? 0) - (b.chips ?? 0));
      // PAYOUT-INTEGRITY 2026-08-27: `ordered.length + 1 - i` assumed no place
      // below it was taken — with a single unresolved player it ALWAYS wrote
      // place 2, occupied or not, paying a second 2nd-place prize. Same
      // free-place walk as the bust sweep.
      const { data: finishTaken } = await supabase
        .from('tournament_players')
        .select('position')
        .eq('tournament_id', this.tournamentId)
        .not('position', 'is', null);
      const finishTakenPositions = new Set<number>(
        (finishTaken || [])
          .map((r) => Number((r as { position: unknown }).position))
          .filter((n) => Number.isFinite(n))
      );
      let finishNext = ordered.length + 1;
      for (let i = 0; i < ordered.length; i++) {
        while (finishNext >= 2 && finishTakenPositions.has(finishNext)) finishNext--;
        if (finishNext < 2) {
          reportError(
            new Error(
              `No free finishing place left for ${ordered[i].user_id} in tournament ${this.tournamentId}`
            ),
            'TournamentManager.no_free_finishing_place_at_finish'
          );
          break;
        }
        await this.eliminatePlayer(ordered[i].user_id, finishNext);
        finishTakenPositions.add(finishNext);
        finishNext--;
      }
    }

    // PAYOUT-INTEGRITY 2026-08-25: this row is the ONLY record that place 1
    // was paid. Discarded, a failure here left the champion status='playing'
    // with prize 0 on a COMPLETED event — unattributable money, the same shape
    // as the 113 under-paid tournaments the comment above describes — and
    // fn_tournament_payout_reconcile would then read prize 0 for place 1 and
    // try to top the winner up to the full first prize a second time.
    const { error: winnerStampErr } = await supabase
      .from('tournament_players')
      .update({ status: 'winner', position: 1, prize: winnerPrize })
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', winnerId);
    if (winnerStampErr) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: winner row not stamped for ${winnerId.slice(0, 8)} (prize ${winnerPrize}): ${winnerStampErr.message}`
        ),
        'Tournament.winner_row_stamp_failed'
      );
    }

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
        return; // Award uncertainty must not fall through to COMPLETED.
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
      // Mystery chests settle FIRST — see reconcileMysteryBounty.
      await this.reconcileMysteryBounty(winnerId);
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
    // PAYOUT-INTEGRITY 2026-08-25: result checked. A discarded failure here
    // leaves the event in COMPLETING — which is harmless, because the recovery
    // watchdog finds it and finishes it idempotently — but SILENT, so nobody
    // learns that the normal finish path is failing to close its own events.
    /**
     * A FINISH THAT DEADLOCKS IS RETRIED (2026-09-06). This update fires
     * fn_clear_seats_on_game_end, which closes every seat of the event, while
     * a table engine may be cashing one of those seats out
     * (atomic_seat_cashout_locked) - 40P01 five times in one hour on
     * 2026-09-06 (b88db8d6, 80fdff30, db05ecf2, 40102ace, ab102e3d), every
     * one a paid event left in COMPLETING. A deadlock victim is chosen in
     * milliseconds and the other side commits; the same statement a moment
     * later succeeds. Three attempts, short backoff, then the watchdog - which
     * now also refuses to be hidden by this manager (managerHasOverstayed).
     */
    let completedErr: { message?: string; code?: string } | null = null;
    for (let attempt = 1; attempt <= COMPLETED_FLIP_ATTEMPTS; attempt++) {
      const { error } = await supabase
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
      completedErr = error;
      if (!error || !isTransientFlipError(error)) break;
      console.warn(
        `[Tournament:${this.tournamentId.slice(0, 8)}] COMPLETING -> COMPLETED attempt ${attempt} of ${COMPLETED_FLIP_ATTEMPTS} hit ${error.code ?? '?'} (${error.message}) - retrying`
      );
      await new Promise((r) => setTimeout(r, COMPLETED_FLIP_BACKOFF_MS * attempt));
    }
    if (completedErr) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] COMPLETING -> COMPLETED failed: ${completedErr.message} - left for recoverStuckCompletingTournaments`
        ),
        'Tournament.completed_transition_failed'
      );
    }

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
