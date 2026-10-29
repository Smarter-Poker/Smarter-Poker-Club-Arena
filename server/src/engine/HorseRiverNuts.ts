import type { Card, HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from './HorseLogic.js';
import { RANKS, SUITS } from './PokerEngine.js';
import { scoreHoldem, scoreOmahaHi, scoreOmahaLow, variantInfo } from './HorseEval.js';
import { horsePolicyRegistration } from './HorsePolicyRegistry.js';
import { fixedLimitStreetBounds } from './BettingStructure.js';

const key = (c: Card) => `${c.rank}:${c.suit}`;
const valid = (c: Card) => c && RANKS.includes(c.rank) && SUITS.includes(c.suit);

/** Exact public-information nuts, never sampled equity or opponents' cards.
 * An opponent's best Omaha hand always uses a pair, so enumerating unseen
 * pairs is exhaustive for four, five and six hole cards alike. For hi/lo,
 * require the nuts on BOTH halves whenever any qualifying low is possible;
 * for multiple boards, require them on every board. A nut low alone or a
 * nut hand on only one board is not a license to escalate the entire pot.
 */
export function hasRiverNuts(
  hero: SeatPlayer,
  state: HorseGameStateV2,
  requirePrivateValue = false
): boolean {
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
  // An unbeatable shared board guarantees a tie, not a value raise. Keep
  // the mathematical nuts result for callers; forced value requires a hole
  // card improving at least one board. Omaha must use two holes already.
  if (
    requirePrivateValue &&
    !rules.isOmaha &&
    boards.every(
      (board) =>
        scoreHoldem([...hero.cards, ...board], 7, rules.isShortDeck) ===
        scoreHoldem(board, 5, rules.isShortDeck)
    )
  )
    return false;
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

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The size a river nut wager should be (Dan 2026-10-23: never under-size the
 * nuts). Pot limit and fixed limit: the controller's maximum, which is the
 * full pot (or the fixed size). No limit: at least a full pot, up to the
 * maximum; a larger policy size is kept by the caller. The controller menu,
 * hero's stack and any host cap (already folded into maxRaiseTo) bound it.
 */
export function riverNutWagerTarget(
  action: 'bet' | 'raise',
  hero: SeatPlayer,
  state: HorseGameStateV2
): number | null {
  const min = state.minRaiseTo;
  const max = state.maxRaiseTo;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max! < min!) return null;
  if (max! > hero.bet + hero.stack + 0.005) return null;
  if (action === 'raise' && min! <= state.currentBet) return null;
  const vi = variantInfo(state.gameVariant ?? 'nlh');
  const structure =
    state.bettingStructure ??
    (vi.isFixedLimit ? 'fixed_limit' : vi.isPotLimit ? 'pot_limit' : 'no_limit');
  if (structure !== 'no_limit') return round2(max!);
  if (!Number.isFinite(state.pot) || state.pot < 0) return null;
  const base = action === 'bet' ? 0 : state.currentBet;
  const potTarget = base + state.pot + (action === 'raise' ? state.toCall! : 0);
  return round2(Math.min(max!, Math.max(min!, potTarget)));
}

/** Final strategy invariant, after every variant/joint/tournament owner.
 * Includes closing calls out of position and multiway nut-flush calls
 * with another responder still behind (production hand 44867615).
 * Only the controller's immutable menu may grant reopening or a short raise.
 *
 * 2026-10-23 extension: with the exact river nuts and an opponent still able
 * to act, a horse never checks (it bets), and a nut bet or raise is never
 * smaller than riverNutWagerTarget (production hand 45000112 raised to 92 of a
 * legal 113 in pot limit).
 */
export function riverNutsRaise(
  decision: HorseDecision,
  hero: SeatPlayer,
  state: HorseGameStateV2
): HorseDecision {
  const act = decision.action;
  if (act !== 'call' && act !== 'fold' && act !== 'check' && act !== 'bet' && act !== 'raise')
    return decision;
  if (
    state.stage !== 'river' ||
    state.wagersCapped === true ||
    state.stateSchemaVersion !== 1 ||
    !Array.isArray(state.legalActions) ||
    !Number.isFinite(state.toCall) ||
    state.toCall! < 0 ||
    !Number.isFinite(state.currentBet) ||
    !Number.isFinite(hero.stack) ||
    !Number.isFinite(hero.bet) ||
    hero.stack <= 0 ||
    hero.is_folded ||
    hero.is_all_in ||
    hero.is_sitting_out
  )
    return decision;
  const opponents = state.players.filter(
    (p) => p.seat !== hero.seat && !p.is_folded && !p.is_sitting_out
  );
  if (!opponents.some((p) => !p.is_all_in && p.stack > 0)) return decision;
  const facing = state.toCall! > 0;

  if (!facing) {
    // Checked to, or first to act: the nuts bet (never check) and are never under-sized.
    if (act !== 'check' && act !== 'bet') return decision;
    if (!state.legalActions.includes('bet')) return decision;
    const target = riverNutWagerTarget('bet', hero, state);
    if (target === null) return decision;
    if (act === 'bet' && Number.isFinite(decision.amount) && decision.amount! >= target - 0.005)
      return decision;
    if (!hasRiverNuts(hero, state, true)) return decision;
    return { ...decision, action: 'bet', amount: target };
  }

  if (act === 'raise') {
    if (!state.legalActions.includes('raise') || !Number.isFinite(decision.amount)) return decision;
    const target = riverNutWagerTarget('raise', hero, state);
    if (target === null || decision.amount! >= target - 0.005) return decision;
    if (!hasRiverNuts(hero, state, true)) return decision;
    return { ...decision, amount: target };
  }
  if (act !== 'call' && act !== 'fold') return decision;
  if (hero.stack <= state.toCall!) return decision;
  const min = state.minRaiseTo;
  const max = state.maxRaiseTo;
  // Fixed limit also advertises all_in when its structure clamp would only
  // call (for example, action was not reopened). Null bounds authorize a
  // short raise only below the actual full-raise/completion target.
  const fixedLimit = variantInfo(state.gameVariant ?? 'nlh').isFixedLimit;
  const shortFixedRaise =
    fixedLimit && Number.isFinite(state.fixedBetSize) && Array.isArray(state.actionHistory)
      ? hero.bet + hero.stack <
        state.currentBet +
          fixedLimitStreetBounds(
            state.actionHistory,
            state.stage,
            state.fixedBetSize!,
            state.currentBet
          ).raiseSize -
          0.005
      : false;
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
      amount: round2(max!),
      thinkTime: decision.thinkTime,
    };
  } else if (
    state.legalActions.includes('all_in') &&
    hero.bet + hero.stack > state.currentBet &&
    // HandController deliberately reports null bounds when only a short
    // all-in is available. Its explicit all_in menu entry is the authority.
    ((max === null && (!fixedLimit || shortFixedRaise)) ||
      (Number.isFinite(max) && hero.bet + hero.stack <= max! + 0.005))
  ) {
    raise = { action: 'all_in', thinkTime: decision.thinkTime };
  }
  if (!raise || !hasRiverNuts(hero, state, true)) return decision;
  return { ...decision, ...raise, amount: raise.amount };
}

