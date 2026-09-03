/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PLO PREFLOP SIZING — a min-raise open must be UNREACHABLE (Dan 2026-09-03)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Horses min-raising in PLO is unacceptable ... a min-raise is NOT the
 *  standard PLO opening raise."
 *
 * Measured against production on 2026-09-02 over 40,232 PLO opens: average
 * 2.62x BB, 37.4% at or under 2x, 11.7% pot or bigger — against 2.87x and
 * 26.8% in NLH the same day. The pot-limit games were opening SMALLER than
 * the no-limit game because a no-limit sizing ladder was running both.
 *
 * These tests drive the WHOLE decision (HorseLogic.decide -> the V7 preflop
 * layer -> legalize -> the pot-limit cap), not the sizer in isolation, so a
 * regression anywhere on that path fails here. They pin SIZING only: no
 * threshold, range or stack-off dial is asserted, because moving one of those
 * is a strategy change that needs a league matchup rather than a unit test.
 */

import { describe, it, expect } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { potLimitRaiseTo } from './BettingStructure.js';
import { PLO_MIN_OPEN_BB } from './HorsePreflop.js';
import { seedFastRandom } from './HorseEval.js';
import type { Card, SeatPlayer, HorseStyle } from '../types.js';

const C = (rank: string, suit: string): Card => ({ rank, suit }) as Card;

/** Aces double-suited: opens from every seat, so every seat gets sampled. */
const AAKK = [
  C('A', 'hearts'),
  C('A', 'spades'),
  C('K', 'hearts'),
  C('K', 'spades'),
  C('Q', 'diamonds'),
  C('J', 'clubs'),
];

const STYLES: HorseStyle[] = ['tag', 'lag', 'balanced', 'tricky', 'grinder'];
const PLO_VARIANTS = ['plo4', 'plo5', 'plo6', 'plo8'];

const HOLE_COUNT: Record<string, number> = { plo4: 4, plo5: 5, plo6: 6, plo8: 4 };

interface OpenCase {
  variant: string;
  bb: number;
  /** hero's seat index among `seats` below */
  heroSeat: number;
  limpers: number;
  straddle: boolean;
  tableSize: number;
  stackBB: number;
}

/**
 * Build an UNOPENED preflop pot: blinds posted, `limpers` callers, optionally
 * a straddle. Hero is yet to act. The pot and currentBet are assembled exactly
 * as the engine assembles them so `potLimitRaiseTo` here is the same number
 * the engine's own validateAction will bound the horse by.
 */
function unopenedGs(cs: OpenCase): { hero: SeatPlayer; gs: HorseGameStateV2; potTo: number } {
  const sb = cs.bb / 2;
  const straddleAmt = cs.straddle ? cs.bb * 2 : 0;
  const currentBet = cs.straddle ? straddleAmt : cs.bb;
  const stack = cs.stackBB * cs.bb;
  const cards = AAKK.slice(0, HOLE_COUNT[cs.variant] ?? 4);

  const players: SeatPlayer[] = [];
  const actionHistory: HorseGameStateV2['actionHistory'] = [];
  let pot = sb + cs.bb + straddleAmt;

  // seat 1 small blind, seat 2 big blind, seat 3 straddle when present.
  for (let seat = 1; seat <= cs.tableSize; seat++) {
    const bet = seat === 1 ? sb : seat === 2 ? cs.bb : seat === 3 && cs.straddle ? straddleAmt : 0;
    players.push({
      seat,
      user_id: seat === cs.heroSeat ? 'hero' : `v${seat}`,
      stack: stack - bet,
      bet,
      is_folded: false,
      cards: seat === cs.heroSeat ? cards : [],
    } as never as SeatPlayer);
  }
  // Limpers call the current bet from the seats BEFORE hero.
  let limped = 0;
  for (const p of players) {
    if (limped >= cs.limpers) break;
    if (p.seat === cs.heroSeat || p.seat <= (cs.straddle ? 3 : 2)) continue;
    if (p.seat > cs.heroSeat) break;
    const add = currentBet - p.bet;
    p.bet = currentBet;
    p.stack -= add;
    pot += add;
    actionHistory.push({
      stage: 'preflop',
      seat: p.seat,
      userId: p.user_id,
      action: 'call',
      amount: currentBet,
    } as never);
    limped++;
  }

  const hero = players.find((p) => p.seat === cs.heroSeat) as SeatPlayer;
  const gs = {
    players,
    communityCards: [],
    pot,
    currentBet,
    minRaise: cs.bb,
    lastRaise: cs.bb,
    stage: 'preflop',
    gameVariant: cs.variant,
    bigBlind: cs.bb,
    smallBlind: sb,
    dealerSeat: cs.tableSize,
    actionHistory,
    straddleActive: cs.straddle,
  } as never as HorseGameStateV2;

  const toCall = Math.max(0, currentBet - hero.bet);
  return { hero, gs, potTo: potLimitRaiseTo(pot, currentBet, toCall) };
}

