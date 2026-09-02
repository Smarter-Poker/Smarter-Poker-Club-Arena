/**
 * V16 STRATEGY LAYER — ICM, HU overlay, PLO polarity, plo8 low draws,
 * size-conditioned sampling, unblocker bluffs, ratio-rescale plumbing.
 */
import { describe, it, expect } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { decidePreflopV7 } from './HorsePreflop.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom, omahaDrawQuality } from './HorseEval.js';
import type { Card, SeatPlayer, ActionRecord } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;
const h = 'hearts';
const d = 'diamonds';
const s = 'spades';
const cl = 'clubs';

const icmRisk = HorseLogic.__testables.icmRisk as (
  gs: HorseGameStateV2,
  stackBB: number,
  useV16?: boolean
) => number;

describe('V16 real ICM', () => {
  const baseGs = (stacks: number[], payoutPct: number[]): HorseGameStateV2 =>
    ({
      players: [],
      communityCards: [],
      pot: 0,
      currentBet: 0,
      minRaise: 0,
      stage: 'preflop',
      gameVariant: 'nlh',
      bigBlind: 100,
      gameMode: 'tournament',
      format: 'mtt',
      tournament: {
        playersLeft: stacks.length,
        spotsPaid: payoutPct.length,
        stacks,
        payoutPct,
      },
    }) as never;

  it('the flat-payout squeeze: a medium stack carries more pressure than the near-dead short stack', () => {
    // Correct ICM doctrine (the first cut of this test asserted folk wisdom
    // backwards): on a FLAT payout bubble the short stack has little left to
    // protect - its equity is nearly gone - while a medium/big stack risking
    // a full confrontation with another big stack is the catastrophe. The
    // premium must reflect that.
    const stacks = [9000, 6000, 5000, 1500];
    const pays = [40, 32, 28];
    const shortPrem = icmRisk(baseGs(stacks, pays), 15, true); // 1500 chips
    const medPrem = icmRisk(baseGs(stacks, pays), 50, true); // 5000 chips
    expect(medPrem).toBeGreaterThan(shortPrem);
    expect(medPrem).toBeGreaterThan(0.04);
  });

  it('winner-take-all payout collapses to chip EV (zero premium)', () => {
    const prem = icmRisk(baseGs([5000, 5000, 5000], [100]), 50, true);
    expect(prem).toBeLessThan(0.005);
  });

  it('missing stack data degrades to the legacy heuristic, never throws', () => {
    const gs = baseGs([], []);
    (gs.tournament as { stacks?: number[] }).stacks = undefined;
    const prem = icmRisk(gs, 30, true);
    expect(prem).toBeGreaterThanOrEqual(0);
    expect(prem).toBeLessThanOrEqual(0.12);
  });
});

describe('V16 PLO 3-bet polarity', () => {
  const ctx = (strength: number, omahaAA: boolean | undefined) => ({
    strength,
    position: 'late' as const,
    raiserPosition: 'middle' as const,
    raises: 1,
    limpers: 0,
    callers: 0,
    oppsLeft: 2,
    toCall: 6,
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
    omahaAA,
    rand: () => 0.99, // no bluff rolls, no traps
  });

  it('a marginal rundown WITHOUT aces flats where AAxx 3-bets', () => {
    // Strength just over the generic late-vs-middle bar.
    let flats = 0;
    let aaRaises = 0;
    for (let st = 0.7; st <= 0.78; st += 0.02) {
      const noAA = decidePreflopV7(ctx(st, false) as never);
      const withAA = decidePreflopV7(ctx(st, true) as never);
      if (noAA.a === 'call') flats++;
      if (withAA.a === 'raiseTo') aaRaises++;
    }
    expect(flats).toBeGreaterThan(0);
    expect(aaRaises).toBeGreaterThan(0);
  });
});

