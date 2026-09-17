import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
import { reportError } from '../services/errorReporter.js';
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
beforeEach(() => vi.mocked(reportError).mockClear());
afterEach(() => vi.restoreAllMocks());
const T = 'aaaaaaaa-1111-4111-8111-111111111111';
function harness(ticketRows: unknown[] = [{ id: 'ticket', source_tournament_id: T }]) {
  const server = Object.create(GameServer.prototype) as any;
  let running = true;
  const target = {
    id: T,
    name: 'Qualified Target',
    tournament_type: 'MTT',
    variant: 'freezeout',
    max_players: 200,
    min_players: 4,
    current_players: 24,
    start_time: new Date(Date.now() + 600000).toISOString(),
    prize_pool_finalized: false,
    guaranteed_prize: 0,
    prize_pool: 480,
    buy_in_amount: 20,
    buy_in_fee: 2,
  };
  const ticketRead = vi.fn((cursor: string | null) => ({
    data: cursor ? [] : ticketRows,
    error: null as unknown,
  }));
  vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
    let status: string | undefined,
      cursor: string | null = null;
    const b: Record<string, any> = {};
    for (const method of [
      'select',
      'in',
      'is',
      'not',
      'lte',
      'lt',
      'order',
      'limit',
      'range',
      'update',
    ])
      b[method] = () => b;
    b.eq = (key: string, value: string) => {
      if (key === 'status') status = value;
      return b;
    };
    b.gt = (key: string, value: string) => {
      if (key === 'id') cursor = value;
      return b;
    };
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        table === 'tournament_tickets'
          ? ticketRead(cursor)
          : {
              data: table === 'tournaments' && status === 'REGISTERING' ? [target] : [],
              count: 0,
              error: null,
            }
      ).then(resolve);
    return b as never;
  });
  Object.assign(server, {
    lifecycleGeneration: 1,
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
    directAdmissionIsCurrent: (g: number) => running && server.lifecycleGeneration === g,
    sleep: vi.fn(async () => {
      await server.drainDiscoveryJobs();
      running = false;
    }),
    tournamentRecurring: { topUpWithHorses: vi.fn(async () => 0) },
  });
  return { server, target, ticketRead };
}
describe('existing prestart discovery continues ticket delivery after the funding quota', () => {
  it('offers a zero-quota target through the existing top-up service with ticket recovery enabled', async () => {
    const { server } = harness();
    await server.discoverTournaments();
    expect(server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledWith(
      T,
      0,
      expect.objectContaining({ redeemTickets: true })
    );
  });
  it('does not add ordinary top-ups when no target ticket exists', async () => {
    const { server } = harness([]);
    await server.discoverTournaments();
    expect(server.tournamentRecurring.topUpWithHorses).not.toHaveBeenCalled();
  });
  it.each(['finalized', 'past', 'seat-first'])('preserves %s exclusions', async (kind) => {
    const { server, target } = harness();
    if (kind === 'finalized') target.prize_pool_finalized = true;
    if (kind === 'past') target.start_time = new Date(Date.now() - 10000).toISOString();
    if (kind === 'seat-first') {
      target.variant = 'sng';
      target.max_players = 2;
    }
    // Admissions are unrelated to the ticket claim under test.
    server.ensureTournamentManagerAdmission = vi.fn(async () => undefined);
    await server.discoverTournaments();
    expect(server.tournamentRecurring.topUpWithHorses).not.toHaveBeenCalled();
  });
  it('keeps the existing per-event throttle', async () => {
    const { server } = harness();
    server.lastMttRampAt.set(T, Date.now());
    await server.discoverTournaments();
    expect(server.tournamentRecurring.topUpWithHorses).not.toHaveBeenCalled();
  });
  it('does not spend a ticket hint delivered after discovery retires', async () => {
    const { server, ticketRead } = harness();
    ticketRead.mockImplementation(() => {
      server.lifecycleGeneration++;
      return { data: [{ id: 'ticket', source_tournament_id: T }], error: null };
    });
    await server.discoverTournaments();
    expect(ticketRead).toHaveBeenCalled();
    expect(server.tournamentRecurring.topUpWithHorses).not.toHaveBeenCalled();
  });
  it('reads past a full ticket page before classifying target hints', async () => {
    const { server, ticketRead } = harness();
    const first = Array.from({ length: 1000 }, (_, i) => ({
      id: `a${String(i).padStart(4, '0')}`,
      source_tournament_id: 'other',
    }));
    ticketRead.mockImplementation((cursor) => ({
      data: cursor ? [{ id: 'z', source_tournament_id: T }] : first,
      error: null,
    }));
    const targets = await server.readPendingSatelliteTicketTargets();
    expect(targets?.has(T)).toBe(true);
    expect(ticketRead.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'a0999']);
  });
  it('keeps a failed ticket hint board unknown', async () => {
    const { server, ticketRead } = harness();
    ticketRead.mockReturnValue({ data: [], error: new Error('offline') });
    expect(await server.readPendingSatelliteTicketTargets()).toBeNull();
    expect(reportError).toHaveBeenCalled();
  });
  it('does not treat a missing row array as an empty ticket board', async () => {
    const { server, ticketRead } = harness();
    ticketRead.mockReturnValue({ data: null, error: null } as never);
    expect(await server.readPendingSatelliteTicketTargets()).toBeNull();
    expect(reportError).toHaveBeenCalled();
  });
});
