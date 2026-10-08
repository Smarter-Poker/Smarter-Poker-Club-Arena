import { describe, expect, it } from 'vitest';
import type { Card } from '../types.js';
import { RANKS, SUITS } from '../engine/PokerEngine.js';
import { seedFastRandom } from '../engine/HorseEval.js';
import { isPlo4HoldoutSeed } from './Plo4StrengthContract.js';
import { isOmahaVariantHoldoutSeed } from './OmahaVariantStrengthContract.js';
import { isRemainingVariantHoldoutSeed } from './RemainingVariantStrengthContract.js';
import { isJointHoldoutSeed } from './JointStrengthContract.js';
import { TOURNAMENT_PROMOTION_SEEDS } from './HorseTournamentLeague.js';
import {
  HUMAN_CALIBRATED_CHECK_SEED_BASE,
  HUMAN_CALIBRATED_FIT_SEED_BASE,
  HUMAN_CALIBRATED_FITTED_NODES,
  HUMAN_CALIBRATED_HOLDOUT_SEEDS,
  HUMAN_CALIBRATED_MAX_FIT_ITERATIONS,
  blendHumanCalibratedCutoffs,
  fitHumanCalibratedCutoffs,
  histogramQuantile,
  isHumanCalibratedHoldoutSeed,
  HUMAN_CALIBRATED_POPULATION_ID,
  HUMAN_CALIBRATED_PROFILES,
  HUMAN_CALIBRATION_SOURCE,
  humanCalibratedDecide,
  humanCalibratedFamily,
  humanCalibratedPreflopPercentile,
  humanCalibrationAdequacy,
  thresholdResponse,
  type HumanCalibratedSpot,
} from './HumanCalibratedPopulation.js';
import {
  PLO4_LEAGUE_PROFILES,
  playPlo4PolicyHand,
  plo4StrengthLeagueProfile,
  withHumanCalibratedOpponents,
} from './Plo4PolicyLeague.js';
import { jointStrengthLeagueProfile } from './JointStrengthLeague.js';
import { remainingVariantStrengthLeagueProfile } from './RemainingVariantStrengthLeague.js';