/** Every unopened shape worth sampling, without a combinatorial explosion. */
function openCases(variant: string): OpenCase[] {
  const out: OpenCase[] = [];
  for (const bb of [2, 10, 50]) {
    for (const tableSize of [2, 6, 9]) {
      for (let heroSeat = 1; heroSeat <= tableSize; heroSeat++) {
        for (const limpers of [0, 1, 2]) {
          if (limpers > 0 && heroSeat <= 3) continue;
          for (const straddle of tableSize >= 6 ? [false, true] : [false]) {
            if (straddle && heroSeat <= 3) continue;
            for (const stackBB of [40, 100, 200]) {
              out.push({ variant, bb, heroSeat, limpers, straddle, tableSize, stackBB });
            }
          }
        }
      }
    }
  }
  return out;
}

describe('PLO opens are pot-sized and never a min-raise', () => {
  for (const variant of PLO_VARIANTS) {
    it(`${variant}: no open lands below ${PLO_MIN_OPEN_BB}x BB, from any seat, stack or style`, () => {
      seedFastRandom(20260903);
      const offenders: string[] = [];
      let opens = 0;
      let sumX = 0;

      for (const cs of openCases(variant)) {
        for (const style of STYLES) {
          const { hero, gs, potTo } = unopenedGs(cs);
          const d = HorseLogic.decide(hero, gs, style, {}, { telemetry: false } as never);
          if (d.action !== 'raise' && d.action !== 'bet' && d.action !== 'all_in') continue;
          const to = d.action === 'all_in' ? hero.bet + hero.stack : (d.amount ?? 0);
          opens++;
          sumX += to / cs.bb;

          // An all-in for less than one pot raise is the largest legal wager
          // there is; it is not a min-raise open and is not an offender.
          const cappedByStack = hero.bet + hero.stack < potTo;
          const floor = Math.min(PLO_MIN_OPEN_BB * cs.bb, potTo);
          if (to < floor - 0.005 && !cappedByStack) {
            offenders.push(
              `${style} bb=${cs.bb} seat=${cs.heroSeat}/${cs.tableSize} limpers=${cs.limpers} ` +
                `straddle=${cs.straddle} stack=${cs.stackBB}bb -> to ${to} (${(to / cs.bb).toFixed(2)}x, potTo ${potTo})`
            );
          }
          // And it can never exceed the pot-limit ceiling.
          expect(to).toBeLessThanOrEqual(potTo + 0.005);
        }
      }

      expect(opens).toBeGreaterThan(200);
      expect(offenders).toEqual([]);
      // The fleet average lands in the pot-open band, not the 2.62x measured
      // in production the day this was written.
      const avgX = sumX / opens;
      expect(avgX).toBeGreaterThan(3.0);
    });
  }

  it('the legacy v7Preflop:false path is fixed too - it was a second source of 2x opens', () => {
    seedFastRandom(4242);
    for (const cs of openCases('plo6')) {
      const { hero, gs, potTo } = unopenedGs(cs);
      const d = HorseLogic.decide(hero, gs, 'grinder', {}, { v7Preflop: false } as never);
      if (d.action !== 'raise' && d.action !== 'bet') continue;
      const to = d.amount ?? 0;
      const floor = Math.min(PLO_MIN_OPEN_BB * cs.bb, potTo);
      if (hero.bet + hero.stack >= potTo) expect(to).toBeGreaterThanOrEqual(floor - 0.005);
      expect(to).toBeLessThanOrEqual(potTo + 0.005);
    }
  });

  it('a straddled PLO pot sizes the open off the STRADDLE, not the big blind', () => {
    seedFastRandom(7);
    const cs: OpenCase = {
      variant: 'plo6',
      bb: 2,
      heroSeat: 4,
      limpers: 0,
      straddle: true,
      tableSize: 6,
      stackBB: 200,
    };
    const { hero, gs, potTo } = unopenedGs(cs);
    // 1/2 with a 4 straddle: pot 7, currentBet 4, toCall 4 -> pot raise to 15.
    expect(potTo).toBe(15);
    const d = HorseLogic.decide(hero, gs, 'lag', {}, {} as never);
    expect(d.action).toBe('raise');
    expect(d.amount ?? 0).toBeGreaterThanOrEqual(3 * 4 - 0.005);
    expect(d.amount ?? 0).toBeLessThanOrEqual(potTo + 0.005);
  });

  it('one limper adds a full pot raise, exactly as pot limit says - not a flat +1bb', () => {
    const cs: OpenCase = {
      variant: 'plo4',
      bb: 2,
      heroSeat: 5,
      limpers: 1,
      straddle: false,
      tableSize: 6,
      stackBB: 200,
    };
    const { potTo } = unopenedGs(cs);
    // pot 5 (0.5bb + 1bb + the limp), currentBet 2, toCall 2 -> to 9 = 4.5x BB.
    expect(potTo).toBe(9);
  });

  it('NLH is untouched - the fix is scoped to pot limit', () => {
    seedFastRandom(99);
    let below3 = 0;
    let opens = 0;
    for (const cs of openCases('nlh')) {
      const { hero, gs } = unopenedGs({ ...cs, variant: 'nlh' });
      const d = HorseLogic.decide(hero, gs, 'grinder', {}, {} as never);
      if (d.action !== 'raise') continue;
      opens++;
      if ((d.amount ?? 0) < 3 * cs.bb) below3++;
    }
    expect(opens).toBeGreaterThan(40);
    // No-limit opens live below 3x by design; if this ever reads zero the
    // pot-limit branch has leaked into the no-limit ladder.
    expect(below3).toBeGreaterThan(0);
  });
});

