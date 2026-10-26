/**
 * HOLD'EM: PREMIUMS ARE NEVER PLAYED PASSIVELY, AND DOMINATED HANDS FOLD TO A
 * 3-BET (Dan 2026-10-25, BINDING).
 *
 * The recorded hand (2026-10-26 02:02 UTC, mystery-bounty MTT, 150/300 + BB
 * ante, about 77bb deep): a human opened KQo under the gun to 600, a horse
 * 3-bet AA to 2,746, a second horse COLD-CALLED the 3-bet with KQo, the human
 * folded, and on 9h 5s 3s 9s 6c the two horses checked every street. AA won a
 * pot it never bet into.
 *
 * Dan, verbatim:
 *   "HORSES CAN NOT EVER BE PLAYING PASSIVELY WITH PREMIUM HANDS."
 *   "THE ONE HORSE SHOULD BE FOLDING TO A HUGE THREE BET WITH KQO."
 *   "THE ACES SHOULD BE FIRING ON A SMALL FLOP AND TAKING COMMAND OF THE HAND!
 *    NEVER CHECKING IT DOWN!!"
 *   "MAKE THESE FIXES NOW FOR THE HORSE BRAIN AND UPDATE ALL 1000 HORSES"
 *
 * Measured before the fix (the 90 minutes up to 2026-10-26 02:15 UTC, NLH):
 * horses holding QQ/KK/AA saw 472 flops and fully checked down 30 of those
 * pots, and horses flat-called preflop 3-bets with KK, QQ and AK instead of
 * re-raising.
 *
 * These are rules, not equity caps: a cap is a number the next tweak moves.
 * Applied to the final decision after every other layer (HorseLogic.decide)
 * and again at commit (ServerTableEngineTurns), so no strategy owner, policy
 * pack or withdrawn selection can put the passive line back.
 *
 * Scope: no-limit hold'em, one board, cash and tournaments, every horse.
 * Omaha, short deck, pineapple and fixed limit have their own brains.
 *
 *  1. DOMINATED HANDS FOLD TO A 3-BET. Facing a real 3-bet or more preflop
 *     (the last raise at least 2.5x the level it raised), an offsuit
 *     unpaired hand other than AKo folds instead of calling or raising.
 *     A horse that has not yet put money in voluntarily (a cold caller) also
 *     folds AQo. Short stacks (20bb effective or less) are push/fold and are
 *     left to the brain, as are token prices under 15% required equity, and
 *     a 3-bet from a seat the brain reads as a maniac (Dan's maniac law:
 *     against a player who re-raises every hand, KQo is a call-off).
 *
 *  2. PREMIUMS RAISE PREFLOP, NEVER FLAT. AA and KK never limp, never check
 *     the big-blind option and never flat a raise: they raise. QQ, AKs and
 *     AKo raise over limps, a single raise and a 3-bet; over a 4-bet or more
 *     they are left to the brain. A raise is a standard size (3x plus one per
 *     caller unopened or over one raise, 2.3x over a 3-bet); only a size that
 *     reaches the horse's whole stack becomes an all-in. The tournament shove
 *     discipline still runs after this rule.
 *
 *  3. PREMIUMS KEEP BETTING POSTFLOP. When a horse with an overpair (QQ+
 *     above every board card) or AK with top pair or better is checked to,
 *     or is first to act, it bets instead of checking: half pot on the flop
 *     (two-thirds on a wet flop), two-thirds on the turn and river, all in
 *     once the bet would be 60% of its stack. Facing a bet, the brain still
 *     chooses between calling and raising. The only checks left are boards
 *     that have plainly passed the hand: four to a flush the horse does not
 *     hold, or four to a straight on the board.
 */
import type { Card, CardRank, SeatPlayer } from '../types.js';

const RANK_VALUE: Readonly<Record<CardRank, number>> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

export const HOLDEM_PREMIUM_VARIANTS: ReadonlySet<string> = new Set(['nlh']);
/** A 3-bet is "huge" (Dan) once it at least 2.5x's the level it raised. */
export const BIG_RERAISE_MULTIPLE = 2.5;
/** At or under this effective depth, preflop is push/fold: left to the brain. */
export const PUSH_FOLD_EFFECTIVE_BB = 20;
const TOKEN_CALL_REQUIRED_EQUITY = 0.15;
const POSTFLOP_JAM_STACK_SHARE = 0.6;

export type HoldemPremiumRule =
  | 'dominated_3bet_fold'
  | 'premium_preflop_raise'
  | 'premium_postflop_bet';

