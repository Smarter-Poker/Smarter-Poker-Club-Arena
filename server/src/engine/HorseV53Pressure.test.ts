/**
 * V53 PRESSURE (2026-10-24). Dan: "HORSES NEED TO 3BET AGGRESSIVE HUMANS MORE
 * IN POSITION AND CONTINUE THE PRESSURE THROUGHOUT THE HAND", "NOT NEARLY
 * ENOUGH CHECK RAISES WITH THE BEST HAND AND AS BLUFFS WHEN ITS WARRANTED" and
 * "DON'T FORGET THE RIVER BLUFF WHEN THE SCARE CARD COMES".
 *
 * The read used below is the production PLO5 full-ring cash row of the human
 * the request was about (horse_exploit_profiles, SELECT only, 2026-10-24
 * 22:15 UTC): opens ~76%, re-raises ~48%, folded 0 of ~6.7 faced 3-bets,
 * folds ~56% to postflop bets and calls ~7% of river bets.
 */
import { describe, expect, it } from 'vitest';
import { readScopeOf } from './HorseMind.js';
import {
  aggressiveBettorPressure,
  aggressiveOpenerPressure,
  freshExploitCounters,
  opponentExploitRead,
  preflopVsOpener,
  riverBluffFrequency,
  riverFoldLowerBound,
  type ExploitCounters,
} from './HorseOpponentExploit.js';
import { decidePreflopV7 } from './HorsePreflop.js';

const MEASURED: ExploitCounters = {
  ...freshExploitCounters(),
  hands: 43.7780151413752,
  vpip: 32.5104153221498,
  pfr: 26.3732358372006,
  rfiOpp: 20.1000949771467,
  rfi: 15.281653148764,
  threeBetOpp: 22.1188624668681,
  threeBet: 10.7213083003648,
  foldTo3BetOpp: 6.6522320171437,
  foldTo3Bet: 0,
  betCheckedToOpp: 58.548698373745,
  betCheckedTo: 18.8323095444715,
  foldToBetOpp: 22.7057514227004,
  foldToBet: 12.7089863125434,
  riverCallOpp: 4.02700294029147,
  riverCall: 0.291769043768339,
  fHands: 12.0487797070162,
  fPfr: 6.63098910306557,
  fRfiOpp: 6.5771007060026,
  fRfi: 4.53625488460437,
  fThreeBetOpp: 4.85197990634312,
  fThreeBet: 2.07063717431421,
  fBetCheckedToOpp: 14.0806798314077,
  fBetCheckedTo: 4.6543710397637,
  fFoldToBetOpp: 6.39364587805712,
  fFoldToBet: 3.65321314014924,
  fRiverCallOpp: 0.979589062540531,
  fRiverCall: 0.00716414194609682,
};
const scope = readScopeOf('plo5', 9);
const measured = () => opponentExploitRead(MEASURED, scope, 'plo5')!;

describe('V53 read helpers', () => {
  it('the measured human reads as a wide raiser and re-raiser', () => {
    const read = measured();
    expect(read).not.toBeNull();
    // Shrunk posteriors: raises ~55% of hands, re-raises ~39% of opens. The
    // fold-to-bet and fold-to-3-bet reads are beyond the horse means but not
    // yet credible at 90% on this sample, so they stay disengaged.
    expect(read.stats.pfr.engaged).toBe('high');
    expect(read.stats.threeBet.engaged).toBe('high');
    expect(read.stats.foldToBet.engaged).toBeNull();
  });

  it('no read, no pressure (the neutrality contract)', () => {
    expect(aggressiveOpenerPressure(null, true)).toBeNull();
    expect(aggressiveBettorPressure(null)).toBeNull();
    expect(riverFoldLowerBound(null)).toBeNull();
    expect(riverBluffFrequency(null, 0.7, true, true)).toBe(0);
  });

  it('a read that is not a wide opener gets no 3-bet widening', () => {
    // Over-folds postflop only: engaged, but opens like a horse.
    const c: ExploitCounters = {
      ...freshExploitCounters(),
      hands: 60,
      vpip: 15,
      pfr: 9,
      rfiOpp: 40,
      rfi: 11,
      foldToBetOpp: 50,
      foldToBet: 40,
    };
    const read = opponentExploitRead(c, scope, 'plo5');
    expect(read?.stats.foldToBet.engaged).toBe('high');
    expect(aggressiveOpenerPressure(read, true)).toBeNull();
  });

  it('3-bets wider than the old value bar, widest in position', () => {
    const read = measured();
    const p = aggressiveOpenerPressure(read, true)!;
    const old = preflopVsOpener(read, true)!.threeBetBar!;
    // A lower bar admits more hands.
    expect(p.ipThreeBetBar).toBeLessThan(p.oopThreeBetBar);
    expect(p.oopThreeBetBar).toBeLessThan(old);
  });

  it('raises a wide bettor more, and check-raise bluffs an over-folder hardest', () => {
    const p = aggressiveBettorPressure(measured())!;
    expect(p.valueBarDrop).toBeGreaterThan(0);
    expect(p.raiseFloor).toBeGreaterThanOrEqual(0.85);
    expect(p.semiBluffMul).toBeGreaterThan(1);
    const overFolder: ExploitCounters = {
      ...MEASURED,
      foldToBetOpp: 60,
      foldToBet: 45,
      fFoldToBetOpp: 12,
      fFoldToBet: 9,
    };
    const read = opponentExploitRead(overFolder, scope, 'plo5');
    expect(read?.stats.foldToBet.engaged).toBe('high');
    expect(aggressiveBettorPressure(read)!.semiBluffMul).toBeGreaterThanOrEqual(2.5);
  });

  it('bluffs the river into a credible over-folder, more on a scare card', () => {
    const lb = riverFoldLowerBound(measured())!;
    // A 70%-pot bluff breaks even at 41% folds.
    expect(lb).toBeGreaterThan(0.7 / 1.7 + 0.06);
    const scare = riverBluffFrequency(lb, 0.7, true, false);
    const plain = riverBluffFrequency(lb, 0.7, false, false);
    expect(plain).toBeGreaterThan(0);
    expect(scare).toBeGreaterThan(plain);
    expect(scare).toBeLessThanOrEqual(0.9);
  });

  it('never bluffs the river into a player who calls it', () => {
    const station: ExploitCounters = {
      ...MEASURED,
      riverCallOpp: 12,
      riverCall: 10,
      fRiverCallOpp: 6,
      fRiverCall: 5,
    };
    const lb = riverFoldLowerBound(opponentExploitRead(station, scope, 'plo5'));
    expect(lb).not.toBeNull();
    expect(riverBluffFrequency(lb, 0.7, true, true)).toBe(0);
  });

  it('a thin river sample is not trusted', () => {
    const thin: ExploitCounters = { ...MEASURED, riverCallOpp: 1, riverCall: 0 };
    expect(riverFoldLowerBound(opponentExploitRead(thin, scope, 'plo5'))).toBeNull();
  });
});

