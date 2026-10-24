import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasCommittedSeatFold } from '../../src/utils/committedSeatFold';

const snapshot = {
  table_id: 'table',
  hand_number: 12,
  stage: 'preflop',
  players: [{ seat: 2, user_id: 'player', is_folded: false }],
};
const folded = { ...snapshot, players: [{ ...snapshot.players[0], is_folded: true }] };
const hidden = (value: Record<string, unknown> | null) =>
  hasCommittedSeatFold(value, 'table', 12, 2, 'player');

describe('a player disappears only after their actual fold', () => {
  it('keeps a selected fold and an unaccepted optimistic action visible', () => {
    expect(hidden({ ...snapshot, pre_action: 'auto_fold', last_action: 'fold' })).toBe(false);
  });
  it('accepts the engine fold on the same preflop hand, including reconnect', () => {
    expect(hidden(folded)).toBe(true);
    expect(hidden(JSON.parse(JSON.stringify(folded)))).toBe(true);
  });
  it.each(['flop', 'turn', 'river', 'showdown', 'waiting'])(
    'keeps a committed fold hidden on %s',
    (stage) => {
      expect(hidden({ ...folded, stage })).toBe(true);
    }
  );
  it.each([
    null,
    { ...folded, table_id: 'another-table' },
    { ...folded, hand_number: 11 },
    { ...folded, players: [{ ...folded.players[0], user_id: 'replacement' }] },
    { ...folded, players: [{ ...folded.players[0], seat: 3 }] },
    { ...folded, players: [{ ...folded.players[0], is_folded: 'true' }] },
    { ...folded, players: [null] },
  ])('never hides a player from an unknown or different occupancy: %j', (value) => {
    expect(hidden(value)).toBe(false);
  });
  it('restores a legitimately seated player for the next hand', () => {
    expect(hasCommittedSeatFold({ ...snapshot, hand_number: 13 }, 'table', 13, 2, 'player')).toBe(
      false
    );
  });
  it('the maintained table supplies authoritative state to the real seat, without a format filter', () => {
    const source = readFileSync('src/pages/TablePage.tsx', 'utf8').replace(/\s+/g, ' ');
    expect(source).toMatch(
      /foldCommitted=\{hasCommittedSeatFold\(\s*engineSnapshot, tableId, tableState.handNumber, seatNumber, displayPlayer\?\.id\s*\)\}/
    );
    const css = readFileSync('src/components/table/SeatSlot.css', 'utf8');
    const rule = css.slice(css.indexOf('.seat--fold-hidden >'));
    expect(rule).toContain('visibility: hidden');
    expect(rule).not.toMatch(/seat__wager-group|seat__cards/);
  });
});
