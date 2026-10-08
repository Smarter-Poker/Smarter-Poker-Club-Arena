/**
 * Round 3 test support (docs/horse-brain-phase12-round3-2026-10-08.md): a
 * decision state where the round-3 pack's proposal differs from the reference
 * at the HorseLogic owner. The round-3 pack keeps the reference everywhere
 * except its declared spots, so a test that needs a real change builds one of
 * them and tries a fixed list of hero holdings until the pack-off reference
 * and the shadow proposal differ. The reference is read from the pack-off
 * run, never from the code under test.
 *
 * - No limit (Short Deck, Crazy Pineapple): the flop checked to the hero,
 *   where the reference bets and the pack checks below its flop equity.
 * - Fixed limit (FLH, FLO8): heads-up first in on the button, where the
 *   reference does not open and the pack opens.
 */
import type { Card, HorseDecision } from '../../types.js';
import { remainingVariantSpot } from '../../benchmark/RemainingVariantPolicyEvidence.js';
import { calculateContestablePot, calculatePots } from '../PokerEngine.js';
import type { RemainingPolicyVariant } from './RemainingVariantPolicyPack.js';

export type Round3Spot = ReturnType<typeof remainingVariantSpot>;

const RANK_SUIT: Record<string, Card['suit']> = {
  c: 'clubs',
  d: 'diamonds',
  h: 'hearts',
  s: 'spades',
};
const cards = (text: string): Card[] =>
  text.split(' ').map((c) => ({ rank: c[0] as Card['rank'], suit: RANK_SUIT[c[1]] }));

/** Holdings tried in order. None collides with its variant's board or the
 * Pineapple spot's known discard (Qc). */
const HOLDINGS: Record<RemainingPolicyVariant, readonly string[]> = {
  short_deck: ['Ac Ah', 'Jc Th', 'Kh Td', 'Qh Jd', 'Ah Kd', 'Tc Th', 'Jh Jd', 'Ad Tc'],
  pineapple: ['Ac Ah', 'Kc Kd', 'Kd Qd', 'Jc Th', 'Ah Kc', '9c 9h', 'Tc 9c', 'Ad 7c'],
  flh: ['Qc 4d', 'Jc 3d', 'Tc 5d', '9c 6d', 'Kc 2d', 'Qh 3c', 'Jh 5c', 'Th 6c', '8c 7d'],
  flo8: [
    'Kc Kd 3h 2s',
    'Qc Qd 3h 2s',
    '2c 3d 9h 9s',
    'Ac 3d 9h Ts',
    'Ah 4d Jc 9s',
    '2c 3c Jh 8d',
    'Kc 2d 3h 7s',
    'Ac 5d Kh 9s',
    'Jc Jd 4h 2s',
    'Ac 4c Qh Td',
    '3c 4d Kh Ks',
    'Ad 8c 7h 2s',
  ],
};

/** No limit: the hero is checked to on the flop of the evidence spot. */
function checkedToFlop(variant: RemainingPolicyVariant, mode: 'cash' | 'tournament') {
  const spot = remainingVariantSpot(variant, 'flop', 2, mode);
  for (const p of spot.state.players) {
    p.bet = 0;
    p.totalInvested = 20;
  }
  spot.hero.bet = 0;
  spot.hero.totalInvested = 20;
  const s = spot.state;
  s.pot = 40;
  s.currentBet = 0;
  s.toCall = 0;
  s.minRaise = s.bigBlind;
  s.lastRaise = 0;
  // The controller's menu always offers fold, as the live worker requires.
  s.legalActions = ['fold', 'check', 'bet'];
  s.minRaiseTo = s.bigBlind;
  s.maxRaiseTo = spot.hero.stack;
  s.actionHistory = (s.actionHistory ?? []).filter((a) => a.action === 'discard');
  s.contestablePot = calculateContestablePot(s.players, 'hero', 0);
  s.pots = calculatePots(s.players);
  if (s.tournament) {
    s.tournament.stacks = s.players.map((p) => p.stack + p.totalInvested);
    s.tournament.stackByUser = Object.fromEntries(
      s.players.map((p) => [p.user_id, p.stack + p.totalInvested])
    );
  }
  spot.baseline = { action: 'check', thinkTime: 0 } as HorseDecision;
  return spot;
}

function round3Base(variant: RemainingPolicyVariant, mode: 'cash' | 'tournament') {
  return variant === 'flh' || variant === 'flo8'
    ? remainingVariantSpot(variant, 'preflop', 2, mode)
    : checkedToFlop(variant, mode);
}

/** The street of the declared spot for `variant`. */
export function round3ChangedStreet(variant: RemainingPolicyVariant) {
  return variant === 'flh' || variant === 'flo8' ? ('preflop' as const) : ('flop' as const);
}

/** One factory per fixed holding, in order, each making a fresh copy of the
 * declared spot for `variant` (for callers whose check is asynchronous). */
export function round3SpotFactories(
  variant: RemainingPolicyVariant,
  mode: 'cash' | 'tournament'
): ReadonlyArray<() => Round3Spot> {
  return HOLDINGS[variant].map((holding) => () => {
    const spot = round3Base(variant, mode);
    spot.hero.cards = cards(holding);
    return spot;
  });
}

/**
 * A factory for a fresh copy of the first declared spot, over the fixed
 * holdings, where `changed(spot)` holds; throws if none does.
 */
export function round3ChangedSpot(
  variant: RemainingPolicyVariant,
  mode: 'cash' | 'tournament',
  changed: (spot: Round3Spot) => boolean
): () => Round3Spot {
  for (const make of round3SpotFactories(variant, mode)) if (changed(make())) return make;
  throw new Error(`no round-3 ${variant} ${mode} spot changes the reference`);
}
