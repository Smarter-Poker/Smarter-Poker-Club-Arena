/**
 * ServerTableEngine, layer 6/8 — the HAND_COMPLETE settlement pipeline and post-hand tasks.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { HandController } from './HandController.js';
import { TimeBankEngine } from './TimeBankEngine.js';
import { DisconnectEngine } from './DisconnectEngine.js';
import { AtomicStackService, type StackSettlement } from './AtomicStackService.js';
import { StraddleEngine } from './StraddleEngine.js';
import { integrityFeed } from '../integrity/IntegrityFeed.js';
import type { HandHistoryRow } from '../integrity/HandEventAdapter.js';
import { computeSevenDeuceBounties } from './SevenDeuceBounty.js';
import { getFullRakeConfig, detectBBJHit, detectBBJNearMiss } from '../config/RakeConfig.js';
import {
  loadTable,
  syncStacks,
  syncTournamentChips,
  updateTableStatus,
  autoRebuyHorse,
  markSeatAsLeft,
  processLeavePending,
  atomicCashoutVoluntary,
  logBBJCollection,
  logInsuranceSettlement,
  logHandHistory,
  processBBJPayout,
  completeHandSnapshot,
  supabase,
} from '../services/supabase.js';
import type { HandEvent, SeatedPlayer } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { queueUnbankedFee } from '../services/FeeReconciler.js';
import { selectRevealedShowdownResults } from './revealedShowdown.js';
import { ServerTableEngineDealing } from './ServerTableEngineDealing.js';
import { atRebuyStopLoss, horseRebuyAmount } from '../services/HorseRebuyPolicy.js';
import { buildDailyMissionHandEvents } from './dailyMissionEvents.js';
import { checkTournamentChipConservation } from './tournamentChipConservation.js';

/**
 * How long a finished hand stays purchasable. A rabbit hunt is an impulse, and
 * the only other bound is "the map holds the last two hands" — which stops
 * bounding anything the moment a table stops dealing (an idle cash table, a
 * tournament on break, the last two players standing up), leaving an offer from
 * hours ago still buyable.
 */
const RABBIT_HUNT_OFFER_TTL_MS = 90_000;

/**
 * BOMB-POT AWARD LEDGER DURABILITY (2026-08-29).
 *
 * The award-unit write is deliberately fire-and-forget — the money is already
 * recorded by logHandHistory, and a ledger that narrates a settlement must
 * never be able to fail the hand it is narrating. But "cannot fail the hand"
 * had been implemented as "one attempt, then a console.warn on the engine
 * host", which means a single transient error loses a hand's award units
 * PERMANENTLY and SILENTLY.
 *
 * Hand 3364829 (2026-08-29 02:35:08Z, table c4874708) is the proof: a clean
 * two-board showdown, pot 88.00 paid out correctly to the cent, bracketed by
 * hands at 02:31 and 02:37 whose rows both landed — and zero rows of its own.
 * Nothing on the platform noticed; it was found by hand-written SQL.
 *
 * Three attempts with a linear backoff, then reportError. What still slips
 * through is caught by fn_bomb_pot_ledger_gaps, which reconcile_ledger_nightly
 * files as critical — the same "make it LOUD rather than impossible" shape
 * CLAUDE.md section 11.5 settled on for seat-stack exits.
 */
/**
 * MEASURED, THEN WIDENED (2026-08-29, same day).
 *
 * The first cut was 3 attempts with a LINEAR 250ms backoff — 750ms of cover in
 * total. Production then reported the rate: of 457 bomb hands settled after the
 * ledger became complete, 455 wrote their award units and **2 did not**. Both
 * survived three attempts.
 *
 * Three independent transient failures in under a second is not what 0.44%
 * looks like. A short outage window is: one blip a couple of seconds long
 * swallows all three attempts, because they all land inside it.
 *
 * So the backoff is exponential now and the window is about 4.75 seconds
 * (250ms, 750ms, 1.75s, 2s cap) instead of 750ms — long enough to outlast the
 * kind of blip that produced both losses, at no cost to a hand that succeeds
 * first time, which is every hand but two in 457.
 *
 * The cap matters as much as the growth: this runs per settled bomb hand, and
 * an unbounded doubling would have a failing table holding retry timers open
 * across several of its own subsequent hands.
 */
const BOMB_LEDGER_WRITE_ATTEMPTS = 4;
const BOMB_LEDGER_RETRY_BASE_MS = 250;
const BOMB_LEDGER_RETRY_MAX_MS = 2_000;

export abstract class ServerTableEngineSettlement extends ServerTableEngineDealing {
  /**
   * RABBIT HUNT — the paid reveal. Dan 2026-08-25.
   *
   * "The rabbit hunt should pop up when the action is completed, no matter if
   *  it's pre flop, on the flop, on the turn, or on the river... these should
   *  ONLY APPEAR TO THE PLAYER WHO CLICKED the rabbit hunt. VIP members get 100
   *  rabbit hunts a month for free, and they cost 5 diamonds each after that."
   *
   * Every one of those words is enforced HERE rather than on the client, because
   * the previous implementation enforced none of them anywhere: the five cards
   * went out in a room-wide broadcast the instant the hand ended, and the client
   * decided on its own whether to bill. The cards were free to anyone who opened
   * devtools, and visible to every opponent.
   *
   * Order matters: every free check runs BEFORE the charge, so a request that
   * was never going to be honoured cannot take a player's diamonds. Payment is
   * the last gate, and the cards are returned only on its success.
   */
  public async revealRabbitHunt(
    userId: string,
    handNumber?: number
  ): Promise<{
    success: boolean;
    error?: string;
    cards?: import('../types.js').Card[];
    board_length?: number;
    source?: string;
    diamonds_spent?: number;
    diamonds_remaining?: number | null;
    vip_remaining?: number | null;
    uses_remaining?: number | null;
  }> {
    const hand = handNumber ?? this.handCount;
    const offer = this.rabbitHuntOffers.get(hand);

    if (!offer) {
      return { success: false, error: 'Rabbit Hunt Is No Longer Available For That Hand' };
    }
    // A rabbit hunt is an impulse, not a standing option. The only other bound
    // is "the map holds the last two hands", which stops bounding anything the
    // moment a table stops dealing — an idle cash table, a tournament on break,
    // the last two players standing up — and an offer from hours ago stays
    // purchasable. offeredAt was captured for exactly this and was never read.
    if (Date.now() - offer.offeredAt > RABBIT_HUNT_OFFER_TTL_MS) {
      return { success: false, error: 'That Hand Is Too Old To Rabbit Hunt' };
    }
    if ((this.tableInfo as { allow_rabbit_hunt?: boolean })?.allow_rabbit_hunt === false) {
      return { success: false, error: 'Rabbit Hunt Is Disabled At This Table' };
    }
    if (offer.boardLength >= 5) {
      // The whole board already ran out; there is nothing unseen to sell.
      return { success: false, error: 'The Board Already Ran Out' };
    }
    if (!offer.eligible.has(userId)) {
      return { success: false, error: 'You Were Not Dealt Into That Hand' };
    }

    const cards = offer.cards.slice(0, Math.max(0, 5 - offer.boardLength));
    if (cards.length === 0) {
      return { success: false, error: 'No Cards Remain To Reveal' };
    }

    // Already bought this hand: return the same cards, charge nothing. A dropped
    // response or a double tap must never bill twice for one reveal.
    if (offer.revealed.has(userId)) {
      return { success: true, cards, board_length: offer.boardLength, source: 'already_revealed' };
    }
    if (this.rabbitHuntInFlight.has(userId)) {
      // Two taps that race the RPC would both pass the `revealed` check above,
      // because that set is only written after the charge returns. The advisory
      // lock in fn_consume_rabbit_hunt serialises them, so they would not
      // corrupt the pool — they would just both succeed, and bill twice.
      return { success: false, error: 'Rabbit Hunt Is Already Loading' };
    }
    this.rabbitHuntInFlight.add(userId);

    // VIP monthly pool -> purchased packs -> 5 diamonds. Engine-only RPC: a
    // player's own JWT cannot execute it, which is what stops a client from
    // simply not calling it.
    let charge: Record<string, unknown> | null = null;
    try {
      const { data, error } = await supabase.rpc('fn_consume_rabbit_hunt', {
        p_user_id: userId,
      });
      if (error) throw error;
      charge = (data ?? null) as Record<string, unknown> | null;
    } catch (err) {
      reportError(err, 'ServerTableEngine.rabbit_hunt_charge_error');
      return { success: false, error: 'Could Not Complete Purchase' };
    } finally {
      // Released on EVERY path, including the throw above. Leaving it held would
      // lock this player out of rabbit hunt for the life of the engine.
      this.rabbitHuntInFlight.delete(userId);
    }

    if (!charge || charge.success !== true) {
      // Name the reason. "Could Not Complete Purchase" for every refusal left
      // the player unable to tell a shortfall from an outage, and support
      // unable to tell either from a broken RPC.
      const reason = String(charge?.error ?? '');
      const message =
        reason === 'insufficient_diamonds'
          ? 'Not Enough Diamonds'
          : reason === 'unknown user'
            ? 'Your Account Could Not Be Verified'
            : 'Could Not Complete Purchase';
      return {
        success: false,
        error: message,
        diamonds_remaining:
          charge?.diamonds_remaining != null ? Number(charge.diamonds_remaining) : null,
      };
    }

    // Mark the reveal before the audit write. Billing has succeeded and the
    // in-flight guard has been released; an await before this line would let a
    // second request slip between those states and call the billing RPC again.
    offer.revealed.add(userId);

    // `rabbit_hunt_reveals` is the metadata-only production ledger that was
    // created for this path and never wired. Do not use the obsolete
    // `rabbit_hunt_offers` table: it has a `cards` column, and persisting the
    // unseen runout would recreate the private-card leak this endpoint removed.
    // A ledger outage must not strand a player after a successful charge, so
    // report it and still return the cards they bought.
    try {
      const { error: revealLogError } = await supabase.from('rabbit_hunt_reveals').insert({
        user_id: userId,
        table_id: this.tableId,
        hand_number: hand,
        charged: Number(charge.diamonds_spent ?? 0),
      });
      if (revealLogError) throw revealLogError;
    } catch (err) {
      reportError(err, 'ServerTableEngine.rabbit_hunt_reveal_log_error');
    }

    return {
      success: true,
      cards,
      board_length: offer.boardLength,
      source: String(charge.source ?? ''),
      diamonds_spent: Number(charge.diamonds_spent ?? 0),
      diamonds_remaining:
        charge.diamonds_remaining != null ? Number(charge.diamonds_remaining) : null,
      vip_remaining: charge.vip_remaining != null ? Number(charge.vip_remaining) : null,
      // A purchased-pack reveal spends neither diamonds nor a VIP use, so
      // without this the player burned one of a pack they paid for and the UI
      // said nothing at all. The RPC has always returned it.
      uses_remaining: charge.uses_remaining != null ? Number(charge.uses_remaining) : null,
    };
  }

  /**
   * What a rabbit hunt costs in diamonds, read from `feature_pricing` so a
   * repricing in the dashboard reaches the button without a deploy — which is
   * the promise the migration makes and the client was not keeping: it rendered
   * a hardcoded 5 from FEATURE_PRICING while the charge came from the table.
   *
   * Cached for the life of the engine. A price change reaches players as tables
   * turn over, and the CHARGE is always the live row regardless of this value,
   * so the worst case is a stale label on a long-running table, never a
   * mischarge.
   */
  protected async getRabbitHuntCost(): Promise<number> {
    if (this.rabbitHuntCostCache != null) return this.rabbitHuntCostCache;
    try {
      const { data } = await supabase
        .from('feature_pricing')
        .select('diamond_cost')
        .eq('feature', 'rabbit_hunt')
        .maybeSingle();
      const cost = Number((data as { diamond_cost?: number } | null)?.diamond_cost);
      this.rabbitHuntCostCache = Number.isFinite(cost) && cost > 0 ? cost : 5;
    } catch {
      // Never let a pricing lookup stop the hand-complete path. The fallback
      // matches the migration's own v_default_cost.
      this.rabbitHuntCostCache = 5;
    }
    return this.rabbitHuntCostCache;
  }

