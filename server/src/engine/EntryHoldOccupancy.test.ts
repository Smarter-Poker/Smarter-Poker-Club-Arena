/** Actual production method with modeled PostgREST effects. All cases UNRUN. */
import { afterEach, describe, expect, it, vi } from 'vitest';
const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from, rpc: () => { throw Error('unexpected RPC'); } }, maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';

const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const engines: any[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) {
    e.preciseTimer.dispose(); e.engineTelemetry.dispose();
  }
  vi.restoreAllMocks(); from.mockReset();
});
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function fixture() {
  const e = new ServerTableEngine(id(1)) as any; engines.push(e);
  vi.spyOn(e, 'isTournamentTable').mockReturnValue(false);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const original = { seat_id: id(2), occupancy_id: id(3), user_id: id(4),
    seat_joined_at: '2026-09-15T00:00:00.123456Z', seat_number: 1, stack: 100 };
  e.seatedPlayers = [original];
  const rows: Array<Record<string, any>> = [{ id: id(2), occupancy_id: id(3), user_id: id(4),
    table_id: id(1), left_at: null, entry_hold: 'waiting', entry_post_agreed: true }];
  const calls: Array<{ patch: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
  const applied: unknown[] = [];
  const failures: Array<'reject' | 'getter_throw' | 'error'> = [];
  from.mockImplementation((table: string) => {
    expect(table).toBe('table_seats');
    const call = { patch: {} as Record<string, unknown>, filters: [] as Array<[string, unknown]> };
    calls.push(call);
    const mode = failures.shift();
    const builder: any = {
      update(patch: Record<string, unknown>) { call.patch = { ...patch }; return builder; },
      eq(key: string, value: unknown) { call.filters.push([key, value]); return builder; },
      is(key: string, value: unknown) { call.filters.push([key, value]); return builder; },
      get then() {
        if (mode === 'getter_throw') throw Error('modeled then getter failure');
        return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
          if (mode === 'reject') { reject(Error('modeled transport failure')); return; }
          if (mode === 'error') { resolve({ error: { message: 'modeled database refusal' } }); return; }
          // Generic predicate evaluation models only row targeting, not SQL/trigger installation.
          for (const row of rows) {
            if (call.filters.every(([key, value]) => row[key] === value)) {
              Object.assign(row, call.patch); applied.push({ ...call.patch });
            }
          }
          resolve({ error: null });
        };
      },
    };
    return builder;
  });
  const enqueue = (state: { hold: 'waiting' | 'posting' | null; agreed?: boolean }) =>
    e.persistEntryHold(id(4), state);
  const tail = () => e.entryHoldWriteChains.get(id(4)) as Promise<void>;
  return { e, original, rows, calls, applied, failures, enqueue, tail, warning };
}
describe('entry hold targets the occupancy observed at enqueue', () => {
  it.each(['new_row', 'same_row_reactivated'] as const)('delayed patch does not update later occupancy: %s', async (mode) => {
    const f = fixture(), gate = barrier(); f.e.entryHoldWriteChains.set(id(4), gate.promise);
    expect(f.enqueue({ hold: null, agreed: false })).toBeUndefined();
    const pending = f.tail(); expect(f.calls).toHaveLength(0);
    if (mode === 'new_row') {
      f.rows[0].left_at = '2026-09-15T00:01:00Z';
      f.rows.push({ ...f.rows[0], id: id(5), occupancy_id: id(6), left_at: null });
    } else {
      f.rows[0].occupancy_id = id(6);
    }
    // Mutate the very source object too: retaining a reference is insufficient.
    f.original.seat_id = mode === 'new_row' ? id(5) : id(2);
    f.original.occupancy_id = id(6);
    gate.release(); await pending;
    expect(f.rows.at(-1)!.entry_hold).toBe('waiting');
    expect(f.rows.at(-1)!.entry_post_agreed).toBe(true);
    expect(f.applied).toEqual([]);
    expect(f.calls[0].filters).toEqual(expect.arrayContaining([
      ['id', id(2)], ['occupancy_id', id(3)], ['table_id', id(1)], ['user_id', id(4)], ['left_at', null],
    ]));
  });
  it('retains original table scalar when the Engine table changes while queued', async () => {
    const f = fixture(), gate = barrier(); f.e.entryHoldWriteChains.set(id(4), gate.promise);
    f.enqueue({ hold: null, agreed: false }); const pending = f.tail();
    f.e.tableId = id(9);
    f.rows.push({ ...f.rows[0], table_id: id(9), id: id(5), occupancy_id: id(6) });
    f.e.seatedPlayers = [{ ...f.original, seat_id: id(5), occupancy_id: id(6) }];
    gate.release(); await pending;
    expect(f.rows[0].entry_hold).toBeNull(); expect(f.rows[1].entry_hold).toBe('waiting');
  });
  it('preserves unchanged-original FIFO and copies patch values before delay', async () => {
    const f = fixture(), gate = barrier(); f.e.entryHoldWriteChains.set(id(4), gate.promise);
    const state: { hold: 'waiting' | 'posting' | null; agreed: boolean } = { hold: 'posting', agreed: false };
    f.enqueue(state); const first = f.tail();
    f.enqueue({ hold: null }); const last = f.tail(); state.hold = 'waiting'; state.agreed = true;
    expect(last).not.toBe(first); expect(f.calls).toHaveLength(0);
    gate.release(); await last;
    expect(f.applied).toEqual([{ entry_hold: 'posting', entry_post_agreed: false }, { entry_hold: null }]);
    expect(f.rows[0].entry_post_agreed).toBe(false); expect(f.rows[0].entry_hold).toBeNull();
    expect(f.e.entryHoldWriteChains.has(id(4))).toBe(false);
  });
  it.each(['missing', 'ambiguous', 'missing_seat', 'missing_occupancy'] as const)('explicitly skips %s target without blocking the caller', async (kind) => {
    const f = fixture();
    if (kind === 'missing') f.e.seatedPlayers = [];
    if (kind === 'ambiguous') f.e.seatedPlayers = [f.original, { ...f.original }];
    if (kind === 'missing_seat') f.original.seat_id = '';
    if (kind === 'missing_occupancy') f.original.occupancy_id = '';
    expect(() => f.e.registerWaitForBB(id(4))).not.toThrow();
    expect(f.e.waitingForBB.has(id(4))).toBe(true);
    expect(f.warning).toHaveBeenCalledWith(expect.stringContaining('original seat occupancy unavailable or ambiguous'));
    expect(f.e.entryHoldWriteChains.has(id(4))).toBe(false);
    await Promise.resolve(); expect(from).not.toHaveBeenCalled();
  });
  it.each(['reject', 'getter_throw', 'error'] as const)('later writes progress after %s thenable outcome', async (mode) => {
    const f = fixture(); f.failures.push(mode);
    f.enqueue({ hold: 'posting', agreed: false }); const first = f.tail();
    f.enqueue({ hold: null, agreed: false }); const last = f.tail();
    await first; await last;
    expect(f.warning).toHaveBeenCalled(); expect(f.calls).toHaveLength(2);
    expect(f.applied).toEqual([{ entry_hold: null, entry_post_agreed: false }]);
    expect(f.rows[0].entry_hold).toBeNull(); expect(f.e.entryHoldWriteChains.has(id(4))).toBe(false);
  });
  it('excludes tournaments before resolving a target or changing caller sets', async () => {
    const f = fixture(); vi.mocked(f.e.isTournamentTable).mockReturnValue(true); f.e.seatedPlayers = [];
    expect(f.enqueue({ hold: null })).toBeUndefined(); f.e.registerWaitForBB(id(4));
    await Promise.resolve(); expect(from).not.toHaveBeenCalled(); expect(f.warning).not.toHaveBeenCalled();
    expect(f.e.waitingForBB.has(id(4))).toBe(false);
  });
  it('actual register and post caller preserve state and queue original patch order', async () => {
    const f = fixture(), gate = barrier(); f.e.entryHoldWriteChains.set(id(4), gate.promise);
    vi.spyOn(f.e, 'getSBSeatIndex').mockReturnValue(2); vi.spyOn(f.e, 'getButtonSeatIndex').mockReturnValue(3);
    f.e.registerWaitForBB(id(4)); expect(f.e.waitingForBB.has(id(4))).toBe(true);
    const result = f.e.postBBToEnter(id(4));
    expect(result.success).toBe(true); expect(f.e.waitingForBB.has(id(4))).toBe(false);
    expect(f.e.postingBBToEnter.has(id(4))).toBe(true); expect(f.original.stack).toBe(100);
    expect(f.calls).toHaveLength(0); const pending = f.tail(); gate.release(); await pending;
    expect(f.applied).toEqual([{ entry_hold: 'waiting' }, { entry_hold: 'posting', entry_post_agreed: false }]);
    expect(f.rows[0].entry_hold).toBe('posting');
  });
});
