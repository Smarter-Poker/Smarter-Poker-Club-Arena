/**
 * THE HAND SNAPSHOT IS WRITTEN ONCE, NOT TWICE (2026-09-04)
 *
 * `saveSnapshot()` used to INSERT the snapshot row and then, four lines later
 * in the same function body, issue a second statement against the row it had
 * just inserted, to fill in two columns it already had in hand.
 *
 * Measured in one production stats window, on the largest table in the
 * database (7,357 MB):
 *
 *     1,209,476 inserts     2,419,902 updates     16.5% of them HOT
 *
 * 1,210,782 of those updates were that second statement. Postgres writes a
 * whole new ~1.7 KB heap tuple however few columns you name, and at 16.5% HOT
 * most of them also rewrote all three indexes.
 *
 * These assertions fail against the two-statement version. That is the point.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

vi.mock('./client.js', () => ({
  supabase: { rpc: vi.fn().mockResolvedValue({ error: null }) },
}));

import * as snapshots from './snapshots.js';
import { supabase } from './client.js';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const here = dirname(fileURLToPath(import.meta.url));

describe('the hand snapshot is written once, not twice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockResolvedValue({ error: null });
  });

  it('carries the deadlines and disconnect states on the insert itself', async () => {
    await snapshots.saveHandStateSnapshot({
      tableId: '11111111-1111-1111-1111-111111111111',
      handNumber: 42,
      stateJson: { stage: 'preflop' },
      configJson: {},
      dealerSeat: 3,
      playersJson: [{ seat: 1, user_id: 'u1' }],
      stage: 'preflop',
      pendingDeadlines: [{ kind: 'action', dueAt: 1 }] as never,
      disconnectStates: { u1: { state: 'CONNECTED' } } as never,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe('save_hand_state_snapshot');
    expect(args.p_pending_deadlines).toEqual([{ kind: 'action', dueAt: 1 }]);
    expect(args.p_disconnect_states).toEqual({ u1: { state: 'CONNECTED' } });
  });

  it('sends the column defaults, never null, when the caller has nothing to add', async () => {
    // pending_deadlines and disconnect_states are NOT NULL in the schema. A
    // caller with nothing to say must still produce the empty shapes the table
    // declares, or the row that lands stops being identical to today's.
    await snapshots.saveHandStateSnapshot({
      tableId: '11111111-1111-1111-1111-111111111111',
      handNumber: 43,
      stateJson: {},
      configJson: {},
      dealerSeat: 0,
      playersJson: [],
      stage: 'preflop',
    });

    const [, args] = rpc.mock.calls[0];
    expect(args.p_pending_deadlines).toEqual([]);
    expect(args.p_disconnect_states).toEqual({});
  });

  it('no longer exports the second-statement writer at all', () => {
    // Dead the moment its only caller was folded away. Left in place it is an
    // invitation to reintroduce the second write.
    expect(Object.keys(snapshots)).not.toContain('saveHandSnapshotExtras');
  });

  it('the engine writes the snapshot with exactly one call', () => {
    const engine = readFileSync(resolve(here, '../../engine/ServerTableEngineBase.ts'), 'utf8');

    expect(engine).not.toContain('saveHandSnapshotExtras');

    const writes = engine.match(/await saveHandStateSnapshot\(/g) ?? [];
    expect(writes).toHaveLength(1);

    // And it still carries both, so the fold did not silently drop them - the
    // disconnect FSM is the one thing crash recovery actually reads back.
    const body = engine.slice(engine.indexOf('await saveHandStateSnapshot('));
    const call = body.slice(0, body.indexOf('});') + 3);
    expect(call).toContain('pendingDeadlines:');
    expect(call).toContain('disconnectStates:');
  });
});
