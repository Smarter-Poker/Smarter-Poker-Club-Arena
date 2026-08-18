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

        let chooserPlayerId = allInPlayers[0].user_id;
        let bestEval = evaluator(allInPlayers[0].cards || [], board);

        for (let i = 1; i < allInPlayers.length; i++) {
          const playerEval = evaluator(allInPlayers[i].cards || [], board);
          if (compareHands(playerEval, bestEval) > 0) {
            bestEval = playerEval;
            chooserPlayerId = allInPlayers[i].user_id;
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
            // Declined — normal single runout
            this.handController.continueRunout();
          }
        });
      } else {
        // NO INSURANCE, NO RIT: Instant full runout (standard behavior)
        this.handController.continueRunout();
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
  protected safeContinueRunout(reason: string): void {
    try {
      this.handController?.continueRunout();
    } catch (err) {
      reportError(err, 'ServerTableEngine.' + this.tableId + '.forced_runout_failed', { reason });
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
      this.handController.continueRunout();
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
    this.handController.settleUncalledBet();
    const pots = this.handController.computeLivePots();
    const variant = this.handController.getVariant();
    const dealerSeat = this.handController.getDealerSeat();
    const state = this.handController.getState();

    // Distribution: playerId → total chips won across all boards (pre-rake).
    const rawDistribution = new Map<string, number>();
    for (let boardIdx = 0; boardIdx < runs; boardIdx++) {
      const board = boards[boardIdx];
      // determineWinners handles hi-lo split, short-deck, ties/odd-chip.
      const boardWinnersFull = determineWinners(state.players, board, pots, variant, dealerSeat);
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
   * Compute the insurance leader's pot-win equity (percent) against the KNOWN
   * opponent hands. Offloaded to the EquityWorkerPool when workers are available;
   * otherwise falls back to the synchronous EXACT enumeration (insuranceEquity),
   * keeping money-pricing accuracy in the degraded mode.
   */
  protected async computeInsuranceLeaderEquity(
    leaderId: string,
    allInForOffer: Array<{
      playerId: string;
      holeCards: import('../types.js').Card[];
      atRisk: number;
    }>,
    board: import('../types.js').Card[],
    variant: string,
    shortDeck: boolean
  ): Promise<number> {
    const leader = allInForOffer.find((p) => p.playerId === leaderId);
    if (!leader) return 0;
    const opponents = allInForOffer.filter((p) => p.playerId !== leaderId).map((p) => p.holeCards);
    if (opponents.length === 0) return 0;

    const isOmaha = variant.startsWith('plo');
    const pool = getEquityPool();
    if (pool.isAvailable()) {
      try {
        const fractions = await pool.estimateEquity(
          [leader.holeCards, ...opponents],
          board,
          [],
          2000,
          { shortDeck, omaha: isOmaha }
        );
        return Math.round(fractions[0] * 1000) / 10; // fraction -> % (1 dp)
      } catch {
        /* fall through to exact synchronous pricing */
      }
    }
    return insuranceEquity(leader.holeCards, opponents, board, variant, shortDeck).equity;
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
      // Degraded fallback: synchronous Monte-Carlo (fewer iters, no offload).
      const numOpponents = valid.length - 1;
      for (const player of valid) {
        const equity = monteCarloEquity(player.cards || [], board, numOpponents, 1000, isShortDeck);
        equities.push({
          userId: player.user_id,
          username: player.username || 'Unknown',
          equity: Math.round(equity * 10) / 10,
          seat: player.seat,
        });
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
    let leaderEquityPct: number | undefined;
    if (bestHandPlayer) {
      leaderEquityPct = await this.computeInsuranceLeaderEquity(
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
          leaderEquityPct
        );

        if (offers.length > 0) {
          this.broadcastInsuranceOffers(offers, pot, offerTimeout);
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
            leaderEquityPct
          );

          if (offers.length > 0) {
            this.broadcastInsuranceOffers(offers, pot, offerTimeout);
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
            `[ServerTableEngine:${this.tableId}] All players declined insurance for hand — switching to instant runout`
          );
          if (this.handController) {
            this.handController.continueRunout();
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