export interface HoldemPremiumDecision {
  action: string;
  amount?: number;
  thinkTime?: number;
}

export interface HoldemPremiumActionRecord {
  seat: number;
  userId?: string;
  action: string;
  amount: number;
  stage: string;
}

export interface HoldemPremiumInput {
  gameVariant: string | undefined;
  bettingStructure?: string;
  multiBoard: boolean;
  bombPot?: boolean;
  stage: string;
  board: Card[];
  hero: Pick<SeatPlayer, 'seat' | 'user_id' | 'cards' | 'stack' | 'bet'>;
  players: Array<
    Pick<SeatPlayer, 'seat' | 'user_id' | 'is_folded' | 'is_all_in' | 'stack' | 'bet'>
  >;
  pot: number;
  currentBet: number;
  bigBlind: number;
  toCall?: number;
  legalActions?: readonly string[];
  minRaiseTo?: number | null;
  maxRaiseTo?: number | null;
  actionHistory?: readonly HoldemPremiumActionRecord[];
  /**
   * True when the brain reads the seat that made the last preflop raise as a
   * maniac (HorseOpponentExploit). Against a player who 3-bets or shoves every
   * hand, KQo is ahead of his range: Dan's maniac law ("call off lighter")
   * keeps that spot, so the dominated-hand fold stands aside.
   */
  raiserIsManiac?: (seat: number) => boolean;
  /**
   * The table's settlement unit: 1 for tournament chips and whole Diamonds,
   * 0.01 for cash. A wager is rounded to it, or the table refuses it.
   */
  chipUnit?: number;
  /** False skips rule 1 (the commit-time recheck has no opponent reads). */
  dominatedFold?: boolean;
}

export interface HoldemPremiumVerdict<D extends HoldemPremiumDecision = HoldemPremiumDecision> {
  rule: HoldemPremiumRule;
  decision: D;
}

const rv = (c: Card | undefined): number => (c ? (RANK_VALUE[c.rank] ?? 0) : 0);
const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

interface HoleShape {
  hi: number;
  lo: number;
  pair: boolean;
  suited: boolean;
}

function holeShape(cards: Card[] | undefined): HoleShape | null {
  if (!Array.isArray(cards) || cards.length !== 2) return null;
  const a = rv(cards[0]);
  const b = rv(cards[1]);
  if (!a || !b) return null;
  return {
    hi: Math.max(a, b),
    lo: Math.min(a, b),
    pair: a === b,
    suited: cards[0].suit === cards[1].suit,
  };
}

/** AA, KK. */
export function isTopPremium(h: HoleShape): boolean {
  return h.pair && h.hi >= 13;
}

/** QQ+, AKs, AKo. */
export function isPremium(h: HoleShape): boolean {
  return (h.pair && h.hi >= 12) || (h.hi === 14 && h.lo === 13);
}

/** Offsuit, unpaired, not AKo (and not AQo unless the horse already acted). */
export function isDominatedVersus3Bet(h: HoleShape, coldCaller: boolean): boolean {
  if (h.pair || h.suited) return false;
  if (h.hi === 14 && h.lo === 13) return false; // AKo
  if (h.hi === 14 && h.lo === 12) return coldCaller; // AQo: openers may continue
  return true;
}

/**
 * Overpair QQ+ (above every board card), or AK holding top pair or better
 * (an ace on board, or a king as the board's highest card).
 */
export function isPremiumMadeHand(cards: Card[] | undefined, board: Card[]): boolean {
  const h = holeShape(cards);
  if (!h || !isPremium(h) || board.length < 3) return false;
  const boardTop = Math.max(...board.map(rv));
  if (h.pair) return h.hi > boardTop;
  return board.some((c) => c.rank === 'A') || boardTop === 13;
}

/** Four to a flush the hero holds none of, or four to a straight on board. */
export function boardHasPassedPremium(cards: Card[], board: Card[]): boolean {
  const suitCount = new Map<string, number>();
  for (const c of board) suitCount.set(c.suit, (suitCount.get(c.suit) ?? 0) + 1);
  for (const [suit, n] of suitCount) {
    if (n >= 4 && !cards.some((c) => c.suit === suit)) return true;
  }
  const ranks = new Set(board.map(rv));
  if (ranks.has(14)) ranks.add(1);
  for (let low = 1; low <= 10; low++) {
    let n = 0;
    for (let r = low; r < low + 5; r++) if (ranks.has(r)) n++;
    if (n >= 4) return true;
  }
  return false;
}