const deck = (): Card[] => RANKS.flatMap((rank) => SUITS.map((suit) => ({ rank, suit })));
const c = (s: string): Card => ({
  rank: s[0] as Card['rank'],
  suit: ({ h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' } as const)[
    s[1] as 'h' | 'd' | 'c' | 's'
  ],
});

describe('human-calibrated opponent population (WIN-POP)', () => {
  it('records counts that add up to the measured sample, with no timeout share in play', () => {
    expect(HUMAN_CALIBRATED_PROFILES.map((p) => p.family)).toEqual(['nlh', 'omaha', 'other']);
    expect(HUMAN_CALIBRATED_PROFILES.reduce((n, p) => n + p.seatHands, 0)).toBe(
      HUMAN_CALIBRATION_SOURCE.humanSeatHands
    );
    for (const p of HUMAN_CALIBRATED_PROFILES) {
      const all = [
        p.preflop.unopened,
        p.preflop.facingRaise,
        ...(['flop', 'turn', 'river'] as const).map((s) => p.postflop[s].facingBet),
      ];
      for (const r of all) {
        expect(r.fold + r.call + r.raise).toBeCloseTo(1, 12);
        expect(r.n).toBeGreaterThan(0);
      }
      expect(JSON.stringify(p)).not.toMatch(/timeout/i);
    }
  });

  it('is not an adequate calibration for a qualifying claim yet, and says why', () => {
    for (const p of HUMAN_CALIBRATED_PROFILES) {
      const a = humanCalibrationAdequacy(p);
      expect(a.adequate).toBe(false);
      expect(a.reasons).toContain('distinct_humans_5_below_20');
      expect(a.reasons.some((r) => r.startsWith('seat_hands_'))).toBe(true);
    }
    const enough = { ...HUMAN_CALIBRATED_PROFILES[0], seatHands: 10_000 };
    expect(humanCalibrationAdequacy(enough, { distinctHumans: 20, topHumanShare: 0.25 })).toEqual({
      family: 'nlh',
      adequate: true,
      reasons: [],
    });
  });

  it('maps every variant to its measured family', () => {
    expect(humanCalibratedFamily('nlh')).toBe('nlh');
    for (const v of ['plo4', 'plo5', 'plo6', 'plo8'])
      expect(humanCalibratedFamily(v)).toBe('omaha');
    for (const v of ['short_deck', 'pineapple', 'flh', 'flo8'])
      expect(humanCalibratedFamily(v)).toBe('other');
  });

  it('ranks preflop holdings as percentiles in [0, 1)', () => {
    const aces = humanCalibratedPreflopPercentile([c('Ah'), c('As')], 'nlh');
    const trash = humanCalibratedPreflopPercentile([c('7h'), c('2c')], 'nlh');
    expect(aces).toBeGreaterThan(0.99);
    expect(aces).toBeLessThan(1);
    expect(trash).toBeLessThan(0.1);
    const plo = humanCalibratedPreflopPercentile([c('Ah'), c('Ad'), c('Kh'), c('Kd')], 'plo4');
    expect(plo).toBeGreaterThan(0.95);
    expect(
      humanCalibratedPreflopPercentile([c('Ah'), c('As'), c('Kd')], 'pineapple')
    ).toBeGreaterThan(0.9);
  });

  it("reproduces the measured preflop frequencies over every hold'em holding", () => {
    const d = deck();
    const p = HUMAN_CALIBRATED_PROFILES[0];
    const counts = { fold: 0, call: 0, raise: 0 };
    let n = 0;
    for (let i = 0; i < d.length; i++)
      for (let j = i + 1; j < d.length; j++) {
        counts[
          thresholdResponse(
            humanCalibratedPreflopPercentile([d[i], d[j]], 'nlh'),
            p.preflop.facingRaise
          )
        ]++;
        n++;
      }
    // Ties in the hand-tuned score put whole classes on one side of a threshold.
    expect(Math.abs(counts.fold / n - p.preflop.facingRaise.fold)).toBeLessThan(0.05);
    expect(Math.abs(counts.raise / n - p.preflop.facingRaise.raise)).toBeLessThan(0.05);
  });

  it('returns only legal actions and sizes inside the legal interval', () => {
    const base: HumanCalibratedSpot = {
      variant: 'nlh',
      stage: 'flop',
      cards: [c('Ah'), c('Kh')],
      board: [c('Qh'), c('Jh'), c('2c')],
      pot: 30,
      toCall: 10,
      currentBet: 10,
      aggressionThisStreet: true,
      legalActions: ['fold', 'call', 'raise', 'all_in'],
      minRaiseTo: 20,
      maxRaiseTo: 190,
      wholeChips: true,
    };
    seedFastRandom(14001101);
    const strong = humanCalibratedDecide(base);
    expect(base.legalActions).toContain(strong.action);
    if (strong.action === 'raise') {
      expect(Number.isInteger(strong.amount)).toBe(true);
      expect(strong.amount).toBeGreaterThanOrEqual(20);
      expect(strong.amount).toBeLessThanOrEqual(190);
    }
    const free = humanCalibratedDecide({
      ...base,
      cards: [c('7d'), c('2s')],
      board: [c('Kc'), c('9h'), c('4d')],
      toCall: 0,
      currentBet: 0,
      aggressionThisStreet: false,
      legalActions: ['check', 'bet', 'all_in'],
      minRaiseTo: 2,
      maxRaiseTo: 190,
    });
    expect(free.action).toBe('check');
    const shortStack = humanCalibratedDecide({
      ...base,
      legalActions: ['fold', 'all_in'],
      minRaiseTo: null,
      maxRaiseTo: null,
    });
    expect(['fold', 'all_in']).toContain(shortStack.action);
  });

  it('replays a postflop decision exactly from the same random state', () => {
    const spot: HumanCalibratedSpot = {
      variant: 'plo4',
      stage: 'turn',
      cards: [c('Ah'), c('Kd'), c('Qs'), c('Jc')],
      board: [c('Th'), c('9d'), c('2c'), c('3s')],
      pot: 40,
      toCall: 20,
      currentBet: 20,
      aggressionThisStreet: true,
      legalActions: ['fold', 'call', 'raise'],
      minRaiseTo: 40,
      maxRaiseTo: 100,
      wholeChips: false,
    };
    seedFastRandom(14001102);
    const a = humanCalibratedDecide(spot);
    seedFastRandom(14001102);
    expect(humanCalibratedDecide(spot)).toEqual(a);
  });

  it('is a new, separately named league profile and leaves the source profile unchanged', () => {
    const source = PLO4_LEAGUE_PROFILES.find((p) => p.id === 'six-max-100bb')!;
    const before = JSON.stringify(source);
    const human = withHumanCalibratedOpponents(source);
    expect(human.id).toBe(`six-max-100bb--${HUMAN_CALIBRATED_POPULATION_ID}`);
    expect(human.opponentPopulation).toBe(HUMAN_CALIBRATED_POPULATION_ID);
    expect(JSON.stringify(source)).toBe(before);
    expect(PLO4_LEAGUE_PROFILES.some((p) => 'opponentPopulation' in p)).toBe(false);
    expect(() => withHumanCalibratedOpponents(human)).toThrow();
  });

  it.each([
    ['plo4', () => plo4StrengthLeagueProfile('p10c-6max-100bb')],
    ['nlh', () => jointStrengthLeagueProfile('nlh', 'p13c-nlh-6max-100bb')],
    [
      'short_deck',
      () => remainingVariantStrengthLeagueProfile('short_deck', 'p12c-short_deck-6max-100bb'),
    ],
  ])(
    '%s: the human-calibrated table plays legal, conserved, repeatable hands that differ from the horse table',
    async (_variant, make) => {
      const horses = make();
      const humans = withHumanCalibratedOpponents(horses);
      let differs = 0;
      for (let k = 0; k < 6; k++) {
        const seed = 14001200 + k;
        const a = await playPlo4PolicyHand(humans, seed, 1, 3, 'off');
        const again = await playPlo4PolicyHand(humans, seed, 1, 3, 'off');
        const h = await playPlo4PolicyHand(horses, seed, 1, 3, 'off');
        expect(a.complete).toBe(true);
        expect(a.illegalActions + a.conservationErrors + a.cardErrors + a.truncated).toBe(0);
        expect(a.net.reduce((s, n) => s + n, 0) + a.rake + a.bbj).toBeCloseTo(0, 8);
        expect(again).toEqual(a);
        expect(Object.keys(a.humanCalibrated ?? {}).length).toBeGreaterThan(0);
        expect(h.humanCalibrated).toBeUndefined();
        if (JSON.stringify(a.net) !== JSON.stringify(h.net) || a.decisions !== h.decisions)
          differs++;
      }
      expect(differs).toBeGreaterThan(0);
    }
  );

  it('carries fitted cutoffs for every node, fold below raise', () => {
    for (const p of HUMAN_CALIBRATED_PROFILES)
      for (const node of HUMAN_CALIBRATED_FITTED_NODES) {
        const c = p.cutoffs?.[node];
        expect(c, `${p.id} ${node}`).toBeDefined();
        if (node.endsWith('checked_to')) {
          expect(c!.bet).toBeGreaterThan(0);
          expect(c!.bet).toBeLessThanOrEqual(1);
        } else expect(c!.fold!).toBeLessThanOrEqual(c!.raise!);
      }
  });

  it('fits cutoffs as quantiles of the strengths that reach a node', () => {
    const uniform = Array<number>(50).fill(10);
    expect(histogramQuantile(uniform, 0.5)).toBeCloseTo(0.5, 6);
    const p = { ...HUMAN_CALIBRATED_PROFILES[0], cutoffs: {} };
    const fitted = fitHumanCalibratedCutoffs(p, { 'flop/facing_bet': uniform });
    expect(fitted['flop/facing_bet']!.fold).toBeCloseTo(p.postflop.flop.facingBet.fold, 3);
    expect(fitted['flop/facing_bet']!.raise).toBeCloseTo(1 - p.postflop.flop.facingBet.raise, 3);
    expect(fitted['turn/facing_bet']).toBeUndefined();
    const sparse = fitHumanCalibratedCutoffs(p, { 'flop/facing_bet': Array<number>(50).fill(1) });
    expect(sparse['flop/facing_bet']).toBeUndefined();
    const half = blendHumanCalibratedCutoffs(
      { 'flop/facing_bet': { fold: 0.2, raise: 0.8 } },
      { 'flop/facing_bet': { fold: 0.4, raise: 0.9 } },
      0.5
    );
    expect(half['flop/facing_bet']).toEqual({ fold: 0.3, raise: 0.85 });
  });

  it('keeps its held-out seeds apart from every other contract and from its own fitting seeds', () => {
    const fitMax =
      HUMAN_CALIBRATED_FIT_SEED_BASE + HUMAN_CALIBRATED_MAX_FIT_ITERATIONS * 100_000 + 99_999;
    expect(HUMAN_CALIBRATED_CHECK_SEED_BASE).toBeGreaterThan(fitMax);
    for (const s of HUMAN_CALIBRATED_HOLDOUT_SEEDS) {
      expect(isHumanCalibratedHoldoutSeed(s)).toBe(true);
      expect(
        isPlo4HoldoutSeed(s) ||
          isOmahaVariantHoldoutSeed(s) ||
          isRemainingVariantHoldoutSeed(s) ||
          isJointHoldoutSeed(s)
      ).toBe(false);
      expect(TOURNAMENT_PROMOTION_SEEDS as readonly number[]).not.toContain(s);
      expect(s).toBeGreaterThan(HUMAN_CALIBRATED_CHECK_SEED_BASE + 99_999);
    }
  });
});
