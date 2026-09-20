import { describe, expect, it, vi } from 'vitest';
import { HandController, type HorseDiscardControllerReceipt } from './HandController.js';
import type { HandEvent, SeatPlayer } from '../types.js';
import { reportError } from '../services/errorReporter.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

function dealt(choice: boolean) {
  const players: SeatPlayer[] = [1, 2, 3].map((seat) => ({
    seat,
    user_id: `horse-${seat}`,
    username: `Horse ${seat}`,
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
      tableId: 'private-discard',
      handNumber: 1,
      gameVariant: 'pineapple',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    },
    players,
    1
  );
  const events: HandEvent[] = [];
  controller.onEvent((event) => events.push(event));
  controller.start();
  if (choice) {
    for (let i = 0; i < 20 && controller.getState().stage === 'preflop'; i++) {
      const state = controller.getState();
      const player = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
      expect(
        controller.performAction(player.seat, state.currentBet > player.bet ? 'call' : 'check')
      ).toBe(true);
    }
    expect(controller.getState().stage).toBe('pineapple_discard');
  } else {
    // This fixture drives the forced commit directly; each contender is all-in.
    const state = (controller as unknown as { state: { players: SeatPlayer[] } }).state;
    for (const player of state.players) player.is_all_in = true;
  }
  return { controller, events };
}

describe('private Horse accepted-discard receipt', () => {
  it('binds exact cards and timestamp before the public accepted action, without leaking choice', () => {
    const { controller, events } = dealt(true);
    const before = structuredClone(controller.getState().players.find((p) => p.seat === 1)!.cards);
    const receipts: HorseDiscardControllerReceipt[] = [];
    const publicCount = events.filter((e) => e.type === 'PLAYER_ACTION').length;
    controller.observeNextPineappleDiscard(1, (receipt) => {
      expect(events.filter((e) => e.type === 'PLAYER_ACTION')).toHaveLength(publicCount);
      expect(controller.getState().players.find((p) => p.seat === 1)!.cards).toHaveLength(2);
      receipts.push(receipt);
    });
    expect(controller.performDiscard(1, 1)).toBe(true);
    expect(controller.performDiscard(1, 0)).toBe(false);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0];
    expect(receipt).toMatchObject({
      seat: 1,
      actorId: 'horse-1',
      chosenIndex: 1,
      originalCards: before,
      discardedCard: before[1],
      retainedCards: [before[0], before[2]],
    });
    const action = events.filter((e) => e.type === 'PLAYER_ACTION').at(-1)!;
    expect(action.record).toEqual(receipt.acceptedRecord);
    expect(action.record).not.toBe(receipt.acceptedRecord);
    expect(JSON.stringify(action)).not.toMatch(
      /chosenIndex|originalCards|retainedCards|discardedCard/
    );
    expect(Object.isFrozen(receipt)).toBe(true);
    for (const cards of [receipt.originalCards, receipt.retainedCards, receipt.communityCards]) {
      expect(Object.isFrozen(cards)).toBe(true);
      expect(cards.every(Object.isFrozen)).toBe(true);
    }
    expect(Object.isFrozen(receipt.discardedCard)).toBe(true);
    expect(Object.isFrozen(receipt.acceptedRecord)).toBe(true);
  });

  it('does not consume the observer or emit evidence for a refused discard', () => {
    const { controller } = dealt(true);
    const observer = vi.fn();
    controller.observeNextPineappleDiscard(1, observer);
    expect(controller.performDiscard(1, 3)).toBe(false);
    expect(observer).not.toHaveBeenCalled();
    expect(controller.performDiscard(1, 2)).toBe(true);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it('honors unsubscribe without letting an old cleanup remove a replacement', () => {
    const { controller } = dealt(true);
    const old = vi.fn(),
      current = vi.fn(),
      removed = vi.fn();
    const stopOld = controller.observeNextPineappleDiscard(1, old);
    controller.observeNextPineappleDiscard(1, current);
    stopOld();
    controller.observeNextPineappleDiscard(2, removed)();
    expect(controller.performDiscard(1, 2)).toBe(true);
    expect(controller.performDiscard(2, 0)).toBe(true);
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
  });

  it('isolates observer failure after mutation and still emits the accepted action', () => {
    const { controller, events } = dealt(true);
    controller.observeNextPineappleDiscard(1, () => {
      throw new Error('audit sink failed');
    });
    expect(controller.performDiscard(1, 2)).toBe(true);
    expect(controller.getState().players.find((p) => p.seat === 1)!.cards).toHaveLength(2);
    expect(events.filter((e) => e.type === 'PLAYER_ACTION').at(-1)?.action).toBe('discard');
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'HandController.horse_discard_observer'
    );
  });

  it('emits forced receipts only on actual commit, for each real seat and exact prepared flop', () => {
    const { controller, events } = dealt(false);
    const snapshot = controller.getPineappleRunoutDiscardSnapshot()!;
    const receipts: HorseDiscardControllerReceipt[] = [];
    for (const player of snapshot.players)
      controller.observeNextPineappleDiscard(player.seat, (receipt) => receipts.push(receipt));
    const choices = new Map(snapshot.players.map((player, index) => [player.seat, index]));
    expect(controller.preparePineappleRunoutDiscards(snapshot.flop, choices)).toBe(true);
    expect(receipts).toEqual([]);
    expect(controller.commitPreparedPineappleRunoutDiscards(snapshot.flop.slice(0, 2))).toBe(false);
    expect(receipts).toEqual([]);
    expect(controller.commitPreparedPineappleRunoutDiscards(snapshot.flop)).toBe(true);
    expect(receipts).toHaveLength(3);
    for (const [index, receipt] of receipts.entries()) {
      expect(receipt.originalCards).toEqual(snapshot.players[index].cards);
      expect(receipt.discardedCard).toEqual(snapshot.players[index].cards[index]);
      expect(receipt.communityCards).toEqual(snapshot.flop);
      expect(receipt.acceptedRecord).toMatchObject({
        seat: snapshot.players[index].seat,
        action: 'discard',
        amount: 0,
        stage: 'flop',
      });
    }
    expect(controller.commitPreparedPineappleRunoutDiscards(snapshot.flop)).toBe(true);
    expect(receipts).toHaveLength(3);
    expect(events.filter((e) => e.type === 'PLAYER_ACTION' && e.action === 'discard')).toHaveLength(
      3
    );
  });
});
