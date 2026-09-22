/**
 * V51 THE COMMITMENT CAP (2026-09-21). Daily audit 2026-09-20, finding P2.2:
 * "top_pair_weak_kicker_stackoff is the day's real leak ... target the
 * commitment threshold for one-pair and weak-kicker trips at 20bb-plus pots".
 *
 * WHAT WAS MEASURED (each number is a query result, none is a guess). The
 * horse_hand_reviews rows played 2026-09-14 through 2026-09-21 in the
 * hold'em family that carry a V24 stack-off tag or its _won mirror (shown
 * down, 40bb or more invested; HorseHandReview), split by whether an
 * opponent RAISED or moved ALL IN postflop in the hand:
 *
 *   | class                          | line                 | hands | won   | bb/hand |
 *   | ------------------------------ | -------------------- | ----- | ----- | ------- |
 *   | top pair, kicker nine or worse | all lines            | 1,701 | 26.2% |  -39.59 |
 *   |                                | faced raise / all-in | 1,075 | 19.7% |  -51.39 |
 *   |                                | horse raised, never  |   336 | 40.2% |  -20.37 |
 *   |                                | faced one            |       |       |         |
 *   | trips, kicker nine or worse    | all lines            |   947 | 63.1% |  +20.07 |
 *   |                                | faced raise / all-in |   536 | 55.0% |   +8.34 |
 *   |                                | horse raised, never  |   310 | 78.1% |  +41.77 |
 *   |                                | faced one            |       |       |         |
 *
 * The one-pair raise and all-in lines hold 82% of that class's loss
 * (-55,245bb of -67,349bb). The trips rows are WINNING on every line: the
 * audit asked for the class, so it is in the flag, but its ceiling is its
 * own measured win rate and its no-raise rule is the part of this flag most
 * likely to cost. The league reads the flag as a whole.
 *
 * THE CAP (HorseLogic.decidePostflop, facing a bet, only when
 * HorseDecideOpts.v51CommitCap === true - DEFAULT OFF):
 *   - WHO (commitCapClass): a hold'em-family hand (two hole cards, no-limit
 *     or pot-limit, one board, not a bomb pot) that holds
 *       one pair of its own no better than top pair with a kicker of nine or
 *       worse (top pair weak kicker, a lower pair, an underpair), or
 *       trips made with one hole card on a board pair, kicker nine or worse.
 *     A pair the board makes for everybody is not the hand's own, exactly as
 *     the V24 detectors do not count it.
 *   - WHERE: a pot of COMMIT_CAP_POT_BB big blinds or more, the pot the
 *     decision prices (the wager in front of the hand included).
 *   - NO RAISE, NO RE-RAISE, NO JAM: every raise gate (value raise,
 *     semi-bluff raise, check-raise bluff, river blocker raise) is withheld,
 *     and the committed branch calls instead of moving all in.
 *   - BOUNDED CALL-DOWN: facing an opponent's raise or all-in on the street,
 *     the equity the decision may use is capped at the class ceiling
 *     (commitCapEquity), so the hand continues only at a price below what
 *     its class actually wins on that line.
 *
 * WHAT IT NEVER TOUCHES: the nuts and every straight or better, the hand's
 * own two pair, sets, trips with a ten-or-better kicker (top-kicker trips
 * included), overpairs, top pair with a ten-or-better kicker, hands with no
 * pair of their own (draws and air), pots under 20bb, Omaha, fixed limit,
 * multi-board and bomb pots, and every decision that is not facing a bet.
 *
 * PROMOTION: the v51_commitment_cap league matchup, three separate nightly
 * runs each significant and positive (|bb100| > 2 x stderr), the rule
 * v16Ratio is held to. A local run shows only that the flag reaches code.
 */
import type { ActionRecord, Card, HandStage } from '../types.js';
import { scoreHoldem } from './HorseEval.js';
import { RANK_VALUES } from './PokerEngine.js';

/**
 * The pot, in big blinds, where the cap starts: the audit's "20bb-plus
 * pots", and FLAG_BB in HorseHandReview, the size at which a pot is reviewed
 * at all. The V24 detectors fire at twice that INVESTED.
 */
export const COMMIT_CAP_POT_BB = 20;

/** Kicker nine or worse: the V24 top-pair detector's own line for a weak kicker. */
export const COMMIT_CAP_WEAK_KICKER = 9;

/**
 * One pair's ceiling facing a raise or an all-in: the class won 212 of its
 * 1,075 showdowns on that line (19.7%).
 */
export const COMMIT_CAP_EQUITY_ONE_PAIR = 0.2;

/**
 * Weak-kicker trips' ceiling facing a raise or an all-in: the class won 295
 * of its 536 showdowns on that line (55.0%). A call is never priced above
 * 50%, so this bound binds only where a caller's margin lifts the price past
 * it; the trips half of the cap is its no-raise rule.
 */
