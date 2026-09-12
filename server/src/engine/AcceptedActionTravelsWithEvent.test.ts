import { describe, expect, it, vi } from 'vitest';
import { HandController } from './HandController.js';
import { ServerTableEngineHandEvents } from './ServerTableEngineHandEvents.js';
import type { ActionRecord, HandConfig, HandEvent, SeatPlayer } from '../types.js';

type ActionEvent = Extract<HandEvent, { type: 'PLAYER_ACTION' }>;
const players = (stacks: number[]): SeatPlayer[] =>
  stacks.map((stack, index) => ({
    seat: index + 1,
    user_id: `u${index + 1}`,
    username: `P${index + 1}`,
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
const config = (variant: HandConfig['gameVariant'] = 'nlh'): HandConfig =>
  ({
    tableId: 'accepted-action',
    handNumber: 1,
    gameVariant: variant,
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
  }) as HandConfig;
function harness(stacks: number[], variant: HandConfig['gameVariant'] = 'nlh') {
  const controller = new HandController(config(variant), players(stacks), 1);
  const events: ActionEvent[] = [];
  controller.onEvent((event) => {
    if (event.type === 'PLAYER_ACTION') events.push(event);
  });
  controller.start();
  return { controller, events };
}
async function drain(
  events: ActionEvent[],
  lateState: ReturnType<HandController['getState']>,
  missingController = false
) {
  const owner = {
    tableId: 'accepted-action',
    handCount: 1,
    currentHandActions: [] as ActionRecord[],
    handController: missingController ? undefined : { getState: () => lateState },
    markProgress: vi.fn(),
    broadcastCurrentState: vi.fn(),
    seatedPlayers: lateState.players.map((p) => ({ ...p, seat_number: p.seat })),
    preActionEngine: { onBetPlaced: vi.fn() },
    hub: { emitEvent: vi.fn() },
  };
  const handler = (
    ServerTableEngineHandEvents.prototype as unknown as {
      handleHandEvent(event: HandEvent, roster: unknown[]): Promise<void>;
    }
  ).handleHandEvent;
  for (const event of events) await handler.call(owner, event, []);
  return owner;
}

describe('accepted action facts survive a delayed history consumer', () => {
  it('keeps full raise, short all-in, call, actor and timestamp independent of later state', async () => {
    const h = harness([200, 8, 200, 200]);
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(1010);
      expect(h.controller.performAction(4, 'raise', 6)).toBe(true);
      clock.mockReturnValue(1020);
      expect(h.controller.performAction(1, 'call', 6)).toBe(true);
      clock.mockReturnValue(1030);
      expect(h.controller.performAction(2, 'all_in')).toBe(true);
      clock.mockReturnValue(1040);
      expect(h.controller.performAction(3, 'call', 8)).toBe(true);
      const expectedFlags = [true, undefined, false, undefined];
      expect(h.events.map((e) => e.record?.isFullRaise)).toEqual(expectedFlags);
      expect(h.events.every((e) => Object.isFrozen(e.record))).toBe(true);
      const late = h.controller.getState();
      late.players.forEach((p) => {
        p.user_id = 'replacement';
      });
      late.actionHistory.push({
        seat: 4,
        userId: 'replacement',
        action: 'raise',
        amount: 80,
        timestamp: 9999,
        stage: 'river',
        isFullRaise: true,
      });
      late.stage = 'river';
      clock.mockReturnValue(9999);
      const owner = await drain(h.events, late);
      expect(owner.currentHandActions.map((a) => a.isFullRaise)).toEqual(expectedFlags);
      expect(owner.currentHandActions.map((a) => a.userId)).toEqual(['u4', 'u1', 'u2', 'u3']);
      expect(owner.currentHandActions.map((a) => a.timestamp)).toEqual([1010, 1020, 1030, 1040]);
      expect(owner.currentHandActions.every((a) => a.stage === 'preflop')).toBe(true);
      expect(owner.currentHandActions.map((a) => a.publicNode)).toEqual(
        h.events.map((e) => e.publicNode)
      );
      expect(owner.currentHandActions[0].publicNode).toMatchObject({
        status: 'captured',
        pot: 3,
        currentBet: 2,
        actorSeat: 4,
      });
      expect(h.controller.getState().actionHistory.every((a) => a.publicNode === undefined)).toBe(
        true
      );
      expect(owner.hub.emitEvent.mock.calls.map(([, e]) => e.user_id)).toEqual([
        'u4',
        'u1',
        'u2',
        'u3',
      ]);
      expect(owner.preActionEngine.onBetPlaced.mock.calls).toEqual([
        ['accepted-action', 'u4'],
        ['accepted-action', 'u2'],
      ]);
      for (const [, event] of owner.hub.emitEvent.mock.calls) {
        expect(event).not.toHaveProperty('record');
        expect(event).not.toHaveProperty('publicNode');
        expect(event).not.toHaveProperty('cards');
      }
      expect(JSON.stringify(h.events.map((e) => e.record))).not.toMatch(/cards|hole|rank|suit/);
    } finally {
      clock.mockRestore();
    }
  });

  it('does not create a record for a rejected or stale action', () => {
    const h = harness([200, 200, 200]);
    expect(h.controller.performAction(2, 'check')).toBe(false);
    expect(h.controller.performAction(1, 'raise', 1)).toBe(false);
    expect(h.events).toEqual([]);
  });

  it('records both chosen Pineapple discards and folds for missed discards without a private card', async () => {
    const h = harness([200, 200, 200], 'pineapple');
    for (let n = 0; n < 10 && h.controller.getState().stage === 'preflop'; n++) {
      const state = h.controller.getState(),
        seat = state.currentPlayerSeat;
      const player = state.players.find((p) => p.seat === seat)!;
      expect(
        h.controller.performAction(seat, state.currentBet > player.bet ? 'call' : 'check')
      ).toBe(true);
    }
    expect(h.controller.getState().stage).toBe('pineapple_discard');
    expect(h.controller.performDiscard(1, 0)).toBe(true);
    expect(h.controller.foldForMissedDiscard(2)).toBe(true);
    const actions = h.events.filter((e) => e.stage === 'pineapple_discard');
    expect(actions.map((e) => e.record?.action)).toEqual(['discard', 'fold']);
    expect(actions.map((e) => e.publicNode)).toEqual([
      { version: 1, status: 'unavailable', reason: 'private_discard_choice' },
      { version: 1, status: 'unavailable', reason: 'timeout_discard_fold' },
    ]);
    expect(
      h.controller
        .getState()
        .actionHistory.filter((a) => a.stage === 'pineapple_discard')
        .map((a) => a.action)
    ).toEqual(['discard', 'fold']);
    const owner = await drain(actions, h.controller.getState());
    expect(owner.currentHandActions.map((a) => a.isFullRaise)).toEqual([undefined, undefined]);
    expect(JSON.stringify(actions.map((e) => e.record))).not.toMatch(/cards|hole|rank|suit/);
  });

  it('retains compatibility with a legacy event that has no accepted record', async () => {
    const h = harness([200, 200]);
    const state = h.controller.getState();
    state.actionHistory.push({
      seat: 1,
      userId: 'u1',
      action: 'all_in',
      amount: 200,
      timestamp: 1,
      stage: 'preflop',
      isFullRaise: false,
    });
    const owner = await drain(
      [{ type: 'PLAYER_ACTION', seat: 1, action: 'all_in', amount: 200, stage: 'preflop' }],
      state
    );
    expect(owner.currentHandActions[0]).toMatchObject({
      userId: 'u1',
      isFullRaise: false,
      stage: 'preflop',
    });
    expect(owner.currentHandActions[0]).not.toHaveProperty('publicNode');
    const legacyWithoutController = await drain(
      [{ type: 'PLAYER_ACTION', seat: 1, action: 'all_in', amount: 200, stage: 'preflop' }],
      state,
      true
    );
    expect(legacyWithoutController.preActionEngine.onBetPlaced.mock.calls).toEqual([
      ['accepted-action', 'u1'],
    ]);
  });
});
