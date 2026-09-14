import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameServer as GameServerType } from './GameServer.js';

type TableRow = {
  id: string;
  tournament_id: string | null;
  current_players: number;
  status: string;
};

let GameServer: typeof GameServerType;
let supabase: typeof import('./services/supabase.js').supabase;
let errorReporter: typeof import('./services/errorReporter.js');

beforeAll(async () => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-placeholder-key');
  ({ GameServer } = await import('./GameServer.js'));
  ({ supabase } = await import('./services/supabase.js'));
  errorReporter = await import('./services/errorReporter.js');
});

beforeEach(() => {
  vi.stubEnv('DISABLE_HORSE_FLEET', 'false');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(errorReporter, 'reportError').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Execute the real boot method without constructing a server or opening a socket. */
function bootFixture(
  rows: TableRow[],
  options: { beforeTableWrite?: () => void; rejectTableWrite?: boolean } = {}
) {
  const background: Promise<unknown>[] = [];
  const writes: Array<{ relation: string; values: Record<string, unknown> }> = [];
  const from = vi.spyOn(supabase, 'from').mockImplementation((relation: string) => {
    if (!['profiles', 'tables', 'tournaments'].includes(relation)) {
      throw new Error(`Unexpected boot data access: ${relation}`);
    }
    let values: Record<string, unknown> | undefined;
    const filters: Array<(row: TableRow) => boolean> = [];
    const query = {
      update(next: Record<string, unknown>) {
        values = next;
        return query;
      },
      select: () => query,
      eq: () => query,
      lt: () => query,
      is(column: string, value: unknown) {
        filters.push((row) => row[column as keyof TableRow] === value);
        return query;
      },
      neq(column: string, value: unknown) {
        filters.push((row) => row[column as keyof TableRow] !== value);
        return query;
      },
      in(column: string, allowed: unknown[]) {
        filters.push((row) => allowed.includes(row[column as keyof TableRow]));
        return query;
      },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve()
          .then(() => {
            if (values) writes.push({ relation, values });
            if (relation === 'tables' && values) {
              options.beforeTableWrite?.();
              if (options.rejectTableWrite) return { error: { message: 'restart write refused' } };
              for (const row of rows) {
                if (filters.every((filter) => filter(row))) Object.assign(row, values);
              }
            }
            return { data: [], count: 0, error: null };
          })
          .then(resolve, reject);
      },
    };
    return query as never;
  });
  const server = Object.assign(Object.create(GameServer.prototype), {
    lifecycleGeneration: 1,
    reapDeadLeases: vi.fn().mockResolvedValue(undefined),
    directAdmissionIsCurrent: () => false,
    launchServerLifecycleJob: (job: Promise<unknown>) => background.push(job),
  }) as { cleanupStaleData: (protectedId?: string) => Promise<void> };
  return {
    from,
    writes,
    async restart(protectedId?: string) {
      await server.cleanupStaleData(protectedId);
      await Promise.all(background);
    },
  };
}

const cash = (id: string, players: number, status = 'running'): TableRow => ({
  id,
  tournament_id: null,
  current_players: players,
  status,
});

describe('a cash restart preserves the census of surviving seats', () => {
  it.each([0, 2, 6])('keeps %i players while resetting the live table status', async (players) => {
    const rows = [cash('main', players)];
    const fixture = bootFixture(rows);
    await fixture.restart();
    expect(rows).toEqual([cash('main', players, 'waiting')]);
    expect(fixture.writes.filter((write) => write.relation === 'tables')).toHaveLength(1);
  });

  it('cannot erase the count committed by a seat arriving before the boot write lands', async () => {
    const rows = [cash('main', 2)];
    const fixture = bootFixture(rows, { beforeTableWrite: () => rows[0].current_players++ });
    await fixture.restart();
    expect(rows[0]).toEqual(cash('main', 3, 'waiting'));
  });

  it('preserves closed tables, tournaments, and counts across repeated restarts', async () => {
    const rows = [
      cash('main', 4),
      cash('feeder', 2, 'waiting'),
      cash('closed', 0, 'closed'),
      { ...cash('event', 8), tournament_id: 'tournament' },
    ];
    const fixture = bootFixture(rows);
    await fixture.restart();
    await fixture.restart();
    expect(rows).toEqual([
      cash('main', 4, 'waiting'),
      cash('feeder', 2, 'waiting'),
      cash('closed', 0, 'closed'),
      { ...cash('event', 8), tournament_id: 'tournament' },
    ]);
    expect(fixture.from.mock.calls.some(([relation]) => relation === 'table_seats')).toBe(false);
  });

  it('reports a refused table-status write without claiming that reset succeeded', async () => {
    const rows = [cash('main', 4)];
    const fixture = bootFixture(rows, { rejectTableWrite: true });
    await fixture.restart();
    expect(rows).toEqual([cash('main', 4)]);
    expect(errorReporter.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'GameServer.cash_table_restart_status_failed'
    );
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Reset cash table'));
  });

  it('still protects the selected table in the isolated E2E mode', async () => {
    const rows = [cash('protected', 4), cash('other', 2)];
    const fixture = bootFixture(rows);
    await fixture.restart('protected');
    expect(rows[0]).toEqual(cash('protected', 4));
    expect(rows[1].status).toBe('closed');
  });
});