export const COMMIT_CAP_EQUITY_TRIPS = 0.55;

export type CommitCapClass =
  | 'top_pair_weak_kicker'
  | 'lower_pair'
  | 'underpair'
  | 'weak_kicker_trips';

/** The equity ceiling a capped class may use facing a raise or an all-in. */
export function commitCapEquity(cls: CommitCapClass): number {
  return cls === 'weak_kicker_trips' ? COMMIT_CAP_EQUITY_TRIPS : COMMIT_CAP_EQUITY_ONE_PAIR;
}

/**
 * The class the cap applies to, or null. Hole cards against board ranks, the
 * way the V24 detectors read a hand: only a pair the hand makes with its own
 * cards counts, so K4 on K-J-3-J-8 is top pair with a four kicker (the
 * board's jacks belong to everybody), 55 on 7-7-2 is an underpair, and K4 on
 * K-K-3 is trips with a four kicker.
 */
export function commitCapClass(
  hole: readonly Card[],
  board: readonly Card[],
  shortDeck = false
): CommitCapClass | null {
  if (!Array.isArray(hole) || !Array.isArray(board) || hole.length !== 2 || board.length < 3) {
    return null;
  }
  const rank = (c: Card): number => RANK_VALUES[c.rank] ?? 0;
  const a = rank(hole[0]);
  const b = rank(hole[1]);
  if (a === 0 || b === 0) return null;
  const onBoard = new Map<number, number>();
  let top = 0;
  for (const c of board) {
    const r = rank(c);
    if (r === 0) return null;
    onBoard.set(r, (onBoard.get(r) ?? 0) + 1);
    if (r > top) top = r;
  }
  let cls: CommitCapClass | null;
  let wantCategory: number;
  if (a === b) {
    // A pocket pair that meets the board is a set (or quads); above the top
    // board card it is an overpair. Neither is this class.
    if (onBoard.has(a) || a > top) return null;
    cls = 'underpair';
    wantCategory = 0; // one pair, or two pair with the board's own pair
  } else {
    const pairedA = onBoard.has(a);
    const pairedB = onBoard.has(b);
    // Neither card paired: no pair of its own (a draw, or air). Both paired:
    // its own two pair or better.
    if (pairedA === pairedB) return null;
    const pair = pairedA ? a : b;
    const kicker = pairedA ? b : a;
    const onBoardN = onBoard.get(pair) ?? 0;
    if (onBoardN === 2) {
      // One hole card on a board pair: trips. Nine or worse is the weak line.
      if (kicker > COMMIT_CAP_WEAK_KICKER) return null;
      cls = 'weak_kicker_trips';
      wantCategory = 4;
    } else if (onBoardN === 1) {
      if (pair < top) cls = 'lower_pair';
      else if (kicker <= COMMIT_CAP_WEAK_KICKER) cls = 'top_pair_weak_kicker';
      else return null;
      wantCategory = 0;
    } else {
      // A card that meets board trips is quads.
      return null;
    }
  }
  // The board can still make the hand a straight, a flush or a full house;
  // then it is not this class. For one pair, category 3 is the hand's pair
  // plus the board's own pair.
  const all = [...hole, ...board];
  const category = Math.floor(scoreHoldem(all, all.length, shortDeck) / 0x100000);
  if (wantCategory === 4) return category === 4 ? cls : null;
  return category === 2 || category === 3 ? cls : null;
}

/**
 * Is the wager the hero faces on `street` a RAISE (the bet level had already
 * been set on this street) or an opponent's ALL-IN? A plain first bet is
 * neither. Amounts are read the way the engine records them: bet, raise and
 * all_in carry the level the actor went TO (HandController and the league
 * simulator both write it so), and an all-in that does not lift the level is
 * a call-off, not a wager.
 */
export function facesRaiseOrAllIn(
  history: readonly ActionRecord[] | undefined,
  street: HandStage,
  heroId: string
): boolean {
  let level = 0;
  let lifts = 0;
  let lastAllIn = false;
  let lastByOpponent = false;
  for (const a of Array.isArray(history) ? history : []) {
    if (a.stage !== street) continue;
    const amount = Number(a.amount);
    const lifted =
      a.action === 'bet' ||
      a.action === 'raise' ||
      (a.action === 'all_in' && Number.isFinite(amount) && amount > level + 1e-9);
    if (!lifted) continue;
    lifts++;
    if (Number.isFinite(amount) && amount > level) level = amount;
    lastAllIn = a.action === 'all_in';
    lastByOpponent = a.userId !== heroId;
  }
  return lastByOpponent && (lifts >= 2 || lastAllIn);
}
