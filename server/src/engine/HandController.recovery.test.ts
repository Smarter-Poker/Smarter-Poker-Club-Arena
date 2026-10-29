import { describe, expect, it } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

const config: HandConfig = {
  tableId: 'recovery-fixture',
  handNumber: 42,
  gameVariant: 'nlh',
  smallBlind: 200,
  bigBlind: 400,
  ante: 400,
  bigBlindAnte: true,
  isTournament: true,
  rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
};
function players(
  stacks = [9632, 54010, 17795, 15962, 11095, 13361, 39365, 10861, 7919]
): SeatPlayer[] {
  return stacks.map((stack, i) => ({
    seat: i + 1,
    user_id: `u${i + 1}`,
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
function checkpoint(controller: HandController): string {
  return controller.serializeRecoveryState();
}
function restored(controller: HandController): HandController {
  return HandController.fromRecoveryState(
    checkpoint(controller),
    config.tableId,
    config.handNumber
  );
}
function finish(controller: HandController): HandEvent[] {
  const events: HandEvent[] = [];
  controller.onEvent((event) => events.push(event));
  for (let n = 0; n < 100 && !events.some((e) => e.type === 'HAND_COMPLETE'); n++) {
    const state = controller.getState();
    if (state.currentPlayerSeat < 0) controller.continueRunout();
    else {
      const p = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
      expect(controller.performAction(p.seat, p.bet < state.currentBet ? 'call' : 'check')).toBe(
        true
      );
    }
  }
  expect(events.some((e) => e.type === 'HAND_COMPLETE')).toBe(true);
  return events;
}

describe('unfinished controller recovery keeps the original hand', () => {
  it('continues a proven unacted legacy river without inventing its unused deck', () => {
    const c = { ...config, ante: 0, gameVariant: 'plo5' as const };
    const original = new HandController(c, players([50000, 50000]), 1);
    original.start();
    for (let n = 0; n < 20 && original.getState().stage !== 'river'; n++) {
      const s = original.getState(),
        p = s.players.find((p) => p.seat === s.currentPlayerSeat)!;
      expect(original.performAction(p.seat, p.bet < s.currentBet ? 'call' : 'check')).toBe(true);
    }
    const { deck: _deck, ...saved } = original.getState();
    const copy = HandController.fromLegacyUnactedRiver(c, saved, original.getBlindSeatsSnapshot()!);
    expect(copy.getRemainingDeck()).toEqual([]);
    expect(copy.getState().players).toEqual(original.getState().players);
    const a = finish(original),
      b = finish(copy);
    expect(b.filter((e) => ['SHOWDOWN', 'WINNERS', 'HAND_COMPLETE'].includes(e.type))).toEqual(
      a.filter((e) => ['SHOWDOWN', 'WINNERS', 'HAND_COMPLETE'].includes(e.type))
    );
    const terminal = HandController.fromRecoveryState(
      copy.serializeRecoveryState(),
      c.tableId,
      c.handNumber
    );
    expect(terminal.getState().players.reduce((n, p) => n + p.stack, 0)).toBe(100000);
    terminal.resumeRecoveredHand();
  });
  it('refuses legacy recovery before the complete board or after a river decision', () => {
    const original = new HandController(config, players(), 5);
    original.start();
    const { deck: _deck, ...saved } = original.getState();
    expect(() =>
      HandController.fromLegacyUnactedRiver(config, saved, original.getBlindSeatsSnapshot()!)
    ).toThrow('Unproven');
  });
  it('retains the prepared shuffled deck before publishing the first hand event', () => {
    const original = new HandController(config, players(), 5);
    const copy = restored(original);
    const a: HandEvent[] = [],
      b: HandEvent[] = [];
    original.onEvent((e) => a.push(e));
    copy.onEvent((e) => b.push(e));
    original.start();
    copy.resumeRecoveredHand();
    expect(b).toEqual(a);
    expect(copy.getState()).toEqual(original.getState());
    copy.resumeRecoveredHand();
    expect(b).toEqual(a);
  });
  it('retains terminal credited stacks without evaluating or awarding the pot twice', () => {
    const original = new HandController(config, players(), 5);
    original.start();
    finish(original);
    const copy = restored(original);
    const events: HandEvent[] = [];
    copy.onEvent((e) => events.push(e));
    copy.resumeRecoveredHand();
    copy.continueRunout();
    expect(events).toEqual([]);
    expect(copy.getState()).toEqual(original.getState());
    expect(copy.getState().players.reduce((n, p) => n + p.stack, 0)).toBe(180000);
  });
  it('preserves an all-in, exact deck, actor, stakes and final payout across reconstruction', () => {
    const original = new HandController(config, players(), 5);
    original.start();
    expect(original.performAction(8, 'fold')).toBe(true);
    expect(original.performAction(9, 'all_in')).toBe(true);
    const copy = restored(original);
    expect(copy.getState()).toEqual(original.getState());
    const resumed: HandEvent[] = [];
    copy.onEvent((e) => resumed.push(e));
    copy.resumeRecoveredHand();
    expect(resumed.map((e) => e.type)).toEqual(['TURN_CHANGE']);
    expect(copy.getState().players.find((p) => p.seat === 9)?.stack).toBe(0);
    expect(copy.getState().currentBet).toBe(7919);
    const a = finish(original),
      b = finish(copy);
    expect(b.filter((e) => ['SHOWDOWN', 'WINNERS', 'HAND_COMPLETE'].includes(e.type))).toEqual(
      a.filter((e) => ['SHOWDOWN', 'WINNERS', 'HAND_COMPLETE'].includes(e.type))
    );
    expect(copy.getState().players.reduce((n, p) => n + p.stack, 0)).toBe(180000);
  });
  it('does not repost blinds or deal new hole cards when resumed repeatedly', () => {
    const original = new HandController(config, players(), 5);
    original.start();
    const copy = restored(original),
      before = copy.getState();
    copy.resumeRecoveredHand();
    copy.resumeRecoveredHand();
    expect(copy.getState()).toEqual(before);
    expect(() => copy.start()).toThrow();
  });
  it('refuses wrong identity, old snapshots, missing deck and duplicate cards', () => {
    const original = new HandController(config, players(), 5);
    original.start();
    const encoded = checkpoint(original);
    expect(() => HandController.fromRecoveryState(encoded, 'another-table', 42)).toThrow();
    expect(() => HandController.fromRecoveryState(encoded, config.tableId, 43)).toThrow();
    expect(() => HandController.fromRecoveryState('{}', config.tableId, 42)).toThrow();
    const invalid = JSON.parse(encoded);
    invalid.deck[0] = invalid.deck[1];
    expect(() =>
      HandController.fromRecoveryState(JSON.stringify(invalid), config.tableId, 42)
    ).toThrow();
    delete invalid.deck;
    expect(() =>
      HandController.fromRecoveryState(JSON.stringify(invalid), config.tableId, 42)
    ).toThrow();
  });
});
