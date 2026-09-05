/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HAND CONTROLLER — Server-Side
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages the flow of a single poker hand: dealing, betting rounds, showdown.
 * Pure TypeScript, ZERO browser dependencies.
 */

import {
  Deck,
  evaluateHand,
  evaluateOmahaHand,
  evaluateOmahaLowHand,
  calculatePots,
  calculateBettingState,
  validateAction,
  calculateRake,
  determineWinners,
  describeHand,
  compareHands,
  compareLowHands,
} from './PokerEngine.js';
import {
  isFixedLimitVariant,
  isPotLimitVariant,
  fixedLimitBetSize,
  isFixedLimitCapped,
} from './BettingStructure.js';
import { bestPineappleDiscard } from './pineappleDiscardChoice.js';
import {
  deckSizeFor,
  holeCardCount,
  isHiLoVariant,
  isOmahaVariant,
  isShortDeckVariant,
} from './VariantRules.js';

import type {
  Card,
  HandStage,
  SeatPlayer,
  ActionType,
  GameVariant,
  HandConfig,
  GameState,
  ActionRecord,
  HandEvent,
  ShowdownResult,
  EvaluatedHand,
  Pot,
  Winner,
  PerPotAward,
  RakeConfig,
  BettingState,
} from '../types.js';

import { reportError } from '../services/errorReporter.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { createHandStateMachine, type HandFSMState } from './StateMachine.js';
import { bigBlindAnteTotal } from './AnteMath.js';
import { HAND_COMPLETION } from '../config/handCompletionSpec.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HAND CONTROLLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Scale winners' pre-rake amounts down to the post-rake total, in whole cents.
 *
 * Exported and pure so the invariant below can be tested directly rather than
 * only through a 10,000-hand fuzz run.
 *
 * TWO POST-CONDITIONS, both load-bearing:
 *   1. `sum(result) === round(totalWinnings * 100)` — no chip is created or
 *      destroyed by the rake deduction.
 *   2. `result[i] <= round(preRakeAmounts[i] * 100)` — no winner is paid more
 *      than they were entitled to BEFORE rake. Rake only ever takes away, so a
 *      winner rising above their pre-rake figure means a cent moved from
 *      another winner's stack into theirs.
 *
 * (2) is the one that was broken. The rounding remainder was handed to
 * `adjusted[0]` unconditionally, and index 0 is the MAIN-pot winner — by
 * construction the shortest all-in stack at the table. In a side-pot hand that
 * player is not eligible for the chips above the main pot, so the cent came out
 * of a side-pot winner. Found by the D24 chip-conservation fuzzer (INV-7):
 * main pot 1.93, u3 all-in for 0.32, four side pots above them; u3 was eligible
 * for 1.93 and was paid 1.94. Totals still balanced, which is exactly why plain
 * conservation never caught it — the cent moved between players.
 *
 * Placing the remainder under the pre-rake caps always succeeds: total headroom
 * is `rakeCents + remainder`, which is never less than `remainder`.
 */
export function scaleWinnerCentsForRake(
  preRakeAmounts: readonly number[],
  totalWinnings: number
): number[] {
  // Round 40 audit Pass 3 fix: integer-cents arithmetic with Math.round (NOT
  // Math.trunc) for the float->cents conversion. IEEE 754 drift can make a pot
  // of "$140.30" actually be 140.29999..., and Math.trunc(140.299... * 100) is
  // 13479 rather than 13480 — exactly 1c lost per chop pot with any drift.
  const totalCents = Math.round(totalWinnings * 100);
  const entitlementCents = preRakeAmounts.map((a) => Math.round(a * 100));
  const totalWinnerCents = entitlementCents.reduce((s, c) => s + c, 0) || 1;

  const adjusted = entitlementCents.map((c) => Math.round((c * totalCents) / totalWinnerCents));

  let remainder = totalCents - adjusted.reduce((s, a) => s + a, 0);

  // Positive remainder: rounding dust. Place it only where it does not exceed
  // the winner's pre-rake entitlement.
  let placedOne = true;
  while (remainder > 0 && placedOne) {
    placedOne = false;
    for (let i = 0; i < adjusted.length && remainder > 0; i++) {
      if (adjusted[i] >= entitlementCents[i]) continue;
      adjusted[i]++;
      remainder--;
      placedOne = true;
    }
  }

  // Negative remainder: rounding overshot. Pull back evenly, never below zero.
  let pulledOne = true;
  while (remainder < 0 && pulledOne) {
    pulledOne = false;
    for (let i = 0; i < adjusted.length && remainder < 0; i++) {
      if (adjusted[i] <= 0) continue;
      adjusted[i]--;
      remainder++;
      pulledOne = true;
    }
  }

  return adjusted;
}

export class HandController {
  private config: HandConfig;
  private state: GameState;
  private eventHandlers: ((event: HandEvent) => void)[] = [];
  /** FIX 120: Crazy Pineapple — tracks seats that still need to discard after flop */
  private pineappleDiscardsRemaining: Set<number> = new Set();
  /**
   * DOUBLE-BOARD BOMB POT 2026-08-20 / TRIPLE-BOARD 2026-08-27: how many
   * boards THIS hand actually deals — 1, 2 or 3 — set in postBombPotAntes()
   * from the configured board count, downgraded stepwise (3 → 2 → 1) until
   * the deck can cover players × holeCards + 5 × boards cards. Every
   * dealing/showdown path consults this, never the raw config.
   */
  private activeBoardCount: 1 | 2 | 3 = 1;
  /** Convenience: at least two boards are live this hand. */
  private get multiBoardActive(): boolean {
    return this.activeBoardCount >= 2;
  }
  /** Round 2: per-board winner breakdown for the next WINNERS emit (multi-board only). */
  private pendingWinnersByBoard:
    | Array<{ board: 1 | 2 | 3; userId: string; amount: number; handName?: string }>
    | undefined;
  /**
   * SHOWDOWN SYSTEM 2026-08-25 (Dan spec section 8): set the moment an all-in
   * ends all possible betting with cards to come. At such a showdown every
   * live hand is exposed and nobody may muck — cash, tournament, heads-up,
   * multiway, main pots and side pots alike. Per-hand: a HandController lives
   * for exactly one hand, so no reset is needed.
   */
  private allInShowdownLocked = false;
  /**
   * SHOWDOWN POLISH 2026-08-25: the unmerged per-pot(-half) award breakdown
   * collected by determineWinners for the WINNERS emit. Per-hand — a
   * HandController lives for exactly one hand.
   */
  private pendingPerPotAwards: PerPotAward[] = [];
  /** FIX-225: Bible V8 §1.6/§3.2 — Formal Hand State Machine */
  private handFSM = createHandStateMachine('idle');

