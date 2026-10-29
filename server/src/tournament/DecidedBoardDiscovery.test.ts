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
function harness(size = 1001) {
  const rows = Array.from({ length: size }, (_, i) => event(i));
  const server = Object.create(GameServer.prototype) as any;
  let running = true;
  const board = vi.fn((cursor: string | null, limit: number): any => ({
    data: rows.filter((r) => !cursor || r.id > cursor).slice(0, limit),
    error: null,
  }));
  const players = vi.fn((ids: string[], cursor: string | null, limit: number): any => ({
    data: ids
      .filter((id) => id !== rows.at(-1)?.id)
      .flatMap((id) => [
        { id: `${id}-a`, tournament_id: id },
        { id: `${id}-b`, tournament_id: id },
      ])
      .filter((r) => !cursor || r.id > cursor)
      .slice(0, limit),
    error: null,
  }));
  vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
    let fields = '',
      status = '',
      cursor: string | null = null,
      limit = 1000;
    let ids: string[] = [];
    const b: Record<string, any> = {};
    for (const method of ['is', 'not', 'lte', 'lt', 'order', 'range', 'update'])
      b[method] = () => b;
    b.select = (value: string) => {
      fields = value;
      return b;
    };
    b.eq = (key: string, value: string) => {
      if (key === 'status') status = value;
      return b;
    };
    b.in = (key: string, value: string[]) => {
      if (key === 'tournament_id') ids = value;
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
        table === 'tournaments' && status === 'RUNNING' && fields === 'id, name'
          ? board(cursor, limit)
          : table === 'tournament_players' && fields === 'id, tournament_id'
            ? players(ids, cursor, limit)
            : { data: [], error: null, count: 0 }
      ).then(resolve);
    return b as never;
  });
  Object.assign(server, {
    lifecycleGeneration: 1,
    tournamentEngines: new Map(),
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
      running = false;
    }),
    ensureTournamentManagerAdmission: vi.fn(async () => undefined),
    tournamentRecurring: {
      topUpWithHorses: vi.fn(async () => 0),
      seatFirstPartnerHoldUntil: vi.fn(() => -Infinity),
    },
  });
  return { server, board, players, rows };
}
describe('the real discovery reads the complete decided-event board', () => {
  it('reaches a decided event beyond the first 1000 candidates', async () => {
    const { server, board, rows } = harness();
    await server.discoverTournaments();
    expect(board).toHaveBeenCalled();
    expect(server.ensureTournamentManagerAdmission).toHaveBeenCalledWith(
      rows[1000].id,
      'resume',
      expect.any(String),
      1
    );
    expect(board.mock.calls.map((c) => c[0])).toEqual([null, rows[999].id]);
  });
  it('certifies the end of an exactly full page before waking its final event', async () => {
    const { server, board, rows } = harness(1000);
    await server.discoverTournaments();
    expect(board.mock.calls.map((c) => c[0])).toEqual([null, rows[999].id]);
    expect(server.ensureTournamentManagerAdmission).toHaveBeenCalledTimes(1);
    expect(server.ensureTournamentManagerAdmission).toHaveBeenCalledWith(
      rows[999].id,
      'resume',
      expect.any(String),
      1
    );
  });
  it('accepts a genuinely empty board and clears stale held evidence', async () => {
    const { server, board } = harness(0);
    await server.discoverTournaments();
    expect(board).toHaveBeenCalledTimes(1);
    expect(server.ensureTournamentManagerAdmission).not.toHaveBeenCalled();
    expect(server.decidedEventsHeldByQuarantine).toBe(0);
    expect(server.decidedEventsHeldReported.size).toBe(0);
  });
  it('keeps malformed successful data unknown rather than empty', async () => {
    const { server, board, players } = harness(1);
    board.mockReturnValue({ data: null, error: null });
    await server.discoverTournaments();
    expect(players).not.toHaveBeenCalled();
    expect(server.decidedEventsHeldByQuarantine).toBe(2);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'GameServer.decided_board_read_failed'
    );
  });
  it('does not use a partial board or erase prior quarantine evidence on a late page error', async () => {
    const { server, board, players } = harness();
    board.mockImplementation((cursor) =>
      cursor
        ? { data: null, error: new Error('offline') }
        : {
            data: Array.from({ length: 1000 }, (_, i) => event(i)),
            error: null,
          }
    );
    await server.discoverTournaments();
    expect(players).not.toHaveBeenCalled();
    expect(server.ensureTournamentManagerAdmission).not.toHaveBeenCalled();
    expect(server.decidedEventsHeldByQuarantine).toBe(2);
    expect(server.decidedEventsHeldReported.get('old')).toBe('held');
  });
  it.each(['board', 'players'])(
    'does not wake an existing manager after retirement during %s read',
    async (phase) => {
      const { server, board, players, rows } = harness(1);
      const wake = vi.fn();
      server.tournamentEngines.set(rows[0].id, {
        isRunning: () => true,
        requestDecidedEliminationSweep: wake,
      });
      (phase === 'board' ? board : players).mockImplementation(() => {
        server.lifecycleGeneration++;
        return { data: phase === 'board' ? rows : [], error: null };
      });
      await server.discoverTournaments();
      expect(phase === 'board' ? board : players).toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
    }
  );
  it('still wakes the existing finish owner on a complete current board', async () => {
    const { server, rows } = harness(1);
    const wake = vi.fn();
    server.tournamentEngines.set(rows[0].id, {
      isRunning: () => true,
      requestDecidedEliminationSweep: wake,
    });
    await server.discoverTournaments();
    expect(wake).toHaveBeenCalledWith('stalled_decided_survivor');
  });
});
