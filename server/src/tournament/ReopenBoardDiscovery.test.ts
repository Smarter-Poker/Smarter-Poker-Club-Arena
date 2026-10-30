import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const id = (prefix: string, n: number) => `${prefix}-${String(n).padStart(6, '0')}`;
function harness() {
  const server = Object.assign(Object.create(GameServer.prototype), {
    running: true,
    lifecycleGeneration: 1,
    tournamentRetirementCustody: {
      admissionAllowed: () => true,
      withAdmission: async (
        _id: string,
        current: () => boolean,
        work: (check: () => void) => Promise<unknown>
      ) => {
        if (!current()) throw new Error('stale');
        return work(() => {
          if (!current()) throw new Error('stale');
        });
      },
    },
  }) as any;
  const events = [{ id: 'event', status: 'RUNNING', start_time: null }];
  const tables = [
    {
      id: id('table', 0),
      tournament_id: 'event',
      status: 'closed',
      is_deleted: false,
      created_at: '2026-01-01',
    },
  ];
  const seats = Array.from({ length: 2 }, (_, n) => ({
    id: id('seat', n),
    table_id: tables[0].id,
  }));
  const writes = vi.fn();
  const read = vi.fn(
    (table: string, cursor: string | null, limit: number, ids: string[], from: number) => {
      const source =
        table === 'tournaments'
          ? events
          : table === 'tables'
            ? tables
            : seats.filter((s) => ids.includes(s.table_id));
      return {
        data: source
          .filter((r) => !cursor || r.id > cursor)
          .slice(from, from + Math.min(1000, limit)),
        error: null,
      } as any;
    }
  );
  vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
    let cursor: string | null = null,
      limit = 1000,
      from = 0,
      ids: string[] = [],
      update: unknown;
    const b: any = {};
    for (const name of ['select', 'eq', 'is', 'order']) b[name] = () => b;
    b.in = (_key: string, values: string[]) => {
      ids = values;
      return b;
    };
    b.gt = (_key: string, value: string) => {
      cursor = value;
      return b;
    };
    b.limit = (n: number) => {
      limit = n;
      return b;
    };
    b.range = (start: number, end: number) => {
      from = start;
      limit = end - start + 1;
      return b;
    };
    b.update = (value: unknown) => {
      update = value;
      return b;
    };
    b.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        update
          ? (writes(table, update), { data: [], error: null })
          : read(table, cursor, limit, ids, from)
      ).then(resolve);
    return b;
  });
  return { server, events, tables, seats, writes, read };
}
describe('closed tournament table decisions require the complete current board', () => {
  it('does not reopen a closed table when an open sibling is beyond table 1000', async () => {
    const h = harness();
    h.tables.push(
      ...Array.from({ length: 1000 }, (_, n) => ({
        ...h.tables[0],
        id: id('table', n + 1),
        status: n === 999 ? 'running' : 'closed',
        created_at: '2025-01-01',
      }))
    );
    await h.server.reopenTablesClosedUnderLiveTournaments();
    expect(h.writes).not.toHaveBeenCalled();
    expect(h.read.mock.calls.filter(([table]) => table === 'tables').length).toBeGreaterThan(1);
  });
  it('preserves the existing conditional reopen for a fully read occupied closed table', async () => {
    const h = harness();
    await h.server.reopenTablesClosedUnderLiveTournaments();
    expect(h.writes).toHaveBeenCalledTimes(1);
    expect(h.writes).toHaveBeenCalledWith('tables', { status: 'running', current_players: 2 });
  });
  it.each(['error', 'null'])('does not plan from an unreadable %s table suffix', async (kind) => {
    const h = harness();
    h.tables.push(
      ...Array.from({ length: 999 }, (_, n) => ({
        ...h.tables[0],
        id: id('table', n + 1),
        created_at: '2025-01-01',
      }))
    );
    const read = h.read.getMockImplementation()!;
    h.read.mockImplementation((...args) =>
      args[0] === 'tables' && args[1]
        ? { data: null, error: kind === 'error' ? new Error('offline') : null }
        : read(...args)
    );
    await h.server.reopenTablesClosedUnderLiveTournaments();
    expect(h.writes).not.toHaveBeenCalled();
  });
  it('does not replace an unreadable occupied-chair answer with zero', async () => {
    const h = harness();
    h.events[0].status = 'REGISTERING';
    const read = h.read.getMockImplementation()!;
    h.read.mockImplementation((...args) =>
      args[0] === 'table_seats' ? { data: null, error: null } : read(...args)
    );
    await h.server.reopenTablesClosedUnderLiveTournaments();
    expect(h.writes).not.toHaveBeenCalled();
  });
  it('never writes after lifecycle ownership changes during inventory reads', async () => {
    const h = harness();
    const read = h.read.getMockImplementation()!;
    h.read.mockImplementation((...args) => {
      if (args[0] === 'table_seats') h.server.lifecycleGeneration++;
      return read(...args);
    });
    await h.server.reopenTablesClosedUnderLiveTournaments();
    expect(h.writes).not.toHaveBeenCalled();
  });
});
