import { beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  result: { data: null, error: null } as any,
  reads: [] as Array<{ table: string; columns?: string; filters: Array<[string, unknown]> }>,
}));
vi.mock('./client.js', () => ({
  supabase: {
    from(table: string) {
      const read = { table, filters: [] } as (typeof io.reads)[number];
      io.reads.push(read);
      const query = {
        select(columns: string) {
          read.columns = columns;
          return query;
        },
        eq(column: string, value: unknown) {
          read.filters.push([column, value]);
          return query;
        },
        async maybeSingle() {
          return io.result;
        },
      };
      return query;
    },
  },
}));
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));
import { loadTournamentBlinds } from './tables.js';

beforeEach(() => {
  io.reads = [];
  io.result = { data: null, error: null };
});

it('reads only current blinds for the exact table and tournament on every hand', async () => {
  io.result.data = { small_blind: 10, big_blind: 20, ante: 2 };
  expect(await loadTournamentBlinds('table-a', 'event-a')).toEqual(io.result.data);
  io.result.data = { small_blind: 20, big_blind: 40, ante: 4 };
  expect(await loadTournamentBlinds('table-a', 'event-a')).toEqual(io.result.data);
  expect(io.reads).toEqual(
    Array.from({ length: 2 }, () => ({
      table: 'tables',
      columns: 'small_blind, big_blind, ante',
      filters: [
        ['id', 'table-a'],
        ['tournament_id', 'event-a'],
      ],
    }))
  );
});

it('refuses a missing or reassigned table instead of dealing with old blinds', async () => {
  await expect(loadTournamentBlinds('table-a', 'event-a')).rejects.toThrow('not found');
  expect(io.reads).toHaveLength(1);
});

it('propagates the read failure without adding another query or cached fallback', async () => {
  io.result = { data: null, error: { message: 'fetch failed' } };
  await expect(loadTournamentBlinds('table-a', 'event-a')).rejects.toThrow('fetch failed');
  expect(io.reads).toHaveLength(1);
});
