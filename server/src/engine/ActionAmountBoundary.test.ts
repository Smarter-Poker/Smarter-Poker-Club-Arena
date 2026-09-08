import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import { calculateBettingState, validateAction } from './PokerEngine.js';
import type { HandConfig, SeatPlayer } from '../types.js';

function hand() {
  const config = {
    tableId: 'amount-boundary',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
  } as HandConfig;
  const players = [1, 2, 3, 4].map((seat) => ({
    seat,
    user_id: 'u' + seat,
    username: 'P' + seat,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const controller = new HandController(config, players, 1);
  controller.start();
  return controller;
}
const money = (h: HandController) => {
  const s = h.getState();
  return {
    pot: s.pot,
    currentBet: s.currentBet,
    turn: s.currentPlayerSeat,
    players: s.players.map((p) => ({ stack: p.stack, bet: p.bet, totalInvested: p.totalInvested })),
    actions: s.actionHistory.length,
  };
};
describe('action amount is a finite smallest-unit value before money changes', () => {
  it.each([6.005, 6.001, 6.009, '6', null, NaN, Infinity, -Infinity])(
    'refuses raise amount %s without mutating the hand',
    (amount) => {
      const h = hand();
      const before = money(h);
      expect(h.performAction(4, 'raise', amount as number)).toBe(false);
      expect(money(h)).toEqual(before);
    }
  );
  it.each([6.001, 6.005, '6', null, NaN, Infinity, -Infinity])(
    'the shared validator rejects opening bet %s',
    (amount) => {
      const bs = calculateBettingState(3, 0, 0, 2, 2, false);
      expect(validateAction('bet', amount as number, 100, bs).valid).toBe(false);
    }
  );
  it('accepts representation noise but conserves exactly four 100-chip stacks', () => {
    const h = hand();
    expect(h.performAction(4, 'raise', 6.01 + Number.EPSILON)).toBe(true);
    const s = h.getState();
    expect(Math.round((s.pot + s.players.reduce((n, p) => n + p.stack, 0)) * 100)).toBe(40000);
  });
});
