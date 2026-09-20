import { describe, expect, it, vi } from 'vitest';
import { HandController } from './HandController.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import type { AcceptedActionOrigin, HandEvent, SeatPlayer } from '../types.js';

function harness() {
  const players: SeatPlayer[] = [1, 2, 3].map((seat) => ({
    seat,
    user_id: `u${seat}`,
    username: 'offline',
    stack: 200,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
  const controller = new HandController(
    {
      tableId: 'origin-test',
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    },
    players,
    1
  );
  const events: Array<Extract<HandEvent, { type: 'PLAYER_ACTION' }>> = [];
  controller.onEvent((event) => {
    if (event.type === 'PLAYER_ACTION') events.push(event);
  });
  controller.start();
  const engine = Object.create(ServerTableEngine.prototype) as ServerTableEngine & {
    handController: HandController;
    lifecycleCanMutate: () => boolean;
    actionLock: boolean;
    cancelHorseDecisionWork: () => void;
    _handlePlayerActionInner: (
      user: string,
      action: string,
      amount: number | undefined,
      origin: AcceptedActionOrigin
    ) => { success: boolean };
    forceResolveSeat: (seat: number, preferCheck: boolean) => boolean;
  };
  // Exercise the production serialization/context gate and forced-action owner
  // with a real controller, while excluding unrelated clock/lease infrastructure.
  Object.assign(engine, {
    handController: controller,
    lifecycleCanMutate: () => true,
    actionLock: false,
    cancelHorseDecisionWork: vi.fn(),
    _handlePlayerActionInner: (
      user: string,
      action: string,
      amount: number | undefined,
      origin: AcceptedActionOrigin
    ) => ({
      success: controller.performAction(Number(user.slice(1)), action as 'call', amount, origin),
    }),
  });
  return { controller, events, engine };
}

describe('accepted action origin is an executor fact, not a roster inference', () => {
  it.each([0, 2])(
    'records forced contributions and the already-returned amount without another chip movement (ante=%s)',
    async (ante) => {
      const players: SeatPlayer[] = [1, 2].map((seat) => ({
        seat,
        user_id: `u${seat}`,
        username: 'offline',
        stack: 1000,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }));
      const controller = new HandController(
        {
          tableId: 'origin-money-events',
          handNumber: 1,
          gameVariant: 'nlh',
          smallBlind: 5,
          bigBlind: 10,
          ante,
          rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
        },
        players,
        1
      );
      class HistoryEngine extends ServerTableEngine {
        constructor() {
          super('origin-money-events');
          this.handController = controller;
        }
        record(event: HandEvent) {
          return this.handleHandEvent(event, []);
        }
        get history() {
          return this.currentHandActions;
        }
      }
      const engine = new HistoryEngine();
      const pending: Promise<void>[] = [];
      const events: HandEvent[] = [];
      controller.onEvent((event) => {
        events.push(event);
        if (event.type === 'FORCED_BETS_POSTED' || event.type === 'UNCALLED_BET_RETURNED')
          pending.push(engine.record(event));
      });
      controller.start();
      const postedPot = controller.getState().pot;
      await Promise.all(pending);
      const postings = events.flatMap((event) =>
        event.type === 'FORCED_BETS_POSTED' ? event.postings : []
      );
      expect(engine.history).toEqual(
        postings.map(({ kind, ...posting }) => ({
          ...posting,
          action: kind,
          stage: 'preflop',
          timestamp: expect.any(Number),
          origin: 'forced',
        }))
      );
      expect(postedPot).toBe(15 + ante * 2);
      expect(controller.getState().pot).toBe(postedPot);
      const prefix = structuredClone(engine.history);
      expect(controller.performAction(1, 'call', 0, 'player')).toBe(true);
      expect(controller.performAction(2, 'check', 0, 'player')).toBe(true);
      expect(controller.performAction(2, 'check', 0, 'player')).toBe(true);
      expect(controller.performAction(1, 'bet', 100, 'player')).toBe(true);
      expect(controller.performAction(2, 'fold', 0, 'player')).toBe(true);
      const settled = structuredClone(controller.getState());
      await Promise.all(pending);
      expect(engine.history.slice(0, prefix.length)).toEqual(prefix);
      expect(engine.history.slice(prefix.length)).toEqual([
        {
          seat: 1,
          userId: 'u1',
          action: 'return',
          amount: 100,
          timestamp: expect.any(Number),
          stage: 'flop',
          historyEvent: 'uncalled_bet_returned',
        },
      ]);
      expect(engine.history.at(-1)).not.toHaveProperty('origin');
      expect(events.filter((event) => event.type === 'UNCALLED_BET_RETURNED')).toHaveLength(1);
      expect(controller.getState()).toEqual(settled);
      const completion = events.find((event) => event.type === 'HAND_COMPLETE');
      const rake = ante === 0 ? 1 : 1.2;
      expect(completion).toMatchObject({ rake });
      expect(settled.players.map((player) => player.stack)).toEqual(
        ante === 0 ? [1009, 990] : [1010.8, 988]
      );
      expect(settled.players.reduce((sum, player) => sum + player.stack, 0) + rake).toBe(2000);
    }
  );

  it.each(['player', 'pre_action', 'horse_policy', 'horse_fallback', 'forced', 'unknown'] as const)(
    'preserves %s only on accepted internal/durable facts',
    (origin) => {
      const h = harness();
      expect(h.controller.performAction(2, 'call', undefined, origin)).toBe(false);
      expect(h.events).toHaveLength(0);
      expect(h.controller.performAction(1, 'call', undefined, origin)).toBe(true);
      expect(h.events[0].origin).toBe(origin);
      expect(h.controller.getState().actionHistory[0]).not.toHaveProperty('origin');
    }
  );

  it('defaults old or malformed callers to unknown without changing valid poker', () => {
    for (const origin of [undefined, 'client_claimed_player', null]) {
      const h = harness();
      expect(h.controller.performAction(1, 'call', undefined, origin as AcceptedActionOrigin)).toBe(
        true
      );
      expect(h.events[0].origin).toBe('unknown');
    }
  });

  it('only labels a validated displayed context as a direct player action', () => {
    const h = harness();
    expect(h.engine.handlePlayerAction('u1', 'call', undefined, 'stale').success).toBe(false);
    expect(h.events).toHaveLength(0);
    expect(
      h.engine.handlePlayerAction('u1', 'call', undefined, h.engine.getActionContext()).success
    ).toBe(true);
    expect(h.events[0].origin).toBe('player');
  });

  it('keeps an unlabelled trusted internal caller unknown', () => {
    const h = harness();
    expect(h.engine.handlePlayerAction('u1', 'call').success).toBe(true);
    expect(h.events[0].origin).toBe('unknown');
  });

  it('carries the immediate pre-action source through the same serialization gate', () => {
    const h = harness();
    expect(
      h.engine.handlePlayerAction('u1', 'call', undefined, undefined, 'pre_action').success
    ).toBe(true);
    expect(h.events[0].origin).toBe('pre_action');
  });

  it('distinguishes a forced recovery from a voluntary fold by the same seat', () => {
    const forced = harness(),
      voluntary = harness();
    expect(forced.engine.forceResolveSeat(1, true)).toBe(true);
    expect(voluntary.controller.performAction(1, 'fold', undefined, 'player')).toBe(true);
    expect(forced.events[0]).toMatchObject({ action: 'fold', origin: 'forced' });
    expect(voluntary.events[0]).toMatchObject({ action: 'fold', origin: 'player' });
    expect(forced.controller.getState().players.map((p) => p.stack)).toEqual(
      voluntary.controller.getState().players.map((p) => p.stack)
    );
  });
});
