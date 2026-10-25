import { afterEach, describe, expect, it } from 'vitest';
import { HandController } from './HandController.js';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

function game(bomb = false, stacks = [400, 400, 400, 400, 400, 400]) {
  const players = stacks.map((stack, i) => ({
    seat: i + 1,
    user_id: `madness-${i}`,
    username: `Seat ${i + 1}`,
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const config: HandConfig = {
    tableId: 'madness-qualification',
    handNumber: 1,
    gameVariant: 'plo5',
    smallBlind: 1,
    bigBlind: 2,
    ante: 2,
    bigBlindAnte: true,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    ...(bomb ? { bombPot: { anteMultiplier: 3, doubleBoard: true } } : {}),
  };
  const controller = new HandController(config, players, 1);
  const events: HandEvent[] = [];
  controller.onEvent((e) => events.push(e));
  controller.start();
  return { controller, events, total: stacks.reduce((a, b) => a + b, 0) };
}
function finish(h: ReturnType<typeof game>) {
  for (let step = 0; step < 100 && !h.events.some((e) => e.type === 'HAND_COMPLETE'); step++) {
    const s = h.controller.getState();
    const p = s.players.find((p) => p.seat === s.currentPlayerSeat)!;
    expect(p, 'the hand must retain an actionable seat').toBeDefined();
    expect(
      h.controller.performAction(
        p.seat,
        s.currentBet > p.bet ? 'call' : 'check',
        undefined,
        'horse_policy'
      )
    ).toBe(true);
  }
  expect(h.events.some((e) => e.type === 'HAND_COMPLETE')).toBe(true);
  expect(Math.round(h.controller.getState().players.reduce((n, p) => n + p.stack, 0) * 100)).toBe(
    h.total * 100
  );
}
afterEach(() => HorseMind.reset());
describe('six-handed 1/2 PLO5 Madness through the real controller', () => {
  it('collects one 2-chip BB ante, keeps it dead and deals five cards each', () => {
    const h = game();
    const s = h.controller.getState();
    expect(s.pot).toBe(5);
    expect(s.currentBet).toBe(2);
    expect(s.players.map((p) => p.cards.length)).toEqual([5, 5, 5, 5, 5, 5]);
    const forced = h.events.find((e) => e.type === 'FORCED_BETS_POSTED') as Extract<
      HandEvent,
      { type: 'FORCED_BETS_POSTED' }
    >;
    const bb = forced.postings.find((a) => a.kind === 'bb')!;
    const ante = forced.postings.filter((a) => a.kind === 'ante');
    expect(ante).toHaveLength(1);
    expect(ante[0]).toMatchObject({ seat: bb.seat, amount: 2 });
    expect(s.players.find((p) => p.seat === bb.seat)?.deadInvested).toBe(2);
    finish(h);
  });
  it('uses six 3BB bomb antes without charging the ordinary BBA again', () => {
    const h = game(true);
    const s = h.controller.getState();
    expect(s.stage).toBe('flop');
    expect(s.pot).toBe(36);
    expect(s.communityCards).toHaveLength(3);
    expect(s.communityCards2).toHaveLength(3);
    expect(s.players.every((p) => p.cards.length === 5)).toBe(true);
    finish(h);
    expect(h.controller.getState().communityCards2).toHaveLength(5);
    expect(h.events.some((e) => e.type === 'BOMB_POT_COMPLETED')).toBe(true);
  });
  it('conserves partial bomb antes and side pots for a short stack', () => {
    const h = game(true, [3, 12, 400, 400, 400, 400]);
    expect(h.controller.getState().pot).toBe(33);
    finish(h);
  });
  for (const bomb of [false, true]) {
    it(`accepts the actual floor-aware horse decision unchanged (${bomb ? 'two-board bomb' : 'BB ante'})`, () => {
      const h = game(bomb);
      const s = h.controller.getState();
      const hero = s.players.find((p) => p.seat === s.currentPlayerSeat)!;
      const gs = {
        ...s,
        stateSchemaVersion: 1,
        gameVariant: 'plo5',
        bigBlind: 2,
        gameMode: 'cash',
        heroSeat: hero.seat,
        dealtSeatIds: s.players.map((p) => p.seat),
        boardCount: bomb ? 2 : 1,
        bombPot: bomb,
        vpipFloor: 50,
        ownVpip: { hands: 10, vpip: 40 },
        players: s.players.map((p) => ({ ...p, cards: p.seat === hero.seat ? p.cards : [] })),
      } as HorseGameStateV2;
      const decision = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
      expect(decision.policyFallback).toBeUndefined();
      expect(decision.policyOwnership).toBeDefined();
      expect(
        h.controller.performAction(hero.seat, decision.action, decision.amount, 'horse_policy')
      ).toBe(true);
      const accepted = h.events.filter((e) => e.type === 'PLAYER_ACTION').at(-1) as Extract<
        HandEvent,
        { type: 'PLAYER_ACTION' }
      >;
      expect(accepted.origin).toBe('horse_policy');
      expect(accepted.action).toBe(decision.action);
      finish(h);
    });
  }
});