function wetFlop(board: Card[]): boolean {
  if (board.length !== 3) return false;
  const suits = new Set(board.map((c) => c.suit));
  if (suits.size <= 2) return true;
  const v = board.map(rv).sort((a, b) => a - b);
  return v[2] - v[0] <= 4;
}

interface PreflopRead {
  raises: number;
  level: number;
  previousLevel: number;
  lastRaiserSeat: number | null;
  callersSinceLastRaise: number;
  heroVoluntary: boolean;
}

function readPreflop(i: HoldemPremiumInput): PreflopRead {
  const bb = finite(i.bigBlind);
  let level = bb;
  let previousLevel = bb;
  let raises = 0;
  let lastRaiserSeat: number | null = null;
  let callersSinceLastRaise = 0;
  let heroVoluntary = false;
  for (const a of i.actionHistory ?? []) {
    if (a.stage !== 'preflop') continue;
    const act = String(a.action);
    const amount = finite(a.amount);
    const isHero = a.seat === i.hero.seat;
    if (act === 'raise' || act === 'bet' || act === 'all_in') {
      if (amount > level + 0.005) {
        previousLevel = level;
        level = amount;
        raises++;
        lastRaiserSeat = a.seat;
        callersSinceLastRaise = 0;
      } else if (act === 'all_in') {
        callersSinceLastRaise++;
      }
      if (isHero) heroVoluntary = true;
    } else if (act === 'call') {
      callersSinceLastRaise++;
      if (isHero) heroVoluntary = true;
    }
  }
  // The live state is the authority for the level the hero faces.
  const current = finite(i.currentBet);
  if (current > level + 0.005) {
    previousLevel = level;
    level = current;
  }
  return { raises, level, previousLevel, lastRaiserSeat, callersSinceLastRaise, heroVoluntary };
}

function inScope(i: HoldemPremiumInput): boolean {
  const variant = String(i.gameVariant ?? '').toLowerCase();
  if (!HOLDEM_PREMIUM_VARIANTS.has(variant)) return false;
  if (i.bettingStructure && i.bettingStructure !== 'no_limit') return false;
  if (i.multiBoard || i.bombPot) return false;
  return finite(i.bigBlind) > 0;
}

function toCallOf(i: HoldemPremiumInput): number {
  return Number.isFinite(i.toCall)
    ? Math.max(0, i.toCall as number)
    : Math.max(0, finite(i.currentBet) - finite(i.hero.bet));
}

function effectiveBB(i: HoldemPremiumInput, opponentSeat: number | null): number {
  const hero = finite(i.hero.stack) + finite(i.hero.bet);
  const live = i.players.filter((p) => p.seat !== i.hero.seat && !p.is_folded);
  const target = opponentSeat === null ? undefined : live.find((p) => p.seat === opponentSeat);
  const villain = target
    ? finite(target.stack) + finite(target.bet)
    : Math.max(0, ...live.map((p) => finite(p.stack) + finite(p.bet)));
  return Math.min(hero, villain) / finite(i.bigBlind);
}

/** A legal wager of `to` (absolute street total), or null when none is legal. */
function wager(
  i: HoldemPremiumInput,
  to: number,
  kind: 'bet' | 'raise'
): HoldemPremiumDecision | null {
  const legal = new Set(i.legalActions ?? []);
  const minTo = Number.isFinite(i.minRaiseTo) ? (i.minRaiseTo as number) : null;
  const maxTo = Number.isFinite(i.maxRaiseTo)
    ? (i.maxRaiseTo as number)
    : finite(i.hero.stack) + finite(i.hero.bet);
  const unit = i.chipUnit === 1 ? 1 : 0.01;
  const toUnit = (v: number): number => (unit === 1 ? Math.round(v) : Math.round(v * 100) / 100);
  if (legal.has(kind) && minTo !== null && maxTo >= minTo - 0.005) {
    const amount = Math.max(minTo, Math.min(maxTo, toUnit(to)));
    if (amount >= maxTo - 0.005 && legal.has('all_in')) return { action: 'all_in' };
    return { action: kind, amount };
  }
  if (legal.has('all_in') && maxTo <= to + 0.005) return { action: 'all_in' };
  return null;
}

function keepThink(
  original: HoldemPremiumDecision,
  next: HoldemPremiumDecision
): HoldemPremiumDecision {
  // Keep the brain's own think time: an override that snaps faster than the
  // action it replaced would be a tell.
  const out: HoldemPremiumDecision = { ...original, ...next };
  if (next.amount === undefined) delete out.amount;
  return out;
}