describe('PLO re-raises are pot-sized too', () => {
  /** Hero in the big blind facing a pot-sized open of 7 at 1/2. */
  const facingOpen = (variant: string, raiseTo: number, pot: number) => {
    const cards = AAKK.slice(0, HOLE_COUNT[variant] ?? 4);
    const hero = {
      seat: 2,
      user_id: 'hero',
      stack: 400 - 2,
      bet: 2,
      is_folded: false,
      cards,
    } as never as SeatPlayer;
    const gs = {
      players: [
        { seat: 1, user_id: 'sb', stack: 399, bet: 1, is_folded: true, cards: [] },
        hero,
        {
          seat: 3,
          user_id: 'opener',
          stack: 400 - raiseTo,
          bet: raiseTo,
          is_folded: false,
          cards: [],
        },
      ],
      communityCards: [],
      pot,
      currentBet: raiseTo,
      minRaise: raiseTo - 2,
      lastRaise: raiseTo - 2,
      stage: 'preflop',
      gameVariant: variant,
      bigBlind: 2,
      smallBlind: 1,
      dealerSeat: 3,
      actionHistory: [
        {
          stage: 'preflop',
          seat: 3,
          userId: 'opener',
          action: 'raise',
          amount: raiseTo,
          isFullRaise: true,
        },
      ],
    } as never as HorseGameStateV2;
    return { hero, gs, potTo: potLimitRaiseTo(pot, raiseTo, raiseTo - 2) };
  };

  it('a PLO 3-bet is a pot raise, not an NLH multiple of the open', () => {
    seedFastRandom(11);
    let threeBets = 0;
    for (const style of STYLES) {
      for (let i = 0; i < 40; i++) {
        const { hero, gs, potTo } = facingOpen('plo6', 7, 10);
        const d = HorseLogic.decide(hero, gs, style, {}, {} as never);
        if (d.action !== 'raise') continue;
        threeBets++;
        const to = d.amount ?? 0;
        // Pot here is 24. The old IP multiplier produced 21 and under; the
        // band below is the pot with only the persona shade taken off it.
        expect(to).toBeLessThanOrEqual(potTo + 0.005);
        expect(to).toBeGreaterThanOrEqual(potTo * 0.85 - 0.005);
      }
    }
    expect(threeBets).toBeGreaterThan(0);
  });
});
