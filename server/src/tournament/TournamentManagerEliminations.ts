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
import { UUID_SHAPE as UUID } from '../lib/uuidShape.js';
import { isMaintenanceFrozen, onNextMaintenanceThaw } from '../maintenance/freezeState.js';
import { supabase } from '../services/supabase.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { reportError } from '../services/errorReporter.js';
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
import { computePlacePrize, prizePoolAvailableToPlaces } from './payoutMath.js';
import { resolvePayoutStructure, parsePayoutStructure } from './payoutStructure.js';
import type { ServerTableEngine } from '../engine/ServerTableEngine.js';
import type { VerifiedTournamentCompletionReceipt } from './completionSettlementReceipt.js';
import {
  requestTournamentTerminalReceipt,
  TerminalSettlementDisagreementError,
  TerminalSettlementOutcomeUnknownError,
  TerminalSettlementRefusedError,
} from './terminalSettlementRpc.js';
import type { VerifiedSatelliteSettlementReceipt } from './satelliteSettlementReceipt.js';
import { TournamentSweepWorkCursor } from './TournamentSweepWorkCursor.js';
import {
  reconcileTournamentManagerWakeAcknowledgement,
  type TournamentManagerWakeReceipt,
} from './TournamentManagerWakeProtocol.js';
import {
  SatelliteSettlementOutcomeUnknownError,
  SatelliteSettlementRefusedError,
} from './satelliteSettlementRpc.js';
import { horseRebuyAllowance } from '../services/FreeBuy.js';
import { bindLatestKnockoutCandidates, knockoutCandidateReadIsComplete } from './bustOrder.js';

interface FinalTableDealConsensus {
  reviewId: string | null;
  reviewState: 'none' | 'requested' | 'reviewing' | 'completed' | 'cancelled' | 'expired';
  reviewExpiresAt: number | null;
  stale: boolean;
  proposalId: string | null;
  revision: string | null;
  voters: Set<string>;
  required: number;
  ready: boolean;
}

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

interface CandidateBackedKnockoutEvidence extends PersistedKnockoutEvidence {
  candidateId: string;
  seatId: string;
  seatJoinedAt: string;
  /**
   * A PLACE IS NOT A BOUNTY (2026-09-10). True when the bust itself is fully
   * proven - accepted zero-stack settlement, matching atomic receipt, the
   * player at zero in the history roster - but the hand cannot name who won
   * the pot holding their last chips. The elimination is still recorded and
   * the place still assigned; the head is left in the pool for
   * fn_finalize_bounty_pool to resolve as residual, and no obligation is
   * written. `attribution` is the empty 'none' attribution in this case, so
   * nothing downstream can mistake it for a payable claim.
   */
  attributionUnavailable?: boolean;
}

/**
 * The money threshold is a finishing place, not the number of rows in a
 * payout ladder. A valid stored ladder may be sparse (for example 1, 2, 3,
 * and 5), so hand-for-hand must begin with six players rather than five.
 * Terminal SQL independently derives the same maximum from its locked ladder
 * before it prices the pool-funded Bubble Promise.
 */
function deepestCanonicalPaidPlace(
  payouts: ReadonlyArray<{ place?: number }> | null | undefined
): number {
  if (!Array.isArray(payouts)) return 0;
  return payouts.reduce((deepest, payout) => {
    const place = Number(payout?.place);
    return Number.isInteger(place) && place > deepest ? place : deepest;
  }, 0);
}

/** A receipt committed, but the pre-commit display snapshot raced its result. */
class TerminalSettlementCommittedError extends Error {
  constructor(
    readonly receipt: VerifiedTournamentCompletionReceipt,
    message: string
  ) {
    super(message);
    this.name = 'TerminalSettlementCommittedError';
  }
}

/** Spread owed work through the existing scheduler after the actual thaw. */
export function thawPassDelayMs(tournamentId: string, spreadMs: number): number {
  if (!(spreadMs > 0)) return 0;
  const head = Number.parseInt(tournamentId.replace(/-/g, '').slice(0, 8), 16);
  return Number.isFinite(head) ? head % spreadMs : 0;
}

export abstract class TournamentManagerEliminations extends TournamentManagerBase {
  private thawPass: { generation: number; cancel: () => void } | null = null;
  // A thaw wake can resume a cursor already past a frozen stage. Retain the
  // exact debt until that stage actually runs in a later cycle.
  private readonly frozenStagesOwed = new Set<number>();
  static readonly THAW_PASS_SPREAD_MS = 10_000;

  private owePassAfterTheThaw(): void {
    const lifecycle = this.captureLifecycleToken();
    if (!lifecycle || !this.lifecycleIsCurrent(lifecycle)) return;
    if (this.thawPass?.generation === lifecycle.generation) return;
    this.thawPass?.cancel();
    const cancel = onNextMaintenanceThaw(() => {
      this.thawPass = null;
      if (!this.lifecycleIsCurrent(lifecycle)) return;
      if (isMaintenanceFrozen()) {
        this.owePassAfterTheThaw();
        return;
      }
      this.requestUrgentEliminationSweepAfter(
        thawPassDelayMs(this.tournamentId, TournamentManagerEliminations.THAW_PASS_SPREAD_MS)
      );
    }, lifecycle.signal);
    this.thawPass = { generation: lifecycle.generation, cancel };
  }

