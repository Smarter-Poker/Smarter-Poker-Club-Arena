import { beforeEach, describe, expect, it, vi } from 'vitest';

const alerts = vi.hoisted(() => ({ raised: [] as unknown[], resolved: [] as unknown[] }));
vi.mock('../services/engineAlerts.js', () => ({
  raiseEngineAlert: vi.fn(async (input: unknown) => {
    alerts.raised.push(input);
    return true;
  }),
  resolveEngineAlert: vi.fn(async (...args: unknown[]) => {
    alerts.resolved.push(args);
    return true;
  }),
}));

import {
  __resetHorseRiverValueAlarm,
  auditHorseRiverValue,
  horseRiverValueAlarmSnapshot,
  observeCommittedHandRiverValue,
  RIVER_VALUE_ALERT,
  type RiverValueAuditInput,
} from './HorseRiverValueAudit.js';

const SUITS = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const;
const cards = (s: string) =>
  s.split(' ').map((c) => ({ rank: c[0], suit: SUITS[c[1] as keyof typeof SUITS] }));

type Seat = [number, number, number, number, number, number, number];
function node(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    status: 'captured',
    variant: 'plo5',
    mode: 'cash',
    asset: 'chips',
    chipUnit: 0.01,
    street: 'river',
    dealerSeat: 4,
    actorSeat: 2,
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    anteType: 'per_player',
    allInOrFold: false,
    bombPot: false,
    boardCount: 1,
    boards: ['2d3s6sJh4d'],
    pot: 169,
    currentBet: 50,
    toCall: 50,
    structure: 'pot_limit',
    minRaiseTo: 100,
    maxRaiseTo: 269,
    fixedBetSize: null,
    wagersCapped: false,
    legalActions: ['fold', 'call', 'raise', 'all_in'],
    seats: [
      [2, 275.5, 0, 60, 0, 0, 0],
      [4, 640.7, 50, 110, 0, 0, 0],
    ] as Seat[],
    ...over,
  } as never;
}

// Hand 44826179: muckGhost (seat 2) holds the nut straight 7c5d on 2d3s6sJh4d.
function hand(
  action: string,
  amount: number | undefined,
  over: Record<string, unknown> = {},
  hole = '7c 5d Ac Kh Qh',
  origin = 'horse_policy'
): RiverValueAuditInput {
  return {
    variant: 'plo5',
    holeCards: new Map([['horse', { seat: 2, cards: cards(hole) }]]),
    actions: [{ seat: 2, userId: 'horse', action, amount, origin, publicNode: node(over) }],
  };
}

const checkedTo = {
  currentBet: 0,
  toCall: 0,
  minRaiseTo: 2,
  maxRaiseTo: 169,
  legalActions: ['fold', 'check', 'bet', 'all_in'],
  seats: [
    [2, 275.5, 0, 60, 0, 0, 0],
    [4, 690.7, 0, 60, 0, 0, 0],
  ],
};

describe('horse river value alarm: what it catches', () => {
  it('catches the production nut flat-call (hand 44826179)', () => {
    const { findings, riverActionsAudited } = auditHorseRiverValue(hand('call', 50));
    expect(riverActionsAudited).toBe(1);
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'nut_call_with_legal_raise', target: 269, seat: 2 }),
    ]);
  });

  it('catches a nut check when a bet is legal and an opponent can act', () => {
    const { findings } = auditHorseRiverValue(hand('check', undefined, checkedTo));
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'nut_check_with_legal_bet', target: 169 }),
    ]);
  });

  it('catches an under-sized nut raise (hand 45000112 shape) and an under-sized nut bet', () => {
    expect(auditHorseRiverValue(hand('raise', 125)).findings).toEqual([
      expect.objectContaining({ kind: 'nut_wager_undersized', amount: 125, target: 269 }),
    ]);
    expect(auditHorseRiverValue(hand('bet', 60, checkedTo)).findings).toEqual([
      expect.objectContaining({ kind: 'nut_wager_undersized', amount: 60, target: 169 }),
    ]);
  });

  it('catches a 90-99% pot wager that could legally have been the full pot, on any street', () => {
    const flop = {
      street: 'flop',
      boards: ['2d3s6s'],
      pot: 100,
      currentBet: 0,
      toCall: 0,
      minRaiseTo: 2,
      maxRaiseTo: 100,
      legalActions: ['check', 'bet'],
    };
    expect(auditHorseRiverValue(hand('bet', 95, flop)).findings).toEqual([
      expect.objectContaining({ kind: 'near_pot_wager_not_full_pot', target: 100 }),
    ]);
    expect(auditHorseRiverValue(hand('bet', 100, flop)).findings).toEqual([]);
    expect(auditHorseRiverValue(hand('bet', 80, flop)).findings).toEqual([]);
  });
});