  /**
   * Bible V8 §1.9 settlement pipeline. Extracted verbatim (2026-08-08 file
   * split) from the `HAND_COMPLETE` case of `handleHandEvent`. The body is
   * unchanged apart from a uniform 4-space dedent for its new nesting level
   * (that was exactly true when it was extracted on 2026-08-08; the body has
   * since been changed by later work, so diff against git history rather than
   * against the old monolith); the trailing
   * `break;` became the caller’s own `break;`.
   */
  /**
   * ═══ THE SETTLEMENT BARRIER COVERS THE WHOLE SETTLEMENT (2026-08-31) ═════
   *
   * The dealing loop waits on `postHandTasksPromise` before dealing the next
   * hand, because dealHand RESETS every per-hand capture field
   * (currentHandRake, currentHandCommunityCards, currentHandActions, ...) and
   * reallocates handCount. Two holes let the next hand start while THIS
   * hand's settlement was still reading those fields:
   *
   *   1. The promise was assigned mid-body (only around postHandTasks), so
   *      any await BEFORE that line - the insurance-shortfall critical
   *      alerts are awaits - yielded to a dealing loop that found the barrier
   *      NULL, skipped it, and dealt.
   *   2. The loop capped its wait at 45s and then proceeded anyway, with the
   *      settlement still running in the background against fields the next
   *      deal was about to blank. That is how a settled hand's history row
   *      can record an empty board and the next hand's number - the exact
   *      corpse the rake-law audit filed as `board_not_recorded`.
   *
   * The barrier is now assigned FIRST, synchronously, and covers this entire
   * method INCLUDING the postHandTasks chain it fires (see the Promise.all
   * where that chain starts). The loop-side hole is closed in dealingLoop:
   * it waits with liveness instead of walking away at 45s.
   */
  protected async handleHandCompleteEvent(
    event: HandEvent,
    players: SeatedPlayer[]
  ): Promise<void> {
    const wholeSettlement = this.settleCompletedHand(event, players);
    // Barrier only - failures are reported inside; the barrier must resolve
    // either way or the table stops dealing forever.
    this.postHandTasksPromise = wholeSettlement.catch(() => undefined);
    return wholeSettlement;
  }

