/**
 * FLO8 round 4 (docs/changelog/2026-10-16-packs-do-declared-work.md): FLO8
 * has its own rule set, the fixed-limit rules without the big blind defence,
 * as pack `fixed-limit-omaha8-round4-v1`. The contract v2 FLO8 matrix (run
 * 38771868755 on 818b10c1) failed only the trust check in position big_blind
 * and profile 6max 2dealt 100bb, the cells where that rare large change lives.
 * FLH keeps the round-3 fixed-limit rules and decides exactly as before.
 */
import { describe, expect, it } from 'vitest';
import type { HorseDecision } from '../../types.js';
import {
  remainingCards,
  remainingVariantSpot,
} from '../../benchmark/RemainingVariantPolicyEvidence.js';
import { calculateContestablePot, calculatePots } from '../PokerEngine.js';
import { evaluateRemainingVariantPolicy } from './RemainingVariantLivePolicy.js';
import {
  REMAINING_VARIANT_PACKS,
  remainingVariantEntryBars,
  remainingVariantHandShape,
} from './RemainingVariantPolicyPack.js';

/** The round-3 fixed-limit rules, written out: FLH must keep them exactly. */
const FIXED_LIMIT_ROUND3 = {
  openTighten: ['middle', 'cutoff', 'button'],
  openTightenMinDealt: 3,
  headsUpOpenBelowBar: 0.15,
  smallBlindStealBelowBar: 0.2,
  bigBlindDefendBelowCallBar: 0.15,
  bigBlindDefendMaxDealt: null,
};

/**
 * Three dealt, hero (seat 1) in the big blind: the button (seat 2) raised to
 * 4 in a 2/4 fixed-limit game, the small blind (seat 3) folded, and the
 * reference folds. This is the node the round-3 defence changed.
 */
function bigBlindFacingSingleRaise(variant: 'flh' | 'flo8', holding: string) {
  const s = remainingVariantSpot(variant, 'preflop', 3);
  const [hero, button, smallBlind] = s.state.players;
  s.state.dealerSeat = 2;
  s.state.blindSeats = { smallBlind: 3, bigBlind: 1 };
  s.hero.cards = remainingCards(holding);
  for (const p of [hero, s.hero]) Object.assign(p, { bet: 2, totalInvested: 2 });
  Object.assign(button, { bet: 4, totalInvested: 4 });
  Object.assign(smallBlind, { bet: 1, totalInvested: 1, is_folded: true });
  Object.assign(s.state, {
    pot: 7,
    currentBet: 4,
    toCall: 2,
    minRaise: 2,
    lastRaise: 2,
    minRaiseTo: 6,
    maxRaiseTo: 6,
    legalActions: ['fold', 'call', 'raise'],
    actionHistory: [
      {
        userId: button.user_id,
        seat: 2,
        action: 'raise',
        amount: 4,
        stage: 'preflop',
        timestamp: 1,
        isFullRaise: true,
      },
      {
        userId: smallBlind.user_id,
        seat: 3,
        action: 'fold',
        amount: 0,
        stage: 'preflop',
        timestamp: 2,
      },
    ],
  });
  s.state.pots = calculatePots(s.state.players);
  s.state.contestablePot = calculateContestablePot(s.state.players, 'hero', 2);
  return s;
}

const fold: HorseDecision = { action: 'fold', thinkTime: 0 };

/** Whether the round-3 defence condition holds for this decision's node. */
function round3DefenceHolds(
  variant: 'flh' | 'flo8',
  holding: string,
  receipt: { position: unknown; aggressorPosition: unknown; role: unknown; depthBB: unknown }
) {
  const bars = remainingVariantEntryBars(variant, {
    position: receipt.position as never,
    aggressorPosition: receipt.aggressorPosition as never,
    role: receipt.role as never,
    seats: 3,
    depthBB: receipt.depthBB as number,
    rakePercent: 5,
    anteBB: 0,
    straddle: false,
  });
  const quality = remainingVariantHandShape(variant, remainingCards(holding), false).quality;
  return quality >= bars.call - FIXED_LIMIT_ROUND3.bigBlindDefendBelowCallBar;
}

describe('FLO8 round 4: its own rule set without the big blind defence', () => {
  it('names a new FLO8 pack version and leaves FLH on the round-3 rules, byte for byte', () => {
    expect(REMAINING_VARIANT_PACKS.flo8.version).toBe('fixed-limit-omaha8-round4-v1');
    expect(REMAINING_VARIANT_PACKS.flh.version).toBe('fixed-limit-holdem-round3-v1');
    expect(REMAINING_VARIANT_PACKS.flh.round3).toEqual(FIXED_LIMIT_ROUND3);
    expect(REMAINING_VARIANT_PACKS.flo8.round3).toEqual({
      ...FIXED_LIMIT_ROUND3,
      bigBlindDefendBelowCallBar: null,
    });
    expect(Object.isFrozen(REMAINING_VARIANT_PACKS.flo8.round3)).toBe(true);
    expect(REMAINING_VARIANT_PACKS.flo8.round3).not.toBe(REMAINING_VARIANT_PACKS.flh.round3);
  });

  const flo8Holdings = [
    'Kc Kd 3h 2s',
    'Qc Qd 3h 2s',
    'Ac 3d 9h Ts',
    '2c 3c Jh 8d',
    'Kc 2d 3h 7s',
    'Ad 8c 7h 2s',
    'Ac 2d 9h 8s',
    'Ad 3c Th 9s',
    '2c 3d 9h 9s',
    'Ah 4d Jc 9s',
  ];

  it('FLO8 keeps the reference fold at the big blind facing a single raise, including every hand round 3 defended', () => {
    let wouldHaveDefended = 0;
    for (const holding of flo8Holdings) {
      const s = bigBlindFacingSingleRaise('flo8', holding);
      const r = evaluateRemainingVariantPolicy(s.hero, s.state, fold, null, 'candidate', () => 0);
      expect(r.receipt, holding).toMatchObject({
        eligible: true,
        position: 'big_blind',
        role: 'defense',
        reason: 'round3_reference_retained',
        changed: false,
        applied: false,
      });
      expect(r.decision, holding).toEqual(fold);
      if (round3DefenceHolds('flo8', holding, r.receipt)) wouldHaveDefended++;
    }
    // The spot is the defence's own node: round 3 would have called with
    // most of these hands (measured: 8 of the 10).
    expect(wouldHaveDefended).toBeGreaterThanOrEqual(5);
  });

  it('FLH still defends exactly where the round-3 condition holds', () => {
    let defended = 0;
    for (const holding of [
      'Qc 4d',
      'Jc 3d',
      '9c 6d',
      'Th 6c',
      '8c 7d',
      'Kd 7c',
      'Ad 2c',
      'Js 8d',
    ]) {
      const s = bigBlindFacingSingleRaise('flh', holding);
      const r = evaluateRemainingVariantPolicy(s.hero, s.state, fold, null, 'candidate', () => 0);
      const holds = round3DefenceHolds('flh', holding, r.receipt);
      expect(r.receipt.reason, holding).toBe(
        holds ? 'round3_big_blind_defended' : 'round3_reference_retained'
      );
      expect(r.decision.action, holding).toBe(holds ? 'call' : 'fold');
      if (holds) defended++;
    }
    expect(defended).toBeGreaterThan(0);
  });
});
