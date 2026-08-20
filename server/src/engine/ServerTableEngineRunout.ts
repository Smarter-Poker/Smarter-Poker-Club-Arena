/**
 * ServerTableEngine, layer 4/8 — pineapple discards, all-in runouts, run-it-twice, insurance.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { HandController } from './HandController.js';
import { HorseLogic, resolveHorseStyle } from './HorseLogic.js';
import { InsuranceEngine } from './InsuranceEngine.js';
import { monteCarloEquity } from './MonteCarloEquity.js';
import { getEquityPool } from './equity/EquityWorkerPool.js';
import * as EngineMetrics from '../observability/engineInstruments.js';
import { insuranceEquity } from './InsuranceEquity.js';
import { evaluateHand, evaluateOmahaHand, compareHands, determineWinners } from './PokerEngine.js';
import type { SeatPlayer, HandEvent, SeatedPlayer } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { ServerTableEngineTurns } from './ServerTableEngineTurns.js';

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
   */
  protected actionSettleMs = 650;

  /**
   * Dan 2026-08-20: the beat a freshly dealt board gets before the first
   * postflop actor goes on the clock. HandController deals the street and
   * emits TURN_CHANGE in the same synchronous call, so without this the reveal
   * raced the next action.
   *
   * Sized for the worst case, the flop: it lands (ccFlopLand 300ms) and only
   * then fans open (ccFlopFanOpen 420ms, starting ~520ms in) — ~940ms of
   * animation — plus a beat to actually read the board.
   */
  protected streetSettleMs = 1400;

  /**
   * Dan 2026-08-20: the beat between hands turning face up at showdown and the
   * pot shipping. completeHandInner() emits SHOWDOWN and WINNERS in the SAME
   * tick, so the reveal had zero airtime before the winner lit up and the pot
   * flew away. Covers cardShowdownFlip (350ms + 120ms second-card stagger) and
   * leaves time to read the hands. Applied only when 2+ hands actually reached
   * showdown; a fold-around win has nothing to reveal.
   */
  protected showdownSettleMs = 1600;

  /** Wall-clock stamp of the last street dealt — see streetSettleMs. */
  protected lastStreetDealtAtMs = 0;

  /**
   * Dan 2026-08-20: the beat between the hand being dealt and the first player
   * going on the clock. The deal is the longest animation at the table — 12
   * cards on an 80ms stagger with a 320ms flight (~1.2s) — and the blinds fly
   * for another 400ms after it. Both used to still be in the air when the
   * first action began.
   */
  protected handStartSettleMs = 1500;

  /** Wall-clock stamp of the blinds landing — see handStartSettleMs. */
  protected lastHandStartAtMs = 0;

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

    // Phase 1: Chooser picks how many boards
    if (userId === state.chooserPlayerId && runs !== undefined) {
      this.runItTwiceEngine.chooserDecides(this.tableId, userId, runs);
      if (runs === 1) {
        return { success: true, status: 'declined_by_chooser' };
      }
      // Broadcast chooser's decision to all clients so others can accept/decline
      this.hub?.emitEvent(this.tableId, {
        type: 'rit_chooser_decided',
        table_id: this.tableId,
        chooserPlayerId: userId,
        chosenRuns: runs,
        waitingFor: state.allPlayerIds.filter((pid) => pid !== userId),
      });
      return { success: true, status: 'waiting_for_others' };
    }

    // Phase 2: Other players accept or decline
    if (response === 'accept') {
      const allAccepted = this.runItTwiceEngine.accept(this.tableId, userId);
      if (allAccepted) {
        return { success: true, status: 'accepted' };
      }
      return { success: true, status: 'waiting_for_others' };
    } else if (response === 'decline') {
      this.runItTwiceEngine.decline(this.tableId, userId);
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
   * @param declineForHand — If declining, true = "Decline for Hand" (never re-offer),
   *   false = "Decline Now" (may re-offer on next street if equity shifts).
   */
  public respondToInsurance(
    userId: string,
    response: 'accept' | 'decline',
    coveragePercent: number = 100,
    declineForHand: boolean = false
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
      // Two decline modes: "Decline Now" (this street) or "Decline for Hand" (all streets)
      this.insuranceEngine.decline(this.tableId, userId, declineForHand);
      return { success: true, status: declineForHand ? 'declined_for_hand' : 'declined' };
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
  /**
   * FIX 120: Crazy Pineapple — start a discard timer for all active players.
   * Each player has action_time_seconds to pick which card to discard.
   * If they don't respond, auto-discard the last (3rd) card.
   */
  protected handlePineappleDiscard(event: HandEvent): void {
    if (event.type !== 'PINEAPPLE_DISCARD_REQUIRED' || !this.handController) return;

    const seats = (event as any).seats as number[];
    const timeoutMs = (this.tableInfo?.action_time_seconds || 15) * 1000;

    // AUDIT V2 (2026-07-23): horses used to rely on the expiry auto-discard,
    // which always throws away the LAST card — effectively a random discard.
    // Now each horse picks the equity-maximizing discard with a humanlike delay.
    const handControllerRef = this.handController;
    const hcState = handControllerRef.getState();
    for (const seat of seats) {
      const seated = this.seatedPlayers.find((p) => p.seat_number === seat);
      if (!seated?.is_horse) continue;
      const enginePlayer = hcState.players.find((p) => p.seat === seat);
      if (!enginePlayer || enginePlayer.is_folded || enginePlayer.cards.length !== 3) continue;
      const delay = 1200 + Math.random() * Math.min(4000, Math.max(1500, timeoutMs * 0.3));
      setTimeout(() => {
        if (!this.handController || this.handController !== handControllerRef) return;
        try {
          const current = this.handController.getState();
          const p = current.players.find((pl) => pl.seat === seat);
          if (!p || p.is_folded || p.cards.length !== 3) return;
          const idx = HorseLogic.decideDiscard(
            p.cards,
            current.communityCards,
            (this.tableInfo?.game_variant || 'pineapple') as string
          );
          this.handController.performDiscard(seat, idx);
        } catch {
          /* expiry auto-discard remains the safety net */
        }
      }, delay);
    }

    // Start a single discard timer — when it expires, auto-discard for anyone remaining.
    //
    // 2026-08-15: this had no try/catch and no hand-identity guard. autoDiscard
    // drives performDiscard -> checkPineappleDiscardsComplete -> advanceStage ->
    // deck.deal -> the synchronous broadcast chain, so a throw on the FIRST seat
    // aborted the loop: the remaining seats never discarded,
    // pineappleDiscardsRemaining never emptied, and the hand was parked at
    // pineapple_discard forever. Three pineapple tables run in production.
    const discardControllerRef = this.handController;
    this.pineappleDiscardTimer = setTimeout(() => {
      if (!this.handController || this.handController !== discardControllerRef) return;
      for (const seat of seats) {
        try {
          // Auto-discard last card for any player who hasn't responded
          this.handController.autoDiscard(seat);
        } catch (err) {
          reportError(err, 'ServerTableEngine.' + this.tableId + '.pineapple_autodiscard_threw', {
            seat,
          });
          // Keep going — one bad seat must not strand the whole table.
        }
      }
      this.markProgress();
      // checkPineappleDiscardsComplete() inside autoDiscard will advance the game
    }, timeoutMs);
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

    // If all discards are complete, the HandController will advance the game
    // and emit events that trigger broadcasting. Clear the discard timer.
    //
    // 2026-08-15: this used to re-test `hcState.stage`, a PRE-discard copy
    // returned by getState() — proven equal to 'pineapple_discard' by the guard
    // at the top of this method and unable to change, so the branch was dead
    // and the timer was NEVER cleared. It always ran to full duration and fired
    // autoDiscard into whatever hand happened to be live by then.
    if (this.handController.getState().stage !== 'pineapple_discard') {
      // Stage already advanced — all discards are in
      if (this.pineappleDiscardTimer) {
        clearTimeout(this.pineappleDiscardTimer);
        this.pineappleDiscardTimer = null;
      }
    }

    this.broadcastCurrentState();
    return { success: true };
  }

  protected handleAllInRunout(event: HandEvent, players: SeatedPlayer[]): void {
    if (event.type !== 'ALL_IN_RUNOUT' || !this.handController) return;

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

    // ═══════════════════════════════════════════════════════════════════════
    // EQUITY DISPLAY: Calculate and broadcast equity for ALL all-in players
    // This is shown on every table (insurance or not) for all players/observers.
    // ═══════════════════════════════════════════════════════════════════════
    if (allInPlayers.length >= 2) {
      void this.broadcastAllInEquity(allInPlayers, board, pot);
    }

    const insuranceEnabled = this.insuranceEngine.isEnabled(this.tableId);

    if (insuranceEnabled && board.length < 5 && allInPlayers.length >= 2) {
      // ═══════════════════════════════════════════════════════════════════════
      // INSURANCE TABLE: Per-street pause flow
      // Deal one street at a time, pause for insurance offers, then deal next.
      // Each street recalculates equity and re-offers to eligible players.
      // ═══════════════════════════════════════════════════════════════════════
      const offerPlayers = allInPlayers.map((p) => ({
        playerId: p.user_id,
        holeCards: p.cards || [],
      }));

      // runInsurancePerStreetFlow has no try/catch of its own and ends in
      // finalizeRunout()/continueRunout(). An unhandled rejection therefore
      // left the hand parked forever with no clock of any kind, because
      // HandController.advanceStage returns without setting currentPlayerSeat
      // while it waits for this callback to come back.
      this.runInsurancePerStreetFlow(offerPlayers, allInPlayers, pot).catch((err) => {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.insurance_flow_rejected');
        this.safeContinueRunout('insurance_flow_rejected');
      });
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
      const ritEnabled = this.runItTwiceEngine.isEnabled(this.tableId);
      if (ritEnabled && allInPlayers.length >= 2 && board.length < 5) {
        // Determine the chooser: player with the BEST ACTUAL HAND right now
        const variant = this.tableInfo?.game_variant || 'nlh';
        const isOmaha = variant.startsWith('plo');
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

        this.runItTwiceEngine.offer(
          this.tableId,
          `${this.tableId}:${this.handCount}`,
          chooserPlayerId,
          allPlayerIds,
          pot
        );

        // Broadcast RIT offer to ALL clients
        this.hub?.emitEvent(this.tableId, {
          type: 'rit_offer',
          table_id: this.tableId,
          hand_number: this.handCount,
          chooserPlayerId,
          allPlayerIds,
          pot,
          maxRuns: this.runItTwiceEngine.getChosenRuns(this.tableId),
          timeoutSeconds: 10,
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
            this.dealAndResolveRIT(allInPlayers);
          } else if (this.handController) {
            // Declined — normal single runout, paced (Dan item 16).
            void this.pacedAllInRunout(allInPlayers, pot);
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
        const result = controller.dealNextStreet();
        this.broadcastCurrentState();

        if (controller.getCommunityCards().length === before) {
          // The deck gave us nothing; stop rather than sleep and retry.
          reportError(
            new Error(
              '[PacedRunout] board stopped growing at ' + String(before) + ' cards — short deck'
            ),
            'ServerTableEngine.' + this.tableId + '.paced_runout_short_deck'
          );
          break;
        }

        if (allInPlayers.length >= 2) {
          await this.broadcastAllInEquity(allInPlayers, result.board, pot);
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
      this.safeContinueRunout('paced_runout_complete');
    }
  }

  protected safeContinueRunout(reason: string): void {
    try {
      this.handController?.continueRunout();
    } catch (err) {
      reportError(err, 'ServerTableEngine.' + this.tableId + '.forced_runout_failed', { reason });
    }
  }

  /**
   * HORSE RIT RESPONSES 2026-08-18: schedule horse answers to a live offer.
   *
   * - A horse CHOOSER picks the board count after ~1.2-2.4s: mostly 2, a
   *   third of hands 3 (varied deterministically by hand number - no
   *   Math.random in the engine's decision paths).
   * - Horse RESPONDERS accept after ~2.5-4s. Accepting before the chooser
   *   has decided is safe: the consent-race fix in RunItTwiceEngine records
   *   the accept and completes only once the chooser picks.
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
      const runs = (this.handCount % 3 === 0 ? 3 : 2) as 2 | 3;
      respond(1200 + (this.handCount % 5) * 240, () => {
        this.respondToRIT(chooserPlayerId, undefined, runs);
      });
    }
    for (const pid of allPlayerIds) {
      if (pid === chooserPlayerId || !horseIds.has(pid)) continue;
      respond(2500 + ((pid.charCodeAt(0) + this.handCount) % 4) * 400, () => {
        this.respondToRIT(pid, 'accept');
      });
    }
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
          new Error('RIT wait resolved into a different hand (#' + handAtOffer + ') — dropped'),
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
        this.safeContinueRunout('rit_oncomplete_threw');
      }
    };

    const checkInterval = setInterval(() => {
      const state = this.runItTwiceEngine.getState(this.tableId);
      // Complete when status is no longer 'offered' (accepted, declined, or resolved)
      if (!state || state.status !== 'offered') {
        finish();
      }
    }, 250);

    // FIX 98: Safety timeout: 18 seconds (5s chooser + 10s responders + 3s buffer)
    const safetyTimeout = setTimeout(() => {
      finish();
    }, 18_000);
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
  protected dealAndResolveRIT(allInPlayers: import('../types.js').SeatPlayer[]): void {
    if (!this.handController) return;

    const runs = this.runItTwiceEngine.getChosenRuns(this.tableId);
    if (runs < 2) {
      // Dan 2026-08-20: continueRunout() is the INSTANT synchronous loop —
      // flop, turn and river all land in one tick with no equity updates. A
      // hand that ends up running ONCE must still be watchable, exactly like
      // the ordinary all-in path. Pace it.
      void this.pacedAllInRunout(allInPlayers, this.handController.getState().pot);
      return;
    }

    const existingBoard = this.handController.getCommunityCards();
    const remainingDeck = this.handController.getRemainingDeck();
    const cardsNeeded = 5 - existingBoard.length;

    if (remainingDeck.length < cardsNeeded * runs) {
      reportError(
        new Error(
          `[ServerTableEngine:${this.tableId}] RIT: Not enough cards for ${runs} runouts (need ${cardsNeeded * runs}, have ${remainingDeck.length})`
        ),
        'ServerTableEnginethistableId.RIT'
      );
      this.handController.continueRunout();
      return;
    }

    // Deal independent boards
    const boards: import('../types.js').Card[][] = [];
    for (let r = 0; r < runs; r++) {
      const runCards = remainingDeck.slice(r * cardsNeeded, (r + 1) * cardsNeeded);
      boards.push([...existingBoard, ...runCards]);
    }

    // HAND HISTORY 2026-08-18: these boards are built OUTSIDE HandController,
    // so no COMMUNITY_CARDS events fire and currentHandCommunityCards stays
    // at the pre-all-in board - a preflop all-in RIT hand recorded NO board
    // at all. Record board 0 (the canonical, BBJ-eligible board) as the
    // hand's community cards and append each extra runout to the action log,
    // so the full multi-board hand is reconstructable from the record.
    this.currentHandCommunityCards = boards[0].map((c) => `${c.rank}${c.suit}`);
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
    this.handController.markFlopSeen();
    this.handController.settleUncalledBet();
    const pots = this.handController.computeLivePots();
    const variant = this.handController.getVariant();
    const dealerSeat = this.handController.getDealerSeat();
    const state = this.handController.getState();

    // Distribution: playerId → total chips won across all boards (pre-rake).
    const rawDistribution = new Map<string, number>();
    // MULTIWAY DISPLAY 2026-08-18: exact winner set per board (side pots and
    // splits included), so the client can label each run with who took it.
    const perBoardWinners: string[][] = [];
    for (let boardIdx = 0; boardIdx < runs; boardIdx++) {
      const board = boards[boardIdx];
      // determineWinners handles hi-lo split, short-deck, ties/odd-chip.
      const boardWinnersFull = determineWinners(state.players, board, pots, variant, dealerSeat);
      perBoardWinners.push([...new Set(boardWinnersFull.map((w) => w.userId))]);
      for (const w of boardWinnersFull) {
        rawDistribution.set(w.userId, (rawDistribution.get(w.userId) || 0) + w.amount / runs);
      }
    }

    // Deduct rake + BBJ once, scaling every winner proportionally (integer cents).
    const totalPot = pots.reduce((sum, p) => sum + p.amount, 0);
    const { rake, bbjFee } = this.handController.computeRakeAndBBJ();
    const netPot = Math.max(0, totalPot - rake - bbjFee);
    const rawTotal = [...rawDistribution.values()].reduce((s, a) => s + a, 0) || 1;

    const totalDistribution = new Map<string, number>();
    const netCents = Math.round(netPot * 100);
    let assignedCents = 0;
    const rawEntries = [...rawDistribution.entries()];
    for (const [pid, amount] of rawEntries) {
      const cents = Math.round((Math.round(amount * 100) * netCents) / Math.round(rawTotal * 100));
      totalDistribution.set(pid, cents / 100);
      assignedCents += cents;
    }
    // Repair rounding drift so sum(distribution) === netPot exactly.
    let remainderCents = netCents - assignedCents;
    for (let i = 0; i < rawEntries.length && remainderCents !== 0; i++) {
      const [pid] = rawEntries[i];
      const step = remainderCents > 0 ? 1 : -1;
      const cur = Math.round((totalDistribution.get(pid) || 0) * 100);
      if (cur + step >= 0) {
        totalDistribution.set(pid, (cur + step) / 100);
        remainderCents -= step;
      }
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
    this.handController.creditRunoutWinnings(totalDistribution);

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
      pots: pots.map((p) => ({ amount: p.amount, eligiblePlayers: p.eligiblePlayers })),
    });

    // Resolve in RIT engine (for event emission and cleanup)
    // Use first eligible winner per board for the engine's simpler tracking.
    const isOmaha = variant.startsWith('plo');
    const isShortDeck = variant === 'short_deck';
    const boardEvaluator = isOmaha
      ? evaluateOmahaHand
      : (h: import('../types.js').Card[], c: import('../types.js').Card[]) =>
          evaluateHand(h, c, isShortDeck);
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
    const firstBoard = boards[0];
    this.currentHandShowdownResults = allInPlayers
      .filter((p) => p.cards && p.cards.length > 0)
      .map((p) => {
        const hand = boardEvaluator(p.cards, firstBoard);
        return {
          userId: p.user_id,
          handRanking: hand.ranking ?? 0,
          handName: hand.name ?? '',
          kickers: hand.kickers ?? [],
          holeCards: p.cards.map((c) => ({ rank: c.rank, suit: c.suit })),
        };
      });
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
    this.handController.finalizeRunout(true);
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
  protected computeInsurancePricing(
    leaderId: string,
    allInForOffer: Array<{
      playerId: string;
      holeCards: import('../types.js').Card[];
      atRisk: number;
    }>,
    board: import('../types.js').Card[],
    variant: string,
    shortDeck: boolean
  ): { equity: number; strictLossPct: number; pushPct: number } | undefined {
    const leader = allInForOffer.find((p) => p.playerId === leaderId);
    if (!leader) return undefined;
    const opponents = allInForOffer.filter((p) => p.playerId !== leaderId).map((p) => p.holeCards);
    if (opponents.length === 0) return undefined;
    const r = insuranceEquity(leader.holeCards, opponents, board, variant, shortDeck);
    return { equity: r.equity, strictLossPct: r.strictLossPct, pushPct: r.pushPct };
  }

  protected async broadcastAllInEquity(
    allInPlayers: import('../types.js').SeatPlayer[],
    board: import('../types.js').Card[],
    pot: number
  ): Promise<void> {
    // PERF FIX (2026-07-24): equity now runs on the EquityWorkerPool (worker
    // threads) instead of a synchronous monteCarloEquity(...,5000) with a crypto
    // syscall per shuffle swap — which froze EVERY table for hundreds of ms on
    // each all-in. In an all-in every player's cards are known, so we price each
    // hand against the KNOWN others in ONE simulation (the true all-in equity),
    // off the main event loop. Degrades to a synchronous compute only if the pool
    // is unavailable.
    const isShortDeck = this.tableInfo?.game_variant === 'short_deck';
    const isOmaha = (this.tableInfo?.game_variant || '').startsWith('plo');
    const valid = allInPlayers.filter((p) => (p.cards || []).length >= 2);
    const equities: Array<{ userId: string; username: string; equity: number; seat: number }> = [];
    // ── ADDITIVE observability (#5): time the all-in equity computation ──
    const equityComputeStartMs = Date.now();

    try {
      const hands = valid.map((p) => p.cards || []);
      const fractions = await getEquityPool().estimateEquity(hands, board, [], 1000, {
        shortDeck: isShortDeck,
        omaha: isOmaha,
      });
      for (let i = 0; i < valid.length; i++) {
        equities.push({
          userId: valid[i].user_id,
          username: valid[i].username || 'Unknown',
          equity: Math.round(fractions[i] * 1000) / 10, // fraction -> % (1 dp)
          seat: valid[i].seat,
        });
      }
    } catch {
      // Degraded fallback (pool unavailable).
      // ANIMATION AUDIT 2026-08-19: this used to call monteCarloEquity, which
      // simulates RANDOM opponents instead of the KNOWN all-in hands and has
      // no Omaha branch — its numbers were wrong for PLO and noisy everywhere.
      // insuranceEquity is exact vs the known hands and variant-aware
      // (flop/turn enumerate <=990 boards; preflop samples 6,000 seeded).
      const variantName = this.tableInfo?.game_variant || 'nlh';
      for (const player of valid) {
        try {
          const opponents = valid
            .filter((o) => o.user_id !== player.user_id)
            .map((o) => o.cards || []);
          const r = insuranceEquity(player.cards || [], opponents, board, variantName, isShortDeck);
          equities.push({
            userId: player.user_id,
            username: player.username || 'Unknown',
            equity: Math.round(r.equity * 10) / 10,
            seat: player.seat,
          });
        } catch {
          // Last resort for this one player: NLH-only Monte-Carlo, but never
          // for Omaha (no evaluator — better to omit than to lie).
          if (!isOmaha) {
            const equity = monteCarloEquity(
              player.cards || [],
              board,
              valid.length - 1,
              1000,
              isShortDeck
            );
            equities.push({
              userId: player.user_id,
              username: player.username || 'Unknown',
              equity: Math.round(equity * 10) / 10,
              seat: player.seat,
            });
          }
        }
      }
    }

    // ── ADDITIVE observability (#5): observe all-in equity compute duration ──
    try {
      EngineMetrics.allInEquityDuration.observe(Date.now() - equityComputeStartMs, {
        table_id: this.tableId,
      });
    } catch {
      /* metrics must never affect gameplay */
    }
    // Broadcast to all clients — this is public information during all-in
    this.hub?.emitEvent(this.tableId, {
      type: 'all_in_equity',
      table_id: this.tableId,
      hand_number: this.handCount,
      board: board.map((c) => `${c.rank}${c.suit}`),
      pot,
      equities,
    });
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
    pot: number
  ): Promise<void> {
    if (!this.handController) return;

    // ANIMATION AUDIT 2026-08-19: give the CURRENT board + percentages a
    // readable beat before the next card lands. The insurance flow used to
    // rely entirely on the 15s offer window for pacing — but when no offer is
    // created (tied hands) or the horse leader answers in ~1s, streets fired
    // back-to-back with no gap at all.
    await this.sleep(this.allInStreetPauseMs);
    if (!this.handController) return;

    // Deal the next street
    const result = this.handController.dealNextStreet();
    this.broadcastCurrentState();

    // ═══════════════════════════════════════════════════════════════════════
    // RE-BROADCAST EQUITY: Update on-screen equity percentages per street.
    // All players and observers see updated equity as each card is dealt.
    // Uses the original allInPlayers (SeatPlayer[]) for proper username/seat data.
    // ═══════════════════════════════════════════════════════════════════════
    await this.broadcastAllInEquity(allInPlayers, result.board, pot);

    const offerTimeout = 15; // Matches InsuranceEngine DEFAULT_CONFIG.offerTimeoutSeconds

    // ═══════════════════════════════════════════════════════════════════════
    // FIX 103: Insurance is ONLY offered to the player with the BEST HAND.
    // Dan's rules:
    // - Evaluate all all-in players' hands against the current board
    // - Find the leader (best actual hand, not equity percentages)
    // - If players are TIED (same hand rank + kickers), NO insurance offered
    // - On later streets, re-evaluate — if a different player takes the lead,
    //   insurance is offered to THEM (if they haven't declined for hand)
    // ═══════════════════════════════════════════════════════════════════════
    const variant = this.tableInfo?.game_variant || 'nlh';
    const isOmaha = variant.startsWith('plo');
    const handEvaluator = isOmaha ? evaluateOmahaHand : evaluateHand;

    // Evaluate all hands on current board
    const playerEvals = offerPlayers.map((p) => ({
      ...p,
      hand: handEvaluator(p.holeCards, result.board),
    }));

    // Sort by hand rank descending (best first)
    playerEvals.sort((a, b) => compareHands(b.hand, a.hand));

    // Check for tie: if top two players have identical hands, no insurance
    const isTied =
      playerEvals.length >= 2 && compareHands(playerEvals[0].hand, playerEvals[1].hand) === 0;

    const bestHandPlayer = isTied ? null : playerEvals[0];

    // FIX 139: Pass shortDeck to insurance engine for correct equity calculations
    const isShortDeckInsurance = this.tableInfo?.game_variant === 'short_deck';

    // FIX-A12: full all-in set with each player's at-risk (their own committed
    // chips) so the engine prices the leader against the KNOWN opponent hands.
    const allInForOffer = allInPlayers.map((p) => ({
      playerId: p.user_id,
      holeCards: p.cards || [],
      atRisk: p.totalInvested ?? 0,
    }));

    // PERF FIX (2026-07-24): precompute the leader's insurance equity OFF the
    // event loop (EquityWorkerPool), once per street, then hand it to
    // createOffers so the heavy board enumeration never blocks the main loop.
    let leaderPricing: { equity: number; strictLossPct: number; pushPct: number } | undefined;
    if (bestHandPlayer) {
      leaderPricing = this.computeInsurancePricing(
        bestHandPlayer.playerId,
        allInForOffer,
        result.board,
        variant,
        isShortDeckInsurance
      );
    }

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
          pot,
          variant,
          isShortDeckInsurance,
          leaderPricing
        );

        if (offers.length > 0) {
          this.broadcastInsuranceOffers(offers, pot, offerTimeout);
          this.scheduleHorseInsuranceResponse(bestHandPlayer.playerId);
        }
      } else {
        console.log(
          `[ServerTableEngine:${this.tableId}] Insurance: Tied hands — no insurance offered`
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
            pot,
            variant,
            isShortDeckInsurance,
            leaderPricing
          );

          if (offers.length > 0) {
            this.broadcastInsuranceOffers(offers, pot, offerTimeout);
            this.scheduleHorseInsuranceResponse(bestHandPlayer.playerId);
          }
        }
      } else {
        console.log(
          `[ServerTableEngine:${this.tableId}] Insurance: Tied hands on new street — no insurance offered`
        );
      }
    }

    // If all 5 cards are dealt, finalize after insurance responses
    if (result.complete) {
      // Wait for any pending offers then finalize
      this.waitForInsuranceResponses(() => {
        if (this.handController) {
          this.handController.finalizeRunout();
        }
      });
    } else {
      // More streets to come — wait for responses, then check eligibility
      this.waitForInsuranceResponses(() => {
        // ═══════════════════════════════════════════════════════════════════
        // FIX 88: Check if per-street pause should continue or revert to
        // instant runout. If ALL players have declined for the entire hand,
        // the per-street pause is VOID — run out remaining streets instantly.
        // If at least one player hasn't declined for hand, continue pausing.
        //
        // Dan's rule: "THIS IS VOID IF THE PLAYER DECLINES INSURANCE FOR
        // HAND OPTION. IT WILL RUN OUT NORMAL, UNLESS THAT PLAYER IS NOT
        // 'BEHIND' — INSURANCE WILL BE OFFERED TO THE PLAYER THAT IS
        // 'AHEAD' IF ANY STREETS ARE STILL PENDING."
        // ═══════════════════════════════════════════════════════════════════
        if (!this.insuranceEngine.anyEligibleForInsurance(this.tableId)) {
          // ALL players declined for hand — per-street pause is void.
          // Deal remaining streets instantly and finalize.
          console.log(
            `[ServerTableEngine:${this.tableId}] All players declined insurance for hand — switching to paced runout`
          );
          // ANIMATION AUDIT 2026-08-19: was continueRunout() — the INSTANT
          // synchronous loop. Declining insurance must not also skip the
          // watchable street-by-street runout with equity updates; the paced
          // path finishes with safeContinueRunout itself.
          if (this.handController) {
            void this.pacedAllInRunout(allInPlayers, pot);
          }
        } else {
          // At least one player eligible — continue per-street pause
          // runInsurancePerStreetFlow has no try/catch of its own and ends in
          // finalizeRunout()/continueRunout(). An unhandled rejection therefore
          // left the hand parked forever with no clock of any kind, because
          // HandController.advanceStage returns without setting currentPlayerSeat
          // while it waits for this callback to come back.
          this.runInsurancePerStreetFlow(offerPlayers, allInPlayers, pot).catch((err) => {
            reportError(err, 'ServerTableEngine.' + this.tableId + '.insurance_flow_rejected');
            this.safeContinueRunout('insurance_flow_rejected');
          });
        }
      });
    }
  }

  /**
   * Broadcast insurance offers to clients via Supabase Realtime.
   * Includes all fields needed for the InsurancePanel slider UI.
   */
  protected broadcastInsuranceOffers(
    offers: import('./InsuranceEngine.js').InsuranceOffer[],
    pot: number,
    timeoutSeconds: number
  ): void {
    this.hub?.emitEvent(this.tableId, {
      type: 'insurance_offers',
      table_id: this.tableId,
      hand_number: this.handCount,
      pot,
      offers: offers.map((o) => ({
        playerId: o.playerId,
        equity: o.equity,
        fullPremium: o.fullPremium,
        premium: o.premium,
        fullInsuredAmount: o.fullInsuredAmount,
        insuredAmount: o.insuredAmount,
        coveragePercent: o.coveragePercent,
        timeoutSeconds,
      })),
    });
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
      900 + (this.handCount % 4) * 150
    );
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
            'Insurance wait resolved into a different hand (#' + handAtOffer + ') — dropped'
          ),
          'ServerTableEngine.' + this.tableId + '.insurance_wait_stale'
        );
        return;
      }
      try {
        onComplete();
      } catch (err) {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.insurance_oncomplete_threw');
        this.safeContinueRunout('insurance_oncomplete_threw');
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
          `[ServerTableEngine:${this.tableId}] Insurance safety timeout — forcing continue`
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
