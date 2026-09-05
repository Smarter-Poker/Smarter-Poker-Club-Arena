/**
 * V43 (2026-09-05) - THE MIND REMEMBERS TEMPO, AND THE FLEET STATE SAYS WHEN
 * A HORSE LAST ACTED
 *
 * From the deep audit: the action log has carried a timestamp on every
 * record and nothing read it; ca_horse_fleet_state.last_action_at was NULL
 * on all 1,000 rows while 564 said "seated".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/supabase/client.js', () => ({
  supabase: { rpc: vi.fn(async () => ({ data: 1, error: null })), from: vi.fn() },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind, SNAP_MS, TANK_MS } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import { LEAGUE_MATCHUPS } from '../benchmark/HorseLeague.js';
import {
  accumulateHorseNets,
  drainSeatTouches,
  drainHorseNets,
  drainHorsePlay,
  type HorseReviewInput,
} from '../services/HorseHandReview.js';
import type { Card, SeatPlayer, ActionRecord, HandStage } from '../types.js';

beforeEach(() => {
  seedFastRandom(0x43);
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
    user_id: `p-${seat}`,
    username: `P${seat}`,
    stack: 200,
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
  timestamp: number,
  extra: Partial<ActionRecord> = {}
): ActionRecord {
  return { seat, userId: `p-${seat}`, action, amount, timestamp, stage, ...extra };
}

/** A hand where p-3 bets 60 into 60 on the river `gapMs` after the previous
 *  action, and the showdown reveals `handName`. */
function riverBigBetHand(gapMs: number, handName: string) {
  const t0 = 1_700_000_000_000;
  const actions = [
    rec(2, 'bb' as ActionRecord['action'], 2, 'preflop', t0),
    rec(3, 'raise', 6, 'preflop', t0 + 2000, { isFullRaise: true }),
    rec(2, 'call', 4, 'preflop', t0 + 4000),
    rec(2, 'check', 0, 'flop', t0 + 6000),
    rec(3, 'bet', 8, 'flop', t0 + 8000, { isFullRaise: true }),
    rec(2, 'call', 8, 'flop', t0 + 10000),
    rec(2, 'check', 0, 'turn', t0 + 12000),
    rec(3, 'check', 0, 'turn', t0 + 14000),
    rec(2, 'check', 0, 'river', t0 + 16000),
    rec(3, 'bet', 60, 'river', t0 + 16000 + gapMs, { isFullRaise: true }),
    rec(2, 'call', 60, 'river', t0 + 16000 + gapMs + 3000),
  ];
  const showdown = [
    { user_id: 'p-3', mucked: false, hand_name: handName },
    { user_id: 'p-2', mucked: false, hand_name: 'pair' },
  ];
  return { actions, showdown };
}

describe('V43 tempo counters', () => {
  it('a snap river big bet that showed down is counted snap, a tanked one tank, a normal one neither', () => {
    for (let i = 0; i < 5; i++) {
      const h = riverBigBetHand(800, 'two pair');
      HorseMind.observeHandComplete(`t:snap${i}`, h.actions, 2, h.showdown);
    }
    for (let i = 0; i < 5; i++) {
      const h = riverBigBetHand(TANK_MS + 500, 'high card');
      HorseMind.observeHandComplete(`t:tank${i}`, h.actions, 2, h.showdown);
    }
    const h = riverBigBetHand(4000, 'flush');
    HorseMind.observeHandComplete('t:mid', h.actions, 2, h.showdown);
    const s = HorseMind.getStats('p-3')!;
    expect(s.bigBetSD).toBe(11);
    expect(s.snapBetSD).toBe(5);
    expect(s.snapBetSDStrong).toBe(5);
    expect(s.tankBetSD).toBe(5);
    expect(s.tankBetSDStrong).toBe(0);
    expect(HorseMind.snapBetValueTendency('p-3')).toBe(1);
    expect(HorseMind.tankBetValueTendency('p-3')).toBe(0);
    expect(SNAP_MS).toBe(1500);
  });

  it('below five observations the tendency is null, and a record without a timestamp is not classed', () => {
    for (let i = 0; i < 4; i++) {
      const h = riverBigBetHand(500, 'two pair');
      HorseMind.observeHandComplete(`t:few${i}`, h.actions, 2, h.showdown);
    }
    expect(HorseMind.snapBetValueTendency('p-3')).toBeNull();
    const h = riverBigBetHand(500, 'two pair');
    const stripped = h.actions.map((a) => ({ ...a, timestamp: undefined as unknown as number }));
    HorseMind.observeHandComplete('t:nots', stripped, 2, h.showdown);
    expect(HorseMind.getStats('p-3')!.snapBetSD).toBe(4);
    expect(HorseMind.getStats('p-3')!.bigBetSD).toBe(5);
  });
});