function preflopVerdict(
  decision: HoldemPremiumDecision,
  i: HoldemPremiumInput,
  h: HoleShape
): HoldemPremiumVerdict | null {
  const read = readPreflop(i);
  const toCall = toCallOf(i);
  const legal = new Set(i.legalActions ?? []);
  const bb = finite(i.bigBlind);

  // 1. Dominated hands fold to a big 3-bet.
  const raiserManiac =
    read.lastRaiserSeat !== null && i.raiserIsManiac?.(read.lastRaiserSeat) === true;
  if (
    i.dominatedFold !== false &&
    !raiserManiac &&
    read.raises >= 2 &&
    toCall > 0.005 &&
    (decision.action === 'call' || decision.action === 'raise' || decision.action === 'all_in') &&
    legal.has('fold') &&
    isDominatedVersus3Bet(h, !read.heroVoluntary) &&
    read.level >= read.previousLevel * BIG_RERAISE_MULTIPLE - 0.005 &&
    effectiveBB(i, read.lastRaiserSeat) > PUSH_FOLD_EFFECTIVE_BB
  ) {
    const pot = Math.max(0, finite(i.pot));
    if (toCall / (pot + toCall || 1) >= TOKEN_CALL_REQUIRED_EQUITY) {
      return { rule: 'dominated_3bet_fold', decision: keepThink(decision, { action: 'fold' }) };
    }
  }

  // 2. Premiums raise preflop, never flat.
  const passive = decision.action === 'call' || decision.action === 'check';
  if (!passive || !isPremium(h)) return null;
  if (!isTopPremium(h) && read.raises >= 3) return null;
  let to: number;
  if (read.raises === 0) {
    to = 3 * bb + read.callersSinceLastRaise * bb;
  } else if (read.raises === 1) {
    to = 3 * read.level + read.callersSinceLastRaise * read.level;
  } else if (read.raises === 2) {
    to = 2.3 * read.level + read.callersSinceLastRaise * read.level;
  } else {
    to = Number.POSITIVE_INFINITY; // AA/KK over a 4-bet: get it in
  }
  const next = wager(i, to, finite(i.currentBet) > 0 ? 'raise' : 'bet');
  if (!next) return null;
  return { rule: 'premium_preflop_raise', decision: keepThink(decision, next) };
}

function postflopVerdict(
  decision: HoldemPremiumDecision,
  i: HoldemPremiumInput
): HoldemPremiumVerdict | null {
  if (decision.action !== 'check') return null;
  if (toCallOf(i) > 0.005) return null;
  const cards = i.hero.cards;
  if (!isPremiumMadeHand(cards, i.board)) return null;
  if (boardHasPassedPremium(cards, i.board)) return null;
  const opponents = i.players.filter((p) => p.seat !== i.hero.seat && !p.is_folded && !p.is_all_in);
  if (opponents.length === 0) return null;
  const pot = Math.max(0, finite(i.pot));
  if (pot <= 0) return null;
  const share = i.board.length === 3 ? (wetFlop(i.board) ? 2 / 3 : 1 / 2) : 2 / 3;
  const stack = finite(i.hero.stack);
  const size = pot * share;
  const to =
    size >= stack * POSTFLOP_JAM_STACK_SHARE ? Number.POSITIVE_INFINITY : finite(i.hero.bet) + size;
  const next = wager(i, to, finite(i.currentBet) > 0 ? 'raise' : 'bet');
  if (!next) return null;
  return { rule: 'premium_postflop_bet', decision: keepThink(decision, next) };
}

/**
 * The verdict for this decision, or null when the brain's decision stands.
 * Pure: reads only its input.
 */
export function holdemPremiumAggressionVerdict<D extends HoldemPremiumDecision>(
  decision: D,
  i: HoldemPremiumInput
): HoldemPremiumVerdict<D> | null {
  if (!inScope(i)) return null;
  const h = holeShape(i.hero.cards);
  if (!h) return null;
  const stage = String(i.stage);
  let verdict: HoldemPremiumVerdict | null;
  if (stage === 'preflop') {
    if (Array.isArray(i.board) && i.board.length > 0) return null;
    verdict = preflopVerdict(decision, i, h);
  } else {
    if (stage !== 'flop' && stage !== 'turn' && stage !== 'river') return null;
    if (!Array.isArray(i.board) || i.board.length < 3) return null;
    verdict = postflopVerdict(decision, i);
  }
  return verdict as HoldemPremiumVerdict<D> | null;
}