  private async settleCompletedHand(event: HandEvent, players: SeatedPlayer[]): Promise<void> {
    // ═══════════════════════════════════════════════════════════════════
    // Bible V8 §1.9: SETTLEMENT PIPELINE — 15-step mandatory order
    //
    // Step  1: Lock table (no new actions accepted)
    // Step  2: Calculate side pots from contributions
    // Step  3: Evaluate all active players' hands (variant-aware)
    // Step  4: Determine winners per pot (including hi-lo split)
    // Step  5: Calculate rake (percentage with cap, no-flop-no-drop)
    // Step  6: Distribute winnings (integer-cents arithmetic)
    // Step  7: Update player stacks (atomic via AtomicStackService)
    // Step  8: Persist results to database (atomic transaction)
    // Step  9: Update leaderboards
    // Step 10: Trigger achievements/daily challenges
    // Step 11: Calculate VIP points earned
    // Step 12: Calculate rakeback
    // Step 13: Log complete hand history
    // Step 14: Broadcast final state (with showdown cards)
    // Step 15: Unlock table
    //
    // Steps 1-6 are handled inside HandController.advanceStage()
    // Steps 7-15 are handled here + postHandTasks()
    // ═══════════════════════════════════════════════════════════════════

    // SETTLEMENT STEP 1: Lock table (actionLock prevents new actions)
    // Already enforced — handController completes hand, no more actions accepted
    // Phase X5 (2026-04-28): emit explicit table_locked event so the
    // client knows to suppress the action panel until table_unlocked.
    // Bible V8 §1.16 Real-Time Delivery: every state transition gets a
    // discrete named event, never inferred from a state-snapshot diff.
    this.hub?.emitEvent(this.tableId, {
      type: 'table_locked',
      table_id: this.tableId,
      hand_number: this.handCount,
      reason: 'settlement',
      timestamp: Date.now(),
    });

    // SETTLEMENT STEP 14 (early broadcast): Notify clients hand is complete
    // Bible V8 §1.16: discrete hand_complete event
    this.hub?.emitEvent(this.tableId, {
      type: 'hand_complete',
      table_id: this.tableId,
      hand_number: this.handCount,
      winner_ids: this.currentHandWinnerIds,
      timestamp: Date.now(),
    });
    // Rabbit Hunt: Capture remaining deck cards BEFORE handController is nulled.
    //
    // Dan 2026-08-25: the cards are NEVER broadcast. They are held here and
    // handed to one player, once, by revealRabbitHunt() after that player has
    // actually paid. Everything needed to police the request is captured in the
    // same breath as the cards, while the controller is still alive:
    //   - boardLength, because the broadcast below used to re-read the board
    //     through an optional chain that returns [] once the controller is
    //     nulled, which reads as "board length 0" and would offer a rabbit hunt
    //     on a hand that had already run to the river;
    //   - who was dealt in, so a spectator cannot buy a look at a hand they
    //     were never part of.
    // RUN IT TWICE IS NEVER OFFERED A RABBIT HUNT.
    //
    // On a RIT hand `communityCards` holds only the shared pre-all-in prefix —
    // 0 cards for a pre-flop all-in — because each board is dealt into
    // dealAndResolveRIT's own arrays. So the board-length gate reads 0, decides
    // the hand ended pre-flop, and offers five cards. But RIT has already burned
    // two or three run-outs off this deck: what is left is not "what would have
    // come", it is noise the player would be charged five diamonds for. There is
    // also nothing to rabbit hunt on a hand that ran out twice to showdown.
    const ranItTwice = (this.currentHandRitBoards ?? 0) >= 2;
    // A MULTI-BOARD BOMB POT IS NEVER OFFERED A RABBIT HUNT EITHER
    // (Dan's bomb pot spec §19). Same defect shape as RIT: the boards were
    // dealt interleaved from one deck, so `remainingDeck.slice(0, 5)` is not
    // "what board 1 would have run" — it is noise the player would be charged
    // five diamonds for, and there are two or three boards it could belong to.
    const multiBoardBomb = this.handController?.isDoubleBoardActive?.() ?? false;
    if (this.handController && !ranItTwice && !multiBoardBomb) {
      try {
        const state = this.handController.getState();
        const remainingDeck = this.handController.getRemainingDeck();
        // A local, not an instance field. This was `this.currentHandRabbitCards`,
        // which nothing else read — and because the SAME array reference is
        // stored into the offer below, the only thing keeping the previous
        // hand's offer intact was that the per-hand reset reassigned the field
        // rather than emptying it in place.
        const rabbitCards = remainingDeck.slice(0, 5);
        this.rabbitHuntOffers.set(this.handCount, {
          cards: rabbitCards,
          boardLength: (state?.communityCards ?? []).length,
          eligible: new Set(
            (state?.players ?? [])
              .map((p: { user_id?: string }) => p?.user_id)
              .filter((id): id is string => !!id)
          ),
          revealed: new Set<string>(),
          offeredAt: Date.now(),
        });
        // Keep the two most recent offers, by INSERTION ORDER. Trimming on
        // `handNumber < handCount - 1` looked equivalent and was not: hand
        // numbers come from allocateGlobalHandNumber and are global to the
        // server, so they jump by arbitrary amounts and `handCount - 1` is
        // almost never the previous hand at this table. That silently kept one
        // entry instead of two, cutting the grace period for a late click in
        // half. Map iterates in insertion order, so this is exact.
        while (this.rabbitHuntOffers.size > 2) {
          const oldest = this.rabbitHuntOffers.keys().next().value;
          if (oldest === undefined) break;
          this.rabbitHuntOffers.delete(oldest);
        }
      } catch (err) {
        // Never silent. A throw here means no offer, no event, and a rabbit hunt
        // that has quietly stopped working on this table with nothing to explain
        // why — which is precisely the blind spot that would hide a bug like the
        // RIT one above.
        reportError(err, 'ServerTableEngine.rabbit_hunt_capture_error');
      }
    }

    // SETTLEMENT STEP 8 (partial): Mark hand snapshot as complete
    // FIX 137: Bible V8 §7.17
    // Reported, not swallowed. A snapshot that never completes leaves the hand
    // marked in-flight in the recovery path, and `.catch(() => {})` meant the
    // only way to learn that was to go looking for it. It still must not throw
    // into settlement — the hand is over and the money is already moved.
    completeHandSnapshot(this.tableId, this.handCount).catch((err) =>
      reportError(err, 'ServerTableEngine.complete_hand_snapshot_error')
    );

    // SETTLEMENT STEP 5: Capture rake and BBJ fee (calculated in HandController)
    if ((event as any).rake !== undefined) {
      this.currentHandRake = (event as any).rake;
    }
    if ((event as any).bbjFee !== undefined) {
      this.currentHandBBJFee = (event as any).bbjFee;
    }

    // SETTLEMENT STEP 4+5: State verification — deduct rake + BBJ and verify chip conservation
    const totalDeductions = this.currentHandRake + this.currentHandBBJFee;
    if (totalDeductions > 0) {
      this.stateVerifier.deductRake(this.tableId, totalDeductions);
    }
    if (this.handController) {
      const finalState = this.handController.getState();
      const verifyResult = this.stateVerifier.verify({
        tableId: this.tableId,
        handNumber: this.handCount,
        players: finalState.players,
        communityCards: finalState.communityCards,
        pot: finalState.pot,
        stage: finalState.stage,
        // RIT VERIFIER FIX 2026-08-21: multi-board hands keep only the
        // shared prefix in communityCards — tell the verifier.
        ritBoards: this.currentHandRitBoards,
      });
      if (!verifyResult.valid) {
        reportError(
          verifyResult.violations.map((v) => v.message).join('; '),
          'ServerTableEnginethistableId.Hand_thishandCount_FAILED_inte'
        );
      }
    }

    // SETTLEMENT STEP 7: Update player stacks (atomic via AtomicStackService)
    // FIX 150: Wire AtomicStackService — settle final stacks through atomic layer
    // Computes delta (final stack - initial stack tracked by version service) for each player
    // so version tracking stays in sync and race conditions with concurrent rebuy/cashout are prevented.
    if (this.handController) {
      const finalState = this.handController.getState();
      const settlements: StackSettlement[] = [];
      for (const p of finalState.players) {
        const initial = this.atomicStackService.getStackWithVersion(this.tableId, p.user_id);
        const delta = p.stack - initial.stack;
        if (delta !== 0) {
          settlements.push({ userId: p.user_id, delta });
        }
      }
      if (settlements.length > 0) {
        const settleResult = this.atomicStackService.atomicSettle(this.tableId, settlements);
        if (!settleResult.success) {
          reportError(
            settleResult.errors.join('; '),
            'ServerTableEnginethistableId.AtomicSettle_failed'
          );
        }
      }
    }

    // SETTLEMENT STEP 15 (partial): Clean up validator state between hands (unlock table)
    this.actionValidator.clearTable(this.tableId);
    this.preciseTimer.clearTable(this.tableId);
    // 2026-08-22 review: clearTable deliberately no longer cancels the
    // NAMESPACED countdowns (timebank:/disconnect:) — mid-hand callers must
    // not kill them. But at the hand boundary they MUST die, through their
    // owning engines so the paired state (bank.isActive, no strike changes)
    // stays consistent. A leaked disconnect countdown fires into the next
    // hand and records a phantom timeout strike; a leaked bank can fold a
    // live player at the same seat.
    this.disconnectEngine.cancelAllCountdowns(this.tableId);
    this.timeBankEngine.cancelActiveForTable(this.tableId);

    // Step 5: Clean up supporting modules between hands
    this.preActionEngine.dispose(this.tableId);
    // Note: timeBankEngine persists across hands (pool model — depletes per session, not per hand)
    //       Per-street activation counter is reset in dealHand() and on every
    //       new street via resetStreetActivations()
    // Note: disconnectEngine persists across hands (tracks connection state)
    // Note: atomicStackService persists across hands (tracks stack versions via FIX 150)

    // SETTLEMENT STEP 6 (continued): Insurance settlement — distribute insurance payouts
    // Bible V8 §4.19: Settle insurance BEFORE disposing (offers cleared on dispose)
    // FIX 118: Pass ALL winner IDs — chops (multiple winners) = PUSH (insurance voided)
    if (this.currentHandWinnerIds.length > 0) {
      this.currentHandInsuranceSettlements = this.insuranceEngine.settle(
        this.tableId,
        this.currentHandWinnerIds
      );

      // Bible V8 §4.19: Insurance settlement — applied like rake at the end.
      // - LOSER who bought insurance: Gets insuredAmount from union/club bank → credited to table stack
      // - WINNER who bought insurance: Premium deducted from winnings (taken at end like rake)
      // - Player can't lose more than their premium; can't gain more than insuredAmount
      // 2026-08-18: the engine's own stacks are moved through applyStackDeltas
      // at the end of this loop, NOT by assigning to `enginePlayer.stack`.
      // getState() returns copies (players spread, cards cloned), so the old
      // `enginePlayer.stack += payout` mutated a throwaway and the engine state
      // never moved — the same defect PR #97 fixed for run-it-twice. The
      // database was always correct because syncStacks() persists
      // seatedPlayers, but every broadcast between here and the next hand read
      // the engine copy and therefore showed pre-insurance stacks.
      //
      // Deltas are keyed off what was ACTUALLY applied to the seat row, so the
      // engine and the DB move by the same amount even where the premium is
      // clamped against a short stack.
      const insuranceDeltas = new Map<string, number>();
      for (const settlement of this.currentHandInsuranceSettlements) {
        const seatedPlayer = this.seatedPlayers.find((p) => p.user_id === settlement.playerId);
        // Read-only: used solely as a stack fallback for the shortfall alert
        // below when the player has no seat row. Never mutated.
        const enginePlayer = this.handController
          ? this.handController.getState().players.find((p) => p.user_id === settlement.playerId)
          : null;

        if (settlement.payout > 0) {
          // LOSER with insurance: credit payout from union/club bank to table
          // stack. EV CASHOUT 2026-08-28: a cashed-out player's locked amount
          // rides the same branch — paid from the bank regardless of outcome.
          if (seatedPlayer) {
            seatedPlayer.stack += settlement.payout;
            insuranceDeltas.set(
              settlement.playerId,
              (insuranceDeltas.get(settlement.playerId) ?? 0) + settlement.payout
            );
            console.log(
              `[ServerTableEngine:${this.tableId}] ${settlement.kind === 'ev_cashout' ? 'EV cashout' : 'Insurance payout'}: ${settlement.playerId} → +$${settlement.payout} from bank`
            );
          }
        }

        // EV CASHOUT 2026-08-28: the bank BOUGHT this player's equity — the
        // pot share the board actually delivered belongs to the bank, not the
        // player. Distribution already credited it above (their hand stayed
        // live), so claw exactly what they won back to the bank. Clamped like
        // the premium below; a clamp means the bank under-collects and the
        // same critical alert fires.
        if (settlement.kind === 'ev_cashout') {
          const wonAmt =
            Math.round(
              this.currentHandWinners
                .filter((w) => w.userId === settlement.playerId)
                .reduce((s, w) => s + w.amount, 0) * 100
            ) / 100;
          this.currentHandCashoutRedirects.set(settlement.playerId, 0);
          if (wonAmt > 0 && seatedPlayer) {
            const before = seatedPlayer.stack;
            if (wonAmt > before) {
              await raiseFinancialAlert(
                'critical',
                'ServerTableEngine.ev_cashout_redirect_exceeds_stack',
                `EV cashout redirect ${wonAmt} exceeds stack ${before} for ${settlement.playerId}; clamped and under-collected`,
                {
                  tableId: this.tableId,
                  playerId: settlement.playerId,
                  redirect: wonAmt,
                  stack: before,
                  cashout: settlement.payout,
                }
              );
            }
            seatedPlayer.stack = Math.max(0, before - wonAmt);
            const applied = before - seatedPlayer.stack;
            this.currentHandCashoutRedirects.set(settlement.playerId, applied);
            insuranceDeltas.set(
              settlement.playerId,
              (insuranceDeltas.get(settlement.playerId) ?? 0) - applied
            );
            console.log(
              `[ServerTableEngine:${this.tableId}] EV cashout redirect: ${settlement.playerId} won $${wonAmt} → bank`
            );
          }
        }

        // POKERBROS PARITY 2026-08-28 (Dan's ruling): the fee is charged only
        // when the insured player WINS — settle() reports premium 0 on a loss,
        // so a losing leader receives the insured amount whole ("For Losing"
        // in the dialog is literal) and only a winner pays the fee here.
        if (settlement.premium > 0) {
          // AUDIT M16: the clamps below silently absorb (Math.max(0, ...)) any
          // premium the stack cannot cover. A premium larger than the stack it
          // is pulled from means the insurance bank collected less than the
          // premium that was priced and written to the audit ledger — a
          // real-money under-collection that must never pass silently. Alert
          // with the exact shortfall, durably (raiseFinancialAlert never
          // throws), before clamping exactly as before.
          const premiumStack = seatedPlayer
            ? seatedPlayer.stack
            : enginePlayer
              ? enginePlayer.stack
              : 0;
          if (settlement.premium > premiumStack) {
            const shortfall = Math.round((settlement.premium - premiumStack) * 100) / 100;
            await raiseFinancialAlert(
              'critical',
              'ServerTableEngine.insurance_premium_exceeds_stack',
              `Insurance premium ${settlement.premium} exceeds stack ${premiumStack} by ${shortfall} for ${settlement.playerId}; premium clamped and under-collected`,
              {
                tableId: this.tableId,
                playerId: settlement.playerId,
                premium: settlement.premium,
                stack: premiumStack,
                shortfall,
                insuredAmount: settlement.insuredAmount,
                equity: settlement.equity,
                won: settlement.won,
                payout: settlement.payout,
              }
            );
          }
          if (seatedPlayer) {
            const beforePremium = seatedPlayer.stack;
            seatedPlayer.stack = Math.max(0, seatedPlayer.stack - settlement.premium);
            // The CLAMPED amount, not settlement.premium — a short stack pays
            // what it has and the engine must debit exactly that.
            insuranceDeltas.set(
              settlement.playerId,
              (insuranceDeltas.get(settlement.playerId) ?? 0) + (seatedPlayer.stack - beforePremium)
            );
            console.log(
              `[ServerTableEngine:${this.tableId}] Insurance premium: ${settlement.playerId} → -$${settlement.premium} (stack: $${seatedPlayer.stack})`
            );
          }
        }
      }

      if (insuranceDeltas.size > 0) this.handController?.applyStackDeltas(insuranceDeltas);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SEVEN-DEUCE BOUNTY (7-2 game) — Bible V8 §11 table option
    // A player who WINS a pot holding any 7 and any 2 collects a fixed bounty
    // (default 2 big blinds, configurable per table) from every OTHER player
    // dealt into the hand. Rule (Dan 2026-07-20): the hand MUST have seen a
    // flop to qualify — pots won pre-flop pay no bounty. Any 7 + any 2
    // qualifies. NLH only (meaningless in PLO; short-deck has no deuces).
    // The bounty is a player-to-player table-stack transfer (zero-sum,
    // chip-conserving); each payer pays only up to their remaining stack so
    // no chips are ever minted. Both the seated + engine stack copies are
    // mutated here so syncStacks() in postHandTasks persists the result.
    // ═══════════════════════════════════════════════════════════════════════
    const sevenDeuceEnabled = (this.tableInfo as any)?.seven_deuce_enabled === true;
    const sevenDeuceSawFlop = this.currentHandCommunityCards.length >= 3;
    const sevenDeuceIsNlh = (this.tableInfo?.game_variant || 'nlh') === 'nlh';
    if (
      sevenDeuceEnabled &&
      sevenDeuceSawFlop &&
      sevenDeuceIsNlh &&
      this.tableInfo &&
      this.currentHandWinners.length > 0 &&
      this.handController
    ) {
      const bb = this.tableInfo.big_blind || 0;
      const bbMultiple = Number((this.tableInfo as any)?.seven_deuce_amount ?? 2) || 2;
      const bountyPerPayer = Math.round(bb * bbMultiple * 100) / 100;

      if (bountyPerPayer > 0) {
        const sdState = this.handController.getState();
        const sdDealtIn = players.map((p) => {
          const enginePlayer = sdState.players.find((ep) => ep.user_id === p.user_id);
          const seatedPlayer = this.seatedPlayers.find((sp) => sp.user_id === p.user_id);
          return {
            userId: p.user_id,
            cards: enginePlayer?.cards ?? [],
            stack: seatedPlayer?.stack ?? enginePlayer?.stack ?? 0,
          };
        });

        const sdTransfers = computeSevenDeuceBounties(
          this.currentHandWinnerIds,
          sdDealtIn,
          bountyPerPayer
        );

        let sdAnyApplied = false;
        // Same story as the insurance block above: sdState came from
        // getState(), so its player objects are copies. Collect signed deltas
        // and push them into the engine once, before the re-broadcast that
        // exists specifically to show the bounty-adjusted stacks.
        const bountyDeltas = new Map<string, number>();
        for (const transfer of sdTransfers) {
          // Apply debits to each payer (re-cap at the live stack in case an
          // earlier transfer this hand already took chips) and credit the
          // winner. Mutate BOTH the seated + engine stack copies.
          let applied = 0;
          const appliedPayers: Array<{ userId: string; amount: number }> = [];
          for (const payer of transfer.payers) {
            const seatedPayer = this.seatedPlayers.find((p) => p.user_id === payer.userId);
            const enginePayer = sdState.players.find((p) => p.user_id === payer.userId);
            const liveStack = Math.max(
              0,
              Math.round((seatedPayer?.stack ?? enginePayer?.stack ?? 0) * 100) / 100
            );
            const pay = Math.min(payer.amount, liveStack);
            if (pay <= 0) continue;
            if (seatedPayer) seatedPayer.stack = Math.round((seatedPayer.stack - pay) * 100) / 100;
            bountyDeltas.set(payer.userId, (bountyDeltas.get(payer.userId) ?? 0) - pay);
            applied = Math.round((applied + pay) * 100) / 100;
            appliedPayers.push({ userId: payer.userId, amount: pay });
          }

          if (applied <= 0) continue;
          sdAnyApplied = true;

          const seatedWinner = this.seatedPlayers.find((p) => p.user_id === transfer.winnerUserId);
          const engineWinner = sdState.players.find((p) => p.user_id === transfer.winnerUserId);
          if (seatedWinner)
            seatedWinner.stack = Math.round((seatedWinner.stack + applied) * 100) / 100;
          bountyDeltas.set(
            transfer.winnerUserId,
            (bountyDeltas.get(transfer.winnerUserId) ?? 0) + applied
          );

          const winnerCards = engineWinner?.cards ?? [];
          console.log(
            `[ServerTableEngine:${this.tableId}] 7-2 BOUNTY: ${transfer.winnerUserId} won post-flop with 7-2 -> +$${applied} from ${appliedPayers.length} players`
          );

          // Reveal the 7-2 (even on a fold-around win) + announce the bounty.
          this.hub?.emitEvent(this.tableId, {
            type: 'seven_deuce_bounty',
            table_id: this.tableId,
            hand_number: this.handCount,
            winner_user_id: transfer.winnerUserId,
            total_collected: applied,
            per_player_amount: transfer.perPlayerAmount,
            payers: appliedPayers,
            hole_cards: winnerCards.map((c) => ({ rank: c.rank, suit: c.suit })),
          });

          // Durable audit trail (fire-and-forget, non-fatal).
          if (this.tableInfo.club_id) {
            const sdClubId = this.tableInfo.club_id;
            const sdHandNo = this.handCount;
            Promise.resolve(
              supabase.from('seven_deuce_bounties').insert({
                table_id: this.tableId,
                club_id: sdClubId,
                hand_number: sdHandNo,
                winner_user_id: transfer.winnerUserId,
                total_collected: applied,
                per_player_amount: transfer.perPlayerAmount,
                payers: appliedPayers,
              })
            )
              .then(({ error }: { error: unknown }) => {
                if (error)
                  console.warn('[Engine] seven_deuce_bounties insert failed (non-fatal):', error);
              })
              .catch((sdErr: unknown) =>
                console.warn('[Engine] seven_deuce_bounties insert threw (non-fatal):', sdErr)
              );
          }
        }

        // Move the engine's own stacks BEFORE the re-broadcast: broadcastCurrentState()
        // reads handController.getState(), so without this the "bounty-adjusted"
        // snapshot below went out with the pre-bounty numbers.
        if (bountyDeltas.size > 0) this.handController?.applyStackDeltas(bountyDeltas);

        // Re-broadcast so clients see the bounty-adjusted stacks immediately
        // (the WINNERS snapshot went out before these transfers were applied).
        if (sdAnyApplied) this.broadcastCurrentState();
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BBJ HIT DETECTION — Check if showdown qualifies as a Bad Beat Jackpot
    // FIX: Respect table-level bbj_percent — explicit 0 disables per-table.
    // RAKE-AUDIT 2026-07-24: default is now ENABLED (?? 100) to match the
    // fee-drop gate — `?? 0` made jackpots undetectable on every table
    // because bbj_percent was never selected by loadTable. Tournaments are
    // excluded (no fee is collected there).
    // ═══════════════════════════════════════════════════════════════════════
    const tableBbjPercent = this.isTournamentTable()
      ? 0
      : ((this.tableInfo as any)?.bbj_percent ?? 100);
    if (
      tableBbjPercent > 0 &&
      this.currentHandShowdownResults.length >= 2 &&
      this.currentHandWinnerIds.length > 0 &&
      this.tableInfo
    ) {
      const variant = this.tableInfo.game_variant || 'nlh';
      const dealtInPlayerIds = players.map((p) => p.user_id);
      // BBJ AUDIT FIX 2026-08-18: pass the final board (board 0 on RIT
      // hands) so the detector can enforce "both cards from hand must play".
      const bbjBoard = this.currentHandCommunityCards
        .map((str) => {
          const m = /^(10|[2-9]|[TJQKA])(hearts|diamonds|clubs|spades)$/.exec(str);
          return m ? { rank: m[1], suit: m[2] } : null;
        })
        .filter((c): c is { rank: string; suit: string } => c !== null);

      // OBSERVABILITY 2026-08-18: detectBBJHit now FAILS CLOSED when it cannot
      // see a five-card board — the right call for money, but silence would be
      // the wrong failure mode: a parse or plumbing regression would quietly
      // stop paying jackpots and nobody would know. A showdown that reached
      // this point had a board, so anything short of five parsed cards is a
      // bug, and it is reported once per occurrence rather than swallowed.
      if (this.currentHandShowdownResults.length >= 2 && bbjBoard.length < 5) {
        reportError(
          new Error(
            `[BBJ] Board unavailable at settlement - jackpot detection will fail closed for ` +
              `table ${this.tableId} hand #${this.handCount}. ` +
              `raw=${JSON.stringify(this.currentHandCommunityCards)} parsed=${bbjBoard.length}. ` +
              `A qualifying hand cannot be verified without the board, so no payout is made; ` +
              `if this fires, the plumbing is broken, not the rule.`
          ),
          'ServerTableEngine.bbj_board_unavailable'
        );
      }
      const bbjResult = detectBBJHit(
        this.currentHandShowdownResults,
        // AUDIT FIX 2026-08-27: was `currentHandWinnerIds[0]`. On a chopped
        // pot that examined one winner and ignored the other, so if the second
        // held the quads the "winner must have quads or better" gate refused a
        // real bad beat and nothing recorded that it had. All of them now; the
        // detector applies the rule to the strongest.
        this.currentHandWinnerIds,
        variant,
        this.currentHandPotSize,
        this.tableInfo.big_blind,
        dealtInPlayerIds.length,
        dealtInPlayerIds,
        bbjBoard,
        {
          // BBJ_RULES.excludeDoubleBoard has been published to players since it
          // was written and enforced nowhere. A double-board bomb pot deals two
          // boards for one pot, so a beat on one of them is not the hand the
          // jackpot is for — and until now such a hand could pay, which made
          // the rules panel wrong rather than the engine.
          doubleBoard: this.currentHandCommunityCards2.length > 0,
        }
      );

      if (bbjResult.hit) {
        console.log(
          `[ServerTableEngine:${this.tableId}] *** BBJ HIT! *** ` +
            `Loser: ${bbjResult.loserUserId} (${bbjResult.loserHand?.name}), ` +
            `Winner: ${bbjResult.winnerUserId} (${bbjResult.winnerHand?.name})`
        );

        // Get BBJ payout config for this stakes level
        const rakeConfig = getFullRakeConfig(
          this.tableInfo.small_blind,
          this.tableInfo.big_blind,
          variant
        );

        // BBJ payout: chips credited directly to players' table balances
        // The actual pool amounts are fetched from Supabase and paid from union/club bank
        // For now, broadcast the BBJ_HIT event with payout percentages.
        // The actual payout amounts will be calculated in postHandTasks() using the pool balance.
        this.hub?.emitEvent(this.tableId, {
          type: 'bbj_hit',
          table_id: this.tableId,
          hand_number: this.handCount,
          /* Dan 2026-08-26: "the notification keeps resending anytime you
             refresh or open a page."

             The hub RETAINS transient events and re-delivers them to a fresh
             socket (see EngineStateClient: `lastEventSeq` is reset on every
             reconnect precisely because "a fresh socket legitimately
             re-receives retained reveal events"). Seq-based de-duplication is
             therefore connection-scoped by design and cannot survive a
             refresh - so every reload replayed the jackpot as though it had
             just happened.

             The wall-clock stamp is what makes a replay identifiable as a
             replay. The client shows the celebration only for an event that
             is genuinely NEW (see BBJ_FRESH_MS in TablePage), and pairs it
             with table_id + hand_number as a stable identity so the same hit
             can never be shown twice. Additive: an older client ignores it. */
          emitted_at: Date.now(),
          loser: {
            userId: bbjResult.loserUserId,
            hand: bbjResult.loserHand,
            payoutPercent: rakeConfig.bbjPayoutLoser, // % of BBJ pool
          },
          winner: {
            userId: bbjResult.winnerUserId,
            hand: bbjResult.winnerHand,
            payoutPercent: rakeConfig.bbjPayoutWinner,
          },
          tableShare: {
            playerIds: dealtInPlayerIds,
            payoutPercent: rakeConfig.bbjPayoutTable,
          },
          totalPayoutPercent: rakeConfig.bbjPayoutTotalPercent,
          variant,
          qualifyingHandLabel: bbjResult.qualifyingHandLabel,
        });

        // Store BBJ hit for postHandTasks to process the actual payouts
        this.currentHandBBJHit = bbjResult;
        this.currentHandBBJPayoutConfig = rakeConfig;
      } else {
        // NEAR-MISS 2026-08-18: no hit — but did someone make a qualifying
        // losing hand and miss on exactly one condition? Teaching the rules
        // in the moment beats a rules page nobody opens. Display only: this
        // branch moves no money and cannot gate a payout.
        try {
          const nearMiss = detectBBJNearMiss(
            this.currentHandShowdownResults,
            this.currentHandWinnerIds[0],
            variant,
            this.currentHandPotSize,
            this.tableInfo.big_blind,
            dealtInPlayerIds.length,
            bbjBoard
          );
          if (nearMiss.nearMiss) {
            console.log(
              `[ServerTableEngine:${this.tableId}] BBJ near miss (${nearMiss.reason}): ` +
                `${nearMiss.userId} held ${nearMiss.handName}`
            );
            this.hub?.emitEvent(this.tableId, {
              type: 'bbj_near_miss',
              table_id: this.tableId,
              hand_number: this.handCount,
              user_id: nearMiss.userId,
              hand_name: nearMiss.handName,
              reason: nearMiss.reason,
              message: nearMiss.message,
            });
          }
        } catch (nmErr) {
          // A cosmetic banner must never break settlement.
          console.warn(`[ServerTableEngine:${this.tableId}] BBJ near-miss check failed:`, nmErr);
        }
      }
    }

    // Step 6: Clean up advanced modules between hands.
    // OFFER-CONFIG FIX 2026-08-21: this used to call dispose(), which ALSO
    // deleted the table's configuration - and configure() only ever runs in
    // start(). Both features therefore worked for exactly one hand per engine
    // restart and were dead for every hand after it. endHand() clears the
    // hand's offers and timers and leaves the config alone.
    this.runItTwiceEngine.endHand(this.tableId);
    this.insuranceEngine.endHand(this.tableId);
    // Note: straddleEngine persists (auto-straddle enrollment persists)
    // (RakebackEngine deleted 2026-08-29 — weighted contributed rake law;
    // per-player rake credit is allocated at banking time and by the settler.)

    // SETTLEMENT STEP 12: Calculate rakeback (done in postHandTasks)
    // SETTLEMENT STEP 9-11: Leaderboards, achievements, VIP points (done in postHandTasks)

    // Record telemetry for this hand
    this.engineTelemetry.recordPlayerCount(this.tableId, players.length);

    // FIX 211: Bible V8 §1.9 — Track postHandTasks promise so dealingLoop can await
    // it before starting the next hand, preventing stale DB stacks from race conditions.
    // 2026-08-31: the wrapper stored the whole-settlement promise in
    // postHandTasksPromise. The async task chain fired here must ALSO hold
    // the barrier, so chain it - the loop may deal only when BOTH the rest of
    // this method and every post-hand task are done reading this hand's
    // capture fields.
    const priorBarrier = this.postHandTasksPromise;
    const postTasks = this.postHandTasks(players).catch((err) =>
      reportError(err, 'ServerTableEnginethistableId.Posthand_error')
    );
    this.postHandTasksPromise = priorBarrier
      ? Promise.all([priorBarrier, postTasks]).then(() => undefined)
      : postTasks;
    this.currentHandWinnerIds = [];

    // Rabbit Hunt: Broadcast captured remaining deck ONLY when the hand
    // ended before the river was dealt. If the board already had all 5
    // cards revealed (full showdown), there's nothing to "see" — the
    // event would just confuse the UI by offering a paid reveal of cards
    // the player already saw. Round 65: gate on board.length < 5.
    // Read the board length CAPTURED above, not the live controller: by the
    // time this runs the controller may already be nulled, and an optional
    // chain onto a null controller yields [], i.e. "board length 0", which
    // offers a rabbit hunt on a hand that ran all the way to the river.
    // Captured, not re-read. `this.handCount` is a live field reassigned by
    // allocateGlobalHandNumber() at the next deal, and the emit below runs in a
    // .then(). Reading it there could stamp the NEXT hand's number onto THIS
    // hand's cards and eligibility set — the client posts that number back, the
    // lookup misses, and the player is told the hand is no longer available for
    // a hand they are still looking at.
    const handNumber = this.handCount;
    const offer = this.rabbitHuntOffers.get(handNumber);
    const boardLength = offer?.boardLength ?? 5;
    const handReachedRiver = boardLength >= 5;
    // FIX-D3 2026-07-19 (Bible V8 §11): honor the table's rabbit-hunt toggle.
    // The event was emitted unconditionally, offering rabbit hunt even where
    // the host disabled it. Default allowed unless explicitly off.
    const rabbitAllowed =
      (this.tableInfo as { allow_rabbit_hunt?: boolean })?.allow_rabbit_hunt !== false;
    if (offer && offer.cards.length > 0 && !handReachedRiver && rabbitAllowed) {
      // Dan 2026-08-25: this is an AVAILABILITY SIGNAL, not the cards.
      //
      // It used to carry `rabbit_cards` — the five real remaining cards — in a
      // room-wide broadcast to every socket at the table, before anyone had
      // paid anything. The paywall was a client-side `if`. Anyone watching the
      // websocket read the run-out for free, and so did every opponent.
      //
      // The cards now leave the server only through revealRabbitHunt(), one
      // authenticated player at a time, after fn_consume_rabbit_hunt has taken
      // a VIP monthly use, a purchased use, or five diamonds.
      //
      // It is still a ROOM-WIDE broadcast, so it carries who may act on it
      // rather than assuming everyone who receives it can. Without that, a
      // spectator — or a player who had just sat down and was not dealt in —
      // got a live Rabbit Hunt button whose only possible outcome was the
      // server refusing them. The eligibility set is already held here; it
      // simply was not being sent.
      void this.getRabbitHuntCost()
        .then((diamondCost) => {
          this.hub?.emitEvent(this.tableId, {
            type: 'rabbit_hunt_available',
            table_id: this.tableId,
            hand_number: handNumber,
            // How many cards a reveal would show: flop-fold → turn+river, turn-fold
            // → river only, preflop-fold → the full five.
            current_board_length: boardLength,
            cards_available: Math.min(offer.cards.length, 5 - boardLength),
            // Only these players were dealt into the hand.
            eligible_user_ids: Array.from(offer.eligible),
            // The LIVE price from feature_pricing. The button used to render a
            // hardcoded 5 from the client's FEATURE_PRICING while the charge came
            // from the table, so a repricing in the dashboard made the label lie.
            diamond_cost: diamondCost,
            // Offers expire, so the client can stop showing a button that would
            // now be refused.
            expires_at: offer.offeredAt + RABBIT_HUNT_OFFER_TTL_MS,
          });
        })
        .catch((err) =>
          // Fire-and-forget off the settlement path, so it must carry its own
          // catch: an unhandled rejection here would take the process down over
          // a decoration. The player simply gets no rabbit-hunt offer.
          reportError(err, 'ServerTableEngine.rabbit_hunt_offer_emit_error')
        );
    }

    // ── ADDITIVE event-sourcing shadow (#1): replay + chip-conservation verify at hand end ──
    if (this.shadowRecorder) {
      try {
        this.shadowRecorder.recordHandEnded(this.handCount);
        const finalSeats = players.map((pp) => ({
          seat: pp.seat_number,
          userId: pp.user_id,
          stack: pp.stack,
        }));
        this.shadowRecorder.finalize({ seats: finalSeats });
      } catch (e) {
        reportError(e, 'ServerTableEngine.EVENT_SHADOW_finalize_error');
      }
      this.shadowRecorder = null;
    }
    // ── ADDITIVE observability (#5): close the hand span (feeds hand-duration histogram) ──
    if (this.handSpan) {
      try {
        this.handSpan.end();
      } catch {
        /* tracing must never affect gameplay */
      }
      this.handSpan = null;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // POST-HAND TASKS
  // ═════════════════════════════════════════════════════════════════════════════

  protected async postHandTasks(players: SeatedPlayer[]): Promise<void> {
    /* ═══ THIS HAND'S RECORD IS CAPTURED BEFORE THE FIRST AWAIT (2026-08-31)
       Everything below used to read the live `this.currentHand*` fields and
       `this.handCount` between awaited database calls. Those fields belong to
       whatever hand the table is on NOW - dealHand blanks them and reallocates
       the hand number - so any path that let the dealing loop advance during
       settlement (see handleHandCompleteEvent's barrier note) wrote hand N's
       row from hand N+1's empty capture. Snapshot synchronously, before the
       first await can yield, and read ONLY the snapshot from here down. The
       Maps/arrays are copied shallowly: settlement only reads them, and
       nothing else mutates their elements after HAND_COMPLETE. */
    const snap = {
      handNumber: this.handCount,
      variant: this.currentHandVariant,
      potSize: this.currentHandPotSize,
      rake: this.currentHandRake,
      bbjFee: this.currentHandBBJFee,
      communityCards: [...this.currentHandCommunityCards],
      communityCards2: [...this.currentHandCommunityCards2],
      communityCards3: [...this.currentHandCommunityCards3],
      bombPot: this.currentHandBombPot,
      ritExtraBoards: this.currentHandRitExtraBoards,
      ritBoards: this.currentHandRitBoards,
      startedAt: this.currentHandStartedAt,
      winners: [...this.currentHandWinners],
      pots: this.currentHandPots,
      actions: [...this.currentHandActions],
      contributions: new Map(this.currentHandContributions),
      holeCards: new Map(this.currentHandHoleCards),
      dealerSeat: this.currentHandDealerSeat,
      perPotAwards: [...this.currentHandPerPotAwards],
      showdownResults: [...this.currentHandShowdownResults],
      insuranceSettlements: [...this.currentHandInsuranceSettlements],
      cashoutRedirects: new Map(this.currentHandCashoutRedirects),
      returnedUncalled: new Map(this.currentHandReturnedUncalled),
      bbjHit: this.currentHandBBJHit,
      bbjPayoutConfig: this.currentHandBBJPayoutConfig,
      dealtStacks: new Map(this.currentHandDealtStacks),
    };
    // ═══════════════════════════════════════════════════════════════════════
    // Bible V8 §1.9: SETTLEMENT PIPELINE (continued) — Steps 8-15
    // Steps 1-7 completed in HAND_COMPLETE handler above
    // ═══════════════════════════════════════════════════════════════════════

    // AUDIT E8 (2026-08-15): the settlement pipeline below used to be one
    // straight-line sequence with a single catch at the CALLER. Any step that
    // threw aborted every step after it: a hand-history transport error could
    // skip rake distribution (leaving raked chips with no unbanked-fee queue
    // entry), BBJ banking, pending add-ons, leave processing, and the STEP 15
    // unlock. Every step now runs in its own guard: a failure is reported
    // (and, for money steps, raised as a durable CRITICAL financial alert)
    // and the remaining steps still run. Order is unchanged; steps still run
    // sequentially because later steps read state earlier steps produce.
    const runStep = async (
      stepName: string,
      moneyCritical: boolean,
      fn: () => Promise<void>
    ): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        reportError(err, `postHandTasks.step_failed.${stepName}`, {
          tableId: this.tableId,
          handNumber: snap.handNumber,
        });
        if (moneyCritical) {
          await raiseFinancialAlert(
            'critical',
            `postHandTasks.${stepName}_failed`,
            `Post-hand step ${stepName} threw for hand #${snap.handNumber}; later steps continued`,
            {
              table_id: this.tableId,
              hand_number: snap.handNumber,
              error: err instanceof Error ? err.message : String(err),
            }
          );
        }
      }
    };

    /* ═══ TOURNAMENT CHIPS ARE CONSERVED HAND BY HAND (chip-std Lane F, 2026-09-02)
       A tournament hand has no rake and no BBJ drop, so the players who were
       dealt in must hold, after settlement, exactly what they were dealt
       with. The database only checks conservation when rake is declared,
       and the engine declares none for tournaments, so until now a hand
       whose stacks did not add up was written as if they did. Tournament
       chips decide the winner; a total the engine cannot account for must
       not reach the record. On a violation: CRITICAL alert with the hand id
       and both totals, and NEITHER stack write below runs - the pre-hand
       stacks stay persisted, which is the only total anyone can vouch for.
       Pure decision: tournamentChipConservation.ts. */
    let tournamentHandConserved = true;
    if (this.isTournamentTable() && snap.dealtStacks.size > 0) {
      const verdict = checkTournamentChipConservation({
        dealt: snap.dealtStacks,
        settled: players.map((p) => ({ user_id: p.user_id, stack: p.stack })),
        rake: 0,
      });
      if (!verdict.ok) {
        tournamentHandConserved = false;
        const detail =
          `tournament hand #${snap.handNumber} at table ${this.tableId} does not conserve: ` +
          `dealt ${verdict.dealtTotal}, settled ${verdict.settledTotal}, delta ${verdict.delta}` +
          (verdict.missing.length > 0
            ? `, ${verdict.missing.length} dealt player(s) with no settled stack`
            : '') +
          ' - stacks NOT persisted, pre-hand stacks stand';
        reportError(
          new Error(`[ServerTableEngine] ${detail}`),
          'Tournament.chip_conservation_broken'
        );
        await raiseFinancialAlert('critical', 'Tournament.chip_conservation_broken', detail, {
          table_id: this.tableId,
          tournament_id: this.tableInfo?.tournament_id ?? null,
          hand_number: snap.handNumber,
          dealt_total: verdict.dealtTotal,
          settled_total: verdict.settledTotal,
          delta: verdict.delta,
          missing: verdict.missing,
        });
      }
    }

    await runStep('sync_stacks', true, async () => {
      // SETTLEMENT STEP 8: Persist results to database (atomic transaction)
      if (!tournamentHandConserved) return;
      await syncStacks(
        this.tableId,
        players.map((p) => ({
          user_id: p.user_id,
          stack: p.stack,
          // VIP time banks 2026-08-18: HandController players never carried
          // time_bank_uses_remaining (always undefined), so this column sat
          // at its insert default (4) on every one of 22,805 seat rows -
          // the persist had NEVER once written. Ask the engine, the actual
          // source of truth.
          time_bank_uses_remaining: this.timeBankEngine.getUsesRemaining(this.tableId, p.user_id),
          time_bank_remaining: this.timeBankEngine.getRemainingSeconds(this.tableId, p.user_id),
        })),
        // ZERO-DRIFT phase 5: identify the hand so the write is atomic and
        // idempotent (fn_ca_settle_hand_stacks_absolute). The BBJ re-sync
        // later in this file deliberately does NOT pass a hand number - it is
        // a correction pass over the same hand and must not be swallowed by
        // the idempotency replay.
        // Read from the snapshot, never the live field (stale-continuation
        // law): dealHand reassigns handCount while a stalled settlement is
        // still writing.
        snap.handNumber
      );
    });

    // ─── ROUND 38 + 43 FIX: REORDERED — hand_history FIRST, then rake/BBJ ───
    // Round 38: rake_records.hand_id needed the v_handHistoryId.
    // Round 43: club_wallet_transactions.related_id (rake_in audit row) also
    // needs the hand UUID to link the audit ledger to the source hand. So
    // logHandHistory must precede logRakeCollection / logBBJCollection.
    let v_handHistoryId: string | null = null;
    await runStep('hand_history', true, async () => {
      if (this.tableInfo) {
        // ── SECURITY 2026-08-17: apply the auto-muck gate to the WRITE ──
        //
        // `currentHandShowdownResults` is built in ServerTableEngineHandEvents
        // on the SHOWDOWN event, from EVERY participant, before the winners are
        // known. It is a full evaluation set, not a reveal set — the comment at
        // that site (AUDIT FIX 2026-07-19) says so explicitly, which is why the
        // `showdown_cards_revealed` broadcast was moved to the WINNERS handler
        // and gated there.
        //
        // The persistence path never got that gate. logHandHistory fans this
        // array into three columns of one row — `hole_cards`, `dispute_review`
        // and `player_summaries` — and `hand_history_authenticated_select`
        // lets ANY participant of a hand read that whole row. So every player
        // could mine every opponent's mucked holdings for any hand they were
        // dealt into. Measured on 2026-08-17: 2,706 rows carrying 3,953 losing
        // players' hole cards in a single hour.
        //
        // handHistory.ts already documents the intended policy above its own
        // loop — "Mucked cards are deliberately never stored ... a game
        // integrity problem, not a feature". This restores that intent. The
        // in-memory array is deliberately NOT filtered: bad-beat-jackpot
        // detection needs the losing hand.
        //
        // FOLLOW-UP 2026-08-17: derive the winners from `currentHandWinners`,
        // NOT `currentHandWinnerIds`. postHandTasks() is fired WITHOUT await
        // (see FIX 211, ~40 lines above) and the very next synchronous line is
        // `this.currentHandWinnerIds = []`. So by the time this code runs
        // inside postHandTasks, that array is always empty — gating on it
        // filtered out EVERY holding including the winners', which silently
        // emptied hand_history.hole_cards (verified: 0 of 611 hands stored any
        // cards). `currentHandWinners` is reset only when the NEXT hand starts
        // dealing, and dealingLoop awaits postHandTasksPromise first, so it is
        // still populated here — it is passed to this same logHandHistory call
        // as `winners` a few lines below.
        // UPDATE 2026-08-18 (Dan): the rule above is unchanged - a holding may
        // be stored only if the table showed it - but WHAT the table shows has
        // changed. A showdown now turns every hand face up (see the WINNERS
        // handler in ServerTableEngineHandEvents), so the revealed set and the
        // persisted set are once again the same thing. Passing autoMuck=false
        // keeps this write in lockstep with that broadcast; if the two ever
        // disagree, hand_history either hides cards the table showed or stores
        // cards it did not.
        //
        // The set is still not "everyone dealt in": HandController builds it
        // from getActivePlayers(), which excludes folded and sitting-out
        // players, so the leak this gate was added for on 2026-08-17 (3,953
        // losing holdings in one hour) stays closed - those players never
        // enter the array to begin with.
        const winnerIds = new Set(snap.winners.map((w) => w.userId));
        // SHOWDOWN SYSTEM 2026-08-25: the module's rule is "a holding may be
        // exposed only if the table already showed it" — and a hand the engine
        // ruled muckable was never shown. Filter mucked hands here (voluntary
        // shows override via isMuckedAtShowdown) so the participant-readable
        // hand_history matches what the table displayed. The full dealt-card
        // record for audit/integrity still rides the separate holeCardsAll
        // capture, exactly as before.
        const revealedShowdownResults = selectRevealedShowdownResults(
          snap.showdownResults.filter((r) => !this.isMuckedAtShowdown(r.userId)),
          winnerIds,
          this.showHandPlayers,
          false
        );

        // ── MUCKED-WINNER INVARIANT (2026-08-25) ────────────────────────────
        // A hand the reveal system withheld can NEVER be a hand that was paid:
        // applyShowdownRevealRules auto-tables every hand that wins or ties.
        // If this ever fires, the muck ruling and the payout disagreed — a
        // money/privacy consistency break worth a page, not a log line. It
        // runs per hand, in the settlement path, so it can't be missed by a
        // sampling job. RIT hands pass trivially (all hands force-revealed).
        if (snap.showdownResults.length >= 2) {
          const revealedIds = new Set(revealedShowdownResults.map((r) => r.userId));
          const paidButHidden = [...winnerIds].filter(
            (id) => !revealedIds.has(id) && snap.showdownResults.some((r) => r.userId === id)
          );
          if (paidButHidden.length > 0) {
            await raiseFinancialAlert(
              'critical',
              'ServerTableEngine.mucked_winner_invariant',
              `Hand ${snap.handNumber} on table ${this.tableId}: winner(s) ${paidButHidden.join(
                ','
              )} were withheld from the reveal set - the muck ruling and the payout disagree`,
              { tableId: this.tableId, handNumber: snap.handNumber, userIds: paidButHidden }
            );
          }
        }

        // SHOWDOWN POLISH 2026-08-25 (persistence): what the table actually
        // SAW, for replays and dispute review — reveal order, muck ruling,
        // and hand identity for revealed hands only. A mucked entry carries
        // no hand name, description, or cards: participants can read this
        // row back, and a mucked range stays private (2026-08-17 leak rule).
        const showdownReveal = snap.showdownResults.map((r) => {
          const mucked = this.isMuckedAtShowdown(r.userId);
          return mucked
            ? {
                user_id: r.userId,
                seat: r.seat ?? -1,
                reveal_order: r.revealOrder ?? 0,
                mucked: true,
              }
            : {
                user_id: r.userId,
                seat: r.seat ?? -1,
                reveal_order: r.revealOrder ?? 0,
                mucked: false,
                hand_name: r.handName,
                hand_description: r.handDescription ?? '',
              };
        });

        const dailyMissionEvents = buildDailyMissionHandEvents({
          dealtPlayerIds: snap.holeCards.keys(),
          roster: players.map((player) => ({
            userId: player.user_id,
            isHorse: player.is_horse,
          })),
          winners: snap.winners,
          showdownResults: snap.showdownResults,
        });

        const result = await logHandHistory({
          tableId: this.tableId,
          nitGame: this.tableInfo.nit_game === true,
          tournamentId: this.tableInfo.tournament_id || undefined,
          handNumber: snap.handNumber,
          // VARIANT OVERRIDE 2026-08-28 (spec §10.1/§20): the variant this
          // hand was DEALT as — plo4 on a PLO4 bomb hand at an NLH table.
          // Falling back to the table label only when the capture is absent.
          gameVariant: snap.variant || this.tableInfo.game_variant || 'nlh',
          smallBlind: this.tableInfo.small_blind,
          bigBlind: this.tableInfo.big_blind,
          potSize: snap.potSize,
          rakeAmount: snap.rake,
          bbjAmount: snap.bbjFee,
          communityCards: snap.communityCards,
          communityCards2: snap.communityCards2,
          // TRIPLE-BOARD BOMB POT 2026-08-27: board 3 + the frozen bomb facts
          // (trigger reason, ante, board count — spec §20).
          communityCards3: snap.communityCards3,
          bombPot: snap.bombPot,
          // COMPLETENESS PASS 2026-08-26: RIT boards 2..N, first-class. The
          // rit_board_N pseudo-actions in `actions` stay for old readers.
          ritBoards: snap.ritExtraBoards,
          startedAt: snap.startedAt || Date.now(),
          endedAt: Date.now(),
          winners: snap.winners,
          // POT-LEVEL SETTLEMENT (Dan section 29). Captured at WINNERS, when
          // the breakdown still exists. `winners` already carry `potIndex`;
          // this is the other half of that pair, and without it the number is
          // an index into an array nobody stored. Together they let the
          // elimination sweep credit a knockout to the winner(s) of the pot
          // that held the busted player's last chips.
          pots: snap.pots,
          players: players.map((p) => ({
            userId: p.user_id,
            username: p.username,
            seat: p.seat_number,
            stack: p.stack,
            cards: [],
          })),
          actions: snap.actions,
          // STATS FACT LAYER 2026-08-21: engine-memory values the write used to
          // discard. Rationale in services/supabase/handFacts.ts.
          clubId: this.tableInfo.club_id,
          contributions: snap.contributions,
          holeCardsAll: snap.holeCards,
          roster: players.map((p) => ({ userId: p.user_id, isHorse: p.is_horse })),
          // ASSISTANT FIX 2026-08-16: both of these were already computed on
          // the engine for this hand and then thrown away at the write.
          //
          // showdownResults carries the revealed holdings (captured in
          // ServerTableEngineHandEvents on SHOWDOWN, used until now only for
          // bad-beat-jackpot detection). buttonSeat is currentHandDealerSeat.
          // Without the first, the personal assistant can show a leak but not
          // the hand that proves it; without the second, it cannot compute a
          // positional leak at all.
          showdownResults: revealedShowdownResults,
          dailyMissionEvents,
          buttonSeat: snap.dealerSeat,
          showdownReveal,
        });
        v_handHistoryId = result.handId;

        // ── AWARD-UNIT LEDGER (2026-08-28, spec §16.2/§17) ──────────────────
        // One row per (pot layer, board, hi/lo side, winner) for every
        // MULTI-BOARD bomb hand — the settlements that are genuinely hard to
        // reconstruct from the merged winners list. Amounts are the same
        // post-rake display shares perPotAwards broadcast. Idempotency is the
        // table's UNIQUE key (hand + pot + board + side + winner): a retried
        // insert conflicts and does nothing, exactly as spec §17.2 demands.
        // Fire-and-forget: the ledger narrates money that logHandHistory has
        // already recorded; it must never be able to fail a hand.
        // SCOPE 2026-08-28: EVERY bomb hand, not only multi-board ones. The
        // first cut gated on board_count >= 2 because that is where the
        // reconstruction is hardest, but it made the ledger a partial record
        // of a feature — `v_bomb_pot_outcomes` could not tell a single-board
        // bomb from a hand that never happened, and a single-board bomb with
        // three side pots is exactly as hard to rebuild from the merged
        // winners list. `board` is 1 for those, which the UNIQUE key already
        // accommodates.
        // DEFENSIVE 2026-08-31: a bomb hand that produced WINNERS but no
        // per-pot awards writes nothing here and looks, to
        // `fn_bomb_pot_ledger_gaps` and to the hourly repair sweep, exactly
        // like a transport loss — except no retry and no backfill can ever
        // close it, because the units were never computed in the first place.
        // The condition below is silent about that case by construction (it
        // just does not run), so say it out loud instead of leaving a gap the
        // sweep will chase forever.
        if (
          v_handHistoryId &&
          snap.bombPot &&
          snap.perPotAwards.length === 0 &&
          (snap.winners?.length ?? 0) > 0
        ) {
          reportError(
            new Error(
              `[BombPot] hand ${snap.handNumber} settled with ` +
                `${snap.winners?.length ?? 0} winner(s) but an EMPTY per-pot award ` +
                'array - no award units can be written and none can be reconstructed'
            ),
            'ServerTableEngine.bomb_award_units_empty'
          );
        }
        if (v_handHistoryId && snap.bombPot && snap.perPotAwards.length > 0) {
          const ledgerRows = snap.perPotAwards.map((a) => ({
            hand_history_id: v_handHistoryId,
            table_id: this.tableId,
            hand_number: snap.handNumber,
            pot_index: a.potIndex,
            board: a.board ?? 1,
            side: a.low ? 'low' : 'high',
            user_id: a.userId,
            amount: a.amount,
            hand_name: a.hand?.name ?? null,
          }));
          // DURABILITY 2026-08-29: see BOMB_LEDGER_WRITE_ATTEMPTS above. Still
          // fire-and-forget — nothing here is awaited and nothing here can fail
          // the hand — but a lost row now costs three attempts to lose, and the
          // third failure is reported rather than logged to a host nobody reads.
          const handNumberForLedger = snap.handNumber;
          const writeAwardUnits = async (): Promise<void> => {
            let lastMessage = 'unknown error';
            for (let attempt = 1; attempt <= BOMB_LEDGER_WRITE_ATTEMPTS; attempt++) {
              const { error } = await supabase.from('bomb_pot_award_units').upsert(ledgerRows, {
                onConflict: 'hand_history_id,pot_index,board,side,user_id',
                ignoreDuplicates: true,
              });
              if (!error) return;
              lastMessage = error.message;
              if (attempt < BOMB_LEDGER_WRITE_ATTEMPTS) {
                // Exponential, capped: 250ms, 750ms, 1.75s. Was linear
                // (250/500), which put all three attempts inside the first
                // second and so inside the same blip. See the constants above
                // for the production rate that motivated the change.
                const backoff = Math.min(
                  BOMB_LEDGER_RETRY_BASE_MS * (2 ** attempt - 1),
                  BOMB_LEDGER_RETRY_MAX_MS
                );
                await new Promise((resolve) => setTimeout(resolve, backoff));
              }
            }
            reportError(
              new Error(
                `[BombPot] award-unit ledger write failed after ${BOMB_LEDGER_WRITE_ATTEMPTS} ` +
                  `attempts for hand ${handNumberForLedger} (${ledgerRows.length} units): ` +
                  lastMessage
              ),
              'ServerTableEngine.bomb_award_ledger_write_failed'
            );
          };
          void writeAwardUnits().catch((err: unknown) =>
            reportError(err, 'ServerTableEngine.bomb_award_ledger_write_threw')
          );
        }

        // ── Dan 2026-08-15 (item 3): tell the clients the hand's row id ──
        //
        // The discrete `hand_complete` event fires earlier in this file, and
        // at that moment the hand_history row does not exist yet — the insert
        // happens right here, in postHandTasks. So `hand_complete` could never
        // carry an id, and the client had nothing to open a replay with.
        //
        // The client's workaround was to lazily query "my most recent hand"
        // when the replay panel opened. That RACES this insert: tap Replay
        // quickly after a hand and the query returns the PREVIOUS hand, so the
        // player is shown the wrong one. Emitting the real id at the moment it
        // exists removes the race; the lazy lookup stays only as a cold-start
        // fallback for players who joined mid-session.
        if (v_handHistoryId) {
          this.hub?.emitEvent(this.tableId, {
            type: 'hand_history_saved',
            table_id: this.tableId,
            hand_number: snap.handNumber,
            hand_id: v_handHistoryId,
            timestamp: Date.now(),
          });
        }

        // ── ADDITIVE anti-cheat feed (#5): observe-only, fire-and-forget, flag-gated (default OFF) ──
        if (this.integrityFeedEnabled) {
          try {
            const feedRow: HandHistoryRow = {
              id: v_handHistoryId,
              table_id: this.tableId,
              hand_number: snap.handNumber,
              game_variant: this.tableInfo.game_variant || 'nlh',
              small_blind: this.tableInfo.small_blind,
              big_blind: this.tableInfo.big_blind,
              pot_size: snap.potSize,
              rake_amount: snap.rake,
              community_cards: snap.communityCards,
              started_at: snap.startedAt || Date.now(),
              ended_at: Date.now(),
              winners: snap.winners.map((w) => ({ userId: w.userId, amount: w.amount })),
              players: players.map((pp) => ({
                userId: pp.user_id,
                seat: pp.seat_number,
                stack: pp.stack,
              })),
              actions: snap.actions,
            };
            integrityFeed.ingestRow(feedRow);
          } catch {
            /* observe-only: never affect settlement */
          }
        }
      }
    });

    // SETTLEMENT STEP 8b: Distribute rake — ATOMIC + IDEMPOTENT + RECOVERABLE.
    // RAKE-AUDIT 2026-07-24 [money]: replaced the separate, non-atomic
    // logRakeCollection(...) + fire-and-forget rake_records insert (old STEP 12)
    // with ONE awaited atomic_distribute_rake(...) call, mirroring
    // bbj_atomic_payout_v2. In a single SECURITY DEFINER transaction it gates on
    // the hand (idempotent no-op on retry/restart), writes the durable
    // rake_records audit, credits the club_wallets accumulator, and routes the
    // spendable rake (union rake_wallet OR standalone chip_treasury) via a
    // per-leg claim ledger, so a missing leg is re-driven WITHOUT double-crediting.
    // UNION MODEL UNCHANGED: the union still holds 100% of cash rake; the weekly
    // settlement still returns 90% to clubs (nets 10%).
    await runStep('rake_distribution', true, async () => {
      if (!this.isTournamentTable() && snap.rake > 0 && this.tableInfo?.club_id) {
        const contribsObj: Record<string, number> = {};
        for (const [uid, amt] of snap.contributions.entries()) {
          contribsObj[uid] = amt;
        }
        // WEIGHTED CONTRIBUTED RAKE (Dan 2026-08-29): pass the returned-
        // uncalled audit map and stamp the methodology. contribsObj is already
        // ELIGIBLE contribution (net of returned uncalled bets), so the RPC's
        // weighted per-player attribution needs no further adjustment.
        const returnedObj: Record<string, number> = {};
        for (const [uid, amt] of snap.returnedUncalled.entries()) {
          returnedObj[uid] = amt;
        }
        let rakeDistributed = false;
        for (let attempt = 0; attempt < 3 && !rakeDistributed; attempt++) {
          const { error: rdErr } = await supabase.rpc('atomic_distribute_rake', {
            p_table_id: this.tableId,
            p_club_id: this.tableInfo.club_id,
            p_hand_id: v_handHistoryId,
            p_hand_number: snap.handNumber,
            p_rake: snap.rake,
            p_bbj: snap.bbjFee,
            p_pot: snap.potSize,
            p_num_players: snap.contributions.size,
            p_contributions: contribsObj,
            p_tournament_id: this.tableInfo.tournament_id || null,
            p_returned_uncalled: returnedObj,
            p_rake_method: 'WEIGHTED_CONTRIBUTED',
          });
          if (!rdErr) {
            rakeDistributed = true;
          } else if (attempt === 2) {
            reportError(
              new Error(`[atomic_distribute_rake] failed after retries: ${rdErr.message}`),
              'postHandTasks.atomic_distribute_rake_failed'
            );
            // A5 FIX (2026-08-08): the retries are exhausted, but the rake is
            // ALREADY out of the pot. Reporting an error and moving on destroyed
            // those chips — nothing on disk said they were owed. Queue the exact
            // arguments so the FeeReconciler can re-drive them. Re-driving is
            // safe: atomic_distribute_rake is gated on the hand
            // (uq_rake_records_hand_id), so an entry that actually did land is a
            // no-op rather than a double-bank.
            await queueUnbankedFee('rake', {
              tableId: this.tableId,
              clubId: this.tableInfo?.club_id,
              handId: v_handHistoryId,
              handNumber: snap.handNumber,
              rake: snap.rake,
              bbj: snap.bbjFee,
              pot: snap.potSize,
              numPlayers: snap.contributions.size,
              contributions: contribsObj,
              returnedUncalled: returnedObj,
              rakeMethod: 'WEIGHTED_CONTRIBUTED',
              tournamentId: this.tableInfo?.tournament_id || null,
              bigBlind: this.tableInfo?.big_blind ?? null,
              lastError: rdErr.message,
            });
          } else {
            await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
          }
        }
      }
    });

    // SETTLEMENT STEP 8c: Log BBJ contribution
    // Round 44: pass v_handHistoryId so bbj_contributions.hand_id links to
    // hand_history (consistent with rake_records and club_wallet_transactions).
    await runStep('bbj_contribution', true, async () => {
      if (!this.isTournamentTable() && snap.bbjFee > 0 && this.tableInfo?.club_id) {
        // A5 FIX (2026-08-08): this return value used to be discarded, and
        // logBBJCollection swallowed every failure while logging 1 hand in 100.
        // That was not cosmetic. atomic_distribute_rake computes
        // `v_net := p_rake - v_bbj` and credits the club wallet only v_net,
        // deliberately excluding the BBJ slice because bbj_record_contribution is
        // what puts it into the jackpot pool. So a failure here left the chips in
        // NEITHER place — out of the pot and out of existence. An audit of the
        // 20,000 most recent raked hands (joined on hand_id) found zero actually
        // lost, so this is a hole being closed before it bites rather than a bleed
        // being stopped — but it was a hole nobody could have SEEN bite, which is
        // the part that had to change.
        const bbjBanked = await logBBJCollection(
          this.tableId,
          this.tableInfo.club_id,
          snap.handNumber,
          snap.bbjFee,
          this.tableInfo.big_blind,
          v_handHistoryId
        );
        if (!bbjBanked) {
          await queueUnbankedFee('bbj_contribution', {
            tableId: this.tableId,
            clubId: this.tableInfo.club_id,
            handId: v_handHistoryId,
            handNumber: snap.handNumber,
            rake: snap.rake,
            bbj: snap.bbjFee,
            pot: snap.potSize,
            numPlayers: snap.contributions.size,
            contributions: {},
            tournamentId: this.tableInfo?.tournament_id || null,
            bigBlind: this.tableInfo?.big_blind ?? null,
            lastError: 'logBBJCollection returned false',
          });
        }
      }
    });

    // SETTLEMENT STEP 12: rakeback input (durable rake_records) is now written
    // INSIDE atomic_distribute_rake (STEP 8b) — one atomic, idempotent,
    // recoverable transaction. RAKE-AUDIT 2026-07-24 [money]: the former separate
    // fire-and-forget `rake_records.insert` here was REMOVED — it could silently
    // drop the settler's sole rakeback input on failure, and double-write on a
    // retry. RakebackSettlerService reads rake_records exactly as before.

    // SETTLEMENT STEP 12b: Promo playthrough accrual (unlock-by-wagering).
    // Any player who has an outstanding promo balance accrues their per-hand
    // wagered amount toward the playthrough requirement. When the threshold is
    // met, promo_apply_playthrough RELEASES the promo into cashable chip_balance
    // (atomic, FOR UPDATE, idempotent no-op when no promo is outstanding).
    // Cash tables only — tournament chips never carry a promo playthrough.
    // Fire-and-forget per player: non-blocking to gameplay, failures are logged
    // but never surface to the table (the wager is durably in rake_records above,
    // and the next hand's accrual is additive so nothing is lost permanently).
    await runStep('promo_playthrough', false, async () => {
      if (!this.isTournamentTable() && this.tableInfo?.club_id) {
        const promoClubId = this.tableInfo.club_id;
        for (const [uid, amt] of snap.contributions.entries()) {
          if (!uid || amt <= 0) continue;
          Promise.resolve(
            supabase.rpc('promo_apply_playthrough', {
              p_club_id: promoClubId,
              p_user_id: uid,
              p_wagered: amt,
            })
          )
            .then(({ error }: { error: unknown }) => {
              if (error) {
                console.warn('[Engine] promo_apply_playthrough failed (non-fatal):', error);
              }
            })
            .catch((ppErr: unknown) => {
              console.warn('[Engine] promo_apply_playthrough threw (non-fatal):', ppErr);
            });
        }
      }
    });

    // 3b. Bible V8 §4.19: Log insurance settlements (settled in HAND_COMPLETE handler)
    // Insurance premiums → union bank (or club bank for standalone)
    // Insurance payouts → from union bank (or club bank) to player
    await runStep('insurance_ledger', true, async () => {
      if (
        !this.isTournamentTable() &&
        this.tableInfo?.club_id &&
        snap.insuranceSettlements.length > 0
      ) {
        for (const settlement of snap.insuranceSettlements) {
          // EV CASHOUT 2026-08-28: the bank's IN side for a cashout is the
          // redirected pot winnings (what the bank actually collected after
          // clamps), logged in the premium column; the OUT side is the locked
          // cashout in payout. bank_delta = premium − payout keeps working.
          const bankIn =
            settlement.kind === 'ev_cashout'
              ? (snap.cashoutRedirects.get(settlement.playerId) ?? 0)
              : settlement.premium;
          await logInsuranceSettlement({
            tableId: this.tableId,
            clubId: this.tableInfo.club_id,
            handNumber: snap.handNumber,
            playerId: settlement.playerId,
            equityPercent: settlement.equity, // FIX-A12: real equity the premium was priced on
            premium: bankIn,
            insuredAmount: settlement.insuredAmount,
            payout: settlement.payout,
            playerWon: !settlement.won, // settlement.won = insurance paid out = player lost the hand
            kind: settlement.kind,
          });
        }
      }
    });

    // 3c. BBJ Payout — if a BBJ hit was detected in HAND_COMPLETE, process the actual payout
    // Chips credited directly to players' table balances from union/club BBJ pool
    await runStep('bbj_payout', true, async () => {
      if (
        !this.isTournamentTable() &&
        this.tableInfo?.club_id &&
        snap.bbjHit?.hit &&
        snap.bbjPayoutConfig
      ) {
        const bbjHit = snap.bbjHit;
        const payoutConfig = snap.bbjPayoutConfig;
        const result = await processBBJPayout({
          tableId: this.tableId,
          clubId: this.tableInfo.club_id,
          handNumber: snap.handNumber,
          loserUserId: bbjHit.loserUserId!,
          winnerUserId: bbjHit.winnerUserId!,
          loserHandName: bbjHit.loserHand?.name || 'Unknown',
          winnerHandName: bbjHit.winnerHand?.name || 'Unknown',
          dealtInPlayerIds: bbjHit.dealtInPlayerIds || [],
          // FIX P0-2: pass the currently-seated user_ids (engine memory = seat
          // authority) so the payout RPC credits seats for these and credits the
          // wallet directly for any dealt-in recipient who has since left the
          // table (their share is no longer silently dropped).
          seatedUserIds: players.map((p) => p.user_id),
          payoutTotalPercent: payoutConfig.bbjPayoutTotalPercent,
        });

        if (result) {
          // Credit chips directly to players' table stacks
          // LOSER (bad beat holder) gets 50% of total payout
          const loserSeat = players.find((p) => p.user_id === bbjHit.loserUserId);
          if (loserSeat) {
            loserSeat.stack += result.loserShare;
            console.log(
              `[ServerTableEngine:${this.tableId}] BBJ → Loser ${bbjHit.loserUserId} +$${result.loserShare}`
            );
          }

          // WINNER (hand winner) gets 25% of total payout
          const winnerSeat = players.find((p) => p.user_id === bbjHit.winnerUserId);
          if (winnerSeat) {
            winnerSeat.stack += result.winnerShare;
            console.log(
              `[ServerTableEngine:${this.tableId}] BBJ → Winner ${bbjHit.winnerUserId} +$${result.winnerShare}`
            );
          }

          // TABLE SHARE: remaining 25% split equally among dealt-in players (excluding loser/winner)
          const tableOnlyPlayers = (bbjHit.dealtInPlayerIds || []).filter(
            (id) => id !== bbjHit.loserUserId && id !== bbjHit.winnerUserId
          );
          for (const playerId of tableOnlyPlayers) {
            const seat = players.find((p) => p.user_id === playerId);
            if (seat) {
              seat.stack += result.perPlayerShare;
              console.log(
                `[ServerTableEngine:${this.tableId}] BBJ → Table player ${playerId} +$${result.perPlayerShare}`
              );
            }
          }

          // Re-sync stacks to database with BBJ payouts included
          await syncStacks(
            this.tableId,
            players.map((p) => ({
              user_id: p.user_id,
              stack: p.stack,
              time_bank_uses_remaining: this.timeBankEngine.getUsesRemaining(
                this.tableId,
                p.user_id
              ),
              time_bank_remaining: this.timeBankEngine.getRemainingSeconds(this.tableId, p.user_id),
            }))
          );

          // Broadcast updated stacks + BBJ payout details so clients show the celebration
          this.hub?.emitEvent(this.tableId, {
            type: 'bbj_payout_complete',
            table_id: this.tableId,
            hand_number: snap.handNumber,
            /* The celebration's own trigger, so it carries the same stamp as
               bbj_hit above - see the note there for why a retained replay is
               otherwise indistinguishable from a live hit. */
            emitted_at: Date.now(),
            totalPayout: result.totalPayout,
            loser: { userId: bbjHit.loserUserId, share: result.loserShare },
            winner: { userId: bbjHit.winnerUserId, share: result.winnerShare },
            tableShare: result.tableShare,
            perPlayerShare: result.perPlayerShare,
            tablePlayerIds: tableOnlyPlayers,
            // Include updated stacks for all players
            updatedStacks: players.map((p) => ({ userId: p.user_id, stack: p.stack })),
          });

          console.log(
            `[ServerTableEngine:${this.tableId}] BBJ payout complete: $${result.totalPayout} distributed to ${players.length} players`
          );
        }
      }
    });

    // SETTLEMENT STEP 8d: Tournament chip sync
    await runStep('tournament_chip_sync', true, async () => {
      // Lane F: a hand that did not conserve persisted nothing above, and
      // mirroring table_seats into tournament_players is a no-op then. Kept
      // explicit so the refusal cannot be undone by a later step.
      if (!tournamentHandConserved) return;
      if (this.isTournamentTable() && this.tableInfo?.tournament_id) {
        await syncTournamentChips(this.tableId, this.tableInfo.tournament_id);
      }
    });

    // SETTLEMENT STEP 8e: Process pending add-ons (queued during the hand).
    // Must run AFTER pot distribution + BBJ payouts so we know each player's
    // final stack. Add-ons are capped so stack + add-on <= max buy-in.
    // Any excess is refunded to the player's club wallet.
    await runStep('pending_addons', true, async () => {
      if (!this.isTournamentTable()) {
        await this.processPendingAddOns(players);
      }
    });

    // 5. Auto-rebuy busted horses (cash games only)
    await runStep('horse_rebuys', false, async () => {
      if (!this.isTournamentTable()) {
        const bustHorses = players.filter((p) => p.is_horse && p.stack === 0);
        for (const horse of bustHorses) {
          const currentRebuys = this.horseRebuys.get(horse.user_id) || 0;

          /**
           * Stop-loss. This was a hard-coded `>= 2` for every horse alike;
           * it is now the temperament's own figure, and `standard` - six in
           * ten of the fleet - still stops at exactly the same place, so this
           * is a spread around today's behaviour rather than a move away from
           * it. A nit gives up a buy-in earlier, a gambler one later.
           */
          if (atRebuyStopLoss(horse.user_id, currentRebuys)) {
            await markSeatAsLeft(this.tableId, horse.user_id, horse.seat_number);
            // Round 57: clear FSM tracking so the horse doesn't leave a ghost
            // entry in disconnect_states.
            this.disconnectEngine.unregisterPlayer(this.tableId, horse.user_id);
            // Round 64: same for TimeBankEngine.
            this.timeBankEngine.removePlayer(this.tableId, horse.user_id);
            // Round 66: same for StraddleEngine — symmetric cleanup.
            this.straddleEngine.removePlayer(this.tableId, horse.user_id);
            this.preActionEngine.removePlayer(this.tableId, horse.user_id);
            this.horseRebuys.delete(horse.user_id);
            console.log(
              `[ServerTableEngine:${this.tableId}] Stop-Loss: Horse ${horse.username} lost 3 buy-ins and has been removed.`
            );
            continue;
          }

          /**
           * WHETHER, and HOW MUCH. `bigBlind * 100` ignored the table's own
           * limits and the horse's roll both; a horse that can no longer
           * afford this stake now stands up instead of reloading it forever.
           * Zero is a decision to leave and takes the same branch a failed
           * funding call already took. The chips still come from the club
           * treasury - this changes the answer, not the source.
           */
          const rebuyAmount = await horseRebuyAmount({
            clubId: this.tableInfo?.club_id || '',
            userId: horse.user_id,
            bigBlind: Number(this.tableInfo?.big_blind) || 0,
            minBuyIn: this.tableInfo?.min_buy_in as number | null | undefined,
            maxBuyIn: this.tableInfo?.max_buy_in as number | null | undefined,
            rebuysTaken: currentRebuys,
          });
          const success =
            rebuyAmount > 0 &&
            (await autoRebuyHorse(
              this.tableId,
              horse.user_id,
              rebuyAmount,
              this.tableInfo?.club_id || ''
            ));
          if (success) {
            horse.stack = rebuyAmount;
            this.horseRebuys.set(horse.user_id, currentRebuys + 1);
            console.log(
              `[ServerTableEngine:${this.tableId}] Auto-rebuy: ${horse.username} -> ${rebuyAmount} chips (Rebuy #${currentRebuys + 1})`
            );
          } else {
            await markSeatAsLeft(this.tableId, horse.user_id, horse.seat_number);
            // Round 57: clear FSM tracking on insufficient-funds leave too.
            this.disconnectEngine.unregisterPlayer(this.tableId, horse.user_id);
            // Round 64: same for TimeBankEngine.
            this.timeBankEngine.removePlayer(this.tableId, horse.user_id);
            // Round 66: same for StraddleEngine.
            this.straddleEngine.removePlayer(this.tableId, horse.user_id);
            this.preActionEngine.removePlayer(this.tableId, horse.user_id);
            this.horseRebuys.delete(horse.user_id);
            console.log(
              `[ServerTableEngine:${this.tableId}] Horse ${horse.username} left - insufficient funds`
            );
          }
        }
      }
    });

    // 5.7 CHIP CONTINUITY (Operation Table Stakes, Slice 0): the hand is
    // settled, add-ons and horse rebuys have landed, so every seated player's
    // stack is final for this boundary. Tell the database, which settles each
    // stay clock and decides who is ahead of their money (running) and who is
    // not (paused, remainder kept). Runs BEFORE any departure below so a
    // horse's profit-target exit and a leave_pending seat are judged against
    // the post-hand stack, never the pre-hand one.
    await runStep('chip_continuity', false, async () => {
      if (!this.isTournamentTable()) {
        await this.chipContinuity.evaluate(
          players.map((p) => ({
            user_id: p.user_id,
            stack: p.stack,
            active: this.isContinuityActive(p.user_id),
          }))
        );
      }
    });

    // 5.5 Auto-Cashout successful horses (bankroll management)
    // Always wait until right before they are the Big Blind to leave.
    await runStep('horse_cashouts', false, async () => {
      if (!this.isTournamentTable() && players.length >= 2) {
        const maxBuyIn = this.tableInfo?.max_buy_in
          ? Number(this.tableInfo.max_buy_in)
          : (this.tableInfo?.big_blind || 2) * 200;

        // Calculate who will be the next Big Blind — AUDIT FIX 2026-07-19:
        // seat-based from the current button. Next hand's button is the next
        // occupied seat clockwise from lastButtonSeat; BB is one seat past SB
        // (HU: BB is the non-button, i.e. one seat past the button).
        // Uses the SAME predictButtonSeat as getSBSeatIndex, getBBSeatIndex and
        // the rotation itself. This was a fourth, independent walk over the raw
        // roster, so once new players stopped being button-eligible it could
        // name a different next button than the deal actually uses — and this
        // one decides when a horse stands up to dodge the big blind, so
        // disagreeing means it leaves on the wrong hand.
        const nextButtonSeat = this.predictButtonSeat(players);
        const nextSbSeat =
          players.length === 2 ? nextButtonSeat : this.getNextSeat(nextButtonSeat, players);
        const nextBbSeat = this.getNextSeat(nextSbSeat, players);
        const nextBbPlayer = players.find((p) => p.seat_number === nextBbSeat);

        const cashedOutHorses = players.filter((p) => {
          if (!p.is_horse) return false;

          // Target is dynamically between 2.5x and 3.5x max buy-in
          // We use their user_id to deterministically seed their target, so they don't randomly flip-flop
          const idInt = parseInt(p.user_id.replace(/-/g, '').substring(0, 8), 16) || 0;
          const targetMultiplier = 2.5 + idInt / 0xffffffff;
          const cashOutTarget = maxBuyIn * targetMultiplier;

          // Only depart if they hit the target AND their NEXT hand is the Big Blind
          const isNextBb = p.user_id === nextBbPlayer?.user_id;

          return p.stack >= cashOutTarget && isNextBb;
        });

        for (const horse of cashedOutHorses) {
          // CHIP CONTINUITY / HORSES ARE PLAYERS (CLAUDE.md 10.5): a horse
          // that has hit its target is a player choosing to leave while
          // ahead, so it goes through the same door a human does and waits
          // out the same stay clock. A refusal simply means "not this
          // orbit" - the target still stands and it tries again when the big
          // blind comes back around, exactly as a human would.
          const exit = await atomicCashoutVoluntary(horse.user_id, this.tableId, horse.seat_number);
          if (!exit.ok) {
            if (exit.code === 'LEAVE_LOCKED') {
              this.chipContinuity.noteRefusal(horse.user_id, exit.stayRemainingMs);
              console.log(
                `[ServerTableEngine:${this.tableId}] Bankroll Management: Horse ${horse.username} at target but stay clock has ${exit.stayRemainingMs}ms left - stays seated`
              );
            }
            continue;
          }
          this.chipContinuity.forget(horse.user_id);
          // Round 57: clear FSM tracking on profit-target cashout too.
          this.disconnectEngine.unregisterPlayer(this.tableId, horse.user_id);
          // Round 64: same for TimeBankEngine.
          this.timeBankEngine.removePlayer(this.tableId, horse.user_id);
          // Round 66: same for StraddleEngine.
          this.straddleEngine.removePlayer(this.tableId, horse.user_id);
          this.preActionEngine.removePlayer(this.tableId, horse.user_id);
          this.horseRebuys.delete(horse.user_id);
          console.log(
            `[ServerTableEngine:${this.tableId}] Bankroll Management: Horse ${horse.username} hit profit target (${Math.floor(horse.stack)} chips) and cashed out before posting the Big Blind.`
          );
        }
      }
    });

    // 5.9 FIX 143: Bible V8 §7.12 — Apply deferred sit-outs now that the hand is over
    await runStep('deferred_sitouts', false, async () => {
      if (this.pendingSitOut.size > 0) {
        for (const userId of this.pendingSitOut) {
          this.disconnectEngine.sitOut(this.tableId, userId, 'voluntary');
          console.log(`[ServerTableEngine:${this.tableId}] Deferred sit-out applied: ${userId}`);
        }
        this.pendingSitOut.clear();
      }
    });

    // 6. Process leave-pending players (cash games only)
    await runStep('leave_pending', true, async () => {
      if (!this.isTournamentTable()) {
        // Round 57: processLeavePending now returns the user_ids it cashed out;
        // we use that to unregister DisconnectEngine tracking so player states
        // don't leak. Without this every leaver leaves a ghost FSM entry that
        // persists in hand_state_snapshots.disconnect_states forever.
        // Round 64: extended to also call timeBankEngine.removePlayer so the
        // playerBanks Map sheds its entry too — same architectural fix.
        const cashedOutIds = await processLeavePending(
          this.tableId,
          this.tableInfo?.club_id || '',
          (lockedUserId, stayRemainingMs) =>
            this.onLeaveRefusedAtSettlement(lockedUserId, stayRemainingMs)
        );
        for (const userId of cashedOutIds) {
          this.disconnectEngine.unregisterPlayer(this.tableId, userId);
          this.timeBankEngine.removePlayer(this.tableId, userId);
          this.straddleEngine.removePlayer(this.tableId, userId);
          this.preActionEngine.removePlayer(this.tableId, userId);
          this.chipContinuity.forget(userId);
        }
      }
    });

    // SETTLEMENT STEP 15: Unlock table — authoritative recount, ready for next hand
    await runStep('table_unlock', true, async () => {
      // PAYOUT-INTEGRITY 2026-08-28: this ran `dbPlayerCount ?? 0` on a count
      // whose error was never destructured. It is the AUTHORITATIVE recount at
      // the end of EVERY hand, so a single failed read wrote
      // current_players = 0 on a live table, flipped it to 'waiting', and
      // broadcast seated_count 0 to everyone sitting at it. TableService does
      // the identical recount and checks the error first (TableService.ts:465);
      // this path was the one without the guard.
      //
      // Same house rule as everywhere else in this engine: a count we could not
      // read is UNKNOWN, not zero. Leave the table's status exactly as it is
      // and let the next hand's recount settle it.
      const { count: dbPlayerCount, error: countErr } = await supabase
        .from('table_seats')
        .select('*', { count: 'exact', head: true })
        .eq('table_id', this.tableId)
        .is('left_at', null);
      let finalCount: number | null = null;
      if (countErr || dbPlayerCount === null || dbPlayerCount === undefined) {
        reportError(
          new Error(
            `[Table:${this.tableId.slice(0, 8)}] table_unlock: seat count unavailable (${countErr?.message ?? 'null count'}) - table status left unchanged`
          ),
          'ServerTableEngine.table_unlock_count_unavailable'
        );
      } else {
        finalCount = dbPlayerCount;
        await updateTableStatus(this.tableId, finalCount, finalCount >= 2 ? 'running' : 'waiting');
      }

      // Phase X5 (2026-04-28): emit table_unlocked event paired with the
      // table_locked emitted at the start of settlement. Bible V8 §1.16.
      // If the DB recount was unavailable, fall back to the engine's in-memory
      // seat list for the event only: the unlock event must still pair with
      // table_locked, and the in-memory roster is known state, not a
      // fabricated zero. Table status itself was left unchanged above.
      const unlockedCount = finalCount ?? this.seatedPlayers.length;
      this.hub?.emitEvent(this.tableId, {
        type: 'table_unlocked',
        table_id: this.tableId,
        hand_number: snap.handNumber,
        seated_count: unlockedCount,
        next_state: unlockedCount >= 2 ? 'running' : 'waiting',
        timestamp: Date.now(),
      });
    });

    // Settlement pipeline complete — table unlocked for next hand
  }
}
