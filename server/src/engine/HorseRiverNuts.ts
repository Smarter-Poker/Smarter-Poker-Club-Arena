import type { Card, HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from './HorseLogic.js';
import { RANKS, SUITS } from './PokerEngine.js';
import { scoreHoldem, scoreOmahaHi, scoreOmahaLow, variantInfo } from './HorseEval.js';
import { horsePolicyRegistration } from './HorsePolicyRegistry.js';

const key = (c: Card) => `${c.rank}:${c.suit}`;
const valid = (c: Card) => c && RANKS.includes(c.rank) && SUITS.includes(c.suit);

/** Exact public-information nuts, never sampled equity or opponents' cards.
 * An opponent's best Omaha hand always uses a pair, so enumerating unseen
 * pairs is exhaustive for four, five and six hole cards alike. For hi/lo,
 * require the nuts on BOTH halves whenever any qualifying low is possible;
 * for multiple boards, require them on every board. A nut low alone or a
 * nut hand on only one board is not a license to escalate the entire pot.
 */
export function hasRiverNuts(hero: SeatPlayer, state: HorseGameStateV2): boolean {
  if (state.stage !== 'river' || !horsePolicyRegistration(state.gameVariant)) return false;
  const rules = variantInfo(state.gameVariant!);
  const expectedHole = rules.isOmaha ? rules.holeCount : 2;
  if (!Array.isArray(hero.cards) || hero.cards.length !== expectedHole) return false;
  const boards = [state.communityCards, state.communityCards2, state.communityCards3].filter(
    (b): b is Card[] => Array.isArray(b) && b.length > 0
  );
  if (!boards.length || boards.some((b) => b.length !== 5)) return false;
  if (state.boardCount !== undefined && state.boardCount !== boards.length) return false;
  const dead = hero.knownDeadCards ?? [];
  const known = [...hero.cards, ...boards.flat(), ...dead];
  if (known.some((c) => !valid(c) || (rules.isShortDeck && ['2', '3', '4', '5'].includes(c.rank))))
    return false;
  const held = new Set(hero.cards.map(key));
  if (held.size !== hero.cards.length || dead.some((c) => held.has(key(c)))) return false;
  for (const board of boards) {
    if (new Set(board.map(key)).size !== 5 || board.some((c) => held.has(key(c)))) return false;
  }
  const removed = new Set(known.map(key));
  const unseen: Card[] = [];
  for (const suit of SUITS)
    for (const rank of RANKS) {
      if (rules.isShortDeck && ['2', '3', '4', '5'].includes(rank)) continue;
      const card = { rank, suit };
      if (!removed.has(key(card))) unseen.push(card);
    }
  for (const board of boards) {
    const high = (hole: Card[]) =>
      rules.isOmaha
        ? scoreOmahaHi(hole, board)
        : scoreHoldem([...hole, ...board], 7, rules.isShortDeck);
    const heroHigh = high(hero.cards);
    const heroLow = rules.isHiLo ? scoreOmahaLow(hero.cards, board) : Infinity;
    for (let i = 0; i < unseen.length; i++)
      for (let j = i + 1; j < unseen.length; j++) {
        const pair = [unseen[i], unseen[j]];
        if (high(pair) > heroHigh) return false;
        if (rules.isHiLo) {
          const low = scoreOmahaLow(pair, board);
          if (Number.isFinite(low) && (!Number.isFinite(heroLow) || low < heroLow)) return false;
        }
      }
  }
  return true;
}

/** Final strategy invariant, after every variant/joint/tournament owner.
 * Matching the outstanding bet means an opponent has already answered it;
 * thus this also catches a check/call closing the action out of position.
 * Only the controller's immutable menu may grant reopening or a short raise.
 */
export function riverNutsRaise(
  decision: HorseDecision,
  hero: SeatPlayer,
  state: HorseGameStateV2
): HorseDecision {
  // Preserve an already selected wager and its sizing. This rule repairs a
  // passive decision; it does not replace sound value-raise sizing.
  if (decision.action !== 'call' && decision.action !== 'fold') return decision;
  if (
    state.stage !== 'river' ||
    state.stateSchemaVersion !== 1 ||
    !Array.isArray(state.legalActions) ||
    !Number.isFinite(state.toCall) ||
    state.toCall! <= 0 ||
    !Number.isFinite(state.currentBet) ||
    !Number.isFinite(hero.stack) ||
    hero.stack <= state.toCall! ||
    hero.is_folded ||
    hero.is_all_in ||
    hero.is_sitting_out
  )
    return decision;
  const opponents = state.players.filter(
    (p) => p.seat !== hero.seat && !p.is_folded && !p.is_sitting_out
  );
  if (
    !opponents.some((p) => !p.is_all_in && p.stack > 0) ||
    opponents.some((p) => !p.is_all_in && p.stack > 0 && p.bet < state.currentBet)
  )
    return decision;
  const min = state.minRaiseTo;
  const max = state.maxRaiseTo;
  let raise: HorseDecision | null = null;
  if (
    state.legalActions.includes('raise') &&
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    min! > state.currentBet &&
    max! >= min! &&
    max! <= hero.bet + hero.stack + 0.005
  ) {
    raise = {
      action: 'raise',
      amount: Math.round(max! * 100) / 100,
      thinkTime: decision.thinkTime,
    };
  } else if (
    state.legalActions.includes('all_in') &&
    hero.bet + hero.stack > state.currentBet &&
    // HandController deliberately reports null bounds when only a short
    // all-in is available. Its explicit all_in menu entry is the authority.
    (max === null || (Number.isFinite(max) && hero.bet + hero.stack <= max! + 0.005))
  ) {
    raise = { action: 'all_in', thinkTime: decision.thinkTime };
  }
  if (!raise || !hasRiverNuts(hero, state)) return decision;
  return { ...decision, ...raise, amount: raise.amount };
}
