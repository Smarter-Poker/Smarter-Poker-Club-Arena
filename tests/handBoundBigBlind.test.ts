import { describe, expect, it } from 'vitest';
import { mapEngineSnapshot } from '../src/utils/mapEngineSnapshot';
import { displayBigBlind } from '../src/utils/handBlinds';
import { formatBigBlinds } from '../src/utils/format';

const snapshot = (hand: number, bb: number, amount: number) => ({
  table_id: 'table-a',
  hand_number: hand,
  hand_blinds: {
    table_id: 'table-a',
    hand_number: hand,
    small_blind: bb / 2,
    big_blind: bb,
  },
  players: [],
  action_history: [],
  pots: [],
  pot: amount,
});

describe('hand-bound BB display', () => {
  it('recovers the dealt BB from a reconnect snapshot despite stale 1000 level metadata', () => {
    const mapped = mapEngineSnapshot(snapshot(12, 1200, 2400), 'hero', 9);
    expect((mapped as any).handBlinds?.bigBlind).toBe(1200);
    expect(formatBigBlinds(1200, (mapped as any).handBlinds?.bigBlind)).toBe('1 BB');
    expect(formatBigBlinds(600, (mapped as any).handBlinds?.bigBlind)).toBe('0.5 BB');
    expect(formatBigBlinds(mapped.pot, (mapped as any).handBlinds?.bigBlind)).toBe('2 BB');
  });
  it('keeps the old hand denomination until the next hand snapshot, not the level announcement', () => {
    const oldHand = mapEngineSnapshot(snapshot(11, 1000, 2000), 'hero', 9);
    const newHand = mapEngineSnapshot(snapshot(12, 1200, 2400), 'hero', 9);
    expect(formatBigBlinds(1000, (oldHand as any).handBlinds?.bigBlind)).toBe('1 BB');
    expect(formatBigBlinds(1200, (newHand as any).handBlinds?.bigBlind)).toBe('1 BB');
    expect(displayBigBlind(oldHand.handBlinds, 'table-a', 11, true, 1200)).toBe(1000);
    expect(displayBigBlind(newHand.handBlinds, 'table-a', 12, true, 1000)).toBe(1200);
    expect(displayBigBlind(oldHand.handBlinds, 'table-a', 12, true, 1000)).toBe(0);
    expect(displayBigBlind(null, 'cash', 1, false, 2)).toBe(2);
    expect(oldHand.pot).toBe(2000);
    expect(newHand.pot).toBe(2400);
  });
  it('rejects another hand/table denomination and treats legacy data as unknown', () => {
    const wrong = snapshot(12, 1200, 2400);
    wrong.hand_blinds.hand_number = 11;
    expect((mapEngineSnapshot(wrong, 'hero', 9) as any).handBlinds).toBeNull();
    wrong.hand_blinds.hand_number = 12;
    wrong.hand_blinds.table_id = 'table-b';
    expect((mapEngineSnapshot(wrong, 'hero', 9) as any).handBlinds).toBeNull();
    const legacy = { ...snapshot(12, 1200, 2400), hand_blinds: undefined };
    expect((mapEngineSnapshot(legacy, 'hero', 9) as any).handBlinds).toBeNull();
  });
});