/** Betting amounts are street totals. A pot raise adds the pot AFTER calling
 * to the outstanding bet. Only round 90-100%; preserve deliberate overbets.
 * The controller menu, stack and host cap must all permit the full target.
 */
export function fullPotNearPotWager(
  decision: HorseDecision,
  hero: SeatPlayer,
  state: HorseGameStateV2
): HorseDecision {
  if (
    (decision.action !== 'bet' && decision.action !== 'raise') ||
    state.stateSchemaVersion !== 1 ||
    !Array.isArray(state.legalActions) ||
    !state.legalActions.includes(decision.action) ||
    state.wagersCapped === true ||
    variantInfo(state.gameVariant ?? 'nlh').isFixedLimit ||
    state.bettingStructure === 'fixed_limit' ||
    !Number.isFinite(decision.amount) ||
    !Number.isFinite(state.pot) ||
    state.pot <= 0 ||
    !Number.isFinite(state.currentBet) ||
    !Number.isFinite(state.toCall) ||
    state.toCall! < 0 ||
    !Number.isFinite(state.minRaiseTo) ||
    !Number.isFinite(state.maxRaiseTo) ||
    !Number.isFinite(hero.stack) ||
    !Number.isFinite(hero.bet)
  )
    return decision;
  const base = decision.action === 'bet' ? 0 : state.currentBet;
  const potIncrement = state.pot + (decision.action === 'raise' ? state.toCall! : 0);
  const increment = decision.amount! - base;
  const target = Math.round((base + potIncrement) * 100) / 100;
  if (
    increment < potIncrement * 0.9 - 0.000001 ||
    increment > potIncrement + 0.000001 ||
    target < state.minRaiseTo! ||
    target > state.maxRaiseTo! + 0.000001 ||
    target > hero.bet + hero.stack + 0.000001 ||
    target === decision.amount
  )
    return decision;
  // The final pot snap must keep the same canonical form the legalizer priced.
  // A full physical stack is an all-in only when the authoritative menu permits it.
  if (
    target === Math.round((hero.bet + hero.stack) * 100) / 100 &&
    state.legalActions.includes('all_in')
  )
    return { ...decision, action: 'all_in', amount: undefined };
  return { ...decision, amount: target };
}
