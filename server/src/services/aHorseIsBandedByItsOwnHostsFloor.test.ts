/**
 * A HORSE IS BANDED BY ITS OWN HOST'S FLOOR (2026-09-11).
 *
 * `bandSupply` was the union of every open table on the platform, and a horse
 * can only sit where it holds a membership. The two hosts do not deal the same
 * ladder: Deep Stack Society deals micro, low, mid and high; Midway Union deals
 * micro, low and mid (its games above 2/5 were switched off on 2026-09-04). One
 * Deep Stack 25/50 game therefore answered "yes, 'high' has a game" to every
 * Midway horse, so a Midway horse assigned 'high' never stepped down and was
 * refused at every Midway table by the same hard gate - the 2026-09-05 shape
 * (100 horses that could sit nowhere), one host at a time.
 *
 * Measured read-only against production on 2026-09-11: the next assignment run
 * would have written 'high' onto 76 Midway horses. The assignment was fixed the
 * same day (fn_assign_horse_stake_bands projects onto the horse's own hosts);
 * this is the belt to those braces, covering the window between an operator
 * switching a host's game off and the next assignment run.
 *
 * The fail-open rule is the load-bearing half and it is pinned hardest: a host
 * nobody published supply for, or an unknown host, must fall back to the
 * platform answer. Narrowing on ignorance is how a fleet disappears.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyStakeBandSupply,
  clearStakeBandSupply,
  setHorseStakeBands,
  clearHorseStakeBands,
  effectiveStakeBandFor,
  stakeBandAllows,
  stakeBandSupplyForHost,
} from './HorseBehavior.js';

const DSS = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
const MIDWAY = 'fade0000-0000-0000-0000-000000000001';

/** The two hosts as production actually deals them. */
const liveFloor = () =>
  applyStakeBandSupply(['micro', 'low', 'mid', 'high'], [
    [DSS, ['micro', 'low', 'mid', 'high']],
    [MIDWAY, ['micro', 'low', 'mid']],
  ] as Array<readonly [string, Array<'micro' | 'low' | 'mid' | 'high'>]>);

beforeEach(() => {
  clearStakeBandSupply();
  clearHorseStakeBands();
});

describe('the band a horse may sit is asked of its own host', () => {
  it('a high-banded horse steps down on the host with no high game, and stays on the host with one', () => {
    setHorseStakeBands([{ id: 'topdog', stakeBand: 'high' }]);
    liveFloor();
    expect(effectiveStakeBandFor('topdog', MIDWAY)).toBe('mid');
    expect(effectiveStakeBandFor('topdog', DSS)).toBe('high');
    // 25/50 is a high game, 2/5 is mid: the same horse, two different answers,
    // each correct for the floor it is standing on.
    expect(stakeBandAllows('topdog', 50, DSS)).toBe(true);
    expect(stakeBandAllows('topdog', 50, MIDWAY)).toBe(false);
    expect(stakeBandAllows('topdog', 5, MIDWAY)).toBe(true);
  });

  it('the platform answer alone would have stranded that horse on Midway', () => {
    setHorseStakeBands([{ id: 'topdog', stakeBand: 'high' }]);
    // No per-host supply published: the old behaviour, kept as the fallback.
    applyStakeBandSupply(['micro', 'low', 'mid', 'high']);
    expect(effectiveStakeBandFor('topdog', MIDWAY)).toBe('high');
    // And that is the strand, exactly: the gate happily says yes to a 25/50
    // seat Midway does not deal, and no to every table Midway does deal. The
    // horse is refused at 2/5, at 1/2 and at 0.05/0.10, and the one game its
    // band matches is on the other host, where it holds no membership.
    expect(stakeBandAllows('topdog', 5, MIDWAY)).toBe(false);
    expect(stakeBandAllows('topdog', 2, MIDWAY)).toBe(false);
    expect(stakeBandAllows('topdog', 0.1, MIDWAY)).toBe(false);
  });

  it('never promotes: a micro horse is micro on a floor that deals nothing but high', () => {
    setHorseStakeBands([{ id: 'smallfry', stakeBand: 'micro' }]);
    applyStakeBandSupply(['high'], [[DSS, ['high']]] as Array<
      readonly [string, Array<'micro' | 'low' | 'mid' | 'high'>]
    >);
    expect(effectiveStakeBandFor('smallfry', DSS)).toBe('micro');
    expect(stakeBandAllows('smallfry', 50, DSS)).toBe(false);
  });
});

describe('an unknown floor never narrows anybody', () => {
  it('a host nobody published supply for falls back to the platform answer', () => {
    setHorseStakeBands([{ id: 'topdog', stakeBand: 'high' }]);
    liveFloor();
    expect(stakeBandSupplyForHost('a-club-nobody-scanned')).toBeNull();
    expect(effectiveStakeBandFor('topdog', 'a-club-nobody-scanned')).toBe('high');
  });

  it('an empty per-host set is left out rather than recorded as "no games"', () => {
    setHorseStakeBands([{ id: 'topdog', stakeBand: 'high' }]);
    applyStakeBandSupply(['micro', 'low', 'mid', 'high'], [[MIDWAY, []]] as Array<
      readonly [string, Array<'micro' | 'low' | 'mid' | 'high'>]
    >);
    expect(stakeBandSupplyForHost(MIDWAY)).toBeNull();
    expect(effectiveStakeBandFor('topdog', MIDWAY)).toBe('high');
  });

  it('no host argument at all is exactly the old behaviour', () => {
    setHorseStakeBands([{ id: 'topdog', stakeBand: 'high' }]);
    liveFloor();
    expect(effectiveStakeBandFor('topdog')).toBe('high');
    expect(stakeBandAllows('topdog', 50)).toBe(true);
  });

  it('clearing the supply forgets the per-host map too', () => {
    liveFloor();
    expect(stakeBandSupplyForHost(MIDWAY)).not.toBeNull();
    clearStakeBandSupply();
    expect(stakeBandSupplyForHost(MIDWAY)).toBeNull();
  });
});

describe('the report still counts what the platform is short of', () => {
  it('names the bands with horses in them and no game anywhere', () => {
    setHorseStakeBands([
      { id: 'topdog', stakeBand: 'high' },
      { id: 'midder', stakeBand: 'mid' },
    ]);
    const report = applyStakeBandSupply(['micro', 'low', 'mid'], [
      [MIDWAY, ['micro', 'low', 'mid']],
    ] as Array<readonly [string, Array<'micro' | 'low' | 'mid' | 'high'>]>);
    expect(report.missing).toEqual(['high']);
    expect(report.fallbacks).toBe(1);
  });
});
