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
import {
  acceptedZeroStackSettlement,
  persistedKnockoutEvidence,
  type PersistedKnockoutEvidence,
  type StackSettlementResult,
} from './bountyAttributionGate.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import {
  eliminationSweepMs,
  eliminationSweepsInflight,
} from '../observability/engineInstruments.js';
import { computePlacePrize } from './payoutMath.js';
import { settleTournamentPlacesAtomically } from './atomicPlaceSettlement.js';
import {
  settleFinalTableDealAtomically,
  type AtomicFinalTableDealResult,
} from './atomicFinalTableDeal.js';
import { resolvePayoutStructure, parsePayoutStructure } from './payoutStructure.js';
import type { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { claimTournamentFinish } from './tournamentFinishContract.js';
import { TournamentSweepWorkCursor } from './TournamentSweepWorkCursor.js';
import {
  reconcileTournamentManagerWakeAcknowledgement,
  type TournamentManagerWakeReceipt,
} from './TournamentManagerWakeProtocol.js';

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
  /**
   * Cooperative continuation through the bounded manager work unit. A slow
   * but successful database request advances this cursor before yielding, so
   * the next admission never restarts the same prefix forever.
   */
  private readonly eliminationSweepCursor = new TournamentSweepWorkCursor();
  /** Latest level-triggered generation observed for each durable wake identity. */
  private readonly pendingManagerWakeGenerations = new Map<number, number>();
  /**
   * How many consecutive times each player has been REFUSED by
   * `eliminatePlayer`, so a permanently un-eliminable one stops holding the
   * queue (2026-09-09).
   *
   * The assignment loop aborts the whole pass on a refusal, and it must: a
   * refusal can mean the CAS missed because another generation took the place,
   * which makes `takenPositions` stale, and handing out a stale place is how
   * two players get paid for one finish. But the batch is ordered by chips and
   * every candidate holds ZERO, so the order is stable - the same refused
   * player was first on every five-second sweep, for ever, and the nineteen
   * behind him were never even attempted.
   *
   * Keeping the abort and rotating the ORDER fixes the deadlock without
   * touching the ladder safety: whoever refuses goes to the back, so the next
   * pass attempts somebody who has not just failed. An entry is dropped as
   * soon as that player is eliminated, and the map only ever holds members of
   * the current busted set.
   */
  private readonly bustRefusalStreak = new Map<string, number>();

  override requestEliminationSweep(
    reason?: string,
    durableWakeId?: number,
    durableWakeGeneration?: number
  ): boolean {
    const accepted = super.requestEliminationSweep(reason, durableWakeId);
    if (
      accepted &&
      Number.isSafeInteger(durableWakeId) &&
      Number(durableWakeId) > 0 &&
      Number.isSafeInteger(durableWakeGeneration) &&
      Number(durableWakeGeneration) > 0
    ) {
      const id = Number(durableWakeId);
      const generation = Number(durableWakeGeneration);
      this.pendingManagerWakeGenerations.set(
        id,
        Math.max(this.pendingManagerWakeGenerations.get(id) ?? 0, generation)
      );
    }
    return accepted;
  }
  /** One signal per unresolved bounty hand, cleared when its exact row lands. */
  protected bountyEvidenceDeferred = new Set<string>();
  /** A comprehensive durable-outbox drain runs once after every manager restore. */
  protected bountyRecoveryAudited = false;
  /** Report a broken immutable satellite award plan once, while exact retries continue. */
  private satelliteEntitlementUnreadableReported = false;
  /** Bound outbox work per admission so one damaged event cannot own a slot. */
  protected static readonly BOUNTY_RECOVERY_BATCH = 4;

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

  /** undefined = entry still open; null = finalized but authoritative count unreadable. */
  protected async finalFieldSize(): Promise<number | null | undefined> {
    if (!this.prizePoolFinalized) return undefined;
    if (this.finalFieldSizeCache !== undefined) return this.finalFieldSizeCache;

    const { count, error } = await supabase
      .from('tournament_players')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', this.tournamentId);

    if (error || typeof count !== 'number' || count < 1) return null;
    this.finalFieldSizeCache = count;
    return count;
  }

  protected startEliminationChecker(): void {
    this.registerEliminationScheduler((signal) => this.runEliminationSweep(signal));
  }

  /** The settlement/elimination body is unchanged; only its admission moved. */
  private async runEliminationSweep(signal: AbortSignal): Promise<void> {
    let budgetRequeued = false;
    let completedWholeSweep = false;
    const durableWakes = new Map(this.pendingManagerWakes);
    const durableWakeIds = [...durableWakes.keys()];
    const durableWakeReceipts: TournamentManagerWakeReceipt[] = durableWakeIds.map((id) => ({
      id,
      generation: this.pendingManagerWakeGenerations.get(id) ?? 1,
    }));
    const acknowledgeCapturedWakes = async (): Promise<void> => {
      if (durableWakeReceipts.length === 0) return;
      const acknowledgement = await this.gameServer.acknowledgeTournamentManagerWakes(
        this.tournamentId,
        durableWakeReceipts
      );
      if (!acknowledgement.ok) {
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        return;
      }
      const stillPending = reconcileTournamentManagerWakeAcknowledgement(
        durableWakeReceipts,
        acknowledgement.current
      );
      if (!stillPending) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] durable manager wake acknowledgement did not describe the exact captured generations`
          ),
          'Tournament.manager_wake_ack_contract_invalid'
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        return;
      }

      let newerGenerationRemains = false;
      for (const receipt of durableWakeReceipts) {
        const observedAfterSweep = this.pendingManagerWakeGenerations.get(receipt.id) ?? 1;
        const databaseGeneration = stillPending.get(receipt.id);
        if (databaseGeneration !== undefined) {
          this.pendingManagerWakeGenerations.set(
            receipt.id,
            Math.max(observedAfterSweep, databaseGeneration)
          );
          newerGenerationRemains = true;
          continue;
        }
        if (observedAfterSweep === receipt.generation) {
          this.pendingManagerWakes.delete(receipt.id);
          this.pendingManagerWakeGenerations.delete(receipt.id);
        } else {
          // Realtime delivered a newer generation after the database ack
          // statement began. It was not part of this sweep and stays pending.
          newerGenerationRemains = true;
        }
      }
      if (newerGenerationRemains) this.requestEliminationSweep('manager_wake_generation_advanced');
    };
    const sweepStopped = (): boolean => !this.running || signal.aborted;
    const completedStage = (nextStage: number): boolean => {
      this.eliminationSweepCursor.advanceTo(nextStage);
      if (!this.eliminationWorkBudgetExpired()) return false;
      if (!budgetRequeued) {
        budgetRequeued = true;
        this.requestEliminationSweep();
      }
      return true;
    };
    if (sweepStopped()) return;

    // The process scheduler never admits the same tournament while its
    // physical promise is live. Do not "force release" this local guard: it
    // would create the concurrent writes the scheduler cap is designed to
    // prevent. Stalled work remains counted/alerted until it really settles.
    if (this.isProcessingEliminations) return;

    this.isProcessingEliminations = true;
    this.eliminationSweepSignal = signal;
    this.eliminationSweepDeadlineAt = Date.now() + TournamentManagerBase.SWEEP_WORK_BUDGET_MS;
    // How many of these the single JS thread is carrying at once, and how
    // long one takes. Both are measurement only - see engineInstruments.
    const sweepStartedAt = Date.now();
    eliminationSweepsInflight.inc();

    try {
      // A close commits its durable receipt and a `late_registration` wake in
      // one database transaction. Registration uses the same reason while the
      // window is open; asking the authoritative RPC then is a cheap no-op.
      // Crucially, a pending receipt returns false until the database proves
      // every early finisher was repriced, so the captured wake cannot be
      // acknowledged after a lost response or process crash.
      if (
        this.tournamentEntryRepricePending ||
        [...durableWakes.values()].some((reason) => reason === 'late_registration')
      ) {
        if (!(await this.reconcileTournamentEntryWindow('engine.manager_wake'))) return;
        if (sweepStopped()) return;
      }

      syncAndRecoveryStage: {
        if (this.eliminationSweepCursor.nextStage > 0) break syncAndRecoveryStage;
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
        const { data: liveSeatSnapshotRaw, error: liveSeatSnapshotErr } = await supabase.rpc(
          'fn_sync_tournament_live_seat_chips',
          { p_tournament_id: this.tournamentId }
        );
        if (sweepStopped()) return;
        const liveSeatSnapshot = (liveSeatSnapshotRaw ?? {}) as {
          ok?: boolean;
          open_user_ids?: unknown;
          ambiguous_user_ids?: unknown;
          synced?: number;
        };
        if (liveSeatSnapshotErr || liveSeatSnapshot.ok !== true) {
          reportError(
            liveSeatSnapshotErr ??
              new Error('database did not return a complete live-seat chip snapshot'),
            'Tournament.live_seat_chip_snapshot_failed'
          );
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
          return;
        }

        const ambiguousSeatUsers = Array.isArray(liveSeatSnapshot.ambiguous_user_ids)
          ? liveSeatSnapshot.ambiguous_user_ids.map((id) => String(id))
          : [];
        if (ambiguousSeatUsers.length > 0) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] ${ambiguousSeatUsers.length} player(s) hold multiple open seats with no unique latest joined_at - their chip sync is fail-closed this sweep: ${ambiguousSeatUsers.map((u) => u.slice(0, 8)).join(', ')}`
            ),
            'Tournament.ambiguous_live_seat'
          );
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        }

        // Never infer a knockout from a player's temporary absence from a
        // seat. A table move and a bust are distinguishable only by the
        // accepted hand-settlement record; elapsed time plus "no seat" is not
        // money authority and could eliminate a legitimate moving player.

        if (completedStage(1)) return;
      }

      recoveryStage: {
        if (this.eliminationSweepCursor.nextStage > 1) break recoveryStage;
        // CHIP-CAP INPUTS (2026-08-31): entrants + rebuys/add-ons granted, so
        // capLevelToTournamentChips knows how many chips the event has issued.
        // Throttled to once a minute — the cap only needs to be roughly right,
        // and it is a high-water mark so a slow refresh can never tighten it.
        await this.refreshChipCapInputs();
        if (sweepStopped()) return;

        // Settle earlier durable obligations before admitting another bust.
        // In a PKO an earlier collection can add value to the next busted
        // player's head, so proceeding on a failed recovery would underpay it.
        if (!(await this.recoverPendingBountyObligations(this.tournamentCache))) return;
        if (sweepStopped()) return;

        // A persisted chop owns the COMPLETING tail. Resume it before the
        // generic remaining-player logic can see only its already-stamped
        // winner and incorrectly enter the normal payout-structure finish.
        if (!(await this.checkFinalTableDeal())) return;
        if (sweepStopped()) return;
        if (this.finalTableDealHandled || this.tournamentFinished) {
          await acknowledgeCapturedWakes();
          return;
        }

        if (completedStage(2)) return;
      }

      bustStage: {
        if (this.eliminationSweepCursor.nextStage > 2) break bustStage;
        // Find ALL busted players (0 chips) in a single query
        // eslint-disable-next-line prefer-const
        let { data: busted, error: bustedErr } = await supabase
          .from('tournament_players')
          .select('user_id, chips')
          .eq('tournament_id', this.tournamentId)
          .eq('status', 'playing')
          .lte('chips', 0);
        let bustBatchHasMore = false;
        if (sweepStopped()) return;

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
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
          return; // the finally block clears isProcessingEliminations
        }

        // Re-drive only tournaments that currently contain an unresolved
        // zero-stack player. The retired five-second interval also retried a
        // transient count/position read, human rebuy decision, accepted rebuy
        // reseating, and deferred Spin credit on this cadence. One coalesced
        // delayed scheduler wake preserves those semantics without polling
        // every healthy tournament. Every retry re-arms only while a bust is
        // still visible; after elimination/reseat, one harmless tail pass runs
        // and stops.
        if (busted && busted.length > 0) {
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
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
          if (sweepStopped()) return;
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
          if (sweepStopped()) return;

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
          /**
           * ═══════════════════════════════════════════════════════════════════
           *  THE BATCH IS TAKEN BEFORE THE RPC, NOT FORTY LINES AFTER IT
           *  (2026-09-09, from 714 knockouts that sat pending for hours)
           * ═══════════════════════════════════════════════════════════════════
           *
           * `fn_open_tournament_rebuy_decisions` REFUSES a candidate set larger
           * than fifty - `cardinality(p_user_ids)>50` raises
           * `invalid rebuy-decision candidate set`. The whole `busted` array was
           * handed to it below, and the `SWEEP_MUTATION_BATCH_SIZE` slice that
           * was supposed to bound this work did not happen until after the
           * decision filter. So a tournament that ever accumulated fifty-one
           * simultaneous zero-chip `playing` players raised inside the RPC, took
           * the `decisionsErr` return, re-armed the five-second retry, and
           * arrived at the next sweep with the SAME oversized list.
           *
           * It cannot recover on its own, because nothing in that loop
           * eliminates anybody, so the backlog only grows. Measured on
           * production 2026-09-09: 907 knockout candidates `pending` for more
           * than two hours, 714 of them in RUNNING tournaments whose players
           * still read `playing` at 0 chips, while the engine's own ghost-seat
           * detector logged "the elimination sweep is not reaching this table"
           * 433 times in fifteen minutes.
           *
           * The batch is the bound on ALL the work in this stage, so it is taken
           * here, before the first call that has an input cap. `bustedTotal`
           * keeps the whole-field comparison below honest, and
           * `bustBatchHasMore` re-arms the sweep exactly as it did before.
           */
          const bustedTotal = busted.length;
          if (busted.length > TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE) {
            busted = [...busted]
              .sort((a, b) => (a.chips ?? 0) - (b.chips ?? 0))
              .slice(0, TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE);
            bustBatchHasMore = true;
          }

          const { rebought, answered } = await this.tryTournamentRebuys(
            busted.map((b) => b.user_id)
          );
          if (sweepStopped()) return;
          if (rebought.size > 0) {
            busted = busted.filter((b) => !rebought.has(b.user_id));
            if (busted.length === 0) {
              // Rebuy is a committed chip purchase, not a maintenance hint.
              // Seat it in this same admitted unit (bounded by the helper)
              // instead of returning before the normal seating stage and
              // depending on the five-second recovery wake.
              await this.ensureLateRegSeated();
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
           * The deadline is database-owned. A manager restart, pod handoff or
           * delayed event loop therefore cannot grant another window or make
           * an expired one look open. The row-locked RPC also opens a missing
           * deadline for a zero written by an old pod during rolling deploy.
           */
          {
            const { data: decisionsRaw, error: decisionsErr } = await supabase.rpc(
              'fn_open_tournament_rebuy_decisions',
              {
                p_tournament_id: this.tournamentId,
                p_user_ids: busted.map((b) => b.user_id),
              }
            );
            if (sweepStopped()) return;
            if (decisionsErr || !Array.isArray(decisionsRaw)) {
              reportError(
                decisionsErr ?? new Error('rebuy-decision RPC returned no authoritative rows'),
                'Tournament.rebuy_decisions_unavailable'
              );
              this.requestUrgentEliminationSweepAfter(
                TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS
              );
              return;
            }
            const decisions = new Map(
              decisionsRaw.map((row: { user_id: string; decision_open?: boolean }) => [
                String(row.user_id),
                row.decision_open === true,
              ])
            );
            busted = busted.filter((b) => {
              if (answered.has(b.user_id)) return true;
              // Omitted means the locked row was no longer a playing zero -
              // most commonly a concurrent rebuy. Never eliminate from the
              // stale snapshot captured before that transaction committed.
              if (!decisions.has(b.user_id)) return false;
              return decisions.get(b.user_id) !== true;
            });
            if (busted.length === 0) return;
          }

          /**
           * ═══════════════════════════════════════════════════════════════════
           *  BUSTS ARE PROCESSED IN THE ORDER THEY HAPPENED (2026-09-09)
           * ═══════════════════════════════════════════════════════════════════
           *
           * This sorted by chips, and every candidate here holds ZERO, so the
           * order was whatever the database happened to return. That is wrong
           * twice over.
           *
           * It is wrong for the STANDINGS, because the first entry takes the
           * worst remaining place, and the player who busted first is the player
           * who finished last. Chips cannot say who that was; the hand number
           * can, and it is the witness that was actually there (10.9).
           *
           * And it is wrong for PKO MONEY. `fn_claim_bounty_legacy_candidate`
           * keeps a per-tournament settlement watermark and refuses any claim
           * for a hand BEFORE it - `pko_order_already_advanced` - because a
           * progressive bounty's halves must settle in hand order. Out-of-order
           * processing therefore does not merely reorder: it STRANDS. Measured
           * on production 2026-09-09, as the elimination backlog from #3912
           * began draining: 79 refusals in six minutes and 49 knockout
           * candidates left permanently behind the watermark across ALL THREE
           * live PKO events - 49 players who could never be eliminated and whose
           * bounties could never be paid.
           *
           * Ordering by the hand the bust actually happened in makes the
           * watermark advance monotonically, so it cannot overtake a claim that
           * has not been made yet.
           *
           * The refusal streak still wins, because it is the deadlock breaker: a
           * player who cannot be eliminated at all must not hold the queue.
           * Chips remain the last resort, for a candidate with no recorded hand.
           */
          const bustHandNumbers = new Map<string, number>();
          {
            const { data: bustHands, error: bustHandsErr } = await supabase
              .from('tournament_knockout_candidates')
              .select('eliminated_user_id, hand_number')
              .eq('tournament_id', this.tournamentId)
              .eq('state', 'pending')
              .in(
                'eliminated_user_id',
                busted.map((b) => b.user_id)
              );
            if (sweepStopped()) return;
            // A read we could not make is UNKNOWN, not "no order": fall back to
            // the chip tiebreak rather than inventing one. The watermark still
            // refuses anything genuinely out of order, so this stays safe.
            if (bustHandsErr) {
              reportError(bustHandsErr, 'Tournament.bust_order_unreadable');
            } else {
              for (const row of bustHands ?? []) {
                const uid = String((row as { eliminated_user_id?: unknown }).eliminated_user_id);
                const hand = Number((row as { hand_number?: unknown }).hand_number);
                if (!uid || !Number.isFinite(hand)) continue;
                const seen = bustHandNumbers.get(uid);
                if (seen === undefined || hand < seen) bustHandNumbers.set(uid, hand);
              }
            }
          }

          // UNKNOWN sorts LAST. A missing hand number must never claim it busted
          // first and take a place that belongs to somebody the engine watched.
          const bustRank = (userId: string): number =>
            bustHandNumbers.get(userId) ?? Number.MAX_SAFE_INTEGER;

          let bustedOrdered = [...busted].sort(
            (a, b) =>
              (this.bustRefusalStreak.get(a.user_id) ?? 0) -
                (this.bustRefusalStreak.get(b.user_id) ?? 0) ||
              bustRank(a.user_id) - bustRank(b.user_id) ||
              (a.chips ?? 0) - (b.chips ?? 0)
          );

          // TOURNEY-AUDIT 2026-07-24 [double-pay guard]: if EVERY remaining
          // player busted in the same sweep, the old loop handed position 1 to
          // the largest stack via eliminatePlayer (paying the 1st-place prize)
          // and then the remainingCount===0 branch ALSO paid the winner via
          // finishTournament — 1st place paid twice. Spare the top stack from
          // elimination; the winner path below then pays them exactly once.
          // `bustedTotal`, not `busted.length`: the batch above may already have
          // narrowed this pass, and the spare-the-top-stack rule is about the
          // WHOLE field busting at once, not about the slice we happen to hold.
          if (playingCount === bustedTotal && bustedOrdered.length > 0) {
            bustedOrdered = bustedOrdered.slice(0, -1);
          }
          bustBatchHasMore =
            bustBatchHasMore ||
            bustedOrdered.length > TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE;
          bustedOrdered = bustedOrdered.slice(0, TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE);

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
          if (sweepStopped()) return;

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
          if (sweepStopped()) return;

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
            if (!this.running || signal.aborted) return;

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

            const eliminated = await this.eliminatePlayer(bustedOrdered[i].user_id, place);
            if (sweepStopped()) return;
            // False includes both a deliberate evidence defer and a CAS miss
            // because another generation/process got there first. In either
            // case takenPositions is now stale. Abort the assignment pass;
            // the already-armed unresolved-bust retry rebuilds the ladder
            // from persisted positions before it writes anybody else.
            if (!eliminated) {
              // Remember WHO refused, so the next pass tries somebody else
              // first. Without this the batch order is fixed (every candidate
              // holds zero chips, so the sort is a tie) and one permanently
              // refused player starves the rest for ever.
              const refusedId = bustedOrdered[i].user_id;
              this.bustRefusalStreak.set(
                refusedId,
                (this.bustRefusalStreak.get(refusedId) ?? 0) + 1
              );
              return;
            }
            this.bustRefusalStreak.delete(bustedOrdered[i].user_id);
            takenPositions.add(place);
            nextPosition = Math.min(nextPosition, place) - 1;
          }
        }

        if (bustBatchHasMore) {
          this.requestEliminationSweep();
          return;
        }

        if (completedStage(3)) return;
      }

      finishStage: {
        if (this.eliminationSweepCursor.nextStage > 3) break finishStage;
        // Check remaining players AFTER all eliminations processed
        const { count: remainingCount, error: remainingErr } = await supabase
          .from('tournament_players')
          .select('*', { count: 'exact', head: true })
          .eq('tournament_id', this.tournamentId)
          .eq('status', 'playing');
        if (sweepStopped()) return;

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
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        } else if (remainingCount > 1) {
          // MYSTERY BOUNTY ACTIVATION (2026-08-25). This is the only place in
          // the engine that knows, between hands and from a count it has just
          // verified, how many players can still be knocked out — which is
          // both halves of the activation predicate and the size of the chest
          // inventory. Guarded on `> 1` so the phase can never open on the
          // heads-up hand that ends the event.
          try {
            await this.maybeActivateMysteryBounty(remainingCount);
            if (sweepStopped()) return;
          } catch (mbErr) {
            reportError(mbErr, 'Tournament.mystery_bounty_activation_sweep');
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
            return;
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
            const { data: winner, error: winnerErr } = await supabase
              .from('tournament_players')
              .select('user_id')
              .eq('tournament_id', this.tournamentId)
              .eq('status', 'playing')
              .maybeSingle();
            if (sweepStopped()) return;

            if (winnerErr) {
              reportError(winnerErr, 'Tournament.finish_winner_unreadable');
              this.requestUrgentEliminationSweepAfter(
                TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS
              );
              return;
            }

            if (winner) {
              await this.finishTournament(winner.user_id);
              if (sweepStopped()) return;
            } else if ((remainingCount || 0) === 0) {
              // All players busted simultaneously — pick the last eliminated as winner
              const { data: lastEliminated, error: lastEliminatedErr } = await supabase
                .from('tournament_players')
                .select('user_id')
                .eq('tournament_id', this.tournamentId)
                .eq('status', 'eliminated')
                .order('eliminated_at', { ascending: false })
                .limit(1)
                .maybeSingle();

              if (sweepStopped()) return;
              if (lastEliminatedErr) {
                reportError(lastEliminatedErr, 'Tournament.last_eliminated_unreadable');
                this.requestUrgentEliminationSweepAfter(
                  TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS
                );
                return;
              }

              if (lastEliminated) {
                console.log(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] All busted simultaneously - last eliminated wins`
                );
                await this.finishTournament(lastEliminated.user_id);
                if (sweepStopped()) return;
              }
            }
          } catch (finishErr) {
            reportError(finishErr, 'TournamentthistournamentIdslic.finishTournament_error__will_r');
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
            return;
          }
        }

        if (completedStage(4)) return;
      }

      seatingStage: {
        if (this.eliminationSweepCursor.nextStage > 4) break seatingStage;
        // TOURNEY-AUDIT 2026-07-24 (sweep 6): server-authoritative seating —
        // late registrants / re-entries are seated within one cycle; if every
        // table is full they're marked 'playing' so checkDynamicTableExpansion
        // spawns a table and the balancer redraws. No player ever waits.
        await this.ensureLateRegSeated();
        if (sweepStopped()) return;
        if (completedStage(5)) return;
      }

      finalDealStage: {
        if (this.eliminationSweepCursor.nextStage > 5) break finalDealStage;
        // FINAL TABLE DEAL (2026-08-22 parity): while the field is down to one
        // table and the feature is on, watch tournament_deal_votes; unanimity
        // executes fn_settle_final_table_deal_atomic. Cheap by construction - it stands down
        // immediately unless the flag is set, and throttles its own polling.
        if (!(await this.checkFinalTableDeal())) return;
        if (sweepStopped()) return;
        if (completedStage(6)) return;
      }

      addOnStage: {
        if (this.eliminationSweepCursor.nextStage > 6) break addOnStage;
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
        // Keep repeated bust/late-registration wakes from re-offering more than
        // once every 20 seconds.
        if (this.addOnPeriodTriggered && !this.prizePoolFinalized) {
          const nowMs = Date.now();
          if (nowMs - this.lastAddOnOfferAt >= TournamentManagerBase.ADD_ON_RETRY_MS) {
            this.lastAddOnOfferAt = nowMs;
            await this.tryTournamentAddOns();
            if (sweepStopped()) return;
          }
          this.scheduleAddOnRetry();
        }
        if (completedStage(7)) return;
      }

      balanceStage: {
        if (this.eliminationSweepCursor.nextStage > 7) break balanceStage;
        // A tournament break freezes seat movement as well as dealing. A
        // balance operation closes one live seat and opens another, so it may
        // only run after the same maintenance predicate used by the table
        // engines has proved the platform thawed.
        if (!isMaintenanceFrozen()) {
          await this.checkTableBalance();
          if (sweepStopped()) return;

          // The old five-second manager interval also happened to poll final
          // table deal votes. Preserve the feature's intended ten-second
          // cadence only after table balancing has proved the field is on one
          // live final table and the feature is enabled. This delayed wake uses
          // the scheduler's one process timer and stops naturally when the deal
          // is handled, the tournament finishes, or the manager unregisters.
          if (
            this.isFinalTable &&
            this.tournamentCache?.final_table_deal_enabled === true &&
            !this.finalTableDealHandled &&
            !this.tournamentFinished
          ) {
            const dueIn = Math.max(
              0,
              this.lastDealPollAt + TournamentManagerBase.FINAL_TABLE_DEAL_POLL_MS - Date.now()
            );
            this.requestUrgentEliminationSweepAfter(dueIn);
          }
        }
        if (completedStage(8)) return;
      }

      expansionStage: {
        if (this.eliminationSweepCursor.nextStage > 8) break expansionStage;
        // FIX 155: Check if new tables need to be created during rebuy/late-reg period
        if (!isMaintenanceFrozen() && !(await this.checkDynamicTableExpansion())) return;
        if (sweepStopped()) return;
        if (completedStage(9)) return;
      }

      handForHandStage: {
        if (this.eliminationSweepCursor.nextStage > 9) break handForHandStage;
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
            if (sweepStopped()) return;

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
              this.requestUrgentEliminationSweepAfter(
                TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS
              );
              return; // the finally block clears isProcessingEliminations
            }

            const isSatellite =
              String(this.tournamentCache.variant ?? '').toLowerCase() === 'satellite' ||
              String(this.tournamentCache.tournament_type ?? '').toUpperCase() === 'SATELLITE' ||
              Boolean(this.tournamentCache.satellite_target_id);
            let payoutCount = 0;

            if (isSatellite) {
              // A satellite does not pay the generic percentage ladder stored
              // for display. Its bubble is the immutable award plan created
              // from the final funded pool: seat-or-cash entitlements plus a
              // distinct remainder recipient when one exists. Before entry
              // closes that plan quite correctly does not exist yet; the exact
              // DB-relative entry-close timer/wake owns the next admission, so
              // do not turn the whole open window into a polling loop.
              if (!this.prizePoolFinalized) break handForHandStage;

              const { data: entitlementRaw, error: entitlementErr } = await supabase.rpc(
                'fn_get_tournament_satellite_entitlement_depth',
                { p_tournament_id: this.tournamentId }
              );
              if (sweepStopped()) return;
              const entitlement = (
                Array.isArray(entitlementRaw) ? entitlementRaw[0] : entitlementRaw
              ) as {
                ok?: boolean;
                is_satellite?: boolean;
                ready?: boolean;
                award_depth?: number | string;
                reason?: string;
              } | null;
              const awardDepth = Number(entitlement?.award_depth);
              if (
                entitlementErr ||
                entitlement?.ok !== true ||
                entitlement?.is_satellite !== true ||
                entitlement?.ready !== true ||
                !Number.isSafeInteger(awardDepth) ||
                awardDepth < 0
              ) {
                if (!this.satelliteEntitlementUnreadableReported) {
                  this.satelliteEntitlementUnreadableReported = true;
                  reportError(
                    new Error(
                      `[Tournament:${this.tournamentId.slice(0, 8)}] hand-for-hand: immutable satellite entitlement depth unavailable (${entitlementErr?.message ?? entitlement?.reason ?? 'unreadable result'}) - bubble state left unchanged`
                    ),
                    'Tournament.satellite_entitlement_depth_unavailable'
                  );
                }
                this.requestUrgentEliminationSweepAfter(
                  TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS
                );
                return;
              }
              this.satelliteEntitlementUnreadableReported = false;
              // A finalized zero-pool/zero-seat satellite has no award
              // boundary. Zero is a complete plan, not a broken one. Clear a
              // stale pre-deploy H4H latch if this manager inherited one, and
              // never schedule error retries for an intentionally empty plan.
              if (awardDepth === 0) {
                if (this.handForHandActive) {
                  this.handForHandActive = false;
                  this.stopHandForHandSync();
                  await this.broadcast('bubble_burst', {
                    playersRemaining: playingNow,
                    paidPositions: 0,
                    reason: 'satellite_has_no_awards',
                  });
                  if (sweepStopped()) return;
                  for (const engine of this.tableEngines.values()) engine.resumeDealing();
                }
                break handForHandStage;
              }
              payoutCount = awardDepth;
            } else {
              // PAYOUT-INTEGRITY 2026-08-28: an unparseable column is UNKNOWN,
              // never the zero-place answer. Every ordinary MTT reader uses
              // the same strict parser, and final entry closure is the only
              // authority allowed to repair and persist its field-sized ladder.
              let paidPlaces = parsePayoutStructure(this.tournamentCache.payout_structure);
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
              }
              if (this.prizePoolFinalized && paidPlaces === null) {
                const repaired = await this.reconcileTournamentEntryWindow(
                  'engine.payout_structure_repair'
                );
                if (sweepStopped()) return;
                if (!repaired) return;
                paidPlaces = parsePayoutStructure(this.tournamentCache.payout_structure);
                if (paidPlaces === null) {
                  reportError(
                    new Error(
                      `[Tournament:${this.tournamentId.slice(0, 8)}] atomic entry-close replay returned no usable payout structure`
                    ),
                    'Tournament.payout_structure_repair_unproven'
                  );
                  this.requestUrgentEliminationSweepAfter(
                    TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS
                  );
                  return;
                }
              }
              payoutCount = paidPlaces?.length ?? 0;
            }

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
                if (sweepStopped()) return;
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
              if (sweepStopped()) return;
              // Resume all engines permanently
              for (const engine of this.tableEngines.values()) {
                engine.resumeDealing();
              }
            }
          }
        }
        if (completedStage(10)) return;
      }
      this.eliminationSweepCursor.reset();
      completedWholeSweep = true;
    } catch (err) {
      reportError(err, 'TournamentthistournamentIdslic.Elimination_check_error');
      // A detached/event wake is consumable: once this invocation throws,
      // the causal work is still unresolved. Re-drive only this manager after
      // a short bounded delay. Healthy tournaments do not poll; a known failed
      // attempt retains responsibility until a clean pass proves completion.
      if (!sweepStopped()) {
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
      }
    } finally {
      if (completedWholeSweep && this.running && !signal.aborted) {
        try {
          await acknowledgeCapturedWakes();
        } catch (ackErr) {
          // The row remains pending; never let an acknowledgement failure
          // strand the scheduler lock or turn an executed action into loss.
          reportError(ackErr, 'Tournament.manager_wake_ack_threw');
        }
      }
      if (this.eliminationSweepSignal === signal) this.eliminationSweepSignal = null;
      this.eliminationSweepDeadlineAt = 0;
      this.isProcessingEliminations = false;
      eliminationSweepsInflight.dec();
      eliminationSweepMs.observe(Date.now() - sweepStartedAt);
    }
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
    // The database maintenance trigger intentionally exempts service_role.
    // This manager uses that role, so the application boundary must freeze
    // before even identifying horses to charge. The durable decision deadline
    // is database-owned, so maintenance never advances or reconstructs it in
    // process memory; thaw emits the causal sweep that re-reads the same offer.
    if (isMaintenanceFrozen()) {
      return { rebought, answered };
    }
    const t = this.tournamentCache as
      | { is_rebuy?: boolean; rebuy_levels?: number | null; late_reg_levels?: number | null }
      | undefined;
    if (!t?.is_rebuy || bustedUserIds.length === 0) return { rebought, answered };
    if (!this.eliminationMutationAllowed()) return { rebought, answered };
    const batch = bustedUserIds.slice(0, TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE);
    if (bustedUserIds.length > batch.length) this.requestEliminationSweep();

    // The database owns the canonical window. Its policy deliberately folds
    // zero-valued settings through NULLIF fallbacks, extends the cap through
    // configured add-on levels, and closes at the exact boundary. Duplicating
    // only part of that policy here caused eligible horses to be silently
    // eliminated. The RPC is the cheap, authoritative refusal.

    try {
      const { data: horseRows, error: horseErr } = await supabase
        .from('profiles')
        .select('id')
        .in('id', batch)
        .eq('is_horse', true);
      if (!this.eliminationMutationAllowed()) return { rebought, answered };
      if (horseErr || !horseRows || horseRows.length === 0) return { rebought, answered };

      const declined = new Map<string, number>();
      for (const h of horseRows) {
        if (!this.eliminationMutationAllowed()) return { rebought, answered };
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
        if (!this.eliminationMutationAllowed()) return { rebought, answered };
        if (error) {
          declined.set(error.message, (declined.get(error.message) || 0) + 1);
          // A transport error can follow a committed purchase. Keep the
          // decision grace open and re-read chips next pass; never eliminate
          // this horse from a stale pre-rebuy snapshot.
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
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
  protected async tournamentTableForUser(
    userId: string
  ): Promise<{ tableId: string; joinedAt: string } | null> {
    try {
      const { data, error } = await supabase
        .from('table_seats')
        .select('table_id, joined_at, tables!inner(tournament_id)')
        .eq('user_id', userId)
        .eq('tables.tournament_id', this.tournamentId)
        .is('left_at', null)
        .limit(1)
        .maybeSingle(); // FIX 168: Bible safety rule — maybeSingle over single
      if (error) {
        reportError(error, 'Tournament.knockout_table_lookup_failed');
        return null;
      }
      const row = data as { table_id?: string; joined_at?: string } | null;
      return row?.table_id && row.joined_at
        ? { tableId: row.table_id, joinedAt: row.joined_at }
        : null;
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
  protected async lastTournamentTableForUser(
    userId: string
  ): Promise<{ tableId: string; joinedAt: string } | null> {
    try {
      const { data, error } = await supabase
        .from('table_seats')
        .select('table_id, joined_at, left_at, tables!inner(tournament_id)')
        .eq('user_id', userId)
        .eq('tables.tournament_id', this.tournamentId)
        .order('left_at', { ascending: false, nullsFirst: true })
        .limit(1);
      if (error) {
        reportError(error, 'Tournament.knockout_table_fallback_failed');
        return null;
      }
      const row = data?.[0] as { table_id?: string; joined_at?: string } | undefined;
      return row?.table_id && row.joined_at
        ? { tableId: row.table_id, joinedAt: row.joined_at }
        : null;
    } catch (err) {
      reportError(err, 'Tournament.knockout_table_fallback_threw');
      return null;
    }
  }

  /**
   * Load the one hand that is allowed to authorize a bounty elimination.
   *
   * Stack persistence and hand-history persistence are separate requests. A
   * safety sweep can therefore see tournament_players.chips=0 while the
   * knockout hand is still being inserted. Selecting "the latest hand this
   * player appeared in" is not safe: after a rebuy that can be an older bust
   * and pay the new head to the old winner. The successful stack-settlement
   * ledger records the exact accepted hand number and zero stack; the matching
   * history row must exist before eliminatePlayer may mutate status or release
   * the seat.
   *
   * Both records are durable, so this works after a manager/engine restart and
   * does not depend on an in-memory callback surviving. A queued history write
   * wakes the restored manager from GameServer when it lands; this short
   * coalesced retry covers transient reads and the narrow stack/history gap.
   */
  protected async loadPersistedBountyEvidence(
    userId: string,
    tableId: string,
    seatJoinedAt: string
  ): Promise<PersistedKnockoutEvidence | null> {
    const defer = (reason: string, cause?: unknown): null => {
      if (!this.bountyEvidenceDeferred.has(userId)) {
        this.bountyEvidenceDeferred.add(userId);
        const detail =
          cause && typeof cause === 'object' && 'message' in cause
            ? String((cause as { message?: unknown }).message ?? cause)
            : cause
              ? String(cause)
              : reason;
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] bounty elimination for ${userId.slice(0, 8)} deferred before status mutation: ${reason} (${detail})`
          ),
          'Tournament.bounty_attribution_deferred'
        );
      }
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
      return null;
    };

    try {
      // JSON containment finds the newest accepted settlement that wrote THIS
      // player to zero. It cannot select a later unrelated table hand (the
      // player is no longer dealt) and, ordered newest-first, cannot select an
      // earlier pre-rebuy bust when the current zero write exists.
      const { data: settlementRow, error: settlementErr } = await supabase
        .from('settlement_idempotency_keys')
        .select('result, completed_at')
        .eq('table_id', tableId)
        .eq('status', 'succeeded')
        .contains('result', { written: { [userId]: 0 } })
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (settlementErr)
        return defer('accepted zero-stack settlement is unreadable', settlementErr);

      const persisted = settlementRow as {
        result?: StackSettlementResult;
        completed_at?: string;
      } | null;
      const settlement = persisted?.result;
      const identity = acceptedZeroStackSettlement(settlement, userId);
      if (!identity || identity.tableId !== tableId) {
        return defer('no exact accepted zero-stack settlement exists yet');
      }
      // A rebuy/re-entry creates a new seat generation. Never authorize that
      // generation with an older zero-stack settlement, even if it came from
      // the same physical table and still has a perfectly valid history row.
      const settlementAt = Date.parse(String(persisted?.completed_at ?? ''));
      const joinedAt = Date.parse(seatJoinedAt);
      if (!Number.isFinite(settlementAt) || !Number.isFinite(joinedAt) || settlementAt < joinedAt) {
        return defer('accepted zero-stack settlement predates this seat generation');
      }

      const { data: hand, error: handErr } = await supabase
        .from('hand_history')
        .select('id, table_id, hand_number, winners, players, pots')
        .eq('hand_number', identity.handNumber)
        .maybeSingle();
      if (handErr) return defer(`knockout hand #${identity.handNumber} is unreadable`, handErr);

      const evidence = persistedKnockoutEvidence(settlement, hand, userId);
      if (!evidence.ready) {
        return defer(
          `knockout hand #${identity.handNumber} is not authoritative (${evidence.reason})`
        );
      }

      this.bountyEvidenceDeferred.delete(userId);
      return { ...evidence, settledAt: String(persisted?.completed_at ?? '') };
    } catch (err) {
      return defer('authoritative knockout lookup threw', err);
    }
  }

  /**
   * Drain the explicit, atomic knockout outbox.
   *
   * New eliminations create `tournament_bounty_obligations` in the SAME RPC
   * transaction as the playing/chips<=0 status CAS. The bounty-ledger insert
   * or completed mystery-award update acknowledges it by trigger in the SAME
   * payout transaction, so a lost HTTP response is already durable success.
   * The bounded database sweeper handles ordinary retry and managerless
   * COMPLETING recovery. Missing obligations are invariant failures in the
   * write path; recovery never manufactures them from mutable history.
   */
  protected async recoverPendingBountyObligations(
    tournament: any,
    comprehensive = false
  ): Promise<boolean> {
    const isBounty = Boolean(
      tournament?.is_bounty || tournament?.is_pko || tournament?.is_mystery_bounty
    );
    if (!isBounty) {
      this.bountyRecoveryAudited = true;
      return true;
    }

    try {
      if (comprehensive) {
        // One bounded database operation settles only durable pending outboxes.
        // SQL holds the tournament lock and limits each admission; it does not
        // scan eliminated players or reconstruct missing financial work.
        const { data: sweepData, error: sweepErr } = await supabase.rpc(
          'fn_sweep_pending_tournament_bounties',
          {
            p_tournament_id: this.tournamentId,
            p_limit: TournamentManagerEliminations.BOUNTY_RECOVERY_BATCH,
          }
        );
        const sweep = (sweepData ?? {}) as {
          ok?: boolean;
          pending?: number;
          failed?: number;
        };
        if (
          sweepErr ||
          sweep.ok !== true ||
          Number(sweep.failed || 0) > 0 ||
          Number(sweep.pending || 0) > 0
        ) {
          if (sweepErr || sweep.ok !== true) {
            reportError(
              sweepErr ?? new Error('bounded bounty recovery refused'),
              'Tournament.bounty_recovery_sweep_failed'
            );
          }
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
          return false;
        }
        this.bountyRecoveryAudited = true;
        return true;
      }

      const { data: hasPending, error: pendingErr } = await supabase.rpc(
        'fn_tournament_has_unsettled_bounties',
        { p_tournament_id: this.tournamentId }
      );
      if (pendingErr) {
        reportError(pendingErr, 'Tournament.bounty_outbox_verdict_failed');
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        return false;
      }
      // A committed pending row owns its own event-driven recovery signal.
      // Do not turn every manager sweep into a five-second correctness loop;
      // the settled UPDATE (plus the sweeper's direct same-process wake) will
      // re-admit this manager when its money path has actually completed.
      if (hasPending !== false) return false;
      return true;
    } catch (err) {
      reportError(err, 'Tournament.bounty_recovery_threw');
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
      return false;
    }
  }

  protected async eliminatePlayer(
    userId: string,
    position: number,
    allowCompletingClaim = false
  ): Promise<boolean> {
    if (!this.eliminationMutationAllowed()) return false;
    // Guard: check if already eliminated (prevents double-processing)
    const { data: playerCheck, error: checkErr } = await supabase
      .from('tournament_players')
      .select('status')
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!this.eliminationMutationAllowed()) return false;

    if (
      checkErr ||
      !playerCheck ||
      playerCheck.status === 'eliminated' ||
      playerCheck.status === 'winner'
    ) {
      // Both elimination functions release the exact locked seat generation
      // in their database transaction. A later user-scoped cleanup would be
      // able to close a legitimate rebuy seat, so replay stops here.
      return false; // Already processed
    }

    const { data: tournament, error: tournamentErr } = await supabase
      .from('tournaments')
      .select(
        // spin_multiplier + tournament_type: a Spin's payout split is a pure
        // function of its multiplier, so the spec can rebuild the structure
        // when the stored column is unreadable. See payoutStructure.ts.
        'payout_structure, prize_pool, is_bounty, is_pko, is_mystery_bounty, bounty_amount, mystery_bounty_min, mystery_bounty_max, variant, tournament_type, satellite_target_id, spin_multiplier'
      )
      .eq('id', this.tournamentId)
      .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
    if (!this.eliminationMutationAllowed()) return false;

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
     * the same null row). The terminal atomic settlement derives any Bubble
     * Protection promise later from the complete finalized field.
     *
     * Not stamping anything is strictly recoverable: the player still has 0
     * chips and the next scheduled or event-driven sweep retries with a readable row.
     */
    if (tournamentErr || !tournament) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] cannot price place ${position} for ${userId.slice(0, 8)} - tournament row unreadable (${tournamentErr?.message ?? 'no row'}). Eliminating nobody; the next sweep retries.`
        ),
        'Tournament.elimination_tournament_unreadable'
      );
      return false;
    }

    const hasBounty = Boolean(
      tournament.is_bounty || tournament.is_pko || tournament.is_mystery_bounty
    );
    // Capture the table and prove the exact knockout BEFORE the status CAS.
    // If history is still queued, this returns false and no position, payout,
    // status, or seat mutation below can occur.
    const liveBustedSeat = await this.tournamentTableForUser(userId);
    if (!this.eliminationMutationAllowed()) return false;
    const bountySeat = hasBounty
      ? (liveBustedSeat ?? (await this.lastTournamentTableForUser(userId)))
      : liveBustedSeat;
    if (!this.eliminationMutationAllowed()) return false;
    const bountyEvidence = hasBounty
      ? bountySeat
        ? await this.loadPersistedBountyEvidence(userId, bountySeat.tableId, bountySeat.joinedAt)
        : null
      : null;
    if (!this.eliminationMutationAllowed()) return false;
    if (hasBounty && !bountyEvidence) {
      if (!bountySeat) {
        if (!this.bountyEvidenceDeferred.has(userId)) {
          this.bountyEvidenceDeferred.add(userId);
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] bounty elimination for ${userId.slice(0, 8)} deferred before status mutation: no tournament table can be attributed`
            ),
            'Tournament.bounty_attribution_deferred'
          );
        }
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
      }
      return false;
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
      String((tournament as any)?.variant ?? '').toLowerCase() === 'satellite' ||
      String((tournament as any)?.tournament_type ?? '').toUpperCase() === 'SATELLITE' ||
      !!(tournament as any)?.satellite_target_id;
    if (!isSatellite && tournament) {
      // resolvePayoutStructure parses the stored column and, for a Spin whose
      // column is missing or malformed, rebuilds it from the canonical spec.
      // Places 2..N are priced HERE and recorded as result facts; the terminal
      // atomic batch pays them later. Both stages resolve the same contract, so
      // a Spin that can reconstruct its exact split keeps the reads aligned.
      // SHORT-FIELD RESIDUAL 2026-08-27: pay by a structure the field can
      // actually fill, so the leftover lands on a place somebody reached. The
      // second belt, on top of finalFieldSize's own two: never trim below the
      // place being priced right now. A field smaller than the position being
      // paid could only mean the count is wrong, and acting on it would
      // promote this player to residual holder and overpay them.
      const field = await this.finalFieldSize();
      if (!this.eliminationMutationAllowed()) return false;
      if (field === null) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] finalized field size is unreadable; refusing to price place ${position}`
          ),
          'Tournament.final_field_size_unreadable'
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        return false;
      }
      const safeField = field !== undefined && field >= position ? field : undefined;
      const payouts = resolvePayoutStructure(tournament as any, safeField);
      if (payouts) {
        prize = computePlacePrize(Number(tournament.prize_pool || 0), payouts, position);
      }
    }

    // Elimination records a provisional result, never a Bubble payment. The
    // terminal database batch derives the one canonical stone-bubble holder
    // from finalized standings and the frozen buy-in contract, then pays that
    // refund together with every place or rolls the whole settlement back.
    const bubbleRefund = 0;

    let bountyMode: string | null = null;
    let durableBountyKnocker: string | null = null;
    let durableBountyClaimants: Array<{ userId: string; weight: number }> = [];
    if (hasBounty) {
      if (!this.eliminationMutationAllowed()) return false;
      const attribution = bountyEvidence!.attribution;
      const { data: claimData, error: claimErr } = await supabase.rpc(
        'fn_claim_tournament_bounty_elimination',
        {
          p_tournament_id: this.tournamentId,
          p_eliminated_user_id: userId,
          p_position: position,
          p_prize: prize,
          p_table_id: bountyEvidence!.tableId,
          p_hand_id: bountyEvidence!.handId,
          p_hand_number: bountyEvidence!.handNumber,
          p_seat_joined_at: bountySeat!.joinedAt,
          p_knocker_user_id: attribution.knockerUserId!,
          p_claimants: attribution.claimants.map((claimant) => ({
            user_id: claimant.userId,
            weight: claimant.weight,
          })),
          p_bubble_refund: bubbleRefund,
          // The ordinary sweep claims only RUNNING. finishTournament already
          // owns RUNNING->COMPLETING and may discover a zero survivor whose
          // claim queued behind that lock; its explicit fallback is allowed to
          // create the same exact-evidence outbox while COMPLETING.
          p_allow_existing_eliminated: allowCompletingClaim,
        }
      );
      const claim = (claimData ?? {}) as {
        ok?: boolean;
        claimed?: boolean;
        already?: boolean;
        mode?: string;
        reason?: string;
      };
      const semanticClaimAccepted =
        !claimErr && claim.ok === true && (claim.claimed === true || claim.already === true);

      // Every continuation, including an HTTP response-loss recovery, reloads
      // the exact generation-bound record. The local attribution is only a
      // proposal to fn_claim; durable canonical claimants, knocker, placement
      // and mode are the sole authority after that RPC returns.
      const { data: existing, error: existingErr } = await supabase
        .from('tournament_bounty_obligations')
        .select(
          'id,table_id,hand_id,hand_number,mode,state,knocker_user_id,claimants,position,prize,bubble_refund'
        )
        .eq('tournament_id', this.tournamentId)
        .eq('eliminated_user_id', userId)
        .eq('seat_joined_at', bountySeat!.joinedAt)
        .eq('hand_id', bountyEvidence!.handId)
        .maybeSingle();
      const row = existing as {
        id?: string;
        table_id?: string;
        hand_id?: string;
        hand_number?: number;
        mode?: string;
        state?: string;
        knocker_user_id?: string;
        claimants?: unknown;
        position?: number;
        prize?: number;
        bubble_refund?: number;
      } | null;
      const canonicalClaims = Array.isArray(row?.claimants)
        ? row!.claimants
            .map((entry: unknown) => {
              const item = entry as { user_id?: unknown; weight?: unknown };
              return { userId: String(item?.user_id ?? ''), weight: Number(item?.weight) };
            })
            .filter((entry) => entry.userId && Number.isFinite(entry.weight) && entry.weight > 0)
        : [];
      const durableRecordMatches =
        !existingErr &&
        !!row?.id &&
        row.table_id === bountyEvidence!.tableId &&
        row.hand_id === bountyEvidence!.handId &&
        Number(row.hand_number) === bountyEvidence!.handNumber &&
        Number(row.position) === position &&
        Math.round(Number(row.prize) * 100) === Math.round(prize * 100) &&
        Math.round(Number(row.bubble_refund) * 100) === Math.round(bubbleRefund * 100) &&
        !!row.knocker_user_id &&
        canonicalClaims.length > 0;

      // A logical `{ok:false}` is an authoritative refusal, not an ambiguous
      // response. Only a transport error may be recovered from a matching
      // durable commit marker.
      const durableClaim = semanticClaimAccepted
        ? durableRecordMatches
        : !!claimErr && durableRecordMatches;
      if (!durableClaim) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] atomic bounty elimination claim FAILED for ${userId.slice(0, 8)} at place ${position}: ${claimErr?.message ?? claim.reason ?? 'CAS missed'}`
          ),
          'Tournament.bounty_elimination_claim_failed'
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        return false;
      }
      bountyMode = String(row!.mode || '');
      durableBountyKnocker = String(row!.knocker_user_id || '');
      durableBountyClaimants = canonicalClaims;
      // An `already` row is the replay of that exact generation, not permission
      // to run a place or Bubble payer here.
    } else {
      if (!this.eliminationMutationAllowed()) return false;
      // Result, exact status CAS and tournament-scoped seat release are one
      // transaction. Place and Bubble money wait for the finalized terminal
      // batch. A transport failure is ambiguous, so replay the same idempotent
      // RPC once; its locked exact-position/prize and knockout-generation
      // checks turn a lost successful response into `{ already: true }`.
      const eliminationRequest = {
        p_tournament_id: this.tournamentId,
        p_user_id: userId,
        p_position: position,
        p_prize: prize,
        p_bubble_refund: bubbleRefund,
      };
      let eliminationResponse = await supabase.rpc(
        'fn_eliminate_tournament_player_atomic',
        eliminationRequest
      );
      if (eliminationResponse.error) {
        eliminationResponse = await supabase.rpc(
          'fn_eliminate_tournament_player_atomic',
          eliminationRequest
        );
      }
      const { data: updateData, error: updateErr } = eliminationResponse;
      const update = (updateData ?? {}) as {
        ok?: boolean;
        claimed?: boolean;
        already?: boolean;
        reason?: string;
      };
      const eliminationReceiptAccepted =
        !updateErr && update.ok === true && (update.claimed === true || update.already === true);
      if (!eliminationReceiptAccepted) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] atomic elimination FAILED for ${userId.slice(0, 8)} at place ${position} after exact transport replay: ${updateErr?.message ?? update.reason ?? 'no accepted commit receipt'}`
          ),
          'Tournament.elimination_write_failed'
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        return false;
      }
    }

    /* Dan 2026-08-23: "they must be removed from the table... it currently
       doesn't remove them."

       The seat release used to sit at the very BOTTOM of this method, behind
       the bounty block — a knocker lookup, a 10-row hand_history scan and an
       RPC, every one of them an awaited round-trip, all wrapped in a try that
       swallows. A player whose bust triggered any of that stayed visibly
       seated for the duration, and the former polling sweep could already lag the bust by
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
    // Bounty claims release the exact table+joined_at generation atomically.
    // A broad post-response release is unsafe: the response can be delayed
    // until after a settled player re-enters, at which point it would close
    // the new live seat. Both atomic elimination RPCs already release the
    // tournament-scoped seat they locked; no second application write follows.

    /* RESULT, SEAT RELEASE AND BOUNTY OUTBOX SHARE THE ELIMINATION COMMIT.
       The atomic elimination RPC records the provisional place, releases the
       locked seat, and, for bounty events, records the exact knockout outbox.
       It moves no place or Bubble money. Tournament completion normalizes the
       final standings and pays the immutable place-plus-Bubble plan in one
       all-or-none database transaction. */

    // ── BOUNTY / PKO / MYSTERY BOUNTY COLLECTION ──
    // Determine who knocked this player out by finding the last hand winner at their table
    if (bountyEvidence) {
      try {
        const { attribution } = bountyEvidence;
        if (attribution.basis === 'largest_winner') {
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] knockout attribution used the legacy ` +
              `largest-winner fallback for ${userId.slice(0, 8)} (hand ${bountyEvidence.handId})`
          );
        }
        const bountySettled = await this.processBountyCollection(
          tournament,
          userId,
          durableBountyKnocker || attribution.knockerUserId!,
          bountyEvidence.tableId,
          durableBountyClaimants.length > 0
            ? durableBountyClaimants
            : attribution.claimants.map((claimant) => ({ ...claimant })),
          bountyEvidence.handId,
          bountyMode
        );
        if (!bountySettled) {
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
          return false;
        }
      } catch (bountyErr) {
        reportError(bountyErr, 'TournamentthistournamentIdslic.Bounty_processing_error');
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        return false;
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
    // Seat release happens inside the atomic status/settlement transaction.

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
    return true;
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
    handId: string | null = null,
    /** Persisted by the atomic elimination RPC; never re-derived from stage. */
    persistedMode: string | null = null
  ): Promise<boolean> {
    // ── MYSTERY PHASE ──────────────────────────────────────────────────────
    // Once the chests are open, this knockout draws one. fn_collect_bounty
    // refuses in that state ('mystery_phase_active'), so this is not an
    // optimisation — it is the only path that pays.
    if (
      (persistedMode === 'mystery_chest' ||
        (persistedMode === null && this.mysteryBountyStage === 'active')) &&
      tournament?.is_mystery_bounty
    ) {
      return this.processMysteryBountyKnockout(
        eliminatedUserId,
        knockerUserId,
        tableId,
        claimants,
        handId
      );
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

    let res = (result ?? {}) as {
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
      marker_verified?: boolean;
      obligation_id?: string;
    };

    // An RPC response can be lost after PostgreSQL committed. Read the exact
    // generation marker before classifying a transport error; a semantic
    // `{ok:false}` remains an authoritative refusal and is never overridden.
    const { data: settledObligation, error: settledObligationErr } = await supabase
      .from('tournament_bounty_obligations')
      .select('id,state,mode,head_amount')
      .eq('tournament_id', this.tournamentId)
      .eq('eliminated_user_id', eliminatedUserId)
      .eq('hand_id', handId)
      .maybeSingle();

    if (error) {
      if (!settledObligationErr && settledObligation?.state === 'settled') {
        const { data: markerComplete, error: markerCompleteErr } = await supabase.rpc(
          'fn_bounty_obligation_has_complete_marker',
          { p_obligation_id: settledObligation.id }
        );
        const { data: markerRows, error: markerErr } = await supabase
          .from('tournament_bounties')
          .select('collector_player_id,bounty_amount,added_to_collector_bounty')
          .eq('bounty_obligation_id', settledObligation.id);
        if (
          !markerCompleteErr &&
          markerComplete === true &&
          !markerErr &&
          markerRows &&
          markerRows.length > 0
        ) {
          const shares = markerRows.map((row) => ({
            user_id: String(row.collector_player_id),
            // tournament_bounties.bounty_amount is the full claimant share;
            // PKO's head increment is a component of it, not extra money.
            cash: Math.max(
              0,
              (Number(row.bounty_amount) || 0) - (Number(row.added_to_collector_bounty) || 0)
            ),
            to_head: Number(row.added_to_collector_bounty) || 0,
          }));
          res = {
            ok: true,
            mode: String(settledObligation.mode || persistedMode || ''),
            head: Number(settledObligation.head_amount) || 0,
            paid_cash: shares.reduce((sum, share) => sum + share.cash, 0),
            added_to_head: shares.reduce((sum, share) => sum + share.to_head, 0),
            shares,
            split: shares.length > 1,
            marker_verified: true,
            obligation_id: String(settledObligation.id),
          };
        }
      }
      if (res.ok !== true) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: bounty collection FAILED for knocker ${knockerUserId.slice(0, 8)} over ${eliminatedUserId.slice(0, 8)}: ${error.message}`
          ),
          'Tournament.bounty_collection_failed'
        );
        return false;
      }
    }

    if (!res.ok) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty not collected (${res.reason}) for ${eliminatedUserId.slice(0, 8)}`
        ),
        'Tournament.bounty_not_collected'
      );
      return false;
    }

    // An RPC answer is not a money marker. The wrapper/ledger transaction
    // settles the exact generation outbox only after every canonical share
    // and the full head amount are durable; reread that state before any
    // success broadcast or before allowing the placement loop to advance.
    if (
      settledObligationErr ||
      settledObligation?.state !== 'settled' ||
      res.marker_verified !== true
    ) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty payer returned without a settled exact-generation marker for ${eliminatedUserId.slice(0, 8)} hand ${String(handId).slice(0, 8)}`
        ),
        'Tournament.bounty_marker_not_settled'
      );
      return false;
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
    return true;
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
  private async mysteryAwardSettlementProven(awardId: string): Promise<boolean> {
    const { data: award, error: awardErr } = await supabase
      .from('tournament_bounty_awards')
      .select('status,bounty_obligation_id')
      .eq('id', awardId)
      .maybeSingle();
    if (awardErr || award?.status !== 'completed' || !award?.bounty_obligation_id) {
      return false;
    }
    const { data: obligation, error: obligationErr } = await supabase
      .from('tournament_bounty_obligations')
      .select('state')
      .eq('id', award.bounty_obligation_id)
      .maybeSingle();
    if (obligationErr || obligation?.state !== 'settled') return false;
    const { data: marker, error: markerErr } = await supabase.rpc(
      'fn_bounty_obligation_has_complete_marker',
      { p_obligation_id: award.bounty_obligation_id }
    );
    const markerValue = Array.isArray(marker) ? marker[0] : marker;
    return !markerErr && markerValue === true;
  }

  protected async processMysteryBountyKnockout(
    eliminatedUserId: string,
    knockerUserId: string,
    tableId: string | null,
    claimants: Array<{ userId: string; weight: number }>,
    handId: string | null = null
  ): Promise<boolean> {
    const recipients = buildRecipientClaims(knockerUserId, claimants);
    if (recipients.length === 0) return false;

    // op_id makes THIS call idempotent; the award's unique
    // (tournament, eliminated) key makes the whole knockout idempotent. The
    // op id is derived from the knockout rather than random so that a retry of
    // the same sweep pass presents the same id.
    const opId = nodeCrypto
      .createHash('sha256')
      .update(`mb:${this.tournamentId}:${eliminatedUserId}:${handId ?? 'legacy'}`)
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

    let res = (reserved ?? {}) as {
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

    // Reserve is atomic with its obligation-bound award. If the HTTP response
    // is lost, recover only from that exact hand's durable outbox+award; never
    // infer success from a user-level historical chest.
    if (reserveErr) {
      const { data: obligation, error: obligationErr } = await supabase
        .from('tournament_bounty_obligations')
        .select('id,mode')
        .eq('tournament_id', this.tournamentId)
        .eq('eliminated_user_id', eliminatedUserId)
        .eq('hand_id', handId)
        .maybeSingle();
      if (!obligationErr && obligation?.mode === 'mystery_chest') {
        const { data: award, error: awardErr } = await supabase
          .from('tournament_bounty_awards')
          .select('id,status')
          .eq('bounty_obligation_id', obligation.id)
          .maybeSingle();
        if (!awardErr && award?.id) {
          const { data: recipientRows, error: recipientsErr } = await supabase
            .from('tournament_bounty_award_recipients')
            .select('user_id,is_designated_revealer')
            .eq('award_id', award.id);
          if (!recipientsErr && recipientRows && recipientRows.length > 0) {
            const designated = recipientRows.find(
              (recipient) => recipient.is_designated_revealer === true
            );
            res = {
              ok: true,
              already: true,
              status: String(award.status || ''),
              award_id: String(award.id),
              designated_revealer: String(designated?.user_id || knockerUserId),
              recipient_user_ids: recipientRows.map((recipient) => String(recipient.user_id)),
            };
          }
        }
      }
      if (res.ok !== true || !res.award_id) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: mystery bounty reserve FAILED for ${eliminatedUserId.slice(0, 8)}: ${reserveErr.message}`
          ),
          'Tournament.mystery_bounty_reserve_failed'
        );
        return false;
      }
    }

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
      return false;
    }

    // Already completed on an earlier pass — nothing to re-announce.
    if (res.already && res.status === 'completed') {
      return this.mysteryAwardSettlementProven(res.award_id);
    }

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
    return false;
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
      q.coalesceTimer = this.setLifecycleTimeout(() => {
        const live = this.bountyRevealQueues.get(key);
        if (live) live.coalesceTimer = null;
        return this.pumpBountyRevealQueue(key);
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
    const lifecycle = this.captureLifecycleToken();
    if (!this.lifecycleIsCurrent(lifecycle)) return;
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
        if (!this.lifecycleIsCurrent(lifecycle)) return;
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
      if (!this.lifecycleIsCurrent(lifecycle)) return;
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
      if (!this.lifecycleIsCurrent(lifecycle)) return;
    } catch (err) {
      reportError(err, 'Tournament.mystery_bounty_pending_broadcast_failed');
    }

    // The reveal, on the deadline. The designated revealer's own tap normally
    // gets there first (from the browser, which is the drama); this call is
    // idempotent and returns the identical payload, so section 54's "auto
    // reveal so a table can never wedge" costs nothing when they did tap and
    // saves the table when they did not.
    const timer = this.setLifecycleTimeout(() => {
      return (async () => {
        let settled = false;
        try {
          settled = await this.settleMysteryBountyAward(
            next.awardId,
            next.tableId,
            next.eliminatedUserId,
            queueIndex,
            queueTotal
          );
        } catch (err) {
          reportError(err, 'Tournament.mystery_bounty_settle_threw');
        } finally {
          if (this.lifecycleIsCurrent(lifecycle)) {
            if (!settled) {
              // Keep the exact same durable award in this table's queue. The
              // dedupe remains set while queued, so another sweep cannot add a
              // second presentation; the retry starts only after this reveal
              // gate is released by finishBountyReveal.
              const live = this.bountyRevealQueues.get(key);
              if (live && !live.waiting.some((item) => item.awardId === next.awardId)) {
                live.waiting.push(next);
              }
              this.requestUrgentEliminationSweepAfter(
                TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS
              );
            }
            this.finishBountyReveal(key, next);
          }
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
    const settle = this.setLifecycleTimeout(() => {
      this.closeBountyGate(item.tableId, item.awardId);
      const q = this.bountyRevealQueues.get(key);
      if (q && q.active?.awardId === item.awardId) q.active = null;
      return this.pumpBountyRevealQueue(key);
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
  protected async reconcileMysteryBounty(winnerId: string | null): Promise<boolean> {
    if (!this.tournamentCache?.is_mystery_bounty) return true;
    if (this.mysteryBountyStage === 'pending') return true;
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
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        return false;
      }
      const res = (data ?? {}) as {
        ok?: boolean;
        balanced?: boolean;
        pool_cents?: number;
        settled_cents?: number;
        unclaimed_cents?: number;
        variance_cents?: number;
      };
      if (res.ok !== true) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] mystery bounty settlement REFUSED: ${(res as { reason?: string }).reason ?? 'unknown'}`
          ),
          'Tournament.mystery_bounty_settle_refused'
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        return false;
      }
      if (res.balanced === false) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: mystery bounty DOES NOT RECONCILE - pool ${res.pool_cents}c, settled ${res.settled_cents}c, variance ${res.variance_cents}c`
          ),
          'Tournament.mystery_bounty_unbalanced'
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        return false;
      } else {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Mystery bounty reconciled exactly: ${res.settled_cents}c of ${res.pool_cents}c (${res.unclaimed_cents}c unclaimed to champion)`
        );
      }
      this.mysteryBountyStage = 'complete';
      return true;
    } catch (err) {
      reportError(err, 'Tournament.mystery_bounty_settle_threw');
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
      return false;
    }
  }

  /** Reveal (idempotently), pay, and tell the table what was in the chest. */
  protected async settleMysteryBountyAward(
    awardId: string,
    tableId: string | null,
    eliminatedUserId: string,
    queueIndex: number,
    queueTotal: number
  ): Promise<boolean> {
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
        return false;
      }
      const rev = revealed as {
        amount_cents: number;
        tier: string;
        is_jackpot: boolean;
        recipients: Array<{ user_id: string; amount_cents: number }>;
      };

      // PAY BEFORE BROADCASTING. If the credit fails, nobody should have been
      // shown a number they are not going to receive.
      const { data: paid, error: payErr } = await supabase.rpc('fn_mystery_bounty_pay', {
        p_award_id: awardId,
      });
      const pay = (paid ?? {}) as { ok?: boolean; refused_recipients?: number };

      // Read the durable state even when the transport says the call failed:
      // PostgreSQL may have committed immediately before the response was
      // lost. A semantic `{ok:false}` is still authoritative; only a transport
      // ambiguity may be recovered from an exact completed award marker.
      const { data: award, error: awardErr } = await supabase
        .from('tournament_bounty_awards')
        .select('status,bounty_obligation_id')
        .eq('id', awardId)
        .maybeSingle();
      const settlementProven =
        !awardErr && award?.status === 'completed'
          ? await this.mysteryAwardSettlementProven(awardId)
          : false;
      const recoveredLostPayResponse = !!payErr && settlementProven;
      if (
        (payErr && !recoveredLostPayResponse) ||
        (!payErr && (pay.ok !== true || Number(pay.refused_recipients ?? 0) > 0))
      ) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: mystery bounty PAY FAILED for award ${awardId} (${rev.amount_cents}c): ${payErr?.message ?? `${Number(pay.refused_recipients ?? 0)} recipient(s) refused`}`
          ),
          'Tournament.mystery_bounty_pay_failed'
        );
        return false;
      }

      // `ok` means the payer ran. A refused recipient deliberately keeps the
      // award retryable, so only the durable completed marker may authorize
      // the reveal broadcast and release the outbox.
      if (awardErr || award?.status !== 'completed' || !settlementProven) {
        reportError(
          awardErr ??
            new Error(
              `award ${awardId} remained ${award?.status ?? 'missing'} or its exact obligation marker was not settled`
            ),
          'Tournament.mystery_bounty_pay_not_completed'
        );
        return false;
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
      return true;
    } catch (err) {
      reportError(err, 'Tournament.mystery_bounty_settle_threw');
      return false;
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
   * When the prize pool grows during late reg, early eliminations recorded
   * smaller prizes. This rewrites every paid-place entitlement now that the
   * final pool is known; the atomic finish moves the money later.
   */
  protected async recalculateEliminatedPrizes(finalPrizePool: number): Promise<boolean> {
    const { data: eliminated, error: eliminatedErr } = await supabase
      .from('tournament_players')
      .select('user_id, position, prize')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'eliminated');

    /* Zero cannot be used as the ITM filter. A guaranteed freeroll that ends
       before its usual funding point records every early prize as zero; those
       are precisely the rows this final reprice must promote after the funded
       pool arrives. The published structure below selects the paid places. */

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
      return false;
    }
    if (!eliminated || eliminated.length === 0) return true;

    // PAYOUT-INTEGRITY 2026-08-25: use the SHARED structure resolver, not a
    // bare parse of the cached column. resolvePayoutStructure rebuilds a
    // Spin's split from its multiplier when the stored column is unusable,
    // which is the same rule both live payout sites follow — parsing the
    // column here meant a top-up computed from a DIFFERENT structure than the
    // payment it is topping up.
    const finalField = await this.finalFieldSize();
    if (typeof finalField !== 'number') {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] prize recalc ABORTED - finalized field size is unreadable`
        ),
        'Tournament.prize_recalc_field_unreadable'
      );
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
      return false;
    }
    const payouts = resolvePayoutStructure(this.tournamentCache as any, finalField);
    if (!payouts || payouts.length === 0) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] prize recalc ABORTED - final payout structure is unreadable`
        ),
        'Tournament.prize_recalc_structure_unreadable'
      );
      return false;
    }

    let complete = true;
    let mutations = 0;
    for (const player of eliminated) {
      const payoutEntry = payouts.find((p: any) => Number(p.place) === Number(player.position));
      const correctPrize = payoutEntry
        ? computePlacePrize(finalPrizePool, payouts, Number(player.position))
        : 0;

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
      const difference = Math.round((correctPrize - (player.prize || 0)) * 100) / 100;

      if (Math.abs(difference) >= 0.005) {
        if (
          mutations >= TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE ||
          this.eliminationWorkBudgetExpired()
        ) {
          complete = false;
          break;
        }
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Prize recalc: ${player.user_id.slice(0, 8)} pos ${player.position} - old: ${player.prize}, new: ${correctPrize}, diff: ${difference >= 0 ? '+' : ''}${difference}`
        );

        /* Repricing changes the durable entitlement only. Both increases and
           decreases are safe before the batch is prepared because no place
           money has moved. A transitional event with older payout evidence is
           still protected: prepare seeds that evidence and refuses any amount
           already paid above the frozen plan; nothing is clawed back. */
        const { error: recordErr } = await supabase
          .from('tournament_players')
          .update({ prize: correctPrize })
          .eq('tournament_id', this.tournamentId)
          .eq('user_id', player.user_id);
        if (recordErr) {
          complete = false;
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] prize recalc could not record prize=${correctPrize} for ${player.user_id.slice(0, 8)}: ${recordErr.message}; atomic completion will refuse an incomplete prize set`
            ),
            'Tournament.prize_recalc_record_failed'
          );
        } else {
          mutations++;
        }
      }
    }
    if (!complete) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
    }
    return complete;
  }

  protected tournamentFinished = false;

  // ── FINAL TABLE DEAL (2026-08-22 parity) ─────────────────────────────────
  protected finalTableDealHandled = false;
  /**
   * A durable deal commit whose operational tail still needs to finish.
   *
   * This is deliberately checked before finalTableDealHandled and
   * tournamentFinished. Those latches prevent a second money attempt; this
   * one keeps the non-money tail reachable until tables and seats are closed.
   */
  private committedFinalTableDealCleanupPending = false;
  /** A terminal result is important, but it may never hold seats/tables open. */
  private static readonly COMMITTED_BROADCAST_ATTEMPTS = 3;
  /** Exact engine instance held between hands while a unanimous deal settles. */
  private finalTableDealPause: { tableId: string; engine: ServerTableEngine } | null = null;
  /** Long enough for a full live hand plus the guarantee and settlement calls. */
  private static readonly FINAL_TABLE_DEAL_PAUSE_MS = 15 * 60_000;
  private lastDealPollAt = 0;
  private lastDealVoteCount = -1;

  /** Read terminal truth independently of an RPC response that may be lost. */
  private async readDurableTournamentStatus(): Promise<{
    status: string | null;
    error: string | null;
  }> {
    try {
      const { data, error } = await supabase
        .from('tournaments')
        .select('status')
        .eq('id', this.tournamentId)
        .maybeSingle();
      return {
        status: typeof data?.status === 'string' ? data.status : null,
        error: error?.message ?? null,
      };
    } catch (error) {
      return {
        status: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Deliver a committed, non-money outcome before terminal teardown.
   *
   * Realtime REST can fail transiently and `broadcast()` reports that as
   * `false`; ignoring the receipt permanently stranded the result card after
   * the manager stopped. Retry a small bounded number of times here. If every
   * attempt fails, physical cleanup still proceeds and TablePage reconstructs
   * the same result from the durable COMPLETED/player rows.
   */
  private async broadcastCommittedOutcome(eventType: string, payload: unknown): Promise<boolean> {
    for (
      let attempt = 1;
      attempt <= TournamentManagerEliminations.COMMITTED_BROADCAST_ATTEMPTS;
      attempt++
    ) {
      if (await this.broadcast(eventType, payload)) return true;
      if (attempt < TournamentManagerEliminations.COMMITTED_BROADCAST_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
      }
    }
    reportError(
      new Error(
        `[Tournament:${this.tournamentId.slice(0, 8)}] committed ${eventType} announcement exhausted ${TournamentManagerEliminations.COMMITTED_BROADCAST_ATTEMPTS} attempts; durable client recovery remains authoritative`
      ),
      'Tournament.committed_outcome_broadcast_exhausted',
      { tournamentId: this.tournamentId, eventType }
    );
    return false;
  }

  /**
   * The single non-money terminal tail for every durably committed finish.
   *
   * Every database mutation is idempotent. A transient failure returns false
   * with the manager alive and every unresolved engine handle retained,
   * allowing the cleanup-only branch to retry without touching a payout
   * function.
   */
  private async cleanupCommittedTablesAndManager(): Promise<boolean> {
    let tournamentTables: Array<{ id: string }>;
    try {
      const { data, error } = await supabase
        .from('tables')
        .select('id')
        .eq('tournament_id', this.tournamentId);
      if (error || !data) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] committed cleanup could not list tables: ${error?.message ?? 'no rows returned'}`
          ),
          'Tournament.committed_cleanup_table_list_failed'
        );
        return false;
      }
      tournamentTables = data as Array<{ id: string }>;
    } catch (error) {
      reportError(error, 'Tournament.committed_cleanup_table_list_threw');
      return false;
    }

    const tableIds = tournamentTables.map(({ id }) => id).filter(Boolean);
    const durableTableIds = new Set(tableIds);
    let cleanupComplete = true;
    const stoppedManagerEngineIds = new Set<string>();
    for (const [tableId, engine] of this.tableEngines) {
      // A manager-map entry alone does not prove this engine belongs to the
      // committed tournament. Never stop it until the authoritative tables
      // query above establishes that provenance.
      if (!durableTableIds.has(tableId)) {
        cleanupComplete = false;
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] committed cleanup retained manager-only engine ${tableId.slice(0, 8)} because no durable tournament table proves its ownership`
          ),
          'Tournament.committed_cleanup_engine_provenance_missing'
        );
        continue;
      }
      try {
        await engine.stop();
        stoppedManagerEngineIds.add(tableId);
      } catch (error) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] committed cleanup could not stop engine ${tableId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`
          ),
          'Tournament.committed_cleanup_engine_stop_failed'
        );
      }
    }

    const leftAt = new Date().toISOString();
    for (let offset = 0; offset < tableIds.length; offset += IN_LIST_CHUNK) {
      try {
        const { error } = await supabase
          .from('table_seats')
          .update({ left_at: leftAt })
          .in('table_id', tableIds.slice(offset, offset + IN_LIST_CHUNK))
          .is('left_at', null);
        if (error) {
          cleanupComplete = false;
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] committed seat release failed: ${error.message}`
            ),
            'Tournament.committed_cleanup_seat_release_failed'
          );
        }
      } catch (error) {
        cleanupComplete = false;
        reportError(error, 'Tournament.committed_cleanup_seat_release_threw');
      }
    }

    let tablesDurablyClosed = false;
    try {
      const { error } = await supabase
        .from('tables')
        .update({ status: 'closed' })
        .eq('tournament_id', this.tournamentId)
        .neq('status', 'closed');
      if (error) {
        cleanupComplete = false;
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] committed table closure failed: ${error.message}`
          ),
          'Tournament.committed_cleanup_table_close_failed'
        );
      } else {
        tablesDurablyClosed = true;
      }
    } catch (error) {
      cleanupComplete = false;
      reportError(error, 'Tournament.committed_cleanup_table_close_threw');
    }

    if (tablesDurablyClosed) {
      // Unregister only after durable closure. If GameServer now holds a
      // replacement (or the manager forgot a durable table), stop that current
      // owner through the fresh-status-checked terminal path. Exact-instance
      // guards on both removals prevent this old manager from erasing a newer
      // dealer while either stop awaits I/O.
      for (const tableId of tableIds) {
        const managerEngine = this.tableEngines.get(tableId);
        if (managerEngine && !stoppedManagerEngineIds.has(tableId)) {
          cleanupComplete = false;
          continue;
        }

        let unregistered = false;
        try {
          if (managerEngine) {
            unregistered = this.gameServer.unregisterTableEngine(tableId, managerEngine);
          }
          if (!unregistered) {
            unregistered = await this.gameServer.stopClosedTournamentTableEngine(tableId);
          }
        } catch (error) {
          reportError(error, 'Tournament.committed_cleanup_engine_unregister_threw', { tableId });
        }
        if (!unregistered) {
          cleanupComplete = false;
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] committed cleanup could not release terminal engine ownership for ${tableId.slice(0, 8)}; retained manager handles for retry`
            ),
            'Tournament.committed_cleanup_engine_unregister_failed'
          );
        }
      }
    }

    if (!cleanupComplete) return false;

    await this.cleanupBroadcastChannel();
    // All engines were awaited above. Clearing first prevents stop() from
    // launching a second, unawaited stop against the same engine instances.
    this.tableEngines.clear();
    void this.stop().catch((error) => {
      reportError(error, 'Tournament.committed_cleanup_manager_stop_failed', {
        tournamentId: this.tournamentId,
      });
    });
    return true;
  }

  /** Announce and close a normal place settlement, without moving money. */
  private async cleanupCommittedTournament(): Promise<boolean> {
    this.tournamentFinished = true;
    try {
      const { data: winnerRows, error: winnerError } = await supabase
        .from('tournament_players')
        .select('user_id, username, prize')
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'winner')
        .eq('position', 1)
        .limit(2);
      if (winnerError || !winnerRows || winnerRows.length !== 1 || !winnerRows[0]?.user_id) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] COMPLETED settlement has no single durable winner (rows=${winnerRows?.length ?? 0}, error=${winnerError?.message ?? 'none'})`
          ),
          'Tournament.committed_cleanup_winner_unproven'
        );
        return false;
      }

      const winner = winnerRows[0] as {
        user_id: string;
        username?: string | null;
        prize?: number | string | null;
      };
      await this.broadcastCommittedOutcome('tournament_winner', {
        userId: winner.user_id,
        position: 1,
        prize: Number(winner.prize ?? 0) || 0,
        playerName: winner.username || 'Player',
      });
      return await this.cleanupCommittedTablesAndManager();
    } catch (error) {
      reportError(error, 'Tournament.committed_cleanup_threw');
      return false;
    }
  }

  /**
   * Reconstruct a committed deal announcement from durable rows, then run the
   * shared non-money tail. No payout, bounty, rake or deal RPC is reachable
   * from this recovery method.
   */
  private async cleanupCommittedFinalTableDeal(): Promise<boolean> {
    this.tournamentFinished = true;
    this.finalTableDealHandled = true;
    this.committedFinalTableDealCleanupPending = true;

    try {
      const [{ data: payoutRows, error: payoutError }, { data: winnerRows, error: winnerError }] =
        await Promise.all([
          supabase
            .from('tournament_payouts')
            .select('user_id, amount')
            .eq('tournament_id', this.tournamentId)
            .eq('source', 'final_table_deal'),
          supabase
            .from('tournament_players')
            .select('user_id')
            .eq('tournament_id', this.tournamentId)
            .eq('status', 'winner')
            .eq('position', 1)
            .limit(2),
        ]);

      if (payoutError) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] committed deal payouts could not be re-read for announcement: ${payoutError.message}`
          ),
          'Tournament.committed_deal_payouts_unreadable'
        );
      }
      const winnerId =
        !winnerError && winnerRows?.length === 1 && winnerRows[0]?.user_id
          ? winnerRows[0].user_id
          : null;
      if (!winnerId) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] committed deal winner could not be re-read (rows=${winnerRows?.length ?? 0}, error=${winnerError?.message ?? 'none'})`
          ),
          'Tournament.committed_deal_winner_unreadable'
        );
      }

      await this.broadcastCommittedOutcome('final_table_deal', {
        payouts: payoutError ? [] : (payoutRows ?? []),
        chipLeader: winnerId,
      });

      const cleaned = await this.cleanupCommittedTablesAndManager();
      if (cleaned) this.committedFinalTableDealCleanupPending = false;
      return cleaned;
    } catch (error) {
      reportError(error, 'Tournament.committed_deal_cleanup_threw');
      return false;
    }
  }

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
  protected async settleTournamentRake(tournament: any): Promise<boolean> {
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
        const durableReceipt = data?.already_settled !== true || Boolean(data?.settled_at);
        if (!error && data?.ok && durableReceipt) {
          if (data.already_settled) {
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Rake already settled (${data.amount} -> ${data.destination})`
            );
          } else {
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Rake settled: ${data.amount} -> ${data.destination}`
            );
          }
          return true;
        }
        lastErr =
          error?.message ||
          data?.reason ||
          (data?.already_settled === true ? 'rake_settlement_receipt_pending' : 'settle_failed');
      } catch (err: any) {
        lastErr = String(err?.message ?? err);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
    }
    // Completion callers fail closed on false. The sweep remains an independent
    // recovery path, never the thing that makes an under-settled finish valid.
    reportError(
      new Error(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Rake settlement FAILED after 3 attempts (${lastErr}) - fn_sweep_unsettled_tournament_rake will re-drive it`
      ),
      'Tournament.rake_settlement_failed'
    );
    return false;
  }

  /**
   * FINAL TABLE DEAL (2026-08-22 parity). When the tournament opted in
   * (final_table_deal_enabled) and the field is down to one table
   * (remaining <= table_size), every remaining player may vote a deal via
   * tournament_deal_votes (RLS restricts inserts to seated, alive players of a
   * RUNNING deal-enabled tournament). Unanimity executes
   * fn_settle_final_table_deal_atomic. The database first preserves every
   * structure place already earned by an eliminated player, then divides the
   * exact remainder among the live players by chips. Obligations, wallet
   * credits, payout evidence, standings and COMPLETED commit together or all
   * roll back. The engine only performs the operational tail after that proof
   * (rake, bounty residuals, seats and tables); it never pays a second time.
   *
   * Clients see the feature through the tournaments row realtime
   * (final_table_deal_enabled is on the row); the vote-count broadcast below
   * is the live tally for the Deal button.
   */
  private releaseFinalTableDealPause(): void {
    const held = this.finalTableDealPause;
    this.finalTableDealPause = null;
    if (!held) return;

    // A stale manager may never resume a replacement engine that took this
    // table while an ownership read was awaiting I/O.
    if (this.gameServer.getTableEngine(held.tableId) !== held.engine) return;
    try {
      held.engine.resumeFromFinalTableDeal();
    } catch (err) {
      reportError(err, 'Tournament.final_table_deal_pause_release_failed');
    }
  }

  /**
   * Resolve the one durable table that actually has live seats, then prove the
   * manager and GameServer maps name the same running engine instance.
   */
  private async authoritativeFinalTableDealEngine(): Promise<{
    tableId: string;
    engine: ServerTableEngine;
  } | null> {
    const { data: tables, error: tablesErr } = await supabase
      .from('tables')
      .select('id')
      .eq('tournament_id', this.tournamentId)
      .in('status', ['running', 'waiting']);
    if (tablesErr || !tables) return null;

    const tableIds = tables.map((row: { id: string }) => row.id).filter(Boolean);
    if (tableIds.length === 0) return null;
    const { data: seats, error: seatsErr } = await supabase
      .from('table_seats')
      .select('table_id')
      .in('table_id', tableIds)
      .is('left_at', null);
    if (seatsErr || !seats) return null;

    const occupiedTableIds = [...new Set(seats.map((seat: { table_id: string }) => seat.table_id))];
    if (occupiedTableIds.length !== 1) return null;
    const tableId = occupiedTableIds[0];
    const managerEngine = this.tableEngines.get(tableId);
    const serverEngine = this.gameServer.getTableEngine(tableId);
    if (!managerEngine || !serverEngine || managerEngine !== serverEngine) return null;
    try {
      return managerEngine.isRunning() ? { tableId, engine: managerEngine } : null;
    } catch {
      return null;
    }
  }

  /**
   * First call arms the no-new-hand gate and deliberately returns false. A
   * later poll may proceed only after the engine itself reports that it has
   * reached the gate with no cards or post-hand settlement in flight.
   */
  private async acquireFinalTableDealPause(): Promise<boolean> {
    const current = await this.authoritativeFinalTableDealEngine();
    if (!current) {
      this.releaseFinalTableDealPause();
      return false;
    }

    if (!this.finalTableDealPause) {
      try {
        current.engine.pauseForFinalTableDeal(
          TournamentManagerEliminations.FINAL_TABLE_DEAL_PAUSE_MS
        );
        this.finalTableDealPause = current;
      } catch (err) {
        reportError(err, 'Tournament.final_table_deal_pause_failed');
      }
      return false;
    }

    if (
      this.finalTableDealPause.tableId !== current.tableId ||
      this.finalTableDealPause.engine !== current.engine
    ) {
      this.releaseFinalTableDealPause();
      return false;
    }

    try {
      return current.engine.isParkedForFinalTableDeal();
    } catch {
      this.releaseFinalTableDealPause();
      return false;
    }
  }

  /** Re-prove exact ownership and the physical park after every awaited read. */
  private async finalTableDealPauseIsStillAuthoritative(): Promise<boolean> {
    const held = this.finalTableDealPause;
    if (!held) return false;
    const current = await this.authoritativeFinalTableDealEngine();
    if (!current || current.tableId !== held.tableId || current.engine !== held.engine) {
      this.releaseFinalTableDealPause();
      return false;
    }
    try {
      return current.engine.isParkedForFinalTableDeal();
    } catch {
      this.releaseFinalTableDealPause();
      return false;
    }
  }

  protected async checkFinalTableDeal(): Promise<boolean> {
    // A committed deal never re-enters its money path. Keep its operational
    // tail reachable even though both completion latches are intentionally
    // held shut, and even during maintenance because this branch moves no
    // chips.
    if (this.committedFinalTableDealCleanupPending) {
      return this.cleanupCommittedFinalTableDeal();
    }
    if (this.finalTableDealHandled || this.tournamentFinished) {
      this.releaseFinalTableDealPause();
      return true;
    }
    if (isMaintenanceFrozen() || this.isOnBreak() || this.handForHandActive) {
      this.releaseFinalTableDealPause();
      return true;
    }
    const t = this.tournamentCache;
    if (!t || t.final_table_deal_enabled !== true) {
      this.releaseFinalTableDealPause();
      return true;
    }
    if (String(t.status || 'RUNNING') !== 'RUNNING') {
      this.releaseFinalTableDealPause();
      return true;
    }

    // A successful chop is durably receipted in the same DB transaction that
    // moves RUNNING -> COMPLETING. Resume that tail before every RUNNING/alive
    // or vote gate: a prior attempt may already have stamped all losers, and a
    // restarted manager must never reinterpret the agreed chop as a normal
    // one-survivor finish.
    const { data: persistedDeal, error: persistedDealErr } = await supabase
      .from('tournament_final_table_deal_receipts')
      .select('tournament_id')
      .eq('tournament_id', this.tournamentId)
      .maybeSingle();
    if (persistedDealErr) {
      reportError(persistedDealErr, 'Tournament.final_table_deal_receipt_unreadable');
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.FINAL_TABLE_DEAL_POLL_MS);
      return false;
    }
    if (persistedDeal) {
      const committed = await this.readDurableTournamentStatus();
      if (committed.status !== 'COMPLETED') {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] legacy final-table-deal receipt exists while durable status is ${committed.status ?? 'unreadable'}${committed.error ? ` (${committed.error})` : ''}; refusing any second money path`
          ),
          'Tournament.final_table_deal_receipt_status_conflict'
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.FINAL_TABLE_DEAL_POLL_MS);
        return false;
      }
      this.tournamentFinished = true;
      this.finalTableDealHandled = true;
      this.committedFinalTableDealCleanupPending = true;
      return this.cleanupCommittedFinalTableDeal();
    }
    if (String(t.status || 'RUNNING') !== 'RUNNING') return true;

    // Event wakes can bunch together; the deal poll is cheap but needs nothing
    // like that cadence.
    const now = Date.now();
    const forcedByDurableVote = this.forceFinalTableDealCheck;
    if (
      !forcedByDurableVote &&
      now - this.lastDealPollAt < TournamentManagerBase.FINAL_TABLE_DEAL_POLL_MS
    )
      return true;
    this.forceFinalTableDealCheck = false;
    this.lastDealPollAt = now;

    let atomicDealCommitted = false;
    try {
      // Clamp written max-of-min so the guard test's "no Math.max(2, ...)"
      // position-clamp scan cannot mistake it for the double-pay pattern.
      const tableSize = Math.max(Math.min(Number(t.table_size) || 9, 10), 2);
      const { data: alive, error: aliveErr } = await supabase
        .from('tournament_players')
        .select('user_id, chips')
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'playing');
      if (aliveErr || !alive) {
        this.releaseFinalTableDealPause();
        return false;
      }
      if (alive.length < 2 || alive.length > tableSize) {
        this.releaseFinalTableDealPause();
        return true;
      }

      /**
       * ═══════════════════════════════════════════════════════════════════
       *  A DEAL NEEDS ONE TABLE, NOT A SHORT HEADCOUNT (2026-08-27, P0)
       * ═══════════════════════════════════════════════════════════════════
       *
       * The count above is necessary and NOT sufficient. Nine players spread
       * three-three-three across three felts satisfy it, and unanimity among
       * those nine would then run `fn_settle_final_table_deal_atomic` - an even chip-chop
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
      if (liveTables === null) {
        this.releaseFinalTableDealPause();
        return false;
      }
      if (liveTables !== 1) {
        this.releaseFinalTableDealPause();
        return true;
      }

      const { data: votes, error: votesErr } = await supabase
        .from('tournament_deal_votes')
        .select('user_id')
        .eq('tournament_id', this.tournamentId);
      if (votesErr || !votes) {
        this.releaseFinalTableDealPause();
        return false;
      }

      const voted = new Set(votes.map((v: { user_id: string }) => v.user_id));
      const votesFromAlive = alive.filter((p) => voted.has(p.user_id)).length;

      if (votesFromAlive !== this.lastDealVoteCount) {
        this.lastDealVoteCount = votesFromAlive;
        await this.broadcast('final_table_deal_votes', {
          votes: votesFromAlive,
          required: alive.length,
        });
      }
      if (votesFromAlive < alive.length) {
        this.releaseFinalTableDealPause();
        return true;
      }

      // Arm on one poll, settle on a later poll only after the authoritative
      // engine has physically parked. This removes the tiny but real gap where
      // handController is null after the loop's pause check and a new hand is
      // already about to open.
      if (!(await this.acquireFinalTableDealPause())) {
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.FINAL_TABLE_DEAL_POLL_MS);
        return false;
      }

      this.finalTableDealHandled = true;
      if (isMaintenanceFrozen() || this.isOnBreak() || this.handForHandActive) {
        this.finalTableDealHandled = false;
        this.releaseFinalTableDealPause();
        return false;
      }

      /* A DEAL MAY NOT PRICE AN UNFUNDED PROMISE. A short event can reach its
         final table before the late-registration level that normally funds a
         guarantee. Fund through the one guarantee RPC, then independently
         re-read and prove both the floor and its finalized marker before the
         atomic deal sees a pool. */
      const fundedPool = await this.applyPrizeGuarantee('final_table_deal');
      if (fundedPool === null) {
        this.finalTableDealHandled = false;
        this.releaseFinalTableDealPause();
        return false;
      }
      const { data: funded, error: fundedErr } = await supabase
        .from('tournaments')
        .select('prize_pool, guaranteed_prize, prize_pool_finalized, status')
        .eq('id', this.tournamentId)
        .maybeSingle();
      const storedPool = Number(funded?.prize_pool);
      const storedGuarantee = Number(funded?.guaranteed_prize ?? 0);
      if (
        fundedErr ||
        !funded ||
        funded.status !== 'RUNNING' ||
        funded.prize_pool_finalized !== true ||
        !Number.isFinite(storedPool) ||
        storedPool + 0.005 < storedGuarantee ||
        Math.abs(storedPool - fundedPool) >= 0.005
      ) {
        this.finalTableDealHandled = false;
        this.releaseFinalTableDealPause();
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] final-table deal refused before allocation: funded pool could not be proven (${fundedErr?.message ?? `rpc=${fundedPool}, row=${storedPool}, guarantee=${storedGuarantee}, finalized=${String(funded?.prize_pool_finalized)}, status=${String(funded?.status)}`})`
          ),
          'Tournament.final_table_deal_guarantee_unproven'
        );
        return false;
      }
      if (this.tournamentCache) this.tournamentCache.prize_pool = storedPool;
      this.prizePoolFinalized = true;

      // Maintenance may begin while guarantee proof is in flight. The engine
      // holds service_role, so only this explicit gate can stop the deal RPC.
      if (
        isMaintenanceFrozen() ||
        this.isOnBreak() ||
        this.handForHandActive ||
        !(await this.finalTableDealPauseIsStillAuthoritative())
      ) {
        this.finalTableDealHandled = false;
        this.releaseFinalTableDealPause();
        return false;
      }

      // Votes and live membership may change while guarantee proof is in
      // flight. Re-read both after the park, then let SQL lock and prove them
      // once more inside the money transaction.
      const [
        { data: finalAlive, error: finalAliveErr },
        { data: finalVotes, error: finalVotesErr },
      ] = await Promise.all([
        supabase
          .from('tournament_players')
          .select('user_id')
          .eq('tournament_id', this.tournamentId)
          .eq('status', 'playing'),
        supabase
          .from('tournament_deal_votes')
          .select('user_id')
          .eq('tournament_id', this.tournamentId),
      ]);
      const finalVoters = new Set(
        (finalVotes ?? []).map((vote: { user_id: string }) => vote.user_id)
      );
      if (
        finalAliveErr ||
        finalVotesErr ||
        !finalAlive ||
        finalAlive.length < 2 ||
        finalAlive.length > tableSize ||
        finalAlive.some((player: { user_id: string }) => !finalVoters.has(player.user_id)) ||
        isMaintenanceFrozen() ||
        this.isOnBreak() ||
        this.handForHandActive ||
        !(await this.finalTableDealPauseIsStillAuthoritative())
      ) {
        this.finalTableDealHandled = false;
        this.releaseFinalTableDealPause();
        return false;
      }
      const deal = await settleFinalTableDealAtomically(supabase, this.tournamentId);
      if (!deal.ok || !deal.completed) {
        // Every RPC attempt can commit and still lose its response. Durable
        // COMPLETED is the receipt; once observed, only the non-money tail is
        // legal and the deal RPC must never be entered again.
        const committed = await this.readDurableTournamentStatus();
        if (committed.status === 'COMPLETED') {
          this.tournamentFinished = true;
          this.finalTableDealHandled = true;
          this.committedFinalTableDealCleanupPending = true;
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] final-table deal response was lost after commit; resuming cleanup from durable COMPLETED`
          );
          return this.cleanupCommittedFinalTableDeal();
        }

        this.finalTableDealHandled = false;
        this.releaseFinalTableDealPause();
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] atomic final-table deal refused: ${deal.reason ?? 'unknown'}${deal.detail ? ` (${deal.detail})` : ''}${deal.transport_error ? ` (${deal.transport_error})` : ''}${committed.error ? `; completion proof read failed: ${committed.error}` : ''}`
          ),
          'Tournament.final_table_deal_refused'
        );
        await raiseFinancialAlert(
          'critical',
          'Tournament.final_table_deal_atomic_refused',
          'A unanimous final-table deal did not commit. No partial deal is accepted; the tournament remains open for a safe retry or review.',
          {
            tournament_id: this.tournamentId,
            reason: deal.reason,
            detail: deal.detail,
            transport_error: deal.transport_error ?? null,
            funded_prize_pool: storedPool,
            live_players: alive.length,
          }
        );
        return false;
      }

      atomicDealCommitted = true;
      return this.settleFinalTableDeal(deal);
    } catch (err) {
      reportError(err, 'Tournament.final_table_deal_threw');
      // Once the RPC receipt or the tournament row proves the transaction
      // committed, a tail exception may only retry operational cleanup. In
      // particular, clearing the two old latches here used to make a second
      // deal attempt possible after money had already moved.
      const committed = await this.readDurableTournamentStatus();
      if (atomicDealCommitted || committed.status === 'COMPLETED') {
        this.tournamentFinished = true;
        this.finalTableDealHandled = true;
        this.committedFinalTableDealCleanupPending = true;
        return this.cleanupCommittedFinalTableDeal();
      }
      this.tournamentFinished = false;
      this.finalTableDealHandled = false;
      this.releaseFinalTableDealPause();
      return false;
    }
  }

  /**
   * The database has already committed every prize, every final standing and
   * COMPLETED. This method performs only the idempotent operational tail. It
   * must never become a second payer or a second terminal-state writer.
   */
  private async settleFinalTableDeal(deal: AtomicFinalTableDealResult): Promise<boolean> {
    this.tournamentFinished = true;
    this.finalTableDealHandled = true;
    this.committedFinalTableDealCleanupPending = true;

    // Re-read the committed deal evidence for the broadcast. The atomic RPC
    // already verified it against every obligation; a read failure here does
    // not authorize another credit and does not undo the completed event.
    const { data: recordedPayouts, error: prErr } = await supabase
      .from('tournament_payouts')
      .select('user_id, amount')
      .eq('tournament_id', this.tournamentId)
      .eq('source', 'final_table_deal');
    const recordedPayoutCount = recordedPayouts?.length ?? 0;
    const payoutRows =
      !prErr && recordedPayouts && recordedPayoutCount === deal.players
        ? recordedPayouts
        : deal.payouts.map(({ user_id, amount }) => ({ user_id, amount }));
    if (prErr || recordedPayoutCount !== deal.players) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] atomic deal committed but its broadcast evidence re-read disagreed (rows=${recordedPayoutCount}, expected=${deal.players}, error=${prErr?.message ?? 'none'})`
        ),
        'Tournament.final_table_deal_payouts_unreadable'
      );
    }

    // The winner is part of the database proof, not inferred again from the
    // pre-RPC chip snapshot. A raced chip update cannot make the runtime tail
    // finalize bounty money for a different player.
    const { data: winnerRow, error: dealWinnerErr } = await supabase
      .from('tournament_players')
      .select('user_id')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'winner')
      .eq('position', 1)
      .maybeSingle();
    const winnerId =
      !dealWinnerErr && winnerRow?.user_id && winnerRow.user_id === deal.chip_leader
        ? winnerRow.user_id
        : null;
    if (!winnerId) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: atomic deal winner proof could not be re-read (${dealWinnerErr?.message ?? `row=${winnerRow?.user_id ?? 'none'}, rpc=${deal.chip_leader ?? 'none'}`})`
        ),
        'Tournament.final_table_deal_winner_stamp_failed'
      );
      return false;
    }

    await this.broadcastCommittedOutcome('final_table_deal', {
      payouts: payoutRows,
      chipLeader: deal.chip_leader,
    });

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] FINAL TABLE DEAL atomically settled - ${deal.players} live share(s), ${deal.place_paid} prior-place chips and ${deal.deal_paid} deal chips moved this call, chip leader ${deal.chip_leader?.slice(0, 8) ?? 'unknown'} takes 1st`
    );

    const cleaned = await this.cleanupCommittedTablesAndManager();
    if (cleaned) this.committedFinalTableDealCleanupPending = false;
    return cleaned;
  }

  protected async finishTournament(winnerId: string): Promise<void> {
    // This manager holds service_role, which the database maintenance trigger
    // intentionally exempts. Do not claim a finish or enter any settlement
    // preparation while the platform freeze is active.
    //
    // BUT COME BACK FOR IT (2026-09-09). This was a bare `return`: no log, no
    // retry re-armed, nothing. The break holds the platform for five minutes of
    // every hour, so roughly one finish in twelve arrived inside one and was
    // simply dropped - the tournament then waited for whatever sweep happened
    // to call this again, which for a DECIDED event can be a long time, because
    // with one player left there are no more hands and no more eliminations to
    // trigger one. CLAUDE.md 13 rule 4: a deadline is thawed, not burned.
    //
    // Re-arming costs one timer and makes the deferral visible. It is not a
    // repair job (10.12): nothing is being back-filled or compensated - the
    // finish simply has not happened yet, and this is the same work resuming
    // the moment it is allowed to.
    if (isMaintenanceFrozen()) {
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] finish deferred: the platform is frozen for the maintenance break; resuming after the thaw`
      );
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
      return;
    }
    // One in-process finalizer at a time. On every fail-closed exit below the
    // flag is released so the next elimination sweep can resume the durable
    // COMPLETING claim and prepared obligations.
    if (this.tournamentFinished) return;
    this.tournamentFinished = true;

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] FINALIZING... candidate winner: ${winnerId.slice(0, 8)}`
    );

    // One DB transaction both claims RUNNING -> COMPLETING and persists the
    // immutable canonical winner.  A transport ambiguity is retried against
    // that receipt; a semantic conflict is never guessed through.
    const finishClaim = await claimTournamentFinish(
      supabase,
      this.tournamentId,
      winnerId,
      'engine.finishTournament'
    );
    if (!finishClaim.ok || !finishClaim.winnerUserId) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: finish claim refused (${finishClaim.reason}${finishClaim.transportError ? `: ${finishClaim.transportError}` : ''}); canonical winner ${winnerId.slice(0, 8)} remains unpaid and the event remains re-drivable`
        ),
        'Tournament.finish_claim_failed'
      );
      this.tournamentFinished = false;
      return;
    }

    winnerId = finishClaim.winnerUserId;
    if (finishClaim.alreadyCompleted || finishClaim.status === 'COMPLETED') {
      console.warn(
        `[Tournament:${this.tournamentId.slice(0, 8)}] finish claim replayed durable COMPLETED; resuming cleanup only`
      );
      if (!(await this.cleanupCommittedTournament())) this.tournamentFinished = false;
      return;
    }

    /* A retry must inherit the champion already recorded by the first pass.
       After an atomic settlement refusal that row is status=winner/place=1,
       while no row remains status=playing. Falling back to the most recently
       eliminated player on the next sweep would otherwise promote the
       runner-up and create two contradictory winners. Any partial or duplicate
       winner marker is corruption, not authority to guess. */
    const { data: recordedWinnerRows, error: recordedWinnerErr } = await supabase
      .from('tournament_players')
      .select('user_id, status, position')
      .eq('tournament_id', this.tournamentId);
    if (recordedWinnerErr || !recordedWinnerRows) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] could not prove the durable winner marker before finalization: ${recordedWinnerErr?.message ?? 'no rows'}`
        ),
        'Tournament.winner_marker_read_failed'
      );
      this.tournamentFinished = false;
      return;
    }
    const winnerMarkers = recordedWinnerRows.filter(
      (row) => row.status === 'winner' || Number(row.position) === 1
    );
    if (winnerMarkers.length > 0) {
      const marker = winnerMarkers[0];
      if (
        winnerMarkers.length !== 1 ||
        marker.status !== 'winner' ||
        Number(marker.position) !== 1 ||
        !marker.user_id
      ) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] contradictory durable winner markers (${winnerMarkers.length} row(s)); refusing to promote a replacement`
          ),
          'Tournament.winner_marker_conflict'
        );
        this.tournamentFinished = false;
        return;
      }
      if (winnerId !== marker.user_id) {
        console.warn(
          `[Tournament:${this.tournamentId.slice(0, 8)}] retry proposed ${winnerId.slice(0, 8)} as winner; reusing durable champion ${marker.user_id.slice(0, 8)}`
        );
      }
      winnerId = marker.user_id;
    }

    const { data: tournament, error: tourneyLoadErr } = await supabase
      .from('tournaments')
      // TOURNEY-AUDIT 2026-07-24: bounty flags added so the champion's own
      // bounty head can be paid below.
      .select(
        // spin_multiplier: lets a Spin rebuild its own payout split from the
        // spec rather than falling through to "winner takes the whole pool",
        // which on a 10x+ Spin is a 20% overpay on top of money already sent
        // to 2nd and 3rd at elimination. See payoutStructure.ts.
        'payout_structure, prize_pool, guaranteed_prize, prize_pool_finalized, buy_in_fee, buy_in_amount, current_players, club_id, name, status, is_bounty, is_pko, is_mystery_bounty, mystery_bounty_stage, mystery_bounty_activated_at, mystery_bounty_activated_players, bubble_protection, variant, tournament_type, spin_multiplier, satellite_target_id, satellite_seats'
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
       * automatic `recoverStuckCompletingTournaments` scans look only at
       * COMPLETING; the one mechanism built to rescue exactly this case can no
       * longer discover it without an explicit tournament id.
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
      this.tournamentFinished = false;
      return;
    }

    // Calculate the winner's exact entitlement. A missing contract fails closed.
    // TOURNEY-AUDIT 2026-07-24 (sweep 6): satellites award SEATS at the end
    // (processSatelliteAwards below), never per-place cash here.
    const isSatelliteFinish =
      String((tournament as any)?.variant ?? '').toLowerCase() === 'satellite' ||
      ((tournament as any)?.tournament_type || '').toUpperCase() === 'SATELLITE' ||
      Boolean((tournament as any)?.satellite_target_id);
    let refreshedPool = Number(tournament.prize_pool || 0);
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
     * A failure here MUST strand the finish in COMPLETING. Paying the old pool
     * would break the published guarantee, while retrying this idempotent RPC
     * can fund it exactly once. The database completion gate independently
     * requires a finalized pool at least as large as the guarantee.
     */
    if (!isSatelliteFinish) {
      if (isMaintenanceFrozen()) {
        this.tournamentFinished = false;
        return;
      }
      try {
        const funded = await this.applyPrizeGuarantee('finish_fallback');
        if (funded === null) {
          await raiseFinancialAlert(
            'critical',
            'Tournament.finish_guarantee_unconfirmed',
            'The tournament prize pool has no confirmed funding receipt. Winner pricing and completion were not attempted.',
            {
              tournament_id: this.tournamentId,
              guaranteed_prize: Number(tournament.guaranteed_prize ?? 0),
              confirmed_pool: null,
              reason: 'funding_receipt_missing',
            }
          );
          this.tournamentFinished = false;
          return;
        }

        // Always re-read the authoritative row, even when no overlay was
        // needed. The settlement batch may freeze only a pool that the funding
        // transaction marked final and that still covers the published floor.
        const { data: refreshed, error: refreshErr } = await supabase
          .from('tournaments')
          .select('prize_pool, guaranteed_prize, prize_pool_finalized')
          .eq('id', this.tournamentId)
          .maybeSingle();
        refreshedPool = Number(refreshed?.prize_pool);
        const refreshedGuarantee = Number(refreshed?.guaranteed_prize ?? 0);
        if (
          refreshErr ||
          !refreshed ||
          !Number.isFinite(refreshedPool) ||
          refreshed.prize_pool_finalized !== true ||
          refreshedPool + 0.005 < refreshedGuarantee ||
          Math.abs(refreshedPool - funded) >= 0.005
        ) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] funded prize pool could not be proven final (${refreshErr?.message ?? `rpc=${funded}, row=${refreshedPool}, guarantee=${refreshedGuarantee}, finalized=${String(refreshed?.prize_pool_finalized)}`})`
            ),
            'Tournament.guarantee_refresh_failed'
          );
          await raiseFinancialAlert(
            'critical',
            'Tournament.finish_guarantee_unconfirmed',
            'The funded tournament prize pool could not be proven final and at least as large as its published guarantee. Winner pricing and completion were not attempted.',
            {
              tournament_id: this.tournamentId,
              guaranteed_prize: refreshedGuarantee,
              confirmed_pool: funded,
              observed_pool: Number.isFinite(refreshedPool) ? refreshedPool : null,
              prize_pool_finalized: refreshed?.prize_pool_finalized ?? null,
              detail: refreshErr?.message ?? null,
            }
          );
          this.tournamentFinished = false;
          return;
        }
        (tournament as { prize_pool?: number }).prize_pool = refreshedPool;
        (tournament as { guaranteed_prize?: number }).guaranteed_prize = refreshedGuarantee;
        (tournament as { prize_pool_finalized?: boolean }).prize_pool_finalized = true;
      } catch (guaranteeErr) {
        reportError(guaranteeErr, 'Tournament.guarantee_finish_fallback_failed');
        this.tournamentFinished = false;
        return;
      }
    }

    let winnerPrize = 0;
    if (!isSatelliteFinish) {
      // resolvePayoutStructure returns the stored structure when it is usable
      // and, for a Spin, rebuilds it from spinTier(spin_multiplier). An unknown
      // Spin draw and every non-Spin with no usable contract return null.
      const payouts = resolvePayoutStructure(tournament as any, await this.finalFieldSize());
      if (payouts) {
        // PAYOUT-INTEGRITY 2026-08-20: same residual rule as every other place
        // (see computePlacePrize). For a single-place structure (a 2x-5x Spin)
        // place 1 IS the last place, so the winner receives the whole pool
        // exactly; on 80/20 and 80/12/8 the parts sum to the pool to the cent.
        winnerPrize = computePlacePrize(Number(tournament.prize_pool || 0), payouts, 1);
      } else if (Number(tournament.prize_pool || 0) > 0) {
        // An absent structure is not authority to invent winner-take-all.
        // The database finalizer freezes the published ladder and proves that
        // every exact-cent share is represented. Without that ladder there is
        // no complete plan to commit, so leave the durable COMPLETING claim
        // for explicit recovery instead of guessing with real chips.
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: no usable published payout_structure; refusing to invent a place plan or complete the tournament`
          ),
          'Tournament.payout_structure_unavailable_at_finish'
        );
        this.tournamentFinished = false;
        return;
      }
    }

    /**
     * A WINNER PAID NOTHING MUST SAY SO (2026-08-31, phase 6).
     *
     * `if (winnerPrize > 0)` is the right guard for the credit and the wrong
     * place to stop thinking. Every alert this path added on 2026-08-31 -
     * Legacy per-place credit alerts lived inside this block, so they could
     * only escalate a credit that was attempted and failed. The atomic batch
     * now has one durable failure alarm below, while this branch still makes
     * the distinct "nothing was owed" outcome visible.
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

    /* Place 1 is recorded below with every other entitlement. No place money
       moves until fn_settle_tournament_places_atomic can commit the whole
       fingerprinted batch and COMPLETED together. */

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
    // eliminatePlayer records each entitlement; the atomic batch below moves
    // the whole pool only after every final standing has been stamped.
    const { data: stillPlaying, error: stillPlayingErr } = await supabase
      .from('tournament_players')
      .select('user_id, chips')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'playing')
      .neq('user_id', winnerId);

    if (stillPlayingErr || !Array.isArray(stillPlaying)) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] could not read unresolved players at finish: ${stillPlayingErr?.message ?? 'invalid roster'}`
        ),
        'Tournament.unresolved_players_read_failed'
      );
      this.tournamentFinished = false;
      return;
    } else if (stillPlaying.length > 0) {
      console.warn(
        `[Tournament:${this.tournamentId.slice(0, 8)}] finishing with ${stillPlaying.length} unresolved player(s) - assigning places 2..${stillPlaying.length + 1}`
      );
      const ordered = [...stillPlaying].sort((a, b) => (a.chips ?? 0) - (b.chips ?? 0));
      // PAYOUT-INTEGRITY 2026-08-27: `ordered.length + 1 - i` assumed no place
      // below it was taken — with a single unresolved player it ALWAYS wrote
      // place 2, occupied or not, paying a second 2nd-place prize. Same
      // free-place walk as the bust sweep.
      const { data: finishTaken, error: finishTakenErr } = await supabase
        .from('tournament_players')
        .select('position')
        .eq('tournament_id', this.tournamentId)
        .not('position', 'is', null);
      if (
        finishTakenErr ||
        !Array.isArray(finishTaken) ||
        finishTaken.some((r) => !Number.isInteger(Number(r.position)) || Number(r.position) < 1) ||
        new Set(finishTaken.map((r) => Number(r.position))).size !== finishTaken.length
      ) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] cannot assign finishing places from an unreadable or inconsistent position list: ${finishTakenErr?.message ?? 'invalid or duplicate positions'}`
          ),
          'Tournament.finish_positions_unconfirmed'
        );
        this.tournamentFinished = false;
        return;
      }
      const finishTakenPositions = new Set<number>(
        finishTaken
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
          this.tournamentFinished = false;
          return;
        }
        const eliminated = await this.eliminatePlayer(ordered[i].user_id, finishNext, true);
        if (!eliminated) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] finish fallback could not atomically assign place ${finishNext} to ${ordered[i].user_id.slice(0, 8)} - leaving event COMPLETING for the recovery reconciler rather than reusing a stale place`
            ),
            'Tournament.finish_fallback_place_deferred'
          );
          this.tournamentFinished = false;
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
          return;
        }
        finishTakenPositions.add(finishNext);
        finishNext--;
      }
      // eliminatePlayer can return without claiming a stale bust or failed
      // status write. Its return is not proof that the assigned player is out.
      const { data: remainingPlayers, error: remainingPlayersErr } = await supabase
        .from('tournament_players')
        .select('user_id')
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'playing')
        .neq('user_id', winnerId);
      if (remainingPlayersErr || !Array.isArray(remainingPlayers) || remainingPlayers.length > 0) {
        reportError(
          new Error('Tournament finish cannot confirm that every remaining player was resolved.'),
          'Tournament.finish_players_unresolved'
        );
        this.tournamentFinished = false;
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        return;
      }
    }

    // PAYOUT-INTEGRITY 2026-08-25: this row is the result/entitlement record
    // for place 1. Discarded, a failure here left the champion status='playing'
    // with prize 0 on a COMPLETED event, unattributable money in the same shape
    // as the 113 under-paid tournaments the comment above describes — and
    // fn_tournament_payout_reconcile would then read prize 0 for place 1 and
    // try to top the winner up to the full first prize a second time.
    const { error: winnerStampErr, count: winnerStampCount } = await supabase
      .from('tournament_players')
      .update({ status: 'winner', position: 1, prize: winnerPrize }, { count: 'exact' })
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', winnerId);
    if (winnerStampErr || winnerStampCount !== 1) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: winner row not stamped for ${winnerId.slice(0, 8)} (prize ${winnerPrize}): ${winnerStampErr?.message ?? `affected rows: ${winnerStampCount ?? 'unknown'}`}`
        ),
        'Tournament.winner_row_stamp_failed'
      );
      this.tournamentFinished = false;
      return;
    }

    /* The final field must be ranked before its entitlements are derived.
       During open late registration an early bust can carry a provisional
       position and a positive provisional prize; treating that estimate as a
       protected result preserves the wrong ladder. The database normalizer
       protects only exact payout evidence, atomically ranks every unpaid bust
       by eliminated_at over the final field, and proves 1..N. Only then may
       the application recalculate the final structure prizes. */
    if (!isSatelliteFinish) {
      const { data: normalizedData, error: normalizedErr } = await supabase.rpc(
        'fn_normalize_tournament_final_standings',
        { p_tournament_id: this.tournamentId }
      );
      const normalized = (normalizedData ?? {}) as {
        ok?: boolean;
        reason?: string;
        detail?: string;
      };
      if (normalizedErr || normalized.ok !== true) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] atomic final-standings normalization refused: ${normalizedErr?.message ?? normalized.reason ?? 'unknown'}${normalized.detail ? ` (${normalized.detail})` : ''}`
          ),
          'Tournament.final_standings_renumber'
        );
        this.tournamentFinished = false;
        return;
      }

      try {
        if (!(await this.recalculateEliminatedPrizes(refreshedPool))) {
          this.tournamentFinished = false;
          return;
        }
      } catch (repriceErr) {
        reportError(repriceErr, 'Tournament.final_standings_reprice_failed');
        this.tournamentFinished = false;
        return;
      }
    }

    // TOURNEY-AUDIT 2026-07-24 [money]: in bounty/PKO formats the champion
    // collects their OWN remaining bounty head (base bounty + everything
    // accumulated via PKO 50%-to-head splits). This was never paid — the
    // winner path skipped bounty collection entirely, silently forfeiting
    // real money the winner is owed. Credit it here, idempotently (head is
    // zeroed after payment).
    if (tournament?.is_bounty || tournament?.is_pko || tournament?.is_mystery_bounty) {
      if (isMaintenanceFrozen()) {
        this.tournamentFinished = false;
        return;
      }
      // DAN'S SPEC 2026-08-15: settle whatever remains in the funded bounty
      // pool to the champion — their own unclaimed head plus any residual left
      // by the tiered mystery draw. One RPC, idempotent on the ownbounty key,
      // and it leaves bounty_pool_paid == bounty_pool so the event is exactly
      // conserving (verified live: pool 75.00 -> paid 75.00, residual 0.00).
      // Mystery chests settle FIRST — see reconcileMysteryBounty.
      if (!(await this.recoverPendingBountyObligations(tournament, true))) {
        this.tournamentFinished = false;
        return;
      }
      if (!(await this.reconcileMysteryBounty(winnerId))) {
        this.tournamentFinished = false;
        return;
      }
      try {
        const { data: fin, error: finErr } = await supabase.rpc('fn_finalize_bounty_pool', {
          p_tournament_id: this.tournamentId,
          p_winner_user_id: winnerId,
        });
        const finalised = fin as { ok?: boolean; reason?: string; residual?: number } | null;
        if (finErr || finalised?.ok !== true) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty pool finalisation FAILED: ${finErr?.message ?? finalised?.reason ?? 'refused'}`
            ),
            'Tournament.bounty_pool_finalise_failed'
          );
          this.tournamentFinished = false;
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
          return;
        } else {
          const residual = Number(finalised?.residual || 0);
          if (residual > 0) {
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Champion ${winnerId.slice(0, 8)} collected remaining bounty pool: ${residual}`
            );
          }
        }
      } catch (obEx) {
        reportError(obEx, 'Tournament.winner_own_bounty_exception');
        this.tournamentFinished = false;
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        return;
      }
    }

    if (isMaintenanceFrozen()) {
      this.tournamentFinished = false;
      return;
    }
    if (!(await this.settleTournamentRake(tournament))) {
      this.tournamentFinished = false;
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
      return;
    }

    if (isSatelliteFinish) {
      if (!(await this.settleSatelliteFinishAtomically(tournament))) {
        this.tournamentFinished = false;
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        return;
      }
    } else {
      /* This RPC owns both place money and the terminal status. Its prepare
         call has already committed the complete obligation fingerprint; the
         settle call either pays every place and completes, or rolls all new
         place credits back and leaves the event COMPLETING for replay. */
      if (isMaintenanceFrozen()) {
        this.tournamentFinished = false;
        return;
      }
      const settlement = await settleTournamentPlacesAtomically(
        supabase,
        this.tournamentId,
        'engine.finishTournament'
      );
      if (!settlement.ok || !settlement.completed) {
        // A transport error is not proof of rollback. If the atomic database
        // transaction committed and every response was lost, the durable row
        // is our receipt and only the non-money cleanup tail may run.
        const committed = await this.readDurableTournamentStatus();
        if (committed.status === 'COMPLETED') {
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] atomic place response was lost after commit; resuming cleanup from durable COMPLETED`
          );
          if (!(await this.cleanupCommittedTournament())) this.tournamentFinished = false;
          return;
        }

        const failureMessage = `[Tournament:${this.tournamentId.slice(0, 8)}] atomic place settlement refused: ${settlement.reason ?? 'success response omitted completion proof'}${settlement.detail ? ` (${settlement.detail})` : ''}${settlement.transport_error ? ` (${settlement.transport_error})` : ''}${committed.error ? `; completion proof read failed: ${committed.error}` : ''}; no atomic completion is durably proven and the event remains COMPLETING`;
        reportError(new Error(failureMessage), 'Tournament.atomic_place_settlement_failed');
        // The SQL settler raises its own durable alert after an attempted
        // transaction abort. This application-level alarm also covers a
        // prepare refusal or transport failure, before settlement was entered.
        await raiseFinancialAlert(
          'critical',
          'Tournament.atomic_place_settlement_failed',
          failureMessage,
          {
            tournament_id: this.tournamentId,
            reason: settlement.reason,
            detail: settlement.detail,
            transport_error: settlement.transport_error ?? null,
            retryable: settlement.retryable,
            places: settlement.places,
          }
        );
        this.tournamentFinished = false;
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
        return;
      }
    }

    // Success receipts and lost receipts converge here. The helper contains
    // no RPC and reads the durable winner instead of trusting this call's
    // in-memory arguments.
    if (!(await this.cleanupCommittedTournament())) this.tournamentFinished = false;
  }

  /**
   * Keep satellite completion behind its format-owned all-or-none database
   * door. A lost RPC response is resolved only from durable COMPLETED truth;
   * no application-side status flip or reconstructed payout is permitted.
   */
  private async settleSatelliteFinishAtomically(tournament: any): Promise<boolean> {
    if (await this.processSatelliteAwards(tournament)) return true;
    const committed = await this.readDurableTournamentStatus();
    if (committed.status === 'COMPLETED') {
      console.warn(
        `[Tournament:${this.tournamentId.slice(0, 8)}] satellite settlement response was lost after durable COMPLETED`
      );
      return true;
    }
    return false;
  }

  // ── Implemented by TournamentManager (layer 3/3) ──
  protected abstract checkTableBalance(): Promise<void>;
  protected abstract processSatelliteAwards(tournament: any): Promise<boolean>;
  protected abstract ensureLateRegSeated(): Promise<void>;
  protected abstract checkDynamicTableExpansion(): Promise<boolean>;
}