  constructor(config: HandConfig, players: SeatPlayer[], dealerSeat: number) {
    this.config = config;

    const deck = new Deck();
    if (config.gameVariant === 'short_deck') {
      deck.removeCardsBelow('6');
    }

    this.state = {
      stage: 'preflop' as HandStage,
      deck: deck as any, // Internal only
      communityCards: [],
      communityCards2: [],
      communityCards3: [],
      pot: 0,
      currentBet: 0,
      lastRaise: config.bigBlind,
      minRaise: config.bigBlind,
      dealerSeat,
      currentPlayerSeat: -1,
      players: this.initializePlayers(players),
      pots: [],
      actionHistory: [],
      sawFlop: false,
      lastAggressorSeat: -1, // Bible V8 §4.21: Track for showdown reveal order
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event System
  // ─────────────────────────────────────────────────────────────────────────

  onEvent(handler: (event: HandEvent) => void): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  private emit(event: HandEvent): void {
    for (const handler of this.eventHandlers) {
      // 2026-08-22: per-listener guard. An unguarded throw here aborted the
      // remaining listeners AND unwound back into the middle of
      // performAction/completeHand — mid-settlement state corruption from a
      // subscriber bug. A listener failure is the listener's problem.
      try {
        handler(event);
      } catch (err) {
        console.error('[HandController] event listener threw on ' + event.type + ':', err);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FIX-225: Stage Transition with FSM Validation
  // ─────────────────────────────────────────────────────────────────────────

  /** Map HandStage strings to HandFSMState for validation */
  private static readonly STAGE_TO_FSM: Record<string, HandFSMState> = {
    preflop: 'preflop',
    flop: 'flop',
    pineapple_discard: 'pineapple_discard',
    turn: 'turn',
    river: 'river',
    showdown: 'showdown',
  };

  /**
   * Transition to a new hand stage with FSM validation.
   * The FSM validates the transition is legal per Bible V8 §3.2.
   * If invalid, logs warning but still sets stage (defensive — don't break game).
   */
  private transitionStage(newStage: HandStage): void {
    const fsmState = HandController.STAGE_TO_FSM[newStage];
    if (fsmState) {
      this.handFSM.transition(fsmState);
    }
    this.state.stage = newStage;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────

  private initializePlayers(players: SeatPlayer[]): SeatPlayer[] {
    return players.map((p) => ({
      ...p,
      bet: 0,
      totalInvested: 0,
      returnedUncalled: 0,
      deadInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Start Hand
  // ─────────────────────────────────────────────────────────────────────────

  start(): void {
    /* ═══ A HAND THAT IS STARTING MUST BE A BLANK HAND (2026-08-31) ════════
       The rake-law alarm's no_flop_no_drop criticals were hands played inside
       a controller that a STALE runout continuation from the PREVIOUS hand
       had already driven to showdown - sawFlop true, phantom board dealt into
       the void - before start() ever ran. start() never reset the stage, so
       live betting proceeded inside the corpse: no street could ever deal
       (advanceStage has no 'showdown' case), big blinds were walked through
       folds on uncontested pots, and the fold-out settlement priced rake on
       sawFlop=true. The runout entry points now refuse an unstarted hand
       (refuseUnlessRunout below), so this cannot recur by that path - but if
       ANY path ever corrupts a pre-start controller again, say so loudly and
       deal a clean hand instead of a broken one. */
    if (
      this.state.stage !== 'preflop' ||
      this.state.sawFlop ||
      this.state.communityCards.length > 0
    ) {
      reportError(
        new Error(
          `[HandController] hand ${this.config.handNumber} is starting DIRTY: ` +
            `stage=${this.state.stage} sawFlop=${this.state.sawFlop} ` +
            `board=${this.state.communityCards.length} - reset to a blank preflop hand`
        ),
        'HandController.dirty_start'
      );
      this.state.stage = 'preflop';
      this.state.sawFlop = false;
      this.state.communityCards = [];
      this.state.communityCards2 = [];
      this.state.communityCards3 = [];
      this.boardDealtOutsideState = false;
    }
    this.handStarted = true;
    // FIX-225: FSM transitions for hand start sequence
    this.handFSM.transition('posting_blinds');

    this.emit({
      type: 'HAND_START',
      handNumber: this.config.handNumber,
      players: this.state.players,
    });

    if (this.config.bombPot) {
      this.postBombPotAntes();
      this.handFSM.transition('dealing');
      this.dealHoleCards();
      // 2026-08-20 (chip-conservation property test, D24): this branch used to
      // go straight from 'dealing' into advanceStage(), which calls
      // transitionStage('flop') — and 'dealing' -> 'flop' is not a legal edge,
      // so the FSM REJECTED it and stayed parked on 'dealing' for the whole
      // hand. Every subsequent transition was then invalid too, so a single
      // bomb pot logged 'dealing -> flop', 'dealing -> showdown',
      // 'dealing -> settlement' and 'dealing -> idle' to reportError/Sentry.
      // state.stage was always correct (transitionStage sets it regardless),
      // so play was never affected — but the FSM, whose entire job is to make
      // an illegal hand flow detectable, was reporting a false positive on
      // every bomb pot and would have masked a real violation.
      //
      // A bomb pot IS at preflop; it simply has no preflop betting round. Say
      // so, and the existing preflop -> flop / preflop -> showdown edges cover
      // both the normal deal and the everyone-all-in-from-antes runout.
      this.handFSM.transition('preflop');
      // Bible V8 §4.22: Bomb pot skips preflop betting — deal directly to flop
      this.advanceStage(); // preflop → flop, deals 3 community cards, sets first postflop player
      return;
    }

    this.postBlinds();
    this.handFSM.transition('dealing');
    this.dealHoleCards();
    this.handFSM.transition('preflop');
    this.setNextPlayer();
    // AUDIT FIX 2026-07-19: if the blinds/antes put everyone all-in (e.g. HU
    // where both stacks <= their blind), no player can act. Previously
    // emitTurnChange() no-op'd on currentPlayerSeat === -1 and the hand hung
    // until the 10-minute safety void (blinds effectively refunded). Advance
    // straight into the runout instead.
    if (this.state.currentPlayerSeat === -1) {
      this.advanceGame();
    } else {
      this.emitTurnChange();
    }
  }

  private postBlinds(): void {
    const { smallBlind, bigBlind } = this.config;
    const activePlayers = this.getActivePlayers();
    if (activePlayers.length < 2) return;

    const isHeadsUp = activePlayers.length === 2;
    const sbSeat = isHeadsUp
      ? this.state.dealerSeat
      : this.getNextActiveSeat(this.state.dealerSeat);
    const bbSeat = this.getNextActiveSeat(sbSeat);

    const sbPlayer = this.state.players.find((p) => p.seat === sbSeat);
    if (sbPlayer) {
      const sbAmount = Math.min(smallBlind, sbPlayer.stack);
      sbPlayer.bet = sbAmount;
      sbPlayer.totalInvested += sbAmount;
      sbPlayer.stack -= sbAmount;
      this.state.pot += sbAmount;
      if (sbPlayer.stack === 0) sbPlayer.is_all_in = true;
    }

    const bbPlayer = this.state.players.find((p) => p.seat === bbSeat);
    if (bbPlayer) {
      const bbAmount = Math.min(bigBlind, bbPlayer.stack);
      bbPlayer.bet = bbAmount;
      bbPlayer.totalInvested += bbAmount;
      bbPlayer.stack -= bbAmount;
      this.state.pot += bbAmount;
      // Bible V8 §4.2 / §7.2 — the price to enter is the BIG BLIND, not what
      // the big blind could afford.
      //
      // This used to be `= bbAmount`, i.e. min(bigBlind, stack). A big blind
      // all-in for less than a full blind therefore made the hand cheaper for
      // everyone behind them: with a 1.00 BB and a 0.40 stack, currentBet
      // became 0.40 and the whole table entered for 0.40. The short blind is
      // all-in for less and can only win what they matched — that is what the
      // side pots are for — but the price for everyone else does not move.
      //
      // Worse, when the BB's stack was below the SMALL blind the bet level
      // ended up BELOW an already-posted live bet: SB posts 0.50, BB is all-in
      // for 0.20, currentBet = 0.20, so the SB's toCall is −0.30. `call` then
      // runs Math.min(negative, stack), which ADDS to the caller's stack and
      // SUBTRACTS from the pot — a call that mints chips.
      //
      // Math.max keeps this monotonic: the level can only ever be raised by a
      // blind, never lowered. The straddle block below deliberately raises it
      // further.
      this.state.currentBet = Math.max(this.state.currentBet, bigBlind);
      if (bbPlayer.stack === 0) bbPlayer.is_all_in = true;
    }

    // Bible V8 §4.2: Dead blinds — players returning from sit-out post SB+BB (SB is dead money)
    if (this.config.deadBlinds && this.config.deadBlinds.length > 0) {
      for (const db of this.config.deadBlinds) {
        const dbPlayer = this.state.players.find((p) => p.seat === db.seat);
        if (dbPlayer && dbPlayer.seat !== sbSeat && dbPlayer.seat !== bbSeat) {
          // Dead SB goes straight to pot (dead money, not a live bet)
          const deadSBAmount = Math.min(smallBlind, dbPlayer.stack);
          dbPlayer.totalInvested += deadSBAmount;
          dbPlayer.deadInvested = (dbPlayer.deadInvested ?? 0) + deadSBAmount;
          dbPlayer.stack -= deadSBAmount;
          this.state.pot += deadSBAmount;
          // Live BB — counts as their current bet
          if (dbPlayer.stack > 0) {
            const liveBBAmount = Math.min(bigBlind, dbPlayer.stack);
            dbPlayer.bet = liveBBAmount;
            dbPlayer.totalInvested += liveBBAmount;
            dbPlayer.stack -= liveBBAmount;
            this.state.pot += liveBBAmount;
          }
          if (dbPlayer.stack === 0) dbPlayer.is_all_in = true;
        }
      }
    }

    // AUDIT FIX 2026-07-19: "Post BB to enter" — new players post ONLY a live
    // BB (no dead SB). They act on it like a normal blind.
    if (this.config.bbOnlyPosts && this.config.bbOnlyPosts.length > 0) {
      for (const bp of this.config.bbOnlyPosts) {
        const p = this.state.players.find((pl) => pl.seat === bp.seat);
        if (p && p.seat !== sbSeat && p.seat !== bbSeat && !p.is_sitting_out) {
          const amt = Math.min(bigBlind, p.stack);
          p.bet = amt;
          p.totalInvested += amt;
          p.stack -= amt;
          this.state.pot += amt;
          if (p.stack === 0) p.is_all_in = true;
        }
      }
    }

    /**
     * FORCED MONEY, SNAPSHOT ONE OF THREE (2026-08-27).
     *
     * Everything posted above — small blind, big blind, dead blinds, "post BB
     * to enter" — went into the pot and into `totalInvested` and into NO
     * action record. Neither did the antes and straddles below. `actions` is
     * the only per-hand log that is persisted, so every consumer that tries to
     * rebuild a pot, an investment or a stack from `hand_history` is short by
     * exactly the forced money, on every hand that has any.
     *
     * That is not theoretical: reconstructing the 4,000 most recent live hands
     * lands on the stored `pot_size` on 99.18%, and every miss is a hand with
     * an ante or a straddle. Those are the hands where the rundown has to drop
     * its stack column rather than draw one that is wrong.
     *
     * Rather than instrument six separate posting branches — and miss the
     * seventh someone adds later — the totals are SNAPSHOT at three points and
     * differenced. `totalInvested` is zero at the top of the hand and nobody
     * has acted voluntarily yet, so at this line it is precisely the blind
     * money, after the ante block it is blinds + antes, and after the straddle
     * block it is all three. A new posting path lands in whichever bucket it
     * sits between and is recorded whether or not anyone remembered to.
     */
    const investedSnapshot = (): Map<number, { total: number; dead: number }> =>
      new Map(
        this.state.players.map((p) => [
          p.seat,
          {
            total: Math.round((p.totalInvested ?? 0) * 100) / 100,
            dead: Math.round((p.deadInvested ?? 0) * 100) / 100,
          },
        ])
      );
    const afterBlinds = investedSnapshot();

    if (this.config.ante) {
      if (this.config.bigBlindAnte && bbPlayer) {
        // Bible V8 §4.3: BBA — Big blind posts ante for entire table.
        // The seat-count multiply lives in bigBlindAnteTotal now, because a
        // structure that authors `ante` as the TOTAL (ante == bigBlind, the
        // modern standard) was being charged one big blind PER SEAT — 7 to 8
        // big blinds a hand, measured live 2026-08-30. See AnteMath.ts.
        const totalBBA = bigBlindAnteTotal(
          this.config.ante,
          activePlayers.length,
          this.config.bigBlind
        );
        const bbaAmount = Math.min(totalBBA, bbPlayer.stack);
        bbPlayer.totalInvested += bbaAmount;
        // Dead money: the BB fronts the whole table's ante. It belongs to the
        // pot, not to the BB as an uncalled bet or a private side pot.
        bbPlayer.deadInvested = (bbPlayer.deadInvested ?? 0) + bbaAmount;
        bbPlayer.stack -= bbaAmount;
        this.state.pot += bbaAmount;
        if (bbPlayer.stack === 0) bbPlayer.is_all_in = true;
      } else {
        // Traditional ante: each player posts individually
        for (const player of this.state.players.filter((p) => !p.is_sitting_out)) {
          const anteAmount = Math.min(this.config.ante, player.stack);
          player.totalInvested += anteAmount;
          // Dead money — antes never count as a live bet toward a call.
          player.deadInvested = (player.deadInvested ?? 0) + anteAmount;
          player.stack -= anteAmount;
          this.state.pot += anteAmount;
          if (player.stack === 0) player.is_all_in = true;
        }
      }
    }

    /** FORCED MONEY, SNAPSHOT TWO OF THREE: blinds + antes. */
    const afterAntes = investedSnapshot();

    // Bible V8 §4.4: Post straddles after blinds/antes
    if (this.config.straddles && this.config.straddles.length > 0) {
      for (const straddle of this.config.straddles) {
        const straddler = this.state.players.find((p) => p.seat === straddle.seat);
        if (straddler && !straddler.is_sitting_out && straddler.stack >= straddle.amount) {
          const straddleAmount = Math.min(straddle.amount, straddler.stack);
          straddler.bet = straddleAmount;
          straddler.totalInvested += straddleAmount;
          straddler.stack -= straddleAmount;
          this.state.pot += straddleAmount;
          this.state.currentBet = straddleAmount;
          // AUDIT FIX 2026-07-19: the straddle is a live blind that raises the
          // BB — the minimum raise is to DOUBLE the straddle (4×BB for a 2×BB
          // straddle). Track lastRaise/minRaise = straddle amount so the raise
          // floor is currentBet + straddle (was left at BB → only 3×BB).
          this.state.lastRaise = straddleAmount;
          this.state.minRaise = straddleAmount;
          // Straddle is live — straddler can raise when action comes back (§4.4)
          if (straddler.stack === 0) straddler.is_all_in = true;

          // Phase X5 (2026-04-29) — Bible V8 §1.16 discrete event so the
          // client can render the "STRADDLE" tag + chip-to-pot animation
          // without inferring it from a state-snapshot diff.
          this.emit({
            type: 'STRADDLE_POSTED',
            seat: straddle.seat,
            amount: straddleAmount,
            user_id: straddler.user_id,
          } as never);
        }
      }
    }

    this.emit({ type: 'POT_UPDATE', pot: this.state.pot, pots: this.state.pots });

    // Bible V8 §1.16 (Real-Time Law) — emit a BLINDS_POSTED event so the
    // ServerTableEngine can re-emit it to the WS hub for the chip-to-pot
    // animation. The client must NOT need to diff the snapshot to discover
    // the SB/BB went into the pot.
    const blindsPostings: Array<{ seat: number; type: string; amount: number }> = [];
    if (sbPlayer) {
      const sbAmount = Math.min(smallBlind, sbPlayer.bet); // bet has been set to actual paid
      if (sbAmount > 0)
        blindsPostings.push({ seat: sbSeat, type: 'small_blind', amount: sbAmount });
    }
    if (bbPlayer) {
      const bbAmount = Math.min(bigBlind, bbPlayer.bet);
      if (bbAmount > 0) blindsPostings.push({ seat: bbSeat, type: 'big_blind', amount: bbAmount });
    }
    if (blindsPostings.length > 0) {
      this.emit({ type: 'BLINDS_POSTED', postings: blindsPostings } as any);
    }

    /**
     * FORCED MONEY, SNAPSHOT THREE OF THREE, and the event that records it.
     *
     * Separate from BLINDS_POSTED on purpose. That event drives the client's
     * chip-to-pot animation and carries only the SB and BB; adding nine ante
     * postings to it would change what every table animates. This one is for
     * the hand record and nothing else — ServerTableEngineHandEvents turns it
     * into `actions` entries and does not re-emit it to the hub.
     */
    const afterStraddles = investedSnapshot();
    const forced: Array<{
      seat: number;
      userId: string;
      kind: string;
      amount: number;
      /**
       * DEAD money is in the pot but is NOT part of the live bet level, so it
       * never counts toward a call and must never be differenced against a
       * raise-TO level. An ante is always dead; so is the small blind half of
       * a dead blind. Getting this wrong understates every raise made by a
       * player who posted an ante, which is every player in a tournament.
       */
      dead: boolean;
    }> = [];
    const straddleSeats = new Set((this.config.straddles ?? []).map((s) => s.seat));
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const zero = { total: 0, dead: 0 };

    for (const p of this.state.players) {
      const b = afterBlinds.get(p.seat) ?? zero;
      const a = afterAntes.get(p.seat) ?? zero;
      const s = afterStraddles.get(p.seat) ?? zero;

      const push = (kind: string, amount: number, dead: boolean) => {
        if (amount > 0) forced.push({ seat: p.seat, userId: p.user_id, kind, amount, dead });
      };

      // Blind bucket. `post` covers a dead blind and a "post BB to enter" —
      // forced, but neither of the two named blinds.
      const blindKind = p.seat === sbSeat ? 'sb' : p.seat === bbSeat ? 'bb' : 'post';
      push(blindKind, round2(b.total - b.dead), false);
      push('post', b.dead, true);

      // Ante bucket. Dead by definition, live only if some future path puts
      // non-dead money here — in which case it is recorded rather than lost.
      push('ante', round2(a.dead - b.dead), true);
      push('ante', round2(a.total - b.total - (a.dead - b.dead)), false);

      // Straddle bucket. A straddle is a live blind: it raises the bet level.
      push(straddleSeats.has(p.seat) ? 'straddle' : 'post', round2(s.total - a.total), false);
    }

    if (forced.length > 0) {
      this.emit({ type: 'FORCED_BETS_POSTED', postings: forced } as never);
    }

    // AUDIT V6: snap chips after all posting (blinds/dead blinds/straddles)
    this.snapChips();
  }

  private postBombPotAntes(): void {
    const { bigBlind, bombPot } = this.config;
    if (!bombPot) return;
    // BOMB POT STANDARDIZATION 2026-08-27 (spec §3): FIXED ante mode — a
    // positive anteFixed overrides the BB multiple. Both resolve to the same
    // equal forced contribution from every locked participant (BP-ANTE-01).
    /**
     * ROUNDED TO THE CENT BEFORE ANYBODY IS CHARGED (2026-08-29).
     *
     * This was `bigBlind * bombPot.anteMultiplier`, raw, and it is the only
     * forced-money path in the engine that did not round. Every sibling does:
     * postBlinds takes cent-granular blinds from the row and round2s the
     * recorder, the BBJ fee is `Math.round(bigBlind * feeBB * 100) / 100`, and
     * returnUncalledBet rounds every term it touches.
     *
     * Two things went wrong without it.
     *
     * The multiplier slider steps by 0.5 (min 1, max 10), so at micro stakes
     * the product is a fraction of a cent — a 0.05 big blind at 1.5x is 0.075.
     * snapChips() then rounds each player's stack and totalInvested
     * INDEPENDENTLY of state.pot, so N players each paying half a cent leaves
     * `pot != sum(totalInvested)` and the table's chips no longer conserve.
     * verifyStreetIntegrity would have caught it as a critical financial
     * alert, which is presumably why nobody has seen it yet — loud, but still
     * a hand that should never have been dealt.
     *
     * And even at cent-legal multiples, binary floats produce dust: 0.1 * 3 is
     * 0.30000000000000004. snapChips cleans the engine's own state but not the
     * number that ESCAPES — anteAmount and every posting are emitted raw in
     * BOMB_POT_TRIGGERED and FORCED_BETS_POSTED, so that dust landed verbatim
     * in the persisted actions log and in hand_history.bomb_pot.ante_amount.
     *
     * Rounding here fixes both, because this is the single value both the
     * charge and the announcement are derived from.
     */
    const anteAmount =
      Math.round(
        (bombPot.anteFixed && bombPot.anteFixed > 0
          ? bombPot.anteFixed
          : bigBlind * bombPot.anteMultiplier) * 100
      ) / 100;

    const dealtIn = this.state.players.filter((p) => !p.is_sitting_out);

    // DOUBLE-BOARD BOMB POT 2026-08-20 / TRIPLE-BOARD 2026-08-27: activate as
    // many boards as the deck can cover — every player's hole cards plus FIVE
    // board cards per board. Downgrade stepwise (3 → 2 → 1) rather than
    // exhausting the deck mid-hand: a 9-handed PLO5 table (45 hole cards)
    // quietly plays a single board; a 7-handed PLO6 table (42 hole cards)
    // plays two of a requested three. The short-deck 36-card deck is covered
    // by the same arithmetic.
    const requestedBoards: 1 | 2 | 3 = bombPot.boardCount ?? (bombPot.doubleBoard ? 2 : 1);
    if (requestedBoards >= 2) {
      // 2026-08-29: was `gameVariant === 'short_deck' ? 36 : 52`, a sixth copy
      // of a fact VariantRules owns. Currently equivalent, but the sibling
      // check in ServerTableEngineDealing already calls deckSizeFor and this
      // same file uses isShortDeckVariant two hundred lines below — one more
      // literal is one more place a new short-deck spelling gets a 52-card
      // deck and a bomb pot that exhausts it mid-hand.
      const deckSize = deckSizeFor(this.config.gameVariant);
      const holeCardsNeeded = dealtIn.length * this.getCardsPerPlayer();
      let boards = requestedBoards;
      while (boards > 1 && holeCardsNeeded + 5 * boards > deckSize) {
        boards = (boards - 1) as 1 | 2 | 3;
      }
      this.activeBoardCount = boards;
      if (boards < requestedBoards) {
        console.warn(
          `[HandController] ${requestedBoards}-board bomb pot downgraded to ${boards} board(s): ` +
            `${dealtIn.length} players × ${this.getCardsPerPlayer()} cards + ${5 * requestedBoards} board > ${deckSize}`
        );
      }
    } else {
      this.activeBoardCount = 1;
    }

    // Per-seat postings for the client's ante-chip presentation. Built as we
    // mutate so the amounts reflect what each player actually paid.
    const postings: Array<{ seat: number; userId: string; amount: number }> = [];

    for (const player of dealtIn) {
      // BP-ANTE-03 (spec §5.2): a stack shorter than the bomb ante posts
      // everything it has and is all-in — side pots come from the normal
      // contribution-layer algorithm, never a bespoke "partial participation".
      // A short stack pays what it has, and a stack is already cent-exact, so
      // rounding the min again costs nothing and closes the case where a
      // future change makes stacks fractional.
      const actualAnte = Math.round(Math.min(anteAmount, player.stack) * 100) / 100;
      player.totalInvested += actualAnte;
      player.stack -= actualAnte;
      this.state.pot += actualAnte;
      if (player.stack === 0) player.is_all_in = true;
      if (actualAnte > 0) {
        postings.push({ seat: player.seat, userId: player.user_id, amount: actualAnte });
      }
    }

    this.state.currentBet = 0;
    // AUDIT V6: snap chips after ante collection
    this.snapChips();
    // DEAD-WIRING FIX 2026-08-15: announce the bomb pot. Without this the only
    // thing the client saw was a POT_UPDATE — an unexplained ante off every
    // stack, then a hand that inexplicably began on the flop.
    this.emit({
      type: 'BOMB_POT_TRIGGERED',
      anteAmount,
      // POLISH 2026-08-28: in FIXED-ante mode the multiple did not set the
      // price, so reporting it made the overlay caption a lie — "Everyone
      // Antes 7 (2x BB)" on a 1/2 table. Zero here means "fixed amount" and
      // the caption shows the amount alone.
      bbMultiplier: bombPot.anteFixed && bombPot.anteFixed > 0 ? 0 : bombPot.anteMultiplier,
      doubleBoard: this.multiBoardActive,
      boardCount: this.activeBoardCount,
      triggerReason: bombPot.triggerReason,
      postings,
    });
    // FORCED MONEY ON THE RECORD (2026-08-27, extends #1477): bomb antes are
    // forced money like any blind or ante, and postBlinds' snapshot-diff
    // recorder never runs on a bomb hand — without this emit every bomb hand's
    // persisted `actions` log was short by the entire starting pot. Dead
    // money: a bomb ante is in the pot but there is no preflop bet level for
    // it to count toward.
    if (postings.length > 0) {
      this.emit({
        type: 'FORCED_BETS_POSTED',
        postings: postings.map((p) => ({
          seat: p.seat,
          userId: p.userId,
          kind: 'bomb_ante',
          amount: p.amount,
          dead: true,
        })),
      } as never);
    }
    this.emit({ type: 'POT_UPDATE', pot: this.state.pot, pots: this.state.pots });
  }

  private dealHoleCards(): void {
    const cardsPerPlayer = this.getCardsPerPlayer();
    const deck = this.state.deck as unknown as Deck;

    for (const player of this.state.players.filter((p) => !p.is_sitting_out)) {
      player.cards = deck.deal(cardsPerPlayer);
      this.emit({ type: 'CARDS_DEALT', seat: player.seat, cards: player.cards });
      // Phase X5 (2026-04-29) — Bible V8 §1.16 hole_cards_dealt private event.
      // ServerTableEngine fans this through to the WS hub as a per-user
      // private message (NOT a public broadcast — only the holder sees the
      // values; spectators see a count-only mask).
      this.emit({
        type: 'HOLE_CARDS_DEALT',
        seat: player.seat,
        user_id: player.user_id,
        cards: player.cards,
        card_count: player.cards.length,
      } as never);
    }
  }

  private getCardsPerPlayer(): number {
    // 2026-08-23: this was a switch whose `default: return 2` silently made any
    // variant it had not been taught a Hold'em game. `flo8` is four cards and
    // would have been dealt two. VariantRules is the one table now — see the
    // header there for the five copies of this fact that used to exist.
    return holeCardCount(this.config.gameVariant);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Player Actions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * AUDIT V6 (2026-07-24, Bible V8 §2.6): snap every chip value to exact
   * cents. Individual amounts are always whole cents by rule, but repeated
   * float += / -= accumulates IEEE 754 representation error (live example:
   * an all-in recorded as 171.64999999999998). Drift is ~1e-13 per op —
   * nine orders of magnitude below the half-cent snap threshold — so this
   * is lossless and preserves chip conservation by construction. Called at
   * every mutation choke point so stacks, bets, the pot, and every recorded
   * action amount stay clean for the DB, the clients, and the horse logic.
   */
  private snapChips(): void {
    const r = (n: number) => Math.round(n * 100) / 100;
    for (const p of this.state.players) {
      p.stack = r(p.stack);
      p.bet = r(p.bet);
      p.totalInvested = r(p.totalInvested ?? 0);
    }
    this.state.pot = r(this.state.pot);
    this.state.currentBet = r(this.state.currentBet);
  }

  performAction(seat: number, action: ActionType, amount?: number): boolean {
    const player = this.state.players.find((p) => p.seat === seat);
    if (!player || seat !== this.state.currentPlayerSeat) return false;
    // 2026-08-15 BACKSTOP: a folded, all-in or sitting-out seat can never act,
    // whatever currentPlayerSeat claims. Without this, any stale turn pointer
    // lets an automated path (watchdog force-action, disconnect auto-action, a
    // late horse timer) push a legal-looking check/fold from a player who is
    // not in the decision. This is the authoritative guard; every caller that
    // trusts currentPlayerSeat is now safe by construction.
    if (player.is_folded || player.is_all_in || player.is_sitting_out) return false;

    // ── ALL-IN-OR-FOLD (2026-08-22 parity) ──────────────────────────────────
    // Preflop the only actions are fold or all-in; the BB (or anyone owing
    // nothing) may check when unraised. Bet/raise/call are rejected outright —
    // this is the authoritative server enforcement, getAvailableActions is
    // only the menu. Postflop needs no restriction: with every live player
    // all-in or folded preflop, no postflop decision exists.
    if (this.config.allInOrFold && this.state.stage === 'preflop') {
      const owesNothing = this.state.currentBet - player.bet <= 0;
      const aofLegal =
        action === 'fold' || action === 'all_in' || (action === 'check' && owesNothing);
      if (!aofLegal) return false;
    }

    // Bible V8 §4.14: PLO variants use pot-limit betting; flh/flo8 use
    // fixed-limit (2026-08-23). `buildBettingState` is the one place that
    // decides which — the nine copies of `startsWith('plo')` are gone.
    const bettingState = this.buildBettingState(player);

    const clamped = this.clampToStructure(player, action, amount, bettingState);
    const effAction: ActionType = clamped.action;
    const effAmount = clamped.amount;

    const validation = validateAction(effAction, effAmount, player.stack, bettingState);

    if (!validation.valid) return false;
    action = effAction;
    amount = effAmount;

    // FIX-A1 2026-07-19 (Bible V8 §4.14 / TDA Rule 44): reject a `raise` that
    // cannot legally reopen betting — e.g. a player who already acted and now
    // faces only a sub-full-raise all-in may call or fold, not re-raise. This is
    // the authoritative server enforcement; getAvailableActions hides the button
    // but a hand-crafted action must be rejected here too. `all_in` is exempt.
    if (action === 'raise' && !this.canReopenBetting(player)) return false;

    let actualAmount = 0;
    let isFullRaiseFlag: boolean | undefined;

    switch (action) {
      case 'fold':
        player.is_folded = true;
        break;
      case 'check':
        break;
      case 'call':
        actualAmount = Math.min(bettingState.toCall, player.stack);
        player.bet += actualAmount;
        player.totalInvested += actualAmount;
        player.stack -= actualAmount;
        this.state.pot += actualAmount;
        if (player.stack === 0) player.is_all_in = true;
        break;
      case 'bet':
      case 'raise': {
        actualAmount = amount!;
        // FIX 157: Bible V8 §4.14 — raiseSize must be the INCREMENT over the current bet level,
        // NOT the increment over the player's personal bet. Old code used player.bet which was
        // wrong when the player hadn't called yet (e.g., CO raising preflop with bet=0).
        // Correct: raiseSize = newBetLevel - previousBetLevel
        const raiseSize = actualAmount - this.state.currentBet;
        isFullRaiseFlag = true; // Normal bet/raise is always a full raise
        if (raiseSize > this.state.lastRaise) this.state.lastRaise = raiseSize;
        // Bible V8 §4.14: Keep minRaise in sync — must be at least lastRaise or BB
        this.state.minRaise = Math.max(this.config.bigBlind, this.state.lastRaise);
        const chipsAdded = actualAmount - player.bet;
        player.totalInvested += chipsAdded;
        player.stack -= chipsAdded;
        this.state.pot += chipsAdded;
        player.bet = actualAmount;
        this.state.currentBet = actualAmount;
        // Bible V8 §4.21: Track last aggressor for showdown reveal order
        this.state.lastAggressorSeat = seat;
        if (player.stack === 0) player.is_all_in = true;
        break;
      }
      case 'all_in':
        actualAmount = player.stack + player.bet;
        player.totalInvested += player.stack;
        this.state.pot += player.stack;
        player.bet += player.stack;
        player.stack = 0;
        player.is_all_in = true;
        // Bible V8 §4.14: Track whether this all-in constitutes a full raise
        // A short all-in (raise increment < lastRaise) does NOT reopen betting
        if (player.bet > this.state.currentBet) {
          const rs = player.bet - this.state.currentBet;
          isFullRaiseFlag = rs >= this.state.lastRaise;
          if (isFullRaiseFlag) {
            this.state.lastRaise = rs;
            // Bible V8 §4.14: Keep minRaise in sync for full-raise all-ins
            this.state.minRaise = Math.max(this.config.bigBlind, this.state.lastRaise);
            // Bible V8 §4.21: Full-raise all-in counts as aggression for showdown order
            this.state.lastAggressorSeat = seat;
          }
          this.state.currentBet = player.bet;
        }
        break;
    }

    // AUDIT V6: snap chips + the recorded amount to exact cents (Bible V8 §2.6)
    this.snapChips();
    actualAmount = Math.round(actualAmount * 100) / 100;

    this.state.actionHistory.push({
      seat,
      userId: player.user_id,
      action,
      amount: actualAmount,
      timestamp: Date.now(),
      stage: this.state.stage,
      isFullRaise: isFullRaiseFlag,
    });

    // The stage travels WITH the action. This is the same value just written
    // to actionHistory above, so the persisted hand history and the
    // controller's own record agree by construction rather than by timing.
    this.emit({
      type: 'PLAYER_ACTION',
      seat,
      action,
      amount: actualAmount,
      stage: this.state.stage,
    });
    this.emit({ type: 'POT_UPDATE', pot: this.state.pot, pots: calculatePots(this.state.players) });
    this.advanceGame();
    return true;
  }

  /**
   * FIX 120: Crazy Pineapple — player discards one of their 3 hole cards after the flop.
   * Called by ServerTableEngine when a player submits a discard action.
   * @param seat - The seat number of the player discarding
   * @param cardIndex - The index (0, 1, or 2) of the card to discard from their hand
   * @returns true if discard was accepted
   */
  performDiscard(seat: number, cardIndex: number): boolean {
    if (this.state.stage !== 'pineapple_discard') {
      return false; // Not in discard phase
    }
    if (!this.pineappleDiscardsRemaining.has(seat)) {
      return false; // Already discarded or not eligible
    }

    const player = this.state.players.find((p) => p.seat === seat);
    if (!player || player.is_folded) {
      this.pineappleDiscardsRemaining.delete(seat);
      this.checkPineappleDiscardsComplete();
      return true;
    }

    if (!player.cards || player.cards.length !== 3) {
      return false; // Invalid state — should have 3 cards
    }
    if (cardIndex < 0 || cardIndex >= player.cards.length) {
      return false; // Invalid card index
    }

    // Remove the selected card from the player's hand
    const discarded = player.cards.splice(cardIndex, 1);
    this.pineappleDiscardsRemaining.delete(seat);

    /* PHASE 4 2026-09-01: the card itself, to the seat that threw it and to
       nobody else. This event is consumed by the engine and written to the
       RLS-protected hand_discards table; it is never forwarded to the hub.
       `discarded` was already computed here and thrown away - the splice
       result has been unused since the variant shipped, which is why the
       replay could say "Discard" but never which card. */
    if (discarded[0]) {
      this.emit({ type: 'PINEAPPLE_DISCARDED', seat, card: discarded[0] });
    }

    /* PHASE 3 FOLLOW-UP 2026-08-31 - the discard has to be IN the hand's own
       action history, not only on the wire.
       
       `currentHandActions` (what becomes hand_history.actions) is appended from
       the PLAYER_ACTION event below, so the PERSISTED record has always had
       discards. `state.actionHistory` did not: nothing in performDiscard ever
       wrote to it, because only processAction does, and a discard does not go
       through processAction.
       
       That gap was invisible until Phase 3 gave the discard something to
       render. `getTableState()` publishes this array as `action_history`, and
       the client derives every seat's on-felt action label from it
       (mapEngineSnapshot.derivePerSeatLastAction, keyed on the CURRENT stage).
       With no record here, the very next snapshot of the discard round told the
       client that nobody had acted: the seat's "Discard" label appeared on the
       event and was wiped a moment later, and `lastAction` fell back to
       'discard' again on the next event - a fall-then-rise that re-triggers the
       toss animation, so a seat could throw the same card twice.
       
       Recorded with the same shape and the same stage as any other action, so
       it survives exactly as long as the round it belongs to and disappears
       when the street changes, like a check or a fold does. Every consumer of
       this array filters on stage and on bet/raise/all_in
       (isFixedLimitCapped, canReopenBetting, readInitiative,
       isBettingRoundComplete), so a zero-amount 'discard' on a stage none of
       them bet in is inert to all of them - and it makes the in-memory history
       agree with the persisted one, which is what HorseMind hydrates from. */
    this.state.actionHistory.push({
      seat,
      userId: player.user_id,
      action: 'discard',
      amount: 0,
      timestamp: Date.now(),
      stage: this.state.stage,
    });

    // Emit discard action for logging
    this.emit({
      type: 'PLAYER_ACTION',
      seat,
      action: 'discard',
      amount: 0,
      stage: this.state.stage,
    });
    // Send updated cards to the player (secure per-player)
    this.emit({ type: 'CARDS_DEALT', seat, cards: [...player.cards] });

    this.checkPineappleDiscardsComplete();
    return true;
  }

  /**
   * FIX 120: Auto-discard for players who didn't respond in time.
   * Discards the last (3rd) card by default.
   */
  /**
   * @deprecated Dan 2026-08-21 made a missed discard a FOLD, not a random
   * throw-away. Kept only because older call sites and tests reference it;
   * the live expiry path calls foldForMissedDiscard().
   */
  autoDiscard(seat: number): boolean {
    return this.performDiscard(seat, 2); // Discard last card
  }

  /**
   * Dan 2026-08-21: "FOR PINEAPPLE, THIS NEEDS TO BE A FULL ROUND OF DISCARDS.
   * IF A PLAYER DOESN'T DISCARD IN THE AMOUNT OF TIME GIVEN, THEIR HAND IS
   * FOLDED."
   *
   * The old expiry path auto-discarded the LAST card, which is a random
   * discard dressed up as a decision: it silently kept playing a hand the
   * player never chose, and on 103 pineapple tables that ran every hand. A
   * discard is an ACTION - miss it and you are out of the pot, exactly like
   * missing a turn.
   *
   * Returns true when this call folded the seat.
   */
  foldForMissedDiscard(seat: number): boolean {
    if (this.state.stage !== 'pineapple_discard') return false;
    if (!this.pineappleDiscardsRemaining.has(seat)) return false;
    const player = this.state.players.find((p) => p.seat === seat);
    if (!player || player.is_folded) {
      this.pineappleDiscardsRemaining.delete(seat);
      return false;
    }

    player.is_folded = true;
    this.pineappleDiscardsRemaining.delete(seat);

    // Announce it the same way any fold is announced, so seats grey out and
    // the hand history records a fold rather than a phantom discard.
    this.emit({
      type: 'PLAYER_ACTION',
      seat,
      playerId: player.user_id,
      action: 'fold',
      amount: 0,
      stage: this.state.stage,
    } as unknown as HandEvent);

    // Everyone else folding to one player ends the hand here - there is no
    // flop to deal and no betting round to open.
    if (this.getActivePlayers().length <= 1) {
      this.pineappleDiscardsRemaining.clear();
      this.completeHand();
      return true;
    }

    this.checkPineappleDiscardsComplete();
    return true;
  }

  /**
   * Does this seat still owe a discard? (2026-08-31)
   *
   * The engine keeps its own per-seat DEADLINE map so a time bank can extend
   * one player without touching anyone else. That map can only ever be a cache
   * of this set, and there are three ways a seat leaves the round WITHOUT
   * passing through `submitDiscard`, which is the only place the engine used to
   * prune it:
   *
   *   - a HORSE discards by calling performDiscard directly (HorseLogic picks
   *     the card, ServerTableEngineRunout submits it);
   *   - an all-in seat is resolved by resolvePendingPineappleDiscards when the
   *     flop lands, because the round never opens for it;
   *   - a seat folded for missing the round is already gone from here.
   *
   * So the deadline map is reconciled against THIS on every sweep and before
   * every publish, and the engine can never announce or enforce a deadline for
   * a seat that has nothing left to decide.
   */
  public owesPineappleDiscard(seat: number): boolean {
    return this.pineappleDiscardsRemaining.has(seat);
  }

  /**
   * PHASE 3 2026-08-31 - the ONE timer this class owns, and why.
   *
   * `checkPineappleDiscardsComplete` used to call `advanceStage()` on the same
   * synchronous tick as the last discard, so the flop's betting round opened
   * over the top of a card that was still in the air. Every other cadence on
   * this platform is a named beat in `handCompletionSpec.ts`; the discard had
   * none, which is why the felt read as a pause followed by a jump.
   *
   * Everything about this is written so it can never park a hand at
   * `pineapple_discard`, which is the one catastrophic failure available here
   * (three pineapple tables run in production, and a hand stuck in the discard
   * stage never deals again):
   *
   *   - a zero/negative beat, or an environment with no usable setTimeout,
   *     advances SYNCHRONOUSLY, exactly as before;
   *   - the callback re-reads the stage, so an advance that happened by any
   *     other route in the meantime is a no-op rather than a double-advance;
   *   - `cancelPineappleSettle()` is called from `completeHand` and by the
   *     engine when it drops a controller, so a superseded hand's beat cannot
   *     fire into a live one;
   *   - `unref()` where the runtime has it, so a pending beat never holds a
   *     test process (or the server) open.
   */
  private pineappleSettleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Drop a pending discard beat. Safe to call at any time and any number of
   * times. Public because the engine has to be able to call it when it
   * replaces or discards this controller.
   */
  public cancelPineappleSettle(): void {
    if (this.pineappleSettleTimer) {
      clearTimeout(this.pineappleSettleTimer);
      this.pineappleSettleTimer = null;
    }
  }

  /**
   * Collapse a pending discard beat to nothing and open the street NOW.
   *
   * The beat is measured in WALL CLOCK, and there are drivers that have no
   * clock at all - HandFuzzer walks a whole hand inside one synchronous loop,
   * and its LIVENESS check (`no player to act and hand is not complete`) is a
   * real law: outside this one deliberate beat, a HandController that is
   * neither complete nor waiting on somebody is a hung table. A driver with
   * no clock collapses the beat here rather than the class pretending it does
   * not have one.
   *
   * Returns true when there was a beat to collapse.
   */
  public flushPineappleSettle(): boolean {
    if (!this.pineappleSettleTimer) return false;
    this.cancelPineappleSettle();
    if (this.state.stage !== 'pineapple_discard') return false;
    this.advanceStage();
    return true;
  }

  /**
   * Has the discard round finished - i.e. is there nobody left who owes one?
   *
   * The engine used to answer this by re-reading `stage !== 'pineapple_discard'`
   * immediately after `performDiscard`, which was true only because the
   * advance was synchronous. With the beat above in place the stage is still
   * `pineapple_discard` for DISCARD_SETTLE_MS after the last card is in, so
   * that reading would re-arm the fold sweep against seats that have already
   * acted. This is the question the engine actually meant to ask.
   */
  public allPineappleDiscardsIn(): boolean {
    return this.pineappleDiscardsRemaining.size === 0;
  }

  /** FIX 120: Check if all players have discarded; if so, advance to flop betting */
  private checkPineappleDiscardsComplete(): void {
    if (this.pineappleDiscardsRemaining.size !== 0) return;
    // Already holding for the beat - do not schedule a second one.
    if (this.pineappleSettleTimer) return;

    const settleMs = HAND_COMPLETION.DISCARD_SETTLE_MS;
    if (!(settleMs > 0) || typeof setTimeout !== 'function') {
      this.advanceStage();
      return;
    }

    this.pineappleSettleTimer = setTimeout(() => {
      this.pineappleSettleTimer = null;
      // Anything else that moved the hand on (a fold that ended it, a runout)
      // has already done this job.
      if (this.state.stage !== 'pineapple_discard') return;
      try {
        this.advanceStage(); // 'pineapple_discard' → 'flop', and betting opens
      } catch (err) {
        reportError(err, 'HandController.pineappleSettle');
      }
    }, settleMs);
    (this.pineappleSettleTimer as unknown as { unref?: () => void })?.unref?.();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Game Flow
  // ─────────────────────────────────────────────────────────────────────────

  private advanceGame(): void {
    const activePlayers = this.getActivePlayers();
    if (activePlayers.length === 1) {
      this.completeHand();
      return;
    }
    if (this.isBettingRoundComplete()) {
      this.advanceStage();
    } else {
      this.setNextPlayer();
      this.emitTurnChange();
    }
  }

  private isBettingRoundComplete(): boolean {
    const activePlayers = this.getActivePlayers();
    const playersToAct = activePlayers.filter((p) => !p.is_all_in);

    if (playersToAct.length === 0) return true;
    if (playersToAct.length === 1) {
      const stageActions = this.state.actionHistory.filter((a) => a.stage === this.state.stage);
      const hasActed = stageActions.some((a) => a.seat === playersToAct[0].seat);
      if (hasActed && playersToAct[0].bet >= this.state.currentBet) return true;
      if (!hasActed) return false;
    }

    const stageActions = this.state.actionHistory.filter((a) => a.stage === this.state.stage);

    // Bible V8 §4.14: Only full raises reopen betting.
    // A short all-in (raise increment < lastRaise) does NOT count as aggression.
    let lastAggressorSeat = -1;
    for (const action of stageActions) {
      if (action.action === 'bet' || action.action === 'raise') {
        // Normal bet/raise always reopens
        lastAggressorSeat = action.seat;
      } else if (action.action === 'all_in' && action.isFullRaise) {
        // All-in only reopens if it was a full raise
        lastAggressorSeat = action.seat;
      }
    }

    for (const player of playersToAct) {
      const playerActions = stageActions.filter((a) => a.seat === player.seat);
      if (playerActions.length === 0) return false;

      if (lastAggressorSeat !== -1 && lastAggressorSeat !== player.seat) {
        let lastAggressorActionIdx = -1;
        for (let i = stageActions.length - 1; i >= 0; i--) {
          const a = stageActions[i];
          if (
            a.seat === lastAggressorSeat &&
            (a.action === 'bet' || a.action === 'raise' || (a.action === 'all_in' && a.isFullRaise))
          ) {
            lastAggressorActionIdx = i;
            break;
          }
        }
        let playerLastActionIdx = -1;
        for (let i = stageActions.length - 1; i >= 0; i--) {
          if (stageActions[i].seat === player.seat) {
            playerLastActionIdx = i;
            break;
          }
        }
        if (playerLastActionIdx < lastAggressorActionIdx) return false;
      }
    }

    const targetBet = this.state.currentBet;
    // AUDIT V2 (2026-07-23): strict === live-locked the betting round. A call
    // sets player.bet via `bet += (currentBet - bet)`, and IEEE 754 drift can
    // land it at e.g. 15.580000000000002 while currentBet is 15.58. Both
    // players then "match" the bet for all practical purposes, but === says no,
    // so the round never completes and TURN_CHANGE loops until the hand
    // timeout voids the hand. Compare with a half-cent tolerance instead —
    // chip amounts are whole cents per Bible V8 §2.6, so 0.005 can never mask
    // a genuinely unmatched bet.
    return playersToAct.every((p) => Math.abs(p.bet - targetBet) < 0.005);
  }

  private advanceStage(): void {
    for (const player of this.state.players) {
      player.bet = 0;
    }
    this.state.currentBet = 0;
    // 2026-08-23: on a fixed-limit table the street's wager is the reset value,
    // not the big blind — turn and river are played for the BIG bet. Leaving
    // this at bigBlind would have let a turn all-in of one small bet count as a
    // full raise and reopen betting, since canReopenBetting compares against
    // lastRaise. The stage has not moved yet, so ask about the one we are
    // moving INTO.
    const incomingStage = this.nextStageAfter(this.state.stage);
    const streetReset = isFixedLimitVariant(this.config.gameVariant)
      ? fixedLimitBetSize(this.config.bigBlind, incomingStage)
      : this.config.bigBlind;
    this.state.lastRaise = streetReset;
    this.state.minRaise = streetReset;

    const deck = this.state.deck as unknown as Deck;

    // RIT/INSURANCE PARITY FIX 2026-08-18: park BEFORE dealing the next
    // street. This check used to run AFTER the switch below, so one street
    // was already locked in by the time offers went out: a TURN all-in had
    // the river dealt (board=5) and could never be offered RIT or insurance
    // at all - the single most common RIT spot in real poker - and a FLOP
    // all-in ran only the river twice instead of turn+river. Live proof:
    // 48 eligible all-in runouts in one 20-minute window, all turn shoves,
    // zero offers. The ALL_IN_RUNOUT comment always said "pause before
    // dealing remaining community cards"; now the code agrees. A river
    // round completing has nothing to come and proceeds to showdown below.
    if (this.state.stage !== 'river') {
      const canStillAct = this.getActivePlayers().filter((p) => !p.is_all_in);
      if (canStillAct.length < 2) {
        this.state.currentPlayerSeat = -1;
        // SHOWDOWN SYSTEM 2026-08-25 (Dan spec section 8): an all-in ended all
        // possible betting with cards still to come. Every live hand must be
        // exposed at showdown — no muck option. completeHandInner reads this.
        this.allInShowdownLocked = true;
        // INSURANCE POT FIX 2026-08-28 (Dan's recording, hand #3158299): the
        // pot emitted here fed insurance pricing while still holding the
        // UNCALLED portion of the final bet. A shove over a micro all-in was
        // therefore "insured" against the shover's own returned chips: the
        // dialog priced a 62-chip contested pot as 317.61 (fee 75.62,
        // "For Winning: 241.99" — an amount the hand could never pay).
        // Betting is over the moment this branch is taken, so the textbook
        // refund is determinable NOW. returnUncalledBet() also decrements the
        // bettor's totalInvested, which fixes the offer's atRisk (Break Even
        // preset) in the same stroke. Idempotent: completeHand/RIT call it
        // again later and get 0.
        this.returnUncalledBet();
        this.emit({
          type: 'ALL_IN_RUNOUT',
          board: [...this.state.communityCards],
          board2: this.multiBoardActive ? [...this.state.communityCards2] : undefined,
          board3: this.activeBoardCount >= 3 ? [...this.state.communityCards3] : undefined,
          pot: this.state.pot,
          players: this.getActivePlayers().map((p) => ({ ...p })),
        });
        return;
      }
    }

    switch (this.state.stage) {
      case 'preflop': {
        this.transitionStage('flop');
        this.state.sawFlop = true;
        const flop = deck.deal(3);
        this.state.communityCards.push(...flop);
        // DOUBLE/TRIPLE-BOARD BOMB POT: each extra board gets its own flop,
        // dealt in stable board order (spec §7.2 — 1, then 2, then 3).
        let flop2: Card[] | undefined;
        let flop3: Card[] | undefined;
        if (this.multiBoardActive) {
          flop2 = deck.deal(3);
          this.state.communityCards2.push(...flop2);
        }
        if (this.activeBoardCount >= 3) {
          flop3 = deck.deal(3);
          this.state.communityCards3.push(...flop3);
        }
        this.emit({
          type: 'COMMUNITY_CARDS',
          stage: 'flop',
          cards: flop,
          cards2: flop2,
          cards3: flop3,
        });

        // FIX 120: Crazy Pineapple — after dealing flop, enter discard phase
        if (this.config.gameVariant === 'pineapple') {
          this.transitionStage('pineapple_discard');
          const activePlayers = this.getActivePlayers();
          this.pineappleDiscardsRemaining = new Set(activePlayers.map((p) => p.seat));
          this.emit({
            type: 'PINEAPPLE_DISCARD_REQUIRED',
            seats: [...this.pineappleDiscardsRemaining],
          });
          // Each player will call performDiscard() — no turn rotation needed,
          // all players discard simultaneously. Timer managed by ServerTableEngine.
          return;
        }
        break;
      }
      case 'pineapple_discard':
        // FIX 120: After all discards are in, proceed to flop betting
        this.transitionStage('flop');
        break;
      case 'flop': {
        this.transitionStage('turn');
        const turn = deck.deal(1);
        this.state.communityCards.push(...turn);
        let turn2: Card[] | undefined;
        let turn3: Card[] | undefined;
        if (this.multiBoardActive) {
          turn2 = deck.deal(1);
          this.state.communityCards2.push(...turn2);
        }
        if (this.activeBoardCount >= 3) {
          turn3 = deck.deal(1);
          this.state.communityCards3.push(...turn3);
        }
        this.emit({
          type: 'COMMUNITY_CARDS',
          stage: 'turn',
          cards: turn,
          cards2: turn2,
          cards3: turn3,
        });
        break;
      }
      case 'turn': {
        this.transitionStage('river');
        const river = deck.deal(1);
        this.state.communityCards.push(...river);
        let river2: Card[] | undefined;
        let river3: Card[] | undefined;
        if (this.multiBoardActive) {
          river2 = deck.deal(1);
          this.state.communityCards2.push(...river2);
        }
        if (this.activeBoardCount >= 3) {
          river3 = deck.deal(1);
          this.state.communityCards3.push(...river3);
        }
        this.emit({
          type: 'COMMUNITY_CARDS',
          stage: 'river',
          cards: river,
          cards2: river2,
          cards3: river3,
        });
        break;
      }
      case 'river':
        this.transitionStage('showdown');
        this.completeHand();
        return;
    }

    // (2026-08-18) The all-in-runout park moved ABOVE the switch - see the
    // parity fix comment there. Reaching this point means at least two
    // players can still act on the newly dealt street. The 2026-08-15
    // parked-turn-pointer fix lives on in the pre-deal block.
    //
    // SHOWDOWN SYSTEM 2026-08-25 (Dan spec sections 3 + 6, TDA): the player
    // who shows first is the last aggressor ON THE FINAL BETTING ROUND — not
    // the last aggressor anywhere in the hand. lastAggressorSeat used to be
    // set once and never cleared, so a preflop raiser who check-called the
    // whole way down was still forced to show first. A new betting round is
    // beginning here, so the previous street's aggression no longer counts
    // toward showdown order. If this street checks through (or every later
    // street does), the fallback in completeHandInner — first live player in
    // normal river action order — takes over. An all-in runout parks ABOVE
    // this line, deliberately preserving the aggressor of the final betting
    // round that actually completed.
    this.state.lastAggressorSeat = -1;
    this.state.currentPlayerSeat = this.getFirstPostflopPlayer();
    this.emitTurnChange();
  }

  /**
   * Bible V8 §4.19: Public method called by ServerTableEngine AFTER insurance/RIT
   * offers have been resolved. Deals remaining community cards and completes the hand.
   * This is the resumption point after the ALL_IN_RUNOUT pause.
   */
  /**
   * Resume full runout — deals all remaining cards and completes the hand.
   * Used by non-insurance tables for instant runout.
   */
  public continueRunout(): void {
    if (this.refuseUnlessRunout('continueRunout')) return;
    this.runOutCommunityCards();
  }

  /**
   * Deal exactly ONE street of community cards (flop=3, turn=1, river=1).
   * Returns the new board state. Does NOT complete the hand.
   * Used by insurance tables for per-street pause/offer flow.
   *
   * @returns { board: Card[], stage: string, complete: boolean }
   *   - board: current community cards after dealing
   *   - stage: 'flop' | 'turn' | 'river'
   *   - complete: true if all 5 cards are now dealt (caller should complete the hand)
   */
  public dealNextStreet(): { board: Card[]; stage: string; complete: boolean } {
    if (this.refuseUnlessRunout('dealNextStreet')) {
      // complete:false and an unchanged board: the paced loop sees no growth
      // and stops; nothing about this hand moves.
      return { board: [...this.state.communityCards], stage: this.state.stage, complete: false };
    }
    const deck = this.state.deck as unknown as Deck;
    const currentLength = this.state.communityCards.length;

    if (currentLength >= 5) {
      return { board: [...this.state.communityCards], stage: 'river', complete: true };
    }

    const stage = currentLength < 3 ? 'flop' : currentLength < 4 ? 'turn' : 'river';
    const count = stage === 'flop' ? 3 - currentLength : 1;
    const cards = deck.deal(count);
    // RAKE LEAK FIX 2026-08-18: same as runOutCommunityCards - the insurance
    // per-street path deals the flop without marking it seen.
    if (stage === 'flop') this.state.sawFlop = true;
    // ANIMATION AUDIT 2026-08-19: unlike advanceStage, this path never moved
    // state.stage — during a paced all-in runout every broadcastCurrentState
    // still said 'preflop' while community_cards grew, so the client's
    // stage-derived board rendered ZERO cards (five placeholders) for the
    // whole runout. Advance the stage with the street.
    this.transitionStage(stage as HandStage);
    this.state.communityCards.push(...cards);
    // DOUBLE/TRIPLE-BOARD BOMB POT: boards 2 and 3 track board 1 street for
    // street through the per-street (insurance-paced) runout as well.
    let cards2: Card[] | undefined;
    let cards3: Card[] | undefined;
    if (this.multiBoardActive) {
      const count2 = stage === 'flop' ? 3 - this.state.communityCards2.length : 1;
      if (count2 > 0) {
        cards2 = deck.deal(count2);
        this.state.communityCards2.push(...cards2);
      }
    }
    if (this.activeBoardCount >= 3) {
      const count3 = stage === 'flop' ? 3 - this.state.communityCards3.length : 1;
      if (count3 > 0) {
        cards3 = deck.deal(count3);
        this.state.communityCards3.push(...cards3);
      }
    }
    this.emit({ type: 'COMMUNITY_CARDS', stage: stage as HandStage, cards, cards2, cards3 });

    /* ═══ A PINEAPPLE SHOWDOWN IS TWO HOLE CARDS ON *EVERY* RUNOUT PATH ═════
       2026-08-31. There are two ways an all-in hand runs out, and only one of
       them enforced this. `runOutCommunityCards` resolves outstanding discards
       the moment the flop lands (AUDIT V2, 2026-07-23, and the comment there
       names the exact failure: "players still held THREE hole cards at
       showdown and evaluateHand scored best-5-of-8, an illegal extra-card
       advantage"). This method - the per-street path taken whenever the table
       has insurance or run-it-twice on - never got the same line, and all
       three live pineapple tables have one or both switched on.

       So it was still happening, and paying out. Production hand #3831745,
       table 0be5fa47, board 2h 3c 5d Qc 4h: a seat held Jh Ah Kh and was
       awarded a FLUSH worth 22.57 of a 34.00 pot. The board has exactly two
       hearts. No legal two-card hold on that hand makes a flush - it needed
       all three of its cards, which is the illegal extra card, and it beat an
       honest straight (Ad Kc 5h) that should have scooped. Three more hands in
       the same twelve hours reached showdown with three cards.

       Same call, same place in the street, as the path that had it. */
    if (this.config.gameVariant === 'pineapple' && this.state.communityCards.length >= 3) {
      this.resolvePendingPineappleDiscards();
    }

    const complete = this.state.communityCards.length >= 5;
    return { board: [...this.state.communityCards], stage, complete };
  }

  /**
   * Finalize the hand after all streets are dealt (showdown + settlement).
   * Called by ServerTableEngine after the last street in per-street insurance flow.
   *
   * FIX 117 (restored FIX 109): skipDistribution=true prevents double-money bug.
   * When RIT already distributed pots per-board, we must NOT call completeHand()
   * again because that would re-distribute all pots to winners a SECOND time.
   * Instead, emit HAND_COMPLETE with rake/BBJ fees but skip pot distribution.
   *
   * @param skipDistribution - true when caller (e.g. RIT) already distributed pots
   */
  public finalizeRunout(skipDistribution: boolean = false): void {
    if (this.refuseUnlessRunout('finalizeRunout')) return;
    this.transitionStage('showdown');
    if (skipDistribution) {
      // RIT or other caller already distributed pots — just emit completion
      // events. Priced by the ONE canonical helper (priceDeductions): this
      // path used to hand-copy the arithmetic and was missing the pot-overage
      // clamp entirely.
      const { rake, bbjFee } = this.priceDeductions(this.state.sawFlop, this.state.pot);
      this.emit({ type: 'WINNERS', winners: [] });
      this.handFSM.transition('settlement');
      this.emit({ type: 'HAND_COMPLETE', handNumber: this.config.handNumber, rake, bbjFee });
      this.emitBombPotCompleted();
      this.handFSM.transition('idle');
      return;
    }
    this.completeHand();
  }

  /**
   * Credit an externally-computed payout to the REAL hand state.
   *
   * Run It Twice computes its own distribution (one evaluation per board) and
   * then calls finalizeRunout(true) to skip the normal payout. Before
   * 2026-08-18 it applied that distribution by mutating the array returned by
   * getState() — which is a COPY (see getState: players are spread into new
   * objects). The real this.state.players were never credited.
   *
   * finalizeRunout(true) then emits WINNERS [], and that handler does
   * `localPlayer.stack = enginePlayer.stack` from a fresh (still uncredited)
   * getState(). So it overwrote the one real credit — the seated player's —
   * with the pre-payout stack, and syncStacks persisted that. Both players in
   * an all-in RIT pot finished on their post-betting stack and the pot was
   * destroyed. 28,691 tables have run_it_twice_enabled.
   *
   * Crediting the real state here means the WINNERS sync propagates the
   * CORRECT number instead of clobbering it, so there is exactly one place
   * that owns the stack and one place that copies it outward.
   */
  /**
   * RAKE LEAK FIX 2026-08-18: the RIT path builds its boards OUTSIDE this
   * controller's state (dealAndResolveRIT), so no code path here ever marks
   * the flop as seen for a preflop all-in that runs it twice - rake and the
   * BBJ fee computed as 0 under noFlopNoDrop despite 2-3 full boards being
   * dealt. The engine calls this before computing rake for a RIT hand.
   */
  public markFlopSeen(): void {
    if (this.refuseUnlessRunout('markFlopSeen')) return;
    this.state.sawFlop = true;
    this.boardDealtOutsideState = true;
  }

  /** True once start() has run. A controller that has not started has no
   *  blinds, no hole cards and no hand - nothing about it may be run out. */
  private handStarted = false;

  /**
   * ═══ RUNOUT CALLS ARE ONLY LEGAL DURING A RUNOUT (2026-08-31) ═══════════
   *
   * continueRunout, dealNextStreet, finalizeRunout, markFlopSeen and
   * settleUncalledBet exist for exactly one situation: betting is over
   * because everyone live is all-in (at most one player can still bet), and
   * the board is being run out. They are called by the engine's insurance /
   * run-it-twice / paced-runout cascade - async flows full of sleeps and
   * 20-second offer windows whose catch handlers and safety timers can fire
   * AFTER their hand has died. One of those firing into the NEXT hand's
   * controller is what the rake-law alarm caught: a fresh preflop hand run
   * out into the void before start(), then played to a raked walk inside the
   * wreckage (32 live hands, docs/changelog/2026-08-31-a-stale-runout-
   * cannot-reach-the-next-hand.md).
   *
   * The engine's continuations are now anchored to their controller, but this
   * is the authoritative backstop: whatever the caller, a hand that is not in
   * an all-in runout refuses the call and reports it. Returns true when the
   * call must be refused.
   */
  private refuseUnlessRunout(op: string): boolean {
    const live = this.state.players.filter((p) => !p.is_folded && !p.is_sitting_out);
    const canStillBet = live.filter((p) => !p.is_all_in);
    const inRunout = this.handStarted && (live.length <= 1 || canStillBet.length <= 1);
    if (inRunout) return false;
    reportError(
      new Error(
        `[HandController] ${op} refused on hand ${this.config.handNumber}: not an all-in ` +
          `runout (started=${this.handStarted}, stage=${this.state.stage}, ` +
          `${canStillBet.length} of ${live.length} live players can still bet). A stale ` +
          `continuation from a previous hand is the only known way to get here.`
      ),
      'HandController.stale_runout_refused'
    );
    return true;
  }

  /**
   * TRUE only when a real board exists that this controller's own
   * `state.communityCards` does not hold — which today means exactly one
   * thing: markFlopSeen() above, the RIT path. It is not a second copy of
   * `sawFlop`; it is the evidence that makes an empty board legitimate, and
   * priceDeductions is its only reader.
   */
  private boardDealtOutsideState = false;

  public creditRunoutWinnings(distribution: Map<string, number>): void {
    this.applyStackDeltas(distribution);
  }

  /**
   * Apply signed stack deltas to the ENGINE'S OWN players.
   *
   * Exists because getState() hands out copies:
   *
   *   players: this.state.players.map((p) => ({ ...p, cards: [...p.cards] }))
   *
   * so `getState().players.find(...).stack += x` mutates a throwaway object
   * and the authoritative state never moves. Every settlement adjustment that
   * lands AFTER the WINNERS event — run-it-twice payouts (PR #97), insurance
   * payouts and premiums, the 7-2 bounty transfer — has to come back through
   * here, or the engine keeps broadcasting the pre-adjustment stacks until the
   * next hand reloads seats from the database.
   *
   * Deltas are signed: positive credits, negative debits. Callers pass the
   * amount they ACTUALLY applied to the persisted seat row, so the engine and
   * the database move by the same number and cannot drift apart.
   */
  public applyStackDeltas(deltas: Map<string, number>): void {
    for (const [userId, amount] of deltas) {
      if (!amount) continue;
      const player = this.state.players.find((p) => p.user_id === userId);
      if (player) player.stack += amount;
    }
    // Same reason completeHand() snaps after paying out: += on binary floats
    // is where cross-hand drift is born.
    this.snapChips();
  }

  private runOutCommunityCards(): void {
    const deck = this.state.deck as unknown as Deck;
    // CORRECTION 2026-08-19 (Dan: "YOU CAN'T HAVE 8 MAX PLO6"). An earlier
    // version of this comment justified the bound below with a short-deck
    // scenario that CANNOT HAPPEN, and the claim was wrong twice over:
    //
    //   1. Seat caps make it unreachable. PLO6 is 6-max and PLO5 is 7-max, so
    //      the worst real case is plo5 at 7 seats = 35 + 5 = 40 of 52.
    //   2. `PokerEngine.deal()` THROWS 'Not enough cards in deck' rather than
    //      returning a short array, so the board can never quietly stop
    //      growing — the loop would exit by exception, not spin.
    //
    // The bound is kept because it is free and it makes the exit structural
    // rather than dependent on deal() continuing to throw: a board needs at
    // most three more streets, so three turns of this loop is all it may ever
    // take. It is not load-bearing today, and it is not a fix for anything
    // observed. showdown/completeHand below still runs on every path.
    let guard = 3;
    while (this.state.communityCards.length < 5 && guard-- > 0) {
      const lengthBefore = this.state.communityCards.length;
      const stage =
        this.state.communityCards.length < 3
          ? 'flop'
          : this.state.communityCards.length < 4
            ? 'turn'
            : 'river';
      const count = stage === 'flop' ? 3 - this.state.communityCards.length : 1;
      const cards = deck.deal(count);
      // RAKE LEAK FIX 2026-08-18: only advanceStage() ever set sawFlop, so a
      // PREFLOP all-in runout dealt a full board with sawFlop still false -
      // and with noFlopNoDrop always true on live tables, calculateRake()
      // and the BBJ fee both returned 0. Every preflop all-in hand paid no
      // rake and funded no jackpot. "No flop, no drop" means no rake when
      // the hand ENDS preflop - a runout that deals the flop IS a flop.
      if (stage === 'flop') this.state.sawFlop = true;
      this.state.communityCards.push(...cards);
      // DOUBLE/TRIPLE-BOARD BOMB POT: fill boards 2 and 3 in lockstep during
      // a full runout. Feasibility was checked at ante time, so the deck holds.
      let cards2: Card[] | undefined;
      let cards3: Card[] | undefined;
      if (this.multiBoardActive && this.state.communityCards2.length < 5) {
        const count2 = stage === 'flop' ? Math.max(0, 3 - this.state.communityCards2.length) : 1;
        if (count2 > 0) {
          cards2 = deck.deal(count2);
          this.state.communityCards2.push(...cards2);
        }
      }
      if (this.activeBoardCount >= 3 && this.state.communityCards3.length < 5) {
        const count3 = stage === 'flop' ? Math.max(0, 3 - this.state.communityCards3.length) : 1;
        if (count3 > 0) {
          cards3 = deck.deal(count3);
          this.state.communityCards3.push(...cards3);
        }
      }
      this.emit({ type: 'COMMUNITY_CARDS', stage: stage as HandStage, cards, cards2, cards3 });
      // AUDIT V2 (2026-07-23): Crazy Pineapple all-in runout — the discard
      // phase is skipped when everyone is all-in, so players still held THREE
      // hole cards at showdown and evaluateHand scored best-5-of-8, an illegal
      // extra-card advantage. Resolve pending discards as soon as the flop is
      // on the board, exactly where the discard belongs in the hand flow.
      if (this.config.gameVariant === 'pineapple' && this.state.communityCards.length >= 3) {
        this.resolvePendingPineappleDiscards();
      }
      if (this.state.communityCards.length === lengthBefore) {
        // The deck gave us nothing. Another turn of this loop would give us
        // nothing again, forever.
        break;
      }
    }
    this.transitionStage('showdown');
    this.completeHand();
  }

  /**
   * AUDIT V2 (2026-07-23): Force-resolve outstanding pineapple discards for
   * players who were all-in (or otherwise skipped) before the discard phase.
   * Keeps the best two cards for the player — the same choice any player
   * would make for themselves — so showdown is always a legal 2-card hand.
   */
  private resolvePendingPineappleDiscards(): void {
    const flop = this.state.communityCards.slice(0, 3);
    for (const player of this.state.players) {
      if (player.is_folded || player.cards.length !== 3) continue;
      /* ── KEEP THE BEST HAND, NOT THE BEST FLOP (2026-08-31) ──────────────
         This scored the flop-MADE hand and kept the highest of those. That is
         backwards in the only situation it runs: an ALL-IN, where two more
         cards are coming and there is no more betting, which is exactly when a
         draw is worth the most it will ever be worth. On A(h)K(h)+2(h) against
         7(h)8(h)3(c) it kept the pair of nothing and threw the nut flush draw
         away, because a pair outranks a draw on the flop and the flop was all
         it looked at.

         It now uses the same equity-priced chooser a HORSE uses, which is the
         point: CLAUDE.md 10.5 requires a horse and a human to be treated
         identically, and a decision made by two different rules cannot be. */
      const bestIdx = bestPineappleDiscard(
        player.cards,
        flop,
        this.config.gameVariant ?? 'pineapple'
      );
      const forced = player.cards.splice(bestIdx, 1);
      this.pineappleDiscardsRemaining.delete(player.seat);

      /* PHASE 4 2026-09-01: an all-in seat never chose, but the card still
         left their hand and it is still theirs to review. Same private event,
         same RLS-protected destination. */
      if (forced[0]) {
        this.emit({ type: 'PINEAPPLE_DISCARDED', seat: player.seat, card: forced[0] });
      }

      /* PHASE 3 AUDIT 2026-08-31 - this discard was SILENT, on every layer.
         
         `performDiscard` announces itself with a PLAYER_ACTION; this path
         never did. It is the same act - a card genuinely leaves a hand - and
         the only difference is that the seat was already all-in when the flop
         landed, so the round never opened and the engine chose for them.
         Without the announcement:
         
           - the seat drew no toss, made no sound, and kept three backs on the
             felt for the rest of the hand, which is exactly the Phase 3 bug
             still alive on one path;
           - `currentHandActions` never saw it, so the discard is missing from
             hand_history.actions and would be missing from the replay too;
           - the action history disagreed with the cards, on a hand that is by
             definition heading to showdown.
         
         CLAUDE.md 10.6 says an animation is owed every time it is owed, not
         on the paths that happen to be convenient. Announced identically here,
         BEFORE the cards go out, so ordering matches performDiscard. */
      this.state.actionHistory.push({
        seat: player.seat,
        userId: player.user_id,
        action: 'discard',
        amount: 0,
        timestamp: Date.now(),
        stage: this.state.stage,
      });
      this.emit({
        type: 'PLAYER_ACTION',
        seat: player.seat,
        action: 'discard',
        amount: 0,
        stage: this.state.stage,
      });

      this.emit({ type: 'CARDS_DEALT', seat: player.seat, cards: [...player.cards] });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Hand Completion
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * AUDIT FIX 2026-07-19: Return the uncalled portion of the final bet to the
   * bettor BEFORE forming pots / taking rake — the textbook rule. Previously
   * the excess stayed in `state.pot`, so rake and the BBJ fee were charged on
   * the bettor's own returned chips (e.g. bet 100 into a 20 pot, all fold →
   * rake was taken on 120, not 20), and the proportional payout scaling shaved
   * rake off the refund. Refunding here makes rake, side pots, and chips-in-
   * front all correct at once. Returns the amount refunded (0 if none).
   */
  private returnUncalledBet(): number {
    // Compare LIVE invested only (totalInvested minus dead money such as antes /
    // Big Blind Ante / dead small blinds). Dead money can never be an uncalled
    // bet — otherwise the BB who fronts a Big Blind Ante is refunded the whole
    // table's ante whenever it is the unique top contributor.
    const invAll = this.state.players.map((p) => {
      const dead = p.deadInvested ?? 0;
      const total = p.totalInvested ?? p.bet ?? 0;
      return { p, live: Math.max(0, Math.round((total - dead) * 100) / 100) };
    });
    const withMoney = invAll.filter((x) => x.live > 0);
    if (withMoney.length < 2) {
      // Nobody, or a single live contributor (e.g. a walk) — nothing was
      // "called", but there's also no contest, so leave it for the award path.
      return 0;
    }
    const sorted = [...withMoney].sort((a, b) => b.live - a.live);
    const top = sorted[0];
    const second = sorted[1];
    // Only a UNIQUE, non-folded highest live contributor can have an uncalled bet.
    if (top.live <= second.live) return 0;
    if (top.p.is_folded) return 0;
    const uncalled = Math.round((top.live - second.live) * 100) / 100;
    if (uncalled <= 0) return 0;

    top.p.stack += uncalled;
    top.p.totalInvested = Math.round(((top.p.totalInvested ?? 0) - uncalled) * 100) / 100;
    // WEIGHTED CONTRIBUTED RAKE (Dan 2026-08-29): keep the returned amount as
    // first-class state — it is excluded from eligible contribution (the
    // decrement above) and persisted for audit (rake_records.returned_uncalled,
    // rake_attributions.returned_uncalled). Accumulate: this function can run
    // on both the fast-fold path and completeHand, and only refunds once.
    top.p.returnedUncalled = Math.round(((top.p.returnedUncalled ?? 0) + uncalled) * 100) / 100;
    top.p.bet = Math.max(0, Math.round((top.p.bet - uncalled) * 100) / 100);
    this.state.pot = Math.max(0, Math.round((this.state.pot - uncalled) * 100) / 100);
    this.emit({
      type: 'UNCALLED_BET_RETURNED',
      seat: top.p.seat,
      userId: top.p.user_id,
      amount: uncalled,
    });
    return uncalled;
  }

  /**
   * 2026-08-15: completeHand mutates before it can fail — returnUncalledBet()
   * moves chips, SHOWDOWN is emitted, and only then does determineWinners()
   * run (which evaluates every non-folded player, including any with an empty
   * card array). A throw there left the pot refunded-but-undistributed with
   * HAND_COMPLETE never emitted, so dealHand's promise hung for the full
   * 10-minute safety timeout and the table stopped dealing.
   *
   * A hand that cannot be settled must still END. Emitting HAND_COMPLETE
   * releases the dealing loop; the error is reported for manual reconciliation
   * and players keep the chips they had going in (table_seats.stack is only
   * written at settlement, so an aborted settlement is a no-op on balances).
   */
  /**
   * DOUBLE-BOARD BOMB POT 2026-08-20: BOMB_POT_COMPLETED finally has an
   * emitter — fired after every HAND_COMPLETE of a bomb-pot hand so the
   * client overlay dismisses with the hand. No-op on ordinary hands.
   */
  private emitBombPotCompleted(): void {
    if (!this.config.bombPot) return;
    this.emit({ type: 'BOMB_POT_COMPLETED', handNumber: this.config.handNumber });
  }

  private completeHand(): void {
    // A hand that is over does not owe anybody a flop. PHASE 3 2026-08-31.
    this.cancelPineappleSettle();
    try {
      this.completeHandInner();
    } catch (err) {
      console.error('[HandController] completeHand threw - force-ending hand:', err);
      try {
        this.emit({ type: 'WINNERS', winners: [] } as never);
      } catch {
        /* keep going — the HAND_COMPLETE below is the load-bearing emit */
      }
      this.emit({
        type: 'HAND_COMPLETE',
        handNumber: this.config.handNumber,
        rake: 0,
        bbjFee: 0,
      } as never);
      this.emitBombPotCompleted();
    }
  }

  private completeHandInner(): void {
    // Return any uncalled bet to the bettor before rake / pot formation.
    this.returnUncalledBet();

    const pots = calculatePots(this.state.players);
    this.state.pots = pots;
    const activePlayers = this.getActivePlayers();

    if (activePlayers.length > 1) {
      // FIX 122: Pass shortDeck flag so showdown display uses correct hand rankings
      const isShortDeck = isShortDeckVariant(this.config.gameVariant);
      // 2026-08-23: was `startsWith('plo')`, which reads `flo8` — Fixed Limit
      // Omaha Hi-Lo — as a Hold'em game and evaluates it with any five of
      // seven instead of exactly two from hand.
      const isOmaha = isOmahaVariant(this.config.gameVariant);
      const evaluator = isOmaha
        ? evaluateOmahaHand
        : (h: Card[], c: Card[]) => evaluateHand(h, c, isShortDeck);
      const playersWithCards = activePlayers.filter((p) => p.cards && p.cards.length > 0);
      // DOUBLE/TRIPLE-BOARD BOMB POT: each shown hand also carries its
      // board-2 (and board-3) evaluation so clients can label every board.
      const showBoard2 = this.multiBoardActive && this.state.communityCards2.length === 5;
      const showBoard3 = this.activeBoardCount >= 3 && this.state.communityCards3.length === 5;
      const showdownResults: ShowdownResult[] = playersWithCards.map((p) => ({
        seat: p.seat,
        userId: p.user_id,
        cards: p.cards,
        hand: evaluator(p.cards, this.state.communityCards),
        hand2: showBoard2 ? evaluator(p.cards, this.state.communityCards2) : undefined,
        hand3: showBoard3 ? evaluator(p.cards, this.state.communityCards3) : undefined,
      }));

      // Bible V8 §4.21 + Dan spec sections 3/6/7: sort showdown results — the
      // FINAL betting round's last aggressor shows first, then clockwise. If
      // that street checked through (no aggressor), the first LIVE player in
      // normal river action order shows first — heads-up that is the Big
      // Blind, since the BB acts first postflop. getFirstShowdownSeat differs
      // from getFirstPostflopPlayer in that an all-in player is still a live
      // hand at showdown and must not be skipped over.
      const firstToShow =
        this.state.lastAggressorSeat >= 0
          ? this.state.lastAggressorSeat
          : this.getFirstShowdownSeat();
      if (firstToShow >= 0) {
        // FIX 165: Use max physical seat + 1 for modular distance, not player count.
        // Players may have non-contiguous seats (e.g., seats 1,3,5,7 at a 9-seat table).
        // Using players.length would give wrong clockwise distances.
        const maxSeatNum = Math.max(...this.state.players.map((p) => p.seat), firstToShow) + 1;
        showdownResults.sort((a, b) => {
          const aDist = (a.seat - firstToShow + maxSeatNum * 10) % maxSeatNum;
          const bDist = (b.seat - firstToShow + maxSeatNum * 10) % maxSeatNum;
          return aDist - bDist;
        });
      }

      this.applyShowdownRevealRules(showdownResults, pots);

      this.emit({ type: 'SHOWDOWN', results: showdownResults });
    }

    // FIX 226: Pass dealerSeat so odd chip allocation is clockwise from dealer
    //
    // DOUBLE-BOARD BOMB POT 2026-08-20 / TRIPLE-BOARD 2026-08-27 (spec §8/§9):
    // with N full boards, EVERY pot layer (main and each side pot) is split in
    // integer cents into N board shares — indivisible remainder cents go to
    // the lowest board numbers first (Board 1, then Board 2, then Board 3;
    // spec's LOWEST_BOARD_NUMBER policy) — and each share is awarded
    // independently on its own board among that pot layer's eligible players.
    // The merged winner list sums to exactly the original pot cents, so rake
    // scaling and chip conservation downstream are untouched.
    let winners: Winner[];
    const settlementBoards: Card[][] = [this.state.communityCards];
    if (this.multiBoardActive && this.state.communityCards2.length === 5) {
      settlementBoards.push(this.state.communityCards2);
    }
    if (this.activeBoardCount >= 3 && this.state.communityCards3.length === 5) {
      settlementBoards.push(this.state.communityCards3);
    }
    if (settlementBoards.length >= 2) {
      const boardCount = settlementBoards.length;
      // Per-board pot arrays: potsByBoard[b][p] is pot layer p's share on
      // board b. splitAcrossBoards (spec §18.1): floor division, remainder
      // cents to ascending board order.
      const potsByBoard: Pot[][] = Array.from({ length: boardCount }, () => []);
      for (const pot of pots) {
        const cents = Math.round(pot.amount * 100);
        const base = Math.floor(cents / boardCount);
        const remainder = cents % boardCount;
        for (let b = 0; b < boardCount; b++) {
          const shareCents = base + (b < remainder ? 1 : 0);
          potsByBoard[b].push({
            amount: shareCents / 100,
            eligiblePlayers: [...pot.eligiblePlayers],
          });
        }
      }
      // SHOWDOWN POLISH 2026-08-25: collect the unmerged per-pot(-share)
      // breakdown for each board so the award sequence can play the boards in
      // board-major order (spec §11.2), each pot with its exact share.
      const winnersPerBoard: Winner[][] = [];
      this.pendingPerPotAwards = [];
      for (let b = 0; b < boardCount; b++) {
        const perPot: PerPotAward[] = [];
        const boardWinners = determineWinners(
          this.state.players,
          settlementBoards[b],
          potsByBoard[b],
          this.config.gameVariant,
          this.state.dealerSeat,
          perPot
        );
        winnersPerBoard.push(boardWinners);
        this.pendingPerPotAwards.push(
          ...perPot.map((a) => ({ ...a, board: (b + 1) as 1 | 2 | 3 }))
        );
      }
      // Merge by user, integer cents throughout so the sum stays exact.
      const byUser = new Map<string, number>();
      // Keep the evaluated hand alongside the money. Rebuilding these entries as
      // { userId, amount } alone dropped `hand`, so on every multi-board hand
      // the merged winners carried no hand name and no cards — the board could
      // neither name the winning hand nor light the cards that made it. Where a
      // user won several boards, the higher-ranking hand is the one shown.
      const handByUser = new Map<string, Winner['hand']>();
      for (const w of winnersPerBoard.flat()) {
        byUser.set(w.userId, (byUser.get(w.userId) ?? 0) + Math.round(w.amount * 100));
        const held = handByUser.get(w.userId);
        if (w.hand && (!held || (w.hand.ranking ?? 0) > (held.ranking ?? 0))) {
          handByUser.set(w.userId, w.hand);
        }
      }
      winners = Array.from(byUser.entries()).map(([userId, cents]) => ({
        userId,
        amount: cents / 100,
        hand: handByUser.get(userId),
      }));
      // Round 2: keep the per-board story for the WINNERS emit below —
      // clients label each board with its own winner + hand name.
      this.pendingWinnersByBoard = [
        ...winnersPerBoard.flatMap((boardWinners, b) =>
          boardWinners.map((w) => ({
            board: (b + 1) as 1 | 2 | 3,
            userId: w.userId,
            amount: w.amount,
            handName: w.hand?.name,
          }))
        ),
      ];
    } else {
      const perPot: PerPotAward[] = [];
      winners = determineWinners(
        this.state.players,
        this.state.communityCards,
        pots,
        this.config.gameVariant,
        this.state.dealerSeat,
        perPot,
        // A pot whose eligibility snapshot matched nobody is still awarded -
        // to the contenders - but we want to know it happened, because a bad
        // snapshot means a side pot was built from state that has since moved.
        (info) =>
          reportError(
            new Error(
              `[HandController] pot ${info.potIndex} eligibility snapshot matched no contender ` +
                `(${info.snapshotEligible} listed, ${info.contenders} in the hand, ${info.potAmount} chips) - ` +
                `awarded to the contenders instead`
            ),
            'HandController.pot_eligibility_snapshot_stale'
          )
      );
      this.pendingPerPotAwards = perPot;
    }

    /**
     * A HAND ALWAYS HAS A WINNER (Dan 2026-08-26, binding).
     *
     * Verbatim: "a hand must ALWAYS have a winner, no matter what, that can
     * never happen, you must trigger a RE-CHECK or re-verification because it
     * is impossible for there to not be a winner ever."
     *
     * This used to read: award the pot to `activePlayers[0]`. That is not a
     * fallback, it is a coin toss dressed as one - the first entry of an array
     * has no relationship to who held the best hand, and the pot is real money.
     *
     * Empty winners never means "nobody won". It means the EVALUATION failed,
     * and the answer to a failed evaluation is to evaluate again, properly.
     * determineWinners no longer drops a pot on a stale eligibility snapshot,
     * so reaching here at all is close to impossible - but "close to" is not a
     * thing to settle a pot on.
     *
     * The re-check, in order, and every step decides on MERIT:
     *
     *   1. Re-run the evaluation against one pot holding the whole amount with
     *      every contender eligible. This is the same showdown with the
     *      snapshot removed from the question, and it is what recovers a stale
     *      or mis-shaped eligibility list.
     *   2. If exactly one contender remains, that player wins uncontested.
     *      This is a legitimate outcome, not a guess.
     *   3. If the evaluator still cannot separate them, split the pot equally
     *      among the contenders. Nobody is favoured by list position, and the
     *      money stays with the people who were still in the hand.
     *
     * Every branch past step 1 is a critical alarm, because reaching them means
     * the evaluator failed on a real hand and somebody has to look at it.
     */
    if (winners.length === 0) {
      const contenders = this.state.players.filter(
        (p) => !p.is_folded && Array.isArray(p.cards) && p.cards.length > 0
      );
      const totalPot = pots.reduce((sum, p) => sum + p.amount, 0);

      reportError(
        new Error(
          `[HandController] determineWinners returned no winners for a ${totalPot} chip pot ` +
            `with ${contenders.length} contender(s) - re-verifying`
        ),
        'HandController.no_winners_recheck'
      );

      // 1. Re-evaluate with the eligibility question removed.
      if (contenders.length > 0 && totalPot > 0) {
        winners = determineWinners(
          this.state.players,
          this.state.communityCards,
          [
            {
              amount: totalPot,
              eligiblePlayers: contenders.map((p) => p.user_id),
            } as (typeof pots)[number],
          ],
          this.config.gameVariant,
          this.state.dealerSeat
        );
      }

      // 2. One contender left is a winner, not a guess.
      if (winners.length === 0 && contenders.length === 1) {
        winners = [{ userId: contenders[0].user_id, amount: totalPot }];
        reportError(
          new Error(
            `[HandController] re-check settled a ${totalPot} chip pot on the single remaining contender`
          ),
          'HandController.no_winners_single_contender'
        );
      }

      // 3. Still nothing: split among the contenders. Never by list position.
      if (winners.length === 0 && contenders.length > 0) {
        const cents = Math.round(totalPot * 100);
        const share = Math.floor(cents / contenders.length);
        const remainder = cents - share * contenders.length;
        winners = contenders.map((p, i) => ({
          userId: p.user_id,
          // The odd cents go to the earliest seats, the same rule the split-pot
          // path uses, so the total is exact and the choice is not arbitrary.
          amount: (share + (i < remainder ? 1 : 0)) / 100,
        }));
        reportError(
          new Error(
            `[HandController] EVALUATOR FAILED on a real showdown - split a ${totalPot} chip pot ` +
              `equally among ${contenders.length} contenders. This needs a human.`
          ),
          'HandController.no_winners_evaluator_failed'
        );
      }

      // 4. No contenders at all and money on the table is a state we must not
      //    settle silently. Leaving winners empty lets the caller's own
      //    conservation checks refuse the hand rather than invent a recipient.
      if (winners.length === 0 && totalPot > 0) {
        reportError(
          new Error(
            `[HandController] ${totalPot} chips with NO contender in the hand - refusing to invent a winner`
          ),
          'HandController.no_winners_no_contenders'
        );
      }
    }

    // Bible V8 §1.9 / Appendix A: BBJ fee deducted SIMULTANEOUSLY with rake
    // before distribution. Priced by the ONE canonical helper
    // (priceDeductions), which owns the collection rule AND the pot-overage
    // clamp. Do not inline this arithmetic again — every copy of it drifted.
    const { rake, bbjFee } = this.priceDeductions(this.state.sawFlop, this.state.pot);
    const totalWinnings = this.state.pot - rake - bbjFee;
    const totalWinnerAmount = winners.reduce((sum, w) => sum + w.amount, 0);

    // If still no winners (impossible edge case), skip distribution to prevent chip loss
    if (winners.length === 0 || totalWinnerAmount === 0) {
      reportError(
        new Error(
          `[HandController] CRITICAL: No winners and no active players - pot of ${this.state.pot} cannot be distributed`
        ),
        'HandController.CRITICAL'
      );
      this.emit({ type: 'WINNERS', winners: [] });
      this.handFSM.transition('settlement');
      this.emit({ type: 'HAND_COMPLETE', handNumber: this.config.handNumber, rake: 0, bbjFee: 0 });
      this.emitBombPotCompleted();
      this.handFSM.transition('idle');
      return;
    }

    // Round 40 audit Pass 3 fix: Integer-cents arithmetic. Use Math.round
    // (NOT Math.trunc) for the float→cents conversion — IEEE 754 drift can
    // make state.pot of "$140.30" actually be 140.29999..., so
    // Math.trunc(140.299... * 100) = 13479, not 13480, leaking exactly 1¢
    // per chop pot whose total had any drift. distributePot already uses
    // Math.round (FIX 179, PokerEngine.ts:652); completeHand was the
    // outlier still on Math.trunc. Verified live: hand 254 (chop pot
    // $134.80 → recorded as 67.40 + 67.39 = $134.79, missing 1¢) is
    // exactly this case.
    //
    // After Math.round, adjustedCents.sum may be over OR under totalCents.
    // Two separate distribute loops handle both directions so the post
    // condition `sum(adjustedCents) === totalCents` always holds.
    const adjustedCents = scaleWinnerCentsForRake(
      winners.map((w) => w.amount),
      totalWinnings
    );
    const adjustedAmounts = adjustedCents.map((c) => c / 100);
    const adjustedWinners = winners.map((w, i) => ({ ...w, amount: adjustedAmounts[i] }));

    for (const winner of adjustedWinners) {
      const player = this.state.players.find((p) => p.user_id === winner.userId);
      if (player) player.stack += winner.amount;
    }
    // AUDIT V6: snap stacks after settlement — the payout cents are exact,
    // but += on binary floats is where cross-hand drift was born.
    this.snapChips();

    // SHOWDOWN POLISH 2026-08-25 (review fix): scale the per-pot display
    // shares by the same global rake ratio the merged winners were scaled
    // by, then REPAIR each user's rounding pennies against the amount they
    // were actually credited — independent Math.round per entry could drift
    // a user's displayed shares cents away from their real credit, and the
    // "+N" floats are the numbers players read (this repo's own history —
    // the hand-254 one-cent chop — treats displayed penny drift as a bug).
    // The repair walks a user's entries largest-first, adjusting the last
    // one so the sum matches the credit EXACTLY. Display only — credited
    // money came exclusively from adjustedWinners above.
    //
    // Each entry also carries its own engine-generated hand description —
    // board-2 groups previously inherited the BOARD-1 description from the
    // showdown results, pairing e.g. a board-2 "Flush" name with a board-1
    // "Two Pair" description.
    const rakeRatio = totalWinnerAmount > 0 ? totalWinnings / totalWinnerAmount : 1;
    const scaledPerPot = this.pendingPerPotAwards.map((a) => ({
      ...a,
      amount: Math.round(a.amount * rakeRatio * 100) / 100,
      handDescription: a.low ? (a.hand?.name ?? '') : a.hand ? describeHand(a.hand) : '',
    }));
    const creditByUser = new Map(
      adjustedWinners.map((w) => [w.userId, Math.round(w.amount * 100)])
    );
    const entriesByUser = new Map<string, typeof scaledPerPot>();
    for (const a of scaledPerPot) {
      const g = entriesByUser.get(a.userId);
      if (g) g.push(a);
      else entriesByUser.set(a.userId, [a]);
    }
    for (const [userId, entries] of entriesByUser) {
      const credit = creditByUser.get(userId);
      if (credit === undefined) continue;
      const summed = entries.reduce((s, e) => s + Math.round(e.amount * 100), 0);
      const diff = credit - summed;
      if (diff !== 0 && entries.length > 0) {
        // Put the penny difference on the user's largest entry, floored at 0.
        const target = entries.reduce((m, e) => (e.amount > m.amount ? e : m), entries[0]);
        target.amount = Math.max(0, (Math.round(target.amount * 100) + diff) / 100);
      }
    }

    /* POST-RAKE, LIKE EVERYTHING ELSE ON THIS EVENT (2026-09-04 second
       sweep). pendingWinnersByBoard was built above from the PRE-rake board
       winners and emitted raw beside post-rake `winners` and `perPotAwards`,
       then persisted verbatim into hand_history.winners_by_board - so on a
       double/triple-board bomb pot the per-board shares summed to MORE than
       the paid total, while on a run-it-twice hand (built from the penny-
       repaired awards in ServerTableEngineRunout) they summed exactly. One
       column, two meanings. Rebuilt here from the repaired awards, grouped
       by board and winner, the same way the RIT path does it. */
    const winnersByBoardPostRake = this.pendingWinnersByBoard
      ? (() => {
          const byKey = new Map<
            string,
            { board: 1 | 2 | 3; userId: string; amount: number; handName?: string }
          >();
          for (const a of scaledPerPot) {
            const board = ((a.board ?? 1) as 1 | 2 | 3) || 1;
            const key = `${board}|${a.userId}`;
            const existing = byKey.get(key);
            if (existing) existing.amount = Math.round((existing.amount + a.amount) * 100) / 100;
            else
              byKey.set(key, { board, userId: a.userId, amount: a.amount, handName: a.hand?.name });
          }
          return [...byKey.values()].sort((x, y) => x.board - y.board);
        })()
      : undefined;

    this.emit({
      type: 'WINNERS',
      winners: adjustedWinners,
      winnersByBoard: winnersByBoardPostRake,
      perPotAwards: scaledPerPot,
    });
    this.handFSM.transition('settlement');
    this.emit({ type: 'HAND_COMPLETE', handNumber: this.config.handNumber, rake, bbjFee });
    this.emitBombPotCompleted();
    this.handFSM.transition('idle');
  }

  /**
   * SHOWDOWN SYSTEM 2026-08-25 (Dan spec sections 3-11): annotate the sorted
   * showdown results with reveal order, muck eligibility, and the descriptive
   * hand line. The ENGINE decides who may muck — never the client.
   *
   * The rules, walking the results in reveal order (last final-street
   * aggressor first, else first player in normal river action order):
   *
   *   - The first player to show always tables their hand.
   *   - Each later player must show if, in ANY pot they are eligible for,
   *     their hand beats OR TIES the best hand already required to show for
   *     that pot — on either board of a double-board hand, and on either the
   *     high or the qualifying low half of a hi-lo hand. This is also the
   *     accidental-muck protection: a hand that wins or ties any available
   *     pot is automatically tabled and can never be mucked (spec section 5).
   *   - A player whose hand cannot win or tie anything may muck: their hole
   *     cards stay private and the seat renders MUCKED (spec section 4).
   *   - When an all-in ended all possible betting (allInShowdownLocked),
   *     EVERY live hand is exposed and nobody may muck (spec section 8) —
   *     cash and tournament, heads-up and multiway, main and side pots.
   *
   * Because a mucked hand strictly loses to a shown, pot-eligible hand in
   * every pot it could contest, determineWinners can never award a mucked
   * hand anything — the muck decision and the payout stay consistent by
   * construction.
   */
  private applyShowdownRevealRules(results: ShowdownResult[], pots: Pot[]): void {
    results.forEach((r, i) => {
      r.revealOrder = i;
      r.handDescription = describeHand(r.hand);
      r.mucked = false;
    });

    /**
     * A TOURNAMENT SHOWDOWN IS ALWAYS FACE UP (Dan 2026-08-28, binding).
     *
     * "IN SPINS, ITS A TOURNAMENT, SO THE 'SHOW CARDS' POP UP SHOULD NEVER
     * EVER APPEAR, ALL CARDS ARE ALWAYS SHOWN AT SHOWDOWN."
     *
     * The rules below are the cash-game courtesy: a hand that cannot win or
     * tie any pot may keep its cards private. A tournament does not grant
     * that — every hand that reaches showdown is tabled, which is also what
     * makes the hand history and the rail honest about how a player busted.
     *
     * Placed beside the all-in lock because it is the same shape of rule:
     * an early return leaves every `r.mucked = false` from the loop above
     * standing, so nothing downstream has to special-case it. `is_mucked`
     * in the snapshot, the MUCKED seat label, the withheld hole cards and
     * the persisted showdown set all key off that one flag.
     */
    if (this.config.isTournament) return;

    // Spec section 8: all-in with no further betting possible — expose all.
    if (this.allInShowdownLocked) return;

    // AUDIT FIX 2026-08-25 (spec sections 8/10, "River all-ins" included): the
    // runout park only catches an all-in with CARDS TO COME. A river all-in
    // that gets called, or a multiway pot where the last live stacks went in
    // on the final street, reaches here without the lock — yet at most one
    // live player could still have bet, so this too is an all-in showdown and
    // every live hand is tabled. When two or more live players still have
    // chips behind (spec section 9's shape), normal muck rules apply.
    const liveCanStillBet = results.filter((r) => {
      const p = this.state.players.find((pp) => pp.seat === r.seat);
      return p ? !p.is_all_in : false;
    }).length;
    if (liveCanStillBet <= 1) return;

    const isHiLo = isHiLoVariant(this.config.gameVariant);
    const lowByUser = new Map<string, number[] | null>();
    // AUDIT FIX 2026-08-25 (double-board hi-lo): each board settles its own
    // hi AND lo half, so muck eligibility must consider the board-2 low too —
    // without lowByUser2/bestShownLo2, a hand winning ONLY board-2's low was
    // ruled muckable and then paid, breaking the mucked-hands-never-win
    // invariant.
    const board2Live = results.some((r) => r.hand2 !== undefined);
    // TRIPLE-BOARD 2026-08-27: board 3's hi and lo halves compete for muck
    // eligibility exactly like board 2's — a hand winning ONLY a board-3
    // share must never be ruled muckable and then paid.
    const board3Live = results.some((r) => r.hand3 !== undefined);
    const lowByUser2 = new Map<string, number[] | null>();
    const lowByUser3 = new Map<string, number[] | null>();
    if (isHiLo) {
      for (const r of results) {
        const low = evaluateOmahaLowHand(r.cards, this.state.communityCards);
        lowByUser.set(r.userId, low ? low.kickers : null);
        if (board2Live) {
          const low2 = evaluateOmahaLowHand(r.cards, this.state.communityCards2);
          lowByUser2.set(r.userId, low2 ? low2.kickers : null);
        }
        if (board3Live) {
          const low3 = evaluateOmahaLowHand(r.cards, this.state.communityCards3);
          lowByUser3.set(r.userId, low3 ? low3.kickers : null);
        }
      }
    }
    // SHOWDOWN POLISH 2026-08-25 (hygiene): the low comparator is the SAME
    // exported function the payout path uses (PokerEngine.compareLowHands) —
    // the previous local duplicate could have drifted from the function that
    // actually awards the low half.
    const compareLowKickers = compareLowHands;

    // Per pot index: the best hand among players already required to show.
    const bestShownHi: (EvaluatedHand | null)[] = pots.map(() => null);
    const bestShownLo: (number[] | null)[] = pots.map(() => null);
    const bestShownHi2: (EvaluatedHand | null)[] = pots.map(() => null);
    const bestShownLo2: (number[] | null)[] = pots.map(() => null);
    const bestShownHi3: (EvaluatedHand | null)[] = pots.map(() => null);
    const bestShownLo3: (number[] | null)[] = pots.map(() => null);

    for (const r of results) {
      let eligibleAnywhere = false;
      let mustShow = false;
      // AUDIT FIX 2026-08-25 (BBJ integrity): a hand of four of a kind or
      // better is ALWAYS tabled, win or lose. The Bad Beat Jackpot pays the
      // LOSER of exactly such a hand, and bbj_hit broadcasts that hand's
      // identity — a jackpot paid on a hand the table never saw is a
      // contradiction, and every cardroom tables jackpot hands. Ranking 8 is
      // FOUR_OF_A_KIND in both standard and short-deck orderings.
      if (
        r.hand.ranking >= 8 ||
        (r.hand2 && r.hand2.ranking >= 8) ||
        (r.hand3 && r.hand3.ranking >= 8)
      ) {
        mustShow = true;
      }
      for (let potIdx = 0; !mustShow && potIdx < pots.length; potIdx++) {
        if (!pots[potIdx].eligiblePlayers.includes(r.userId)) continue;
        eligibleAnywhere = true;
        const hi = bestShownHi[potIdx];
        if (hi === null || compareHands(r.hand, hi) >= 0) {
          mustShow = true;
          break;
        }
        if (r.hand2) {
          const hi2 = bestShownHi2[potIdx];
          if (hi2 === null || compareHands(r.hand2, hi2) >= 0) {
            mustShow = true;
            break;
          }
        }
        if (r.hand3) {
          const hi3 = bestShownHi3[potIdx];
          if (hi3 === null || compareHands(r.hand3, hi3) >= 0) {
            mustShow = true;
            break;
          }
        }
        if (isHiLo) {
          const myLow = lowByUser.get(r.userId) ?? null;
          if (myLow) {
            const lo = bestShownLo[potIdx];
            if (lo === null || compareLowKickers(myLow, lo) <= 0) {
              mustShow = true;
              break;
            }
          }
          // AUDIT FIX 2026-08-25: board-2's low half competes too.
          const myLow2 = board2Live ? (lowByUser2.get(r.userId) ?? null) : null;
          if (myLow2) {
            const lo2 = bestShownLo2[potIdx];
            if (lo2 === null || compareLowKickers(myLow2, lo2) <= 0) {
              mustShow = true;
              break;
            }
          }
          const myLow3 = board3Live ? (lowByUser3.get(r.userId) ?? null) : null;
          if (myLow3) {
            const lo3 = bestShownLo3[potIdx];
            if (lo3 === null || compareLowKickers(myLow3, lo3) <= 0) {
              mustShow = true;
              break;
            }
          }
        }
      }
      // Defensive: a live hand that somehow appears in no pot still shows.
      // (eligibleAnywhere is only meaningful when the pot loop actually ran —
      // a hand force-shown by the jackpot rule above skips the loop and is
      // already showing, which is the safe direction.)
      if (!eligibleAnywhere && !mustShow) mustShow = true;

      if (!mustShow) {
        r.mucked = true;
        continue;
      }
      for (let potIdx = 0; potIdx < pots.length; potIdx++) {
        if (!pots[potIdx].eligiblePlayers.includes(r.userId)) continue;
        const hi = bestShownHi[potIdx];
        if (hi === null || compareHands(r.hand, hi) > 0) bestShownHi[potIdx] = r.hand;
        if (r.hand2) {
          const hi2 = bestShownHi2[potIdx];
          if (hi2 === null || compareHands(r.hand2, hi2) > 0) bestShownHi2[potIdx] = r.hand2;
        }
        if (r.hand3) {
          const hi3 = bestShownHi3[potIdx];
          if (hi3 === null || compareHands(r.hand3, hi3) > 0) bestShownHi3[potIdx] = r.hand3;
        }
        if (isHiLo) {
          const myLow = lowByUser.get(r.userId) ?? null;
          if (myLow) {
            const lo = bestShownLo[potIdx];
            if (lo === null || compareLowKickers(myLow, lo) < 0) bestShownLo[potIdx] = myLow;
          }
          const myLow2 = board2Live ? (lowByUser2.get(r.userId) ?? null) : null;
          if (myLow2) {
            const lo2 = bestShownLo2[potIdx];
            if (lo2 === null || compareLowKickers(myLow2, lo2) < 0) bestShownLo2[potIdx] = myLow2;
          }
          const myLow3 = board3Live ? (lowByUser3.get(r.userId) ?? null) : null;
          if (myLow3) {
            const lo3 = bestShownLo3[potIdx];
            if (lo3 === null || compareLowKickers(myLow3, lo3) < 0) bestShownLo3[potIdx] = myLow3;
          }
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * DOUBLE-BOARD BOMB POT 2026-08-20: exposed so ServerTableEngine can skip
   * RIT and insurance offers — a hand that already runs two boards neither
   * needs a second runout nor has a single-board equity to insure.
   *
   * TRIPLE-BOARD 2026-08-27: true for ANY multi-board hand (2 or 3 boards) —
   * every caller uses this as "is this a multi-board hand", and the RIT and
   * insurance suppressions apply equally to three boards (spec §19).
   */
  public isDoubleBoardActive(): boolean {
    return this.multiBoardActive;
  }

  /** TRIPLE-BOARD 2026-08-27: how many boards this hand actually deals (1-3). */
  public getActiveBoardCount(): number {
    return this.activeBoardCount;
  }

  /**
   * VARIANT OVERRIDE 2026-08-28 (spec §10.1): the variant THIS hand is being
   * played under. Identical to the table's variant on every normal hand; on a
   * variant-override bomb pot it is the bomb variant, and every consumer that
   * asks "what game is this hand" — betting structure, legal-action clamps,
   * horse evaluation, hand history — must read it from here rather than from
   * the table row. See ServerTableEngineBase.activeHandVariant().
   */
  public getGameVariant(): string {
    return this.config.gameVariant;
  }

  private getActivePlayers(): SeatPlayer[] {
    return this.state.players.filter((p) => !p.is_folded && !p.is_sitting_out);
  }

  private getNextActiveSeat(fromSeat: number): number {
    const seats = this.state.players
      .filter((p) => !p.is_sitting_out)
      .map((p) => p.seat)
      .sort((a, b) => a - b);
    if (seats.length === 0) return -1;
    for (const seat of seats) {
      if (seat > fromSeat) return seat;
    }
    return seats[0];
  }

  private getFirstPostflopPlayer(): number {
    const activePlayers = this.getActivePlayers().filter((p) => !p.is_all_in);
    if (activePlayers.length === 0) return -1;

    let seat = this.getNextActiveSeat(this.state.dealerSeat);
    let iterations = 0;
    const maxIterations = this.state.players.length;

    while (iterations < maxIterations) {
      const player = this.state.players.find((p) => p.seat === seat);
      if (player && !player.is_folded && !player.is_all_in && !player.is_sitting_out) {
        return seat;
      }
      seat = this.getNextActiveSeat(seat);
      iterations++;
    }
    return activePlayers[0]?.seat ?? -1;
  }

  /**
   * SHOWDOWN SYSTEM 2026-08-25: first LIVE hand in normal river action order
   * — the seat that tables first when the final street checked through.
   * Unlike getFirstPostflopPlayer this does NOT skip all-in players: an
   * all-in hand cannot act in a betting round but is very much live at
   * showdown and holds its place in the reveal order.
   */
  private getFirstShowdownSeat(): number {
    const live = this.getActivePlayers();
    if (live.length === 0) return -1;
    let seat = this.getNextActiveSeat(this.state.dealerSeat);
    for (let i = 0; i < this.state.players.length; i++) {
      const p = this.state.players.find((pp) => pp.seat === seat);
      if (p && !p.is_folded && !p.is_sitting_out) return seat;
      seat = this.getNextActiveSeat(seat);
    }
    return live[0]?.seat ?? -1;
  }

  /** Is this seat currently able to act (not folded, all-in, or sitting out)? */
  private isSeatActionable(seat: number): boolean {
    const p = this.state.players.find((x) => x.seat === seat);
    return !!(p && !p.is_folded && !p.is_all_in && !p.is_sitting_out);
  }

  /**
   * Walk clockwise from `fromSeat` to the next seat that can act. If `inclusive`
   * and `fromSeat` itself can act, returns it unchanged. Returns -1 if no seat
   * can act (everyone remaining is all-in / folded / sitting out).
   *
   * AUDIT FIX 2026-07-19: the preflop first-actor branch previously skipped
   * this normalization, so a player who posted an all-in blind (short SB/BB)
   * could be handed the turn and then auto-folded on timeout — forfeiting their
   * pot equity. All turn assignment now flows through here.
   */
  private nextActionableSeat(fromSeat: number, inclusive = false): number {
    if (inclusive && this.isSeatActionable(fromSeat)) return fromSeat;
    let seat = this.getNextActiveSeat(fromSeat);
    let iterations = 0;
    const maxIterations = this.state.players.length + 1;
    while (iterations < maxIterations) {
      if (this.isSeatActionable(seat)) return seat;
      const next = this.getNextActiveSeat(seat);
      if (next === seat) break; // no progress possible
      seat = next;
      iterations++;
      if (seat === fromSeat) break; // full loop, no actionable seat
    }
    return this.isSeatActionable(seat) ? seat : -1;
  }

  private setNextPlayer(): void {
    const activePlayers = this.getActivePlayers().filter((p) => !p.is_all_in);
    if (activePlayers.length === 0) {
      this.state.currentPlayerSeat = -1;
      return;
    }

    const allActive = this.getActivePlayers();
    const isHeadsUp = allActive.length === 2;

    if (this.state.stage === 'preflop' && this.state.actionHistory.length === 0) {
      let candidate: number;
      if (isHeadsUp) {
        candidate = this.state.dealerSeat;
      } else {
        const sbSeat = this.getNextActiveSeat(this.state.dealerSeat);
        const bbSeat = this.getNextActiveSeat(sbSeat);
        // Bible V8 §4.4: If straddles are posted, first to act is left of last straddler
        if (this.config.straddles && this.config.straddles.length > 0) {
          const lastStraddleSeat = this.config.straddles[this.config.straddles.length - 1].seat;
          candidate = this.getNextActiveSeat(lastStraddleSeat);
        } else {
          candidate = this.getNextActiveSeat(bbSeat);
        }
      }
      // Skip past any all-in/folded blind poster to the first player who can act.
      this.state.currentPlayerSeat = this.nextActionableSeat(candidate, true);
      return;
    }

    this.state.currentPlayerSeat = this.nextActionableSeat(this.state.currentPlayerSeat, false);
  }

  private emitTurnChange(): void {
    const player = this.state.players.find((p) => p.seat === this.state.currentPlayerSeat);
    if (!player) {
      // 2026-08-15 FREEZE FIX. setNextPlayer/nextActionableSeat can return -1,
      // and this silently returned — leaving the hand with no current player,
      // no TURN_CHANGE event and therefore no clock, until the 10-minute hand
      // safety void. start() already guards this exact case (AUDIT FIX
      // 2026-07-19); the two mid-hand call sites (advanceGame, advanceStage)
      // did not. If there is no actionable seat, the street is over — run it
      // out rather than hang.
      console.warn(
        '[HandController] No actionable seat at stage ' + this.state.stage + ' - advancing stage'
      );
      this.advanceStage();
      return;
    }
    const availableActions = this.getAvailableActions(player);
    this.emit({ type: 'TURN_CHANGE', seat: this.state.currentPlayerSeat, availableActions });
  }

  private getAvailableActions(player: SeatPlayer): ActionType[] {
    // ── ALL-IN-OR-FOLD (2026-08-22 parity) ──────────────────────────────────
    // The menu mirrors the performAction gate exactly: preflop offers fold,
    // all-in (stack permitting), and check only when nothing is owed.
    if (this.config.allInOrFold && this.state.stage === 'preflop') {
      const aofActions: ActionType[] = ['fold'];
      if (this.state.currentBet - player.bet <= 0) aofActions.push('check');
      if (player.stack > 0) aofActions.push('all_in');
      return aofActions;
    }
    const actions: ActionType[] = ['fold'];
    const toCall = this.state.currentBet - player.bet;
    // 2026-08-23 (fixed limit): once a street has taken its bet and three
    // raises the round is capped — fold and call are the only moves. Withheld
    // here as well as rejected in validateAction so the button never appears.
    const wagersCapped =
      isFixedLimitVariant(this.config.gameVariant) &&
      isFixedLimitCapped(this.state.actionHistory, this.state.stage);
    if (toCall === 0) {
      actions.push('check');

      // FIX-A1 2026-07-19: when there is no bet to call, an opening wager is a
      // `bet` (currentBet===0, e.g. post-flop checked to this player). But when a
      // bet already exists and this player owes nothing — the BB or straddler
      // exercising their option preflop — the legal move is a `raise`, not a
      // `bet` (validateAction rejects `bet` while currentBet>0). Offering `bet`
      // there left the option un-actionable from the menu.
      if (player.stack > 0 && !wagersCapped) {
        if (this.state.currentBet === 0) actions.push('bet');
        else if (this.canReopenBetting(player)) actions.push('raise');
      }
    } else {
      actions.push('call');
      // FIX-A1 2026-07-19 (Bible V8 §4.14 / TDA Rule 44): only offer `raise`
      // when the player can legally REOPEN betting. A sub-full-raise all-in does
      // not reopen action for a player who has already voluntarily acted this
      // street and is not now facing a full raise since their last action.
      if (player.stack > toCall && !wagersCapped && this.canReopenBetting(player))
        actions.push('raise');
    }

    // ── Dan 2026-08-21 (fuzzer INV-LEGALITY) ──────────────────────────────
    // all_in used to be pushed UNCONDITIONALLY, and in pot-limit that made the
    // menu lie. performAction clamps a pot-limit shove down to the pot cap and
    // re-validates it as a raise; when the cap is below a full raise (which
    // antes and the big-blind ante make reachable) that clamped raise is
    // ILLEGAL, so the engine offered all_in and then refused it. The property
    // fuzzer found it on two independent seeds, and its note is the point:
    // "a player pressing that button gets the same rejection."
    //
    // Offer it only when it would actually be accepted, using the same
    // betting state and the same clamp performAction uses - so the menu and
    // the rule can never disagree again. Calling all-in with a stack of zero
    // is likewise not an action.
    if (player.stack > 0) {
      // 2026-08-23: probe through the SAME clamp performAction uses, so the
      // menu and the rule cannot drift apart — that drift is exactly what the
      // fuzzer caught in pot-limit, and fixed limit has three ceilings (small
      // bet, big bet, capped round) for it to drift against.
      const bettingState = this.buildBettingState(player);
      const probe = this.clampToStructure(player, 'all_in', undefined, bettingState);
      // A clamped pot-limit shove is a RAISE by the time performAction runs
      // (that is where the "all_in is exempt" note stops applying - the clamp
      // has already rewritten the action), so it must also pass the
      // reopen-betting rule. A player who has acted and faces only a
      // sub-full-raise may call or fold, never raise: TDA 44 / Bible V8
      // 4.14. Offering all_in there is what the fuzzer caught. (The fixed-limit
      // branch of the clamp already degrades such a raise to a call, so this
      // only still bites in pot-limit.)
      const wasClamped = probe.action !== 'all_in';
      const legal =
        validateAction(probe.action, probe.amount, player.stack, bettingState).valid &&
        (!wasClamped || probe.action !== 'raise' || this.canReopenBetting(player));
      if (legal) {
        actions.push('all_in');
      }
    }
    return actions;
  }

  /**
   * Bible V8 §4.14 / TDA Rule 44 — may this player legally REOPEN betting (i.e.
   * make a `raise`)? A raise or all-in of less than a full raise does NOT reopen
   * betting to a player who has already voluntarily acted this street and is not
   * currently facing a full raise made since their last action. This mirrors the
   * full-aggressor logic used by isBettingRoundComplete so both agree.
   *
   * Note: this gates the explicit `raise` action only. A player may always go
   * `all_in` for their remaining stack even when it does not reopen betting.
   */
  /**
   * The street `advanceStage` is about to move into. Mirrors the order its own
   * switch already hardcodes; it exists only so the fixed-limit bet size can be
   * reset for the INCOMING street before the transition happens.
   */
  private nextStageAfter(stage: HandStage): HandStage {
    switch (stage) {
      case 'preflop':
        return 'flop';
      case 'flop':
        // Crazy Pineapple inserts its discard between flop and turn; both are
        // small-bet streets, so either answer sizes the same, but name the one
        // advanceStage actually goes to.
        return this.config.gameVariant === 'pineapple' ? 'pineapple_discard' : 'turn';
      case 'pineapple_discard':
        return 'turn';
      case 'turn':
        return 'river';
      default:
        return 'showdown';
    }
  }

  /**
   * The legal betting bounds for a player about to act, under whichever
   * structure this table's variant uses.
   *
   * 2026-08-23: this replaces `gameVariant.startsWith('plo')`, which was
   * duplicated at both call sites here and twice more in ServerTableEngineTurns.
   * Four copies of a two-way test is exactly how a third structure gets
   * silently treated as no-limit — which is what would have happened to `flh`.
   */
  private buildBettingState(player: SeatPlayer): BettingState {
    const variant = this.config.gameVariant;

    if (isFixedLimitVariant(variant)) {
      return calculateBettingState(
        this.state.pot,
        this.state.currentBet,
        player.bet,
        this.config.bigBlind,
        this.state.lastRaise,
        false,
        {
          // Small bet preflop and flop, big bet turn and river.
          betSize: fixedLimitBetSize(this.config.bigBlind, this.state.stage),
          capped: isFixedLimitCapped(this.state.actionHistory, this.state.stage),
        }
      );
    }

    return calculateBettingState(
      this.state.pot,
      this.state.currentBet,
      player.bet,
      this.config.bigBlind,
      this.state.lastRaise,
      isPotLimitVariant(variant)
    );
  }

  /**
   * Rewrite an action the structure's ceiling forbids into the largest thing
   * it does allow.
   *
   * ── Dan 2026-08-21 (PLO hard cap) ──
   * In pot-limit the maximum is the pot, so a stack bigger than the cap CANNOT
   * shove. validateAction rejects that (PokerEngine.ts) — the rule truth — but
   * a bare rejection would freeze the table when the shove came from an
   * automated path (horse decision, disconnect auto-action, watchdog force).
   * Pot-limit "all in" means "bet the legal maximum", so clamp.
   *
   * ── 2026-08-23 (fixed limit) ──
   * Fixed limit has the same problem, harder: the ceiling is the street's bet
   * and it drops to the standing bet once the round is capped, so a deep
   * stack's shove has to become a plain call. And unlike pot-limit, a clamped
   * fixed-limit raise can land on a player who may not reopen betting — so
   * that case degrades to a call rather than returning false and stalling the
   * seat. Pot-limit behaviour below is deliberately left byte-identical to
   * what it was; only the fixed-limit branch is new.
   */
  private clampToStructure(
    player: SeatPlayer,
    action: ActionType,
    amount: number | undefined,
    bs: BettingState
  ): { action: ActionType; amount?: number } {
    if (action !== 'all_in' || bs.maxRaise === undefined) return { action, amount };

    const allInTo = player.bet + player.stack;
    const isFixed = bs.structure === 'fixed_limit';
    // A capped street admits no wager at all, so the ceiling is the bet already
    // standing — the shove can only ever be a call.
    const capTo =
      isFixed && bs.wagersCapped ? this.state.currentBet : this.state.currentBet + bs.maxRaise;

    if (allInTo <= capTo + 0.005) return { action, amount };

    if (!isFixed) {
      return {
        action: this.state.currentBet > 0 ? 'raise' : 'bet',
        amount: Math.round(capTo * 100) / 100,
      };
    }

    // Already at or past the ceiling with nothing owed: there is no wager left
    // to make, so this is a check (or a call if a bet still stands).
    if (capTo <= player.bet + 0.005) {
      return {
        action: this.state.currentBet > player.bet + 0.005 ? 'call' : 'check',
        amount: undefined,
      };
    }
    // Capped street with chips behind: matching the bet is all that is left.
    if (capTo <= this.state.currentBet + 0.005) {
      return { action: 'call', amount: undefined };
    }
    const wager: ActionType = this.state.currentBet > 0 ? 'raise' : 'bet';
    // TDA 44 / Bible V8 §4.14: the clamp has rewritten this into a raise, so it
    // must now satisfy the reopen rule the raise path enforces. A player who
    // cannot reopen may call or fold, never raise.
    if (wager === 'raise' && !this.canReopenBetting(player)) {
      return { action: 'call', amount: undefined };
    }
    return { action: wager, amount: Math.round(capTo * 100) / 100 };
  }

  private canReopenBetting(player: SeatPlayer): boolean {
    const stageActions = this.state.actionHistory.filter((a) => a.stage === this.state.stage);

    // Index of the last FULL aggression this street: a normal bet/raise, or an
    // all-in flagged isFullRaise. Short all-ins carry isFullRaise=false and are
    // never counted, so they cannot reopen betting.
    let lastFullAggressorSeat = -1;
    let lastFullAggressorIdx = -1;
    for (let i = 0; i < stageActions.length; i++) {
      const a = stageActions[i];
      if (a.action === 'bet' || a.action === 'raise' || (a.action === 'all_in' && a.isFullRaise)) {
        lastFullAggressorSeat = a.seat;
        lastFullAggressorIdx = i;
      }
    }

    // The player's own last voluntary action index this street. Forced blind and
    // straddle posts are NOT recorded in actionHistory, so a yet-to-act BB or
    // straddler reads as -1 here and correctly retains the option to raise.
    let playerLastIdx = -1;
    for (let i = stageActions.length - 1; i >= 0; i--) {
      if (stageActions[i].seat === player.seat) {
        playerLastIdx = i;
        break;
      }
    }

    if (lastFullAggressorSeat !== -1 && lastFullAggressorSeat !== player.seat) {
      // Reopened only if the full raise landed AFTER the player's last action.
      return playerLastIdx < lastFullAggressorIdx;
    }

    // No full aggression this street (only limps / short all-ins), or the player
    // is themselves the last full aggressor: they may raise only if they have not
    // yet voluntarily acted (an open-raise or the blind/straddle option).
    return playerLastIdx === -1;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Getters
  // ─────────────────────────────────────────────────────────────────────────

  getState(): GameState {
    return {
      ...this.state,
      players: this.state.players.map((p) => ({ ...p, cards: [...p.cards] })),
      communityCards: [...this.state.communityCards],
      pots: this.state.pots.map((p) => ({ ...p, eligiblePlayers: [...p.eligiblePlayers] })),
      actionHistory: [...this.state.actionHistory],
    };
  }

  getCurrentPlayer(): SeatPlayer | undefined {
    return this.state.players.find((p) => p.seat === this.state.currentPlayerSeat);
  }

  getCommunityCards(): Card[] {
    return [...this.state.communityCards];
  }

  getPot(): number {
    return this.state.pot;
  }

  /**
   * FIX 97: Get remaining deck cards for RIT dual/triple board dealing.
   * Returns a copy of the remaining cards without modifying the deck.
   */
  getRemainingDeck(): import('../types.js').Card[] {
    const deck = this.state.deck as unknown as import('./PokerEngine.js').Deck;
    return deck.getRemainingCards();
  }

  /**
   * FIX 97: Get current pots structure for RIT per-pot resolution.
   */
  getPots(): import('../types.js').Pot[] {
    return this.state.pots.map((p) => ({ ...p, eligiblePlayers: [...p.eligiblePlayers] }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Runout-settlement helpers (shared by ServerTableEngine's RIT path so it
  // uses the SAME uncalled-bet / pot / rake logic as completeHand). AUDIT FIX
  // 2026-07-19: RIT previously read getPots() (empty before completeHand) and
  // distributed the FULL pot with no rake — destroying the pot and minting
  // rake. These expose the canonical pieces.
  // ─────────────────────────────────────────────────────────────────────────

  /** Return the uncalled bet to its bettor (idempotent-ish; call once). */
  public settleUncalledBet(): number {
    if (this.refuseUnlessRunout('settleUncalledBet')) return 0;
    return this.returnUncalledBet();
  }

  /** Live side pots computed from current contributions (not the cached ones). */
  public computeLivePots(): import('../types.js').Pot[] {
    return calculatePots(this.state.players);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE ONE PLACE RAKE AND THE BBJ DROP ARE PRICED (Dan 2026-08-29)
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Every settlement path — completeHand, finalizeRunout (RIT / skip-
   * distribution), and the insurance/EV pricing path — MUST call this.
   * Three hand-copied versions of this arithmetic existed and had already
   * drifted apart twice:
   *
   *   1. all three carried `potInBB >= minPotBB` on the FEE, which is the
   *      PAYOUT rule — 49% of raked hands fed the jackpot nothing until
   *      2026-08-29;
   *   2. finalizeRunout was missing the pot-overage clamp the other two had,
   *      so a small RIT pot could be charged more than it held and mint
   *      chips. Caught by the post-fix hardening sweep before it bit.
   *
   * COLLECTION RULE (Dan, verbatim): "IF THERE IS A FLOP, BBJ SHOULD BE
   * RAKED (3 OR MORE PLAYERS DEALT INTO THE HAND)... BAD BEAT JACKPOT IS
   * ONLY PAID OUT IF THERE IS MORE THEN 10 BB IN THE POT." Pot size never
   * gates the drop; BBJ_RULES.minPotBB gates detectBBJHit only.
   *
   * INVARIANT, enforced here and nowhere else: rake + bbjFee <= pot, with
   * the BBJ drop yielding first (the pot is the only source of both).
   */
  public priceDeductions(
    flopSeen: boolean,
    pot: number,
    opts: { forecast?: boolean } = {}
  ): { rake: number; bbjFee: number } {
    /* ═══ NO FLOP, NO DROP IS SETTLED BY THE BOARD, NOT BY A FLAG ══════════
       2026-08-31. `sawFlop` is a mutable flag written in five places; the
       board is the evidence. Every time the two have disagreed, the flag has
       been the wrong one — HandFuzzer has asserted
       `sawFlop === board.length >= 3` since the 2026-08-18 rake-leak fix, and
       on 2026-08-31 the rake-law alarm (migration 20260831140000) caught the
       same disagreement in production, which the fuzzer's seeded hands never
       reach: 20 live cash hands that ended PREFLOP were charged the full 10%
       (5% heads-up) of a pot no card was ever dealt to.

       They are not ambiguous. Hand 3900820, NLH 2/4 heads-up: SB posts 2, BB
       posts 4, SB folds, 2 returned — a walk, pot 4.00, raked 0.20, winner
       paid 3.80. Hand 3805102, 1/2 seven-handed: one raise, everyone folds,
       pot 5.00, raked 0.50. Board empty, no showdown, nothing to drop on.
       9.15 chips across 20 hands, taken from players who folded before the
       flop. Small money; the wrong money.

       So the flag alone no longer authorises a drop. A drop needs a board:
       three community cards in this controller's own state, or markFlopSeen()
       — the RIT path, which builds its boards outside this state and is the
       ONE legitimate way a fully-dealt hand has no board here. Anything else
       is priced as what the record shows: no flop, no drop. The disagreement
       is REPORTED rather than swallowed, because the flag going wrong is a
       real bug that still needs finding, and this refuses its money without
       hiding it.

       `forecast` is the insurance dialog pricing a runout that has not been
       dealt yet (computeRakeAndBBJ(true)). It moves no chips and must keep
       quoting what the completed hand will pay, so it is exempt. */
    const boardDealt = this.state.communityCards.length >= 3 || this.boardDealtOutsideState;
    let flopCounts = flopSeen;
    if (flopSeen && !boardDealt && !opts.forecast) {
      flopCounts = false;
      reportError(
        new Error(
          `[HandController] sawFlop was true with NO board on hand ` +
            `${this.config.handNumber} (stage ${this.state.stage}, pot ${pot}, ` +
            `${this.state.players.length} seats) - priced as no flop, no drop. ` +
            `The rake and BBJ drop were refused; the flag is what needs fixing.`
        ),
        'HandController.saw_flop_without_board'
      );
      /* And durably, where it can be READ. Sentry is where the first version
         of this sent the finding, and Sentry is not queryable from the place
         the rake-law alarm lives, so the two halves of the same incident sat
         in two systems and only one of them could be joined to a hand id.
         financial_alerts is the server's durable money-alarm table and takes
         a structured context; this is a money path refusing to pay, which is
         exactly what it is for. Fire-and-forget on the settlement hot path —
         raiseFinancialAlert never throws and never rejects (and re-escalates
         a throttled critical to Sentry by itself). */
      void raiseFinancialAlert(
        'critical',
        'HandController.saw_flop_without_board',
        `Hand ${this.config.handNumber} asked for rake on a board that does not exist - refused`,
        {
          tableId: this.config.tableId,
          handNumber: this.config.handNumber,
          stage: this.state.stage,
          pot,
          seats: this.state.players.length,
          boardLength: this.state.communityCards.length,
          board: this.state.communityCards.map((c) => `${c.rank}${c.suit}`),
          board2Length: this.state.communityCards2.length,
          gameVariant: this.config.gameVariant,
          bombPot: Boolean(this.config.bombPot),
          // The last few actions say what the hand was actually doing when the
          // flag went wrong. The live evidence is that these hands record a
          // stage of 'showdown' on ordinary preflop folds, so the stage each
          // action was taken at is the thread to pull.
          recentActions: this.state.actionHistory.slice(-6).map((a) => ({
            seat: a.seat,
            action: a.action,
            amount: a.amount,
            stage: a.stage,
          })),
        }
      );
    }

    const playerCount = this.state.players.filter((p) => !p.is_sitting_out).length;
    const rake = calculateRake(pot, flopCounts, this.config.rakeConfig, playerCount);

    let bbjFee = 0;
    const bbjCfg = this.config.bbjConfig;
    if (bbjCfg && bbjCfg.enabled && flopCounts && playerCount >= bbjCfg.minPlayersDealt) {
      bbjFee = Math.round(this.config.bigBlind * bbjCfg.feeBB * 100) / 100;
    }

    // Total deductions can never exceed the pot. BBJ yields first, then rake.
    if (rake + bbjFee > pot) {
      const overage = Math.round((rake + bbjFee - pot) * 100) / 100;
      if (overage <= bbjFee) {
        bbjFee = Math.round((bbjFee - overage) * 100) / 100;
      } else {
        bbjFee = 0;
        return { rake: Math.max(0, Math.min(rake, pot)), bbjFee: 0 };
      }
    }
    return { rake, bbjFee };
  }

  /** Rake + BBJ fee for the current pot, using the same rules as completeHand.
   *
   * PREFLOP INSURANCE FIX 2026-08-28: `assumeFlop` prices the deductions as
   * if the flop is already seen. An all-in runout ALWAYS deals to the river,
   * so a PREFLOP insurance offer priced on sawFlop=false claimed zero rake
   * and overstated "For Winning" by the full rake + BBJ drop. Default false
   * keeps every other caller (RIT settlement, etc.) exactly as before. */
  public computeRakeAndBBJ(assumeFlop: boolean = false): { rake: number; bbjFee: number } {
    // `assumeFlop` is a FORECAST of a runout that has not been dealt yet, so
    // it is exempt from the board-corroboration rule priceDeductions applies
    // to money that is actually leaving a pot.
    return this.priceDeductions(this.state.sawFlop || assumeFlop, this.state.pot, {
      forecast: assumeFlop,
    });
  }

  /** Dealer seat (for odd-chip allocation in RIT). */
  public getDealerSeat(): number {
    return this.state.dealerSeat;
  }

  /** Variant for this hand. */
  public getVariant(): import('../types.js').GameVariant {
    return this.config.gameVariant;
  }
}
