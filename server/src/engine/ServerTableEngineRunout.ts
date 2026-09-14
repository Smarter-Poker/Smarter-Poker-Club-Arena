/**
 * ServerTableEngine, layer 4/8 — pineapple discards, all-in runouts, run-it-twice, insurance.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { HandController, scaleWinnerCentsForRake } from './HandController.js';
import { InsuranceEngine } from './InsuranceEngine.js';
import { getEquityPool } from './equity/EquityWorkerPool.js';
import * as EngineMetrics from '../observability/engineInstruments.js';
import { leaderOuts } from './InsuranceEquity.js';
import { logInsuranceOfferEvent } from '../services/supabase/insuranceOfferLog.js';
import {
  evaluateHand,
  evaluateOmahaHand,
  compareHands,
  determineWinners,
  describeHand,
} from './PokerEngine.js';
import { deckSizeFor, isOmahaVariant, isShortDeckVariant } from './VariantRules.js';
import type { Card, SeatPlayer, HandEvent, SeatedPlayer } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { HAND_COMPLETION } from '../config/handCompletionSpec.js';
import { ServerTableEngineTurns } from './ServerTableEngineTurns.js';
import type { EngineRecoveryEventClass } from './ServerTableEngineBase.js';
import { getLiveHorseDecisionWorker, HorseDecisionAbortedError } from './horseDecision/index.js';

export abstract class ServerTableEngineRunout extends ServerTableEngineTurns {
  /**
   * All-in run-out pacing (Dan 2026-08-19, item 16). Chosen so a player can
   * actually read a percentage change between cards without the table feeling
   * stalled: roughly the cadence of a live dealer pausing on each street.
   *
   * Instance fields, not statics, so a test can drive the ORDERING of the
   * run-out without also spending its real-world seconds.
   */
  /**
   * Dan 2026-08-20 (systematic sweep): this was 1000ms while the client's ALL
   * IN banner runs allInBannerSlam for 1800ms — so the first street started
   * dealing while "ALL IN" was still slamming in over the felt. Same bug class
   * as the turn bug: the moment was superseded before it finished.
   *
   * The banner fires on the first all_in_equity broadcast, which goes out with
   * this pause. 2000ms lets the banner complete AND leaves a beat to read the
   * starting equities before the first card lands.
   */
  protected allInFirstPauseMs = 2000;
  protected allInStreetPauseMs = 1400;
  protected allInPreShowdownPauseMs = 1200;

  /**
   * The reveal gate: how long a run-out street is given to actually appear
   * before its new equity is allowed to change. See
   * HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS for the full reasoning and where
   * the 1750ms comes from. Instance field, like its neighbours, so a test can
   * drive the ORDERING without spending the seconds.
   */
  protected allInStreetRevealMs = HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS;

  /**
   * Dan 2026-08-20: the settle beat between a player's action landing and the
   * next player going on the clock. Applied in the TURN_CHANGE handler, so it
   * paces EVERY action path — human, horse, pre-action, timeout, time-bank
   * expiry, disconnect auto-action — with no way for a caller to bypass it.
   *
   * 650ms > the 500ms cpSlideIn chip slide, so the wager is fully on the felt
   * and the action label is readable before the spotlight moves.
   *
   * Instance field, not a static, so tests can drive turn ORDER without
   * spending its real-world seconds.
   *
   * ── DAN 2026-09-07, REVERSING THE 2026-08-20 DECISION ──────────────────────
   * "THERE IS A FEW SECOND DELAY AFTER EACH PLAYER MAKES A DECISION ON EVERY
   * STREET, IT DOESN'T SNAP GO TO THE NEXT PLAYER."
   *
   * The 2026-08-20 reasoning above is sound about the ANIMATION and wrong about
   * the CLOCK. cpSlideIn is a client-side transition: it keeps running whether
   * or not the engine has already put the next player on the clock. Blocking
   * the engine for its duration does not make the chip more visible, it just
   * means nobody can act while it moves. Fast sites overlap the two, and that
   * overlap is the whole difference between "snappy" and "laggy".
   *
   * So the settle beat is gone. The chip still slides, the action label still
   * paints; the next seat is simply live while it happens.
   */
  protected actionSettleMs = 0;

  /** One cancellable ownership generation for every Pineapple worker batch. */
  private pineappleDecisionGeneration = 0;
  /** Humanlike-delay timers that have not submitted their worker job yet. */
  private readonly pineappleDecisionDelayTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Submitted jobs, keyed by seat so a human action can cancel its exact job. */
  private readonly pineappleDecisionAbortControllers = new Map<number, AbortController>();
  /** Deadline aborts for normal discard rounds; all-in jobs use the hand fence. */
  private readonly pineappleDecisionDeadlineTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();

  /**
   * Dan 2026-08-20: the beat a freshly dealt board gets before the first
   * postflop actor goes on the clock. HandController deals the street and
   * emits TURN_CHANGE in the same synchronous call, so without this the reveal
   * raced the next action.
   *
   * Sized for the worst case, the flop: it lands (ccFlopLand 300ms) and only
   * then fans open (ccFlopFanOpen 420ms, starting ~520ms in) — ~940ms of
   * animation — plus a beat to actually read the board.
   *
   * Dan 2026-09-07: same correction as actionSettleMs. The board reveal is a
   * client animation and does not need the engine to stand still for it; the
   * first postflop actor almost never acts inside the first half second
   * anyway. Kept non-zero — unlike an action, a street genuinely does need to
   * START appearing before someone can act on it — but cut to the landing beat
   * (300ms) plus a little, not the full fan-open-and-read.
   */
  protected streetSettleMs = 500;

  /**
   * Dan 2026-08-20: the beat between hands turning face up at showdown and the
   * pot shipping. completeHandInner() emits SHOWDOWN and WINNERS in the SAME
   * tick, so the reveal had zero airtime before the winner lit up and the pot
   * flew away. Covers cardShowdownFlip (350ms + 120ms second-card stagger) and
   * leaves time to read the hands. Applied only when 2+ hands actually reached
   * showdown; a fold-around win has nothing to reveal.
   */
  /**
   * Dan 2026-08-21 (item 11): "give all showdowns 3 FULL SECONDS for all cards
   * to be read by players before the pot ship animation and total size plays."
   * Raised 1600 -> 3000. This number and HAND_COMPLETION.SHOWDOWN_READ_BASE_MS
   * in config/handCompletionSpec.ts are the same beat seen from two sides: this
   * one delays the ship, that one makes the engine hold the table long enough
   * for the ship to finish. They must move together.
   *
   * Dan 2026-09-07 ("GAMES ARE FREEZING UP AFTER EACH AND EVERY HAND"): 3000ms
   * of enforced staring, on top of a 4500ms completion hold, is most of why
   * the table reads as frozen between hands. Cut to 1400 in lockstep with
   * HAND_COMPLETION.SHOWDOWN_READ_BASE_MS, per the paragraph above — the two
   * are the same beat seen from two sides and a test pins them equal.
   */
  protected showdownSettleMs = HAND_COMPLETION.SHOWDOWN_READ_BASE_MS;

  /** Wall-clock stamp of the last street dealt — see streetSettleMs. */
  protected lastStreetDealtAtMs = 0;

  /**
   * Dan 2026-08-20: the beat between the hand being dealt and the first player
   * going on the clock. The deal is the longest animation at the table — 12
   * cards on an 80ms stagger with a 320ms flight (~1.2s) — and the blinds fly
   * for another 400ms after it. Both used to still be in the air when the
   * first action began.
   *
   * Dan 2026-09-07: cut to 400. UTG has a full turn clock to act in; the deal
   * and the blinds finish inside the first second of it either way. Waiting
   * for the animation before STARTING the clock only adds dead air to the top
   * of every hand.
   */
  protected handStartSettleMs = 400;

  /** Wall-clock stamp of the blinds landing — see handStartSettleMs. */
  protected lastHandStartAtMs = 0;

  /**
   * POKERBROS PARITY 2026-08-26: the wall-clock deadline of the live RIT
   * offer — ONE shared countdown for the chooser and every responder,
   * matching the engine's DeadlineScheduler expiry. Carried on rit_offer and
   * rit_chooser_decided as deadline_ts so every client renders the same clock.
   */
  protected ritOfferDeadlineTs = 0;

  /** The exact controller currently owned by the RIT terminal boundary. */
  private ritResolutionOwner: HandController | null = null;

  /**
   * The resolver for dealHand's currently-owned completion wait. Dealing binds
   * it to the exact controller before start and clears it on every ordinary
   * exit. A terminal RIT failure uses this edge before teardown so stop can
   * join the dealing loop instead of waiting on a timer teardown just cleared.
   */
  protected activeHandWaitRelease: {
    controller: HandController;
    release: (reason: string) => void;
  } | null = null;

  protected releaseActiveHandWaitForTerminalRecovery(
    controller: HandController,
    reason: string
  ): boolean {
    const owned = this.activeHandWaitRelease;
    if (!owned || owned.controller !== controller) {
      reportError(
        new Error('terminal hand-wait release did not match the active controller'),
        'ServerTableEngine.' + this.tableId + '.terminal_hand_wait_release_mismatch',
        { reason, handNumber: this.handCount, hasOwnedWait: !!owned }
      );
      return false;
    }
    this.activeHandWaitRelease = null;
    owned.release(reason);
    return true;
  }

  /**
   * Every restart kill must release dealHand's exact controller-owned wait
   * before Base clears its timer and controller. Otherwise performStop joins a
   * dealing loop whose only remaining resolve edges were just destroyed.
   */
  protected override killForRestart(
    reason: string,
    notifyOwner = true,
    recoveryEventClass?: EngineRecoveryEventClass
  ): void {
    const activeController = this.activeHandWaitRelease?.controller;
    if (activeController) {
      try {
        this.releaseActiveHandWaitForTerminalRecovery(activeController, 'restart:' + reason);
      } catch (error) {
        reportError(
          error,
          'ServerTableEngine.' + this.tableId + '.terminal_hand_wait_release_failed',
          { reason, handNumber: this.handCount }
        );
      }
    }
    super.killForRestart(reason, notifyOwner, recoveryEventClass);
  }

  /**
   * Announce unanimous consent (reference behavior: the panel closes for
   * everyone and a "players have accepted running multi-times" banner shows
   * while the first board starts dealing).
   */
  protected emitRitAllAccepted(allPlayerIds: string[], runs: number): void {
    try {
      this.hub?.emitEvent(this.tableId, {
        type: 'rit_all_accepted',
        table_id: this.tableId,
        hand_number: this.handCount,
        allPlayerIds,
        runs,
      });
    } catch {
      /* broadcast failure is non-fatal */
    }
  }

  /**
   * ANIMATION AUDIT 2026-08-19: true from the moment an all-in runout begins
   * until the hand completes. While set, broadcastCurrentState reveals every
   * non-folded player's hole cards (ServerTableEngine.ts) — standard poker:
   * once betting is complete and hands are tabled, everyone sees them. Before
   * this flag, cards were only revealed at stage === 'showdown', i.e. AFTER
   * the paced runout finished — players watched equity percentages change for
   * five seconds next to face-DOWN cards. Cleared by the HAND_COMPLETE
   * listener and at hand start (ServerTableEngineDealing.ts).
   */
  protected runoutRevealActive = false;

  /**
   * FIX 95: Bible V8 §4.20 + Dan's rules: Respond to a Run It Twice offer.
   *
   * Two-phase flow:
   * Phase 1 — CHOOSER (best hand) picks how many boards: 1 (decline), 2, or 3.
   *           Body: { tableId, runs: 1|2|3 }
   * Phase 2 — ALL OTHER players accept or decline the chosen number.
   *           Body: { tableId, response: 'accept'|'decline' }
   *
   * If chooser picks 1 → instant run-once, no further prompts.
   * If ANY other player declines → fall back to run-once.
   * If ALL accept → deal that many boards.
   */
  public respondToRIT(
    userId: string,
    response?: 'accept' | 'decline',
    runs?: 1 | 2 | 3
  ): { success: boolean; error?: string; status?: string } {
    if (!this.runItTwiceEngine.hasPendingOffer(this.tableId)) {
      return { success: false, error: 'No active Run It Twice offer' };
    }

    const state = this.runItTwiceEngine.getState(this.tableId);
    if (!state) {
      return { success: false, error: 'No RIT state found' };
    }

    // Only participants in this offer can decide how their pot runs. Once
    // consent is final, late requests must not publish a different decision.
    if (!state.allPlayerIds.includes(userId)) {
      return { success: false, error: 'Player is not part of this Run It Twice offer' };
    }
    if (state.status !== 'offered') {
      return { success: false, error: 'Run It Twice decision is already final' };
    }

    /**
     * ── THE CHOOSER CANNOT "ACCEPT" (2026-08-27) ─────────────────────────
     *
     * Phase 1 below required `runs !== undefined`. A chooser client that
     * POSTed `{ response: 'accept' }` with no `runs` therefore fell through
     * into phase 2, was recorded as an ACCEPTANCE, and left `chooserDecided`
     * false forever — so tryCompleteAcceptance could never complete, the panel
     * sat on "Waiting For Other Players" for everyone, and the offer died at
     * the 25s auto-decline. A deadlock that looks exactly like a broken
     * feature, produced by a request the server answered `success: true`.
     *
     * The alternative fix — treat a bare accept as picking the default run
     * count — was rejected. Consent here is consent to run it N TIMES (see the
     * CONSENT-RACE FIX in RunItTwiceEngine): inventing N on the chooser's
     * behalf puts boards on the felt that nobody chose, which is Defect A
     * again in a different costume. So this fails LOUDLY and tells the client
     * exactly what to send instead. The offer is untouched and still live, so
     * a corrected request lands normally.
     *
     * A chooser DECLINE with no runs is left alone: it falls through to phase
     * 2's decline branch, which is the correct and already-announced outcome
     * (identical in effect to picking 1).
     */
    if (userId === state.chooserPlayerId && runs === undefined && response === 'accept') {
      return {
        success: false,
        error: 'Chooser must send runs (1, 2 or 3), not accept',
      };
    }

    // Phase 1: Chooser picks how many boards
    if (userId === state.chooserPlayerId && runs !== undefined) {
      this.runItTwiceEngine.chooserDecides(this.tableId, userId, runs);
      if (runs === 1) {
        /* Dan 2026-08-23: "I just tried to run it twice, and it did not run a
           second board... only ran it the one time and awarded me the pot."
           The engine was right - hand #1729271 that evening really did deal two
           boards. What was missing is THIS: when the offer resolves to a single
           run, nothing was broadcast at all. The hand simply ran once and
           shipped the pot, so a player who had just asked to run it twice was
           left to conclude the feature is broken. Every path that ends in one
           board now says so, and says who decided it. */
        this.emitRitSingleRun('chooser_chose_one', userId);
        return { success: true, status: 'declined_by_chooser' };
      }
      // Broadcast chooser's decision to all clients so others can accept/decline
      // POKERBROS PARITY 2026-08-26: carry the shared offer deadline so every
      // client's countdown agrees with the engine's auto-decline clock, plus
      // who has already agreed (the chooser, implicitly) for the live
      // checkmark rows in the Risk Management panel.
      this.hub?.emitEvent(this.tableId, {
        type: 'rit_chooser_decided',
        table_id: this.tableId,
        chooserPlayerId: userId,
        chosenRuns: state.chosenRuns,
        waitingFor: state.allPlayerIds.filter((pid) => !state.acceptedBy.has(pid)),
        accepted_ids: [...state.acceptedBy],
        deadline_ts: this.ritOfferDeadlineTs,
        timeoutSeconds: Math.max(1, Math.ceil((this.ritOfferDeadlineTs - Date.now()) / 1000) || 1),
      });
      // The chooser may be the LAST consent needed (responders can accept
      // before the chooser picks — the consent-race fix records them). When
      // chooserDecides completed the acceptance, announce it exactly like the
      // final responder accept would have.
      const stateAfter = this.runItTwiceEngine.getState(this.tableId);
      if (stateAfter?.status === 'accepted') {
        this.emitRitAllAccepted(stateAfter.allPlayerIds, stateAfter.chosenRuns);
      }
      return { success: true, status: 'waiting_for_others' };
    }

    // Phase 2: Other players accept or decline
    if (response === 'accept') {
      const allAccepted = this.runItTwiceEngine.accept(this.tableId, userId);
      // POKERBROS PARITY 2026-08-26: every accept is broadcast the moment it
      // lands, so all clients tick the player's green check LIVE (reference
      // behavior: checks appear one by one as players agree). Reads the state
      // AFTER accept() so acceptedBy includes this player.
      const stateNow = this.runItTwiceEngine.getState(this.tableId);
      if (stateNow) {
        this.hub?.emitEvent(this.tableId, {
          type: 'rit_response_update',
          table_id: this.tableId,
          hand_number: this.handCount,
          player_id: userId,
          accepted_ids: [...stateNow.acceptedBy],
          waiting_for: stateNow.allPlayerIds.filter((pid) => !stateNow.acceptedBy.has(pid)),
        });
      }
      if (allAccepted) {
        this.emitRitAllAccepted(
          stateNow?.allPlayerIds ?? state.allPlayerIds,
          stateNow?.chosenRuns ?? state.chosenRuns
        );
        return { success: true, status: 'accepted' };
      }
      return { success: true, status: 'waiting_for_others' };
    } else if (response === 'decline') {
      this.runItTwiceEngine.decline(this.tableId, userId);
      this.emitRitSingleRun('player_declined', userId);
      return { success: true, status: 'declined' };
    }

    return {
      success: false,
      error: 'Invalid RIT response: provide runs (1/2/3) or response (accept/decline)',
    };
  }

  /**
   * Bible V8 §4.19: Respond to an insurance offer.
   * @param coveragePercent — Optional partial coverage (1-100%). Default = 100% (full insurance).
   *   Player uses a slider UI to adjust. e.g., 75 = "75% insurance" = 75% of the payout/cost.
   * @param declineForHand — Accepted for API compatibility but IGNORED since
   *   2026-08-26: every decline is final for the hand (see below).
   */
  public respondToInsurance(
    userId: string,
    response: 'accept' | 'decline' | 'cashout',
    coveragePercent: number = 100,
    // POKERBROS PARITY 2026-08-26 (Dan): "IF A PLAYER DECLINES, THEY DON'T GET
    // OFFERED AGAIN." There is no street-only decline any more. The parameter
    // stays so older clients don't 400, but the value is not consulted.
    _declineForHand: boolean = false
  ): {
    success: boolean;
    error?: string;
    status?: string;
    premium?: number;
    insuredAmount?: number;
  } {
    if (!this.insuranceEngine.isEnabled(this.tableId)) {
      return { success: false, error: 'Insurance is not enabled at this table' };
    }

    // EV CASHOUT 2026-08-28: third answer to the offer — lock pot x equity
    // (minus the fee) now. The hand still runs out; settlement pays the
    // locked amount and redirects the player's actual winnings to the bank.
    if (response === 'cashout') {
      const r = this.insuranceEngine.acceptEvCashout(this.tableId, userId);
      if (!r.ok) {
        return { success: false, error: 'No pending EV cashout offer for this player' };
      }
      return { success: true, status: 'cashed_out', insuredAmount: r.amount };
    }

    if (response === 'accept') {
      const accepted = this.insuranceEngine.acceptPartial(this.tableId, userId, coveragePercent);
      if (!accepted) {
        return { success: false, error: 'No pending insurance offer for this player' };
      }
      // NOTE: Premium is NOT deducted from stack here — player is ALL-IN.
      // Insurance premium is deducted from the winner's pot at settlement (like rake/BBJ).
      // If the insured player LOSES, they get paid from union/club bank.
      // Settlement happens in HAND_COMPLETE handler.
      const offers = this.insuranceEngine.getOffers(this.tableId);
      const accepted_offer = offers.find((o) => o.playerId === userId && o.status === 'accepted');
      return {
        success: true,
        status: 'accepted',
        premium: accepted_offer?.premium,
        insuredAmount: accepted_offer?.insuredAmount,
      };
    } else {
      // POKERBROS PARITY 2026-08-26 (Dan): a decline is final for the hand —
      // EXCEPT preflop (Dan 2026-08-28: "OFFERED PRE FLOP, AND REOFFERED ON
      // THE FLOP"): a preflop decline is street-only; the flop offer is where
      // finality begins.
      const pending = this.insuranceEngine
        .getOffers(this.tableId)
        .find((o) => o.playerId === userId && o.status === 'offered');
      const forHand = (pending?.boardLength ?? 3) >= 3;
      this.insuranceEngine.decline(this.tableId, userId, forHand);
      return { success: true, status: forHand ? 'declined_for_hand' : 'declined_street' };
    }
  }

  /**
   * Bible V8 §4.19: Preview insurance cost for a given coverage percentage.
   * Used by client slider to show real-time cost/payout as player adjusts.
   */
  public previewInsurance(
    userId: string,
    coveragePercent: number
  ): { premium: number; insuredAmount: number; coveragePercent: number } | null {
    return this.insuranceEngine.getPreview(this.tableId, userId, coveragePercent);
  }

  /**
   * Bible V8 §4.19: Handle all-in runout pause for insurance/RIT offers.
   * When all active players are all-in with cards to come:
   * 1. Pause the action timer
   * 2. If insurance is enabled: create offers for all all-in players, wait for responses (or timeout)
   * 3. If RIT is enabled and exactly 2 players: offer RIT (handled separately via respondToRIT)
   * 4. After all offers resolved → resume with handController.continueRunout()
   */
  private pineappleCardsKey(cards: readonly Card[]): string {
    return cards.map((card) => `${card.rank}:${card.suit}`).join('|');
  }

  private cancelPineappleSeatDecision(seat: number): void {
    const delayed = this.pineappleDecisionDelayTimers.get(seat);
    if (delayed) clearTimeout(delayed);
    this.pineappleDecisionDelayTimers.delete(seat);

    const deadline = this.pineappleDecisionDeadlineTimers.get(seat);
    if (deadline) clearTimeout(deadline);
    this.pineappleDecisionDeadlineTimers.delete(seat);

    this.pineappleDecisionAbortControllers.get(seat)?.abort();
    this.pineappleDecisionAbortControllers.delete(seat);
  }

  private cancelPineappleDecisionWork(): void {
    this.pineappleDecisionGeneration += 1;
    const seats = new Set([
      ...this.pineappleDecisionDelayTimers.keys(),
      ...this.pineappleDecisionDeadlineTimers.keys(),
      ...this.pineappleDecisionAbortControllers.keys(),
    ]);
    for (const seat of seats) this.cancelPineappleSeatDecision(seat);
  }

  /** Hand teardown owns worker cancellation just as it owns every raw timer. */
  protected override clearLooseHandTimers(): void {
    this.cancelPineappleDecisionWork();
    super.clearLooseHandTimers();
  }

  private pineappleDecisionFenceIsCurrent(
    controller: HandController,
    handNumber: number,
    generation: number,
    leaseGeneration: string | null
  ): boolean {
    if (
      this.pineappleDecisionGeneration !== generation ||
      this.handController !== controller ||
      this.handCount !== handNumber ||
      !this.lifecycleCanMutate()
    ) {
      return false;
    }
    const currentLease = this.getEngineLeaseAuthority();
    if (leaseGeneration === null) return currentLease === null;
    return currentLease?.verified === true && currentLease.generation === leaseGeneration;
  }

  private async requestPineappleDiscard(
    controller: HandController,
    handNumber: number,
    generation: number,
    leaseGeneration: string | null,
    seat: number,
    cards: readonly Card[],
    communityCards: readonly Card[],
    gameVariant: string,
    deadlineMs?: number
  ): Promise<number> {
    if (
      !this.pineappleDecisionFenceIsCurrent(controller, handNumber, generation, leaseGeneration)
    ) {
      throw new HorseDecisionAbortedError('pineapple discard lifecycle fence moved');
    }

    this.cancelPineappleSeatDecision(seat);
    const abortController = new AbortController();
    this.pineappleDecisionAbortControllers.set(seat, abortController);
    if (deadlineMs !== undefined) {
      const deadlineTimer = setTimeout(
        () => abortController.abort(),
        Math.max(0, deadlineMs - Date.now())
      );
      deadlineTimer.unref?.();
      this.pineappleDecisionDeadlineTimers.set(seat, deadlineTimer);
    }

    const cardsKey = this.pineappleCardsKey(cards);
    const boardKey = this.pineappleCardsKey(communityCards);
    const fence = [
      this.tableId,
      handNumber,
      'pineapple-discard',
      seat,
      leaseGeneration ?? 'isolated',
      generation,
      cardsKey,
      boardKey,
    ].join(':');

    try {
      const result = await getLiveHorseDecisionWorker().decideDiscard(
        {
          generation,
          fence,
          cards: [...cards],
          communityCards: [...communityCards],
          gameVariant,
        },
        abortController.signal
      );
      if (
        result.generation !== generation ||
        result.fence !== fence ||
        !this.pineappleDecisionFenceIsCurrent(
          controller,
          handNumber,
          generation,
          leaseGeneration
        ) ||
        !Number.isInteger(result.cardIndex) ||
        result.cardIndex < 0 ||
        result.cardIndex >= cards.length
      ) {
        throw new HorseDecisionAbortedError('pineapple discard result crossed its fence');
      }
      return result.cardIndex;
    } finally {
      if (this.pineappleDecisionAbortControllers.get(seat) === abortController) {
        this.pineappleDecisionAbortControllers.delete(seat);
        const deadlineTimer = this.pineappleDecisionDeadlineTimers.get(seat);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        this.pineappleDecisionDeadlineTimers.delete(seat);
      }
    }
  }

  /**
   * Price every all-in Pineapple discard on the sole live worker before the
   * synchronous controller call deals that exact flop. The final controller
   * install is atomic, so settlement never observes a partial result set.
   */
  private async preparePineappleRunoutDiscards(controller: HandController): Promise<boolean> {
    const snapshot = controller.getPineappleRunoutDiscardSnapshot?.();
    if (!snapshot) return true;

    this.cancelPineappleDecisionWork();
    const generation = this.pineappleDecisionGeneration;
    const handNumber = this.handCount;
    const lease = this.getEngineLeaseAuthority();
    const leaseGeneration = lease?.verified === true ? lease.generation : null;
    if (lease !== null && lease.verified !== true) return false;
    const gameVariant = (this.activeHandVariant() || 'pineapple') as string;
    const decisions = new Map<number, number>();

    for (const player of snapshot.players) {
      const cardIndex = await this.requestPineappleDiscard(
        controller,
        handNumber,
        generation,
        leaseGeneration,
        player.seat,
        player.cards,
        snapshot.flop,
        gameVariant
      );
      decisions.set(player.seat, cardIndex);
    }

    if (
      !this.pineappleDecisionFenceIsCurrent(controller, handNumber, generation, leaseGeneration)
    ) {
      return false;
    }
    const current = controller.getPineappleRunoutDiscardSnapshot?.();
    if (
      !current ||
      this.pineappleCardsKey(current.flop) !== this.pineappleCardsKey(snapshot.flop) ||
      current.players.length !== snapshot.players.length ||
      current.players.some((player, index) => {
        const original = snapshot.players[index];
        return (
          !original ||
          player.seat !== original.seat ||
          this.pineappleCardsKey(player.cards) !== this.pineappleCardsKey(original.cards)
        );
      })
    ) {
      return false;
    }
    return controller.preparePineappleRunoutDiscards(snapshot.flop, decisions);
  }

  private refreshAllInPlayersFromController(
    players: readonly SeatPlayer[],
    controller: HandController
  ): SeatPlayer[] {
    // Narrow compatibility seam for legacy test/fault-injection controllers.
    // Every production HandController has getState().
    if (typeof controller.getState !== 'function') return [...players];
    const currentBySeat = new Map(
      controller.getState().players.map((player) => [player.seat, player] as const)
    );
    return players.map((player) => currentBySeat.get(player.seat) ?? player);
  }

  /**
   * FIX 120: Crazy Pineapple — start a discard timer for all active players.
   * Each player has action_time_seconds to pick which card to discard.
   * If they don't respond, auto-discard the last (3rd) card.
   */
  protected handlePineappleDiscard(event: HandEvent): void {
    if (event.type !== 'PINEAPPLE_DISCARD_REQUIRED' || !this.handController) return;

    // The discard round owns per-seat discard deadlines, not an ordinary turn
    // clock. Cancel every preflop turn deadline and speculative Horse action at
    // this boundary. HandController also parks currentPlayerSeat at -1 and
    // rejects ordinary actions during the round; both sides are intentional so
    // a delayed callback cannot manufacture a `check` in pineapple_discard.
    this.clearTurnTimer();
    const seats = (event as any).seats as number[];
    const timeoutMs = (this.tableInfo?.action_time_seconds || 15) * 1000;
    const deadline = Date.now() + timeoutMs;

    // AUDIT V2 (2026-07-23): horses used to rely on the expiry auto-discard,
    // which always throws away the LAST card — effectively a random discard.
    // Each horse still picks the equity-maximizing discard with a humanlike
    // delay, but the Monte Carlo work belongs to the one live worker FIFO.
    const handControllerRef = this.handController;
    const hcState = handControllerRef.getState();
    this.cancelPineappleDecisionWork();
    const generation = this.pineappleDecisionGeneration;
    const handNumber = this.handCount;
    const lease = this.getEngineLeaseAuthority();
    const leaseGeneration = lease?.verified === true ? lease.generation : null;
    for (const seat of seats) {
      const seated = this.seatedPlayers.find((p) => p.seat_number === seat);
      if (!seated?.is_horse) continue;
      const enginePlayer = hcState.players.find((p) => p.seat === seat);
      if (!enginePlayer || enginePlayer.is_folded || enginePlayer.cards.length !== 3) continue;
      const delay = 1200 + Math.random() * Math.min(4000, Math.max(1500, timeoutMs * 0.3));
      const delayTimer = setTimeout(() => {
        this.pineappleDecisionDelayTimers.delete(seat);
        if (lease !== null && lease.verified !== true) {
          return;
        }
        if (
          !this.pineappleDecisionFenceIsCurrent(
            handControllerRef,
            handNumber,
            generation,
            leaseGeneration
          ) ||
          !handControllerRef.owesPineappleDiscard(seat)
        ) {
          return;
        }
        const current = handControllerRef.getState();
        const player = current.players.find((candidate) => candidate.seat === seat);
        if (!player || player.is_folded || player.cards.length !== 3) return;
        const cards = [...player.cards];
        const communityCards = [...current.communityCards];
        const gameVariant = (this.activeHandVariant() || 'pineapple') as string;

        void this.requestPineappleDiscard(
          handControllerRef,
          handNumber,
          generation,
          leaseGeneration,
          seat,
          cards,
          communityCards,
          gameVariant,
          deadline
        )
          .then((cardIndex) => {
            if (
              !this.pineappleDecisionFenceIsCurrent(
                handControllerRef,
                handNumber,
                generation,
                leaseGeneration
              ) ||
              !handControllerRef.owesPineappleDiscard(seat)
            ) {
              return;
            }
            const latest = handControllerRef.getState();
            const latestPlayer = latest.players.find((candidate) => candidate.seat === seat);
            if (
              !latestPlayer ||
              latestPlayer.is_folded ||
              this.pineappleCardsKey(latestPlayer.cards) !== this.pineappleCardsKey(cards) ||
              this.pineappleCardsKey(latest.communityCards) !==
                this.pineappleCardsKey(communityCards)
            ) {
              return;
            }
            handControllerRef.performDiscard(seat, cardIndex);
            if (handControllerRef.allPineappleDiscardsIn()) {
              this.cancelPineappleDecisionWork();
            }
          })
          .catch((error) => {
            if (error instanceof HorseDecisionAbortedError) return;
            reportError(
              error,
              'ServerTableEngine.' + this.tableId + '.pineapple_discard_worker_failed',
              { seat, handNumber }
            );
            // The authoritative discard deadline remains the legal safety net:
            // a seat that never produces an action folds when its clock expires.
          });
      }, delay);
      delayTimer.unref?.();
      this.pineappleDecisionDelayTimers.set(seat, delayTimer);
    }

    // Start a single discard timer — when it expires, auto-discard for anyone remaining.
    //
    // 2026-08-15: this had no try/catch and no hand-identity guard. autoDiscard
    // drives performDiscard -> checkPineappleDiscardsComplete -> advanceStage ->
    // deck.deal -> the synchronous broadcast chain, so a throw on the FIRST seat
    // aborted the loop: the remaining seats never discarded,
    // pineappleDiscardsRemaining never emptied, and the hand was parked at
    // pineapple_discard forever. Three pineapple tables run in production.
    this.pineappleDiscardBaseDeadlineMs = deadline;
    this.pineappleDiscardDurationMs = timeoutMs;
    this.pineappleDiscardDeadlines.clear();
    for (const seat of seats) this.pineappleDiscardDeadlines.set(seat, deadline);
    this.armPineappleDiscardSweep(this.handController);
  }

  /**
   * FIX 120: Public method for players to submit their Pineapple discard.
   * @param userId - The user submitting the discard
   * @param cardIndex - Which card to discard (0, 1, or 2)
   * @returns success/error
   */
  submitDiscard(userId: string, cardIndex: number): { success: boolean; error?: string } {
    if (!this.handController) {
      return { success: false, error: 'No active hand' };
    }

    const hcState = this.handController.getState();
    if (hcState.stage !== 'pineapple_discard') {
      return { success: false, error: 'Not in discard phase' };
    }

    const player = this.seatedPlayers.find((p) => p.user_id === userId);
    if (!player) {
      return { success: false, error: 'Player not seated' };
    }

    const result = this.handController.performDiscard(player.seat_number, cardIndex);
    if (!result) {
      return { success: false, error: 'Discard rejected' };
    }
    // A human action owns the seat now. Cancel a delayed or queued horse job
    // for that exact seat rather than letting it consume FIFO capacity only to
    // be stale-discarded later.
    this.cancelPineappleSeatDecision(player.seat_number);

    // If all discards are complete, the HandController will advance the game
    // and emit events that trigger broadcasting. Clear the discard timer.
    //
    // 2026-08-15: this used to re-test `hcState.stage`, a PRE-discard copy
    // returned by getState() — proven equal to 'pineapple_discard' by the guard
    // at the top of this method and unable to change, so the branch was dead
    // and the timer was NEVER cleared. It always ran to full duration and fired
    // autoDiscard into whatever hand happened to be live by then.
    /* This seat is done, so it can no longer be folded for missing the round.
       Before per-seat deadlines this was implicit in the single table-wide
       timer; now it has to be said. */
    this.pineappleDiscardDeadlines.delete(player.seat_number);
    /* PHASE 3 2026-08-31: was `getState().stage !== 'pineapple_discard'`. That
       read the ADVANCE as the answer to "is the round over", which held only
       while the advance was synchronous. The last discard now buys a
       DISCARD_SETTLE_MS beat so the toss can finish before betting opens, and
       during that beat the stage is still 'pineapple_discard' - so the old
       reading would have re-armed the fold sweep against a table where every
       seat had already acted, and folded them all when it fired. Ask the
       question the engine actually means. */
    if (this.handController.allPineappleDiscardsIn()) {
      this.cancelPineappleDecisionWork();
      // Everyone is in - the beat, then the flop
      if (this.pineappleDiscardTimer) {
        clearTimeout(this.pineappleDiscardTimer);
        this.pineappleDiscardTimer = null;
      }
      this.pineappleDiscardDeadlines.clear();
      this.pineappleDiscardBaseDeadlineMs = null;
    } else {
      this.armPineappleDiscardSweep(this.handController);
    }

    this.broadcastCurrentState();
    return { success: true };
  }

  protected handleAllInRunout(event: HandEvent, players: SeatedPlayer[]): void {
    if (event.type !== 'ALL_IN_RUNOUT' || !this.handController) return;
    // ═══ THE HAND THIS RUNOUT BELONGS TO (2026-08-31) ═════════════════════
    // Every continuation, catch handler and safety timer spawned below must
    // name this controller and be dropped if the live hand has moved on. See
    // safeContinueRunout for what happened when they did not.
    const controllerAtPark = this.handController;

    /**
     * ── RE-READ THE RIT CONFIGURATION BEFORE DECIDING (2026-08-27) ────────
     *
     * `runItTwiceEngine.configure` used to be called exactly once, in
     * ServerTableEngineBase.start(). Everything the table said about run it
     * twice and insurance after that point was invisible to the engine until
     * the process restarted — which is how production hand #3046089 dealt
     * three boards off a configuration snapshot older than the table's own
     * settings. This is the last instruction before the offer decision, so
     * what the table says and what the engine does cannot disagree.
     *
     * It re-reads the configuration; it does NOT decide the RIT/insurance
     * ordering. `insurance_enabled` no longer switches run-it-twice off (Dan
     * 2026-08-26 — see applyRunItTwiceConfig). On a table with both on, the
     * RIT question comes first and insurance picks up the single run; that is
     * `ritFirst` below, a few lines down, and it is the only place the two
     * features are sequenced.
     *
     * See applyRunItTwiceConfig() for what it can and cannot refresh
     * (`this.tableInfo` is itself a per-process snapshot).
     */
    this.applyRunItTwiceConfig();
    this.wireRunItTwiceEvents();

    const board = (event as any).board as import('../types.js').Card[];
    const pot = (event as any).pot as number;
    const allInPlayers = (event as any).players as import('../types.js').SeatPlayer[];

    // Pause all timers during insurance/RIT decision window
    this.clearTurnTimer();

    // ANIMATION AUDIT 2026-08-19: table the hands. All betting is complete —
    // every remaining hand is turned face up for the runout (see the field's
    // doc comment). Must be set BEFORE the broadcast below so the reveal and
    // the first equity percentages land together.
    if (allInPlayers.length >= 2) {
      this.runoutRevealActive = true;
    }

    // Broadcast current state so clients see the all-in board
    this.broadcastCurrentState();

    // DOUBLE-BOARD BOMB POT 2026-08-20: a hand already running two boards
    // neither needs a second runout (RIT) nor has a single-board equity to
    // insure. Both offers are suppressed; the plain runout path fills both
    // boards via HandController.
    // Optional call: RIT test harnesses inject minimal HandController mocks
    // that predate this method — absent method means single board.
    const doubleBoardHand = this.handController.isDoubleBoardActive?.() ?? false;
    const insuranceEnabled = this.insuranceEngine.isEnabled(this.tableId) && !doubleBoardHand;
    const insuranceCanPriceStandingBoard =
      insuranceEnabled && board.length < 5 && allInPlayers.length >= 2;
    let standaloneEquityRequested = false;
    const requestStandaloneEquity = () => {
      if (standaloneEquityRequested || allInPlayers.length < 2) return;
      standaloneEquityRequested = true;
      void this.broadcastAllInEquity(allInPlayers, board, pot, this.liveExtraBoards());
    };

    // ═══════════════════════════════════════════════════════════════════════
    // EQUITY DISPLAY: Calculate and broadcast equity for ALL all-in players
    // This is shown on every table (insurance or not) for all players/observers.
    // ROUND 3 AUDIT FIX (2026-08-20): was suppressed on double-board hands
    // because the solver ran board 1 only. MULTI-BOARD EQUITY 2026-08-28
    // (spec §14): the solver now prices EVERY live board and averages —
    // each board carries an equal share of every pot layer, so the average
    // per-board equity IS the player's true share of the money. The most
    // dramatic runouts on the platform get their percentages back.
    // ═══════════════════════════════════════════════════════════════════════
    // A live single-board insurance street emits these percentages from its
    // mandatory structured-pricing pass. Everything else retains the optional
    // cosmetic worker path.
    if (!insuranceCanPriceStandingBoard) requestStandaloneEquity();
    // SEQUENCING 2026-08-26 (Dan's leader-seat recording): when BOTH features
    // are on, the run-it-multi-times question comes FIRST and insurance
    // engages only if the hand resolves to a single run ("THE INSURANCE PART
    // PICKED UP ON THE TURN. AFTER THE RUN IT TWICE WAS DECLINED"). Per-hand
    // exclusivity is preserved: a hand dealing extra boards never carries an
    // insurance contract, and an insured hand always runs exactly once.
    const ritFirst = this.runItTwiceEngine.isEnabled(this.tableId) && !doubleBoardHand;

    // Shared entry into the per-street insurance flow (offer on the standing
    // board, then deal). Used directly on insurance-only tables and as the
    // single-run continuation on tables that ask the RIT question first.
    const startInsuranceFlow = () => {
      const offerPlayers = allInPlayers.map((p) => ({
        playerId: p.user_id,
        holeCards: p.cards || [],
      }));
      // runInsurancePerStreetFlow has no try/catch of its own and ends in
      // finalizeRunout()/continueRunout(). An unhandled rejection therefore
      // left the hand parked forever with no clock of any kind, because
      // HandController.advanceStage returns without setting currentPlayerSeat
      // while it waits for this callback to come back.
      this.runInsurancePerStreetFlow(
        offerPlayers,
        allInPlayers,
        pot,
        board,
        controllerAtPark
      ).catch((err) => {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.insurance_flow_rejected');
        this.safeContinueRunout('insurance_flow_rejected', controllerAtPark);
      });
    };

    if (!ritFirst && insuranceEnabled && board.length < 5 && allInPlayers.length >= 2) {
      // ═══════════════════════════════════════════════════════════════════════
      // INSURANCE-ONLY TABLE: straight to the per-street pause flow.
      // ═══════════════════════════════════════════════════════════════════════
      startInsuranceFlow();
    } else {
      // ═══════════════════════════════════════════════════════════════════════
      // FIX 94: RIT (Run It Twice) offer — N-player support.
      // Bible V8 §4.20 + Dan's rules:
      // - RIT is ONLY offered when ALL active players are all-in
      // - ANY number of players (2+), no limit — full table all-in is possible
      // - Player with BEST ACTUAL HAND (not percentages) chooses 1/2/3 boards
      // - ALL other all-in players must AGREE. Any decline → run once.
      // - RIT and Insurance are mutually exclusive (FIX 92).
      // - Multiple side pots are handled: each pot evaluated per board.
      // ═══════════════════════════════════════════════════════════════════════
      if (ritFirst && allInPlayers.length >= 2 && board.length < 5) {
        // Determine the chooser: player with the BEST ACTUAL HAND right now.
        //
        // 2026-08-29: reads activeHandVariant(), not tableInfo.game_variant.
        // A SINGLE-board bomb pot with a variant override is fully eligible
        // for RIT (only MULTI-board hands are suppressed), and on one the
        // table says nlh while the players are holding four cards each — so
        // the chooser was elected with a Hold'em evaluator on Omaha hands and
        // the wrong player was given the right to pick 1/2/3 boards.
        // dealAndResolveRIT already settles with the hand's own variant
        // (getVariant, below); this is the election catching up with it.
        // activeHandVariant is the ONE seam for "what game is this hand".
        const variant = this.activeHandVariant();
        // Review fix 2026-08-25: isOmahaVariant, not startsWith('plo') —
        // flo8 (fixed-limit Omaha 8) is an Omaha variant that the prefix
        // check silently evaluated as a hold'em hand.
        const isOmaha = isOmahaVariant(variant);
        const evaluator = isOmaha ? evaluateOmahaHand : evaluateHand;

        // CHOOSER FIX 2026-08-18: on a PREFLOP all-in the board is empty (the
        // parity fix parks before any street is dealt) and evaluateHand
        // cannot rank a bare 2-card holding - it picked KK over AA. Preflop,
        // the best ACTUAL hand is hole-card strength: a pair beats unpaired,
        // higher pair beats lower, then high cards in order. Postflop
        // (board >= 3 -> 5+ cards available) the full evaluator rules.
        const RANK_VALUE: Record<string, number> = {
          '2': 2,
          '3': 3,
          '4': 4,
          '5': 5,
          '6': 6,
          '7': 7,
          '8': 8,
          '9': 9,
          T: 10,
          '10': 10,
          J: 11,
          Q: 12,
          K: 13,
          A: 14,
        };
        const preflopStrength = (cards: import('../types.js').Card[]): number[] => {
          const vals = cards.map((cd) => RANK_VALUE[cd.rank] ?? 0).sort((x, y) => y - x);
          const counts = new Map<number, number>();
          for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
          const pairs = [...counts.entries()]
            .filter(([, n]) => n >= 2)
            .map(([v]) => v)
            .sort((x, y) => y - x);
          // [best pair rank (0 if none), then kickers high-to-low]
          return [pairs[0] ?? 0, ...vals];
        };
        const cmpPreflop = (a: number[], b: number[]): number => {
          for (let k = 0; k < Math.max(a.length, b.length); k++) {
            const d = (a[k] ?? 0) - (b[k] ?? 0);
            if (d !== 0) return d;
          }
          return 0;
        };
        const preflop = board.length < 3;

        let chooserPlayerId = allInPlayers[0].user_id;
        let bestEval = preflop ? null : evaluator(allInPlayers[0].cards || [], board);
        let bestPre = preflop ? preflopStrength(allInPlayers[0].cards || []) : null;

        for (let i = 1; i < allInPlayers.length; i++) {
          if (preflop) {
            const pre = preflopStrength(allInPlayers[i].cards || []);
            if (cmpPreflop(pre, bestPre as number[]) > 0) {
              bestPre = pre;
              chooserPlayerId = allInPlayers[i].user_id;
            }
          } else {
            const playerEval = evaluator(allInPlayers[i].cards || [], board);
            if (compareHands(playerEval, bestEval as NonNullable<typeof bestEval>) > 0) {
              bestEval = playerEval;
              chooserPlayerId = allInPlayers[i].user_id;
            }
          }
        }

        const allPlayerIds = allInPlayers.map((p) => p.user_id);

        /**
         * ── MANDATORY MODES SKIP THE QUESTION (Dan 2026-08-25) ────────────
         *
         * "Mandatory Twice" and "Mandatory 3 Times" have been radio buttons on
         * the creation screen since February that produced the SAME behaviour
         * as "Player's Choice": the offer went out and either all-in player
         * could decline a rule the host had made compulsory. `run_it_mode` was
         * written and never read.
         *
         * The host has already decided, so there is nothing to ask, nobody to
         * time out and no chooser to elect. Straight to the boards.
         */
        const forcedRuns = this.runItTwiceEngine.mandatoryRuns(this.tableId);
        if (forcedRuns) {
          this.runItTwiceEngine.forceRuns(
            this.tableId,
            `${this.tableId}:${this.handCount}`,
            allPlayerIds,
            pot,
            forcedRuns
          );
          this.hub?.emitEvent(this.tableId, {
            type: 'rit_mandatory',
            table_id: this.tableId,
            hand_number: this.handCount,
            allPlayerIds,
            pot,
            runs: forcedRuns,
          });
          requestStandaloneEquity();
          void this.dealAndResolveRIT(allInPlayers);
          return;
        }

        this.runItTwiceEngine.offer(
          this.tableId,
          `${this.tableId}:${this.handCount}`,
          chooserPlayerId,
          allPlayerIds,
          pot
        );

        // Broadcast RIT offer to ALL clients.
        // POKERBROS PARITY 2026-08-26: timeoutSeconds comes from the engine
        // config (25s reference countdown) instead of a hardcoded 10 that
        // disagreed with the engine's own expiry, and deadline_ts pins the
        // exact wall-clock moment so every client's countdown matches.
        const ritTimeoutSeconds = this.runItTwiceEngine.offerTimeoutSeconds(this.tableId);
        this.ritOfferDeadlineTs = Date.now() + ritTimeoutSeconds * 1000;
        this.hub?.emitEvent(this.tableId, {
          type: 'rit_offer',
          table_id: this.tableId,
          hand_number: this.handCount,
          chooserPlayerId,
          allPlayerIds,
          pot,
          // The CEILING the offer permits, not a count anyone consented to.
          // Read from getChosenRuns() until 2026-08-27 — which now answers the
          // consent question and is 1 on a live offer, so the panel would have
          // advertised a single board. maxRunsAllowed is the table's maximum.
          maxRuns: this.runItTwiceEngine.maxRunsAllowed(this.tableId),
          timeoutSeconds: ritTimeoutSeconds,
          deadline_ts: this.ritOfferDeadlineTs,
        });

        // HORSE RIT RESPONSES 2026-08-18: horses never answered rit_offer,
        // so ANY horse in the all-in set let the offer expire and the hand
        // always ran once - zero RIT hands in 24h of live traffic, and a
        // human could never actually run it twice at a table with horses.
        // Horses now respond like players, with human-like delays.
        this.scheduleHorseRITResponses(chooserPlayerId, allPlayerIds);

        // Wait for all players to respond.
        // Chooser picks 1/2/3 → others accept/decline → engine resolves.
        this.waitForRITResponse(() => {
          if (this.runItTwiceEngine.isActive(this.tableId) && this.handController) {
            // ═══════════════════════════════════════════════════════════════
            // FIX 97: RIT ACCEPTED — Deal multiple boards, evaluate per pot.
            // Bible V8 §4.20: Rake applies ONCE (not per board).
            // Each pot is split across boards (half/half or third/third/third).
            // Each board is evaluated independently for each pot.
            // ═══════════════════════════════════════════════════════════════
            requestStandaloneEquity();
            void this.dealAndResolveRIT(allInPlayers);
          } else if (this.handController) {
            // Declined or unanswered — the hand runs ONCE.
            this.emitRitSingleRun('no_agreement');
            // SEQUENCING 2026-08-26: on a single run, insurance now gets its
            // turn (the reference's exact order). No insurance on this table:
            // normal paced runout (Dan item 16).
            if (insuranceEnabled && allInPlayers.length >= 2) {
              startInsuranceFlow();
            } else {
              void this.pacedAllInRunout(allInPlayers, pot);
            }
          }
        });
      } else {
        // NO INSURANCE, NO RIT. This used to be an INSTANT full runout: the
        // flop, turn and river all landed inside one synchronous while-loop in
        // HandController.runOutCommunityCards, in a single tick, and the hand
        // completed immediately after. Dan item 16 — the run-out is paced now.
        void this.pacedAllInRunout(allInPlayers, pot);
      }
    }
  }

  /**
   * Wait for both players to respond to RIT offer.
   * Similar to waitForInsuranceResponses but checks RIT state.
   */
  /**
   * Force a parked runout to finish. The terminal fallback on every path that
   * would otherwise leave a hand waiting on a callback that died.
   */
  /**
   * Deal an all-in run-out ONE STREET AT A TIME, with the equity percentages
   * refreshed between streets.
   *
   * Dan 2026-08-19, bug list item 16: "when players are all-in before all cards
   * are out, show win percentages, slow the action down (turn card ->
   * percentages change -> river -> winning hand identified -> pot pushed)."
   *
   * The percentages already existed and were already broadcast - but only ONCE,
   * at the moment of the all-in. The run-out itself went through
   * HandController.runOutCommunityCards, which is a synchronous `while (board <
   * 5)` loop: flop, turn and river were dealt in the same tick and the hand
   * completed immediately after. Every card appeared at once, so there was no
   * moment at which a percentage could change and nothing to watch.
   *
   * The machinery to do this properly was already here - the INSURANCE tables
   * have paced per-street dealing with an equity re-broadcast on every street.
   * Ordinary all-ins simply never used it. This is that same loop without the
   * offer step.
   *
   * Deliberately NOT used by safeContinueRunout: that is the "something died,
   * finish the hand now" path, and it must stay instant.
   */
  protected async pacedAllInRunout(
    allInPlayers: import('../types.js').SeatPlayer[],
    pot: number
  ): Promise<void> {
    const controller = this.handController;
    if (!controller) return;

    try {
      // A beat on the all-in board itself, so the starting percentages that
      // were broadcast when the players got it in are actually readable.
      await this.sleep(this.allInFirstPauseMs);

      // Guard every iteration: the table can be torn down, or the hand
      // replaced, while we are sleeping between streets.
      // Bounded by the most streets a board can ever still need (three).
      //
      // CORRECTION 2026-08-19: an earlier comment here justified this with an
      // 8-max PLO6 deck exhaustion. That is not a real configuration — PLO6 is
      // 6-max and PLO5 is 7-max (Dan) — and `deal()` throws rather than
      // returning short, so the board cannot silently stop growing. The bound
      // stays because this loop SLEEPS 1.4s per turn and re-broadcasts state
      // and equity on each one, so an unbounded version is the expensive kind
      // of mistake to leave lying around; but it guards a state no current code
      // path can produce.
      let streetsLeft = 3;
      while (
        this.running &&
        this.handController === controller &&
        controller.getCommunityCards().length < 5 &&
        streetsLeft-- > 0
      ) {
        const before = controller.getCommunityCards().length;
        if (controller.getPineappleRunoutDiscardSnapshot?.()) {
          try {
            if (!(await this.preparePineappleRunoutDiscards(controller))) return;
          } catch (error) {
            if (error instanceof HorseDecisionAbortedError) return;
            reportError(
              error,
              'ServerTableEngine.' + this.tableId + '.pineapple_runout_worker_failed'
            );
            // No main-thread fallback: settlement remains parked behind the
            // two-card invariant and the worker lifecycle failure is visible.
            return;
          }
        }
        const result = controller.dealNextStreet();
        // The worker-backed flop commit changes the authoritative hole cards
        // from three to two. Never price later equity from the stale copies
        // captured by ALL_IN_RUNOUT before that commit.
        allInPlayers = this.refreshAllInPlayersFromController(allInPlayers, controller);
        this.broadcastCurrentState();

        if (controller.getCommunityCards().length === before) {
          // The deck gave us nothing; stop rather than sleep and retry.
          reportError(
            new Error(
              '[PacedRunout] board stopped growing at ' + String(before) + ' cards - short deck'
            ),
            'ServerTableEngine.' + this.tableId + '.paced_runout_short_deck'
          );
          break;
        }

        // THE STREET MUST BE SEEN BEFORE THE NUMBERS MOVE (Dan 2026-08-28,
        // verbatim: "EQUITY CHANGES ONLY AFTER THE FLOP IS DISPLAYED, (NOT
        // BEFORE OR DURING)").
        //
        // broadcastCurrentState() above SENT the card; it has not been SEEN.
        // The client is still animating it in — 1.25s for a flop in
        // slow-reveal mode. Broadcasting the new equity in the same instant,
        // which is what this did, flips the percentages to the outcome while
        // the card that caused it is still turning over: on the reported hand
        // the villain read 0% and the hero 100% before the river was face up.
        // That tells the player how it ends and then shows them the card as a
        // formality.
        //
        // Hold for the reveal FIRST, then let the numbers move.
        if (allInPlayers.length >= 2) {
          await this.sleep(this.allInStreetRevealMs);
          if (!this.running || this.handController !== controller) break;
          // liveExtraBoards 2026-08-29: dealNextStreet fills boards 2/3 in
          // lockstep but returns only board 1, so this refresh had been
          // dropping to single-board pricing on every street of a multi-board
          // bomb pot. Read them from the controller instead.
          await this.broadcastAllInEquity(allInPlayers, result.board, pot, this.liveExtraBoards());
        }

        if (result.complete) break;
        await this.sleep(this.allInStreetPauseMs);
      }

      // Let the final percentages and the completed board sit for a moment
      // before the hand resolves and the pot ships.
      if (this.running && this.handController === controller) {
        await this.sleep(this.allInPreShowdownPauseMs);
      }
    } catch (err) {
      reportError(err, 'ServerTableEngine.' + this.tableId + '.paced_runout_failed');
    }

    // Always finish the hand, on every path. With the board already complete,
    // continueRunout's loop body does not execute - it goes straight to
    // showdown and completeHand, which is exactly what we want.
    if (this.handController === controller) {
      this.safeContinueRunout('paced_runout_complete', controller);
    }
  }

  /**
   * ═══ EVERY RUNOUT CONTINUATION NAMES ITS HAND (2026-08-31) ══════════════
   *
   * `controller` is the hand this continuation belongs to. This method used
   * to read this.handController bare, and it is called from catch handlers
   * and safety timers at the END of async flows full of sleeps and 20-second
   * offer windows - so a rejection surfacing after its hand had died called
   * continueRunout() on the NEXT hand's controller. Landing in dealHand's
   * window between assigning the new controller and subscribing/starting it
   * (there is an await on fetchTimeBankExtras in between), that ran the next
   * hand's board out into the void: sawFlop true, stage parked at showdown,
   * every event emitted to nobody. The hand then STARTED inside the corpse
   * and played to a raked walk - the rake-law alarm's no_flop_no_drop
   * criticals, 32 live hands. A stale continuation is dropped, loudly.
   */
  protected safeContinueRunout(reason: string, controller: HandController | null): void {
    if (this.runoutPayoutMutationUnsafe) {
      reportError(
        new Error('refused runout continuation after an external payout may have mutated stacks'),
        'ServerTableEngine.' + this.tableId + '.unsafe_runout_continuation_refused',
        { reason, handNumber: this.handCount }
      );
      this.killForRestart('unsafe_runout_continuation_after_payout');
      return;
    }
    if (!controller || this.handController !== controller) {
      reportError(
        new Error('stale runout continuation dropped (' + reason + ')'),
        'ServerTableEngine.' + this.tableId + '.stale_runout_dropped'
      );
      return;
    }
    if (controller.getPineappleRunoutDiscardSnapshot?.()) {
      void this.preparePineappleRunoutDiscards(controller)
        .then((prepared) => {
          if (!prepared || this.handController !== controller) return;
          if (this.runoutPayoutMutationUnsafe) {
            this.killForRestart('unsafe_pineapple_runout_continuation_after_payout');
            return;
          }
          try {
            controller.continueRunout();
          } catch (error) {
            reportError(error, 'ServerTableEngine.' + this.tableId + '.forced_runout_failed', {
              reason,
            });
            this.killForRestart('forced_runout_failed');
          }
        })
        .catch((error) => {
          if (error instanceof HorseDecisionAbortedError) return;
          reportError(
            error,
            'ServerTableEngine.' + this.tableId + '.pineapple_forced_runout_worker_failed',
            { reason }
          );
          if (this.handController === controller) {
            this.killForRestart('pineapple_forced_runout_worker_failed');
          }
        });
      return;
    }
    try {
      controller.continueRunout();
    } catch (err) {
      reportError(err, 'ServerTableEngine.' + this.tableId + '.forced_runout_failed', { reason });
      this.killForRestart('forced_runout_failed');
    }
  }

  /**
   * HORSE RIT RESPONSES 2026-08-18: schedule horse answers to a live offer.
   *
   * - A horse CHOOSER picks the board count: mostly 2, a third of hands 3
   *   (varied deterministically by hand number - no Math.random in the
   *   engine's decision paths).
   * - Horse RESPONDERS accept or decline. Accepting before the chooser
   *   has decided is safe: the consent-race fix in RunItTwiceEngine records
   *   the accept and completes only once the chooser picks.
   * - WHEN they answer is horseRitThinkMs: spread across the human window,
   *   not a fixed band (see that method for why).
   * - Every callback re-checks the offer is still pending and the hand is
   *   still the same one (watchdog force-completion, 10-minute void).
   */
  protected scheduleHorseRITResponses(chooserPlayerId: string, allPlayerIds: string[]): void {
    const handAtOffer = this.handCount;
    const horseIds = new Set(this.seatedPlayers.filter((p) => p.is_horse).map((p) => p.user_id));
    const respond = (delayMs: number, fn: () => void) => {
      setTimeout(() => {
        if (!this.running || this.handCount !== handAtOffer) return;
        if (!this.runItTwiceEngine.hasPendingOffer(this.tableId)) return;
        try {
          fn();
        } catch (err) {
          reportError(err, 'ServerTableEngine.' + this.tableId + '.horse_rit_response');
        }
      }, delayMs);
    };

    if (horseIds.has(chooserPlayerId)) {
      // A chooser who never picks 1 is a chooser who never runs it once.
      const runs =
        this.horseRitVerdict(chooserPlayerId) === 'once'
          ? (1 as const)
          : ((this.handCount % 3 === 0 ? 3 : 2) as 2 | 3);
      respond(this.horseRitThinkMs(chooserPlayerId, 'chooser'), () => {
        this.respondToRIT(chooserPlayerId, undefined, runs);
      });
    }
    for (const pid of allPlayerIds) {
      if (pid === chooserPlayerId || !horseIds.has(pid)) continue;
      const answer = this.horseRitVerdict(pid) === 'once' ? 'decline' : 'accept';
      respond(this.horseRitThinkMs(pid, 'responder'), () => {
        this.respondToRIT(pid, answer);
      });
    }
  }

  /**
   * ── A HORSE THAT ALWAYS SAYS YES IS NOT A PLAYER (2026-08-31) ──────────
   *
   * scheduleHorseRITResponses taught horses to answer the run-it-twice offer
   * on 2026-08-18, which fixed a real bug: before it, every offer at a table
   * with a horse in the all-in set expired and the hand always ran once. But
   * the answer it taught them was a constant. A horse chooser picked 2 or 3
   * every single time and a horse responder sent 'accept' every single time,
   * with no branch in the code that could ever produce anything else.
   *
   * Two things follow from that, and both are live on the floor today.
   *
   * First, section 10.5. A seat that has agreed to run it twice on every
   * all-in it has ever faced is identifiable from the outside without seeing
   * a single hole card - the same rhythm leak the insurance responder was
   * rewritten to close ("the old ~1s decline was a TELL"). Humans decline
   * this offer; a lot of them decline it always. A seat that cannot is
   * wearing a sign.
   *
   * Second, and this is what the Phase 3 sweep actually found: it silently
   * turned insurance off across the entire floor. checkAllInRunout asks the
   * RIT question FIRST (Dan's leader-seat sequencing, 2026-08-26) and only
   * reaches startInsuranceFlow() on the single-run branch. Every one of the
   * 27 live cash tables has both features on. So with horses unable to
   * decline, every multiway all-in resolved to RIT accepted, the single-run
   * branch was unreachable, and insurance was never offered: 270 hands in 24h
   * met every precondition for an offer and insurance_offer_events recorded
   * zero. The only rows that table has ever held came from four hand-built
   * INSURANCE test tables, all now closed. A whole priced feature was dark by
   * arithmetic, with nothing failing and nothing logging.
   *
   * The verdict is deterministic in (hand, player) rather than random so a
   * replay of a hand answers the same way twice, and so this is testable. It
   * is NOT a coin flip: 'once' lands on roughly three hands in ten, which is
   * inside the range of ordinary human decline rates and leaves run-it-twice
   * the common outcome it should be.
   *
   * This is not an is_horse EXCLUSION (section 10.5): it does not withhold
   * anything a human gets. It is the horse's input device choosing between
   * two answers a human chooses between, instead of being wired to one.
   */
  /**
   * ── AND A HORSE THAT ALWAYS ANSWERS IN THREE SECONDS IS NOT ONE EITHER ──
   *
   * The verdict above stopped the ANSWER being a tell on 2026-08-31. The
   * LATENCY still was: a horse chooser picked inside 1.2-2.2s and a horse
   * responder inside 2.5-3.7s, every hand, against a 25-second window that
   * humans use all of - a tap in two seconds, a think at eight, the odd
   * answer as the clock runs down. Section 10.5 says timing is part of the
   * treatment; a seat that never takes longer than four seconds to decide
   * whether to run it twice is wearing the same sign the always-yes seat
   * wore.
   *
   * Deterministic in (player, hand), like the verdict, so a replayed hand
   * answers at the same moment and the distribution is testable:
   *   - the bulk lands between ~1.5s and ~9s,
   *   - about one hand in six is a long think of ~10-19s,
   *   - never later than 20s of the 25s window (autoDeclineTimeout in
   *     ServerTableEngineBase), so a horse's answer can never be the one
   *     the DeadlineScheduler discards.
   * Responders sit a little later than the chooser on average, because a
   * responder is reading a question the chooser has just asked.
   */
  protected horseRitThinkMs(playerId: string, role: 'chooser' | 'responder'): number {
    let h = 0;
    for (let i = 0; i < playerId.length; i++) {
      h = (h * 33 + playerId.charCodeAt(i) + 7) % 1000003;
    }
    const mixed = (h + this.handCount * 131 + (role === 'responder' ? 17 : 0)) % 1000;
    const longThink = mixed % 6 === 0;
    const base = role === 'responder' ? 1500 : 1200;
    if (longThink) {
      // 10s .. 19s
      return 10_000 + Math.floor((mixed / 1000) * 9_000);
    }
    // base .. base + 7.5s
    return base + Math.floor((mixed / 1000) * 7_500);
  }

  protected horseRitVerdict(playerId: string): 'once' | 'multi' {
    let h = 0;
    for (let i = 0; i < playerId.length; i++) {
      h = (h * 31 + playerId.charCodeAt(i)) % 100000;
    }
    return (h + this.handCount * 7) % 10 < 3 ? 'once' : 'multi';
  }

  protected waitForRITResponse(onComplete: () => void): void {
    let completed = false;
    // Identity anchors. Without them a wait that outlives its hand (watchdog
    // force-completion, 10-minute void) resolves into the NEXT hand and runs
    // out its board at preflop.
    const controllerAtOffer = this.handController;
    const handAtOffer = this.handCount;
    const finish = () => {
      if (completed) return;
      completed = true;
      clearInterval(checkInterval);
      clearTimeout(safetyTimeout);
      if (!this.handController || this.handController !== controllerAtOffer) {
        reportError(
          new Error('RIT wait resolved into a different hand (#' + handAtOffer + ') - dropped'),
          'ServerTableEngine.' + this.tableId + '.rit_wait_stale'
        );
        return;
      }
      // onComplete drives dealAndResolveRIT / continueRunout / finalizeRunout —
      // the whole settlement cascade — inside a bare timer callback. A throw
      // escaped to the process handler with the interval and timeout ALREADY
      // cleared, so nothing would ever retry and the hand was dead.
      try {
        onComplete();
      } catch (err) {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.rit_oncomplete_threw');
        this.safeContinueRunout('rit_oncomplete_threw', controllerAtOffer);
      }
    };

    const checkInterval = setInterval(() => {
      const state = this.runItTwiceEngine.getState(this.tableId);
      // Complete when status is no longer 'offered' (accepted, declined, or resolved)
      if (!state || state.status !== 'offered') {
        finish();
      }
    }, 250);

    // FIX 98 → POKERBROS PARITY 2026-08-26: the offer window is one shared
    // 25-second countdown (engine autoDeclineTimeout). Safety = window + 5s
    // buffer; the DeadlineScheduler's auto-decline resolves the poll well
    // before this fires in any healthy process.
    const safetyTimeout = setTimeout(
      () => {
        finish();
      },
      this.runItTwiceEngine.offerTimeoutSeconds(this.tableId) * 1000 + 5_000
    );
  }

  /** The hand this seat has already been told ran once, so a decline
   *  followed by the timeout branch cannot toast the same player twice. */
  private ritSingleRunNotifiedHand = -1;

  /** True once wireRunItTwiceEvents has registered its forwarder. */
  private ritEventsWired = false;

  /**
   * ── THE RIT ENGINE'S OWN EVENTS REACH THE WIRE (2026-08-27) ─────────────
   *
   * `new RunItTwiceEngine((event) => console.log(...))` in
   * ServerTableEngineBase is the whole delivery mechanism for the engine's
   * lifecycle events, and it is a log line. The insurance engine two
   * declarations below forwards ACCEPTED / DECLINED / SETTLED to the hub; RIT
   * forwarded nothing, so the DeadlineScheduler's auto-decline — the one RIT
   * outcome no other code path announces — died in the process.
   *
   * WHAT IS FORWARDED, and why only this:
   *
   *   RIT_OFFERED   already on the wire as `rit_offer` (richer: chooser,
   *                 deadline_ts, pot, allPlayerIds)
   *   RIT_ACCEPTED  already on the wire as `rit_all_accepted` / `rit_mandatory`
   *   RIT_RESOLVED  already on the wire as `rit_result` (with the boards)
   *   RIT_DECLINED  forwarded ONLY when reason === 'timeout'
   *
   * Forwarding the first three would double-emit, and each engine event
   * carries strictly less than the broadcast it duplicates. A PLAYER decline
   * is likewise already announced, by respondToRIT, with the correct
   * `player_declined` reason and the correct player — forwarding that too
   * would race it and win with a worse reason. So this maps exactly one
   * unannounced engine event onto the EXISTING `rit_single_run` name, through
   * emitRitSingleRun, whose per-hand guard then makes the redundant
   * `no_agreement` that waitForRITResponse emits ~250ms later a no-op. One
   * notice per hand, no new client vocabulary.
   *
   * Registered through addEventListener rather than by assigning onEvent, so
   * the constructor callback and the tests that replace it both keep working.
   */
  protected wireRunItTwiceEvents(): void {
    if (this.ritEventsWired) return;
    this.ritEventsWired = true;
    this.runItTwiceEngine.addEventListener((event) => {
      if (event.type !== 'RIT_DECLINED') return;
      if ((event as Record<string, unknown>).reason !== 'timeout') return;
      /* TWO RULES, BOTH TRUE, COMPOSED (2026-09-14 merge).

         THE EVENT KNOWS WHICH HAND IT IS ABOUT. The DeadlineScheduler fires
         the auto-decline on its own clock, and this listener used to read
         `this.handCount` at FIRE time while the event carries its own
         `handId` - `${tableId}:${handCount}`, stamped when the offer was made.
         A timeout surfacing after the hand turned over toasted "Running It
         Once" on the NEXT hand and, because emitRitSingleRun stamps
         `ritSingleRunNotifiedHand`, SUPPRESSED that hand's own legitimate
         notice. One late timer, two wrong answers. So a stale hand is dropped
         here, before anything is announced.

         AND THE SEAT THAT HELD THINGS UP IS NAMED (2026-09-13). The engine's
         expiry lists who had not answered; exactly one silent seat can be
         named the way a decliner already is, and two or more keep the
         collective line. Both notices carry the hand they are about, so the
         naming cannot land on the wrong hand either. */
      const handId = (event as Record<string, unknown>).handId;
      if (typeof handId !== 'string') return;
      const declinedHand = Number(handId.slice(handId.lastIndexOf(':') + 1));
      if (!Number.isFinite(declinedHand) || declinedHand !== this.handCount) return;
      const unanswered = (event as Record<string, unknown>).unanswered;
      const silent = Array.isArray(unanswered)
        ? unanswered.filter((id) => typeof id === 'string')
        : [];
      if (silent.length === 1)
        this.emitRitSingleRun('no_answer', silent[0] as string, declinedHand);
      else this.emitRitSingleRun('no_agreement', undefined, declinedHand);
    });
  }

  /**
   * Announce that a Run It Twice offer ended in ONE board, and why.
   *
   * There was no event for this. `rit_result` is only emitted when two or more
   * boards are actually dealt, so the single-run outcome - a chooser picking 1,
   * an all-in opponent declining, or nobody answering inside the window - was
   * completely silent on the wire. All three are legitimate poker; none of them
   * should look like a broken feature.
   */
  /**
   * 2026-08-27: two more reasons, because two more paths silently ran one
   * board. `no_consent_recorded` is the resolver finding fewer than two
   * consented runs (Defect A's blast radius: a cleared, missing or unaccepted
   * offer must run once and SAY so); `deck_too_short` is the resolver refusing
   * to deal N boards it does not have cards for.
   *
   * Both are new strings on an existing event. TablePage's rit_single_run
   * handler maps the three known reasons to their own message and falls
   * through to "Running It Once. Not Everyone Agreed In Time." for anything
   * else, so an unrecognised reason degrades to the generic notice rather than
   * to silence — which is the whole point of the event. Giving these two their
   * own copy is a client change and is deliberately not made here.
   */
  protected emitRitSingleRun(
    reason:
      | 'chooser_chose_one'
      | 'player_declined'
      | 'no_agreement'
      /** 2026-09-13: the window closed with exactly ONE seat still silent; player_id names it. */
      | 'no_answer'
      | 'no_consent_recorded'
      | 'deck_too_short',
    playerId?: string,
    /**
     * The hand this notice is ABOUT. Defaults to the live hand, which is right
     * for every synchronous caller. A caller driven by a timer (the RIT
     * auto-decline forwarder) passes the hand captured when the offer was made,
     * so a late timeout cannot claim - or silence - a hand it never saw.
     */
    handNumber: number = this.handCount
  ): void {
    // A notice for a hand that is already over reaches players watching a
    // different one.
    if (handNumber !== this.handCount) return;
    if (this.ritSingleRunNotifiedHand === handNumber) return;
    this.ritSingleRunNotifiedHand = handNumber;
    try {
      this.hub?.emitEvent(this.tableId, {
        type: 'rit_single_run',
        table_id: this.tableId,
        hand_number: handNumber,
        reason,
        player_id: playerId ?? null,
      });
    } catch {
      /* broadcast failure is non-fatal */
    }
  }

  /**
   * FIX 97: Deal and resolve RIT (Run It Twice/Three Times).
   * N-player support with side pots.
   *
   * Flow:
   * 1. Get remaining deck cards from HandController
   * 2. Deal 2 or 3 independent boards from remaining deck
   * 3. For each board: evaluate each pot's eligible players → find winner
   * 4. Split each pot across boards (half/half or third/third/third)
   * 5. Sum up distributions and apply to stacks
   * 6. Broadcast results, then finalize the hand
   *
   * Bible V8 §4.20: Rake applies ONCE (not per board).
   */
  protected async dealAndResolveRIT(
    allInPlayers: import('../types.js').SeatPlayer[]
  ): Promise<void> {
    const controller = this.handController;
    if (!controller) return;
    const captureRollbackState = () => ({
      ritBoards: this.currentHandRitBoards,
      ritBaseBoardCount: this.currentHandRitBaseBoardCount,
      ritExtraBoards: this.currentHandRitExtraBoards.map((board) => [...board]),
      communityCards: [...this.currentHandCommunityCards],
      actions: [...this.currentHandActions],
      pots: this.currentHandPots.map((pot) => ({ ...pot, eligible: [...pot.eligible] })),
      perPotAwards: this.currentHandPerPotAwards.map((award) => ({ ...award })),
      winnersByBoard: this.currentHandWinnersByBoard.map((winner) => ({ ...winner })),
    });
    let before: ReturnType<typeof captureRollbackState> | null = null;
    let handCompleteObserved = false;
    let unsubscribeCompletionProof: () => void = () => {};

    try {
      if (this.ritResolutionOwner) {
        reportError(
          new Error(
            'duplicate RIT resolution refused while the prior resolution still owns the hand'
          ),
          'ServerTableEngine.' + this.tableId + '.duplicate_rit_resolution_refused',
          { handNumber: this.handCount, payoutMutationUnsafe: this.runoutPayoutMutationUnsafe }
        );
        if (this.runoutPayoutMutationUnsafe) {
          this.killForRestart('duplicate_rit_resolution_after_payout_mutation');
        }
        return;
      }
      this.ritResolutionOwner = controller;

      // This wrapper is the sole terminal boundary for every asynchronous RIT
      // resolver phase, including setup. Once creditRunoutWinnings starts there
      // is no legal fallback to the ordinary path: that path pays the pot again.
      before = captureRollbackState();
      this.runoutPayoutMutationUnsafe = false;
      unsubscribeCompletionProof = controller.onEvent((event) => {
        if (
          event.type === 'HAND_COMPLETE' &&
          event.handNumber === this.handCount &&
          this.runoutPayoutMutationUnsafe &&
          this.ritResolutionOwner === controller
        ) {
          handCompleteObserved = true;
        }
      });
      await this.dealAndResolveRITUnchecked(allInPlayers, controller);
      if (this.runoutPayoutMutationUnsafe && !handCompleteObserved) {
        throw new Error('RIT payout mutation completed without HAND_COMPLETE proof');
      }
      if (this.ritResolutionOwner === controller) {
        this.runoutPayoutMutationUnsafe = false;
        this.ritResolutionOwner = null;
      }
    } catch (error) {
      const phase = this.runoutPayoutMutationUnsafe ? 'post_credit' : 'pre_credit';
      reportError(error, 'ServerTableEngine.' + this.tableId + '.rit_resolution_failed', {
        phase,
        handNumber: this.handCount,
      });

      if (this.runoutPayoutMutationUnsafe) {
        // Stack credit may be partial or complete, and HAND_COMPLETE has not
        // been proved. Quarantine this generation so authoritative crash
        // recovery decides the hand exactly once. Never call continueRunout.
        this.killForRestart('rit_resolution_failed_after_payout_mutation');
        return;
      }

      if (this.ritResolutionOwner === controller) this.ritResolutionOwner = null;
      if (this.handController !== controller) return;

      // No payout mutation started. Restore every RIT-only capture before the
      // normal single-board path writes its own board, pots, and action trail.
      if (before) {
        this.currentHandRitBoards = before.ritBoards;
        this.currentHandRitBaseBoardCount = before.ritBaseBoardCount;
        this.currentHandRitExtraBoards = before.ritExtraBoards;
        this.currentHandCommunityCards = before.communityCards;
        this.currentHandActions = before.actions;
        this.currentHandPots = before.pots;
        this.currentHandPerPotAwards = before.perPotAwards;
        this.currentHandWinnersByBoard = before.winnersByBoard;
      }
      this.safeContinueRunout('rit_resolution_failed_before_payout', controller);
    } finally {
      try {
        unsubscribeCompletionProof();
      } catch (error) {
        reportError(
          error,
          'ServerTableEngine.' + this.tableId + '.rit_completion_proof_unsubscribe_failed',
          { handNumber: this.handCount }
        );
      }
    }
  }

  /**
   * The RIT calculation itself. All callers go through dealAndResolveRIT so a
   * rejected worker job or synchronous settlement throw cannot escape without
   * being classified against the payout mutation fence.
   */
  private async dealAndResolveRITUnchecked(
    allInPlayers: import('../types.js').SeatPlayer[],
    controller: HandController
  ): Promise<void> {
    const runs = this.runItTwiceEngine.getChosenRuns(this.tableId);
    // RIT VERIFIER FIX 2026-08-21: the verifier needs to know this hand
    // resolved across multiple boards (see currentHandRitBoards).
    this.currentHandRitBoards = runs >= 2 ? runs : 0;
    if (runs < 2) {
      /**
       * Fewer than two CONSENTED runs. Since 2026-08-27 getChosenRuns() is 1
       * whenever there is no accepted offer on this table, so this branch is
       * also the landing point for the missing-consent case that used to deal
       * the table MAXIMUM instead (production hand #3046089, three boards, no
       * prompt shown to anybody).
       *
       * It said nothing before. A player who had just been asked to run it
       * twice saw one board and no explanation, which is indistinguishable
       * from the feature being broken.
       */
      this.emitRitSingleRun('no_consent_recorded');
      // Dan 2026-08-20: continueRunout() is the INSTANT synchronous loop —
      // flop, turn and river all land in one tick with no equity updates. A
      // hand that ends up running ONCE must still be watchable, exactly like
      // the ordinary all-in path. Pace it.
      void this.pacedAllInRunout(allInPlayers, controller.getState().pot);
      return;
    }

    const existingBoard = controller.getCommunityCards();
    const remainingDeck = controller.getRemainingDeck();
    const cardsNeeded = 5 - existingBoard.length;
    // POKERBROS PARITY 2026-08-26: the hand-completion hold sizes itself from
    // this — the client reveals each board street by street from here.
    this.currentHandRitBaseBoardCount = existingBoard.length;

    if (remainingDeck.length < cardsNeeded * runs) {
      reportError(
        new Error(
          `[ServerTableEngine:${this.tableId}] RIT: Not enough cards for ${runs} runouts (need ${cardsNeeded * runs}, have ${remainingDeck.length})`
        ),
        `ServerTableEngine.${this.tableId}.rit_insufficient_deck`
      );
      /**
       * 2026-08-27: this path had BOTH silent-fallback defects at once. It
       * announced nothing — players who had all consented to two or three
       * boards got one, with no event to explain it — and it finished the hand
       * through continueRunout(), the instant synchronous loop that lands
       * flop, turn and river in a single tick with no equity refresh. Every
       * other "we are running once after all" path was switched to the paced
       * runout on 2026-08-20; this one was missed.
       *
       * The RIT VERIFIER also has to be told: currentHandRitBoards was set to
       * `runs` a few lines above on the assumption that N boards were about to
       * be dealt. One board is dealt. Left as it was, settlement would record
       * a multi-board hand that never happened.
       */
      this.currentHandRitBoards = 0;
      this.currentHandRitBaseBoardCount = 0;
      this.emitRitSingleRun('deck_too_short');
      void this.pacedAllInRunout(allInPlayers, controller.getState().pot);
      return;
    }

    // Deal independent boards
    const boards: import('../types.js').Card[][] = [];
    for (let r = 0; r < runs; r++) {
      const runCards = remainingDeck.slice(r * cardsNeeded, (r + 1) * cardsNeeded);
      boards.push([...existingBoard, ...runCards]);
    }

    // RIT builds its boards outside HandController, so it never reaches the
    // normal flop-deal hook. Resolve the same all-in two-card invariant here,
    // on the canonical first run, before any pot is evaluated or credited.
    if (controller.getPineappleRunoutDiscardSnapshot?.()) {
      try {
        if (!(await this.preparePineappleRunoutDiscards(controller))) return;
      } catch (error) {
        if (error instanceof HorseDecisionAbortedError) return;
        throw error;
      }
      if (
        this.handController !== controller ||
        !controller.commitPreparedPineappleRunoutDiscards(boards[0].slice(0, 3))
      ) {
        throw new Error('Pineapple RIT discard result did not match the canonical first flop');
      }
      const currentPlayers = controller.getState().players;
      allInPlayers = allInPlayers.map(
        (player) => currentPlayers.find((current) => current.seat === player.seat) ?? player
      );
    }

    // HAND HISTORY 2026-08-18: these boards are built OUTSIDE HandController,
    // so no COMMUNITY_CARDS events fire and currentHandCommunityCards stays
    // at the pre-all-in board - a preflop all-in RIT hand recorded NO board
    // at all. Record board 0 (the canonical, BBJ-eligible board) as the
    // hand's community cards and append each extra runout to the action log,
    // so the full multi-board hand is reconstructable from the record.
    this.currentHandCommunityCards = boards[0].map((c) => `${c.rank}${c.suit}`);
    // COMPLETENESS PASS 2026-08-26: boards 2..N go to hand_history.rit_boards
    // first-class at settlement; the pseudo-actions below stay for replayers
    // of the 5M rows that predate the column.
    this.currentHandRitExtraBoards = boards.slice(1).map((b) => b.map((c) => `${c.rank}${c.suit}`));
    for (let b = 1; b < boards.length; b++) {
      this.currentHandActions.push({
        seat: 0,
        userId: 'system',
        action: 'rit_board_' + (b + 1) + ':' + boards[b].map((c) => `${c.rank}${c.suit}`).join(','),
        stage: 'river',
        timestamp: Date.now(),
      });
    }

    // AUDIT FIX 2026-07-19: RIT previously read getPots() — which is `[]` until
    // completeHand() runs (after RIT) — so NOBODY was paid and the whole pot was
    // destroyed; it also distributed the full pot with NO rake while
    // finalizeRunout reported rake as collected (minting chips). Now we:
    //   1. return the uncalled bet (completeHand's rule, which RIT skips),
    //   2. compute LIVE pots from contributions,
    //   3. evaluate each board with determineWinners (correct for split pots,
    //      short-deck, and PLO8 hi-lo — the old ad-hoc evaluator ignored all of
    //      these), taking each board's 1/runs share,
    //   4. deduct rake + BBJ ONCE (Bible V8 §4.20) before crediting stacks.
    // RAKE LEAK FIX 2026-08-18: every RIT board is dealt to 5 cards, so the
    // flop is definitionally seen - but state.sawFlop is only set by the
    // normal street flow, which RIT bypasses. Without this, a preflop all-in
    // that ran it twice paid no rake and no BBJ fee (noFlopNoDrop short-
    // circuit), while the identical hand run once... also leaked, fixed the
    // same day in runOutCommunityCards. Idempotent when the all-in came
    // postflop.
    controller.markFlopSeen();
    controller.settleUncalledBet();
    const pots = controller.computeLivePots();

    /**
     * ── THE POT BREAKDOWN EXISTS ONLY HERE ON A RIT HAND (2026-09-05) ──
     *
     * `currentHandPots` is normally captured in the WINNERS handler
     * (ServerTableEngineHandEvents), guarded by `hasWinners && state.pots`.
     * Neither holds on this path: `finalizeRunout(true)` emits WINNERS with an
     * empty array, and `state.pots` is only ever assigned inside
     * `completeHandInner()`, which RIT skips entirely.
     *
     * The consequences were silent and real, on every run-it-twice hand:
     *   • `hand_history.pots` was written EMPTY, so the knockout sweep could
     *     not tell which pot held a busted player's last chips, and no audit
     *     could reconstruct the side-pot structure of the hand;
     *   • `pot_distributed` shipped `pots: []` (it reads the same capture), so
     *     the client was told a hand with a main pot and two side pots had no
     *     pots at all.
     *
     * These are the live pots the boards below are actually evaluated against,
     * with `eligiblePlayers` still intact — the exact shape the WINNERS
     * capture produces, recorded at the one moment it is knowable.
     */
    this.currentHandPots = pots.map((p, index) => ({
      index,
      // Cents, not floats - same rule as the WINNERS capture. This record is
      // what hand_history.pots is written from.
      amount: Math.round((Number(p?.amount) || 0) * 100) / 100,
      eligible: Array.isArray(p?.eligiblePlayers)
        ? p.eligiblePlayers.map((u) => String(u ?? '')).filter(Boolean)
        : [],
    }));
    const variant = controller.getVariant();
    const dealerSeat = controller.getDealerSeat();
    const state = controller.getState();

    // Distribution: playerId → total chips won across all boards (pre-rake).
    const rawDistribution = new Map<string, number>();
    // MULTIWAY DISPLAY 2026-08-18: exact winner set per board (side pots and
    // splits included), so the client can label each run with who took it.
    const perBoardWinners: string[][] = [];
    // POKERBROS PARITY 2026-08-26: keep the UNMERGED (run, pot, winner)
    // records too. These feed pot_win's pot_awards groups with the RUN as the
    // board axis, so the client ships each board's pots individually — chips
    // fan per pot per board, split pots fan to every winner of that share
    // with their own "+N" float, exactly like the single-board sequence.
    const perBoardPotAwards: Array<{
      board: number;
      userId: string;
      potIndex: number;
      low: boolean;
      amount: number;
      hand?: import('../types.js').EvaluatedHand;
    }> = [];
    /**
     * ── EACH BOARD SETTLES A REAL SLICE OF EVERY POT (2026-09-05) ──
     *
     * This used to evaluate every board against the FULL pots and then divide
     * the winner's entitlement by `runs` — `w.amount / runs`, in floating
     * point, with no rule for the odd cent. Nothing was lost (credited totals
     * are repaired downstream by scaleWinnerCentsForRake, display shares by
     * the per-player penny repair below), but two things were true that
     * should not have been:
     *
     *   • float dust entered the pre-rake distribution, so the repair was
     *     covering for arithmetic rather than only for rake;
     *   • WHICH run carried the odd cent was whatever the rounding happened
     *     to do — not a rule anyone could state, reproduce, or defend to a
     *     player asking why board 2 paid a cent more than board 3.
     *
     * The split now happens ONCE, up front, in integer cents: every pot is cut
     * into `runs` slices and the leftover cents go to the EARLIEST runs — the
     * first board carries the odd chip, which is the live-poker convention and
     * the one thing about it a player can actually be told.
     *
     * Each board then settles its own slice through the ordinary path, so
     * `determineWinners` still handles hi-lo halves and `distributePot` still
     * hands an odd chip inside a chop to the first seat clockwise of the
     * button, exactly as on a single-board hand. No division survives in the
     * loop below.
     *
     * Conservation is exact by construction: a pot's slices sum to
     * `base * runs + remainder`, which is the pot, to the cent.
     */
    /**
     * ── AND THE SLICE IS A WHOLE UNIT OF WHATEVER IS ON THE TABLE (2026-09-12) ──
     *
     * The rule above was written in integer CENTS, which is the indivisible
     * unit of a chip and half of a Diamond. A five Diamond pot over two runs is
     * 250 cents a board, which is two and a half Diamonds, and every Diamond
     * guard refuses a fractional amount outright - which is why run it twice
     * was CLOSED for Diamond rather than merely untested.
     *
     * The unit is now read from the table: one cent for chips, one hundred for
     * a Diamond, the same `unitCents` HandController's own payout math uses.
     * The stated rule does not change and neither does the chip arithmetic -
     * unitCents is 1 there, so `units === cents` by construction. Only what the
     * rule counts in changes.
     */
    const unitCents = this.tableInfo?.arena?.asset === 'diamonds' ? 100 : 1;
    const potSlicesByBoard: Array<typeof pots> = Array.from({ length: runs }, () => []);
    for (const p of pots) {
      const cents = Math.round((Number(p.amount) || 0) * 100);
      const units = Math.round(cents / unitCents);
      const base = Math.floor(units / runs);
      const remainder = units - base * runs;
      for (let b = 0; b < runs; b++) {
        potSlicesByBoard[b].push({
          ...p,
          amount: ((base + (b < remainder ? 1 : 0)) * unitCents) / 100,
        });
      }
    }

    for (let boardIdx = 0; boardIdx < runs; boardIdx++) {
      const board = boards[boardIdx];
      // determineWinners handles hi-lo split, short-deck, ties/odd-chip.
      // The RETURNED winners are merged per user (the settlement contract);
      // perPotOut is the UNMERGED (pot, hi/lo half, winner) breakdown — the
      // only source that still knows which pot each share came from, which
      // the per-board ship sequence needs.
      const perPotOut: import('../types.js').PerPotAward[] = [];
      const boardWinnersFull = determineWinners(
        state.players,
        board,
        potSlicesByBoard[boardIdx],
        variant,
        dealerSeat,
        perPotOut,
        /* No eligibility-fallback collector here; the slice below is the unit
           this board may chop a tie in, and for a Diamond that is one Diamond,
           not one cent. Without it a two-way tie on a Diamond board pays .50
           and the accepted-hand guard refuses the whole hand. */
        undefined,
        unitCents / 100
      );
      perBoardWinners.push([...new Set(boardWinnersFull.map((w) => w.userId))]);
      for (const w of boardWinnersFull) {
        rawDistribution.set(w.userId, (rawDistribution.get(w.userId) || 0) + w.amount);
      }
      for (const a of perPotOut) {
        perBoardPotAwards.push({
          board: boardIdx + 1,
          userId: a.userId,
          potIndex: a.potIndex,
          low: a.low,
          amount: a.amount,
          hand: a.hand,
        });
      }
    }

    // Deduct rake + BBJ once, scaling every winner proportionally (integer cents).
    /* SNAPPED TO CENTS AT THE SOURCE (2026-09-09). `totalPot` is a float
       `reduce` over the pot layers, so it carries the ordinary += drift, and
       both values below travel: `netPot` ships as `pot_distributed.net_pot`,
       and `totalPot` is written to `currentHandPotSize`, which is snapshotted
       into the rake record (ServerTableEngineSettlement) and broadcast as
       `pot_distributed.total_pot` - the number the client stores as its
       "Biggest Pot" tile. Every sibling money field in the same payload is
       already repaired to cents; these two were the exceptions, so a table's
       headline pot could read 34.050000000000004. Rounding here fixes both
       fields and the rake record at once, and `rakeScale` below (netPot /
       totalPot) is measured on the same repaired numbers. */
    const totalPot = Math.round(pots.reduce((sum, p) => sum + p.amount, 0) * 100) / 100;
    const { rake, bbjFee } = controller.computeRakeAndBBJ();
    const netPot = Math.max(0, Math.round((totalPot - rake - bbjFee) * 100) / 100);

    // Scale every winner's pre-rake share down to the post-rake total.
    //
    // 2026-08-23: this was a bespoke proportional-scale-plus-repair loop whose
    // positive drift cent went to the FIRST map entry unconditionally — a
    // board-0 main-pot winner, exactly the defect scaleWinnerCentsForRake was
    // extracted and rewritten for in completeHand (see HandController.ts). Two
    // implementations of the same money math is how one of them stays wrong;
    // this path now uses the shared, entitlement-capped, regression-tested one.
    const rawEntries = [...rawDistribution.entries()];
    const scaledCents = scaleWinnerCentsForRake(
      rawEntries.map(([, amount]) => amount),
      netPot
    );
    const totalDistribution = new Map<string, number>();
    rawEntries.forEach(([pid], i) => {
      totalDistribution.set(pid, scaledCents[i] / 100);
    });

    /**
     * ── TOURNAMENT BACKSTOP: chips are INTEGERS (2026-08-26) ──
     *
     * RIT is CASH-ONLY by Dan's ruling (2026-08-26): "run it twice or 3
     * times is a cash game only area. it should never be in MTT, SPINS OR
     * HEADS UP." The Base configure gate refuses to enable RIT on any
     * tournament table, so this branch is UNREACHABLE in a healthy system.
     *
     * It stays as defense in depth, because the failure mode is real money:
     * per-board splits produce fractional amounts while
     * tournament_players.chips is INTEGER — the sync floors (tables.ts), and
     * live 3-run tournament hand 41627f9a split 1760.88 into fractional
     * chips and destroyed the difference before the gate existed. If the
     * gate ever regresses, this branch floors every winner's credited total
     * to whole chips and hands the remaining odd chips out one at a time
     * CLOCKWISE FROM THE DEALER (distributePot's own chop convention),
     * conserving the pot to the chip instead of destroying the fraction.
     */
    const ritIsTournamentHand =
      !!this.tableInfo?.tournament_id || this.tableInfo?.game_type === 'tournament';
    /* A DIAMOND TAKES THE SAME BACKSTOP (2026-09-12), and for the same reason a
       tournament chip does: the stack it lands in is an integer everywhere it
       is stored, and the accepted-hand guard refuses a fraction rather than
       flooring it. The slicing and the tie-chop above already work in whole
       Diamonds, so this should never have anything to do - which is exactly
       what defense in depth means here. */
    const ritNeedsWholeUnits = ritIsTournamentHand || this.tableInfo?.arena?.asset === 'diamonds';
    if (ritNeedsWholeUnits && totalDistribution.size > 0) {
      const seatOf = new Map<string, number>();
      for (const p of state.players) seatOf.set(p.user_id, p.seat);
      const maxSeat = Math.max(...state.players.map((p) => p.seat), dealerSeat ?? 0) + 1;
      const clockwiseFromDealer = (seat: number) => {
        const d = (seat - (dealerSeat ?? 0) + maxSeat * 10) % maxSeat;
        // The dealer itself sorts LAST — the first seat to the dealer's left
        // gets the first odd chip, standard live-poker convention.
        return d === 0 ? maxSeat : d;
      };
      const entries = [...totalDistribution.entries()].sort(
        (a, b) =>
          clockwiseFromDealer(seatOf.get(a[0]) ?? 0) - clockwiseFromDealer(seatOf.get(b[0]) ?? 0)
      );
      const totalChips = Math.round(entries.reduce((s, [, amt]) => s + amt, 0));
      const floors = entries.map(([, amt]) => Math.floor(amt + 1e-9));
      let oddChips = totalChips - floors.reduce((s, f) => s + f, 0);
      for (let i = 0; i < entries.length && oddChips > 0; i++) {
        floors[i] += 1;
        oddChips -= 1;
      }
      entries.forEach(([pid], i) => totalDistribution.set(pid, floors[i]));
    }

    // POKERBROS PARITY 2026-08-26: publish the unmerged per-(run, pot)
    // breakdown through the SAME presentation state the single-board path
    // uses, so pot_win carries pot_awards groups ordered run 1 → run N,
    // main pot → side pots, and the client's sequenced ship animation plays
    // each board's pots as separate beats (splits fan to every winner).
    // Amounts here are DISPLAY shares scaled to the post-rake pot; the flat
    // winners[] built below from totalDistribution stays authoritative.
    const rakeScale = totalPot > 0 ? netPot / totalPot : 1;
    this.currentHandPerPotAwards = perBoardPotAwards.map((a) => ({
      userId: a.userId,
      potIndex: a.potIndex,
      low: a.low,
      amount: Math.round(a.amount * rakeScale * 100) / 100,
      hand: a.hand,
      board: a.board,
      handDescription: a.hand ? describeHand(a.hand) : undefined,
    }));
    // Tournament chips are whole numbers on screen too: round each display
    // share to integer chips first — the per-player repair below then folds
    // any drift into the largest share, and since the credited totals are
    // integers (odd-chip block above) every "+N" float and run label lands
    // on a whole number.
    if (ritNeedsWholeUnits) {
      for (const a of this.currentHandPerPotAwards) a.amount = Math.round(a.amount);
    }
    // EXACTNESS PASS 2026-08-26: per-player penny repair. Each display share
    // above was rounded independently, so a player's shares could sum a cent
    // or two away from their CREDITED total (scaleWinnerCentsForRake). The
    // "+N" floats ride these shares and the pot counter decrements by them —
    // a drifted cent shows a player floats that do not add up to what their
    // stack actually rose, and leaves the pot pill parked at 0.01. Repair:
    // fold each player's drift into their single largest share, so every
    // player's display shares sum EXACTLY to their credited total (and the
    // grand total therefore matches the net pot to the cent).
    {
      const shareCentsByPlayer = new Map<string, number>();
      for (const a of this.currentHandPerPotAwards) {
        shareCentsByPlayer.set(
          a.userId,
          (shareCentsByPlayer.get(a.userId) ?? 0) + Math.round(a.amount * 100)
        );
      }
      for (const [pid, credited] of totalDistribution) {
        const creditedCents = Math.round(credited * 100);
        const displayCents = shareCentsByPlayer.get(pid) ?? 0;
        const driftCents = creditedCents - displayCents;
        if (driftCents === 0) continue;
        let largest: (typeof this.currentHandPerPotAwards)[number] | null = null;
        for (const a of this.currentHandPerPotAwards) {
          if (a.userId !== pid) continue;
          if (!largest || a.amount > largest.amount) largest = a;
        }
        if (largest) {
          largest.amount = Math.max(0, (Math.round(largest.amount * 100) + driftCents) / 100);
        }
      }
    }
    // Per-run winner labels (who took each run, with what, for how much) —
    // the run headers on the felt read these off pot_win's winners_by_board.
    {
      const byRunWinner = new Map<
        string,
        {
          board: number;
          userId: string;
          amount: number;
          handName?: string;
          low?: boolean;
          pots: Array<{ index: number; amount: number }>;
        }
      >();
      for (const a of this.currentHandPerPotAwards) {
        // One entry per (run, winner, half): a PLO8 scoop on a run is two.
        const low = a.low === true;
        const key = `${a.board ?? 1}|${a.userId}|${low ? 'lo' : 'hi'}`;
        const existing = byRunWinner.get(key);
        /* THE POT AXIS SURVIVES THE MERGE (2026-09-13). A three-way all-in
           that runs it twice pays each board out of a main pot AND a side
           pot; the row is per (run, winner, half), so the merge used to sum
           the pot axis away and the record could say who won which board
           but never which pot. The slices keep it, main pot first. */
        const slice = { index: Number(a.potIndex) || 0, amount: a.amount };
        if (existing) {
          // To the cent, as the single-board sibling does
          // (HandController, currentHandWinners): this accumulator is
          // written verbatim into hand_history.winners_by_board (jsonb,
          // no scale).
          existing.amount = Math.round((existing.amount + a.amount) * 100) / 100;
          existing.pots.push(slice);
        } else {
          byRunWinner.set(key, {
            board: a.board ?? 1,
            userId: a.userId,
            amount: a.amount,
            handName: a.hand?.name,
            ...(low ? { low: true } : {}),
            pots: [slice],
          });
        }
      }
      this.currentHandWinnersByBoard = [...byRunWinner.values()]
        .map((row) => ({ ...row, pots: row.pots.sort((x, y) => x.index - y.index) }))
        .sort((x, y) => x.board - y.board);
    }

    // Apply distributions to player stacks
    //
    // 2026-08-18: credit the ENGINE state through HandController, not the copy
    // getState() hands back. finalizeRunout(true) below emits WINNERS [], whose
    // handler runs `localPlayer.stack = enginePlayer.stack` off a fresh
    // getState() — so whatever is not written into the real state gets
    // overwritten a moment later. Crediting the copy silently destroyed the
    // whole pot on every multi-board RIT hand.
    //
    // seatedPlayers are deliberately NOT credited here: the WINNERS sync is
    // the single path that copies engine stacks outward, and doing it twice
    // would double-count if the two ever drift.
    // Arm before entering the mutator: a fault-injected or future mutator can
    // throw after applying only part of the map. From this instruction until
    // finalizeRunout returns, ordinary continuation is financially unsafe.
    this.runoutPayoutMutationUnsafe = true;
    controller.creditRunoutWinnings(totalDistribution);

    // ── Showdown reveal (review fix 2026-08-25: emitted BEFORE rit_result) ──
    // The client's presentation order is reveal-then-boards-then-pots; when
    // rit_result arrived first the board labels rendered against still-hidden
    // hands for one beat. Evaluator + reveal metadata are built here so the
    // discrete showdown event precedes every result event, matching the
    // single-run path (SHOWDOWN before WINNERS).
    const isOmaha = isOmahaVariant(variant);
    const isShortDeck = variant === 'short_deck';
    const boardEvaluator = isOmaha
      ? evaluateOmahaHand
      : (h: import('../types.js').Card[], c: import('../types.js').Card[]) =>
          evaluateHand(h, c, isShortDeck);
    const firstBoard = boards[0];
    // SHOWDOWN POLISH 2026-08-25 (RIT parity): a run-it-twice hand is an
    // all-in showdown, so it gets the SAME reveal metadata as every other
    // showdown. Review fix: honor spec 2 here too — if a street aggressor
    // exists (the all-in came from a bet/raise), THEY show first and the
    // reveal proceeds clockwise from them; otherwise clockwise from the seat
    // left of the button, exactly like getFirstShowdownSeat's checked-river
    // rule. Mucked is always false (all-in hands are force-exposed).
    const ritAggressorSeat =
      typeof state.lastAggressorSeat === 'number' ? state.lastAggressorSeat : -1;
    const ritAnchorSeat = ritAggressorSeat >= 0 ? ritAggressorSeat : (dealerSeat ?? 0);
    const maxRitSeat = Math.max(...allInPlayers.map((p) => p.seat), ritAnchorSeat) + 1;
    const ritClockwise = (seat: number) => {
      const d = (seat - ritAnchorSeat + maxRitSeat * 10) % maxRitSeat;
      // Aggressor anchor: distance 0 (the aggressor) sorts FIRST. Button
      // anchor: distance 0 (the button) sorts LAST, so the seat to its left
      // leads — the standard checked-down order.
      return d === 0 && ritAggressorSeat < 0 ? maxRitSeat : d;
    };
    const ritOrdered = allInPlayers
      .filter((p) => p.cards && p.cards.length > 0)
      .sort((a, b) => ritClockwise(a.seat) - ritClockwise(b.seat));
    this.currentHandShowdownResults = ritOrdered.map((p, i) => {
      const hand = boardEvaluator(p.cards, firstBoard);
      return {
        userId: p.user_id,
        handRanking: hand.ranking ?? 0,
        handName: hand.name ?? '',
        kickers: hand.kickers ?? [],
        holeCards: p.cards.map((c) => ({ rank: c.rank, suit: c.suit })),
        seat: p.seat,
        revealOrder: i,
        mucked: false,
        handDescription: describeHand(hand),
      };
    });
    // Review fix 2026-08-25: RIT hands are showdowns — count them in the
    // showdown metrics like every single-run showdown (muck total untouched:
    // nothing can muck an all-in reveal).
    try {
      EngineMetrics.showdownHandsTotal.inc();
    } catch {
      /* metrics must never break settlement */
    }
    this.hub?.emitEvent(this.tableId, {
      type: 'showdown',
      table_id: this.tableId,
      hand_number: this.handCount,
      results: this.currentHandShowdownResults.map((r) => ({
        user_id: r.userId,
        seat: r.seat ?? -1,
        reveal_order: r.revealOrder ?? 0,
        mucked: false,
        hand_name: r.handName,
        hand_ranking: r.handRanking,
        hand_description: r.handDescription ?? '',
      })),
    });

    // Broadcast RIT results
    this.hub?.emitEvent(this.tableId, {
      type: 'rit_result',
      table_id: this.tableId,
      hand_number: this.handCount,
      runs,
      boards: boards.map((b) => b.map((c) => `${c.rank}${c.suit}`)),
      distribution: Object.fromEntries(totalDistribution),
      // Exact winners of each run (splits/side pots included) for the
      // client's per-board "won by" labels.
      per_board_winners: perBoardWinners,
      /* THE ENGINE'S OWN VERDICT PER BOARD (2026-09-04 second sweep). The
         client used to re-evaluate each board with bestFive on whatever hole
         cards it could see: on a hi-lo variant that labelled the LOW winner
         with their high hand and lit the wrong five cards, and on a split it
         called a hi/lo divide a "Chop". These are the post-rake shares the
         pot actually ships, with the half named. board is 1-based, like
         winners_by_board. */
      per_board_awards: this.currentHandPerPotAwards.map((a) => ({
        board: a.board ?? 1,
        user_id: a.userId,
        amount: a.amount,
        low: a.low === true,
        hand_name: a.hand?.name ?? null,
        cards: a.hand?.cards ?? [],
      })),
      // What is actually paid out across every run, after rake and drops.
      // The felt's per-board share labels divide THIS, not the gross pot.
      net_pot: netPot,
      pots: pots.map((p) => ({ amount: p.amount, eligiblePlayers: p.eligiblePlayers })),
      // POKERBROS PARITY 2026-08-26: how many community cards were already on
      // the felt when the all-in locked. The client reveals boards street by
      // street from this point (a turn all-in re-deals only rivers; a preflop
      // all-in re-deals whole boards), at the paced-runout cadence.
      base_board_count: existingBoard.length,
    });

    // Resolve in RIT engine (for event emission and cleanup)
    // Use first eligible winner per board for the engine's simpler tracking.
    // (boardEvaluator defined above, before the showdown emit.)
    const boardWinners = boards.map((board) => {
      let best: import('../types.js').EvaluatedHand | null = null;
      let winnerId = '';
      for (const p of allInPlayers) {
        if (!p.cards || p.cards.length === 0) continue;
        const hand = boardEvaluator(p.cards, board);
        if (!best || compareHands(hand, best) > 0) {
          best = hand;
          winnerId = p.user_id;
        }
      }
      return winnerId;
    });

    this.runItTwiceEngine.resolve(
      this.tableId,
      boardWinners[0] || '',
      boardWinners[1] || '',
      boardWinners[2]
    );

    // Bad Beat Jackpot on Run-It-Twice — RULE (Dan, 2026-07-21): the FIRST board
    // only is eligible. The other boards fund the pool (the BBJ fee is collected
    // once in computeRakeAndBBJ above) but cannot trigger the jackpot. Populate
    // the showdown state for board 0 so the existing HAND_COMPLETE BBJ block
    // (finalizeRunout emits HAND_COMPLETE) evaluates a bad beat on it. Previously
    // RIT never emitted SHOWDOWN/WINNERS, so these stayed empty and the BBJ block
    // was skipped entirely — a qualifying bad beat on a run-it-twice hand could
    // never win the jackpot even though the fee was still taken.
    // (Showdown reveal metadata was built and emitted above, before
    // rit_result — review fix 2026-08-25. The BBJ block still reads
    // this.currentHandShowdownResults for board 0.)
    this.currentHandWinnerIds = boardWinners[0] ? [boardWinners[0]] : [];
    // E1 FIX 2026-08-18 (Master Gap Ledger): `currentHandWinners` was never
    // pre-set on the RIT path, so finalizeRunout(true)'s empty WINNERS event
    // left it [] - hand_history recorded no winners, and pot_win /
    // pot_distributed carried empty per-winner data for EVERY run-it-twice
    // hand (stacks were correct; the record and animations were blank).
    // Populate both from the actual net distribution. Order matters on the
    // ids: index 0 must stay the board-0 winner because detectBBJHit reads
    // currentHandWinnerIds[0] (board 0 is the only BBJ-eligible board per
    // Dan's 2026-07-21 rule); other paid players are appended after it.
    for (const [playerId, amount] of totalDistribution) {
      if (amount > 0 && !this.currentHandWinnerIds.includes(playerId)) {
        this.currentHandWinnerIds.push(playerId);
      }
    }
    this.currentHandWinners = [...totalDistribution.entries()]
      .filter(([, amount]) => amount > 0)
      .map(([playerId, amount]) => {
        const sd = this.currentHandShowdownResults.find((r) => r.userId === playerId);
        return {
          userId: playerId,
          amount,
          potIndex: 0,
          hand: sd ? { name: sd.handName, ranking: sd.handRanking } : undefined,
        };
      });
    this.currentHandPotSize = totalPot;

    // FIX 117: skipDistribution=true — RIT already distributed pots per-board above.
    // Without this, completeHand() re-distributes ALL pots → double money.
    controller.finalizeRunout(true);
  }

  /**
   * Calculate and broadcast equity percentages for all all-in players.
   * Shown to ALL players and observers at the table — not just insurance tables.
   * Updates each street as new board cards are dealt.
   */
  /**
   * PRICING FIX 2026-08-18: insurance is priced by EXACT enumeration against
   * the KNOWN all-in hands (InsuranceEquity), returning the contract's real
   * outcome probabilities (pot-share equity for display, strict-loss and
   * push for the premium). The Monte-Carlo worker (2000 ties-split
   * iterations) that used to feed pricing was both noisy (~1% stderr) and
   * blind to the push rule; it remains in use for the on-screen equity
   * broadcast only. The enumeration is cheap on the loop now: flop/turn are
   * exact (<=990 boards) and preflop samples 6,000 boards with a seeded
   * PRNG - the CSPRNG syscall storm that motivated the worker is gone.
   */
  /**
   * INSURABLE POT 2026-08-28 (Dan's recording follow-up): the number the
   * dialog calls "Pot" is the amount the LEADER actually collects by winning,
   * so two corrections on top of the contested pot:
   *
   *   1. SIDE POTS — a short-stacked leader is only eligible for the pots
   *      their chips are in. computeLivePots() gives per-pot eligibility;
   *      insure only the leader's eligible share.
   *   2. RAKE + BBJ — the winner is paid pot minus rake minus the jackpot
   *      drop. Winners are scaled proportionally at settlement
   *      (scaleWinnerCentsForRake), so the leader's net share is
   *      eligible x (total - rake - bbj) / total.
   *
   * Falls back to the gross pot if the controller cannot answer (never
   * refuse an offer over a display refinement).
   */
  public computeInsurablePot(leaderId: string, grossPot: number): number {
    try {
      if (!this.handController || grossPot <= 0) return grossPot;
      const pots = this.handController.computeLivePots();
      let total = 0;
      let eligible = 0;
      for (const p of pots) {
        total += p.amount;
        if (p.eligiblePlayers.includes(leaderId)) eligible += p.amount;
      }
      if (!(total > 0) || !(eligible > 0)) return grossPot;
      // PREFLOP INSURANCE FIX 2026-08-28: an all-in runout always reaches the
      // flop, so price the deductions as if it is already seen — a preflop
      // offer on sawFlop=false claimed zero rake and overstated the winnings.
      const { rake, bbjFee } = this.handController.computeRakeAndBBJ(true);
      const netFrac = Math.max(0, (total - rake - bbjFee) / total);
      return Math.round(eligible * netFrac * 100) / 100;
    } catch {
      return grossPot;
    }
  }

  /**
   * BOARDS 2..N AS THEY STAND RIGHT NOW (2026-08-29).
   *
   * Every equity broadcast on a multi-board hand needs these, and only the
   * FIRST one had them. `dealNextStreet()` fills boards 2 and 3 in lockstep
   * with board 1 but returns `{ board, stage, complete }` — board 1 alone — so
   * the three later broadcast sites (the paced runout's per-street refresh,
   * the insurance per-street flow's, and the RIT continuation's) had nothing
   * to pass and silently fell back to single-board pricing.
   *
   * The effect was that a double or triple board bomb pot showed correct
   * averaged percentages at the moment of the all-in and then WRONG ones for
   * the flop, the turn and the river — the numbers drifting further from the
   * truth exactly as the hand got more dramatic, which is the opposite of what
   * the multi-board equity work was for.
   *
   * Reading the controller's live state at each broadcast is what makes them
   * agree, and it is cheap: three field reads, and nothing at all on a
   * single-board hand. Boards shorter than board 1 are excluded rather than
   * priced — an empty or partial board is not a board the solver can run.
   */
  protected liveExtraBoards(): import('../types.js').Card[][] | undefined {
    if (!(this.handController?.isDoubleBoardActive?.() ?? false)) return undefined;
    const st = this.handController?.getState?.();
    if (!st) return undefined;
    const extras = [st.communityCards2, st.communityCards3].filter(
      (b): b is import('../types.js').Card[] => Array.isArray(b) && b.length > 0
    );
    return extras.length > 0 ? extras : undefined;
  }

  /** Emit the canonical public payload from values already computed off-thread. */
  protected emitAllInEquityPayload(
    players: import('../types.js').SeatPlayer[],
    percentages: number[],
    board: import('../types.js').Card[],
    pot: number,
    boardCount: number
  ): void {
    this.hub?.emitEvent(this.tableId, {
      type: 'all_in_equity',
      table_id: this.tableId,
      hand_number: this.handCount,
      board: board.map((card) => `${card.rank}${card.suit}`),
      board_count: boardCount,
      pot,
      equities: players.map((player, index) => ({
        userId: player.user_id,
        username: player.username || 'Unknown',
        equity: Math.round((percentages[index] ?? 0) * 10) / 10,
        seat: player.seat,
      })),
    });
  }

  protected async broadcastAllInEquity(
    allInPlayers: import('../types.js').SeatPlayer[],
    board: import('../types.js').Card[],
    pot: number,
    /**
     * MULTI-BOARD EQUITY 2026-08-28 (spec §14): boards 2..N of a multi-board
     * bomb pot. When present, equity is computed per board and AVERAGED —
     * every board carries an equal share of every pot layer, so the average
     * is the player's true share of the money. Absent on single-board hands.
     */
    extraBoards?: import('../types.js').Card[][]
  ): Promise<void> {
    // Equity runs only on EquityWorkerPool worker threads. If the pool cannot
    // answer inside its bounded deadline, percentages are omitted; the runout
    // keeps its normal pace and the authoritative event loop never computes a
    // fallback.
    // VARIANT OVERRIDE 2026-08-28 (spec §10.1): the LIVE hand's variant — a
    // PLO bomb hand at an NLH table must be priced with the Omaha evaluator.
    const equityVariant = this.activeHandVariant() || this.tableInfo?.game_variant || 'nlh';
    const isShortDeck = equityVariant === 'short_deck';
    const isOmaha = isOmahaVariant(equityVariant);

    /* ── NEVER PRICE A HAND NOBODY IS ALLOWED TO HOLD (2026-08-31) ─────────
       In Crazy Pineapple a player holds THREE cards until the flop lands, and
       the equity solver has no rule for that: with `omaha: false` it scores
       best-5-of-8, the same illegal advantage that was paying impossible
       flushes at showdown until #2072, and with `omaha: true` evaluateOmahaHand
       falls through its `length < 4` guard and silently prices the FIRST TWO
       cards. Both numbers are confident and wrong, and they go straight onto
       the felt as percentages players trust.

       There is no honest third number either: the true preflop equity depends
       on a discard that has not happened yet and cannot be simulated inside
       the worker. So this hand's equity waits - which is where Dan's own rule
       already points ("equity only AFTER the street lands"), and in this
       variant the flop IS the first moment the numbers mean anything. The
       discard resolves the instant the flop lands (HandController.
       resolvePendingPineappleDiscards, both runout paths), and the per-street
       refresh below then broadcasts a correct number for every street. */
    if (allInPlayers.some((p) => (p.cards || []).length > 2) && !isOmaha) {
      return;
    }

    const valid = allInPlayers.filter((p) => (p.cards || []).length >= 2);
    const equities: Array<{ userId: string; username: string; equity: number; seat: number }> = [];
    // MULTI-BOARD EQUITY 2026-08-28: all live boards, board 1 first.
    const allBoards = [board, ...(extraBoards ?? [])];
    const equityController = this.handController;
    if (!equityController) return;
    const equityHandNumber = this.handCount;
    const requestedBoardKey = allBoards
      .map((liveBoard) => liveBoard.map((card) => `${card.rank}${card.suit}`).join(','))
      .join('|');
    // ── ADDITIVE observability (#5): time the all-in equity computation ──
    const equityComputeStartMs = Date.now();

    try {
      const hands = valid.map((p) => p.cards || []);
      // Per-board fractions, then the equal-share average. The iteration
      // budget is split across boards so a triple-board hand costs what a
      // single-board hand always has.
      const perBoardIters = Math.max(400, Math.ceil(1000 / allBoards.length));
      // PARALLEL 2026-08-28: the boards were priced one after another with an
      // `await` inside the loop, so a triple-board all-in cost three times the
      // latency it needed to. That latency sits between the reveal gate and
      // the percentages appearing — exactly the window Dan's "equity only
      // AFTER the street lands" rule is measured in, so a slow computation
      // there pushes the numbers further from the card that caused them. The
      // worker pool is concurrent by construction; ask it for every board at
      // once.
      const perBoard: number[][] = await Promise.all(
        allBoards.map((b) =>
          getEquityPool().estimateEquity(hands, b, [], perBoardIters, {
            shortDeck: isShortDeck,
            omaha: isOmaha,
          })
        )
      );
      if (
        !this.lifecycleCanMutate() ||
        this.handController !== equityController ||
        this.handCount !== equityHandNumber
      ) {
        return;
      }
      // Hand identity alone is not enough for this fire-and-forget display
      // job. A fast runout can advance to the next street while the worker is
      // still pricing the previous board. Rebuild the exact live board tuple
      // after the await and drop a result whose visual generation has moved.
      const liveState = equityController.getState();
      const currentBoards = [
        liveState.communityCards,
        ...[liveState.communityCards2, liveState.communityCards3].filter(
          (liveBoard): liveBoard is import('../types.js').Card[] =>
            Array.isArray(liveBoard) && liveBoard.length > 0
        ),
      ];
      const currentBoardKey = currentBoards
        .map((liveBoard) => liveBoard.map((card) => `${card.rank}${card.suit}`).join(','))
        .join('|');
      if (currentBoardKey !== requestedBoardKey) return;
      const fractions = hands.map(
        (_, i) => perBoard.reduce((s, f) => s + (f[i] ?? 0), 0) / allBoards.length
      );
      for (let i = 0; i < valid.length; i++) {
        equities.push({
          userId: valid[i].user_id,
          username: valid[i].username || 'Unknown',
          equity: Math.round(fractions[i] * 1000) / 10, // fraction -> % (1 dp)
          seat: valid[i].seat,
        });
      }
    } catch (error) {
      reportError(error, 'ServerTableEngine.' + this.tableId + '.all_in_equity_worker_failed', {
        handNumber: this.handCount,
        boardCount: allBoards.length,
      });
      try {
        EngineMetrics.allInEquityDuration.observe(Date.now() - equityComputeStartMs, {
          table_id: this.tableId,
        });
      } catch {
        /* metrics must never affect gameplay */
      }
      return;
    }

    // ── ADDITIVE observability (#5): observe all-in equity compute duration ──
    try {
      EngineMetrics.allInEquityDuration.observe(Date.now() - equityComputeStartMs, {
        table_id: this.tableId,
      });
    } catch {
      /* metrics must never affect gameplay */
    }
    this.emitAllInEquityPayload(
      valid,
      equities.map((entry) => entry.equity),
      board,
      pot,
      allBoards.length
    );
  }

  /**
   * Per-street insurance flow:
   * 1. Deal one street (flop/turn/river)
   * 2. Re-broadcast equity percentages (updates on-screen equity display)
   * 3. Create or recalculate insurance offers
   * 4. Broadcast offers, wait for responses
   * 5. After responses: check if any eligible players remain
   *    - If ALL players declined for hand → instant runout for remaining streets
   *    - If board incomplete and eligible players exist → go back to step 1
   * 6. After all 5 cards dealt: finalize the hand
   *
   * Dan's rule: "THIS IS VOID IF THE PLAYER DECLINES INSURANCE FOR HAND OPTION.
   * IT WILL RUN OUT NORMAL, UNLESS THAT PLAYER IS NOT 'BEHIND' —
   * INSURANCE WILL BE OFFERED TO THE PLAYER THAT IS 'AHEAD' IF ANY STREETS
   * ARE STILL PENDING."
   */
  protected async runInsurancePerStreetFlow(
    offerPlayers: Array<{ playerId: string; holeCards: import('../types.js').Card[] }>,
    allInPlayers: import('../types.js').SeatPlayer[],
    pot: number,
    // OFFER-BEFORE-DEAL 2026-08-26: the board as it stands RIGHT NOW. The
    // flow used to deal the next street first and only then offer - so a
    // turn all-in dealt the river immediately and never offered river
    // insurance at all, and a flop all-in was never offered two-street
    // coverage. The reference offers on the STANDING board (all-in on the
    // flop -> RIT declined -> turn dealt -> offer with the river to come),
    // which this order now reproduces exactly: offer on the current board,
    // wait for the decision, then deal.
    board: import('../types.js').Card[],
    // ═══ 2026-08-31: the hand this flow serves. The flow sleeps and waits on
    // 20-second offer windows; the live hand can die and be replaced while it
    // does. Every resumption checks identity against this - a bare null-check
    // on this.handController happily walks into the NEXT hand.
    controller: HandController,
    offerRevealPauseMs = 0
  ): Promise<void> {
    if (!this.lifecycleCanMutate() || this.handController !== controller) return;
    const pricingHandNumber = this.handCount;

    const offerTimeout = 25; // Matches InsuranceEngine DEFAULT_CONFIG.offerTimeoutSeconds
    const result = { board, complete: board.length >= 5 };

    // Continuation once this street's offer window resolves: if anyone can
    // still be offered on a later street the pause survives; otherwise the
    // rest of the board runs out paced.
    const continueAfterResponses = () => {
      if (!this.insurancePauseStillLive(offerPlayers)) {
        console.log(
          `[ServerTableEngine:${this.tableId}] All players declined insurance for hand - switching to paced runout`
        );
        if (this.handController === controller) {
          void this.pacedAllInRunout(allInPlayers, pot);
        }
        return;
      }
      /* PARKED-HAND FIX 2026-08-27: this was the one call site of the three
         with no .catch. dealNextInsuranceStreet can reject from
         dealNextStreet(), from broadcastAllInEquity()'s worker pool, or from
         finalizeRunout() — and an unhandled rejection here leaves the hand
         with currentPlayerSeat -1, no clock and no continuation, recoverable
         only by the 45s watchdog. Same guard the sibling call sites use. */
      void this.dealNextInsuranceStreet(offerPlayers, allInPlayers, pot, controller).catch(
        (err) => {
          reportError(err, 'ServerTableEngine.' + this.tableId + '.insurance_deal_street_rejected');
          this.safeContinueRunout('insurance_deal_street_rejected', controller);
        }
      );
    };

    if (result.complete) {
      // Board already full — nothing left to insure; finish the hand.
      this.waitForInsuranceResponses(() => {
        if (this.handController === controller) controller.finalizeRunout();
      });
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FIX 103: Insurance is ONLY offered to the player with the BEST HAND.
    // Dan's rules:
    // - Evaluate all all-in players' hands against the current board
    // - Find the leader (best actual hand, not equity percentages)
    // - If players are TIED (same hand rank + kickers), NO insurance offered
    // - On later streets, re-evaluate — if a different player takes the lead,
    //   insurance is offered to THEM (if they haven't declined for hand)
    //
    // PREFLOP OFFER (Dan 2026-08-28: "THIS SHOULD BE OFFERED PRE FLOP, AND
    // REOFFERED ON THE FLOP"): a preflop all-in used to deal straight to the
    // flop and only offer there. It now offers on the EMPTY board first.
    // Preflop there is no made hand to rank, so the leader is the exact
    // EQUITY favorite (insuranceEquity's seeded 6,000-board sample — the same
    // number the pricing uses); a dead-even matchup (within 0.05%) offers to
    // nobody, mirroring the tied-hands rule.
    // ═══════════════════════════════════════════════════════════════════════
    /**
     * THE HAND'S VARIANT, NOT THE TABLE'S (2026-08-29).
     *
     * Insurance is suppressed only on MULTI-board bomb pots. A SINGLE-board
     * bomb pot carrying a variant override — an NLH table dealing one PLO
     * board, which is a supported and host-selectable configuration — is fully
     * eligible, and every line below ran on `tableInfo.game_variant`.
     *
     * That means the leader was elected with a Hold'em evaluator against
     * four-card holdings, and insuranceEquity was then handed 'nlh' and priced
     * the contract as though those extra two cards did not exist. Insurance
     * premiums and payouts are real money, so this was the wrong player being
     * offered the wrong price.
     *
     * activeHandVariant() is the one seam every "what game is this hand"
     * consumer reads, and broadcastAllInEquity two hundred lines below already
     * uses it. This block was simply missed when the rest were converted.
     */
    const variant = this.activeHandVariant();
    const isOmaha = isOmahaVariant(variant);
    const isShortDeckPreflop = isShortDeckVariant(variant);
    const handEvaluator = isOmaha
      ? evaluateOmahaHand
      : (holeCards: import('../types.js').Card[], liveBoard: import('../types.js').Card[]) =>
          evaluateHand(holeCards, liveBoard, isShortDeckPreflop);

    // One worker operation prices the complete known all-in field. It replaces
    // the former per-player preflop loop plus a second leader-only pricing
    // pass. No unavailable/error/timeout path is allowed to compute here.
    const allInForOffer = allInPlayers.map((player) => ({
      playerId: player.user_id,
      holeCards: player.cards || [],
      atRisk: player.totalInvested ?? 0,
    }));
    const pricingStartedAt = Date.now();
    let allPricing: Awaited<ReturnType<ReturnType<typeof getEquityPool>['estimateInsurance']>>;
    try {
      allPricing = await getEquityPool().estimateInsurance(
        allInForOffer.map((player) => player.holeCards),
        result.board,
        variant,
        isShortDeckPreflop
      );
      // Crossing a worker await is an authority boundary. Re-prove process,
      // distributed lease, exact controller, and exact hand before mutation.
      if (
        !this.lifecycleCanMutate() ||
        this.handController !== controller ||
        this.handCount !== pricingHandNumber
      ) {
        return;
      }
      if (
        allPricing.length !== allInForOffer.length ||
        allPricing.some(
          (pricing) =>
            !Number.isFinite(pricing?.equity) ||
            !Number.isFinite(pricing?.strictLossPct) ||
            !Number.isFinite(pricing?.pushPct)
        )
      ) {
        throw new Error('Insurance worker returned incomplete structured pricing');
      }
      try {
        EngineMetrics.allInEquityDuration.observe(Date.now() - pricingStartedAt, {
          table_id: this.tableId,
        });
      } catch {
        /* metrics must never affect gameplay */
      }
    } catch (error) {
      try {
        EngineMetrics.allInEquityDuration.observe(Date.now() - pricingStartedAt, {
          table_id: this.tableId,
        });
      } catch {
        /* metrics must never affect gameplay */
      }
      reportError(error, 'ServerTableEngine.' + this.tableId + '.insurance_pricing_worker_failed', {
        handNumber: pricingHandNumber,
      });
      if (
        this.lifecycleCanMutate() &&
        this.handController === controller &&
        this.handCount === pricingHandNumber
      ) {
        await this.pacedAllInRunout(allInPlayers, pot);
      }
      return;
    }
    const pricingByPlayer = new Map(
      allInForOffer.map((player, index) => [player.playerId, allPricing[index]] as const)
    );
    this.emitAllInEquityPayload(
      allInPlayers,
      allPricing.map((pricing) => pricing.equity),
      result.board,
      pot,
      1
    );
    if (offerRevealPauseMs > 0) {
      await this.sleep(offerRevealPauseMs);
      if (
        !this.lifecycleCanMutate() ||
        this.handController !== controller ||
        this.handCount !== pricingHandNumber
      ) {
        return;
      }
    }

    let bestHandPlayer: { playerId: string; holeCards: import('../types.js').Card[] } | null = null;
    let isTied = false;
    if (board.length < 3) {
      let bestEq = -1;
      for (const p of offerPlayers) {
        const equity = pricingByPlayer.get(p.playerId)?.equity;
        if (!Number.isFinite(equity) || p.holeCards.length < 2) continue;
        if (Math.abs(equity! - bestEq) < 0.05) {
          isTied = true;
        } else if (equity! > bestEq) {
          bestEq = equity!;
          bestHandPlayer = p;
          isTied = false;
        }
      }
      if (isTied) bestHandPlayer = null;
    } else {
      // Evaluate all hands on current board
      const playerEvals = offerPlayers.map((p) => ({
        ...p,
        hand: handEvaluator(p.holeCards, result.board),
      }));

      // Sort by hand rank descending (best first)
      playerEvals.sort((a, b) => compareHands(b.hand, a.hand));

      // Check for tie: if top two players have identical hands, no insurance
      isTied =
        playerEvals.length >= 2 && compareHands(playerEvals[0].hand, playerEvals[1].hand) === 0;

      bestHandPlayer = isTied ? null : playerEvals[0];
    }

    // FIX 139: Pass shortDeck to insurance engine for correct equity calculations
    // 2026-08-29: the HAND's variant, for the same reason as the block above —
    // and via isShortDeckVariant rather than a string equality, so a new
    // short-deck spelling cannot silently price a 36-card game off a 52-card
    // deck.
    const isShortDeckInsurance = isShortDeckVariant(variant);

    const leaderPricing = bestHandPlayer ? pricingByPlayer.get(bestHandPlayer.playerId) : undefined;
    if (bestHandPlayer && !leaderPricing) {
      reportError(
        new Error('Insurance worker omitted pricing for the elected leader'),
        'ServerTableEngine.' + this.tableId + '.insurance_leader_pricing_missing',
        { handNumber: pricingHandNumber, leaderId: bestHandPlayer.playerId }
      );
      await this.pacedAllInRunout(allInPlayers, pot);
      return;
    }

    // INSURABLE POT 2026-08-28: the offer prices what the leader can actually
    // COLLECT — their eligible side-pot share, net of rake + BBJ drop — not
    // the gross contested pot. "For Winning: pot − fee" is now literal.
    const insurablePot = bestHandPlayer
      ? this.computeInsurablePot(bestHandPlayer.playerId, pot)
      : pot;

    // Check if this is the first street of offers or a recalculation
    const existingOffers = this.insuranceEngine.getOffers(this.tableId);

    if (existingOffers.length === 0) {
      // First time: create offer for ONLY the best hand player
      if (bestHandPlayer) {
        const offers = this.insuranceEngine.createOffers(
          this.tableId,
          `${this.tableId}:${this.handCount}`,
          bestHandPlayer.playerId, // ONLY the leader is offered; priced vs the rest
          allInForOffer,
          result.board,
          insurablePot,
          variant,
          isShortDeckInsurance,
          leaderPricing!
        );

        if (offers.length > 0) {
          this.broadcastInsuranceOffers(offers, insurablePot, offerTimeout, {
            board: result.board,
            allInPlayers,
            outs: leaderOuts(
              bestHandPlayer.holeCards,
              allInForOffer
                .filter((p) => p.playerId !== bestHandPlayer.playerId)
                .map((p) => p.holeCards),
              result.board,
              variant,
              isShortDeckInsurance
            ),
          });
          this.scheduleHorseInsuranceResponse(bestHandPlayer.playerId);
        }
      } else {
        console.log(
          `[ServerTableEngine:${this.tableId}] Insurance: Tied hands - no insurance offered`
        );
      }
    } else {
      // Subsequent streets: recalculate equity and re-evaluate leadership.
      // Clear old offers and create new one for the current leader.
      if (bestHandPlayer) {
        // AUDIT FIX 2026-07-19: clear only still-pending offers — do NOT wipe
        // already-accepted (paid-for) coverage or reset the table config.
        this.insuranceEngine.clearPendingOffers(this.tableId);

        // Only re-offer if the leader hasn't declined for hand
        const prevOffers = existingOffers;
        const leaderPrevOffer = prevOffers.find((o) => o.playerId === bestHandPlayer.playerId);
        const leaderDeclinedForHand = leaderPrevOffer?.declinedForHand ?? false;

        if (!leaderDeclinedForHand) {
          const offers = this.insuranceEngine.createOffers(
            this.tableId,
            `${this.tableId}:${this.handCount}`,
            bestHandPlayer.playerId,
            allInForOffer,
            result.board,
            insurablePot,
            variant,
            isShortDeckInsurance,
            leaderPricing!
          );

          if (offers.length > 0) {
            this.broadcastInsuranceOffers(offers, insurablePot, offerTimeout, {
              board: result.board,
              allInPlayers,
              outs: leaderOuts(
                bestHandPlayer.holeCards,
                allInForOffer
                  .filter((p) => p.playerId !== bestHandPlayer.playerId)
                  .map((p) => p.holeCards),
                result.board,
                variant,
                isShortDeckInsurance
              ),
            });
            this.scheduleHorseInsuranceResponse(bestHandPlayer.playerId);
          }
        }
      } else {
        console.log(
          `[ServerTableEngine:${this.tableId}] Insurance: Tied hands on new street - no insurance offered`
        );
      }
    }

    // The offer (or the no-offer beat on a tie) stands on the CURRENT board.
    // Once every offer resolves — accept, final decline, or timeout — the
    // continuation checks eligibility (FIX 88 / Dan: all-declined voids the
    // pause) and deals the next street.
    this.waitForInsuranceResponses(continueAfterResponses);
  }

  /**
   * OFFER-BEFORE-DEAL 2026-08-26: the dealing half of the per-street flow.
   * A readable beat, one street dealt, equity re-broadcast — then either the
   * hand finalizes (river landed) or the flow re-enters on the new board to
   * evaluate the fresh leader and offer again.
   */
  protected async dealNextInsuranceStreet(
    offerPlayers: Array<{ playerId: string; holeCards: import('../types.js').Card[] }>,
    allInPlayers: import('../types.js').SeatPlayer[],
    pot: number,
    // 2026-08-31: the hand being run out. Identity, not null-ness, gates every
    // resumption - this method sleeps three times and used to deal a street
    // onto WHATEVER controller the table held when it woke up.
    controller: HandController
  ): Promise<void> {
    // ANIMATION AUDIT 2026-08-19: give the CURRENT board + percentages a
    // readable beat before the next card lands.
    await this.sleep(this.allInStreetPauseMs);
    if (this.handController !== controller) return;

    if (controller.getPineappleRunoutDiscardSnapshot?.()) {
      try {
        if (!(await this.preparePineappleRunoutDiscards(controller))) return;
      } catch (error) {
        if (error instanceof HorseDecisionAbortedError) return;
        reportError(
          error,
          'ServerTableEngine.' + this.tableId + '.pineapple_insurance_runout_worker_failed'
        );
        return;
      }
    }

    const result = controller.dealNextStreet();
    allInPlayers = this.refreshAllInPlayersFromController(allInPlayers, controller);
    const currentById = new Map(allInPlayers.map((player) => [player.user_id, player] as const));
    offerPlayers = offerPlayers.map((player) => ({
      ...player,
      holeCards: currentById.get(player.playerId)?.cards ?? player.holeCards,
    }));
    this.broadcastCurrentState();

    // RE-BROADCAST EQUITY: all players and observers see updated percentages
    // as each card is dealt — but only ONCE THE CARD IS FACE UP. Same defect
    // as pacedAllInRunout: the state broadcast above sent the street, the
    // client is still animating it, and moving the percentages now spoils the
    // card that is still turning over (Dan 2026-08-28).
    await this.sleep(this.allInStreetRevealMs);
    if (this.handController !== controller) return;
    if (result.complete) {
      // No contract is priced once the river is complete, so its final public
      // percentage remains a standalone cosmetic worker operation.
      await this.broadcastAllInEquity(allInPlayers, result.board, pot, this.liveExtraBoards());
      if (!this.lifecycleCanMutate() || this.handController !== controller) return;
      // River is down — settle (insurance included) via the normal finalize.
      controller.finalizeRunout();
      return;
    }

    // More cards to come: one structured worker pass supplies both the public
    // percentages and the real-money offer. The flow emits the percentages
    // immediately, then preserves the full one-second reveal-to-dialog beat.
    await this.runInsurancePerStreetFlow(
      offerPlayers,
      allInPlayers,
      pot,
      result.board,
      controller,
      1000
    );
  }

  /**
   * ELIGIBILITY FIX 2026-08-26: does the per-street insurance pause continue?
   *
   * anyEligibleForInsurance() only looks at players who already RECEIVED an
   * offer. With two all-in players, the leader declining left the offers list
   * holding only that one declined entry, the check returned false, and the
   * flow gave up per-street pacing - so when the OTHER player took the lead
   * on the next street (Dan: "IF HERO HAS THE BEST HAND ON THE FLOP ... THEN
   * THE VILLAIN HAS THE BEST HAND ON THE TURN, THEY GET TO ACCEPT OR
   * DECLINE") they were never offered anything. Eligibility is over ALL
   * all-in players: anyone without a final decline on record can still be
   * offered, so the pause must survive them.
   */
  protected insurancePauseStillLive(offerPlayers: Array<{ playerId: string }>): boolean {
    const declinedIds = new Set(
      this.insuranceEngine
        .getOffers(this.tableId)
        .filter((o) => o.declinedForHand)
        .map((o) => o.playerId)
    );
    return offerPlayers.some((p) => !declinedIds.has(p.playerId));
  }

  /**
   * Broadcast insurance offers to clients via Supabase Realtime.
   * Includes all fields needed for the InsurancePanel slider UI.
   */
  protected broadcastInsuranceOffers(
    offers: import('./InsuranceEngine.js').InsuranceOffer[],
    pot: number,
    timeoutSeconds: number,
    // POKERBROS PARITY 2026-08-26: the popup shows the leader's cards, the
    // opponent's cards, the live board and the OUTS that beat the leader -
    // and everyone ELSE at the table shows a "waiting on <name>" bar. All of
    // that context now rides the offer event instead of arriving empty.
    context?: {
      board: import('../types.js').Card[];
      allInPlayers: import('../types.js').SeatPlayer[];
      outs: import('../types.js').Card[];
    }
  ): void {
    const nameOf = (playerId: string): string =>
      context?.allInPlayers.find((p) => p.user_id === playerId)?.username ||
      this.seatedPlayers.find((p) => p.user_id === playerId)?.username ||
      'Player';
    // PREFLOP OFFER 2026-08-28: the empty board is a street of its own now.
    const street = !context
      ? ''
      : context.board.length < 3
        ? 'preflop'
        : context.board.length === 3
          ? 'flop'
          : 'turn';
    // Outs as a probability of the NEXT card: outs / unseen cards. The popup
    // renders it next to the count ("10 Outs - 22.7%").
    let outPct = 0;
    if (context && context.outs.length > 0) {
      const known =
        context.board.length + context.allInPlayers.reduce((n, p) => n + (p.cards?.length ?? 0), 0);
      // 2026-08-29: the HAND's variant, through VariantRules. This is the
      // denominator of the outs percentage a player reads in the insurance
      // popup ("10 Outs - 22.7%"), and it was computed from the TABLE's
      // variant against a hardcoded 36/52 — so on a single-board bomb pot
      // carrying a variant override the number quoted to the player was drawn
      // from the wrong deck. Found by the guard pin for the leader-election
      // fix, which is the same defect one function further along.
      const deckSize = deckSizeFor(this.activeHandVariant());
      const unseen = Math.max(1, deckSize - known);
      outPct = Math.round((context.outs.length / unseen) * 1000) / 10;
    }
    // COUNTDOWN HONESTY 2026-08-28: the popup used to count down from a
    // seconds-remaining number that was already stale by the time it rendered
    // (the recording opened at 23s of a 25s window). An absolute deadline
    // survives transit and reconnects; timeoutSeconds stays for old clients.
    const deadlineAt = Date.now() + timeoutSeconds * 1000;
    this.hub?.emitEvent(this.tableId, {
      type: 'insurance_offers',
      table_id: this.tableId,
      hand_number: this.handCount,
      pot,
      street,
      board: context?.board ?? [],
      outs: context?.outs ?? [],
      outCount: context?.outs.length ?? 0,
      outPct,
      deadlineAt,
      offers: offers.map((o) => ({
        playerId: o.playerId,
        username: nameOf(o.playerId),
        holeCards: o.holeCards,
        opponents:
          context?.allInPlayers
            .filter((p) => p.user_id !== o.playerId)
            .map((p) => ({
              playerId: p.user_id,
              username: p.username || 'Player',
              holeCards: p.cards || [],
            })) ?? [],
        equity: o.equity,
        fullPremium: o.fullPremium,
        premium: o.premium,
        fullInsuredAmount: o.fullInsuredAmount,
        insuredAmount: o.insuredAmount,
        coveragePercent: o.coveragePercent,
        // REFERENCE PARITY 2026-08-26: the dialog's Break Even preset returns
        // exactly the leader's committed chips, and Rate is the payout
        // multiple on the fee - both derived from these.
        atRisk: o.atRisk,
        rate: o.fullPremium > 0 ? Math.round((o.fullInsuredAmount / o.fullPremium) * 10) / 10 : 0,
        timeoutSeconds,
        deadlineAt,
        // EV CASHOUT 2026-08-28: the third choice, server-priced.
        evCashoutAmount: o.evCashoutAmount,
      })),
    });

    // OBSERVABILITY 2026-08-28: record the offer itself. Accept/decline/
    // timeout/cashout/settle are logged from the engine event forwarder in
    // ServerTableEngineBase; without this row the funnel has no denominator.
    for (const o of offers) {
      logInsuranceOfferEvent({
        tableId: this.tableId,
        clubId: this.tableInfo?.club_id ?? null,
        handNumber: this.handCount,
        playerId: o.playerId,
        event: 'offered',
        equityPercent: o.equity,
        premium: o.fullPremium,
        insuredAmount: o.fullInsuredAmount,
        pot,
        street,
      });
    }
  }

  /**
   * Poll for all insurance responses to be resolved (accepted/declined/timed out).
   * Once all responded, invoke the callback to continue the hand.
   */
  /**
   * HORSE INSURANCE RESPONSE 2026-08-18: horses never answered
   * insurance_offers, so a horse leader let every offer run its full 15s
   * timeout - and the per-street flow re-offers each street, so an
   * insurance-enabled table with horses would stall up to ~45s per all-in
   * hand. A horse leader declines FOR THE HAND after ~1s: the pause
   * collapses to an instant runout and the table keeps its pace. Horses do
   * not buy insurance - the premium's house edge is a pure EV loss and
   * horse chips are house chips anyway.
   */
  protected scheduleHorseInsuranceResponse(leaderId: string): void {
    const seated = this.seatedPlayers.find((p) => p.user_id === leaderId);
    if (!seated?.is_horse) return;
    const handAtOffer = this.handCount;
    setTimeout(
      () => {
        if (!this.running || this.handCount !== handAtOffer) return;
        const offer = this.insuranceEngine
          .getOffers(this.tableId)
          .find((o) => o.playerId === leaderId && o.status === 'offered');
        if (!offer) return;
        try {
          this.respondToInsurance(leaderId, 'decline', 100, true);
        } catch (err) {
          reportError(err, 'ServerTableEngine.' + this.tableId + '.horse_insurance_response');
        }
      },
      // HORSES ARE PLAYERS 2026-08-28 (section 10.5 — "TIMING IS PART OF THE
      // TREATMENT"): the old ~1s decline was a TELL. A human leader stops the
      // table for up to 25s while they read the dialog; a table that rolled on
      // after one second told every watching player which seat was a horse —
      // the exact rhythm leak Dan rejected on the rebuy pause. Pace cost is
      // bounded: a decline is FINAL for the hand (2026-08-26), so a hand pays
      // this pause once per leader, not once per street.
      //
      // 2026-09-09, TWO CORRECTIONS TO THAT FIX:
      //
      //   1. It sampled 5-12s out of the 25s a human gets. The law's test is
      //      "is it IDENTICAL", not "is it closer than it was" - and a fleet
      //      that never once takes longer than twelve seconds on a window that
      //      is twenty-five seconds long is still a rhythm you can read off the
      //      felt, just a slower one. The sample now spans the WHOLE human
      //      window, from a beat that is plausibly instant to just inside the
      //      timeout (a decline landing after it would be indistinguishable
      //      from the timeout, and the offer resolves itself then anyway).
      //   2. It used `Math.random()`, in the engine's own decision path, which
      //      the note above horseRitVerdict states this file does not do: a
      //      replay of a hand must answer the same way twice, and a random
      //      answer is not testable. Same deterministic (playerId, handCount)
      //      hash horseRitVerdict uses, so two horses at one table still differ
      //      from each other and from themselves on the next hand.
      this.horseInsuranceThinkMs(
        leaderId,
        this.insuranceEngine.offerTimeoutSeconds(this.tableId) * 1000
      )
    );
  }

  /**
   * How long a horse "reads" an insurance dialog before declining: uniform
   * across the same window a human is given, derived deterministically from
   * (playerId, handCount). `windowMs` is the human offer timeout; the sample
   * stops a beat short of it so a decline never races the timeout it is meant
   * to look like an alternative to.
   */
  protected horseInsuranceThinkMs(playerId: string, windowMs: number): number {
    let h = 0;
    for (let i = 0; i < playerId.length; i++) {
      h = (h * 31 + playerId.charCodeAt(i)) % 1000003;
    }
    const spread = Math.max(1, windowMs - 1500);
    return 400 + ((h + this.handCount * 8191) % spread);
  }

  protected waitForInsuranceResponses(onComplete: () => void): void {
    let completed = false;
    const controllerAtOffer = this.handController;
    const handAtOffer = this.handCount;
    const finish = () => {
      if (completed) return; // Guard: exactly-once invocation
      completed = true;
      clearInterval(checkInterval);
      clearTimeout(safetyTimeout);
      // A wait that outlives its hand must never touch the next hand's board.
      if (!this.handController || this.handController !== controllerAtOffer) {
        reportError(
          new Error(
            'Insurance wait resolved into a different hand (#' + handAtOffer + ') - dropped'
          ),
          'ServerTableEngine.' + this.tableId + '.insurance_wait_stale'
        );
        return;
      }
      try {
        onComplete();
      } catch (err) {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.insurance_oncomplete_threw');
        this.safeContinueRunout('insurance_oncomplete_threw', controllerAtOffer);
      }
    };

    const checkInterval = setInterval(() => {
      if (this.insuranceEngine.allResponded(this.tableId)) {
        finish();
      }
    }, 250); // Check every 250ms

    // Safety timeout: if insurance engine's own timeouts somehow fail, force continue after 20s
    const safetyTimeout = setTimeout(() => {
      if (!this.insuranceEngine.allResponded(this.tableId)) {
        console.warn(
          `[ServerTableEngine:${this.tableId}] Insurance safety timeout - forcing continue`
        );
        // Decline any remaining offers
        for (const offer of this.insuranceEngine.getOffers(this.tableId)) {
          if (offer.status === 'offered') {
            this.insuranceEngine.decline(this.tableId, offer.playerId);
          }
        }
      }
      finish();
    }, 20_000);
  }
}
