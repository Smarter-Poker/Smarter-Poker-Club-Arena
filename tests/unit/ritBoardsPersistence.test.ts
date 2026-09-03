/**
 * RIT BOARDS — first-class persistence, read side (2026-08-26).
 *
 * Migration 20260826_hand_history_rit_boards gave run-it-twice hands their
 * own column at last. The mapper must:
 *   1. prefer the column when present,
 *   2. fall back to parsing the `rit_board_N:` pseudo-actions for the
 *      millions of rows that predate it, in run order,
 *   3. FILTER those pseudo-entries out of the action list either way —
 *      they used to leak into every replay's action feed as a bogus entry
 *      attributed to 'system',
 *   4. leave single-run hands with an empty rit_boards.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({}),
    rpc: vi.fn(),
  },
}));
vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { handHistoryService } from '../../src/services/HandHistoryService';

/** The mapper is private by design; this reaches it the way the service
 *  itself does, against rows shaped exactly like production storage. */
const mapRow = (row: Record<string, unknown>) =>
  (handHistoryService as unknown as Record<string, any>).mapHandHistoryRow(row, new Map());

const baseRow = (over: Record<string, unknown> = {}) => ({
  id: 'h-rit',
  created_at: new Date().toISOString(),
  table_id: 't1',
  hand_number: 42,
  pot_size: 100,
  community_cards: ['10hearts', '5spades', '9clubs', 'Qspades', '2hearts'],
  players: [{ userId: 'u1', username: 'A', seat: 1, stack: 100 }],
  actions: [{ seat: 1, userId: 'u1', action: 'all_in', amount: 50, stage: 'turn', timestamp: 1 }],
  winners: [{ userId: 'u1', amount: 95, potIndex: 0 }],
  small_blind: 1,
  big_blind: 2,
  game_variant: 'nlh',
  ...over,
});

describe('hand_history.rit_boards — the read side', () => {
  it('prefers the first-class column when present', () => {
    const rec = mapRow(
      baseRow({
        rit_boards: [
          ['10hearts', '5spades', '9clubs', 'Qspades', 'Jdiamonds'],
          ['10hearts', '5spades', '9clubs', 'Qspades', '2diamonds'],
        ],
      })
    );
    expect(rec).not.toBeNull();
    expect(rec!.rit_boards).toHaveLength(2);
    expect(rec!.rit_boards![0][4]).toBe('Jdiamonds');
    expect(rec!.rit_boards![1][4]).toBe('2diamonds');
  });

  it('falls back to the pseudo-actions on pre-column rows, in run order', () => {
    const rec = mapRow(
      baseRow({
        actions: [
          { seat: 1, userId: 'u1', action: 'all_in', amount: 50, stage: 'turn', timestamp: 1 },
          {
            seat: 0,
            userId: 'system',
            action: 'rit_board_3:10hearts,5spades,9clubs,Qspades,Jdiamonds',
            stage: 'river',
            timestamp: 3,
          },
          {
            seat: 0,
            userId: 'system',
            action: 'rit_board_2:10hearts,5spades,9clubs,Qspades,2diamonds',
            stage: 'river',
            timestamp: 2,
          },
        ],
      })
    );
    expect(rec!.rit_boards).toHaveLength(2);
    // Run order, not action order: board 2 first, board 3 second.
    expect(rec!.rit_boards![0][4]).toBe('2diamonds');
    expect(rec!.rit_boards![1][4]).toBe('Jdiamonds');
  });

  it('filters the pseudo-entries out of the replay action feed', () => {
    const rec = mapRow(
      baseRow({
        actions: [
          { seat: 1, userId: 'u1', action: 'all_in', amount: 50, stage: 'turn', timestamp: 1 },
          {
            seat: 0,
            userId: 'system',
            action: 'rit_board_2:2clubs,3clubs,4clubs,5clubs,6clubs',
            stage: 'river',
            timestamp: 2,
          },
        ],
      })
    );
    expect(rec!.actions).toHaveLength(1);
    expect(rec!.actions[0].action).toBe('all_in');
  });

  it('single-run hands map to an empty rit_boards', () => {
    const rec = mapRow(baseRow());
    expect(rec!.rit_boards).toEqual([]);
  });
});
