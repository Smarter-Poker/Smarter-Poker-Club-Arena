import { describe, expect, it, vi } from 'vitest';
import { HandController } from './HandController.js';
import { fixedLimitStreetBounds } from './BettingStructure.js';
import type { HandConfig, SeatPlayer } from '../types.js';

function flop(variant: 'flh' | 'flo8', stacks: number[]) {
  const players = stacks.map((stack, i) => ({
    seat: i + 1,
    user_id: `limit-${i}`,
    username: `P${i}`,
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const hc = new HandController(
    {
      tableId: 'limit-completion',
      handNumber: 1,
      gameVariant: variant,
      smallBlind: 10,
      bigBlind: 20,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  hc.start();
  for (const action of ['call', 'call', 'check'] as const) {
    expect(hc.performAction(hc.getState().currentPlayerSeat!, action)).toBe(true);
  }
  expect(hc.getState().stage).toBe('flop');
  return hc;
}

describe.each(['flh', 'flo8'] as const)('%s fixed-limit completion', (variant) => {
  it.each([1, 5, 9.99])('completes a short opening %s to 20', (short) => {
    const hc = flop(variant, [500, 20 + short, 500]);
    expect(hc.performAction(2, 'all_in')).toBe(true);
    expect(hc.performAction(3, 'raise', 20)).toBe(true);
    expect(hc.getState().currentBet).toBe(20);
  });
  it.each([10, 15, 19.99])('raises a half-or-more opening %s by a full 20', (short) => {
    const hc = flop(variant, [500, 20 + short, 500]);
    expect(hc.performAction(2, 'all_in')).toBe(true);
    expect(hc.performAction(3, 'raise', short + 20)).toBe(true);
    expect(hc.getState().currentBet).toBeCloseTo(short + 20, 2);
  });
  it('completes a short raise from 20 to 25 up to 40', () => {
    const hc = flop(variant, [500, 500, 45]);
    expect(hc.performAction(2, 'bet', 20)).toBe(true);
    expect(hc.performAction(3, 'all_in')).toBe(true);
    expect(hc.performAction(1, 'raise', 40)).toBe(true);
    expect(hc.getState().currentBet).toBe(40);
  });
});

describe.each(['flh', 'flo8'] as const)('%s completion integration', (variant) => {
  it('counts a half-bet opening toward the four-wager cap', () => {
    const hc = flop(variant, [500, 30, 500]);
    expect(hc.performAction(2, 'all_in')).toBe(true);
    for (const amount of [30, 50, 70])
      expect(hc.performAction(hc.getState().currentPlayerSeat!, 'raise', amount)).toBe(true);
    expect(hc.performAction(hc.getState().currentPlayerSeat!, 'raise', 90)).toBe(false);
  });
  it('clamps a deep shove to a completion without spending the entire stack', () => {
    const hc = flop(variant, [500, 25, 500]);
    expect(hc.performAction(2, 'all_in')).toBe(true);
    expect(hc.performAction(3, 'all_in')).toBe(true);
    const state = hc.getState();
    expect(state.currentBet).toBe(20);
    expect(state.players.find((p) => p.seat === 3)!.stack).toBe(460);
  });
  it('does not reopen a previous bettor facing less than half', () => {
    const hc = flop(variant, [500, 500, 45]);
    expect(hc.performAction(2, 'bet', 20)).toBe(true);
    expect(hc.performAction(3, 'all_in')).toBe(true);
    expect(hc.performAction(1, 'call')).toBe(true);
    expect(hc.performAction(2, 'raise', 40)).toBe(false);
    expect(hc.performAction(2, 'call')).toBe(true);
  });
});

it('accumulates short increases relative to the last counted wager', () => {
  const actions = [20, 25, 28].map((amount) => ({
    action: 'all_in' as const,
    amount,
    stage: 'flop' as const,
    seat: 1,
    userId: 'test',
    timestamp: 0,
  }));
  expect(fixedLimitStreetBounds(actions, 'flop', 20, 28)).toEqual({ raiseSize: 12, wagers: 1 });
  actions.push({ ...actions[0], amount: 31 });
  expect(fixedLimitStreetBounds(actions, 'flop', 20, 31)).toEqual({ raiseSize: 20, wagers: 2 });
});

vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { ServerTableEngine } = await import('./ServerTableEngine.js');
it.each(['flh', 'flo8'] as const)(
  '%s publishes completion bounds in HTTP, live snapshots and actions',
  async (variant) => {
    const hc = flop(variant, [500, 25, 500]);
    expect(hc.performAction(2, 'all_in')).toBe(true);
    const engine = new ServerTableEngine('limit-completion') as any;
    engine.handController = hc;
    engine.tableInfo = { game_variant: variant, big_blind: 20, small_blind: 10, max_players: 3 };
    engine.showHandCards = new Map();
    engine.hub = { publish: vi.fn(), emitEvent: vi.fn() };
    expect(engine.getPlayerActions('limit-2')).toMatchObject({
      minRaise: 20,
      maxRaise: 20,
      betSize: 20,
    });
    expect(engine.getTableState('limit-2')).toMatchObject({
      fixed_bet_size: 20,
      fixed_raise_size: 15,
    });
    await engine.broadcastCurrentState();
    expect(engine.hub.publish.mock.calls.at(-1)[1]).toMatchObject({
      fixed_bet_size: 20,
      fixed_raise_size: 15,
    });
  }
);
