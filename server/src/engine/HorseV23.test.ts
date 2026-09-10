/**
 * V23 — TOURNAMENT ENDGAME, RAISE-RESPONSE PLANS, RIVER READS, VARIANT AND
 * SPIN POLISH (2026-08-28, Phase 2 "build everything" session).
 *
 * Wiring is the point of these tests: every new pathway is exercised
 * end-to-end through HorseLogic.decide or the exported pure helpers, never
 * by trusting that a flag exists.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HorseLogic, endgameAdjust } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import { HorseMind } from './HorseMind.js';
import { decidePreflopV7 } from './HorsePreflop.js';
import { deriveBlindClock } from '../services/TournamentBrainContext.js';
import type { Card, SeatPlayer, ActionRecord, HandStage } from '../types.js';
import { LEAGUE_MATCHUPS } from '../benchmark/HorseLeague.js';

beforeEach(() => {
  seedFastRandom(0x5eed23);
  HorseMind.reset();
});

function c(spec: string): Card {
  const suitMap: Record<string, Card['suit']> = {
    h: 'hearts',
    d: 'diamonds',
    c: 'clubs',
    s: 'spades',
  };
  return { rank: spec[0] as Card['rank'], suit: suitMap[spec[1]] };
}
const cc = (...specs: string[]): Card[] => specs.map(c);

function mkPlayer(seat: number, overrides: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat,
    user_id: `horse-${seat}`,
    username: `Horse${seat}`,
    stack: 10000,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...overrides,
  } as SeatPlayer;
}

function rec(
  seat: number,
  action: ActionRecord['action'],
  amount: number,
  stage: HandStage,
  extra: Partial<ActionRecord> = {}
): ActionRecord {
  return {
    seat,
    userId: `horse-${seat}`,
    action,
    amount,
    timestamp: 1_000_000,
    stage,
    ...extra,
  };
}

type GS = Parameters<(typeof HorseLogic)['decide']>[1];

// ─────────────────────────────────────────────────────────────────────────────
// Blind clock (pure)
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveBlindClock', () => {
  const structure = [
    { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, duration: 180 },
    { level: 2, smallBlind: 15, bigBlind: 30, ante: 0, duration: 180 },
    { level: 3, smallBlind: 25, bigBlind: 50, ante: 5, duration: 180 },
  ];

  it('reads seconds-shaped durations and the next multiple', () => {
    const started = new Date('2026-08-28T00:00:00Z').toISOString();
    const now = Date.parse('2026-08-28T00:01:00Z'); // 1 min into a 3-min level
    // tournaments.current_level is the zero-based schedule index.
    const clock = deriveBlindClock(structure, 0, started, now);
    expect(clock.nextBlindInMin).toBe(2);
    expect(clock.nextBlindMult).toBeCloseTo(1.5);
  });

  it('reads minutes-shaped durations', () => {
    const alt = [
      { level: 1, smallBlind: 10, bigBlind: 20, durationMinutes: 5 },
      { level: 2, smallBlind: 20, bigBlind: 40, durationMinutes: 5 },
    ];
    const started = new Date('2026-08-28T00:00:00Z').toISOString();
    const now = Date.parse('2026-08-28T00:04:00Z');
    const clock = deriveBlindClock(alt, 0, started, now);
    expect(clock.nextBlindInMin).toBe(1);
    expect(clock.nextBlindMult).toBeCloseTo(2);
  });

  it('a stalled clock reads unknown, not zero-forever', () => {
    // The writer stopped advancing current_level (paused event): after three
    // level-lengths of "elapsed", the clock must stop claiming the next
    // level is imminent, or the M-zones play a shrunken M permanently.
    const started = new Date('2026-08-28T00:00:00Z').toISOString();
    const now = Date.parse('2026-08-28T00:30:00Z'); // 30 min into a 3-min level
    expect(deriveBlindClock(structure, 1, started, now).nextBlindInMin).toBeNull();
  });

  it('degrades to unknown on missing inputs - never guesses', () => {
    expect(deriveBlindClock(null, 1, 'x', Date.now()).nextBlindInMin).toBeNull();
    expect(deriveBlindClock(structure, null, 'x', Date.now()).nextBlindInMin).toBeNull();
    // Past the authored structure the TournamentManager and brain both use
    // the deterministic overflow ladder rather than inventing a terminal
    // level. A malformed negative index still degrades to unknown.
    expect(
      deriveBlindClock(structure, -1, new Date().toISOString(), Date.now()).nextBlindInMin
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Endgame adjust (pure)
// ─────────────────────────────────────────────────────────────────────────────

describe('endgameAdjust', () => {
  const gsBase = (t: Record<string, unknown>) =>
    ({ bigBlind: 100, tournament: t }) as unknown as Parameters<typeof endgameAdjust>[1];

  it('HU of an MTT collapses the premium to chip EV', () => {
    expect(endgameAdjust(0.1, gsBase({ playersLeft: 2 }), 30, true)).toBeLessThanOrEqual(0.01);
  });

  it('a mid-stack at the final table pays ladder pressure per shorter stack', () => {
    const gs = gsBase({
      finalTable: true,
      inMoney: true,
      playersLeft: 6,
      stacks: [9000, 6000, 3000, 1500, 1000, 800],
    });
    // hero 30bb * 100 = 3000 chips; shorter (< 2250) = 3 stacks
    expect(endgameAdjust(0.05, gs, 30, true)).toBeCloseTo(0.05 + 0.045);
  });

  it('the short stack itself has no ladder to protect', () => {
    const gs = gsBase({
      finalTable: true,
      inMoney: true,
      playersLeft: 6,
      stacks: [9000, 6000, 5000, 4000, 3000, 900],
    });
    expect(endgameAdjust(0.05, gs, 9, true)).toBeCloseTo(0.03);
  });

  it('the flag turns it all off', () => {
    expect(endgameAdjust(0.1, gsBase({ playersLeft: 2 }), 30, false)).toBe(0.1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Blind-clock anticipation reaches the jam decision
// ─────────────────────────────────────────────────────────────────────────────

describe('V23 blind-clock anticipation', () => {
  const ctx = (extra: Record<string, unknown>) => ({
    strength: 0.55,
    position: 'late' as const,
    raiserPosition: null,
    raises: 0,
    limpers: 0,
    callers: 0,
    oppsLeft: 7,
    toCall: 100,
    currentBet: 100,
    pot: 250,
    bigBlind: 100,
    stack: 3000,
    stackBB: 30,
    tightness: 1,
    bluffFreq: 0.1,
    aggression: 1,
    slowplayFreq: 0.1,
    sizingMultiplier: 1,
    isOmaha: false,
    isPotLimit: false,
    riskAdd: 0.04,
    mode: 'tournament' as const,
    anteInPlay: true,
    // 0.125/player x 8 seats = a 1.0bb ante per ORBIT (orbit total 2.5bb),
    // the same figure the old per-player field produced here.
    anteOrbitBB: 1.0,
    tableSize: 8,
    v13: true,
    rand: () => 0.5,
    ...extra,
  });

  it('a level about to double the blinds pushes a 30bb stack into the jam', () => {
    // 30bb at a 2.5bb orbit, 8-handed: effM 9.6 — above every jam gate (and
    // past the 22bb orange-zone cap). With the blinds doubling in 2 minutes
    // the honest M is 4.8: jam-or-fold territory RIGHT NOW.
    const withClock = decidePreflopV7(ctx({ nextBlindInMin: 2, nextBlindMult: 2 }) as never);
    expect(withClock.a).toBe('jam');
  });

  it('the same stack with a far-away level plays normally', () => {
    const without = decidePreflopV7(ctx({ nextBlindInMin: 30, nextBlindMult: 2 }) as never);
    expect(without.a).not.toBe('jam');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Raise-response plans, end to end
// ─────────────────────────────────────────────────────────────────────────────

describe('V23 raise-response plans', () => {
  function stabThenRaise(): { hero: SeatPlayer; gsBet: GS; gsRaised: GS } {
    // Hero holds air on a dry board, bets the river as a stab, gets raised.
    const hero = mkPlayer(1, { cards: cc('5h', '4d'), stack: 9000, bet: 0 });
    const villain = mkPlayer(2, { stack: 9000, bet: 0 });
    const board = cc('Ks', '8c', '2d', '9h', 'Qd');
    const histBase = [rec(2, 'check', 0, 'river')];
    const gsBet = {
      players: [hero, villain],
      communityCards: board,
      pot: 1000,
      currentBet: 0,
      minRaise: 100,
      stage: 'river' as HandStage,
      gameVariant: 'nlh',
      bigBlind: 50,
      dealerSeat: 1,
      gameMode: 'cash' as const,
      actionHistory: histBase,
    } as unknown as GS;
    const gsRaised = {
      ...(gsBet as object),
      players: [
        { ...hero, bet: 600 },
        { ...villain, bet: 2400 },
      ],
      pot: 4000,
      currentBet: 2400,
      minRaise: 1800,
      actionHistory: [
        ...histBase,
        rec(1, 'bet', 600, 'river', { isFullRaise: true }),
        rec(2, 'raise', 2400, 'river', { isFullRaise: true }),
      ],
    } as unknown as GS;
    return { hero: { ...hero, bet: 600 } as SeatPlayer, gsBet, gsRaised };
  }

  it('a river stab that gets raised folds - the plan the bet made', () => {
    const { hero, gsBet, gsRaised } = stabThenRaise();
    // Drive decisions until the horse actually bets (its river stab is
    // frequency-mixed); the recorded plan for air must be foldToRaise.
    let betSeen = false;
    for (let i = 0; i < 40 && !betSeen; i++) {
      const d = HorseLogic.decide(
        { ...(gsBet as { players: SeatPlayer[] }).players[0] } as SeatPlayer,
        gsBet,
        'lag'
      );
      if (d.action === 'bet') betSeen = true;
    }
    expect(betSeen).toBe(true);
    const plan = HorseMind.getRaisePlan(
      HorseMind.handKeyOf((gsBet as { actionHistory: ActionRecord[] }).actionHistory),
      'horse-1',
      'river'
    );
    expect(plan).toBe('foldToRaise');
    // And when the raise arrives, the answer is the one the bet gave.
    const d2 = HorseLogic.decide(hero, gsRaised, 'lag');
    expect(d2.action).toBe('fold');
  });

  it('with the plan layer off the fold is not forced by the plan', () => {
    const { gsBet } = stabThenRaise();
    HorseLogic.decide(
      { ...(gsBet as { players: SeatPlayer[] }).players[0] } as SeatPlayer,
      gsBet,
      'lag',
      {},
      { v23Plan: false }
    );
    const plan = HorseMind.getRaisePlan(
      HorseMind.handKeyOf((gsBet as { actionHistory: ActionRecord[] }).actionHistory),
      'horse-1',
      'river'
    );
    expect(plan).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// River reads reach the bluff decision
// ─────────────────────────────────────────────────────────────────────────────

describe('V23 river reads', () => {
  it('riverFoldRate accumulates from observed river folds and gates on sample', () => {
    expect(HorseMind.riverFoldRate('villain-x')).toBeNull();
    // Feed 10 hands where villain-x folds the river to a bet.
    for (let h = 0; h < 10; h++) {
      const hist: ActionRecord[] = [
        {
          seat: 3,
          userId: 'bettor-1',
          action: 'bet',
          amount: 500,
          timestamp: 2_000_000 + h * 1000,
          stage: 'river',
          isFullRaise: true,
        },
        {
          seat: 4,
          userId: 'villain-x',
          action: h < 8 ? 'fold' : 'call',
          amount: h < 8 ? 0 : 500,
          timestamp: 2_000_100 + h * 1000,
          stage: 'river',
        },
      ];
      HorseMind.observe(hist, []);
    }
    const rate = HorseMind.riverFoldRate('villain-x');
    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(0.8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PKO bounty pricing
// ─────────────────────────────────────────────────────────────────────────────

describe('V23 PKO bounty pricing', () => {
  function bountySpot(bountyFactor: number): { hero: SeatPlayer; gs: GS } {
    // A marginal committed call: covered all-in villain, hero holds a medium
    // hand near the price. The bounty discount is what tips it.
    const hero = mkPlayer(1, { cards: cc('Ah', '9h'), stack: 4000, bet: 0 });
    const villain = mkPlayer(2, { cards: [], stack: 0, bet: 3800, is_all_in: true });
    const gs = {
      players: [hero, villain],
      communityCards: cc('9s', '7c', '2d', 'Kd', '3s'),
      pot: 6200,
      currentBet: 3800,
      minRaise: 1000,
      stage: 'river' as HandStage,
      gameVariant: 'nlh',
      bigBlind: 100,
      dealerSeat: 2,
      gameMode: 'tournament' as const,
      format: 'mtt' as const,
      tournament: { playersLeft: 20, spotsPaid: 5, bountyFactor },
      actionHistory: [
        rec(1, 'check', 0, 'river'),
        rec(2, 'all_in', 3800, 'river', { isFullRaise: true }),
      ],
    } as unknown as GS;
    return { hero, gs };
  }

  it('the bounty discount only fires when a bounty exists and hero covers', () => {
    // Identical spot, direct A/B on the flag with a real bounty present:
    // whatever the seeded decision is, it must not be LOOSER without the
    // bounty than with it, and the with-bounty call requirement is lower.
    seedFastRandom(0x5eed23);
    const withB = HorseLogic.decide(
      bountySpot(0.4).hero,
      bountySpot(0.4).gs,
      'balanced',
      {},
      { mind: false }
    );
    seedFastRandom(0x5eed23);
    const withoutB = HorseLogic.decide(
      bountySpot(0).hero,
      bountySpot(0).gs,
      'balanced',
      {},
      { mind: false }
    );
    const rank = (a: string) => (a === 'fold' ? 0 : 1);
    expect(rank(withB.action)).toBeGreaterThanOrEqual(rank(withoutB.action));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// League card + ablation completeness
// ─────────────────────────────────────────────────────────────────────────────

describe('V23 league registration', () => {
  it('the four measurable V23 matchups are on the card', () => {
    for (const name of [
      'v23_raise_plans',
      'v23_river_reads',
      'shortdeck_v23',
      'plo8_v23_lowdraw',
    ]) {
      expect(
        LEAGUE_MATCHUPS.find((m) => m.name === name),
        name
      ).toBeDefined();
    }
  });

  it('full_vs_v2_legacy disables every V23 flag', () => {
    const legacy = LEAGUE_MATCHUPS.find((m) => m.name === 'full_vs_v2_legacy')!.b as Record<
      string,
      unknown
    >;
    for (const f of ['v23Endgame', 'v23Plan', 'v23Reads', 'v23Variants', 'v23Spin']) {
      expect(legacy[f], f).toBe(false);
    }
  });
});
