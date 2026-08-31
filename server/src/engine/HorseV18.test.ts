/**
 * V18 — straddle fix, squeeze response, self-image, exploit sizing,
 * family personality, leak-tag tuning.
 */
import { describe, it, expect } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { decidePreflopV7 } from './HorsePreflop.js';
import { seedFastRandom } from './HorseEval.js';
import { diagnoseAndNudge, type PlayStats } from '../services/HorseSelfTuner.js';
import type { Card, SeatPlayer } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;

function seatP(n: number, id: string, over: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat: n,
    user_id: id,
    username: id,
    stack: 200,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...over,
  } as SeatPlayer;
}

describe('V18 straddle fix', () => {
  function actions(straddleActive: boolean, trials = 400): { folds: number; raises: number } {
    // A hand in the open-but-cannot-call band (Q9s-ish, ~0.45-0.5): a real
    // opening hand from late position that FOLDS if the brain misreads the
    // straddle as an open raise. That inversion is the whole bug.
    let folds = 0;
    let raises = 0;
    for (let s = 1; s <= trials; s++) {
      seedFastRandom(s * 9127);
      const hero = seatP(4, 'hero', { cards: [c('Q', 'hearts'), c('9', 'hearts')], bet: 0 });
      const gs: HorseGameStateV2 = {
        players: [hero, seatP(1, 'a'), seatP(2, 'b', { bet: 2 }), seatP(3, 'st', { bet: 4 })],
        communityCards: [],
        pot: 7,
        currentBet: 4,
        minRaise: 2,
        stage: 'preflop',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 1,
        actionHistory: [],
        gameMode: 'cash',
        format: 'cash',
        straddleActive,
      } as HorseGameStateV2;
      const dec = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
      if (dec.action === 'fold') folds++;
      if (dec.action === 'raise' || dec.action === 'bet') raises++;
    }
    return { folds: folds / trials, raises: raises / trials };
  }

  it('a straddled pot stops reading as an open raise', () => {
    const withFix = actions(true);
    const misread = actions(false); // straddles not flagged: legacy misread
    // Misread: the "open" cannot be called at this strength -> mostly folds.
    expect(misread.folds).toBeGreaterThan(0.4);
    // Fixed: it is an opening hand over dead money -> attacks, rarely folds.
    expect(withFix.raises).toBeGreaterThan(misread.raises + 0.2);
    expect(withFix.folds).toBeLessThan(misread.folds - 0.2);
  });
});

describe('V18 squeeze response', () => {
  const ctx = (squeezed: boolean, strength: number) => ({
    strength,
    position: 'late' as const,
    raiserPosition: 'middle' as const,
    raises: 2,
    limpers: 0,
    callers: 1,
    oppsLeft: 3,
    toCall: 18,
    currentBet: 22,
    pot: 35,
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
    squeezed,
    rand: () => 0.99,
  });

  it('the squeezed opener defends hands a cold 3-bet folds', () => {
    /**
     * The property is "a squeeze is defended WIDER than a cold 3-bet", and
     * that is what this asserts. The window is SCANNED rather than hardcoded
     * (2026-08-31): it used to probe 0.72-0.74, the band just under the
     * then-current `t(0.74)` bar, and the raise-fold price fix moved every
     * facing-a-3-bet bar down by the price relief — so the differential
     * simply relocated to 0.580-0.595 and a hardcoded window reported the
     * property as LOST when it was only somewhere else. Scanning pins the
     * behaviour instead of the coordinates.
     */
    let defendsMore = 0;
    for (let st = 0.3; st < 0.85; st += 0.005) {
      const sq = decidePreflopV7(ctx(true, st) as never);
      const cold = decidePreflopV7(ctx(false, st) as never);
      if (sq.a !== 'fold' && cold.a === 'fold') defendsMore++;
    }
    expect(defendsMore).toBeGreaterThan(0);
  });
});

describe('V18 leak-tag tuning', () => {
  const stats: PlayStats = {
    hands: 5000,
    vpip: 1200,
    pfr: 800,
    threeBets: 100,
    threeBetOpps: 900,
    faced3Bets: 100,
    foldTo3Bets: 45,
    sawFlop: 2500,
    wonWhenSawFlop: 1150,
    postAggr: 900,
    postPassive: 600,
    netBB: 0,
  } as PlayStats;

  it('repeated dominated stackoffs tighten the dials with an honest reason', () => {
    const { mods, reasons } = diagnoseAndNudge(stats, {}, null, 0, {
      nonnut_flush_stackoff: 5,
      second_nut_flush_stackoff: 3,
    });
    expect(mods.tightness).toBeGreaterThan(1);
    expect(mods.aggression).toBeLessThan(1);
    expect(reasons.join(' ')).toContain('dominated-hand stackoffs');
  });

  it('surrendered big bluffs cut the bluff dial', () => {
    const { mods, reasons } = diagnoseAndNudge(stats, {}, null, 0, { big_bet_fold: 12 });
    expect(mods.bluffFreq).toBeLessThan(1);
    expect(reasons.join(' ')).toContain('bluffs surrendered');
  });

  it('below the count gates nothing moves', () => {
    const { reasons } = diagnoseAndNudge(stats, {}, null, 0, {
      nonnut_flush_stackoff: 2,
      big_bet_fold: 4,
    });
    expect(reasons.join(' ')).not.toContain('leak:');
  });
});