describe('horse river value alarm: what it never flags', () => {
  it.each([
    ['a full-size nut raise', hand('raise', 269)],
    ['a full-size nut bet', hand('bet', 169, checkedTo)],
    ['a weaker hand that calls', hand('call', 50, {}, 'Ac Kh Qh Td 9c')],
    ['a human player', hand('call', 50, {}, '7c 5d Ac Kh Qh', 'player')],
    [
      'nobody left who can act',
      hand('check', undefined, {
        ...checkedTo,
        seats: [
          [2, 275.5, 0, 60, 0, 0, 0],
          [4, 0, 0, 750, 0, 0, 2],
        ],
      }),
    ],
    ['a capped street', hand('call', 50, { wagersCapped: true })],
    ['no raise on the menu', hand('call', 50, { legalActions: ['fold', 'call'] })],
    [
      'nuts on only one of two boards',
      hand('call', 50, { boardCount: 2, boards: ['2d3s6sJh4d', 'AsAdTc9c8c'] }),
    ],
  ])('%s', (_name, input) => {
    expect(auditHorseRiverValue(input).findings).toEqual([]);
  });

  it('respects the table commitment cap when pricing the full pot', () => {
    const flop = {
      street: 'flop',
      boards: ['2d3s6s'],
      pot: 100,
      currentBet: 0,
      toCall: 0,
      minRaiseTo: 2,
      maxRaiseTo: 100,
      legalActions: ['check', 'bet'],
      seats: [
        [2, 275.5, 0, 60, 0, 0, 0],
        [4, 690.7, 0, 60, 0, 0, 0],
      ],
    };
    const input = { ...hand('bet', 95, flop), capEnabled: true, capBb: 77, bigBlind: 2 };
    // 77 BB cap = 154 total; 60 already in, so only 94 more is allowed: 95 is the max.
    expect(auditHorseRiverValue(input).findings).toEqual([]);
  });
});

describe('horse river value alarm: delivery', () => {
  beforeEach(() => {
    __resetHorseRiverValueAlarm();
    alerts.raised.length = 0;
    alerts.resolved.length = 0;
  });

  it('fires once with the hand named, then resolves after a clean day', () => {
    const ctx = { tableId: 't-1', handNumber: 44826179 };
    observeCommittedHandRiverValue(ctx, hand('call', 50), 1_000);
    observeCommittedHandRiverValue({ ...ctx, handNumber: 44867615 }, hand('call', 50), 2_000);
    expect(alerts.raised).toHaveLength(1);
    expect(alerts.raised[0]).toMatchObject({
      alertname: RIVER_VALUE_ALERT,
      labels: { kind: 'nut_call_with_legal_raise', hand_number: '44826179', table_id: 't-1' },
    });
    observeCommittedHandRiverValue(ctx, hand('raise', 269), 2_000 + 60_000);
    expect(alerts.resolved).toHaveLength(0);
    observeCommittedHandRiverValue(ctx, hand('raise', 269), 2_000 + 24 * 3600_000);
    expect(alerts.resolved).toHaveLength(1);
    expect(horseRiverValueAlarmSnapshot()).toMatchObject({ firing: false, findingsTotal: 2 });
  });

  it('never throws on malformed input', () => {
    const bad = { variant: 'plo5', holeCards: null, actions: [{}] } as never;
    expect(observeCommittedHandRiverValue({ tableId: 't', handNumber: 1 }, bad)).toEqual([]);
  });
});
