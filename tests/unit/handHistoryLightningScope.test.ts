import { beforeEach, describe, expect, it, vi } from 'vitest';

const HERO = 'hero';
const POOL = '10000000-0000-4000-8000-000000000001';
const A = '20000000-0000-4000-8000-000000000001';
const B = '20000000-0000-4000-8000-000000000002';
const OTHER = '20000000-0000-4000-8000-000000000003';
const state = vi.hoisted(() => ({
  viewer: 'hero',
  rows: [] as any[],
  facts: [] as any[],
  rpc: vi.fn(),
  historyError: null as any,
  switchViewerOnHistoryRead: false,
  reads: [] as Array<{ table: string; calls: Array<[string, ...any[]]> }>,
}));
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => ({ userId: state.viewer }) }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => state.rpc(...args),
    from: (table: string) => {
      const read = { table, calls: [] as Array<[string, ...any[]]> };
      state.reads.push(read);
      const query: any = {};
      for (const method of ['select', 'in', 'eq', 'contains', 'lt', 'order', 'limit', 'range']) {
        query[method] = (...args: any[]) => {
          read.calls.push([method, ...args]);
          return query;
        };
      }
      query.then = (done: (result: any) => unknown) => {
        if (table === 'ca_hand_facts')
          return Promise.resolve({ data: state.facts, error: null }).then(done);
        if (table !== 'hand_history') return Promise.resolve({ data: [], error: null }).then(done);
        let data = [...state.rows];
        for (const [method, column, value] of read.calls) {
          if (method === 'in') data = data.filter((row) => column && value.includes(row[column]));
          if (method === 'eq') data = data.filter((row) => row[column] === value);
          if (method === 'contains' && column === 'players') {
            const requested = JSON.parse(value) as Array<{ userId: string }>;
            data = data.filter((row) =>
              requested.every((player) => row.players.some((p: any) => p.userId === player.userId))
            );
          }
          if (method === 'lt') data = data.filter((row) => row[column] < value);
          if (method === 'order') {
            data.sort((a, b) => (a[column] - b[column]) * (value?.ascending === false ? -1 : 1));
          }
          if (method === 'limit') data = data.slice(0, column);
          if (method === 'range') data = data.slice(column, value + 1);
        }
        if (state.switchViewerOnHistoryRead) state.viewer = 'other';
        return Promise.resolve({ data, error: state.historyError }).then(done);
      };
      return query;
    },
  },
}));

import { handHistoryService } from '../../src/services/HandHistoryService';

const row = (id: string, hand_number: number, table_id: string) => ({
  id,
  hand_number,
  table_id,
  created_at: '2026-10-27T14:00:00Z',
  players: [
    { userId: HERO, seat: 1, stack: 10 },
    { userId: 'villain', seat: 2, stack: 10 },
  ],
  actions: [{ userId: HERO, action: 'fold', amount: 0, street: 'preflop' }],
  hole_cards: {},
  winners: [{ userId: 'villain', amount: 3 }],
  pot_size: 3,
  small_blind: 1,
  big_blind: 2,
  game_variant: 'nlh',
});
const load = (limit = 50, offset = 0) =>
  handHistoryService.getPlayerHands(HERO, limit, {
    tableId: POOL,
    lightningPoolSessionId: POOL,
    throwOnError: true,
    offset,
  });

beforeEach(() => {
  state.viewer = HERO;
  state.reads.length = 0;
  state.historyError = null;
  state.switchViewerOnHistoryRead = false;
  state.rows = [row(A, 30, 'physical-a'), row(B, 20, 'physical-b'), row(OTHER, 40, 'unrelated')];
  state.facts = [
    {
      hand_id: A,
      user_id: HERO,
      hole_cards: [
        { rank: 'K', suit: 'spades' },
        { rank: 'Q', suit: 'hearts' },
      ],
    },
  ];
  state.rpc.mockReset().mockResolvedValue({
    data: [
      { hand_id: 'engine-a', hand_history_id: A, hand_number: 30 },
      { hand_id: 'engine-b', hand_history_id: B, hand_number: 20 },
    ],
    error: null,
  });
});

