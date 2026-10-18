import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  read: (_table: string, _ops: Array<[string, ...unknown[]]>): Promise<unknown> =>
    Promise.resolve({ data: [], error: null }),
  calls: [] as Array<{ table: string; ops: Array<[string, ...unknown[]]> }>,
  cashout: vi.fn(),
}));
vi.mock('./supabase.js', () => ({
  supabase: {
    from(table: string) {
      const ops: Array<[string, ...unknown[]]> = [];
      const builder: unknown = new Proxy(
        {},
        {
          get(_target, key) {
            if (key === 'then')
              return (resolve: (x: unknown) => void, reject: (e: unknown) => void) => {
                io.calls.push({ table, ops: [...ops] });
                return io.read(table, ops).then(resolve, reject);
              };
            return (...args: unknown[]) => {
              ops.push([String(key), ...args]);
              return builder;
            };
          },
        }
      );
      return builder;
    },
  },
  atomicCashout: (...args: unknown[]) => io.cashout(...args),
}));

import { HorseLifecycleManager } from './HorseLifecycleManager.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';

function deferred<T>() {
  let resolve!: (x: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const empty = () => Promise.resolve({ data: [], error: null });
const columns = (ops: Array<[string, ...unknown[]]>) =>
  ops.find(([name]) => name === 'select')?.[1];
let manager: HorseLifecycleManager;
beforeEach(() => {
  setMaintenanceFrozen(false);
  io.calls = [];
  io.cashout.mockReset();
  io.cashout.mockResolvedValue(undefined);
  manager = new HorseLifecycleManager();
});
afterEach(async () => {
  await manager.stop();
  setMaintenanceFrozen(false);
});

it.each(['shutdown', 'freeze'] as const)(
  'does not continue a completed-field read after %s',
  async (boundary) => {
    const field = deferred<{ data: unknown[]; error: null }>();
    const fieldStarted = deferred<void>();
    io.read = (table, ops) => {
      if (table === 'tournaments' && columns(ops) === 'id, name') {
        fieldStarted.resolve();
        return field.promise;
      }
      if (table === 'tournament_players' && columns(ops) === 'user_id')
        return Promise.resolve({ data: [{ user_id: 'horse' }], error: null });
      if (table === 'profiles' && columns(ops) === 'id')
        return Promise.resolve({ data: [{ id: 'horse' }], error: null });
      return empty();
    };
    manager.start();
    await fieldStarted.promise;
    if (boundary === 'shutdown') void manager.stop();
    else setMaintenanceFrozen(true);
    const admitted = io.calls.length;
    field.resolve({ data: [{ id: 'finished', name: 'Finished Event' }], error: null });
    if (boundary === 'shutdown') await manager.stop();
    else
      await Promise.all([
        ...(manager as unknown as { lifecycleJobs: Set<Promise<unknown>> }).lifecycleJobs,
      ]);
    expect(io.calls.slice(admitted)).toEqual([]);
    expect(io.cashout).not.toHaveBeenCalled();
  }
);

it.each(['shutdown', 'freeze'] as const)(
  'joins an accepted cashout but admits no next seat or profile write after %s',
  async (boundary) => {
    const admitted = deferred<void>();
    const cashout = deferred<void>();
    io.cashout.mockImplementation(() => {
      admitted.resolve();
      return cashout.promise;
    });
    io.read = (table, ops) => {
      if (table === 'hand_history') return Promise.resolve({ data: null, error: null });
      if (table === 'table_seats' && String(columns(ops)).includes('joined_at'))
        return Promise.resolve({
          data: [1, 2].map((n) => ({
            id: `seat-${n}`,
            occupancy_id: `occupancy-${n}`,
            table_id: 'cash-table',
            user_id: `horse-${n}`,
            seat_number: n,
            stack: 50,
            joined_at: '2020-01-01T00:00:00Z',
          })),
          error: null,
        });
      if (table === 'tables')
        return Promise.resolve({
          data: [{ id: 'cash-table', tournament_id: null, cluster_id: null }],
          error: null,
        });
      return empty();
    };
    manager.start();
    await admitted.promise;
    let stopped = false;
    if (boundary === 'freeze') setMaintenanceFrozen(true);
    const join =
      boundary === 'shutdown'
        ? manager.stop()
        : Promise.all([
            ...(manager as unknown as { lifecycleJobs: Set<Promise<unknown>> }).lifecycleJobs,
          ]);
    const stop = join.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    const callsAtFence = io.calls.length;
    cashout.resolve();
    await stop;
    expect(stopped).toBe(true);
    expect(io.cashout).toHaveBeenCalledTimes(1);
    expect(io.calls.slice(callsAtFence)).toEqual([]);
  }
);

it.each(['profiles', 'table_seats'])(
  'does not admit another %s page after the owner stops',
  async (table) => {
    const started = deferred<void>();
    const page = deferred<{ data: unknown[]; error: null }>();
    let reads = 0;
    io.read = (requested) => {
      if (requested === table && reads++ === 0) {
        started.resolve();
        return page.promise;
      }
      return empty();
    };
    manager.start();
    await started.promise;
    const stop = manager.stop();
    const admitted = io.calls.length;
    page.resolve({
      data: Array.from({ length: 1000 }, (_, n) => ({ id: `row-${n}` })),
      error: null,
    });
    await stop;
    expect(io.calls.slice(admitted)).toEqual([]);
  }
);

it('withdraws later field chunks after joining the first admitted chunk', async () => {
  const started = deferred<void>();
  const chunk = deferred<{ data: Array<{ id: string }>; error: null }>();
  const field = Array.from({ length: 600 }, (_, n) => ({ user_id: `horse-${n}` }));
  io.read = (table, ops) => {
    if (table === 'tournaments' && columns(ops) === 'id, name')
      return Promise.resolve({ data: [{ id: 'finished', name: 'Finished Event' }], error: null });
    if (table === 'tournament_players') return Promise.resolve({ data: field, error: null });
    if (table === 'profiles' && columns(ops) === 'id') {
      started.resolve();
      return chunk.promise;
    }
    return empty();
  };
  manager.start();
  await started.promise;
  const stop = manager.stop();
  const admitted = io.calls.length;
  chunk.resolve({ data: field.slice(0, 200).map((x) => ({ id: x.user_id })), error: null });
  await stop;
  expect(io.calls.slice(admitted)).toEqual([]);
});