describe('V16 plo8 nut-low draw', () => {
  it('A2 live over two board lows grades as a nutty draw', () => {
    const hole = [c('A', h), c('2', d), c('K', s), c('Q', cl)];
    const board = [c('4', s), c('7', cl), c('K', h)];
    const info = omahaDrawQuality(hole, board, true);
    expect(info.nutLowDraw).toBe(true);
    expect(info.nutty).toBe(true);
    // Counterfeit: a deuce ON the board kills it.
    const info2 = omahaDrawQuality(hole, [c('2', s), c('7', cl), c('K', h)], true);
    expect(info2.nutLowDraw).toBe(false);
    // High-only variants never set it.
    const info3 = omahaDrawQuality(hole, board, false);
    expect(info3.nutLowDraw).toBe(false);
  });
});

describe('V16 size-conditioned sampling read', () => {
  it('bandsForOpponents flags a 20bb+ bet on the newest street', () => {
    const players = [
      { seat: 1, user_id: 'hero', is_folded: false, is_sitting_out: false },
      { seat: 2, user_id: 'bomber', is_folded: false, is_sitting_out: false },
    ] as never as SeatPlayer[];
    const history: ActionRecord[] = [
      { seat: 2, userId: 'bomber', action: 'raise', amount: 6, timestamp: 1, stage: 'preflop' },
      { seat: 1, userId: 'hero', action: 'call', amount: 6, timestamp: 2, stage: 'preflop' },
      { seat: 2, userId: 'bomber', action: 'bet', amount: 60, timestamp: 3, stage: 'flop' },
    ] as ActionRecord[];
    const reads: Array<{ aggrW: number; checked: number; bigBet?: boolean } | null> = [];
    HorseMind.bandsForOpponents(
      1,
      players,
      history,
      2,
      true,
      [c('K', s), c('8', d), c('3', cl)],
      reads
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]?.bigBet).toBe(true);

    // A small stab does not flag.
    const smallHist = history
      .slice(0, 2)
      .concat([
        { seat: 2, userId: 'bomber', action: 'bet', amount: 8, timestamp: 3, stage: 'flop' },
      ] as ActionRecord[]);
    const reads2: Array<{ aggrW: number; checked: number; bigBet?: boolean } | null> = [];
    HorseMind.bandsForOpponents(
      1,
      players,
      smallHist,
      2,
      true,
      [c('K', s), c('8', d), c('3', cl)],
      reads2
    );
    expect(reads2[0]?.bigBet).not.toBe(true);
  });
});

describe('V16 HU overlay + unblocker (comparative frequencies)', () => {
  function mkPlayer(cards: Card[]): SeatPlayer {
    return {
      seat: 1,
      user_id: 'hero',
      username: 'hero',
      stack: 200,
      bet: 0,
      totalInvested: 0,
      cards,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      is_horse: true,
    } as SeatPlayer;
  }
  const opp = (): SeatPlayer =>
    ({
      seat: 3,
      user_id: 'opp3',
      username: 'opp3',
      stack: 200,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      is_horse: true,
    }) as never as SeatPlayer;

  function riverBluffFreq(hole: Card[], board: Card[], v16Blockers: boolean, trials = 400): number {
    let bets = 0;
    for (let seed = 1; seed <= trials; seed++) {
      seedFastRandom(seed * 5527);
      const hero = mkPlayer(hole);
      const gs: HorseGameStateV2 = {
        players: [hero, opp()],
        communityCards: board,
        pot: 40,
        currentBet: 0,
        minRaise: 2,
        stage: 'river',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 1,
        actionHistory: [],
        gameMode: 'cash',
        format: 'cash',
      } as HorseGameStateV2;
      const dec = HorseLogic.decide(hero, gs, 'lag', {}, { mind: false, v16Blockers });
      if (dec.action === 'bet') bets++;
    }
    return bets / trials;
  }

  it('unblocking the missed flush draw bluffs more than blocking it', () => {
    // Board: two hearts, flush missed. Hero air.
    const board = [c('K', h), c('9', h), c('4', s), c('7', cl), c('2', d)];
    const unblockingHole = [c('6', cl), c('5', d)]; // zero hearts
    const blockingHole = [c('6', h), c('5', h)]; // holds the missed draw itself
    const f1 = riverBluffFreq(unblockingHole, board, true);
    const f2 = riverBluffFreq(blockingHole, board, true);
    expect(f1).toBeGreaterThan(f2);
  });
});
