/**
 * ServerTableEngine, layer 6/8 — the HAND_COMPLETE settlement pipeline and post-hand tasks.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { randomUUID } from 'node:crypto';
import { HandController } from './HandController.js';
import { TimeBankEngine } from './TimeBankEngine.js';
import { DisconnectEngine } from './DisconnectEngine.js';
import { AtomicStackService, type StackSettlement } from './AtomicStackService.js';
import { StraddleEngine } from './StraddleEngine.js';
import { integrityFeed } from '../integrity/IntegrityFeed.js';
import type { HandHistoryRow } from '../integrity/HandEventAdapter.js';
import { computeSevenDeuceBounties } from './SevenDeuceBounty.js';
import {
  getFullRakeConfig,
  detectBBJHit,
  detectBBJNearMiss,
  detectMiniBBJHit,
  getTierIdForBB,
} from '../config/RakeConfig.js';
import type { BBJDetectionResult } from '../config/RakeConfig.js';
import { maybeArmed } from '../services/supabase/bbjDrillRegistry.js';
import {
  loadTable,
  persistTimeBanks,
  reconcileTableSeatCount,
  autoRebuyHorse,
  processLeavePending,
  atomicCashoutVoluntary,
  logBBJCollection,
  logInsuranceSettlement,
  logHandHistory,
  processBBJPayout,
  processMiniBBJPayout,
  processHandPostCommitObligations,
  recordBBJNearMiss,
  resolveJackpotSiblingClubIds,
  completeHandSnapshot,
  supabase,
} from '../services/supabase.js';
import type { HandEvent, SeatedPlayer } from '../types.js';
import * as EngineMetrics from '../observability/engineInstruments.js';
import { v5 as uuidv5 } from 'uuid';
import { reportError } from '../services/errorReporter.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { queueUnbankedFee } from '../services/FeeReconciler.js';
import { selectRevealedShowdownResults } from './revealedShowdown.js';
import { ServerTableEngineDealing } from './ServerTableEngineDealing.js';
import { atRebuyStopLoss, horseRebuyAmount } from '../services/HorseRebuyPolicy.js';
import { buildDailyMissionHandEvents } from './dailyMissionEvents.js';
import { maybeSpeak } from './HorseTableTalk.js';
import { checkTournamentChipConservation } from './tournamentChipConservation.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { INSTANCE_ID } from '../services/tableLease.js';

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
      // Keep concurrent taps from duplicating work while the first RPC runs.
      // The durable request ID below also protects payment if its response is
      // lost and a later tap retries after this in-memory guard is released.
      return { success: false, error: 'Rabbit Hunt Is Already Loading' };
    }
    this.rabbitHuntInFlight.add(userId);

    // VIP monthly pool -> purchased packs -> 5 diamonds. Engine-only RPC: a
    // player's own JWT cannot execute it, which is what stops a client from
    // simply not calling it.
    let charge: Record<string, unknown> | null = null;
    try {
      // A timeout can follow a committed charge. Reuse the durable receipt for
      // this player/table/hand, including after an engine instance changes.
      const requestId = uuidv5(
        JSON.stringify([
          'club-arena.rabbit-hunt.v1',
          this.tableId.toLowerCase(),
          hand,
          userId.toLowerCase(),
        ]),
        uuidv5.URL
      );
      const { data, error } = await supabase.rpc('fn_consume_rabbit_hunt_v2', {
        p_user_id: userId,
        p_request_id: requestId,
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
    // Payment has already committed its durable receipt in the consumption
    // RPC. This metadata write is not a payment gate: even a stalled insert
    // must not hold back cards the player has bought. Start it immediately,
    // capture this hand's fields before yielding, and report both returned
    // errors and rejected requests. It never joins the next-hand barrier.
    void (async () => {
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
    })();

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
  /**
   * Claim a single armed Bad Beat Jackpot drill for this hand, and turn it
   * into a detection result built from the REAL showdown (BBJ phase 4.1).
   *
   * Returns null unless an operator armed this exact table and the arm has not
   * already fired. The claim is one atomic UPDATE in the database, so a
   * forgotten arm fires once and two engines racing the same hand cannot both
   * win it.
   *
   * NOTHING HERE CHOOSES A CARD. The loser and the winner are whoever actually
   * sat down and actually showed down, the board is the board that was dealt,
   * and the pot is the pot that was played for. Only the verdict is injected.
   */
  private async claimBBJDrill(
    dealtInPlayerIds: string[],
    variant: string,
    handNumber: number
  ): Promise<BBJDetectionResult | null> {
    /* Refuse before claiming, never after. An arm burned on a hand that cannot
       produce a payout is an operator arming again and wondering why. */
    if (this.currentHandShowdownResults.length < 2) return null;
    if (this.currentHandWinnerIds.length < 1) return null;

    /* ASK THE CHEAP QUESTION FIRST. Without this the claim RPC ran on every
       contested showdown - 137,923 round trips in twenty-four hours, measured
       on production, every one of them answering "no" - on an engine that is
       one core. The registry is one query a minute per process; this is a Set
       lookup. It can only ever DELAY a drill, never cause one: the atomic
       claim below is still the only thing that fires one. */
    if (!(await maybeArmed(this.tableId))) return null;

    const winnerId = this.currentHandWinnerIds[0];
    const winner = this.currentHandShowdownResults.find((r) => r.userId === winnerId);
    const loser = this.currentHandShowdownResults.find((r) => r.userId !== winnerId);
    if (!winner || !loser) return null;

    try {
      const { data, error } = await supabase.rpc('fn_bbj_claim_drill', {
        p_table_id: this.tableId,
        p_hand_number: handNumber,
      });
      if (error) {
        /* A drill is never worth failing a hand over. If the database cannot
           be asked, the hand settles exactly as it would have. */
        reportError(error, 'ServerTableEngine.bbj_drill_claim_failed', { tableId: this.tableId });
        return null;
      }
      const claim = (Array.isArray(data) ? data[0] : data) as { claimed?: boolean } | null;
      if (!claim?.claimed) return null;

      console.warn(
        `[ServerTableEngine:${this.tableId}] *** BBJ DRILL FIRED *** hand #${handNumber}. ` +
          `This is a drill, not a real bad beat. The chips are real.`
      );
      EngineMetrics.bbjDrillsFiredTotal.inc(1, { table_id: this.tableId });

      return {
        hit: true,
        loserUserId: loser.userId,
        loserHand: {
          ranking: loser.handRanking,
          name: loser.handName,
          kickers: loser.kickers ?? [],
        },
        winnerUserId: winner.userId,
        winnerHand: {
          ranking: winner.handRanking,
          name: winner.handName,
          kickers: winner.kickers ?? [],
        },
        dealtInPlayerIds,
        variant,
        qualifyingHandLabel: 'Drill',
      };
    } catch (e) {
      reportError(e, 'ServerTableEngine.bbj_drill_claim_threw', { tableId: this.tableId });
      return null;
    }
  }

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
    /* CHAIN, NEVER OVERWRITE (chip standard 2026-09-04). settleCompletedHand
       runs synchronously to completion on the common path - its only awaits
       are the insurance-shortfall alerts - so by the time it returns it has
       ALREADY assigned postHandTasksPromise = Promise.all([prior, postTasks])
       and fired the chain. The line this replaces then overwrote that with
       wholeSettlement.catch(...), a promise that was already resolved and did
       not include postHandTasks. The dealing loop saw a settled barrier,
       reloaded seats before step 8e had credited the pending add-ons, dealt
       from the stale stacks, and the next hand write erased the credits:
       64 add-ons / 7,685.70 chips in three hours on 2026-09-04. Whatever the
       body assigned is kept and this hand's own promise is added to it; on
       the rare path where the body awaited before firing the chain, the body
       reads this assignment back as its `priorBarrier` and chains onto it.
       Barrier only - failures are reported inside; the barrier must resolve
       either way or the table stops dealing forever. */
    const guarded = wholeSettlement.catch(() => undefined);
    const assignedByBody = this.postHandTasksPromise;
    this.postHandTasksPromise = assignedByBody
      ? Promise.all([assignedByBody, guarded]).then(() => undefined)
      : guarded;
    this.trackSettlementInFlight(this.postHandTasksPromise);
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
      // Chip standard 2026-09-04: what the bank net moved onto the seats, as
      // applied. Declared to the stack write as inflow (see postHandTasks).
      let insuranceNet = 0;
      for (const d of insuranceDeltas.values()) insuranceNet += d;
      this.currentHandInsuranceNet = Math.round(insuranceNet * 100) / 100;
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

      /* ── THE DRILL: ARM A TABLE, NEVER A DECK (BBJ phase 4.1) ─────────────
         A jackpot fires about once a fortnight - the last real one was
         2026-08-19 - so everything downstream of this line has never been
         watched end to end on live infrastructure. The drill lets an operator
         see it in minutes.

         WHAT IT INJECTS IS THIS RESULT, NOT THE CARDS. The plan called for a
         rigged deck and it should not exist: `detectBBJHit` is a pure function
         with 32 tests over every qualifying rule, every variant and every
         rejection reason, so dealing one lucky hand would prove a single case
         those already prove - in exchange for putting code in a real-money
         engine that can choose a player's hole cards. The deck stays
         crypto-shuffled, unseeded and uninjectable.

         So the showdown below is REAL: real players, real board, real pot. The
         only synthetic thing is the verdict. Everything after it - the payout
         RPC, the recipients, the notifications, the hub events, the ledger -
         then runs for real, because it IS real. A drill produces a genuine
         jackpot at a drill club, so nothing in the history is fabricated.

         THE ENGINE NEVER DECIDES. The arm lives in the database and is claimed
         atomically, so there is no flag a deploy can turn on and none it can
         leave on. `fn_bbj_arm_drill` refuses a union pool outright (that is
         where the production jackpot lives) and any pool over 1,000.00. */
      let drillResult: typeof bbjResult | null = null;
      if (!bbjResult.hit) {
        drillResult = await this.claimBBJDrill(dealtInPlayerIds, variant, this.handCount);
      }
      const effectiveBbjResult = drillResult ?? bbjResult;

      if (effectiveBbjResult.hit) {
        const bbjResult = effectiveBbjResult;
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
        EngineMetrics.bbjHitsDetectedTotal.inc(1, { table_id: this.tableId });
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
          /* RETAINED FOR A RECONNECT (BBJ build plan phase 1, 2026-09-05). The
             hub keeps an event only if it declares its own expiry (D3,
             TableStateHub.retainIfReplayable). Without this a player whose
             socket was between reconnects for the one second this went out -
             a train, a backgrounded phone - never received the hand names the
             celebration is built from. Sixty seconds is the hub's ceiling;
             the client's identity gate (lib/bbjHitOnce) already refuses a
             replay it has seen, so retention cannot make it play twice. */
          replay_until: Date.now() + 60_000,
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
        /* ── THE MINI JACKPOT (BBJ phase 6 of 6, Dan 2026-09-07) ────────────
           The main bar was not met. Dan's second tier catches the hand that
           came close, at a rule that differs by game because the games do:
           hold'em ACES FULL OR BETTER losing, PLO ANY QUADS losing. Measured
           over seven days that is 3.4 a day and 0.6 a day - one rule for both
           would have been a lottery in one game and a shrug in the other.

           IT CANNOT OVERRULE THE MAIN. It is reached only from this else
           branch, so `detectBBJHit` has already said no; and the payout RPC
           shares the main's idempotency key (pool, table, hand), so one hand
           can produce one payout of either kind and never both. The money is a
           flat amount per stakes tier out of `backup_balance` - a reserve that
           until now nothing spent - never out of the jackpot itself. */
        const miniResult = detectMiniBBJHit(
          this.currentHandShowdownResults,
          this.currentHandWinnerIds,
          variant,
          this.currentHandPotSize,
          this.tableInfo.big_blind,
          dealtInPlayerIds.length,
          dealtInPlayerIds,
          { doubleBoard: this.currentHandCommunityCards2.length > 0 }
        );

        if (miniResult.hit) {
          const miniTierId = getTierIdForBB(this.tableInfo.big_blind);
          console.log(
            `[ServerTableEngine:${this.tableId}] *** MINI BBJ HIT (${miniResult.miniRule}) *** ` +
              `tier ${miniTierId}, loser ${miniResult.loserUserId} (${miniResult.loserHand?.name}), ` +
              `winner ${miniResult.winnerUserId} (${miniResult.winnerHand?.name})`
          );
          this.currentHandMiniBBJHit = miniResult;
          this.currentHandMiniBBJTierId = miniTierId;

          /* The same event the main jackpot emits, carrying `kind: 'mini'` so
             a client can show a smaller celebration - and so an older client,
             which reads no `kind`, still shows something rather than nothing.
             Same freshness stamp and same retention window as phase 1 built
             for the main, because a mini reaches a reconnecting socket the
             same way. */
          this.hub?.emitEvent(this.tableId, {
            type: 'bbj_hit',
            kind: 'mini',
            table_id: this.tableId,
            hand_number: this.handCount,
            emitted_at: Date.now(),
            replay_until: Date.now() + 60_000,
            loser: { userId: miniResult.loserUserId, hand: miniResult.loserHand },
            winner: { userId: miniResult.winnerUserId, hand: miniResult.winnerHand },
            tableShare: { playerIds: dealtInPlayerIds },
            variant,
            miniTierId,
            miniRule: miniResult.miniRule,
            qualifyingHandLabel: miniResult.qualifyingHandLabel,
          });
        }

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
            /* AND WRITE IT DOWN (2026-09-07). Until now this branch produced a
               console line and a hub event that expires in seconds, so after
               the fact nothing could distinguish "no qualifying hand occurred"
               from "one occurred and a gate refused it". That is exactly the
               question the jackpot's seventeen-day silence turned on, and it
               was unanswerable from this database (CLAUDE.md 10.86 rule 1).
               Fire-and-forget: a cosmetic banner, and now a row, must never be
               able to break settlement. */
            void recordBBJNearMiss({
              tableId: this.tableId,
              clubId: this.tableInfo?.club_id ?? null,
              handNumber: this.handCount,
              variant,
              bigBlind: this.tableInfo?.big_blind ?? null,
              potSize: this.currentHandPotSize,
              playersDealt: dealtInPlayerIds.length,
              userId: nearMiss.userId,
              handName: nearMiss.handName,
              reason: nearMiss.reason,
              message: nearMiss.message,
            }).catch(() => undefined);
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
    const postTasks = this.postHandTasks(players).catch((err) => {
      reportError(err, 'ServerTableEnginethistableId.Posthand_error');
      // A rejected settlement is not a completed hand. Publish the terminal
      // fence synchronously so the dealing loop cannot clear this barrier and
      // reload the pre-hand seats as if the write had succeeded.
      this.killForRestart('post_hand_settlement_failed');
      throw err;
    });
    this.postHandTasksPromise = priorBarrier
      ? Promise.all([priorBarrier, postTasks]).then(() => undefined)
      : postTasks;
    this.trackSettlementInFlight(this.postHandTasksPromise);
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
      // WHO WON EACH RUN (2026-09-04): the per-board record the felt already
      // reads off pot_win. It was built, broadcast, and then dropped at the
      // write, so a run-it-3-times scoop was recorded as one board's hand name.
      winnersByBoard: [...this.currentHandWinnersByBoard],
      showdownResults: [...this.currentHandShowdownResults],
      insuranceSettlements: [...this.currentHandInsuranceSettlements],
      insuranceNet: this.currentHandInsuranceNet,
      cashoutRedirects: new Map(this.currentHandCashoutRedirects),
      returnedUncalled: new Map(this.currentHandReturnedUncalled),
      bbjHit: this.currentHandBBJHit,
      bbjPayoutConfig: this.currentHandBBJPayoutConfig,
      miniBbjHit: this.currentHandMiniBBJHit,
      miniBbjTierId: this.currentHandMiniBBJTierId,
      dealtStacks: new Map(this.currentHandDealtStacks),
      // Capture bank values before settlement yields, just like the hand's
      // money and cards. A late continuation must not read the next hand's bank.
      timeBanks: new Map(
        players.map((p) => [
          p.user_id,
          {
            time_bank_uses_remaining: this.timeBankEngine.getUsesRemaining(this.tableId, p.user_id),
            time_bank_remaining: this.timeBankEngine.getRemainingSeconds(this.tableId, p.user_id),
            persisted_time_bank: p.persisted_time_bank ? { ...p.persisted_time_bank } : undefined,
          },
        ])
      ),
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
    /* ═══ TWO LANES UNDER THE HOLD (Dan 2026-09-07) ═══════════════════════
       "LOTS OF HANDS ARE NOT STARTING THE NEXT HAND 2 SECONDS AFTER THE HAND
       IS COMPLETED ... SOME UP TO 10 SECONDS+."

       The dealing loop waits on this chain before it will reload the roster
       (the settlement barrier, top of dealingLoop), and the chain ran every
       step in one file order: record, rake, jackpot, then add-ons, horses,
       leavers, table status. On the engine box a PostgREST round trip is
       250-700ms, so a plain cash hand paid seven or eight of them in a row -
       3-5s - against a completion hold of 2.1-3.5s. The felt sat in
       await_post_hand_tasks for a mean 5.9s per hand (measured 2026-09-07
       from /health's loop phases).

       The steps fall into two lanes with no dependency between them:

         THE RECORD  hand_history -> rake_distribution -> bbj_contribution ->
                     promo_playthrough -> insurance_ledger -> bbj_mini_payout
                     -> bbj_payout -> tournament_chip_sync
         THE SEATS   pending_addons -> horse_rebuys -> chip_continuity ->
                     horse_cashouts -> deferred_sitouts -> leave_pending ->
                     table_unlock

       runStep files each step by NAME into its lane (STEP_LANE) and returns
       at once; a step is run after the previous step of its own lane, in
       file order, and the loop's barrier waits for both lanes at the end.
       The step bodies and every `await runStep('...')` line keep their
       shape, which is also what the ordering laws pin. A step with no lane
       entry - sync_stacks, or anything added later without one - is run
       and awaited in place, before anything that follows it in the file,
       exactly as every step used to be. The authoritative hand commit is
       explicitly awaited before either lane may begin later work. Nothing
       in the seats lane reads `v_handHistoryId`, and nothing in the record
       lane reads a seat the other lane changed - the hand row is written
       from `playersForRecord`, copied synchronously before either lane
       starts.

       ONE exception keeps the old serial order, and it is the money one: a
       jackpot or insurance hand. bbj_mini_payout and bbj_payout write
       `updatedStacks` onto the very `players` the seats lane reads for
       "who busted", "who cashes out" and the add-on cap ("must run AFTER
       BBJ payouts", step 8e), so on those hands every seats step waits for
       the whole record lane exactly as before. Every other hand pays the
       longer lane instead of the sum. `snap` is the only hand state read in
       either lane (StaleContinuationSweep law). */
    const STEP_LANE: Record<string, 'record' | 'seats'> = {
      hand_history: 'record',
      rake_distribution: 'record',
      bbj_contribution: 'record',
      promo_playthrough: 'record',
      insurance_ledger: 'record',
      bbj_mini_payout: 'record',
      bbj_payout: 'record',
      tournament_chip_sync: 'record',
      pending_addons: 'seats',
      horse_rebuys: 'seats',
      chip_continuity: 'seats',
      horse_cashouts: 'seats',
      deferred_sitouts: 'seats',
      leave_pending: 'seats',
      table_unlock: 'seats',
    };
    const lanesCanOverlap =
      !snap.bbjHit?.hit && !snap.miniBbjHit && snap.insuranceSettlements.length === 0;
    const lanes: Record<'record' | 'seats', Promise<void>> = {
      record: Promise.resolve(),
      seats: Promise.resolve(),
    };
    /* The record is written from the stacks the hand ENDED with. Copied here,
       synchronously, so a rebuy or an add-on the seats lane credits while the
       record lane is still on its first round trip can never reach the row. */
    const playersForRecord = players.map((p) => ({ ...p }));

    const runStep = async (
      stepName: string,
      moneyCritical: boolean,
      fn: () => Promise<void>
    ): Promise<void> => {
      const exec = async (): Promise<void> => {
        // A successor generation may acquire the table while this step waits
        // behind another lane operation. Re-prove authority at execution, not
        // merely when the promise is queued, before beginning a new decision.
        if (!this.lifecycleCanMutate()) return;
        const started = performance.now();
        let outcome = 'returned';
        try {
          await fn();
        } catch (err) {
          outcome = 'threw';
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
        } finally {
          try {
            const elapsed = Math.max(0, performance.now() - started);
            const labels = {
              step: stepName,
              audience: this.humansSeated() > 0 ? 'human' : 'horse',
              format: this.tableFormat(),
              outcome,
            };
            EngineMetrics.settlementStepCount.inc(1, labels);
            EngineMetrics.settlementStepDuration.inc(elapsed, labels);
            EngineMetrics.settlementStepSlow.inc(elapsed >= 1000 ? 1 : 0, labels);
          } catch {
            /* Metrics must never interrupt settlement or error recovery. */
          }
        }
      };
      const lane = STEP_LANE[stepName];
      if (!lane) {
        await exec();
        return;
      }
      const after =
        lane === 'seats' && !lanesCanOverlap
          ? Promise.all([lanes.record, lanes.seats]).then(() => undefined)
          : lanes[lane];
      lanes[lane] = after.then(exec);
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

    // A conservation refusal is an authoritative settlement fault.  Keep the
    // table connected but parked; no history, rake, BBJ, add-on, elimination
    // wake or unlock may run for a hand whose accepted stacks do not exist.
    if (!tournamentHandConserved) {
      this.setLoopPhase('settlement_fault_conservation');
      while (this.running) await this.sleep(1_000);
      return;
    }

    // ─── ROUND 38 + 43 FIX: REORDERED — hand_history FIRST, then rake/BBJ ───
    // Round 38: rake_records.hand_id needed the v_handHistoryId.
    // Round 43: club_wallet_transactions.related_id (rake_in audit row) also
    // needs the hand UUID to link the audit ledger to the source hand. So
    // logHandHistory must precede logRakeCollection / logBBJCollection.
    /* ─── THE HAND'S IDENTITY IS DECIDED HERE, NOT BY THE INSERT (2026-09-07) ──
       `v_handHistoryId` below still means what it always meant: the row is IN
       the database. It is null while the hand is only in the retry queue, and
       the three things that need the row to exist - the `hand_history_saved`
       broadcast, the award-unit ledger, the integrity feed - keep reading it.

       `v_handId` is a different question: WHICH hand is this. The money path
       needs that answer before the row exists, and until today it did not have
       one. `atomic_distribute_rake` was called with `p_hand_id => NULL` on
       every hand whose insert had not come back yet, and a null there costs
       three separate things (measured on production 2026-09-07, 24 hours):

         - 173 cash hands banked their rake with ZERO `rake_attributions`
           rows, because that ledger keys on hand_id. Nobody at those tables
           earned anything from the hand - no VIP points, no agent or
           super-agent commission, no rakeback basis, horse or human alike
           (CLAUDE.md 10.5);
         - `uq_rake_records_hand_id` is UNIQUE ... WHERE hand_id IS NOT NULL,
           so it deduped nothing and an in-line retry could book the club
           twice (36 hands carried two or three copies in seven days);
         - the 15-minute re-drive and the hourly repair both ask "does any
           rake_records row name this hand?", were told no, and banked it
           again. 384 hands between 2026-09-02 and 2026-09-07: 719.49 chips of
           rake and 93.14 of BBJ drop that no pot ever paid.

       Minting the uuid here removes the null instead of compensating for it
       (CLAUDE.md 10.12). `hand_history.id` has no incoming foreign key from
       `rake_records`, `rake_attributions` or `bbj_contributions`, so the
       booking may name the hand before the row lands - and the row, whenever
       it lands, lands under exactly this id. */
    const v_handId = randomUUID();
    // A response-body timeout may replay the exact RPC. Time is part of the
    // accepted-hand payload hash, so freeze it once; recomputing Date.now()
    // on retry turns a committed hand into a deterministic payload conflict.
    const acceptedHandEndedAt = Date.now();
    const acceptedHandStartedAt = snap.startedAt || acceptedHandEndedAt;
    let v_handHistoryId: string | null = null;
    let authoritativeCommitSucceeded = false;
    const settlementLeaseAuthority = this.getEngineLeaseAuthority();
    const durablePostCommitObligations = settlementLeaseAuthority?.verified === true;
    await runStep('hand_history', true, async () => {
      if (this.tableInfo) {
        const tableInfo = this.tableInfo;
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

        /* A HORSE SPEAKS AT THE TABLE, THE SAME WAY A PLAYER DOES.
           Measured 2026-09-08: `table_chat` held 6 messages ever, all from one
           human, and across 1,000 horses and 1,271 occupied seats a horse had
           never sent one. Chat is a feature every human seat has, so silence
           was an exclusion (10.5, and Dan's rebuy-pause ruling: "IF YOU DIDN'T
           GIVE THEM THE SAME EXACT FEATURES AND FUNCTIONALITY, PEOPLE WOULD
           NOTICE"). The module owns every gate - odds, per-horse chattiness,
           cooldowns, the mute check a human gets, and the typing delay - so
           this call site only says WHAT JUST HAPPENED. It is deliberately not
           awaited: chat is the least important thing at a table and must never
           hold up a pot. */
        try {
          const bigBlind = Number(this.tableInfo?.big_blind) || 0;
          const bigWin = bigBlind > 0 ? bigBlind * 25 : Infinity;
          const wonBy = new Map<string, number>();
          for (const w of snap.winners) {
            wonBy.set(w.userId, (wonBy.get(w.userId) ?? 0) + Number(w.amount || 0));
          }
          const wentToShowdown = (snap.showdownResults?.length ?? 0) > 1;
          for (const p of players) {
            if (!p.is_horse) continue;
            const won = wonBy.get(p.user_id) ?? 0;
            const lost = !won && (snap.contributions?.get?.(p.user_id) ?? 0) > 0;
            const moment =
              won >= bigWin
                ? 'won_big'
                : lost && (snap.contributions?.get?.(p.user_id) ?? 0) >= bigWin
                  ? 'lost_big'
                  : wentToShowdown
                    ? 'showdown'
                    : null;
            if (!moment) continue;
            void maybeSpeak({ tableId: this.tableId, userId: p.user_id, moment });
          }
        } catch (err) {
          reportError(err, 'ServerTableEngine.horse_table_talk');
        }

        const dailyMissionEvents = buildDailyMissionHandEvents({
          dealtPlayerIds: snap.holeCards.keys(),
          roster: players.map((player) => ({
            userId: player.user_id,
            isHorse: player.is_horse,
          })),
          winners: snap.winners,
          showdownResults: snap.showdownResults,
          pots: snap.pots,
          perPotAwards: snap.perPotAwards,
        });

        /* THE BOMB BREAKDOWN TRAVELS WITH THE HAND (2026-09-06).
           These used to be written after the hand row, unawaited, so the
           breakdown could be the half that did not land - 3 of 125 bomb pots
           in one measured hour had no award units at all. Handed to
           logHandHistory they commit in the same transaction as the row they
           describe, through fn_ca_insert_hand_with_awards, in the same single
           request the hot path always cost. */
        const bombAwardUnits =
          snap.bombPot && snap.perPotAwards.length > 0
            ? snap.perPotAwards.map((a) => ({
                pot_index: a.potIndex,
                board: a.board ?? 1,
                side: a.low ? 'low' : 'high',
                user_id: a.userId,
                amount: a.amount,
                hand_name: a.hand?.name ?? null,
              }))
            : snap.bombPot && (snap.winners?.length ?? 0) > 0
              ? /* THE ROW MUST STILL COMMIT (2026-09-06). Since 20260906143315
                   the database refuses a bomb hand that distributed chips and
                   carries no award units. A bomb hand that produced winners
                   but an empty per-pot award array (the 'bomb_award_units_
                   empty' defect reported below) would therefore be refused
                   twenty times by the retry queue and lost - hand, rake link,
                   facts and all - which is worse than the missing breakdown
                   the guard exists to prevent. The winners list IS the money
                   that left the pot: on 966 of 966 bomb hands measured over
                   six hours its amounts summed to the distributable pot to the
                   cent. So the breakdown is derived from it, one unit per
                   winner, and the defect is still reported. */
                snap.winners.map((w) => ({
                  pot_index: w.potIndex ?? 0,
                  board: 1,
                  side: 'high',
                  user_id: w.userId,
                  amount: w.amount,
                  hand_name: w.hand?.name ?? null,
                }))
              : undefined;

        const leaseAuthority = settlementLeaseAuthority;
        const contributionRecord = Object.fromEntries(snap.contributions.entries());
        const returnedUncalledRecord = Object.fromEntries(snap.returnedUncalled.entries());
        const insuranceRecords =
          !this.isTournamentTable() && tableInfo.club_id
            ? snap.insuranceSettlements.map((settlement) => ({
                club_id: tableInfo.club_id,
                player_id: settlement.playerId,
                equity_percent: settlement.equity,
                premium:
                  settlement.kind === 'ev_cashout'
                    ? (snap.cashoutRedirects.get(settlement.playerId) ?? 0)
                    : settlement.premium,
                insured_amount: settlement.insuredAmount,
                payout: settlement.payout,
                player_won: !settlement.won,
                kind: settlement.kind,
              }))
            : [];
        const acceptedPostCommitFacts = durablePostCommitObligations
          ? {
              contributions: contributionRecord,
              returned_uncalled: returnedUncalledRecord,
              insurance: insuranceRecords,
            }
          : undefined;
        const postCommitObligations = durablePostCommitObligations
          ? {
              version: 1 as const,
              time_banks: players.map((player) => ({
                user_id: player.user_id,
                uses_remaining: this.timeBankEngine.getUsesRemaining(this.tableId, player.user_id),
                seconds_remaining: this.timeBankEngine.getRemainingSeconds(
                  this.tableId,
                  player.user_id
                ),
              })),
              rake:
                !this.isTournamentTable() && snap.rake > 0 && tableInfo.club_id
                  ? {
                      club_id: tableInfo.club_id,
                      amount: snap.rake,
                      bbj: snap.bbjFee,
                      pot: snap.potSize,
                      num_players: snap.contributions.size,
                      contributions: contributionRecord,
                      returned_uncalled: returnedUncalledRecord,
                      tournament_id: tableInfo.tournament_id || null,
                      method: 'WEIGHTED_CONTRIBUTED',
                    }
                  : null,
              bbj_contribution:
                !this.isTournamentTable() && snap.bbjFee > 0 && tableInfo.club_id
                  ? {
                      club_id: tableInfo.club_id,
                      amount: snap.bbjFee,
                      big_blind: tableInfo.big_blind,
                    }
                  : null,
              promo_playthrough:
                !this.isTournamentTable() && tableInfo.club_id
                  ? [...snap.contributions.entries()]
                      .filter(([uid, amount]) => Boolean(uid) && amount > 0)
                      .map(([uid, amount]) => ({
                        club_id: tableInfo.club_id,
                        user_id: uid,
                        wagered: amount,
                      }))
                  : [],
              insurance: insuranceRecords,
              pending_addons: !this.isTournamentTable()
                ? { enabled: true as const, max_buy_in: this.getMaxBuyIn() }
                : null,
            }
          : undefined;
        const commitAuthoritativeHand = () =>
          logHandHistory({
            tableId: this.tableId,
            handId: v_handId,
            bombAwardUnits,
            nitGame: tableInfo.nit_game === true,
            // THE FLOOR TRAVELS WITH THE HAND (2026-09-06). A horse at a
            // floored table is REQUIRED to play above it (10.5, vpipFloorMul),
            // so its VPIP there cannot be judged against the winning-player
            // band - see HorsePlayStats and fn_horse_frequency_leaks.
            vpipFloor: this.vpipFloor(),
            tournamentId: tableInfo.tournament_id || undefined,
            handNumber: snap.handNumber,
            // VARIANT OVERRIDE 2026-08-28 (spec §10.1/§20): the variant this
            // hand was DEALT as - plo4 on a PLO4 bomb hand at an NLH table.
            // Falling back to the table label only when the capture is absent.
            gameVariant: snap.variant || tableInfo.game_variant || 'nlh',
            smallBlind: tableInfo.small_blind,
            bigBlind: tableInfo.big_blind,
            potSize: snap.potSize,
            rakeAmount: snap.rake,
            bbjAmount: snap.bbjFee,
            communityCards: snap.communityCards,
            communityCards2: snap.communityCards2,
            // TRIPLE-BOARD BOMB POT 2026-08-27: board 3 + the frozen bomb facts
            // (trigger reason, ante, board count - spec §20).
            communityCards3: snap.communityCards3,
            bombPot: snap.bombPot,
            // COMPLETENESS PASS 2026-08-26: RIT boards 2..N, first-class. The
            // rit_board_N pseudo-actions in `actions` stay for old readers.
            ritBoards: snap.ritExtraBoards,
            startedAt: acceptedHandStartedAt,
            endedAt: acceptedHandEndedAt,
            winners: snap.winners,
            // Per-board winners for any multi-board hand; NULL otherwise (see
            // handHistory.ts). This is the record that says which run went to
            // whom, with what - `winners` is only the paid totals.
            winnersByBoard: snap.winnersByBoard,
            // POT-LEVEL SETTLEMENT (Dan section 29). Captured at WINNERS, when
            // the breakdown still exists. `winners` already carry `potIndex`;
            // this is the other half of that pair, and without it the number is
            // an index into an array nobody stored. Together they let the
            // elimination sweep credit a knockout to the winner(s) of the pot
            // that held the busted player's last chips.
            pots: snap.pots,
            /* THE ROSTER IS THE RLS KEY (2026-09-04). hand_history is readable by
             `players @> [{userId}]`, so a hand whose roster is missing a
             participant is a hand that participant can never open, and one
             with an empty roster is invisible to everyone in it. The roster
             here is the dealing loop's array; if it disagrees with who was
             dealt cards or who was paid, the hand was still played - write
             the union, and say so loudly, rather than lose it. */
            players: (() => {
              const roster = playersForRecord.map((p) => ({
                userId: p.user_id,
                username: p.username,
                seat: p.seat_number,
                stack: p.stack,
                cards: [] as string[],
              }));
              const seen = new Set(roster.map((r) => r.userId));
              const seatOf = (uid: string): number => {
                const sd = snap.showdownResults.find((r) => r.userId === uid);
                if (sd && typeof sd.seat === 'number') return sd.seat;
                const act = snap.actions.find(
                  (a) => a.userId === uid && typeof a.seat === 'number'
                );
                return act ? act.seat : 0;
              };
              const missing = [
                ...snap.holeCards.keys(),
                ...snap.winners.map((w) => w.userId),
              ].filter((uid, i, arr) => uid && !seen.has(uid) && arr.indexOf(uid) === i);
              for (const uid of missing) {
                seen.add(uid);
                roster.push({
                  userId: uid,
                  username: 'Player',
                  seat: seatOf(uid),
                  stack: 0,
                  cards: [],
                });
              }
              if (missing.length > 0 || roster.length === 0) {
                console.error(
                  `[hand_history] roster disagreed with the hand: hand=${snap.handNumber} table=${this.tableId} rosterLen=${players.length} added=${missing.length}`
                );
              }
              return roster;
            })(),
            actions: snap.actions,
            // STATS FACT LAYER 2026-08-21: engine-memory values the write used to
            // discard. Rationale in services/supabase/handFacts.ts.
            clubId: tableInfo.club_id,
            contributions: snap.contributions,
            holeCardsAll: snap.holeCards,
            roster: playersForRecord.map((p) => ({ userId: p.user_id, isHorse: p.is_horse })),
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
            atomicCommit: {
              stacks: playersForRecord.map((p) => ({
                user_id: p.user_id,
                stack: p.stack,
                stack_before: snap.dealtStacks.get(p.user_id) ?? p.stack,
              })),
              rake: this.isTournamentTable() ? 0 : snap.rake,
              bbj: this.isTournamentTable() ? 0 : snap.bbjFee,
              inflow: snap.insuranceNet,
              ...(leaseAuthority?.verified
                ? {
                    leaseInstanceId: INSTANCE_ID,
                    leaseGeneration: leaseAuthority.generation,
                    postCommitObligations,
                    acceptedPostCommitFacts,
                  }
                : {}),
              assertLeaseAuthority: () => {
                if (!this.hasCurrentEngineLeaseAuthority()) {
                  throw new Error('atomic hand commit refused (lease_proof_expired)');
                }
              },
            },
          });
        let result: Awaited<ReturnType<typeof commitAuthoritativeHand>>;
        try {
          if (!this.hasCurrentEngineLeaseAuthority()) {
            throw new Error('atomic hand commit refused (lease_proof_expired)');
          }
          result = await commitAuthoritativeHand();
          if (!result.settlementCommitted || !result.handId) {
            throw new Error('atomic hand commit refused (missing_commit_receipt)');
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const semantic = message.includes('atomic hand commit refused');
          const alertCode = semantic
            ? 'ServerTableEngine.authoritative_hand_semantic_refusal'
            : 'ServerTableEngine.authoritative_hand_unreachable';
          reportError(
            err,
            semantic
              ? 'ServerTableEngine.authoritative_hand_semantic_refusal'
              : 'ServerTableEngine.authoritative_hand_transport_failure',
            { tableId: this.tableId, handNumber: snap.handNumber }
          );

          this.setLoopPhase(semantic ? 'settlement_fault_semantic' : 'settlement_fault_transport');
          // logHandHistory already performs the bounded identical-response-loss
          // replay. Exhausting it (or receiving a deterministic refusal) makes
          // this generation terminal; resolving normally here would let the
          // loop deal from seats for a hand the database never accepted.
          this.killForRestart(
            semantic ? 'authoritative_hand_semantic_refusal' : 'authoritative_hand_unreachable'
          );
          try {
            await raiseFinancialAlert(
              'critical',
              alertCode,
              semantic
                ? `Table ${this.tableId} hand #${snap.handNumber} was refused by the atomic settlement contract; this engine generation was terminated before every downstream money step`
                : `Table ${this.tableId} hand #${snap.handNumber} exhausted the bounded identical settlement replay; this engine generation was terminated with the same hand behind its causal barrier`,
              { table_id: this.tableId, hand_number: snap.handNumber, error: message }
            );
          } catch (alertError) {
            reportError(alertError, `${alertCode}.alert_failed`, {
              tableId: this.tableId,
              handNumber: snap.handNumber,
            });
          }
          throw err;
        }
        v_handHistoryId = result.handId;
        authoritativeCommitSucceeded = true;

        // The accepted transaction and its durable obligation envelope remain
        // valid even if the response crossed our proof deadline. Everything
        // below is reflection or a new decision and belongs to the successor.
        if (!this.lifecycleCanMutate()) return;

        // Protocol-2 hands carry time banks in the immutable post-commit
        // envelope. The compatibility path retains the old direct write only
        // for isolated harnesses and a rolling protocol-1 process.
        if (!durablePostCommitObligations) {
          await persistTimeBanks(
            this.tableId,
            players.map((p) => ({
              user_id: p.user_id,
              ...snap.timeBanks.get(p.user_id),
            }))
          );
          if (!this.lifecycleCanMutate()) return;
        }

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
          /* LAST RESORT ONLY (2026-09-06). The units are now written inside
             the hand's own transaction above, so by the time we get here they
             already exist and this upsert conflicts and does nothing. It is
             kept for exactly one case: a hand row that reached the database
             through the background retry queue, which replays a stored row and
             has no units to carry. Anything it actually writes is therefore a
             signal that the atomic path did not run - not routine traffic. */
          if (!result.wroteAwardUnits) {
            void writeAwardUnits().catch((err: unknown) =>
              reportError(err, 'ServerTableEngine.bomb_award_ledger_write_threw')
            );
          }
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
        if (v_handHistoryId && this.lifecycleCanMutate()) {
          this.hub?.emitEvent(this.tableId, {
            type: 'hand_history_saved',
            table_id: this.tableId,
            hand_number: snap.handNumber,
            hand_id: v_handHistoryId,
            timestamp: Date.now(),
          });
        }

        // ── ADDITIVE anti-cheat feed (#5): observe-only, fire-and-forget, flag-gated (default OFF) ──
        if (this.integrityFeedEnabled && this.lifecycleCanMutate()) {
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
              players: playersForRecord.map((pp) => ({
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

    // `runStep` queues named lane work and returns immediately. The hand is
    // the authority for every later money and seat mutation, so prove its
    // exact atomic acceptance before those operations may even be queued.
    await lanes.record;

    // runStep reports the failure, but it must not turn a failed authoritative
    // commit into permission to run later money mutations or unlock the table.
    if (!authoritativeCommitSucceeded) {
      this.setLoopPhase('settlement_fault_uncommitted');
      this.killForRestart('authoritative_hand_commit_not_proved');
      throw new Error(
        `authoritative hand commit was not proved for ${this.tableId}#${snap.handNumber}`
      );
    }

    /* The exact settlement committed an immutable post-commit envelope before
       returning. Any process may finish that already-authorized work, including
       a predecessor whose local proof expires while this request is in flight;
       only the row-locked database function mutates durable state. Process-local
       reflection remains fenced below. The projection worker is the crash and
       lost-response successor because its outbox DELETE cannot commit until the
       same envelope reports complete. */
    let postCommitStateCanReflect = this.lifecycleCanMutate();
    if (durablePostCommitObligations && v_handHistoryId) {
      let obligationsApplied = false;
      let lastObligationError: unknown = null;
      let attempt = 0;
      this.setLoopPhase('settlement_post_commit_obligations');
      while (!obligationsApplied && this.lifecycleCanMutate()) {
        attempt++;
        try {
          const outcome = await processHandPostCommitObligations(v_handHistoryId);
          if (outcome.ok !== true) {
            throw new Error(`post-commit obligations refused (${outcome.reason ?? 'unknown'})`);
          }
          obligationsApplied = true;
        } catch (err) {
          lastObligationError = err;
          if (attempt === 1 || attempt % 10 === 0) {
            reportError(err, 'ServerTableEngine.post_commit_obligations_pending', {
              tableId: this.tableId,
              handNumber: snap.handNumber,
              handId: v_handHistoryId,
              attempt,
            });
          }
          if (attempt === 1) {
            void raiseFinancialAlert(
              'critical',
              'ServerTableEngine.post_commit_obligations_pending',
              `Hand ${this.tableId}#${snap.handNumber} committed, but its durable post-commit envelope remains behind the causal settlement barrier`,
              {
                table_id: this.tableId,
                hand_number: snap.handNumber,
                hand_id: v_handHistoryId,
                error: err instanceof Error ? err.message : String(err),
              }
            ).catch((alertError) =>
              reportError(
                alertError,
                'ServerTableEngine.post_commit_obligations_pending.alert_failed',
                { tableId: this.tableId, handNumber: snap.handNumber }
              )
            );
          }
          if (this.lifecycleCanMutate()) {
            this.markProgress();
            await this.sleep(Math.min(150 * 2 ** Math.min(attempt - 1, 5), 5_000));
          }
        }
      }
      postCommitStateCanReflect = this.lifecycleCanMutate();

      if (!obligationsApplied) {
        // The exact outbox row remains authoritative. This predecessor lost
        // its lifecycle proof; the event-driven successor may finish the DB
        // envelope, but this process must reflect or schedule nothing else.
        if (lastObligationError) {
          reportError(lastObligationError, 'ServerTableEngine.post_commit_handoff', {
            tableId: this.tableId,
            handNumber: snap.handNumber,
            handId: v_handHistoryId,
          });
        }
        return;
      } else if (postCommitStateCanReflect) {
        /* Pending add-ons are applied inside the obligation transaction. Read
           the resulting stacks rather than incrementing engine memory from a
           response: a concurrent worker may have completed the row first, and
           its replay receipt intentionally does not claim which process did it. */
        const { data: persistedSeats, error: persistedSeatError } = await supabase
          .from('table_seats')
          .select('user_id,stack')
          .eq('table_id', this.tableId)
          .is('left_at', null);
        if (!this.lifecycleCanMutate()) {
          postCommitStateCanReflect = false;
        } else if (persistedSeatError) {
          reportError(persistedSeatError, 'ServerTableEngine.post_commit_stack_refresh_failed', {
            tableId: this.tableId,
            handNumber: snap.handNumber,
          });
          this.killForRestart('post_commit_stack_refresh_failed');
          throw persistedSeatError;
        } else {
          const stackByUser = new Map(
            (persistedSeats ?? []).map((seat) => [seat.user_id as string, Number(seat.stack)])
          );
          for (const player of players) {
            const persisted = stackByUser.get(player.user_id);
            if (persisted !== undefined && Number.isFinite(persisted)) player.stack = persisted;
          }
          /* The envelope resolved the frozen add-ons silently. Say what it
             did (the add_on_applied bubble, the private add_on_adjusted
             frame) and rebuild the cap cache - see announceEnvelopeResolvedAddOns. */
          await this.announceEnvelopeResolvedAddOns(v_handHistoryId, players);
          if (!this.lifecycleCanMutate()) postCommitStateCanReflect = false;
        }
      }
    }

    if (!postCommitStateCanReflect || !this.lifecycleCanMutate()) return;

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
      if (
        !durablePostCommitObligations &&
        !this.isTournamentTable() &&
        snap.rake > 0 &&
        this.tableInfo?.club_id
      ) {
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
          if (!this.lifecycleCanMutate()) return;
          const { error: rdErr } = await supabase.rpc('atomic_distribute_rake', {
            p_table_id: this.tableId,
            p_club_id: this.tableInfo.club_id,
            // NEVER v_handHistoryId, and never null: see the note where
            // v_handId is minted. A booking that cannot name its hand is a
            // booking nobody earns from and everybody books again.
            p_hand_id: v_handId,
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
          if (!this.lifecycleCanMutate()) return;
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
              handId: v_handId,
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
            if (!this.lifecycleCanMutate()) return;
          } else {
            await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
            if (!this.lifecycleCanMutate()) return;
          }
        }
      }
    });
    if (!this.lifecycleCanMutate()) return;

    // SETTLEMENT STEP 8c: Log BBJ contribution
    // Round 44: pass the hand id so bbj_contributions.hand_id links to
    // hand_history (consistent with rake_records and club_wallet_transactions).
    //
    // 2026-09-07: that id is now v_handId, minted at settlement, rather than
    // v_handHistoryId, which is null until the row comes back. THIS IS THE
    // ROOT OF `FeeReconciler.bbj_unlinkable`. A drop banked while the hand
    // was still in the retry queue wrote `hand_id => NULL`, and the alert that
    // then fired said a contribution could not be tied to a hand - which was
    // true, and was never the contribution's fault. Same hand, same id,
    // whenever its row arrives.
    await runStep('bbj_contribution', true, async () => {
      if (
        !durablePostCommitObligations &&
        !this.isTournamentTable() &&
        snap.bbjFee > 0 &&
        this.tableInfo?.club_id
      ) {
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
          v_handId
        );
        if (!this.lifecycleCanMutate()) return;
        if (!bbjBanked) {
          await queueUnbankedFee('bbj_contribution', {
            tableId: this.tableId,
            clubId: this.tableInfo.club_id,
            handId: v_handId,
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
          if (!this.lifecycleCanMutate()) return;
        }
      }
    });
    if (!this.lifecycleCanMutate()) return;

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
      if (!durablePostCommitObligations && !this.isTournamentTable() && this.tableInfo?.club_id) {
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
    if (!this.lifecycleCanMutate()) return;

    // 3b. Bible V8 §4.19: Log insurance settlements (settled in HAND_COMPLETE handler)
    // Insurance premiums → union bank (or club bank for standalone)
    // Insurance payouts → from union bank (or club bank) to player
    await runStep('insurance_ledger', true, async () => {
      if (
        !durablePostCommitObligations &&
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
          if (!this.lifecycleCanMutate()) return;
        }
      }
    });
    if (!this.lifecycleCanMutate()) return;

    /* 3b2. THE MINI JACKPOT (BBJ phase 6 of 6). Runs BEFORE the main payout
       step so the ordering in the code reads the way the money does: a hand
       reaches at most one of them, because settlement only detects a mini when
       detectBBJHit already refused, and fn_bbj_mini_payout shares the main's
       (pool, table, hand) idempotency key on top of that. Money-critical, so a
       throw here raises a durable CRITICAL alert like every other money step -
       but a REFUSAL (reserve at its floor, tier disabled) is data, not a
       failure, and is logged rather than alarmed. */
    await runStep('bbj_mini_payout', true, async () => {
      if (
        this.isTournamentTable() ||
        !this.tableInfo?.club_id ||
        !snap.miniBbjHit?.hit ||
        !snap.miniBbjTierId
      ) {
        return;
      }
      const mini = snap.miniBbjHit;
      if (!this.lifecycleCanMutate()) return;
      const outcome = await processMiniBBJPayout({
        tableId: this.tableId,
        clubId: this.tableInfo.club_id,
        handNumber: snap.handNumber,
        tierId: snap.miniBbjTierId,
        loserUserId: mini.loserUserId!,
        winnerUserId: mini.winnerUserId!,
        dealtInPlayerIds: mini.dealtInPlayerIds || [],
        seatedUserIds: players.map((p) => p.user_id),
        metadata: {
          rule: (mini as { miniRule?: string }).miniRule,
          variant: mini.variant,
          loser_hand: mini.loserHand?.name,
          winner_hand: mini.winnerHand?.name,
        },
      });
      if (!this.lifecycleCanMutate()) return;

      if (outcome.status === 'queued') {
        EngineMetrics.bbjPayoutsQueuedTotal.inc(1, { table_id: this.tableId });
        this.hub?.emitEvent(this.tableId, {
          type: 'bbj_payout_pending',
          kind: 'mini',
          table_id: this.tableId,
          hand_number: snap.handNumber,
          emitted_at: Date.now(),
          replay_until: Date.now() + 60_000,
          loser: { userId: mini.loserUserId },
          winner: { userId: mini.winnerUserId },
          tablePlayerIds: [...new Set(mini.dealtInPlayerIds || [])].filter(
            (id) => id !== mini.loserUserId && id !== mini.winnerUserId
          ),
        });
      }

      if (outcome.status !== 'paid') {
        console.warn(
          `[ServerTableEngine:${this.tableId}] mini jackpot not paid for hand #${snap.handNumber}: ${outcome.reason}`
        );
        return;
      }

      console.log(
        `[ServerTableEngine:${this.tableId}] mini jackpot paid ${outcome.total} ` +
          `(loser ${outcome.loser}, winner ${outcome.winner}, ${outcome.perPlayer} each at the table)`
      );

      /* The seats are credited by the RPC in the same transaction that debited
         the reserve, so engine memory has to catch up or the next state push
         would overwrite a real credit with a stale stack. Same pattern the
         main payout uses. */
      const bump = (userId: string | undefined, amount: number): void => {
        if (!userId || amount <= 0) return;
        const seat = players.find((pl) => pl.user_id === userId);
        if (seat) seat.stack = Number(seat.stack || 0) + amount;
      };
      bump(mini.loserUserId, outcome.loser);
      bump(mini.winnerUserId, outcome.winner);
      for (const uid of new Set(mini.dealtInPlayerIds || [])) {
        if (uid !== mini.loserUserId && uid !== mini.winnerUserId) bump(uid, outcome.perPlayer);
      }

      const tableOnlyMini = [...new Set(mini.dealtInPlayerIds || [])].filter(
        (id) => id !== mini.loserUserId && id !== mini.winnerUserId
      );
      this.hub?.emitEvent(this.tableId, {
        type: 'bbj_payout_complete',
        kind: 'mini',
        table_id: this.tableId,
        hand_number: snap.handNumber,
        emitted_at: Date.now(),
        replay_until: Date.now() + 60_000,
        /* THE MAIN JACKPOT'S FIELD NAMES, EXACTLY. The first cut of this used
           `total` / `amount` / `perPlayer` and the celebration would have read
           `totalPayout`, `share` and `perPlayerShare` off it - every number
           zero, on the one screen the whole feature exists to produce. One
           event shape, one reader; `kind` is the only thing that differs, and
           an older client that reads no `kind` still shows a celebration
           rather than nothing. */
        totalPayout: outcome.total,
        loser: { userId: mini.loserUserId, share: outcome.loser },
        winner: { userId: mini.winnerUserId, share: outcome.winner },
        tableShare:
          Math.round((outcome.perPlayer * tableOnlyMini.length + Number.EPSILON) * 100) / 100,
        perPlayerShare: outcome.perPlayer,
        tablePlayerIds: tableOnlyMini,
        updatedStacks: players.map((pl) => ({ userId: pl.user_id, stack: pl.stack })),
      });
    });
    if (!this.lifecycleCanMutate()) return;

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
        if (!this.lifecycleCanMutate()) return;
        const outcome = await processBBJPayout({
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
        if (!this.lifecycleCanMutate()) return;

        /* THE TABLE IS TOLD EVEN WHEN THE MONEY IS LATE (BBJ phase 2.2).
           A jackpot that cannot be paid this instant - the commonest cause
           being the :55 maintenance freeze, which refuses every money write
           for five minutes - used to produce SILENCE at the table: `bbj_hit`
           had already gone out, the celebration waits on
           `bbj_payout_complete`, and that never arrived. The players who had
           just taken and beaten a qualifying hand saw the hand end normally
           and nothing else, and the chips appeared minutes later with no
           explanation. The payout itself is safe (write-ahead claim + the
           reconciler), so this is only about telling them. */
        if (outcome.status === 'queued') {
          EngineMetrics.bbjPayoutsQueuedTotal.inc(1, { table_id: this.tableId });
          this.hub?.emitEvent(this.tableId, {
            type: 'bbj_payout_pending',
            table_id: this.tableId,
            hand_number: snap.handNumber,
            emitted_at: Date.now(),
            // Retained like every other jackpot beat, so a player whose socket
            // is between reconnects still learns the payout is coming.
            replay_until: Date.now() + 60_000,
            loser: { userId: bbjHit.loserUserId },
            winner: { userId: bbjHit.winnerUserId },
            tablePlayerIds: (bbjHit.dealtInPlayerIds || []).filter(
              (id) => id !== bbjHit.loserUserId && id !== bbjHit.winnerUserId
            ),
          });
          console.warn(
            `[ServerTableEngine:${this.tableId}] BBJ payout could not land now; queued and announced as pending`
          );
        }

        if (outcome.status === 'paid') {
          const result = outcome.result;
          EngineMetrics.bbjPayoutsPaidTotal.inc(1, { table_id: this.tableId });
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
          const tableOnlyPlayers = [...new Set(bbjHit.dealtInPlayerIds || [])].filter(
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

          /* NO SECOND STACK WRITE (chip standard 2026-09-04). bbj_atomic_payout_v2
             already credited every seated recipient's table_seats.stack
             durably (bbj_credit_one_recipient), and the shares were mirrored
             into memory just above. The "re-sync" that used to sit here wrote
             every seat ABSOLUTELY from memory with no hand number - the
             unchecked per-seat path - so anything else that had landed on a
             row meanwhile (a resolved add-on, a horse funding) was erased,
             and in delta mode it would have credited the shares twice. The
             database already holds the truth; there is nothing to write. */

          // Broadcast updated stacks + BBJ payout details so clients show the celebration
          this.hub?.emitEvent(this.tableId, {
            type: 'bbj_payout_complete',
            table_id: this.tableId,
            hand_number: snap.handNumber,
            /* The celebration's own trigger, so it carries the same stamp as
               bbj_hit above - see the note there for why a retained replay is
               otherwise indistinguishable from a live hit. */
            emitted_at: Date.now(),
            /* Retained for a reconnecting socket, same reason as bbj_hit. This
               is THE event the ten-second celebration hangs on; before phase 1
               a player reconnecting during the 1-3 s between the hand and the
               payout missed the biggest moment on the platform, permanently. */
            replay_until: Date.now() + 60_000,
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

          /* ── EVERY TABLE IN THE CLUB OR UNION HEARS IT (BBJ audit 2026-09-05) ──
             Dan: "everyone currently playing in the club or union get a pop up
             on screen." Until now the other tables learned of a hit only via
             a Supabase Realtime subscription on the pool row - a WAL stream
             measured a minute or more behind at peak (ClubHomePage, 2026-09-02)
             - and then the client refused anything older than 90 seconds as
             a replay (lib/bbjHitOnce). The announcement was racing its own
             freshness gate and could lose it, silently, at every other table.

             The engine has a socket to every one of those tables already.
             Fan the same identity (table_id + hand_number + emitted_at) out
             over it; the client de-duplicates against the Realtime path by
             that identity, so whichever arrives first announces and the other
             is dropped. The Realtime path stays as the fallback for a table
             this process does not host.

             Never a money step: after the payout has landed, wrapped so that
             nothing here can fail the settlement. */
          try {
            const siblingClubs = new Set(
              await resolveJackpotSiblingClubIds(this.tableInfo.club_id)
            );
            if (!this.lifecycleCanMutate()) return;
            const siblings = ServerTableEngineSettlement.liveCashTableIdsInClubs(
              siblingClubs,
              this.tableId
            );
            if (siblings.length > 0 && this.hub) {
              const badBeatHolder = players.find((p) => p.user_id === bbjHit.loserUserId);
              const announcement = {
                type: 'bbj_hit_global',
                table_id: this.tableId,
                table_name: this.tableInfo.name || 'a table',
                club_id: this.tableInfo.club_id,
                hand_number: snap.handNumber,
                emitted_at: Date.now(),
                // Retained so a sibling table's reconnecting socket still hears it.
                replay_until: Date.now() + 60_000,
                game_variant: this.tableInfo.game_variant,
                big_blind: this.tableInfo.big_blind,
                winner_user_id: bbjHit.loserUserId,
                winner_name: badBeatHolder?.username || 'A player',
                // What the bad-beat holder took home - the headline figure,
                // matching what the Realtime path reads (bad_beat_amount).
                amount: result.loserShare,
                total_payout: result.totalPayout,
                qualifying_hand_label: bbjHit.qualifyingHandLabel || '',
              };
              for (const siblingId of siblings) {
                this.hub.emitEvent(siblingId, announcement);
              }
              console.log(
                `[ServerTableEngine:${this.tableId}] BBJ announced to ${siblings.length} sibling table(s) across ${siblingClubs.size} club(s)`
              );
            }
          } catch (announceErr) {
            console.warn(
              `[ServerTableEngine:${this.tableId}] BBJ club-wide announcement failed (payout already landed):`,
              announceErr
            );
          }
        }
      }
    });
    if (!this.lifecycleCanMutate()) return;

    // Tournament chip mirroring is part of fn_ca_commit_hand_settlement.  A
    // separate post-commit mirror would reopen the split-brain window this
    // transaction removes.

    // TOURNAMENT ELIMINATION WAKE (2026-09-07): this is a scheduling hint,
    // never payout authority.  A zero in the final in-memory stack must wake
    // the owning manager even when one persistence mirror or the queued hand
    // write failed: Dealing may still durably vacate/zero that player, and no
    // later hand will contain them to provide another event.  The sweep itself
    // remains fail-closed on its exact accepted settlement/history/outbox
    // evidence and re-drives unresolved work.  Keep the callback synchronous
    // and fire-and-forget so tournament maintenance never extends settlement.
    const finalStacks = players.map((p) => ({
      user_id: p.user_id,
      stack: p.stack,
    }));
    if (
      this.lifecycleCanMutate() &&
      this.handCompleteCallback &&
      finalStacks.some((player) => Number(player.stack) <= 0)
    ) {
      try {
        this.handCompleteCallback(this.tableId, finalStacks);
      } catch (err) {
        reportError(err, 'ServerTableEngine.handCompleteCallback_error', {
          tableId: this.tableId,
          handNumber: snap.handNumber,
        });
      }
    }

    // SETTLEMENT STEP 8e: Process pending add-ons (queued during the hand).
    // Must run AFTER pot distribution + BBJ payouts so we know each player's
    // final stack. Add-ons are capped so stack + add-on <= max buy-in.
    // Any excess is refunded to the player's club wallet.
    await runStep('pending_addons', true, async () => {
      if (!durablePostCommitObligations && !this.isTournamentTable()) {
        await this.processPendingAddOns(players);
        if (!this.lifecycleCanMutate()) return;
      }
    });
    if (!this.lifecycleCanMutate()) return;

    // 5. Auto-rebuy busted horses (cash games only)
    await runStep('horse_rebuys', false, async () => {
      if (!this.isTournamentTable() && !isMaintenanceFrozen()) {
        const bustHorses = players.filter((p) => p.is_horse && p.stack === 0);
        for (const horse of bustHorses) {
          if (isMaintenanceFrozen() || !this.lifecycleCanMutate()) return;
          const currentRebuys = this.horseRebuys.get(horse.user_id) || 0;

          /**
           * Stop-loss. This was a hard-coded `>= 2` for every horse alike;
           * it is now the temperament's own figure, and `standard` - six in
           * ten of the fleet - still stops at exactly the same place, so this
           * is a spread around today's behaviour rather than a move away from
           * it. A nit gives up a buy-in earlier, a gambler one later.
           */
          if (atRebuyStopLoss(horse.user_id, currentRebuys)) {
            /* One door out for a busted seat (releaseBustedSeat, 10.5): the
               money path, then `seat_left`, then the trackers. This branch
               used to call markSeatAsLeft by hand and emit nothing, so a
               busted horse's chair cleared on clients only when a snapshot
               happened to be diffed - a tell against the human exit. */
            const released = await this.releaseBustedSeat(horse, 'busted_stop_loss');
            if (!this.lifecycleCanMutate()) return;
            if (!released) continue;
            this.horseRebuys.delete(horse.user_id);
            console.log(
              `[ServerTableEngine:${this.tableId}] Stop-Loss: Horse ${horse.username} reached the stop-loss and has been removed.`
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
          if (isMaintenanceFrozen() || !this.lifecycleCanMutate()) return;
          const funding =
            rebuyAmount > 0
              ? await autoRebuyHorse(
                  this.tableId,
                  horse.user_id,
                  rebuyAmount,
                  this.tableInfo?.club_id || '',
                  snap.handNumber
                )
              : { status: 'declined' as const };
          if (!this.lifecycleCanMutate()) return;
          // An unreadable response may follow a committed transfer. Preserve the seat.
          if (funding.status === 'unknown') return;
          if (funding.status === 'funded') {
            horse.stack = funding.stack;
            this.horseRebuys.set(horse.user_id, currentRebuys + 1);
            console.log(
              `[ServerTableEngine:${this.tableId}] Auto-rebuy: ${horse.username} -> ${rebuyAmount} chips (Rebuy #${currentRebuys + 1})`
            );
          } else {
            const released = await this.releaseBustedSeat(horse, 'busted_unfunded');
            if (!this.lifecycleCanMutate()) return;
            if (!released) continue;
            this.horseRebuys.delete(horse.user_id);
            console.log(
              `[ServerTableEngine:${this.tableId}] Horse ${horse.username} left - insufficient funds`
            );
          }
        }
      }
    });
    if (!this.lifecycleCanMutate()) return;

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
        if (!this.lifecycleCanMutate()) return;
      }
    });
    if (!this.lifecycleCanMutate()) return;

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
          if (!this.lifecycleCanMutate()) return;
          const exit = await atomicCashoutVoluntary(horse.user_id, this.tableId, horse.seat_number);
          if (!this.lifecycleCanMutate()) return;
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
    if (!this.lifecycleCanMutate()) return;

    // 5.9 FIX 143: Bible V8 §7.12 — Apply deferred sit-outs now that the hand is over
    await runStep('deferred_sitouts', false, async () => {
      if (this.lifecycleCanMutate() && this.pendingSitOut.size > 0) {
        for (const userId of this.pendingSitOut) {
          this.disconnectEngine.sitOut(this.tableId, userId, 'voluntary');
          console.log(`[ServerTableEngine:${this.tableId}] Deferred sit-out applied: ${userId}`);
        }
        this.pendingSitOut.clear();
      }
    });
    if (!this.lifecycleCanMutate()) return;

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
          (lockedUserId, stayRemainingMs) => {
            if (this.lifecycleCanMutate()) {
              this.onLeaveRefusedAtSettlement(lockedUserId, stayRemainingMs);
            }
          },
          this.forcedLeaves
        );
        if (!this.lifecycleCanMutate()) return;
        for (const userId of cashedOutIds) {
          this.disconnectEngine.unregisterPlayer(this.tableId, userId);
          this.timeBankEngine.removePlayer(this.tableId, userId);
          this.straddleEngine.removePlayer(this.tableId, userId);
          this.preActionEngine.removePlayer(this.tableId, userId);
          this.forcedLeaves.delete(userId);
          this.leaveHeldByClock.delete(userId);
          this.chipContinuity.forget(userId);
        }
        // MUST-MOVE (Slice 2): planned moves land here, at the hand boundary,
        // after the leavers. A move is not a leave: no cash-out, no clock.
        // ANNOUNCED ONLY (2026-09-05): the deal told the player "Moving After
        // This Hand"; a move planned during the hand waits for the next deal
        // to be announced, so nobody is moved off a hand they were not told
        // about.
        await this.executePendingSeatMoves({ announcedOnly: true });
        if (!this.lifecycleCanMutate()) return;
      }
    });
    if (!this.lifecycleCanMutate()) return;

    // SETTLEMENT STEP 15: Unlock table — authoritative recount, ready for next hand
    await runStep('table_unlock', true, async () => {
      // Fresh authoritative recount, with no update request when the stored
      // summary already agrees. Unavailable reads stay unknown, never zero,
      // and a generation that loses lifecycle authority cannot repair or emit.
      const finalCount = await reconcileTableSeatCount(this.tableId, () =>
        this.lifecycleCanMutate()
      );
      if (!this.lifecycleCanMutate()) return;

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
    if (!this.lifecycleCanMutate()) return;

    // Both lanes must land before the barrier releases the next deal.
    await Promise.all([lanes.record, lanes.seats]);

    // Settlement pipeline complete - table unlocked for next hand.
    // A HAND ENDED (2026-09-05): leavers cashed out, announced moves landed,
    // the recount is written. The game's ClusterController tick is woken so a
    // must-move plan or a break decision follows this boundary, not the clock.
    this.wakeClusterGame('hand_complete');
  }
}
