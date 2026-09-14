import { performance } from 'node:perf_hooks';
/** Tournament review proposals remain diagnostic, separate from structural ICM. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  HorseLogic,
  resolveHorseStyle,
  tourneyStackoffLoad,
  tourneyLeakPremium,
  leakLoad,
  TOURNEY_STACKOFF_TAGS,
  type HorseGameStateV2,
  type HorseProfileMods,
} from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import type { Card, SeatPlayer, ActionRecord, HandStage } from '../types.js';

beforeEach(() => {
  seedFastRandom(0x41f);
  HorseMind.reset();
  drainFires();
});

const SUIT: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
function c(spec: string): Card {
  return { rank: spec.slice(0, -1) as Card['rank'], suit: SUIT[spec.slice(-1)] as Card['suit'] };
}
const cc = (...specs: string[]): Card[] => specs.map(c);

function mkPlayer(seat: number, overrides: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat,
    user_id: `horse-${seat}`,
    username: `Horse${seat}`,
    stack: 2000,
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
  return { seat, userId: `horse-${seat}`, action, amount, timestamp: 0, stage, ...extra };
}

/** Near the bubble of an MTT: hero (BB, 22bb) holds A9o facing a 3x open
 *  and a cold jam from a covering stack. */
function bubbleFacingJam(): { hero: SeatPlayer; gs: HorseGameStateV2 } {
  const history: ActionRecord[] = [
    rec(1, 'sb' as ActionRecord['action'], 50, 'preflop'),
    rec(2, 'bb' as ActionRecord['action'], 100, 'preflop'),
    rec(3, 'raise', 300, 'preflop', { isFullRaise: true }),
    rec(4, 'all_in', 2400, 'preflop', { isFullRaise: true }),
    rec(1, 'fold', 0, 'preflop'),
  ];
  const hero = mkPlayer(2, { cards: cc('Ah', '9c'), stack: 2100, bet: 100, totalInvested: 100 });
  const gs = {
    players: [
      mkPlayer(1, { is_folded: true }),
      hero,
      mkPlayer(3, { bet: 300, stack: 5000 }),
      mkPlayer(4, { bet: 2400, stack: 0, is_all_in: true }),
    ],
    communityCards: [],
    pot: 50 + 100 + 300 + 2400,
    currentBet: 2400,
    minRaise: 2100,
    stage: 'preflop' as HandStage,
    gameVariant: 'nlh',
    bigBlind: 100,
    dealerSeat: 4,
    gameMode: 'tournament' as const,
    format: 'mtt',
    tournament: {
      nearBubble: true,
      inMoney: false,
      playersLeft: 30,
      spotsPaid: 27,
      avgStackChips: 4000,
      stacks: [9000, 7000, 5000, 4200, 4000, 3500, 2200, 2100, 1500, 1200],
      payoutPct: [0.3, 0.2, 0.15, 0.1, 0.08, 0.06, 0.05, 0.03, 0.03],
    },
    actionHistory: history,
  } as unknown as HorseGameStateV2;
  return { hero, gs };
}

const TAGGED: HorseProfileMods = {
  leaksTournament: { preflop_stackoff: 7, coldcall_stackoff: 5 },
  leaksHandsTournament: 100,
};

describe('V41 tournament leak profile', () => {
  it('resolveHorseStyle carries the tournament share with its denominator', () => {
    const { mods } = resolveHorseStyle(
      {
        style: 'tag',
        leaks: { preflop_stackoff: 20 },
        leaksHands: 300,
        leaksTournament: { preflop_stackoff: 7, junk: 'x', neg: -1 },
        leaksHandsTournament: 100,
      },
      'h1'
    );
    expect(mods.leaksTournament).toEqual({ preflop_stackoff: 7 });
    expect(mods.leaksHandsTournament).toBe(100);
    expect(tourneyStackoffLoad(mods)).toBeCloseTo(0.07, 5);
  });

  it('the tournament family never falls back to the pooled (cash) map', () => {
    const { mods } = resolveHorseStyle({ leaks: { preflop_stackoff: 30 }, leaksHands: 100 }, 'h2');
    expect(tourneyStackoffLoad(mods)).toBe(0);
    expect(leakLoad(mods, TOURNEY_STACKOFF_TAGS, 'tournament')).toBe(0);
    expect(tourneyLeakPremium(mods)).toBe(0);
  });

  it('the unapplied premium proposal is capped at 0.03 and zero under the tagged bar', () => {
    expect(
      tourneyLeakPremium({ leaksTournament: { preflop_stackoff: 9 }, leaksHandsTournament: 100 })
    ).toBeCloseTo(0.0225, 5);
    expect(
      tourneyLeakPremium({ leaksTournament: { preflop_stackoff: 40 }, leaksHandsTournament: 100 })
    ).toBe(0.03);
    expect(
      tourneyLeakPremium({ leaksTournament: { preflop_stackoff: 5 }, leaksHandsTournament: 100 })
    ).toBe(0);
    expect(tourneyLeakPremium(undefined)).toBe(0);
  });

  it('does not add an observational survival premium to paired tournament decisions', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      for (let t = 1; t <= 80; t++) {
        const play = (mods: HorseProfileMods, opts = {}) => {
          seedFastRandom(t * 104729 + 7);
          HorseMind.reset();
          const { hero, gs } = bubbleFacingJam();
          return HorseLogic.decide(hero, gs, 'balanced', mods, opts);
        };
        const clean = play({});
        expect(play(TAGGED)).toEqual(clean);
        expect(play(TAGGED, { v41Leaks: false })).toEqual(clean);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it('records ignored historical reports in either format, never an applied ICM receipt', () => {
    enableBrainTelemetry();
    for (const cash of [false, true]) {
      const { hero, gs } = bubbleFacingJam();
      if (cash) {
        (gs as { gameMode: string }).gameMode = 'cash';
        (gs as { format: string }).format = 'cash';
        (gs as { tournament?: unknown }).tournament = undefined;
      }
      HorseLogic.decide(hero, gs, 'balanced', TAGGED, { telemetry: true });
      const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
      expect(fires.phase14_review_signal_ignored).toBe(1);
      expect(fires.v41_tourney_leak_read).toBeUndefined();
    }
  });
});
