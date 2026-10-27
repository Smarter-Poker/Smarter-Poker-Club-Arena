/**
 * A versioned adversarial workload for V53 sensitivity/paired qualification.
 * This is NOT a calibrated human population or an estimate of market profit.
 * PLO actions reuse the public rule model in HorseAggressiveHumanPressure.test-support;
 * NLH is an explicitly heuristic same-rule adaptation using its own evaluator.
 * Only the acting seat's cards and public state are read. Each physical hand
 * is warmed only through the original private public-history packet path.
 */
import type { Card, HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from '../engine/HorseLogic.js';
import { omahaQuickCategory, omahaStrongDrawShape, scoreHoldem } from '../engine/HorseEval.js';
import { RANKS } from '../engine/PokerEngine.js';
import { humanCalibratedPreflopPercentile } from './HumanCalibratedPopulation.js';
import type { Plo4AblationPopulation } from './Plo4PolicyLeague.js';

export const V53_PRESSURE_POPULATION_ID = 'v53_pressure_stress_v1';
export const V53_PRESSURE_VARIANTS = Object.freeze(['nlh', 'plo4', 'plo5', 'plo6'] as const);

function holdemDraw(hole: readonly Card[], board: readonly Card[]): boolean {
  const cards = [...hole, ...board];
  if (hole.some((h) => cards.filter((c) => c.suit === h.suit).length >= 4)) return true;
  const ranks = new Set(cards.map((c) => RANKS.indexOf(c.rank) + 2));
  if (ranks.has(14)) ranks.add(1);
  // A public four-rank straight draw must include at least one private rank.
  for (let lo = 1; lo <= 10; lo++) {
    const window = Array.from({ length: 5 }, (_, i) => lo + i);
    if (
      window.filter((r) => ranks.has(r)).length >= 4 &&
      hole.some((h) => window.includes(RANKS.indexOf(h.rank) + 2))
    )
      return true;
  }
  return false;
}

export function pressureOpponentDecision(
  player: SeatPlayer,
  gs: HorseGameStateV2,
  rng: () => number
): HorseDecision {
  if (!V53_PRESSURE_VARIANTS.includes(gs.gameVariant as never))
    throw new Error(`V53 pressure population refuses unsupported variant ${gs.gameVariant}`);
  const legal = gs.legalActions ?? [];
  const toCall = gs.toCall ?? Math.max(0, gs.currentBet - player.bet);
  const result = (action: HorseDecision['action'], amount?: number): HorseDecision => ({
    action,
    ...(amount === undefined ? {} : { amount }),
    thinkTime: 0,
  });
  const passive = () => (legal.includes('check') ? result('check') : result('fold'));
  const call = () => (legal.includes('call') ? result('call') : passive());
  const sized = (fraction: number): HorseDecision | null => {
    const wager = legal.includes('raise') ? 'raise' : legal.includes('bet') ? 'bet' : null;
    if (!wager || gs.minRaiseTo == null || gs.maxRaiseTo == null || gs.maxRaiseTo < gs.minRaiseTo)
      return null;
    const target =
      wager === 'bet' ? gs.pot * fraction : gs.currentBet + (gs.pot + toCall) * fraction;
    return result(
      wager,
      Math.round(Math.min(gs.maxRaiseTo, Math.max(gs.minRaiseTo, target)) * 100) / 100
    );
  };
  const history = gs.actionHistory ?? [];
  if (gs.stage === 'preflop') {
    const pct = humanCalibratedPreflopPercentile(player.cards, gs.gameVariant);
    const raises = history.filter(
      (a) =>
        a.stage === 'preflop' && (a.action === 'raise' || (a.action === 'all_in' && a.isFullRaise))
    ).length;
    const mine = history.some(
      (a) => a.stage === 'preflop' && a.userId === player.user_id && a.action === 'raise'
    );
    if (raises === 0) return pct >= 0.24 ? (sized(1) ?? call()) : passive();
    if (raises === 1 && !mine)
      return pct >= 0.52 ? (sized(1) ?? call()) : pct >= 0.25 ? call() : passive();
    if (mine && raises === 2) return pct >= 0.88 ? (sized(1) ?? call()) : call();
    return pct >= 0.75 ? call() : passive();
  }
  const omaha = gs.gameVariant !== 'nlh';
  const category = omaha
    ? omahaQuickCategory(player.cards, gs.communityCards)
    : Math.floor(
        scoreHoldem(
          [...player.cards, ...gs.communityCards],
          player.cards.length + gs.communityCards.length,
          false
        ) / 0x100000
      );
  const draw =
    gs.stage !== 'river' &&
    (omaha
      ? omahaStrongDrawShape(player.cards, gs.communityCards)
      : holdemDraw(player.cards, gs.communityCards));
  const opponents = gs.players.filter((p) => !p.is_folded && p.seat !== player.seat).length;
  if (toCall <= 0) {
    if (gs.stage === 'river')
      return category >= 5 || rng() < 0.12 ? (sized(0.75) ?? passive()) : passive();
    const airBet = (gs.stage === 'flop' ? 0.45 : 0.3) * (opponents >= 2 ? 0.3 : 1);
    return category >= 3 || draw || rng() < airBet ? (sized(0.78) ?? passive()) : passive();
  }
  if (gs.stage === 'river') return category >= 6 ? call() : passive();
  if (category >= 4) return sized(1) ?? call();
  return category >= 3 || (draw && opponents <= 2) ? call() : passive();
}

export const V53_PRESSURE_POPULATION: Plo4AblationPopulation = Object.freeze({
  id: V53_PRESSURE_POPULATION_ID,
  decide: pressureOpponentDecision,
});
