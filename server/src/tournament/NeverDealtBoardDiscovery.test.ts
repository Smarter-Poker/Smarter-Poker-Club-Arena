import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
import { reportError } from '../services/errorReporter.js';
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(reportError).mockClear();
});
const event = (i: number) => ({ id: `event-${String(i).padStart(5, '0')}`, name: `Event ${i}` });
function harness(size = 16, passes = 2) {
  const rows = Array.from({ length: size }, (_, i) => event(i));
  const server = Object.create(GameServer.prototype) as any;
  let running = true;
  let pass = 0;
  const retire = vi.fn();
  const inspected = vi.fn();
  const tables = vi.fn((id: string, cursor: string | null, limit: number): any => ({
    data: [{ id, status: 'playing' }],
    error: null,
  }));
  const seats = vi.fn((_ids: string[]): any => ({ data: [], count: 2, error: null }));
  const history = vi.fn((ids: string[]): any => ({
    data: [],
    count: ids.includes(rows.at(-1)?.id ?? '') ? 0 : 1,
    error: null,
  }));
  const board = vi.fn((cursor: string | null, limit: number): any => ({
    data: rows.filter((r) => !cursor || r.id > cursor).slice(0, limit),
    error: null,
  }));
  vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
    let fields = '',
      status = '',
      cursor: string | null = null,
      limit = 1000;
    let ids: string[] = [];
    let tournamentId = '';
    const b: Record<string, any> = {};
    for (const method of ['is', 'not', 'lte', 'lt', 'order', 'range', 'update'])
      b[method] = () => b;
    b.select = (value: string) => {
      fields = value;
      return b;
    };
    b.eq = (key: string, value: string) => {
      if (key === 'status') status = value;
      if (key === 'tournament_id') tournamentId = value;
      return b;
    };
    b.in = (key: string, value: string[]) => {
      ids = value;
      return b;
    };
    b.gt = (key: string, value: string) => {
      if (key === 'id') cursor = value;
      return b;
    };
    b.limit = (value: number) => {
      limit = value;
      return b;
    };
    b.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        table === 'tournaments' && status === 'RUNNING' && fields === 'id, name, started_at'
          ? board(cursor, limit)
          : table === 'tables'
            ? (inspected(tournamentId), tables(tournamentId, cursor, limit))
            : table === 'hand_history'
              ? history(ids)
              : table === 'table_seats'
                ? seats(ids)
                : table === 'tournament_players' && fields === 'id'
                  ? { data: [], count: 2, error: null }
                  : { data: [], error: null, count: 0 }
      ).then(resolve);
    return b as never;
  });
  Object.assign(server, {
    lifecycleGeneration: 1,
    tournamentEngines: new Map(rows.map((r) => [r.id, { isRunning: () => true }])),
    retireTournamentManagerInDiscovery: retire,
    tournamentOwnedTables: new Set(),
    tournamentTopUpsInFlight: new Map(),
    emptyEventCancelsInFlight: new Map(),
    readDurableEmptyTopUps: vi.fn(async () => new Map()),
    recordPastStartTopUpOutcome: vi.fn(async () => {}),
    lastMttRampAt: new Map(),
    pastStartTopUpClock: new Map(),
    registeringButFinalizedReported: new Set(),
    finalizedFinishAttempt: new Map(),
    seatFirstFullSince: new Map(),
    tournamentManagerAdmissionOperations: new Map(),
    tournamentManagerAdmissionRetryTimers: new Map(),
    discoveryJobs: new Set(),
    readSeatFirstPaidSeats: vi.fn(async () => new Map()),
    completingFirstSeenAt: new Map(),
    decidedEventsHeldByQuarantine: 2,
    decidedEventsHeldReported: new Map([['old', 'held']]),
    directAdmissionIsCurrent: (g: number) => running && g === server.lifecycleGeneration,
    sleep: vi.fn(async () => {
      await server.drainDiscoveryJobs();
      if (++pass >= passes) running = false;
    }),
    ensureTournamentManagerAdmission: vi.fn(async () => undefined),
    tournamentRecurring: {
      topUpWithHorses: vi.fn(async () => 0),
      seatFirstPartnerHoldUntil: vi.fn(() => -Infinity),
    },
  });
  return { server, board, rows, retire, inspected, tables, history, seats };
}
describe('never-dealt discovery examines successive bounded candidate pages', () => {
  it('reaches the sixteenth event instead of checking the first fifteen forever', async () => {
    const { server, retire, rows, inspected } = harness();
    await server.discoverTournaments();
    expect(inspected).toHaveBeenCalledWith(rows[15].id);
    expect(retire).toHaveBeenCalledWith(
      rows[15].id,
      expect.anything(),
      'GameServer.never_dealt_stop_engine'
    );
  });
  it('does not retire a manager when discovery stops during its board read', async () => {
    const { server, board, rows, retire } = harness(1, 1);
    board.mockImplementation(() => {
      server.lifecycleGeneration++;
      return { data: rows, error: null };
    });
    await server.discoverTournaments();
    expect(board).toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  });
  it('wraps after a short page, preserving the fifteen-event per-pass budget', async () => {
    const { server, board, rows, inspected } = harness(16, 3);
    await server.discoverTournaments();
    expect(board.mock.calls).toEqual([
      [null, 15],
      [rows[14].id, 15],
      [null, 15],
    ]);
    expect(inspected).toHaveBeenCalledTimes(31);
  });
  it('wraps after the empty suffix of an exactly full page', async () => {
    const { server, board, rows, inspected } = harness(15, 3);
    await server.discoverTournaments();
    expect(board.mock.calls).toEqual([
      [null, 15],
      [rows[14].id, 15],
      [null, 15],
    ]);
    expect(inspected).toHaveBeenCalledTimes(30);
  });
  it.each(['error', 'null', 'backward'])(
    'retains the cursor on a %s candidate response',
    async (kind) => {
      const { server, board, rows, inspected, retire } = harness(16, 1);
      server.neverDealtCandidateCursor = rows[14].id;
      board.mockReturnValue(
        kind === 'error'
          ? { data: null, error: new Error('offline') }
          : { data: kind === 'null' ? null : [rows[0]], error: null }
      );
      await server.discoverTournaments();
      expect(server.neverDealtCandidateCursor).toBe(rows[14].id);
      expect(inspected).not.toHaveBeenCalled();
      expect(retire).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalled();
    }
  );
  it('does not retire after lifecycle loss during a dependent table read', async () => {
    const { server, inspected, retire } = harness(1, 1);
    inspected.mockImplementation(() => {
      server.lifecycleGeneration++;
    });
    await server.discoverTournaments();
    expect(inspected).toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  });
  it('does not classify a field as never-dealt when its completed hand is beyond table 1000', async () => {
    const { server, tables, history, retire } = harness(1, 1);
    const field = Array.from({ length: 1001 }, (_, i) => ({
      id: `table-${String(i).padStart(5, '0')}`,
      status: 'playing',
    }));
    tables.mockImplementation((_id, cursor, limit) => ({
      data: field.filter((r) => !cursor || r.id > cursor).slice(0, limit),
      error: null,
    }));
    history.mockImplementation((ids) => ({
      data: [],
      count: ids.includes(field[1000].id) ? 1 : 0,
      error: null,
    }));
    await server.discoverTournaments();
    expect(retire).not.toHaveBeenCalled();
    expect(history.mock.calls.some(([ids]) => ids.includes(field[1000].id))).toBe(true);
    expect(Math.max(...history.mock.calls.map(([ids]) => ids.length))).toBeLessThanOrEqual(200);
  });
  it('does not retire from a table prefix when the next page is unreadable', async () => {
    const { server, tables, history, retire } = harness(1, 1);
    const field = Array.from({ length: 1000 }, (_, i) => ({
      id: `table-${String(i).padStart(5, '0')}`,
      status: 'playing',
    }));
    tables.mockImplementation((_id, cursor) =>
      cursor ? { data: null, error: new Error('offline') } : { data: field, error: null }
    );
    history.mockReturnValue({ data: [], count: 0, error: null });
    await server.discoverTournaments();
    expect(retire).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });
  it.each(['error', 'null'])(
    'does not retire after an unreadable %s seat-count chunk',
    async (kind) => {
      const { server, tables, history, seats, retire } = harness(1, 1);
      const field = Array.from({ length: 201 }, (_, i) => ({
        id: `table-${String(i).padStart(5, '0')}`,
        status: 'playing',
      }));
      tables.mockReturnValue({ data: field, error: null });
      history.mockReturnValue({ data: [], count: 0, error: null });
      seats.mockImplementation((ids) =>
        ids.includes(field[200].id)
          ? { data: [], count: null, error: kind === 'error' ? new Error('offline') : null }
          : { data: [], count: 2, error: null }
      );
      await server.discoverTournaments();
      expect(seats).toHaveBeenCalledTimes(2);
      expect(retire).not.toHaveBeenCalled();
    }
  );
  it('does not retire when ownership changes while reading completed hands', async () => {
    const { server, history, retire } = harness(1, 1);
    history.mockImplementation(() => {
      server.lifecycleGeneration++;
      return { data: [], count: 0, error: null };
    });
    await server.discoverTournaments();
    expect(history).toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  });
});
