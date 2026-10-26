import { describe, expect, it, vi } from 'vitest';
import { HorseLogic } from '../engine/HorseLogic.js';
import {
  OMAHA_STRESS_OPPONENTS,
  omahaStressOpponent,
  runOmahaAdversarialStress,
  validateOmahaStressRequest,
  type OmahaStressRequest,
} from './OmahaAdversarialStress.js';
import { PLO4_STRENGTH_CONTRACT } from './Plo4StrengthContract.js';
import { HUMAN_CALIBRATED_PROFILES } from './HumanCalibratedPopulation.js';
import { spawnSync } from 'node:child_process';

const request = (): OmahaStressRequest => ({
  variant: 'plo4',
  opponent: 'caller',
  hands: 1,
  seed: 10001,
  seats: 2,
  stackBB: 25,
});

describe('explicit synthetic Omaha stress', () => {
  it('retains validated inputs when the caller mutates its request during a hand', async () => {
    const input = { ...request(), hands: 2 };
    const original = { ...input };
    const decide = HorseLogic.decide.bind(HorseLogic);
    const spy = vi.spyOn(HorseLogic, 'decide').mockImplementation((...args) => {
      input.seed = PLO4_STRENGTH_CONTRACT.holdout.seeds[0];
      input.hands = 0;
      input.stackBB = 200;
      return decide(...args);
    });
    try {
      const out = await runOmahaAdversarialStress(input);
      expect(out.request).toEqual(original);
      expect(out.completedHands).toBe(2);
      expect(Number.isFinite(out.heroBb100)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
  it('carries the actual non-horse roster into the real brain, with no foreign cards', async () => {
    const decide = HorseLogic.decide.bind(HorseLogic);
    let calls = 0;
    const spy = vi.spyOn(HorseLogic, 'decide').mockImplementation((hero, state, ...rest) => {
      calls++;
      expect(state.humanUserIds?.slice().sort()).toEqual(
        state.players
          .filter((p) => p.is_horse === false)
          .map((p) => p.user_id)
          .sort()
      );
      expect(state.humanUserIds).not.toContain(hero.user_id);
      expect(state.players.every((p) => p.cards.length === 0)).toBe(true);
      return decide(hero, state, ...rest);
    });
    try {
      await runOmahaAdversarialStress({ ...request(), hands: 6, seats: 6 });
      expect(calls).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
  it('never represents synthetic extremes as observed human evidence', () => {
    const before = structuredClone(HUMAN_CALIBRATED_PROFILES);
    for (const name of OMAHA_STRESS_OPPONENTS) {
      const p = omahaStressOpponent(name);
      expect(p.id).toMatch(/^synthetic-omaha-stress-v1-/);
      expect(p.seatHands).toBe(0);
      expect(p.cutoffs).toBeUndefined();
      for (const r of [
        p.preflop.unopened,
        p.preflop.facingRaise,
        ...Object.values(p.postflop).map((s) => s.facingBet),
      ]) {
        expect(r.fold + r.call + r.raise).toBeCloseTo(1, 12);
        expect(r.n).toBe(0);
        expect(Math.min(r.fold, r.call, r.raise)).toBeGreaterThanOrEqual(0);
      }
      p.preflop.unopened.fold = 100;
      expect(omahaStressOpponent(name).preflop.unopened.fold).toBeLessThanOrEqual(1);
    }
    expect(HUMAN_CALIBRATED_PROFILES).toEqual(before);
  });
  it('refuses held-out seeds before any deal is played', () => {
    expect(() =>
      validateOmahaStressRequest({ ...request(), seed: PLO4_STRENGTH_CONTRACT.holdout.seeds[0] })
    ).toThrow(/holdout/);
  });
  it.each([
    { hands: 0 },
    { hands: 1001 },
    { hands: 1.5 },
    { seed: 0 },
    { seed: NaN },
    { seed: 0xffffffff, hands: 2 },
    { seats: 3 },
    { stackBB: 0 },
    { variant: 'nlh' },
    { opponent: 'unknown' },
  ])('refuses invalid work requests %j', (bad) => {
    expect(() =>
      validateOmahaStressRequest({ ...request(), ...bad } as OmahaStressRequest)
    ).toThrow();
  });
  for (const variant of ['plo4', 'plo5', 'plo6'] as const)
    for (const opponent of OMAHA_STRESS_OPPONENTS)
      it(`${variant} versus ${opponent}: real controller, independent accounting, no promotion claim`, async () => {
        const input = { ...request(), variant, opponent };
        const before = structuredClone(input);
        const out = await runOmahaAdversarialStress(input);
        expect(out.completedHands).toBe(1);
        expect(out.evidenceKind).toBe('synthetic_development_stress');
        expect(out.qualifiesForPromotion).toBe(false);
        expect(out.isHumanPerformanceEvidence).toBe(false);
        expect(out.decisionPolicy).toBe('reference_only');
        expect(Number.isFinite(out.heroNetBb)).toBe(true);
        expect(out.heroBb100).toBe(out.heroNetBb * 100);
        expect(out.normalApproximation99Bb100).toBeNull();
        expect(out.standardErrorBb100).toBeNull();
        expect(input).toEqual(before);
      });
  it('runs the actual offline CLI and binds its source without a promotion verdict', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/scripts/omahaAdversarialStress.ts',
        '--variant=plo5',
        '--opponent=caller',
        '--seed=10001',
        '--hands=2',
        '--seats=2',
        '--stack=25',
      ],
      { encoding: 'utf8', timeout: 10000 }
    );
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.completedHands).toBe(2);
    expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.qualifiesForPromotion).toBe(false);
    expect(result.standardErrorBb100).not.toBeNull();
    const invalid = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/scripts/omahaAdversarialStress.ts', '--unknown=1'],
      { encoding: 'utf8', timeout: 10000 }
    );
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr).toContain('Unknown or duplicate stress argument');
  });
});
