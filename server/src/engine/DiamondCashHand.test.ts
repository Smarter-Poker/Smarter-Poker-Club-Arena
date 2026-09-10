import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandController } from './HandController.js';
import { Deck } from './PokerEngine.js';
import type { Card, HandConfig, HandEvent, SeatPlayer } from '../types.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function config(overrides: Partial<HandConfig> = {}): HandConfig {
  return {
    asset: 'diamonds',
    tableId: 'diamond-cash-certification',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    ...overrides,
  };
}
function players(stacks = [100, 100, 100]): SeatPlayer[] {
  return stacks.map((stack, i) => ({
    seat: i + 1,
    user_id: `p${i + 1}`,
    username: `P${i + 1}`,
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
}
function royalBoard(): void {
  const cards: Card[] = [
    { rank: '2', suit: 'clubs' },
    { rank: '3', suit: 'clubs' },
    { rank: '4', suit: 'clubs' },
    { rank: '5', suit: 'clubs' },
    { rank: '6', suit: 'clubs' },
    { rank: '7', suit: 'clubs' },
    ...(['T', 'J', 'Q', 'K', 'A'] as const).map((rank) => ({ rank, suit: 'hearts' as const })),
  ];
  vi.spyOn(Deck.prototype, 'deal').mockImplementation((count = 1) => {
    if (cards.length < count) throw new Error('Certification Deck Exhausted');
    return cards.splice(0, count);
  });
}
function finish(hc: HandController): void {
  for (let step = 0; step < 25 && hc.getState().stage !== 'showdown'; step++) {
    const state = hc.getState();
    const player = state.players.find((p) => p.seat === state.currentPlayerSeat);
    if (!player || player.is_all_in) {
      hc.continueRunout();
      continue;
    }
    expect(hc.performAction(player.seat, player.bet < state.currentBet ? 'call' : 'check')).toBe(
      true
    );
  }
  expect(hc.getState().stage).toBe('showdown');
}

describe('Diamond cash uses the shared NLH controller with indivisible units', () => {
  it('rejects fractional betting before any state mutation and still accepts a legal raise', () => {
    const hc = new HandController(config(), players(), 1);
    hc.start();
    const before = hc.getState();
    expect(hc.performAction(before.currentPlayerSeat, 'raise', 4.5)).toBe(false);
    expect(hc.getState()).toEqual(before);
    expect(hc.performAction(before.currentPlayerSeat, 'raise', 4)).toBe(true);
    finish(hc);
    expect(hc.getState().players.reduce((sum, p) => sum + p.stack, 0)).toBe(300);
  });
  it('pays an odd tied pot in whole Diamonds clockwise from the button', () => {
    royalBoard();
    const hc = new HandController(config({ ante: 1 }), players(), 1);
    const events: HandEvent[] = [];
    hc.onEvent((event) => events.push(event));
    hc.start();
    expect(hc.performAction(1, 'fold')).toBe(true);
    finish(hc);
    const awards = events
      .filter((event) => event.type === 'WINNERS')
      .flatMap((event) => event.winners);
    expect(awards.map((w) => w.amount).sort()).toEqual([3, 4]);
    expect(awards.find((w) => w.userId === 'p2')?.amount).toBe(4);
    expect(hc.getState().players.reduce((sum, p) => sum + p.stack, 0)).toBe(300);
    expect(hc.getState().players.every((p) => Number.isInteger(p.stack))).toBe(true);
    expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
  });
  it('settles multi-user all-ins and side pots once, including uncalled money', () => {
    royalBoard();
    const hc = new HandController(config(), players([5, 8, 11]), 1);
    const events: HandEvent[] = [];
    hc.onEvent((event) => events.push(event));
    hc.start();
    for (let step = 0; step < 3; step++) {
      expect(hc.performAction(hc.getState().currentPlayerSeat, 'all_in')).toBe(true);
    }
    hc.continueRunout();
    expect(hc.getState().stage).toBe('showdown');
    expect(hc.getState().players.map((p) => p.stack)).toEqual([5, 8, 11]);
    expect(hc.getState().pots.length).toBeGreaterThan(1);
    hc.continueRunout();
    expect(hc.getState().players.map((p) => p.stack)).toEqual([5, 8, 11]);
    expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
  });
  it.each([0.5, NaN, Infinity, -1])('refuses invalid funded stack %s before dealing', (stack) => {
    expect(() => new HandController(config(), players([stack, 100, 100]), 1)).toThrow(
      'Whole Units'
    );
  });
  it('refuses fractional blinds and unapproved deductions before dealing', () => {
    expect(() => new HandController(config({ smallBlind: 0.5 }), players(), 1)).toThrow(
      'Whole Units'
    );
    expect(
      () =>
        new HandController(
          config({ rakeConfig: { percent: 5, cap: 3, noFlopNoDrop: true } }),
          players(),
          1
        )
    ).toThrow('No Deductions');
  });
  it('rejects a fractional external delta atomically before applying any entry', () => {
    const hc = new HandController(config(), players(), 1);
    const before = hc.getState();
    expect(() =>
      hc.applyStackDeltas(
        new Map([
          ['p1', 1],
          ['p2', -0.5],
        ])
      )
    ).toThrow('Whole Units');
    expect(hc.getState()).toEqual(before);
  });
  it('preserves cent-denominated chip betting', () => {
    const hc = new HandController(
      config({ asset: 'chips', smallBlind: 0.5, bigBlind: 1 }),
      players(),
      1
    );
    hc.start();
    expect(hc.performAction(hc.getState().currentPlayerSeat, 'raise', 2.5)).toBe(true);
    finish(hc);
    expect(hc.getState().players.reduce((sum, p) => sum + p.stack, 0)).toBe(300);
  });
});
