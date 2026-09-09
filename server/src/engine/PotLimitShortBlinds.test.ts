import { describe, expect, it, vi } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, SeatPlayer } from '../types.js';

function hand(variant: string, sb: number, bb: number, ante = 0) {
  const hc = new HandController(
    {
      tableId: 'pot-short-blinds',
      handNumber: 1,
      gameVariant: variant,
      smallBlind: 1,
      bigBlind: 2,
      ante,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    [100, sb, bb, 100].map((stack, i) => ({
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
    })) as SeatPlayer[],
    1
  );
  hc.start();
  return hc;
}

// TDA 54B: assume full SB/BB for preflop pot-limit calculations. The
// missing blind chips never become money in the pot or side-pot eligibility.
describe.each(['plo4', 'plo5', 'plo6', 'plo8'])('%s short blinds', (variant) => {
  it.each([
    [100, 0.5, 1.5],
    [0.25, 100, 2.25],
    [0.25, 0.5, 0.75],
  ])('SB stack %s, BB stack %s: opening maximum is 7', (sb, bb, actualPot) => {
    const hc = hand(variant, sb, bb);
    const start = hc.getState().players.reduce((n, p) => n + p.stack, actualPot);
    expect(hc.getState().pot).toBe(actualPot);
    expect(hc.performAction(4, 'raise', 7.01)).toBe(false);
    expect(hc.getState().pot).toBe(actualPot);
    expect(hc.performAction(4, 'raise', 7)).toBe(true);
    expect(hc.getState().pot).toBe(actualPot + 7);
    expect(hc.getState().players.reduce((n, p) => n + p.stack, hc.getState().pot)).toBe(start);
  });
  it('counts a limper on top of full nominal blinds', () => {
    const hc = hand(variant, 100, 0.5);
    expect(hc.performAction(4, 'call')).toBe(true);
    expect(hc.performAction(1, 'raise', 9.01)).toBe(false);
    expect(hc.performAction(1, 'raise', 9)).toBe(true);
  });
  it('clamps a deep shove to 7 and leaves the remaining stack', () => {
    const hc = hand(variant, 100, 0.5);
    expect(hc.performAction(4, 'all_in')).toBe(true);
    expect(hc.getState().currentBet).toBe(7);
    expect(hc.getState().players.find((p) => p.seat === 4)!.stack).toBe(93);
  });
  it('uses actual individual antes plus full blinds when an ante exhausts the BB', () => {
    const hc = hand(variant, 100, 0.5, 1);
    expect(hc.getState().pot).toBe(4.5); // 3.5 ante + 1 SB, BB paid zero.
    expect(hc.performAction(4, 'raise', 10.51)).toBe(false);
    expect(hc.performAction(4, 'raise', 10.5)).toBe(true);
  });
  it('drops the nominal adjustment after preflop and conserves all chips at showdown', () => {
    const hc = hand(variant, 100, 0.5);
    for (let n = 0; n < 3; n++) {
      expect(hc.performAction(hc.getState().currentPlayerSeat, 'call')).toBe(true);
    }
    expect(hc.getState().stage).toBe('flop');
    expect(hc.getState().pot).toBe(6.5);
    const seat = hc.getState().currentPlayerSeat;
    expect(hc.performAction(seat, 'bet', 6.51)).toBe(false);
    expect(hc.performAction(seat, 'bet', 6.5)).toBe(true);
    for (let n = 0; n < 20 && hc.getState().stage !== 'showdown'; n++) {
      const s = hc.getState();
      const p = s.players.find((p) => p.seat === s.currentPlayerSeat)!;
      expect(hc.performAction(p.seat, p.bet < s.currentBet ? 'call' : 'check')).toBe(true);
    }
    expect(hc.getState().stage).toBe('showdown');
    expect(hc.getState().players.reduce((n, p) => n + p.stack, 0)).toBeCloseTo(300.5, 2);
  });
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

it('publishes the same maximum through actions, HTTP and live state without inflating the pot', async () => {
  const hc = hand('plo4', 100, 0.5);
  const engine = new ServerTableEngine('pot-short-blinds') as any;
  engine.handController = hc;
  engine.tableInfo = { game_variant: 'plo4', big_blind: 2, small_blind: 1, max_players: 4 };
  engine.showHandCards = new Map();
  engine.hub = { publish: vi.fn(), emitEvent: vi.fn() };
  try {
    expect(engine.getPlayerActions('p4')).toMatchObject({ minRaise: 4, maxRaise: 7, pot: 1.5 });
    expect(engine.getTableState('p4')).toMatchObject({ pot: 1.5, pot_limit_pot: 3 });
    await engine.broadcastCurrentState();
    expect(engine.hub.publish.mock.calls.at(-1)[1]).toMatchObject({ pot: 1.5, pot_limit_pot: 3 });
    engine.lifecycleCanMutate = () => true;
    engine.requestSnapshot = vi.fn();
    engine.turnFSM.transition('timer_running');
    expect(engine.handlePlayerAction('p4', 'raise', 99)).toMatchObject({ success: true });
    expect(hc.getState().currentBet).toBe(7);
    expect(hc.getState().pot).toBe(8.5);
  } finally {
    engine.preciseTimer?.dispose();
  }
});