describe('V53 preflop: the top of the flats 3-bets a wide opener', () => {
  const read = measured();
  const opener = preflopVsOpener(read, true)!;
  const pressure = aggressiveOpenerPressure(read, true)!;
  // Strength between the in-position pressure bar and the old value bar.
  const strength = (pressure.ipThreeBetBar + opener.threeBetBar!) / 2;
  const ctx = (over: Record<string, unknown> = {}): never =>
    ({
      strength,
      position: 'late',
      raiserPosition: 'middle',
      raises: 1,
      limpers: 0,
      callers: 0,
      oppsLeft: 3,
      toCall: 5,
      currentBet: 7,
      pot: 10,
      bigBlind: 2,
      stack: 200,
      stackBB: 100,
      tightness: 1,
      bluffFreq: 0.15,
      aggression: 1,
      slowplayFreq: 0,
      sizingMultiplier: 1,
      isOmaha: true,
      isPotLimit: true,
      riskAdd: 0,
      mode: 'cash',
      omahaAA: false,
      exploitOpener: opener,
      rand: () => 0.99,
      ...over,
    }) as never;

  it('flats without the pressure read, 3-bets with it in position', () => {
    expect(decidePreflopV7(ctx()).a).not.toBe('raiseTo');
    expect(decidePreflopV7(ctx({ exploitPressure: pressure })).a).toBe('raiseTo');
  });

  it('a rundown that "takes the flop" still 3-bets the wide opener heads-up', () => {
    expect(decidePreflopV7(ctx({ classNeverThreeBet: true })).a).not.toBe('raiseTo');
    expect(
      decidePreflopV7(ctx({ classNeverThreeBet: true, exploitPressure: pressure })).a
    ).toBe('raiseTo');
  });

  it('with a caller already in, the pressure bars do not apply', () => {
    expect(decidePreflopV7(ctx({ callers: 1, exploitPressure: pressure })).a).toBe(
      decidePreflopV7(ctx({ callers: 1 })).a
    );
  });

  it('out of position the 3-bet widens less', () => {
    const between = (pressure.ipThreeBetBar + pressure.oopThreeBetBar) / 2;
    const oop = decidePreflopV7(
      ctx({ position: 'sb', strength: between, exploitPressure: pressure })
    ).a;
    const ip = decidePreflopV7(ctx({ strength: between, exploitPressure: pressure })).a;
    expect(ip).toBe('raiseTo');
    expect(oop).not.toBe('raiseTo');
  });
});

describe('V53 preflop: hold\'em too', () => {
  it('a wide hold\'em opener is 3-bet in position from a hand that flats without the read', () => {
    const nlhScope = readScopeOf('nlh', 9);
    const c: ExploitCounters = {
      ...freshExploitCounters(),
      hands: 40,
      vpip: 34,
      pfr: 30,
      rfiOpp: 25,
      rfi: 22,
      fHands: 12,
      fPfr: 9,
      fRfiOpp: 8,
      fRfi: 7,
    };
    const read = opponentExploitRead(c, nlhScope, 'nlh')!;
    const opener = preflopVsOpener(read, false)!;
    const pressure = aggressiveOpenerPressure(read, false)!;
    expect(pressure).not.toBeNull();
    const strength = (pressure.ipThreeBetBar + opener.threeBetBar!) / 2;
    const ctx = (over: Record<string, unknown> = {}): never =>
      ({
        strength,
        position: 'late',
        raiserPosition: 'middle',
        raises: 1,
        limpers: 0,
        callers: 0,
        oppsLeft: 3,
        toCall: 4,
        currentBet: 6,
        pot: 9,
        bigBlind: 2,
        stack: 200,
        stackBB: 100,
        tightness: 1,
        bluffFreq: 0.15,
        aggression: 1,
        slowplayFreq: 0,
        sizingMultiplier: 1,
        isOmaha: false,
        isPotLimit: false,
        riskAdd: 0,
        mode: 'cash',
        exploitOpener: opener,
        rand: () => 0.99,
        ...over,
      }) as never;
    expect(decidePreflopV7(ctx()).a).not.toBe('raiseTo');
    expect(decidePreflopV7(ctx({ exploitPressure: pressure })).a).toBe('raiseTo');
  });
});
