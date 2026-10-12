import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  rows: {} as Record<string, { data: any[]; error: unknown }>,
  calls: [] as unknown[],
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: async ({ email }: { email: string }) => ({
        data: { user: { email } },
        error: null,
      }),
      signOut: async () => ({ error: null }),
    },
    from: (table: string) => {
      mock.calls.push(['from', table]);
      const query: any = {
        then: (resolve: any) => Promise.resolve(mock.rows[table]).then(resolve),
      };
      for (const method of ['select', 'eq', 'in', 'is'])
        query[method] = (...args: unknown[]) => {
          mock.calls.push([method, ...args]);
          return query;
        };
      return query;
    },
  }),
}));
import { createHudClockReader } from '../e2e/support/tournamentHudWitness';
import type { TournamentBoardFacts } from '../e2e/support/tournamentBoardEnding';
const start: TournamentBoardFacts = {
  tableId: 'source',
  tournamentId: 'tournament',
  tournamentStatus: 'RUNNING',
  currentPlayers: 8,
  tableStatus: 'running',
  endedAt: null,
  bigBlind: 10,
  seatStacks: [100, 100],
  seatedUserIds: ['one', 'two'],
};
const end = { ...start, tableStatus: 'closed', seatStacks: [], seatedUserIds: [] };
beforeEach(() => {
  vi.stubEnv('SP_EMAIL', 'ca-customization-cert-postdeploy-unit@example.invalid');
  vi.stubEnv('SP_PASS', 'unit-only');
  vi.stubEnv('SUPABASE_URL', 'https://unit.invalid');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'unit-only');
  mock.calls = [];
  mock.rows = {
    tournament_players: {
      data: ['one', 'two'].map((user_id) => ({
        user_id,
        table_id: 'destination',
        status: 'playing',
      })),
      error: null,
    },
    table_seats: {
      data: ['one', 'two'].map((user_id) => ({ user_id, table_id: 'destination', stack: 100 })),
      error: null,
    },
    tables: {
      data: [{ id: 'destination', tournament_id: 'tournament', status: 'running' }],
      error: null,
    },
  };
});
afterEach(() => vi.unstubAllEnvs());
describe('closed board reader qualifies actual returned rows', () => {
  it('reads only the selected tournament and players and verifies active destination custody', async () => {
    const reader = await createHudClockReader();
    expect((await reader.accountClosedBoard(start, end)).relocatedUserIds).toEqual(['one', 'two']);
    expect(mock.calls).toContainEqual(['eq', 'tournament_id', 'tournament']);
    expect(mock.calls).toContainEqual(['in', 'user_id', ['one', 'two']]);
    expect(mock.calls).toContainEqual(['is', 'left_at', null]);
  });
  it.each(['partial', 'duplicate', 'wrong-tournament', 'missing-seat', 'nonplaying'])(
    'refuses incomplete custody: %s',
    async (reason) => {
      if (reason === 'partial') mock.rows.tournament_players.data.pop();
      if (reason === 'duplicate')
        mock.rows.tournament_players.data.push({ ...mock.rows.tournament_players.data[1] });
      if (reason === 'wrong-tournament') mock.rows.tables.data[0].tournament_id = 'other';
      if (reason === 'missing-seat') mock.rows.table_seats.data.pop();
      if (reason === 'nonplaying') mock.rows.tournament_players.data[1].status = 'eliminated';
      const reader = await createHudClockReader();
      expect((await reader.accountClosedBoard(start, end)).relocatedUserIds).not.toContain('two');
    }
  );
  it.each(['tournament_players', 'table_seats', 'tables'])(
    'propagates unreadable %s as a failure',
    async (table) => {
      mock.rows[table].error = new Error('read refused');
      const reader = await createHudClockReader();
      await expect(reader.accountClosedBoard(start, end)).rejects.toThrow('read refused');
    }
  );
  it('accounts for only a dated, ranked, zero-chip elimination', async () => {
    mock.rows.tournament_players.data[1] = {
      user_id: 'two',
      status: 'eliminated',
      chip_count: 0,
      position: 9,
      eliminated_at: '2026-10-06T00:17:05Z',
    };
    const reader = await createHudClockReader();
    expect((await reader.accountClosedBoard(start, end)).eliminatedUserIds).toEqual(['two']);
    mock.rows.tournament_players.data[1].chip_count = null;
    expect((await reader.accountClosedBoard(start, end)).eliminatedUserIds).toEqual([]);
  });
});