  /**
   * Cooperative continuation through the bounded manager work unit. A slow
   * but successful database request advances this cursor before yielding, so
   * the next admission never restarts the same prefix forever.
   */
  private readonly eliminationSweepCursor = new TournamentSweepWorkCursor();
  /**
   * A BALANCE IS A DEBT UNTIL IT RUNS (2026-09-11). The balance stage used to
   * be marked complete whether or not `checkTableBalance` had done anything:
   * it returns without a word when the sweep budget runs out between its
   * reads, and the stage is skipped outright while the platform is frozen. The
   * cursor then handed the next admission stage 6, and a field spread one
   * player per table - no hand to deal, no bust to record - had nothing left
   * that would ever start another pass. `balanceRetriedThisCycle` allows one
   * fresh-budget re-entry of the stage per cycle (so an event whose reads can
   * never fit a budget still records its busts), and `balanceOwedAfterCycle`
   * asks for a new cycle when even that retry ran out.
   */
  private balanceRetriedThisCycle = false;
  private balanceOwedAfterCycle = false;
  /** Latest level-triggered generation observed for each durable wake identity. */
  private readonly pendingManagerWakeGenerations = new Map<number, number>();
  /**
   * Retry order for an exact tie only: same accepted hand and same starting
   * stack. Hand number and hand-start stack always sort before this map, so a
   * refusal can never advance a PKO watermark past an earlier bust or change a
   * standings tie that the accepted hand can distinguish.
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

    /**
     * THREE COUNTS, ONE ROUND TRIP (2026-09-11).
     *
     * These were three awaited reads in a row at the head of every full
     * sweep. The once-a-minute throttle is per manager, and in a backlog a
     * manager is admitted far less often than once a minute - after the 06:57
     * boot on 2026-09-11 the scheduler held 553 of 597 managers in its queue
     * and its oldest entry waited up to 24 minutes - so in practice every
     * sweep paid all three trips, each one also waiting out a main event-loop
     * delay that read 142 ms p50 at 07:22 and 490 ms at 07:51, before it
     * looked at a single bust. The counts are independent high-water marks, so
     * they are read together; each one still only ever raises its mark, and a
     * failed one still leaves its previous value in place.
     */
    try {
      const [entrantsRead, rebuysRead, addonsRead] = await Promise.allSettled([
        supabase
          .from('tournament_players')
          .select('*', { count: 'exact', head: true })
          .eq('tournament_id', this.tournamentId),
        supabase
          .from('wallet_transactions')
          .select('*', { count: 'exact', head: true })
          .eq('related_entity_id', this.tournamentId)
          .eq('category', 'rebuy'),
        supabase
          .from('wallet_transactions')
          .select('*', { count: 'exact', head: true })
          .eq('related_entity_id', this.tournamentId)
          .eq('category', 'addon'),
      ]);
      const settledCount = (read: typeof entrantsRead): number | null => {
        if (read.status === 'rejected') {
          reportError(read.reason, 'Tournament.refresh_chip_cap_inputs');
          return null;
        }
        const { count, error } = read.value;
        return !error && typeof count === 'number' ? count : null;
      };

      const entrants = settledCount(entrantsRead);
      if (entrants !== null && entrants > this.entrantCountForChipCap) {
        this.entrantCountForChipCap = entrants;
      }
      const rebuys = settledCount(rebuysRead);
      if (rebuys !== null && rebuys > this.rebuysGrantedForChipCap) {
        this.rebuysGrantedForChipCap = rebuys;
      }
      const addons = settledCount(addonsRead);
      if (addons !== null && addons > this.addonsGrantedForChipCap) {
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
    // One grace per admitted sweep (SWEEP_MUTATION_GRACE_MS). Reset with the
    // deadline it extends, never carried between sweeps.
    this.eliminationMutationGraceGranted = false;
    // How many of these the single JS thread is carrying at once, and how
    // long one takes. Both are measurement only - see engineInstruments.
    const sweepStartedAt = Date.now();
    eliminationSweepsInflight.inc();

    try {
      // A terminal receipt is already the complete money verdict. Its process
      // tail must outrank every ordinary sweep stage and every completion
      // latch: a prior engine/channel cleanup failure left tournamentFinished
      // true, so falling through to checkFinalTableDeal would otherwise return
      // forever without retrying the retained normal or satellite receipt.
      if (await this.resumeCommittedTerminalCleanup()) return;
      if (sweepStopped()) return;

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

      recoveryStage: {
        if (this.eliminationSweepCursor.nextStage > 0) break recoveryStage;
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

        if (completedStage(1)) return;
      }

      bustStage: {
        if (this.eliminationSweepCursor.nextStage > 1) break bustStage;
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
         * THE INVARIANT — the whole field reads zero. Chips are conserved: every
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
         * Paid seats are now required to hold their exact positive starting
         * stack in the database transaction that creates them. This check is
         * defence in depth against corruption; it is not a delayed-credit gate.
         */
        if (busted && busted.length > 0) {
          /**
           * ONE QUESTION, ONE ROUND TRIP (2026-09-11).
           *
           * This guard and the ladder seed below each read the same
           * `status='playing'` count, back to back, with nothing written in
           * between. A sweep is a chain of awaited PostgREST calls, and on
           * 2026-09-11 each link cost the network trip plus a main event-loop
           * delay of 142 ms p50 at 07:22 and 490 ms at 07:51; a sweep with a
           * bust to record spent its whole 5 s budget on reads before its first
           * elimination 161 times in the 38 minutes after the 06:57 boot. So
           * the count is read once and answers both questions. A failed read
           * now defers the batch instead of skipping the guard and reading
           * again - the fail-closed direction the second read already took.
           */
          // Get current remaining count BEFORE processing any eliminations
          const { count: playingCount, error: playingErr } = await supabase
            .from('tournament_players')
            .select('*', { count: 'exact', head: true })
            .eq('tournament_id', this.tournamentId)
            .eq('status', 'playing');
          if (sweepStopped()) return;
          if (
            !playingErr &&
            typeof playingCount === 'number' &&
            playingCount > 0 &&
            busted.length >= playingCount
          ) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] all ${playingCount} live player(s) read 0 chips - uncredited stacks, not a bust. Eliminating nobody this sweep.`
              ),
              'Tournament.zero_chip_field_refused'
            );
            return; // the finally block clears isProcessingEliminations
          }

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
          // The global hand order must be known BEFORE taking the bounded
          // mutation batch. Slicing the zero-chip rows first would choose an
          // arbitrary twenty-player subset, then allow a later hand in that
          // subset to advance the PKO watermark past an earlier hand left for
          // the next pass. Chunk the id predicate so a backlog cannot exceed
          // an HTTP request-line limit; any unreadable chunk fails the whole
          // pass closed because partial order evidence is not an order.
          const bustHandNumbers = new Map<string, number>();
          const bustStartingStacks = new Map<string, number>();
          const bustOrderLookupSize = 40;
          for (let offset = 0; offset < busted.length; offset += bustOrderLookupSize) {
            const userIds = busted
              .slice(offset, offset + bustOrderLookupSize)
              .map((player) => player.user_id);
            // Every generation of these players, not only the pending ones: the
            // order must come from the generation the door binds, which is the
            // LATEST whatever its state (bustOrder.ts). Keeping the earliest
            // pending hand ranked a player by an orphan the 2026-09-08/09 rebuy
            // chain left behind, a day before the bust the door records.
            // PostgREST truncates a response at its row cap without saying so,
            // so the exact match count comes back with the rows and a short
            // read is an unreadable order (knockoutCandidateReadIsComplete).
            // Forty players would need more than 25 generations each to reach
            // the default cap of 1000.
            const {
              data: bustHands,
              error: bustHandsErr,
              count: bustHandsCount,
            } = await supabase
              .from('tournament_knockout_candidates')
              .select('id, eliminated_user_id, hand_number, stack_before, state', {
                count: 'exact',
              })
              .eq('tournament_id', this.tournamentId)
              .in('eliminated_user_id', userIds)
              .order('hand_number', { ascending: false });
            if (sweepStopped()) return;
            if (bustHandsErr || !knockoutCandidateReadIsComplete(bustHands, bustHandsCount)) {
              reportError(
                bustHandsErr ??
                  new Error(
                    `[Tournament:${this.tournamentId.slice(0, 8)}] knockout generations read ${bustHands?.length ?? 0} of ${bustHandsCount ?? 'an unknown number of'} rows; the bust order is not known`
                  ),
                'Tournament.bust_order_unreadable'
              );
              this.requestUrgentEliminationSweepAfter(
                TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS
              );
              return;
            }
            for (const [uid, bust] of bindLatestKnockoutCandidates(bustHands ?? [])) {
              bustHandNumbers.set(uid, bust.handNumber);
              bustStartingStacks.set(uid, bust.stackBefore);
            }
          }

          // UNKNOWN sorts LAST. A missing candidate must never claim it busted
          // first and take a place that belongs to somebody the engine watched.
          const bustRank = (userId: string): number =>
            bustHandNumbers.get(userId) ?? Number.MAX_SAFE_INTEGER;
          const bustStartingStack = (userId: string): number =>
            bustStartingStacks.get(userId) ?? Number.MAX_SAFE_INTEGER;
          type BustedPlayer = NonNullable<typeof busted>[number];
          const compareBusted = (a: BustedPlayer, b: BustedPlayer): number =>
            bustRank(a.user_id) - bustRank(b.user_id) ||
            bustStartingStack(a.user_id) - bustStartingStack(b.user_id) ||
            (this.bustRefusalStreak.get(a.user_id) ?? 0) -
              (this.bustRefusalStreak.get(b.user_id) ?? 0) ||
            a.user_id.localeCompare(b.user_id);

          const bustedTotal = busted.length;
          if (busted.length > TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE) {
            busted = [...busted]
              .sort(compareBusted)
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
              // The rebuy transaction owns its exact playable chair and stack.
              // This process consumes only the success receipt; it never scans
              // for a seatless roster or performs a later compensating write.
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
           * the next bust snapshot. The rebuy transaction itself restores the
           * exact playable chair — same table and seat whenever still legal —
           * rather than depending on a periodic manager repair.
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
           * The whole zero-stack field is ordered BEFORE the bounded batch is
           * cut. Hand number comes first, then the accepted hand's starting
           * stack for a same-hand tie. That makes the watermark monotonic and
           * gives the smaller starting stack the worse finishing place. A
           * refusal may rotate only an otherwise exact tie; it can never let a
           * later hand pass an earlier one. Missing evidence sorts last.
           *
           * The place handed out in this order is PROVISIONAL (2026-09-11).
           * Hand number is the deal order, which the PKO watermark needs; the
           * finish, fn_settle_tournament_places, ranks every bust by the
           * COMMIT time of its hand before it pays, and for busts at different
           * tables the two orders can disagree (bustOrder.ts).
           */
          let bustedOrdered = [...busted].sort(compareBusted);

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
          // atomic late registration can promote a `registered` entrant to
          // `playing` after eliminations have begun — so a later sweep could compute a
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
           *     atomically promoted out of `registered` is not in it. On
           *     4f42d847 the first bust was seeded at 38 while 39
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
           *
           * The two ladder inputs are independent reads, so they share one
           * round trip (2026-09-11, see ONE QUESTION, ONE ROUND TRIP above).
           * Both are still checked, in the same order, before anybody is
           * placed; sequential reads were never a consistent snapshot either.
           */
          const [takenRead, unplacedRead] = await Promise.all([
            supabase
              .from('tournament_players')
              .select('position')
              .eq('tournament_id', this.tournamentId)
              .not('position', 'is', null),
            // Players who hold no finishing place yet. Monotonic, and immune to
            // the late-reg promotion that made `playingCount` drift.
            supabase
              .from('tournament_players')
              .select('*', { count: 'exact', head: true })
              .eq('tournament_id', this.tournamentId)
              .is('position', null),
          ]);
          const { data: takenRows, error: takenErr } = takenRead;
          const { count: unplacedCount, error: unplacedErr } = unplacedRead;
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
          let committedThisPass = 0;
          for (let i = 0; i < bustedOrdered.length; i++) {
            if (!this.running || signal.aborted) return;

            /**
             * A SWEEP THAT CANNOT AFFORD ITS FIRST MUTATION NEVER MAKES ONE.
             *
             * Everything above this line is READS, and on a large backlog they
             * can spend the whole work budget. Every mutation below asks
             * `eliminationMutationAllowed()`, which is false once the budget is
             * gone - so `eliminatePlayer` used to refuse silently, the pass
             * aborted as though the database had said no, the durable wake was
             * never acknowledged, and the next sweep repeated the same reads on
             * the same backlog. Fifteen tournaments were in that livelock for up
             * to 100 minutes on 2026-09-10, three of them holding more than 150
             * busted players each.
             *
             * Yielding is still the rule; buying one bounded extension when this
             * pass has committed NOTHING is what makes the yield a yield rather
             * than a stall. See SWEEP_MUTATION_GRACE_MS for the measurement.
             */
            if (this.eliminationWorkBudgetExpired()) {
              if (committedThisPass > 0 || !this.grantEliminationMutationGrace()) {
                this.requestUrgentEliminationSweepAfter(
                  TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS
                );
                return;
              }
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] bust preparation spent the whole ${TournamentManagerBase.SWEEP_WORK_BUDGET_MS}ms budget with ${bustedOrdered.length} player(s) to record; extending once by ${TournamentManagerBase.SWEEP_MUTATION_GRACE_MS}ms so this sweep commits at least one finish`
                ),
                'Tournament.bust_mutation_grace_granted'
              );
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

            const eliminated = await this.eliminatePlayer(bustedOrdered[i].user_id, place);
            if (sweepStopped()) return;
            // False includes both a deliberate evidence defer and a CAS miss
            // because another generation/process got there first. In either
            // case takenPositions is now stale. Abort the assignment pass;
            // the already-armed unresolved-bust retry rebuilds the ladder
            // from persisted positions before it writes anybody else.
            if (!eliminated) {
              // Remember WHO refused only as the last tiebreak for the same
              // hand and same starting stack. Hand order must never be skipped:
              // doing so would advance a PKO watermark past unpaid money.
              const refusedId = bustedOrdered[i].user_id;
              const streak = (this.bustRefusalStreak.get(refusedId) ?? 0) + 1;
              this.bustRefusalStreak.set(refusedId, streak);

              /**
               * ONE PLAYER THE DOOR CANNOT ACCEPT IS NOT A REASON TO STOP THE
               * WHOLE EVENT (2026-09-10).
               *
               * Aborting the pass is right for a TRANSIENT refusal - a CAS miss
               * or an evidence defer clears itself in seconds, and retrying in
               * hand order costs nothing. It is wrong for a PERMANENT one. The
               * door refuses deterministically for several real reasons
               * (`unresolved_knockout_generation_chain`,
               * `pko_order_already_advanced`,
               * `knockout_generation_has_new_live_seat`), and every one of them
               * used to freeze the event: no other bust could be recorded, the
               * field never shrank, the event never finished, and its escrow
               * was never paid to anybody. Measured today: seven events stuck
               * that way for up to eighteen hours, one refusing the same player
               * every fifteen seconds since 2026-09-08, together holding
               * thousands of chips no player could be given.
               *
               * So the abort stands for the first two refusals of the same
               * player, and after that this pass records the rest of the field
               * and says out loud who it could not record. Skipping is the
               * lesser harm and it is bounded: hand order is preserved for
               * everyone the door accepts, the blocked player is stamped with
               * the commit time of the hand that busted them when they are
               * finally recorded, and fn_settle_tournament_places - the
               * engine's terminal cash authority - ranks every bust by that
               * hand's commit time before it pays, not by when it was recorded
               * (20260911062048). A skipped player recorded late therefore
               * finishes where they busted - in a cash ladder; a satellite or
               * a final-table deal still pays the recording order
               * (bustOrder.ts). For the two refusals that can never clear by
               * themselves - `unresolved_knockout_generation_chain`, and
               * `knockout_bust_time_unproven` for a generation the player
               * played on from - the door also writes one critical
               * financial_alerts row per player
               * (`knockout_door.payout_blocked_by_unrecordable_bust`), so the
               * stuck event reaches the money board and not only this log
               * line.
               */
              if (streak < TournamentManagerBase.BUST_REFUSAL_SKIP_AFTER) return;
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] the knockout door has refused ${refusedId.slice(0, 8)} ${streak} times running; recording the rest of the field and leaving that bust for the door to accept. The event no longer waits on one player it cannot record.`
                ),
                'Tournament.bust_blocked_player_skipped'
              );
              this.requestUrgentEliminationSweepAfter(
                TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS
              );
              continue;
            }
            this.bustRefusalStreak.delete(bustedOrdered[i].user_id);
            committedThisPass++;
            takenPositions.add(place);
            nextPosition = Math.min(nextPosition, place) - 1;
          }
        }

        if (bustBatchHasMore) {
          this.requestEliminationSweep();
          return;
        }

        if (completedStage(2)) return;
      }

      finishStage: {
        if (this.eliminationSweepCursor.nextStage > 2) break finishStage;
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
              this.rearmIfTheFinishWasRefused();
            } else if ((remainingCount || 0) === 0) {
              // THE DURABLE WINNER OUTRANKS THE LAST BUST (2026-09-10). Once the
              // terminal authority has settled the event, the champion is no
              // longer 'playing' but 'winner'; a manager that reads the field
              // only now (re-admitted after a lease loss, or a second engine)
              // used to see zero live players and hand the runner-up in as its
              // observed winner. The database then refused every replay of that
              // contradiction. Ask for the witness that was there first.
              const { data: durableWinner, error: durableWinnerErr } = await supabase
                .from('tournament_players')
                .select('user_id')
                .eq('tournament_id', this.tournamentId)
                .eq('status', 'winner')
                .eq('position', 1)
                .maybeSingle();
              if (sweepStopped()) return;
              if (durableWinnerErr) {
                reportError(durableWinnerErr, 'Tournament.finish_durable_winner_unreadable');
                this.requestUrgentEliminationSweepAfter(
                  TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS
                );
                return;
              }
              if (durableWinner) {
                await this.finishTournament(durableWinner.user_id);
                if (sweepStopped()) return;
                this.rearmIfTheFinishWasRefused();
              } else {
                // Without a committed winner, use the durable elimination sequence.
                // Timestamp ties and out-of-order callbacks cannot nominate a winner.
                const { data: lastEliminated, error: lastEliminatedErr } = await supabase
                  .from('tournament_players')
                  .select('user_id')
                  .eq('tournament_id', this.tournamentId)
                  .eq('status', 'eliminated')
                  .not('elimination_sequence', 'is', null)
                  .order('elimination_sequence', { ascending: false })
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
                    `[Tournament:${this.tournamentId.slice(0, 8)}] No survivor - final durable elimination submitted to terminal authority`
                  );
                  await this.finishTournament(lastEliminated.user_id);
                  if (sweepStopped()) return;
                  this.rearmIfTheFinishWasRefused();
                } else {
                  reportError(
                    new Error(
                      `[Tournament:${this.tournamentId.slice(0, 8)}] No survivor or durable final elimination witness`
                    ),
                    'Tournament.finish_elimination_witness_unavailable'
                  );
                  this.requestUrgentEliminationSweepAfter(
                    TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS
                  );
                  return;
                }
              }
            }
          } catch (finishErr) {
            reportError(finishErr, 'Tournament.finish_tournament_error_will_retry');
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
            return;
          }
        }

        if (completedStage(3)) return;
      }

      finalDealStage: {
        if (this.eliminationSweepCursor.nextStage > 3) break finalDealStage;
        // FINAL TABLE DEAL (2026-08-22 parity): while the field is down to one
        // table and the feature is on, an explicit review parks the dealer.
        // Consent then refers to the stable post-hand proposal; the shared
        // scheduler keeps that bounded review reachable until it closes.
        if (!(await this.checkFinalTableDeal())) return;
        if (sweepStopped()) return;
        if (completedStage(4)) return;
      }

      addOnStage: {
        if (this.eliminationSweepCursor.nextStage > 4) break addOnStage;
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
        if (completedStage(5)) return;
      }

      balanceStage: {
        if (this.eliminationSweepCursor.nextStage > 5) break balanceStage;
        // A tournament break freezes seat movement as well as dealing. A
        // balance operation closes one live seat and opens another, so it may
        // only run after the same maintenance predicate used by the table
        // engines has proved the platform thawed.
        if (!isMaintenanceFrozen()) {
          await this.checkTableBalance();
          if (sweepStopped()) return;

          // A balance the budget cut short is re-entered with a fresh budget
          // (once per cycle), never recorded as done. See balanceRetriedThisCycle.
          if (this.eliminationWorkBudgetExpired()) {
            if (!this.balanceRetriedThisCycle) {
              this.balanceRetriedThisCycle = true;
              this.requestEliminationSweep();
              return;
            }
            this.balanceOwedAfterCycle = true;
          }

          if (!this.eliminationWorkBudgetExpired()) this.frozenStagesOwed.delete(5);

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
        } else {
          // The skipped stage owes one pass when the actual freeze lifts.
          this.frozenStagesOwed.add(5);
          this.owePassAfterTheThaw();
        }
        if (completedStage(6)) return;
      }

      expansionStage: {
        if (this.eliminationSweepCursor.nextStage > 6) break expansionStage;
        // FIX 155: Check if new tables need to be created during rebuy/late-reg period
        if (!isMaintenanceFrozen() && !(await this.checkDynamicTableExpansion())) return;
        if (sweepStopped()) return;
        // The same debt as the balance stage above: an expansion the freeze
        // skipped is asked for again after the thaw, never dropped.
        if (isMaintenanceFrozen()) {
          this.frozenStagesOwed.add(6);
          this.owePassAfterTheThaw();
        } else {
          this.frozenStagesOwed.delete(6);
        }
        if (completedStage(7)) return;
      }

      handForHandStage: {
        if (this.eliminationSweepCursor.nextStage > 7) break handForHandStage;
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
              // from the final funded pool: seat, noncash ticket, or cash
              // entitlements plus a distinct remainder recipient when one exists. Before entry
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
                  if (!this.isOnBreak()) {
                    for (const engine of this.tableEngines.values()) engine.resumeDealing();
                  }
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
              payoutCount = deepestCanonicalPaidPlace(paidPlaces);
            }

            if (payoutCount > 0 && playingNow === payoutCount + 1 && !this.handForHandActive) {
              this.handForHandActive = true;
              if (!this.handForHandAnnounced) {
                this.handForHandAnnounced = true;
                console.log(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] HAND-FOR-HAND - ${playingNow} players, paid through place ${payoutCount}`
                );
                await this.broadcast('hand_for_hand', {
                  active: true,
                  playersRemaining: playingNow,
                  paidPositions: payoutCount,
                });
                if (sweepStopped()) return;
                // A current break already parks these tables with its longer budget.
                if (!this.isOnBreak()) {
                  for (const engine of this.tableEngines.values()) {
                    engine.pauseAfterHand();
                  }
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
              // Ending the bubble cannot release an overlapping tournament break.
              if (!this.isOnBreak()) {
                for (const engine of this.tableEngines.values()) {
                  engine.resumeDealing();
                }
              }
            }
          }
        }
        if (completedStage(8)) return;
      }
      this.eliminationSweepCursor.reset();
      this.balanceRetriedThisCycle = false;
      if (
        this.balanceOwedAfterCycle ||
        (!isMaintenanceFrozen() && this.frozenStagesOwed.size > 0)
      ) {
        this.balanceOwedAfterCycle = false;
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      }
      completedWholeSweep = true;
    } catch (err) {
      reportError(err, 'Tournament.elimination_check_error');
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
   * Give busted HORSES their configured recovery, subject to the event and
   * deterministic horse policy.
   *
   * Every eligibility rule (the configured product, its level window,
   * database cap, stack state and funding) is enforced inside
   * process_tournament_rebuy, which also does the chip debit, the prize-pool
   * increment and the single rake booking in one transaction. So this asks
   * and lets the database say no -- the refusals ('Rebuy limit reached',
   * 'Insufficient club chips', 'Rebuy period has closed') are all NORMAL and
   * are counted, not reported as errors.
   *
   * Horses only. A real player's rebuy is their own decision and is taken
   * through the client.
   *
   * Bounded by construction: the database event cap/window plus the Free Buy
   * horse's deterministic 0-5 allowance, so this cannot loop indefinitely.
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
      | {
          is_rebuy?: boolean;
          is_reentry?: boolean;
          free_buy?: boolean;
          rebuy_levels?: number | null;
          late_reg_levels?: number | null;
        }
      | undefined;
    if ((!t?.is_rebuy && !t?.is_reentry) || bustedUserIds.length === 0) {
      return { rebought, answered };
    }
    // The horse input device follows the event's executable recovery product.
    // Prefer a rebuy when both legacy flags are present; a re-entry-only event
    // must not silently eliminate every horse while humans retain the option.
    const recoveryType = t.is_rebuy ? 'rebuy' : 'reentry';
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
      let freeBuyReloads: Map<string, number> | null = null;
      if (t.free_buy === true) {
        const horseIds = horseRows.map((horse) => String(horse.id));
        const { data: reloadRows, error: reloadErr } = await supabase
          .from('tournament_players')
          .select('user_id, rebuys')
          .eq('tournament_id', this.tournamentId)
          .in('user_id', horseIds);
        if (!this.eliminationMutationAllowed()) return { rebought, answered };
        if (reloadErr || !Array.isArray(reloadRows)) {
          // Unknown allowance state is not a decline. Preserve the decision
          // window and retry rather than either charging or eliminating.
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
          return { rebought, answered };
        }
        freeBuyReloads = new Map(
          reloadRows.map((row) => [
            String(row.user_id),
            Math.max(0, Math.floor(Number(row.rebuys) || 0)),
          ])
        );
      }
      for (const h of horseRows) {
        if (!this.eliminationMutationAllowed()) return { rebought, answered };
        if (freeBuyReloads) {
          const used = freeBuyReloads.get(h.id);
          if (used === undefined) {
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
            continue;
          }
          if (used >= horseRebuyAllowance(h.id, this.tournamentId)) {
            answered.add(h.id);
            continue;
          }
        }
        const { data, error } = await supabase.rpc('process_tournament_rebuy', {
          p_tournament_id: this.tournamentId,
          p_user_id: h.id,
          p_rebuy_type: recoveryType,
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
   * Load the one hand that is allowed to authorize a bounty elimination.
   *
   * The accepted-hand transaction freezes a `tournament_knockout_candidates`
   * row before it writes the matching `hand_atomic_commits` receipt. A seat is
   * operational state: the physical row may already be closed, moved or reused
   * by a rebuy. It may veto a stale candidate, but it must never choose the
   * table, generation or hand that receives money.
   *
   * Query every candidate state, newest hand first, and THEN require `pending`.
   * Filtering to pending in SQL would let an older unresolved bust leap over a
   * newer rebought/eliminated generation. The exact atomic receipt and history
   * row independently prove the candidate's table, hand id, hand number, zero
   * stack and pot claimant before the bounty RPC can mutate anything.
   */
  protected async loadPersistedBountyEvidence(
    userId: string
  ): Promise<CandidateBackedKnockoutEvidence | null> {
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
      const { data: candidateRow, error: candidateErr } = await supabase
        .from('tournament_knockout_candidates')
        .select(
          'id,table_id,seat_id,seat_joined_at,hand_id,hand_number,stack_before,stack_after,state'
        )
        .eq('tournament_id', this.tournamentId)
        .eq('eliminated_user_id', userId)
        .order('hand_number', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (candidateErr) return defer('latest knockout candidate is unreadable', candidateErr);

      const candidate = candidateRow as {
        id?: unknown;
        table_id?: unknown;
        seat_id?: unknown;
        seat_joined_at?: unknown;
        hand_id?: unknown;
        hand_number?: unknown;
        stack_before?: unknown;
        stack_after?: unknown;
        state?: unknown;
      } | null;
      const candidateId = String(candidate?.id ?? '').trim();
      const tableId = String(candidate?.table_id ?? '').trim();
      const seatId = String(candidate?.seat_id ?? '').trim();
      const seatJoinedAt = String(candidate?.seat_joined_at ?? '').trim();
      const handId = String(candidate?.hand_id ?? '').trim();
      const handNumber = Number(candidate?.hand_number);
      const stackBefore = Number(candidate?.stack_before);
      const stackAfter = Number(candidate?.stack_after);
      if (
        !candidateId ||
        !tableId ||
        !seatId ||
        !seatJoinedAt ||
        !handId ||
        !Number.isSafeInteger(handNumber) ||
        !Number.isFinite(stackBefore) ||
        stackBefore <= 0 ||
        !Number.isFinite(stackAfter) ||
        stackAfter !== 0 ||
        !Number.isFinite(Date.parse(seatJoinedAt))
      ) {
        return defer('latest knockout candidate has an invalid immutable identity');
      }
      if (candidate?.state !== 'pending') {
        return defer(`latest knockout candidate is ${String(candidate?.state ?? 'invalid')}`);
      }

      // A live seat is never positive authorization. The accepted hand closes
      // the zero-stack seat, so no row is normal. One exact zero-stack legacy
      // row is tolerated until the RPC closes it; every other live shape proves
      // the candidate is stale or the player has already entered a new generation.
      const { data: liveSeatRows, error: liveSeatErr } = await supabase
        .from('table_seats')
        .select('id,table_id,joined_at,stack,tables!table_seats_table_id_fkey!inner(tournament_id)')
        .eq('user_id', userId)
        .eq('tables.tournament_id', this.tournamentId)
        .is('left_at', null)
        .limit(2);
      if (liveSeatErr) return defer('live-seat safety veto is unreadable', liveSeatErr);
      const liveSeats = (liveSeatRows ?? []) as Array<{
        id?: unknown;
        table_id?: unknown;
        joined_at?: unknown;
        stack?: unknown;
      }>;
      if (liveSeats.length > 1) return defer('multiple live tournament seats veto the candidate');
      if (liveSeats.length === 1) {
        const live = liveSeats[0];
        if (
          String(live.id ?? '') !== seatId ||
          String(live.table_id ?? '') !== tableId ||
          Date.parse(String(live.joined_at ?? '')) !== Date.parse(seatJoinedAt) ||
          !Number.isFinite(Number(live.stack)) ||
          Number(live.stack) !== 0
        ) {
          return defer('a different or funded live seat generation vetoes the candidate');
        }
      }

      const { data: atomicRow, error: atomicErr } = await supabase
        .from('hand_atomic_commits')
        .select('table_id,hand_id,hand_number,stack_result,committed_at')
        .eq('table_id', tableId)
        .eq('hand_number', handNumber)
        .eq('hand_id', handId)
        // The immutable candidate chooses the exact hand. This additional
        // range bound makes a malformed pre-rebuy receipt impossible to read
        // as evidence for the candidate's newer seat generation.
        .gte('committed_at', seatJoinedAt)
        .maybeSingle();
      if (atomicErr)
        return defer(`atomic receipt for hand #${handNumber} is unreadable`, atomicErr);
      const atomic = atomicRow as {
        table_id?: unknown;
        hand_id?: unknown;
        hand_number?: unknown;
        stack_result?: StackSettlementResult;
        committed_at?: unknown;
      } | null;
      if (
        String(atomic?.table_id ?? '') !== tableId ||
        String(atomic?.hand_id ?? '') !== handId ||
        Number(atomic?.hand_number) !== handNumber ||
        !Number.isFinite(Date.parse(String(atomic?.committed_at ?? ''))) ||
        Date.parse(String(atomic?.committed_at ?? '')) < Date.parse(seatJoinedAt)
      ) {
        return defer(`atomic receipt for hand #${handNumber} does not match its candidate`);
      }
      const settlement = atomic?.stack_result;
      const identity = acceptedZeroStackSettlement(settlement, userId);
      if (identity?.tableId !== tableId || identity.handNumber !== handNumber) {
        return defer(
          `atomic receipt for hand #${handNumber} is not an exact zero-stack settlement`
        );
      }

      const { data: hand, error: handErr } = await supabase
        .from('hand_history')
        .select('id, table_id, hand_number, winners, players, pots')
        .eq('id', handId)
        .eq('table_id', tableId)
        .eq('hand_number', handNumber)
        .maybeSingle();
      if (handErr) return defer(`knockout hand #${handNumber} is unreadable`, handErr);

      const evidence = persistedKnockoutEvidence(settlement, hand, userId);
      if (!evidence.ready) {
        /* A PLACE IS NOT A BOUNTY (2026-09-10).
           `knocker_not_attributable` is the ONE deferral reason that says
           nothing about whether the player busted. Everything above it - the
           accepted zero-stack settlement, the matching atomic receipt, the
           player at zero in the history roster - has already passed, so the
           bust is proven; what is missing is only the pot ledger that would
           name who takes the head. Deferring on it withheld the finishing
           place too, and an unranked player keeps the event from finishing:
           27 busts across nine events sat unrecorded for up to 44 hours,
           holding prize escrow that had nothing to do with bounties.

           Admit the elimination on the candidate's own evidence and mark the
           attribution unavailable. The door records the place, writes no
           obligation, and leaves the head in the pool as residual. Every
           other reason still defers, because every other reason means the
           bust itself is not proven. */
        if (evidence.reason !== 'knocker_not_attributable') {
          return defer(`knockout hand #${handNumber} is not authoritative (${evidence.reason})`);
        }
        this.bountyEvidenceDeferred.delete(userId);
        return {
          ready: true,
          tableId,
          handId,
          handNumber,
          settledAt: String(atomic?.committed_at ?? ''),
          candidateId,
          seatId,
          seatJoinedAt,
          attribution: { knockerUserId: null, claimants: [], basis: 'none', potIndex: null },
          attributionUnavailable: true,
        };
      }
      if (evidence.handId !== handId) {
        return defer(`knockout hand #${handNumber} does not match its candidate hand id`);
      }

      this.bountyEvidenceDeferred.delete(userId);
      return {
        ...evidence,
        settledAt: String(atomic?.committed_at ?? ''),
        candidateId,
        seatId,
        seatJoinedAt,
      };
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
        'payout_structure, prize_pool, bubble_protection, buy_in_amount, is_bounty, is_pko, is_mystery_bounty, bounty_amount, mystery_bounty_min, mystery_bounty_max, variant, tournament_type, satellite_target_id, spin_multiplier'
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
    // Prove the immutable candidate and its exact accepted hand BEFORE the
    // status CAS. A live or historical seat never selects bounty identity.
    const bountyEvidence = hasBounty ? await this.loadPersistedBountyEvidence(userId) : null;
    if (!this.eliminationMutationAllowed()) return false;
    if (hasBounty && !bountyEvidence) {
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
        // Once entry is closed, result facts and the elimination broadcast
        // must price the same pool-funded Bubble Promise as terminal SQL.
        // Before that cutoff the field and ladder remain provisional.
        const ladderPool = prizePoolAvailableToPlaces(
          Number(tournament.prize_pool || 0),
          payouts,
          safeField ?? deepestCanonicalPaidPlace(payouts),
          tournament.bubble_protection === true,
          Number(tournament.buy_in_amount)
        );
        if (ladderPool === null) {
          reportError(
            new Error('Cannot price an unfunded or malformed Bubble Promise'),
            'Tournament.elimination_ladder_pool_invalid'
          );
          return false;
        }
        prize = computePlacePrize(ladderPool, payouts, position);
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
      /* A PLACE IS NOT A BOUNTY (2026-09-10). With no attribution there is no
         claimant to propose. NULL means "you work it out"; an EMPTY ARRAY is
         refused by the door as `invalid_claimants`, which is the freeze this
         change exists to end. */
      const headNotAttributable = bountyEvidence!.attributionUnavailable === true;
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
          p_seat_joined_at: bountyEvidence!.seatJoinedAt,
          p_knocker_user_id: headNotAttributable ? null : attribution.knockerUserId!,
          p_claimants: headNotAttributable
            ? null
            : attribution.claimants.map((claimant) => ({
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
        /** Set by the door when it placed the player but could not settle the head. */
        bounty_blocked?: string | null;
      };
      const semanticClaimAccepted =
        !claimErr && claim.ok === true && (claim.claimed === true || claim.already === true);
      /* A PLACE IS NOT A BOUNTY (2026-09-10). The door reports, in the same
         accepted response, that it recorded the elimination and deliberately
         wrote NO obligation because the head could not be settled. There is
         therefore no obligation row to reconcile against, and demanding one
         would reject a commit that already happened. */
      const bountyHeadNotAttributed =
        semanticClaimAccepted &&
        typeof claim.bounty_blocked === 'string' &&
        claim.bounty_blocked.length > 0;

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
        .eq('table_id', bountyEvidence!.tableId)
        .eq('hand_number', bountyEvidence!.handNumber)
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
      const durableClaim = bountyHeadNotAttributed
        ? true
        : semanticClaimAccepted
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
      if (bountyHeadNotAttributed) {
        // There is no obligation, by design, and therefore no knocker and no
        // claimants. The head stays in the pool; nothing here may pay it.
        bountyMode = String(claim.mode || '');
        durableBountyKnocker = null;
        durableBountyClaimants = [];
      } else {
        bountyMode = String(row!.mode || '');
        durableBountyKnocker = String(row!.knocker_user_id || '');
        durableBountyClaimants = canonicalClaims;
      }
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
    /* A PLACE IS NOT A BOUNTY (2026-09-10). An unattributable head has no
       knocker to pay and no obligation to settle, and processBountyCollection
       requires both. The place is already recorded; the head stays in the pool
       for fn_finalize_bounty_pool to resolve as residual. */
    if (bountyEvidence && bountyEvidence.attributionUnavailable !== true) {
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
        reportError(bountyErr, 'Tournament.bounty_processing_error');
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

    const isSatellite =
      String(this.tournamentCache?.variant ?? '').toLowerCase() === 'satellite' ||
      String(this.tournamentCache?.tournament_type ?? '').toUpperCase() === 'SATELLITE' ||
      Boolean(this.tournamentCache?.satellite_target_id);
    const ladderPool = prizePoolAvailableToPlaces(
      finalPrizePool,
      payouts,
      finalField,
      !isSatellite && this.tournamentCache?.bubble_protection === true,
      Number(this.tournamentCache?.buy_in_amount)
    );
    if (ladderPool === null) {
      reportError(
        new Error('Cannot reprice an unfunded or malformed Bubble Promise'),
        'Tournament.prize_recalc_ladder_pool_invalid'
      );
      return false;
    }

    let complete = true;
    let mutations = 0;
    for (const player of eliminated) {
      const payoutEntry = payouts.find((p: any) => Number(p.place) === Number(player.position));
      const correctPrize = payoutEntry
        ? computePlacePrize(ladderPool, payouts, Number(player.position))
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

        /* Repricing changes the durable entitlement only. Raw service-role
           UPDATE on tournament_players is deliberately revoked: the database
           RPC locks the event and exact roster row, proves that no terminal
           batch or paid-place evidence exists, compares the old amount, and
           commits the new amount as one bounded operation. */
        const expectedPrize = Number(player.prize || 0);
        const { data: recordRaw, error: recordErr } = await supabase.rpc(
          'fn_ca_reprice_unpaid_tournament_place',
          {
            p_tournament_id: this.tournamentId,
            p_user_id: player.user_id,
            p_expected_prize: expectedPrize,
            p_new_prize: correctPrize,
          }
        );
        const record = recordRaw as {
          ok?: boolean;
          tournament_id?: string;
          user_id?: string;
          prize?: number | string;
        } | null;
        const recordInvalid =
          !record ||
          record.ok !== true ||
          record.tournament_id !== this.tournamentId ||
          record.user_id !== player.user_id ||
          !Number.isFinite(Number(record.prize)) ||
          Math.abs(Number(record.prize) - correctPrize) >= 0.005;
        if (recordErr || recordInvalid) {
          complete = false;
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] prize recalc could not certify prize=${correctPrize} for ${player.user_id.slice(0, 8)}: ${recordErr?.message ?? 'invalid database receipt'}; atomic completion will refuse an incomplete prize set`
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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  A REFUSED FINISH ASKS FOR ANOTHER PASS. SOMEBODY HAS TO HEAR IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `finishTournament` has about thirty-five fail-closed exits and every one of
   * them ends `this.tournamentFinished = false`, under a comment that says the
   * flag is released "so the next elimination sweep can resume the durable
   * COMPLETING claim and prepared obligations."
   *
   * THERE IS NO NEXT SWEEP. A sweep is woken by an elimination, and this method
   * is only ever reached once the field is down to its last player - so there
   * is no hand left to deal, nobody left to bust, and nothing left to wake it.
   * The release was a request that nothing was listening for, and the refusal
   * was therefore terminal: whatever the reason (the maintenance freeze, a
   * refused claim, an unreadable row, a transport blip) the event simply stopped
   * where it stood, with its winner unpaid and its status still RUNNING.
   *
   * This was found by reading the control flow, and no production incident is
   * attributed to it: a first pass DID read ten tournaments sitting at one
   * player and called them wedged, and a re-read seven minutes later found nine
   * of the ten already finished. That sample is retracted in the changelog. The
   * defect is the missing listener, which is visible without it.
   *
   * So the flag is read where the call was made. It is not a repair job (10.12)
   * and nothing here back-fills or compensates anything: the finish has not
   * happened yet, and this is the same work being asked for again the moment it
   * can succeed. The scheduler keeps one pending wake per tournament, so an
   * exit that already re-armed (the freeze branch does) coalesces with this.
   */
  private rearmIfTheFinishWasRefused(): void {
    if (this.tournamentFinished) return;
    this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
  }

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
  private committedFinalTableDealReceipt: VerifiedTournamentCompletionReceipt | null = null;
  private committedFinishReceipt: VerifiedTournamentCompletionReceipt | null = null;
  private committedSatelliteReceipt: VerifiedSatelliteSettlementReceipt | null = null;
  /** A terminal result is important, but it may never hold seats/tables open. */
  private static readonly COMMITTED_BROADCAST_ATTEMPTS = 3;
  /** Long enough for a full live hand plus the guarantee and settlement calls. */
  private static readonly FINAL_TABLE_DEAL_PAUSE_MS = 15 * 60_000;
  private lastDealPollAt = 0;
  private proposalAuthorityObserved = false;
  private lastDealVoteCount = -1;
  private finalTableDealReview: {
    reviewId: string;
    tableId: string;
    engine: ServerTableEngine;
    proposalId: string | null;
    revision: string | null;
    closingReason?: 'stale' | 'expired' | 'cancelled';
  } | null = null;

  /**
   * Resume only the non-money tail of an already committed terminal receipt.
   *
   * Returning true means this admission belonged exclusively to terminal
   * cleanup. A failed attempt keeps the receipt in memory and schedules the
   * same manager through the shared causal scheduler; no payout RPC is called
   * again and no fleet watcher or reconciler is introduced.
   */
  private async resumeCommittedTerminalCleanup(): Promise<boolean> {
    let cleaned: boolean;
    if (this.committedFinalTableDealCleanupPending && this.committedFinalTableDealReceipt) {
      cleaned = await this.settleFinalTableDeal(this.committedFinalTableDealReceipt);
    } else if (this.committedFinishReceipt) {
      cleaned = await this.cleanupCommittedTournament(this.committedFinishReceipt);
    } else if (this.committedSatelliteReceipt) {
      cleaned = await this.cleanupCommittedSatellite(this.committedSatelliteReceipt);
    } else {
      return false;
    }

    if (!cleaned && this.running) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
    }
    return true;
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
      try {
        if (await this.broadcast(eventType, payload)) return true;
      } catch (error) {
        reportError(error, 'Tournament.committed_outcome_broadcast_threw', {
          tournamentId: this.tournamentId,
          eventType,
          attempt,
        });
      }
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
   * The immutable receipt already proves every database mutation. A transient
   * process-cleanup failure returns false with the manager alive and every
   * unresolved engine handle retained, allowing the cleanup-only branch to
   * retry without touching a payout function.
   */
  private async cleanupCommittedTablesAndManager(
    closedTableIds: readonly string[]
  ): Promise<boolean> {
    const tableIds = [...closedTableIds];
    const receiptTableIds = new Set(tableIds);
    if (
      receiptTableIds.size !== tableIds.length ||
      tableIds.some((tableId) => typeof tableId !== 'string' || tableId.length === 0)
    ) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] terminal receipt carried duplicate or empty table identity`
        ),
        'Tournament.committed_cleanup_receipt_table_identity_invalid'
      );
      return false;
    }

    let cleanupComplete = true;
    for (const tableId of this.tableEngines.keys()) {
      if (receiptTableIds.has(tableId)) continue;
      cleanupComplete = false;
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] retained manager-only engine ${tableId.slice(0, 8)} because the immutable terminal receipt does not own it`
        ),
        'Tournament.committed_cleanup_engine_provenance_missing'
      );
    }

    for (const tableId of tableIds) {
      const managerEngine = this.tableEngines.get(tableId);
      let released = false;
      if (managerEngine) {
        try {
          await managerEngine.stop();
          released = this.gameServer.unregisterTableEngine(tableId, managerEngine);
        } catch (error) {
          if (!managerEngine.hasReleasedProcessOwnership()) {
            reportError(error, 'Tournament.committed_cleanup_engine_stop_failed', { tableId });
          } else {
            // The immutable receipt makes the snapshot recovery-only, but a
            // rejected cleanup certificate must still be reported. Retire
            // only this exact generation after its process ownership is gone.
            reportError(error, 'Tournament.committed_cleanup_engine_stop_cleanup_failed', {
              tableId,
            });
            released = this.gameServer.unregisterTableEngine(tableId, managerEngine);
          }
        }
      }

      if (!released) {
        try {
          released = await this.gameServer.stopClosedTournamentTableEngine(tableId);
        } catch (error) {
          reportError(error, 'Tournament.committed_cleanup_engine_unregister_threw', { tableId });
        }
      }
      if (!released) {
        cleanupComplete = false;
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] could not release the exact terminal engine owner for receipt table ${tableId.slice(0, 8)}`
          ),
          'Tournament.committed_cleanup_engine_unregister_failed'
        );
      }
    }

    if (!cleanupComplete) return false;

    try {
      await this.cleanupBroadcastChannel();
    } catch (error) {
      reportError(error, 'Tournament.committed_cleanup_channel_failed', {
        tournamentId: this.tournamentId,
      });
      return false;
    }
    this.tableEngines.clear();
    try {
      // This helper normally runs inside the manager's own tracked elimination
      // sweep. stop() applies its lifecycle fence and unregisters the scheduler
      // synchronously, then waits for every admitted sweep to unwind. Awaiting
      // it from this sweep would make each promise wait for the other forever
      // after the terminal receipt had already committed.
      void this.stop().catch((error) =>
        reportError(error, 'Tournament.committed_cleanup_manager_stop_failed', {
          tournamentId: this.tournamentId,
        })
      );
    } catch (error) {
      reportError(error, 'Tournament.committed_cleanup_manager_stop_failed', {
        tournamentId: this.tournamentId,
      });
      return false;
    }
    return true;
  }
  /** Announce one committed Bubble Promise from the immutable receipt. */
  private async announceCommittedBubble(
    receipt: VerifiedTournamentCompletionReceipt
  ): Promise<void> {
    const bubble = receipt.bubbleProtection;
    if (!bubble) return;
    await this.broadcastCommittedOutcome('bubble_protection_paid', {
      userId: bubble.userId,
      position: bubble.position,
      amount: bubble.amount,
    });
  }

  /** Announce and close a normal place settlement, without moving money. */
  private async cleanupCommittedTournament(
    receipt: VerifiedTournamentCompletionReceipt
  ): Promise<boolean> {
    this.tournamentFinished = true;
    this.committedFinishReceipt = receipt;

    const winnerPrize = receipt.winnerAmount;
    await this.broadcastCommittedOutcome('tournament_winner', {
      userId: receipt.winnerId,
      position: 1,
      prize: winnerPrize,
    });
    await this.announceCommittedBubble(receipt);

    const cleaned = await this.cleanupCommittedTablesAndManager(
      receipt.tableClosure.closedTableIds
    );
    if (cleaned) this.committedFinishReceipt = null;
    return cleaned;
  }

  /** Announce and close the one format-owned satellite settlement receipt. */
  private async cleanupCommittedSatellite(
    receipt: VerifiedSatelliteSettlementReceipt
  ): Promise<boolean> {
    this.tournamentFinished = true;
    this.committedSatelliteReceipt = receipt;
    await this.broadcastCommittedOutcome('tournament_winner', {
      userId: receipt.winnerId,
      position: 1,
      prize: receipt.winnerAmount,
    });

    const cleaned = await this.cleanupCommittedTablesAndManager(
      receipt.sourceCloseout.sourceTableIds
    );
    if (cleaned) this.committedSatelliteReceipt = null;
    return cleaned;
  }

  /**
   * FINAL TABLE DEAL (2026-08-22 parity). When the tournament opted in
   * (final_table_deal_enabled) and the field is down to one table
   * (remaining <= table_size), every remaining player may accept the exact current proposal through
   * the versioned deal authority. Proposal-bound unanimity executes the one terminal
   * receipt authority. The database preserves earned structure places,
   * divides the exact remainder by the parked stacks, settles every component,
   * closes every source seat/table, and commits COMPLETED as one transaction.
   * The engine performs presentation and exact process shutdown only after
   * that immutable receipt; it never performs a second durable write.
   *
   * Clients see the feature through the tournaments row realtime
   * (final_table_deal_enabled is on the row); the vote-count broadcast below
   * is the live tally for the Deal button.
   */
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

  /** Read the authoritative session, or claim its snapshot after a physical park. */
  private async readFinalTableDealConsensus(
    alive: ReadonlyArray<{ user_id: string }>,
    beginReviewId?: string
  ): Promise<FinalTableDealConsensus | 'proposal_authority_not_active' | null> {
    let result;
    try {
      result = beginReviewId
        ? await supabase.rpc('fn_begin_tournament_deal_review', {
            p_tournament_id: this.tournamentId,
            p_review_id: beginReviewId,
          })
        : await supabase.rpc('fn_get_tournament_deal_consensus', {
            p_tournament_id: this.tournamentId,
          });
    } catch {
      return null;
    }
    if (!result || typeof result !== 'object') return null;
    const { data, error } = result;
    if (
      !error &&
      data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      data.ok === false &&
      data.reason === 'proposal_authority_not_active'
    )
      return 'proposal_authority_not_active';
    if (
      error ||
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      data.ok !== true ||
      typeof data.ready !== 'boolean' ||
      !Number.isSafeInteger(data.required) ||
      data.required < 0 ||
      !Array.isArray(data.voter_ids) ||
      !['none', 'requested', 'reviewing', 'completed', 'cancelled', 'expired'].includes(
        data.review_state
      )
    )
      return null;

    const noReview = data.review_state === 'none';
    if (data.reason === 'review_stale' && data.ready) return null;
    const stale = data.reason === 'review_stale';
    const reviewExpiresAt =
      typeof data.review_expires_at === 'string' ? Date.parse(data.review_expires_at) : NaN;
    if (noReview) {
      if (data.review_id !== null || data.review_expires_at !== null) return null;
    } else if (
      typeof data.review_id !== 'string' ||
      !UUID.test(data.review_id) ||
      !Number.isFinite(reviewExpiresAt)
    )
      return null;

    if (alive.some((player) => typeof player.user_id !== 'string' || !UUID.test(player.user_id)))
      return null;
    const aliveIds = new Set(alive.map((player) => player.user_id.toLowerCase()));
    if (aliveIds.size !== alive.length) return null;
    if (data.voter_ids.some((id: unknown) => typeof id !== 'string' || !UUID.test(id))) return null;
    const voters = new Set<string>(data.voter_ids.map((id: string) => id.toLowerCase()));
    if (
      voters.size !== data.voter_ids.length ||
      (!stale && [...voters].some((id) => !aliveIds.has(id)))
    )
      return null;
    if (
      data.review_state === 'reviewing' &&
      (data.required < 2 || (!stale && data.required !== alive.length))
    )
      return null;

    const hasProposal =
      typeof data.proposal_id === 'string' &&
      UUID.test(data.proposal_id) &&
      typeof data.revision === 'string' &&
      /^[0-9a-f]{64}$/.test(data.revision);
    if (data.review_state === 'reviewing') {
      if (!hasProposal || (data.ready && voters.size !== data.required)) return null;
    } else if (
      data.proposal_id !== null ||
      data.revision !== null ||
      voters.size !== 0 ||
      data.ready ||
      data.required !== 0
    )
      return null;
    return {
      reviewId: noReview ? null : data.review_id.toLowerCase(),
      reviewState: data.review_state,
      reviewExpiresAt: noReview ? null : reviewExpiresAt,
      stale,
      proposalId: hasProposal ? data.proposal_id.toLowerCase() : null,
      revision: hasProposal ? data.revision : null,
      voters,
      required: data.required,
      ready: data.ready,
    };
  }

  /** Close the exact pre-money review in the database before lifting its dealer fence. */
  private async closeFinalTableDealReview(
    reason: 'stale' | 'expired' | 'cancelled'
  ): Promise<boolean> {
    const review = this.finalTableDealReview;
    if (!review) return true;
    review.closingReason = reason;
    try {
      const { data, error } = await supabase.rpc('fn_close_tournament_deal_review', {
        p_tournament_id: this.tournamentId,
        p_review_id: review.reviewId,
        p_reason: reason,
      });
      if (!error && data?.ok === true && data.review_id === review.reviewId) {
        if (data.review_state === 'completed') {
          this.finalTableDealHandled = true;
          this.tournamentFinished = true;
          this.fenceUnknownTerminalOutcome(
            'Tournament.final_table_deal_review_completed_without_receipt'
          );
          return false;
        }
        if (
          (data.review_state === 'cancelled' || data.review_state === 'expired') &&
          data.proposal_id === null &&
          data.revision === null &&
          data.required === 0 &&
          data.ready === false &&
          Array.isArray(data.voter_ids) &&
          data.voter_ids.length === 0 &&
          typeof data.review_expires_at === 'string' &&
          Number.isFinite(Date.parse(data.review_expires_at))
        ) {
          const running = review.engine.isRunning();
          const ownsEngine =
            this.tableEngines.get(review.tableId) === review.engine &&
            this.gameServer.getTableEngine(review.tableId) === review.engine;
          if (running && !ownsEngine) {
            // The replacement owner must finish retiring this old dealer. Its
            // former manager may not restart a detached, still-running engine.
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.FINAL_TABLE_DEAL_POLL_MS);
            return false;
          }
          if (running) review.engine.releaseTerminalCloseoutPause();
          this.finalTableDealReview = null;
          this.requestUrgentEliminationSweepAfter(0);
          return true;
        }
      }
    } catch (error) {
      reportError(error, 'Tournament.final_table_deal_review_close_unavailable');
    }
    this.requestUrgentEliminationSweepAfter(TournamentManagerBase.FINAL_TABLE_DEAL_POLL_MS);
    return false;
  }

  /**
   * An explicit review request parks the exact dealer before players see and
   * accept a stable proposal. The shared scheduler checks consent while that
   * fence remains owned. Only database-confirmed closure can resume play.
   */
  protected async checkFinalTableDeal(): Promise<boolean> {
    if (this.committedFinalTableDealCleanupPending && this.committedFinalTableDealReceipt) {
      return this.settleFinalTableDeal(this.committedFinalTableDealReceipt);
    }
    if (this.finalTableDealHandled || this.tournamentFinished) return true;
    if (this.finalTableDealReview?.closingReason) {
      return this.closeFinalTableDealReview(this.finalTableDealReview.closingReason);
    }

    const t = this.tournamentCache as {
      status?: string;
      final_table_deal_enabled?: boolean;
      table_size?: number;
      variant?: string;
      tournament_type?: string;
      satellite_target_id?: string | null;
      satellite_target?: string | null;
    } | null;
    if (!t || t.final_table_deal_enabled !== true || t.status !== 'RUNNING') {
      return this.closeFinalTableDealReview('stale');
    }

    // A satellite has a separate whole-format receipt and can never enter the
    // cash prize-chop authority, regardless of which legacy marker identifies it.
    const isSatelliteDeal =
      String(t.variant ?? '').toLowerCase() === 'satellite' ||
      String(t.tournament_type ?? '').toUpperCase() === 'SATELLITE' ||
      Boolean(t.satellite_target_id || t.satellite_target);
    if (isSatelliteDeal) return this.closeFinalTableDealReview('stale');

    const now = Date.now();
    if (now - this.lastDealPollAt < 2_000) {
      if (!this.finalTableDealReview) return true;
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.FINAL_TABLE_DEAL_POLL_MS);
      return false;
    }
    this.lastDealPollAt = now;
    const tableSize = Math.max(2, Number(t.table_size) || 9);

    try {
      const { data: alive, error: aliveError } = await supabase
        .from('tournament_players')
        .select('user_id')
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'playing');
      if (aliveError || !alive || alive.length < 2 || alive.length > tableSize) {
        return this.closeFinalTableDealReview('stale');
      }

      let consensus = await this.readFinalTableDealConsensus(alive);
      if (consensus === 'proposal_authority_not_active') {
        if (this.finalTableDealReview || this.proposalAuthorityObserved)
          return this.closeFinalTableDealReview('stale');
        return this.checkLegacyFinalTableDeal();
      }
      if (consensus) this.proposalAuthorityObserved = true;
      if (!consensus) {
        if (!this.finalTableDealReview) return true;
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.FINAL_TABLE_DEAL_POLL_MS);
        return false;
      }
      if (this.finalTableDealReview && consensus.reviewId !== this.finalTableDealReview.reviewId) {
        return this.closeFinalTableDealReview('stale');
      }
      if (!consensus.reviewId || !['requested', 'reviewing'].includes(consensus.reviewState)) {
        return this.closeFinalTableDealReview(
          consensus.reviewState === 'expired' ? 'expired' : 'cancelled'
        );
      }
      if (isMaintenanceFrozen() || this.isOnBreak() || this.handForHandActive) {
        return this.closeFinalTableDealReview('stale');
      }

      const held = await this.authoritativeFinalTableDealEngine();
      if (
        !held ||
        (this.finalTableDealReview &&
          (held.engine !== this.finalTableDealReview.engine ||
            held.tableId !== this.finalTableDealReview.tableId))
      )
        return this.closeFinalTableDealReview('stale');
      const { tableId, engine } = held;
      if (!this.finalTableDealReview) {
        this.finalTableDealReview = {
          reviewId: consensus.reviewId,
          tableId,
          engine,
          proposalId: consensus.proposalId,
          revision: consensus.revision,
        };
        const parked = await engine.parkForTerminalCloseout(
          TournamentManagerEliminations.FINAL_TABLE_DEAL_PAUSE_MS
        );
        if (!parked) return this.closeFinalTableDealReview('stale');
        if (
          isMaintenanceFrozen() ||
          this.isOnBreak() ||
          this.handForHandActive ||
          this.tableEngines.get(tableId) !== engine ||
          this.gameServer.getTableEngine(tableId) !== engine ||
          !engine.isRunning()
        )
          return this.closeFinalTableDealReview('stale');
        const { data: parkedAlive, error: parkedAliveError } = await supabase
          .from('tournament_players')
          .select('user_id')
          .eq('tournament_id', this.tournamentId)
          .eq('status', 'playing');
        if (
          parkedAliveError ||
          !parkedAlive ||
          parkedAlive.length < 2 ||
          parkedAlive.length > tableSize
        ) {
          return this.closeFinalTableDealReview('stale');
        }
        consensus = await this.readFinalTableDealConsensus(
          parkedAlive,
          this.finalTableDealReview.reviewId
        );
        if (
          !consensus ||
          consensus === 'proposal_authority_not_active' ||
          consensus.reviewId !== this.finalTableDealReview.reviewId
        ) {
          return this.closeFinalTableDealReview('stale');
        }
        if (
          this.finalTableDealReview.proposalId &&
          (consensus.proposalId !== this.finalTableDealReview.proposalId ||
            consensus.revision !== this.finalTableDealReview.revision)
        )
          return this.closeFinalTableDealReview('stale');
        this.finalTableDealReview.proposalId = consensus.proposalId;
        this.finalTableDealReview.revision = consensus.revision;
      }
      if (consensus.reviewState !== 'reviewing') {
        return this.closeFinalTableDealReview(
          consensus.reviewState === 'expired' ? 'expired' : 'stale'
        );
      }
      if (
        consensus.stale ||
        consensus.proposalId !== this.finalTableDealReview.proposalId ||
        consensus.revision !== this.finalTableDealReview.revision
      ) {
        return this.closeFinalTableDealReview('stale');
      }
      if (consensus.reviewExpiresAt !== null && Date.now() >= consensus.reviewExpiresAt) {
        return this.closeFinalTableDealReview('expired');
      }
      const { voters } = consensus;
      if (voters.size !== this.lastDealVoteCount) {
        this.lastDealVoteCount = voters.size;
        await this.broadcast('final_table_deal_votes', {
          votes: voters.size,
          required: consensus.required,
          review_id: consensus.reviewId,
          review_state: consensus.reviewState,
          proposal_id: consensus.proposalId,
          revision: consensus.revision,
        });
      }
      if (!consensus.ready) {
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.FINAL_TABLE_DEAL_POLL_MS);
        return false;
      }

      this.finalTableDealHandled = true;
      this.tournamentFinished = true;
      try {
        return await this.completeFinalTableDealAtBoundary(tableId, engine, tableSize, consensus);
      } catch (err) {
        const committedReceipt =
          err instanceof TerminalSettlementCommittedError
            ? err.receipt
            : this.committedFinalTableDealReceipt;
        const outcomeUnknown = err instanceof TerminalSettlementOutcomeUnknownError;
        const provenRefusal = err instanceof TerminalSettlementRefusedError;
        if (committedReceipt) {
          this.committedFinalTableDealReceipt = committedReceipt;
          this.committedFinalTableDealCleanupPending = true;
          reportError(err, 'Tournament.final_table_deal_committed_tail_failed');
          return this.settleFinalTableDeal(committedReceipt);
        }
        if (!provenRefusal) {
          const alertCode = outcomeUnknown
            ? 'Tournament.final_table_deal_outcome_unknown'
            : 'Tournament.final_table_deal_unclassified_failure';
          reportError(err, alertCode);
          try {
            await raiseFinancialAlert(
              'critical',
              alertCode,
              outcomeUnknown
                ? 'Final-table deal may have committed, but its immutable terminal receipt could not be resolved. The tournament manager and every dealer were fenced.'
                : 'Final-table deal failed without a proven pre-commit refusal. The tournament manager and every dealer were fenced until the terminal result is resolved.',
              {
                tournament_id: this.tournamentId,
                outcome_unknown: outcomeUnknown,
                error: err instanceof Error ? err.message : String(err),
              }
            );
          } catch (alertError) {
            reportError(alertError, 'Tournament.final_table_deal_alert_failed', {
              tournamentId: this.tournamentId,
              alertCode,
            });
          }
          this.fenceUnknownTerminalOutcome('Tournament.final_table_deal_manager_stop_failed');
          return false;
        }

        // Only the serialized resolver or an explicit pre-RPC boundary check
        // may prove that no terminal transaction committed and lift the gate.
        this.finalTableDealHandled = false;
        this.tournamentFinished = false;
        await this.closeFinalTableDealReview('stale');
        reportError(err, 'Tournament.final_table_deal_refused');
        return false;
      }
    } catch (err) {
      reportError(err, 'Tournament.final_table_deal_poll_failed');
      if (!this.tournamentFinished) await this.closeFinalTableDealReview('stale');
      return false;
    }
  }

  /**
   * Re-prove the unanimous deal only after the engine has installed its hard
   * between-hands gate. The terminal RPC is the first and only money writer.
   */
  private async completeFinalTableDealAtBoundary(
    tableId: string,
    engine: ServerTableEngine,
    tableSize: number,
    expectedConsensus: FinalTableDealConsensus
  ): Promise<boolean> {
    const parked = await engine.parkForTerminalCloseout(
      TournamentManagerEliminations.FINAL_TABLE_DEAL_PAUSE_MS
    );
    if (!parked) {
      throw new TerminalSettlementRefusedError(
        `Final-table deal could not prove a durable, fully settled hand boundary for ${tableId}`
      );
    }
    if (
      isMaintenanceFrozen() ||
      this.isOnBreak() ||
      this.handForHandActive ||
      this.tableEngines.get(tableId) !== engine ||
      this.gameServer.getTableEngine(tableId) !== engine ||
      !engine.isRunning()
    ) {
      throw new TerminalSettlementRefusedError('Final-table deal engine authority changed');
    }

    const { data: alive, error: aliveError } = await supabase
      .from('tournament_players')
      .select('user_id, chips')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'playing');
    if (
      aliveError ||
      !alive ||
      alive.length < 2 ||
      alive.length > tableSize ||
      alive.some(
        (player: { user_id?: string | null; chips?: number | string | null }) =>
          !player.user_id || !Number.isFinite(Number(player.chips)) || Number(player.chips) <= 0
      )
    ) {
      throw new TerminalSettlementRefusedError('Final-table deal live stack snapshot is invalid');
    }

    const consensus = await this.readFinalTableDealConsensus(alive);
    if (
      consensus === 'proposal_authority_not_active' ||
      !consensus?.ready ||
      consensus.reviewState !== 'reviewing' ||
      consensus.reviewId !== expectedConsensus.reviewId ||
      consensus.stale ||
      consensus.reviewExpiresAt === null ||
      Date.now() >= consensus.reviewExpiresAt ||
      !consensus.proposalId ||
      !consensus.revision ||
      consensus.proposalId !== expectedConsensus.proposalId ||
      consensus.revision !== expectedConsensus.revision ||
      isMaintenanceFrozen() ||
      this.isOnBreak() ||
      this.handForHandActive ||
      this.tableEngines.get(tableId) !== engine ||
      this.gameServer.getTableEngine(tableId) !== engine ||
      !engine.isRunning()
    ) {
      throw new TerminalSettlementRefusedError('Final-table deal unanimity or authority changed');
    }

    const receipt = await requestTournamentTerminalReceipt(
      this.tournamentId,
      'final_table_deal',
      null,
      { dealProposal: { proposalId: consensus.proposalId, revision: consensus.revision } }
    );
    const aliveUsers = new Set(alive.map((player: { user_id: string }) => player.user_id));
    const payoutShapeIsExact =
      receipt.dealShares.length === alive.length &&
      receipt.dealShares.every(
        (share) => aliveUsers.has(share.userId) && Number.isFinite(share.amount) && share.amount > 0
      );
    if (!payoutShapeIsExact) {
      throw new TerminalSettlementCommittedError(
        receipt,
        'Committed final-table receipt did not match the physically parked live roster'
      );
    }

    this.committedFinalTableDealReceipt = receipt;
    this.committedFinalTableDealCleanupPending = true;
    return this.settleFinalTableDeal(receipt);
  }

  /** Pre-cutover behavior, reachable only after authoritative inactivity. */
  private async checkLegacyFinalTableDeal(): Promise<boolean> {
    if (this.committedFinalTableDealCleanupPending && this.committedFinalTableDealReceipt) {
      return this.settleFinalTableDeal(this.committedFinalTableDealReceipt);
    }
    if (this.finalTableDealHandled || this.tournamentFinished) return true;

    const t = this.tournamentCache as {
      status?: string;
      final_table_deal_enabled?: boolean;
      table_size?: number;
      variant?: string;
      tournament_type?: string;
      satellite_target_id?: string | null;
      satellite_target?: string | null;
    } | null;
    if (!t || t.final_table_deal_enabled !== true || t.status !== 'RUNNING') return true;

    // A satellite has a separate whole-format receipt and can never enter the
    // cash prize-chop authority, regardless of which legacy marker identifies it.
    const isSatelliteDeal =
      String(t.variant ?? '').toLowerCase() === 'satellite' ||
      String(t.tournament_type ?? '').toUpperCase() === 'SATELLITE' ||
      Boolean(t.satellite_target_id || t.satellite_target);
    if (isSatelliteDeal) return true;

    const tableSize = Math.max(2, Number(t.table_size) || 9);

    try {
      const { data: alive, error: aliveError } = await supabase
        .from('tournament_players')
        .select('user_id')
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'playing');
      if (aliveError || !alive || alive.length < 2 || alive.length > tableSize) return true;

      const { data: votes, error: votesError } = await supabase
        .from('tournament_deal_votes')
        .select('user_id')
        .eq('tournament_id', this.tournamentId);
      if (votesError || !votes) return true;

      const voters = new Set(votes.map((vote: { user_id: string }) => vote.user_id));
      if (voters.size !== this.lastDealVoteCount) {
        this.lastDealVoteCount = voters.size;
        await this.broadcast('final_table_deal_votes', {
          votes: voters.size,
          required: alive.length,
        });
      }
      if (!alive.every((player: { user_id: string }) => voters.has(player.user_id))) return true;
      if (isMaintenanceFrozen() || this.isOnBreak() || this.handForHandActive) return false;

      const held = await this.authoritativeFinalTableDealEngine();
      if (!held) return false;

      this.finalTableDealHandled = true;
      this.tournamentFinished = true;
      const { tableId, engine } = held;
      try {
        return await this.completeLegacyFinalTableDealAtBoundary(tableId, engine, tableSize);
      } catch (err) {
        const committedReceipt =
          err instanceof TerminalSettlementCommittedError
            ? err.receipt
            : this.committedFinalTableDealReceipt;
        const outcomeUnknown = err instanceof TerminalSettlementOutcomeUnknownError;
        const provenRefusal = err instanceof TerminalSettlementRefusedError;
        if (committedReceipt) {
          this.committedFinalTableDealReceipt = committedReceipt;
          this.committedFinalTableDealCleanupPending = true;
          reportError(err, 'Tournament.final_table_deal_committed_tail_failed');
          return this.settleFinalTableDeal(committedReceipt);
        }
        if (!provenRefusal) {
          const alertCode = outcomeUnknown
            ? 'Tournament.final_table_deal_outcome_unknown'
            : 'Tournament.final_table_deal_unclassified_failure';
          reportError(err, alertCode);
          try {
            await raiseFinancialAlert(
              'critical',
              alertCode,
              outcomeUnknown
                ? 'Final-table deal may have committed, but its immutable terminal receipt could not be resolved. The tournament manager and every dealer were fenced.'
                : 'Final-table deal failed without a proven pre-commit refusal. The tournament manager and every dealer were fenced until the terminal result is resolved.',
              {
                tournament_id: this.tournamentId,
                outcome_unknown: outcomeUnknown,
                error: err instanceof Error ? err.message : String(err),
              }
            );
          } catch (alertError) {
            reportError(alertError, 'Tournament.final_table_deal_alert_failed', {
              tournamentId: this.tournamentId,
              alertCode,
            });
          }
          this.fenceUnknownTerminalOutcome('Tournament.final_table_deal_manager_stop_failed');
          return false;
        }

        // Only the serialized resolver or an explicit pre-RPC boundary check
        // may prove that no terminal transaction committed and lift the gate.
        engine.releaseTerminalCloseoutPause();
        this.finalTableDealHandled = false;
        this.tournamentFinished = false;
        reportError(err, 'Tournament.final_table_deal_refused');
        return false;
      }
    } catch (err) {
      reportError(err, 'Tournament.final_table_deal_poll_failed');
      return false;
    }
  }

  /**
   * Re-prove the unanimous deal only after the engine has installed its hard
   * between-hands gate. The terminal RPC is the first and only durable writer.
   */
  private async completeLegacyFinalTableDealAtBoundary(
    tableId: string,
    engine: ServerTableEngine,
    tableSize: number
  ): Promise<boolean> {
    const parked = await engine.parkForTerminalCloseout(
      TournamentManagerEliminations.FINAL_TABLE_DEAL_PAUSE_MS
    );
    if (!parked) {
      throw new TerminalSettlementRefusedError(
        `Final-table deal could not prove a durable, fully settled hand boundary for ${tableId}`
      );
    }
    if (
      isMaintenanceFrozen() ||
      this.isOnBreak() ||
      this.handForHandActive ||
      this.tableEngines.get(tableId) !== engine ||
      this.gameServer.getTableEngine(tableId) !== engine ||
      !engine.isRunning()
    ) {
      throw new TerminalSettlementRefusedError('Final-table deal engine authority changed');
    }

    const { data: alive, error: aliveError } = await supabase
      .from('tournament_players')
      .select('user_id, chips')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'playing');
    if (
      aliveError ||
      !alive ||
      alive.length < 2 ||
      alive.length > tableSize ||
      alive.some(
        (player: { user_id?: string | null; chips?: number | string | null }) =>
          !player.user_id || !Number.isFinite(Number(player.chips)) || Number(player.chips) <= 0
      )
    ) {
      throw new TerminalSettlementRefusedError('Final-table deal live stack snapshot is invalid');
    }

    const { data: votes, error: votesError } = await supabase
      .from('tournament_deal_votes')
      .select('user_id')
      .eq('tournament_id', this.tournamentId);
    const voters = new Set((votes ?? []).map((vote: { user_id: string }) => vote.user_id));
    if (
      votesError ||
      !votes ||
      voters.size !== alive.length ||
      !alive.every((player: { user_id: string }) => voters.has(player.user_id)) ||
      isMaintenanceFrozen() ||
      this.isOnBreak() ||
      this.handForHandActive ||
      this.tableEngines.get(tableId) !== engine ||
      this.gameServer.getTableEngine(tableId) !== engine ||
      !engine.isRunning()
    ) {
      throw new TerminalSettlementRefusedError('Final-table deal unanimity or authority changed');
    }

    const receipt = await requestTournamentTerminalReceipt(
      this.tournamentId,
      'final_table_deal',
      null,
      { legacyDealAuthority: 'proposal_authority_not_active' }
    );
    const aliveUsers = new Set(alive.map((player: { user_id: string }) => player.user_id));
    const payoutShapeIsExact =
      receipt.dealShares.length === alive.length &&
      receipt.dealShares.every(
        (share) => aliveUsers.has(share.userId) && Number.isFinite(share.amount) && share.amount > 0
      );
    if (!payoutShapeIsExact) {
      throw new TerminalSettlementCommittedError(
        receipt,
        'Committed final-table receipt did not match the physically parked live roster'
      );
    }

    this.committedFinalTableDealReceipt = receipt;
    this.committedFinalTableDealCleanupPending = true;
    return this.settleFinalTableDeal(receipt);
  }

  /** Present and shut down a final-table deal strictly from its stored receipt. */
  private async settleFinalTableDeal(
    receipt: VerifiedTournamentCompletionReceipt
  ): Promise<boolean> {
    this.tournamentFinished = true;
    this.finalTableDealHandled = true;
    this.committedFinalTableDealReceipt = receipt;
    this.committedFinalTableDealCleanupPending = true;

    const payoutRows = [...receipt.dealShares]
      .sort((a, b) => a.place - b.place)
      .map((share) => ({
        user_id: share.userId,
        amount: share.amount,
        rank: share.place,
      }));
    await this.broadcastCommittedOutcome('final_table_deal', {
      payouts: payoutRows,
      chipLeader: receipt.winnerId,
    });
    await this.announceCommittedBubble(receipt);

    const cleaned = await this.cleanupCommittedTablesAndManager(
      receipt.tableClosure.closedTableIds
    );
    if (cleaned) {
      this.committedFinalTableDealCleanupPending = false;
      this.committedFinalTableDealReceipt = null;
    }
    return cleaned;
  }
  /**
   * One record, never a retry: the terminal authority refused this manager's
   * parameters against its stored receipt and the receipt could not be read
   * back. Names the tournament, what was observed and what is stored.
   */
  private async reportTerminalReceiptDisagreement(
    error: TerminalSettlementDisagreementError
  ): Promise<void> {
    reportError(error, 'Tournament.atomic_finish_receipt_disagreement');
    try {
      await raiseFinancialAlert(
        'critical',
        'Tournament.atomic_finish_receipt_disagreement',
        `Tournament ${this.tournamentId} has a stored terminal receipt that disagrees with this manager's finish parameters, and the receipt could not be adopted. The manager stood down without retrying. ${error.message}`,
        {
          tournament_id: this.tournamentId,
          observed_settlement_mode: error.observed.settlementMode,
          observed_winner_id: error.observed.winnerId,
          stored_settlement_mode: error.stored?.settlementMode ?? null,
          stored_winner_id: error.stored?.winnerId ?? null,
          proven_refusal: true,
          outcome_unknown: false,
        }
      );
    } catch (alertErr) {
      reportError(alertErr, 'Tournament.atomic_finish_alert_failed');
    }
  }

  /** The receipt won over this process's observation; say so once, then continue from the receipt. */
  private async reportAdoptedTerminalReceipt(
    observedWinnerId: string,
    receipt: VerifiedTournamentCompletionReceipt
  ): Promise<void> {
    const message =
      `[Tournament:${this.tournamentId.slice(0, 8)}] adopted the stored terminal receipt ` +
      `(${receipt.settlementMode}, winner ${receipt.winnerId.slice(0, 8)}) over this manager's ` +
      `observed winner ${observedWinnerId.slice(0, 8)}; no money moved on this process's view`;
    reportError(new Error(message), 'Tournament.atomic_finish_receipt_adopted');
    try {
      await raiseFinancialAlert('warning', 'Tournament.atomic_finish_receipt_adopted', message, {
        tournament_id: this.tournamentId,
        observed_winner_id: observedWinnerId,
        stored_winner_id: receipt.winnerId,
        stored_settlement_mode: receipt.settlementMode,
      });
    } catch (alertErr) {
      reportError(alertErr, 'Tournament.atomic_finish_alert_failed');
    }
  }

  protected async finishTournament(winnerId: string): Promise<void> {
    // A committed receipt makes this cleanup-only work. It must remain
    // reachable ahead of every local latch and maintenance admission guard.
    if (this.committedFinishReceipt) {
      await this.cleanupCommittedTournament(this.committedFinishReceipt);
      return;
    }
    if (this.committedSatelliteReceipt) {
      await this.cleanupCommittedSatellite(this.committedSatelliteReceipt);
      return;
    }
    // This manager holds service_role, which the database maintenance trigger
    // intentionally exempts. Do not enter the only terminal settlement RPC
    // while the platform freeze is active. A decided event has no later hand
    // or elimination to wake it, so make the deferral visible and explicitly
    // re-arm the same bounded manager work after the thaw.
    if (isMaintenanceFrozen()) {
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] finish deferred: the platform is frozen for the maintenance break; resuming after the thaw`
      );
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
      return;
    }
    if (this.tournamentFinished) return;

    const tournament = this.tournamentCache as {
      variant?: string;
      tournament_type?: string;
      satellite_target_id?: string | null;
      satellite_target?: string | null;
    } | null;
    if (!tournament) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] terminal settlement refused without a loaded tournament identity`
        ),
        'Tournament.finish_identity_unavailable'
      );
      return;
    }

    this.tournamentFinished = true;
    const releaseFinishGuard = (): void => {
      this.tournamentFinished = false;
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
    };
    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] FINALIZING... candidate winner: ${winnerId.slice(0, 8)}`
    );

    const isSatelliteFinish =
      String(tournament.variant ?? '').toLowerCase() === 'satellite' ||
      String(tournament.tournament_type ?? '').toUpperCase() === 'SATELLITE' ||
      Boolean(tournament.satellite_target_id || tournament.satellite_target);

    if (isSatelliteFinish) {
      let receipt: VerifiedSatelliteSettlementReceipt;
      try {
        receipt = await this.processSatelliteAwards(tournament, winnerId);
      } catch (satErr) {
        const provenRefusal = satErr instanceof SatelliteSettlementRefusedError;
        const outcomeUnknown =
          satErr instanceof SatelliteSettlementOutcomeUnknownError || !provenRefusal;
        const message =
          `[Satellite:${this.tournamentId.slice(0, 8)}] atomic terminal settlement ` +
          `${provenRefusal ? 'refused' : 'has an unresolved outcome'}: ` +
          `${satErr instanceof Error ? satErr.message : String(satErr)}`;
        reportError(
          satErr instanceof Error ? satErr : new Error(message),
          outcomeUnknown
            ? 'Tournament.atomic_satellite_finish_outcome_unknown'
            : 'Tournament.atomic_satellite_finish_refused'
        );
        try {
          await raiseFinancialAlert(
            'critical',
            outcomeUnknown
              ? 'Tournament.atomic_satellite_finish_outcome_unknown'
              : 'Tournament.atomic_satellite_finish_refused',
            message,
            {
              tournament_id: this.tournamentId,
              winner_id: winnerId,
              outcome_unknown: outcomeUnknown,
              proven_refusal: provenRefusal,
            }
          );
        } catch (alertErr) {
          reportError(alertErr, 'Tournament.atomic_satellite_finish_alert_failed');
        }
        if (provenRefusal) releaseFinishGuard();
        if (!provenRefusal) await this.stopAndWait();
        return;
      }

      this.committedSatelliteReceipt = receipt;
      await this.cleanupCommittedSatellite(receipt);
      return;
    }

    let receipt: VerifiedTournamentCompletionReceipt;
    try {
      receipt = await requestTournamentTerminalReceipt(this.tournamentId, 'places', winnerId);
    } catch (settlementErr) {
      if (settlementErr instanceof TerminalSettlementDisagreementError) {
        // The database holds a receipt this request contradicts and the
        // receipt could not be adopted. Nothing about that is transient:
        // one alert names the disagreement, and this manager stands down.
        // It is neither re-armed (that was the 5,575-replay loop of
        // 2026-09-10) nor treated as an unknown outcome.
        await this.reportTerminalReceiptDisagreement(settlementErr);
        this.fenceUnknownTerminalOutcome('Tournament.atomic_finish_disagreement_stop_failed');
        return;
      }
      const provenRefusal = settlementErr instanceof TerminalSettlementRefusedError;
      const outcomeUnknown =
        settlementErr instanceof TerminalSettlementOutcomeUnknownError || !provenRefusal;
      reportError(
        settlementErr,
        outcomeUnknown
          ? 'Tournament.atomic_finish_outcome_unknown'
          : 'Tournament.atomic_finish_refused'
      );
      try {
        await raiseFinancialAlert(
          'critical',
          outcomeUnknown
            ? 'Tournament.atomic_finish_outcome_unknown'
            : 'Tournament.atomic_finish_refused',
          outcomeUnknown
            ? 'Tournament completion may have committed but its immutable receipt could not be resolved. Every table engine was stopped.'
            : 'Tournament completion was definitively refused before commit and remains eligible for a corrected retry.',
          {
            tournament_id: this.tournamentId,
            winner_id: winnerId,
            outcome_unknown: outcomeUnknown,
            proven_refusal: provenRefusal,
          }
        );
      } catch (alertErr) {
        reportError(alertErr, 'Tournament.atomic_finish_alert_failed');
      }
      if (provenRefusal) releaseFinishGuard();
      if (!provenRefusal) {
        this.fenceUnknownTerminalOutcome('Tournament.atomic_finish_manager_stop_failed');
      }
      return;
    }

    this.committedFinishReceipt = receipt;
    if (receipt.winnerId.toLowerCase() !== winnerId.toLowerCase()) {
      // The stored receipt was adopted over this manager's own observation.
      // The money is already right (the receipt is the immutable settlement);
      // what needs a record is that this process read the field wrong.
      await this.reportAdoptedTerminalReceipt(winnerId, receipt);
    }
    const winnerPrize = receipt.winnerAmount;
    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] COMPLETE - winner ${receipt.winnerId.slice(0, 8)} received ${winnerPrize}`
    );
    await this.cleanupCommittedTournament(receipt);
  }

  // ── Implemented by TournamentManager (layer 3/3) ──
  protected abstract checkTableBalance(): Promise<void>;
  protected abstract processSatelliteAwards(
    tournament: any,
    winnerId: string
  ): Promise<VerifiedSatelliteSettlementReceipt>;
  protected abstract checkDynamicTableExpansion(): Promise<boolean>;
}
