import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readXmttLobby, readXmttWaitlistPositions } from '../src/services/xmttLobbyReads';
const state = vi.hoisted(() => ({
  calls: [] as Array<any>,
  rows: [] as Array<any>,
  positions: [] as Array<any>,
  failure: null as unknown,
  count: undefined as number | null | undefined,
}));
vi.mock('../src/utils/unionScope', () => ({
  clubGamesOrFilter: vi.fn(async () => 'club_id.in.(club,union)'),
}));
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from(table: string) {
      const call: any = { table, methods: {} };
      state.calls.push(call);
      const builder: any = {};
      for (const method of [
        'select',
        'or',
        'in',
        'eq',
        'ilike',
        'abortSignal',
        'order',
        'range',
        'limit',
      ])
        builder[method] = (...args: any[]) => {
          (call.methods[method] ??= []).push(args);
          return builder;
        };
      builder.then = (resolve: (value: any) => unknown) => {
        if (state.failure)
          return Promise.resolve({ data: null, error: state.failure, count: null }).then(resolve);
        if (table === 'tournament_waitlists') {
          const ids = call.methods.in[0][1];
          return Promise.resolve({
            data: state.positions.filter((row) => ids.includes(row.tournament_id)),
            error: null,
          }).then(resolve);
        }
        const filter = call.methods.ilike?.[0][1];
        const matches = filter
          ? state.rows.filter((row) => row.status.toLowerCase() === filter)
          : state.rows;
        const range = call.methods.range?.[0];
        return Promise.resolve({
          data: range ? matches.slice(range[0], range[1] + 1) : null,
          count: state.count === undefined ? matches.length : state.count,
          error: null,
        }).then(resolve);
      };
      return builder;
    },
  },
}));
beforeEach(() => {
  state.calls = [];
  state.rows = Array.from({ length: 1201 }, (_, i) => ({
    id: `t-${i}`,
    status: i % 2 ? 'COMPLETED' : 'Registering',
  }));
  state.positions = [];
  state.failure = null;
  state.count = undefined;
});
const signal = () => new AbortController().signal;
describe('bounded authoritative XMTT lobby reads', () => {
  it('reads fifty rows and exact whole-scope counts instead of truncating the total at1000', async () => {
    const value = await readXmttLobby('club', 'all', 50, signal());
    expect(value.rows).toHaveLength(50);
    expect(value.total).toBe(1201);
    expect(value.counts).toEqual({ registering: 601, running: 0, completed: 600 });
    expect(state.calls).toHaveLength(4);
    expect(state.calls.filter((c) => c.methods.range)).toHaveLength(1);
    for (const c of state.calls) {
      expect(c.methods.or).toEqual([['club_id.in.(club,union)']]);
      expect(c.methods.in).toEqual([['tournament_type', ['MTT', 'XMTT']]]);
      expect(c.methods.select[0][1].count).toBe('exact');
    }
    const page = state.calls.find((c) => c.methods.range);
    expect(page.methods.order).toEqual([
      ['start_time', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(page.methods.range).toEqual([[0, 49]]);
  });
  it('retains mixed-case status semantics and reads only the requested pages', async () => {
    const value = await readXmttLobby('club', 'registering', 100, signal());
    expect(value.rows).toHaveLength(100);
    expect(value.total).toBe(601);
    expect(state.calls.filter((c) => c.methods.range).map((c) => c.methods.range)).toEqual([
      [[0, 49]],
      [[50, 99]],
    ]);
    expect(value.rows.at(-1).id).toBe('t-198');
  });
  it.each([null, -1, NaN])('refuses unknown or invalid count%s', async (count) => {
    state.count = count;
    await expect(readXmttLobby('club', 'all', 50, signal())).rejects.toThrow('Unavailable');
  });
  it('keeps read failures observable', async () => {
    state.failure = { message: 'denied' };
    await expect(readXmttLobby('club', 'all', 50, signal())).rejects.toEqual(state.failure);
  });
  it('refuses duplicate IDs across moving offset pages', async () => {
    state.rows[50] = state.rows[0];
    await expect(readXmttLobby('club', 'all', 100, signal())).rejects.toThrow('List Changed');
  });
  it('does not start queries after scope cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readXmttLobby('club', 'all', 50, controller.signal)).rejects.toThrow('Cancelled');
    expect(state.calls).toHaveLength(0);
  });
});
describe('owner-scoped batched legacy exit reads', () => {
  it('uses one bounded query for50 displayed IDs and no per-event count query', async () => {
    const ids = state.rows.slice(0, 50).map((row) => row.id);
    state.positions = [{ tournament_id: ids[4], position: 7 }];
    const value = await readXmttWaitlistPositions(ids, 'owner', signal());
    expect(Object.keys(value)).toHaveLength(50);
    expect(value[ids[4]]).toBe(7);
    expect(value[ids[0]]).toBeNull();
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].methods.eq).toEqual([['user_id', 'owner']]);
    expect(state.calls[0].methods.in).toEqual([['tournament_id', ids]]);
    expect(state.calls[0].methods.select).toEqual([['tournament_id, position']]);
  });
  it('splits a deliberately expanded page into bounded requests and deduplicates IDs', async () => {
    const ids = state.rows.slice(0, 101).map((row) => row.id);
    await readXmttWaitlistPositions([...ids, ids[0]], 'owner', signal());
    expect(state.calls.map((c) => c.methods.in[0][1].length)).toEqual([50, 50, 1]);
  });
  it.each([null, 0, -1, 1.5, '3'])(
    'rejects malformed position%s instead of calling it absent',
    async (position) => {
      state.positions = [{ tournament_id: 't-0', position }];
      await expect(readXmttWaitlistPositions(['t-0'], 'owner', signal())).rejects.toThrow(
        'Unavailable'
      );
    }
  );
  it('refuses duplicate source positions', async () => {
    state.positions = [
      { tournament_id: 't-0', position: 1 },
      { tournament_id: 't-0', position: 2 },
    ];
    await expect(readXmttWaitlistPositions(['t-0'], 'owner', signal())).rejects.toThrow(
      'Unavailable'
    );
  });
  it('never turns a failed batch into an empty membership', async () => {
    state.failure = { message: 'failed' };
    await expect(readXmttWaitlistPositions(['t-0'], 'owner', signal())).rejects.toEqual(
      state.failure
    );
  });
});