describe('Previous Hand reads a Lightning pool session, not a physical table', () => {
  it('loads only session-listed canonical hands across physical instances and retains private cards', async () => {
    const hands = await load();
    expect(hands.map((hand) => hand.id)).toEqual([A, B]);
    expect(state.rpc).toHaveBeenCalledWith('fn_lightning_recent_hands', {
      p_limit: 50,
      p_pool_session_id: POOL,
    });
    const history = state.reads.find((read) => read.table === 'hand_history')!;
    expect(history.calls).toContainEqual(['in', 'id', [A, B]]);
    expect(history.calls.some((call) => call[0] === 'eq' && call[1] === 'table_id')).toBe(false);
    expect(hands[0].players.find((player) => player.user_id === HERO)?.private_hole_cards).toEqual(
      state.facts[0].hole_cards
    );
    expect(
      hands[0].players.find((player) => player.user_id === 'villain')?.private_hole_cards
    ).toBeUndefined();
  });

  it('does not fabricate a hand before its history row is recorded', async () => {
    state.rpc.mockResolvedValue({
      data: [{ hand_id: 'pending', hand_history_id: null }],
      error: null,
    });
    expect(await load()).toEqual([]);
    expect(state.reads).toEqual([]);
  });

  it('reports a failed session read instead of returning a successful empty history', async () => {
    const error = { message: 'Session Read Unavailable' };
    state.rpc.mockResolvedValue({ data: null, error });
    await expect(load()).rejects.toEqual(error);
  });

  it('does not start or commit a read under a different viewer', async () => {
    state.viewer = 'other';
    expect(await load()).toEqual([]);
    expect(state.rpc).not.toHaveBeenCalled();
    state.viewer = HERO;
    state.rpc.mockImplementation(async () => {
      state.viewer = 'other';
      return { data: [{ hand_id: 'a', hand_history_id: A }], error: null };
    });
    expect(await load()).toEqual([]);
    expect(state.reads).toEqual([]);
  });

  it('discards canonical rows if the account changes after the session lookup', async () => {
    state.switchViewerOnHistoryRead = true;
    expect(await load()).toEqual([]);
  });

  it('exposes a canonical read failure instead of turning it into no completed hands', async () => {
    state.historyError = { message: 'Canonical History Unavailable' };
    await expect(load()).rejects.toThrow('Canonical History Unavailable');
  });

  it('keeps regular cash and tournament reads scoped to the requested table', async () => {
    expect(
      (await handHistoryService.getPlayerHands(HERO, 50, { tableId: 'physical-a' })).map(
        (hand) => hand.id
      )
    ).toEqual([A]);
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.reads.find((read) => read.table === 'hand_history')?.calls).toContainEqual([
      'eq',
      'table_id',
      'physical-a',
    ]);
  });

  it('reaches an older bomb beyond fifty owned hands without shifting when a new hand arrives', async () => {
    state.rows = Array.from({ length: 51 }, (_, index) =>
      row(
        `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        100 - index,
        'physical-a'
      )
    );
    const bomb = state.rows[50];
    bomb.bomb_pot = { ante: 6, boards: 2 };
    const foreign = row(OTHER, 200, 'physical-a');
    foreign.players = [{ userId: 'someone-else', seat: 1, stack: 10 }];
    state.rows.unshift(foreign, row('other-table', 300, 'physical-b'));
    const first = await handHistoryService.getPlayerHands(HERO, 50, { tableId: 'physical-a' });
    expect(first).toHaveLength(50);
    expect(first.map((hand) => hand.hand_number)).toEqual(
      Array.from({ length: 50 }, (_, index) => 100 - index)
    );
    expect(first.some((hand) => hand.id === bomb.id)).toBe(false);
    state.rows.unshift(row('newly-finished', 101, 'physical-a'));
    state.reads.length = 0;
    const older = await handHistoryService.getPlayerHands(HERO, 50, {
      tableId: 'physical-a',
      beforeHandNumber: first[first.length - 1].hand_number,
    });
    expect(older.map((hand) => hand.id)).toEqual([bomb.id]);
    expect(older[0].bomb_pot).toEqual(bomb.bomb_pot);
    const query = state.reads.find((read) => read.table === 'hand_history')!.calls;
    expect(query).toContainEqual(['contains', 'players', JSON.stringify([{ userId: HERO }])]);
    expect(query).toContainEqual(['eq', 'table_id', 'physical-a']);
    expect(query).toContainEqual(['lt', 'hand_number', 51]);
    expect(query.findIndex((call) => call[0] === 'lt')).toBeLessThan(
      query.findIndex((call) => call[0] === 'limit')
    );
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'ignores invalid older-hand cursor %s',
    async (beforeHandNumber) => {
      expect(
        (
          await handHistoryService.getPlayerHands(HERO, 50, {
            tableId: 'physical-a',
            beforeHandNumber,
          })
        ).map((hand) => hand.id)
      ).toEqual([A]);
      expect(
        state.reads
          .find((read) => read.table === 'hand_history')!
          .calls.some((call) => call[0] === 'lt')
      ).toBe(false);
    }
  );

  it('applies the physical-table cursor before an explicitly requested range', async () => {
    state.rows = [row(A, 30, 'physical-a'), row(B, 20, 'physical-a'), row(OTHER, 10, 'physical-a')];
    const hands = await handHistoryService.getPlayerHands(HERO, 1, {
      tableId: 'physical-a',
      beforeHandNumber: 30,
      offset: 1,
    });
    expect(hands.map((hand) => hand.id)).toEqual([OTHER]);
    const calls = state.reads.find((read) => read.table === 'hand_history')!.calls;
    expect(calls.findIndex((call) => call[0] === 'lt')).toBeLessThan(
      calls.findIndex((call) => call[0] === 'range')
    );
    expect(calls).toContainEqual(['range', 1, 1]);
  });
});