/** Hero (p-2) faces p-3's pot-sized river bet made `gapMs` after hero's check. */
function facingRiverBet(gapMs: number): { hero: SeatPlayer; gs: HorseGameStateV2 } {
  const t0 = 1_700_000_100_000;
  const history: ActionRecord[] = [
    rec(2, 'bb' as ActionRecord['action'], 2, 'preflop', t0),
    rec(3, 'raise', 6, 'preflop', t0 + 2000, { isFullRaise: true }),
    rec(2, 'call', 4, 'preflop', t0 + 4000),
    rec(2, 'check', 0, 'flop', t0 + 6000),
    rec(3, 'bet', 8, 'flop', t0 + 8000, { isFullRaise: true }),
    rec(2, 'call', 8, 'flop', t0 + 10000),
    rec(2, 'check', 0, 'turn', t0 + 12000),
    rec(3, 'check', 0, 'turn', t0 + 14000),
    rec(2, 'check', 0, 'river', t0 + 16000),
    rec(3, 'bet', 28, 'river', t0 + 16000 + gapMs, { isFullRaise: true }),
  ];
  const hero = mkPlayer(2, { cards: cc('Qd', '7c'), stack: 186, totalInvested: 14 });
  const gs = {
    players: [mkPlayer(1, { is_folded: true }), hero, mkPlayer(3, { bet: 28, stack: 158 })],
    communityCards: cc('Kh', '7s', '4d', '2c', '9h'),
    pot: 28 + 28,
    currentBet: 28,
    minRaise: 28,
    stage: 'river' as HandStage,
    gameVariant: 'nlh',
    bigBlind: 2,
    dealerSeat: 3,
    gameMode: 'cash' as const,
    format: 'cash',
    actionHistory: history,
  } as unknown as HorseGameStateV2;
  return { hero, gs };
}

function callRate(gapMs: number, trials = 60): number {
  let calls = 0;
  for (let t = 1; t <= trials; t++) {
    seedFastRandom(t * 7919 + 43);
    const { hero, gs } = facingRiverBet(gapMs);
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, {});
    if (d.action === 'call' || d.action === 'raise' || d.action === 'all_in') calls++;
  }
  return calls / trials;
}

describe('V43 tempo read - a river big bet is priced by its tempo', () => {
  it('against a player whose snap bets show down as air, the horse calls the snap bet more', () => {
    // learn: five snap river bets, all air
    for (let i = 0; i < 6; i++) {
      const h = riverBigBetHand(700, 'high card');
      HorseMind.observeHandComplete(`t:air${i}`, h.actions, 2, h.showdown);
    }
    const snap = callRate(700);
    const normal = callRate(4000);
    expect(snap).toBeGreaterThanOrEqual(normal);
    enableBrainTelemetry();
    const { hero, gs } = facingRiverBet(700);
    HorseLogic.decide(hero, gs, 'balanced', {}, { telemetry: true });
    const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(fires.v43_tempo_read ?? 0).toBeGreaterThan(0);
    // a mid-tempo bet reads nothing
    const mid = facingRiverBet(4000);
    HorseLogic.decide(mid.hero, mid.gs, 'balanced', {}, { telemetry: true });
    const none = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(none.v43_tempo_read ?? 0).toBe(0);
  });

  it('with the flag off the read is silent', () => {
    for (let i = 0; i < 6; i++) {
      const h = riverBigBetHand(700, 'high card');
      HorseMind.observeHandComplete(`t:off${i}`, h.actions, 2, h.showdown);
    }
    enableBrainTelemetry();
    const { hero, gs } = facingRiverBet(700);
    HorseLogic.decide(hero, gs, 'balanced', {}, { telemetry: true, v43Tempo: false });
    const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(fires.v43_tempo_read ?? 0).toBe(0);
  });

  it('is switched off in full_vs_v2_legacy', () => {
    const legacy = LEAGUE_MATCHUPS.find((m) => m.name === 'full_vs_v2_legacy')!.b as Record<
      string,
      unknown
    >;
    expect(legacy.v43Tempo).toBe(false);
  });
});

function input(over: Partial<HorseReviewInput> = {}): HorseReviewInput {
  return {
    handId: 'h-1',
    tableId: 'table-A',
    tournamentId: null,
    clubId: null,
    gameVariant: 'nlh',
    bigBlind: 2,
    playedAt: '2026-09-05T12:00:00.000Z',
    potSize: 40,
    board: null,
    holeCardsAll: new Map([
      ['horse-a', { seat: 1, cards: [] }],
      ['human-1', { seat: 3, cards: [] }],
    ]),
    contributions: new Map([
      ['horse-a', 10],
      ['human-1', 4],
    ]),
    winners: [{ userId: 'horse-a', amount: 14 }],
    actions: [],
    roster: [
      { userId: 'horse-a', isHorse: true },
      { userId: 'human-1', isHorse: false },
    ],
    ...over,
  };
}

describe('the seat touch - settlement tells the fleet state a horse acted', () => {
  it('accumulates hands per horse per table with the newest settlement time, horses only', () => {
    drainSeatTouches(10_000);
    drainHorseNets(10_000);
    drainHorsePlay(10_000);
    accumulateHorseNets(input());
    accumulateHorseNets(input({ handId: 'h-2', playedAt: '2026-09-05T12:00:30.000Z' }));
    accumulateHorseNets(
      input({ handId: 'h-3', tableId: 'table-B', playedAt: '2026-09-05T12:00:10.000Z' })
    );
    const rows = drainSeatTouches().sort((a, b) => a.table_id.localeCompare(b.table_id));
    expect(rows).toEqual([
      { horse_id: 'horse-a', table_id: 'table-A', hands: 2, at: '2026-09-05T12:00:30.000Z' },
      { horse_id: 'horse-a', table_id: 'table-B', hands: 1, at: '2026-09-05T12:00:10.000Z' },
    ]);
    expect(drainSeatTouches()).toEqual([]);
  });
});
