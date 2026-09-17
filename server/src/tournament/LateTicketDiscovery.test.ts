import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import { HorseTopUpPass } from '../services/TournamentRecurringService.js';
import { supabase } from '../services/supabase.js';
import { reportError } from '../services/errorReporter.js';
const state = vi.hoisted(() => ({ frozen: false }));
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => state.frozen }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
afterEach(() => {
  state.frozen = false;
  vi.restoreAllMocks();
  vi.mocked(reportError).mockClear();
});
const T = 'aaaaaaaa-1111-4111-8111-111111111111';
const target = (id = T) => ({
  id,
  name: 'Late Target',
  status: 'RUNNING',
  tournament_type: 'MTT',
  variant: 'freezeout',
  max_players: 200,
  prize_pool_finalized: false,
});
function harness(rows = [target()]) {
  const server = Object.create(GameServer.prototype) as any;
  let running = true;
  const board = vi.fn((ids: string[]) => ({
    data: rows.filter((r) => ids.includes(r.id)),
    error: null as unknown,
  }));
  const window = vi.fn(
    async (_name: string, _args: { p_tournament_id: string }): Promise<any> => ({
      data: true,
      error: null,
    })
  );
  vi.spyOn(supabase, 'rpc').mockImplementation(window as never);
  vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
    let fields = '',
      ids: string[] = [],
      cursor: string | null = null;
    const b: Record<string, any> = {};
    for (const key of ['eq', 'is', 'not', 'lte', 'lt', 'order', 'limit', 'range']) b[key] = () => b;
    b.select = (value: string) => {
      fields = value;
      return b;
    };
    b.in = (key: string, values: string[]) => {
      if (key === 'id') ids = values;
      return b;
    };
    b.gt = (key: string, value: string) => {
      if (key === 'id') cursor = value;
      return b;
    };
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        table === 'tournament_tickets'
          ? {
              data: cursor
                ? []
                : rows.map((r, i) => ({ id: String(i), source_tournament_id: r.id })),
              error: null,
            }
          : fields ===
              'id, name, status, tournament_type, variant, max_players, prize_pool_finalized'
            ? board(ids)
            : { data: [], error: null, count: 0 }
      ).then(resolve);
    return b as never;
  });
  Object.assign(server, {
    lifecycleGeneration: 7,
    tournamentEngines: new Map(),
    tournamentTopUpsInFlight: new Map(),
    lastMttRampAt: new Map(),
    pastStartTopUpClock: new Map(),
    registeringButFinalizedReported: new Set(),
    finalizedFinishAttempt: new Map(),
    seatFirstFullSince: new Map(),
    tournamentManagerAdmissionOperations: new Map(),
    tournamentManagerAdmissionRetryTimers: new Map(),
    discoveryJobs: new Set(),
    readSeatFirstPaidSeats: vi.fn(async () => new Map()),
    directAdmissionIsCurrent: (g: number) => running && g === server.lifecycleGeneration,
    sleep: vi.fn(async () => {
      // Keep this finite test's engine generation alive until the real owned
      // callbacks settle; stopping before eligibility returns must refuse entry.
      await server.drainDiscoveryJobs();
      running = false;
    }),
    tournamentRecurring: { topUpWithHorses: vi.fn(async (): Promise<number> => 0) },
  });
  const pass = new HorseTopUpPass();
  const select = () => server.recoverLateSatelliteTickets(new Set(rows.map((r) => r.id)), pass, 7);
  const run = async () => {
    await select();
    await server.drainDiscoveryJobs();
  };
  return { server, board, window, pass, run, select };
}
describe('awarded ticket delivery during the actual late registration window', () => {
  it('the real discovery caller reaches a running-only ticket target', async () => {
    const { server, window } = harness();
    await server.discoverTournaments();
    await server.drainDiscoveryJobs();
    expect(window).toHaveBeenCalledWith('fn_tournament_late_registration_open', {
      p_tournament_id: T,
    });
    expect(server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledWith(
      T,
      0,
      expect.objectContaining({ redeemTickets: true })
    );
  });
  it.each([false, null, 'true', { open: true }])(
    'does not infer permission from %j',
    async (data) => {
      const { server, window, run } = harness();
      window.mockResolvedValue({ data, error: null });
      await run();
      expect(server.tournamentRecurring.topUpWithHorses).not.toHaveBeenCalled();
      if (data !== false) expect(reportError).toHaveBeenCalled();
    }
  );
  it('reports a failed eligibility read without any entry', async () => {
    const { server, window, run } = harness();
    window.mockResolvedValue({ data: true, error: new Error('offline') });
    await run();
    expect(server.tournamentRecurring.topUpWithHorses).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalled();
  });
  it.each(['finalized', 'seat-first', 'finished'])(
    'excludes %s targets before eligibility reads',
    async (kind) => {
      const row = target();
      if (kind === 'finalized') row.prize_pool_finalized = true;
      if (kind === 'seat-first') row.max_players = 2;
      if (kind === 'finished') row.status = 'COMPLETED';
      const { window, run } = harness([row]);
      await run();
      expect(window).not.toHaveBeenCalled();
    }
  );
  it('retains the existing event throttle', async () => {
    const { server, window, run } = harness();
    server.lastMttRampAt.set(T, Date.now());
    await run();
    expect(window).not.toHaveBeenCalled();
  });
  it.each([null, [target(), target()]])('refuses malformed target rows %j', async (data) => {
    const { board, window, run } = harness();
    board.mockReturnValue({ data, error: null } as never);
    await run();
    expect(window).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalled();
  });
  it('does not admit after retirement during the board read', async () => {
    const { server, board, window, run } = harness();
    board.mockImplementation(() => {
      server.lifecycleGeneration++;
      return { data: [target()], error: null };
    });
    await run();
    expect(window).not.toHaveBeenCalled();
  });
  it('does not admit after retirement during the eligibility read', async () => {
    const { server, window, run } = harness();
    window.mockImplementation(async () => {
      server.lifecycleGeneration++;
      return { data: true, error: null };
    });
    await run();
    expect(server.tournamentRecurring.topUpWithHorses).not.toHaveBeenCalled();
  });
  it('does not offer tickets through maintenance', async () => {
    const { server, window, run } = harness();
    state.frozen = true;
    await run();
    expect(window).not.toHaveBeenCalled();
    expect(server.tournamentRecurring.topUpWithHorses).not.toHaveBeenCalled();
  });
  it('reads every target chunk before accepting the board', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => target(String(i).padStart(4, '0')));
    const { board, window, run } = harness(rows);
    window.mockResolvedValue({ data: false, error: null });
    await run();
    expect(board.mock.calls.map(([ids]) => ids.length)).toEqual([100, 1]);
    expect(window).toHaveBeenCalledTimes(4);
    // Each finite selection reads the complete board, then spends only the
    // existing four slots; completed ownership makes later targets eligible.
    for (let pass = 1; pass < Math.ceil(rows.length / 4); pass++) await run();
    expect(window).toHaveBeenCalledTimes(101);
    expect(new Set(window.mock.calls.map(([, args]) => args.p_tournament_id)).size).toBe(101);
  });
  it('a failed later chunk cannot authorize entries from the first chunk', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => target(String(i).padStart(4, '0')));
    const { board, window, run } = harness(rows);
    board.mockImplementation((ids) => ({
      data: rows.filter((r) => ids.includes(r.id)),
      error: ids.length === 1 ? new Error('offline') : null,
    }));
    await run();
    expect(window).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalled();
    expect(board.mock.calls.map(([ids]) => ids.length)).toEqual([100, 1, 1, 1]);
  });
  it('retains four unresolved entries and retires without launching successors', async () => {
    const { server, select, pass } = harness(
      Array.from({ length: 6 }, (_, i) => target(String(i)))
    );
    const pending: Array<(n: number) => void> = [];
    server.tournamentRecurring.topUpWithHorses.mockImplementation(
      () => new Promise<number>((resolve) => pending.push(resolve))
    );
    let done = false;
    let drain: Promise<void> | undefined;
    try {
      await select();
      await vi.waitFor(() => expect(pending).toHaveLength(4));
      expect(server.tournamentTopUpsInFlight.size).toBe(4);
      drain = server.drainDiscoveryJobs().then(() => {
        done = true;
      });
      server.lifecycleGeneration++;
      pending[0](1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(done).toBe(false);
      expect(server.tournamentTopUpsInFlight.size).toBe(3);
      for (const resolve of pending.slice(1)) resolve(1);
      await drain;
      expect(done).toBe(true);
      expect(server.tournamentTopUpsInFlight.size).toBe(0);
      expect(pending).toHaveLength(4);
      for (const call of server.tournamentRecurring.topUpWithHorses.mock.calls) {
        expect(call[1]).toBe(0);
        expect(call[2]).toEqual({ pass, redeemTickets: true });
      }
    } finally {
      for (const resolve of pending) resolve(1);
      await drain;
      await server.drainDiscoveryJobs();
    }
  });
});
