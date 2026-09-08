import { it, expect } from 'vitest';
import { HandController } from './HandController.js';
import type { Card, HandConfig, HandEvent, SeatPlayer } from '../types.js';

it('BX01: folded contributions remain, unmatched chips return once, each pot has its own winner', () => {
  const events: HandEvent[] = [];
  const players = [100, 250, 600, 500].map((stack, i) => ({
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
  })) as SeatPlayer[];
  const hc = new HandController(
    {
      tableId: 'bx01',
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  hc.onEvent((e) => events.push(e));
  hc.start();
  expect(hc.performAction(4, 'raise', 100)).toBe(true);
  expect(hc.performAction(1, 'all_in')).toBe(true);
  expect(hc.performAction(2, 'all_in')).toBe(true);
  expect(hc.performAction(3, 'raise', 400)).toBe(true);
  expect(hc.performAction(4, 'all_in')).toBe(true);
  expect(hc.performAction(3, 'fold')).toBe(true);
  expect(
    events
      .filter((e) => e.type === 'UNCALLED_BET_RETURNED')
      .map((e) => (e as { amount: number }).amount)
  ).toEqual([100]);
  expect(hc.getPot()).toBe(1150);
  expect(hc.computeLivePots()).toEqual([
    { amount: 400, eligiblePlayers: ['p1', 'p2', 'p4'] },
    { amount: 450, eligiblePlayers: ['p2', 'p4'] },
    { amount: 300, eligiblePlayers: ['p4'] },
  ]);
  expect(hc.settleUncalledBet()).toBe(0);
  for (let i = 0; i < 3; i++) hc.dealNextStreet();
  const c = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });
  const state = (hc as unknown as { state: { players: SeatPlayer[]; communityCards: Card[] } })
    .state;
  state.communityCards = [
    c('2', 'spades'),
    c('3', 'hearts'),
    c('7', 'clubs'),
    c('9', 'spades'),
    c('J', 'clubs'),
  ];
  state.players[0].cards = [c('A', 'hearts'), c('A', 'diamonds')];
  state.players[1].cards = [c('K', 'hearts'), c('K', 'diamonds')];
  state.players[3].cards = [c('Q', 'hearts'), c('Q', 'diamonds')];
  hc.finalizeRunout();
  const win = events.find((e) => e.type === 'WINNERS') as Extract<HandEvent, { type: 'WINNERS' }>;
  expect(Object.fromEntries(win.winners.map((w) => [w.userId, w.amount]))).toEqual({
    p1: 400,
    p2: 450,
    p4: 300,
  });
  expect(state.players.map((p) => p.stack)).toEqual([400, 450, 200, 400]);
  expect(state.players.reduce((s, p) => s + p.stack, 0)).toBe(1450);
  expect(events.filter((e) => e.type === 'UNCALLED_BET_RETURNED')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'HAND_COMPLETE')).toHaveLength(1);
});
