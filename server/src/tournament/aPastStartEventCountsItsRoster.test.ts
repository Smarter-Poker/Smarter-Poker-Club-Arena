import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
import { reportError } from '../services/errorReporter.js';
import { TournamentRecurringService } from '../services/TournamentRecurringService.js';

/**
 * A PAST-START EVENT COUNTS ITS ROSTER, NOT A STALE COUNTER (2026-09-24).
 *
 * Two mtt-v2 events sat REGISTERING days past their start with 24 entrants in
 * tournament_players and tournaments.current_players = 1. The start gate read
 * the counter, called the event short, and sent it to the past-start top-up;
 * the top-up counted the real roster, found nothing to add and returned 0
 * without a word. The start branch that would have adopted the launch receipt
 * never ran, and the event looped for ever in silence.
 *
 * The gate now decides a registration-first event from the same roster the
 * top-up counts (registered/playing entrants, horses exactly like humans).
 * A seat-first game keeps its paid-seat gate.
 */

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
beforeEach(() => vi.mocked(reportError).mockClear());
afterEach(() => vi.restoreAllMocks());

const T = 'bbbbbbbb-2222-4222-8222-222222222222';

type Row = Record<string, unknown> & { id: string; format_contract: string };

function harness(opts: {
  target: Partial<Row>;
  roster: number;
  abi?: 'legacy-capacity-v1' | 'unlimited-mtt-v2';
  paidSeats?: number;
}) {
  const server = Object.create(GameServer.prototype) as any;
  let running = true;
  const target: Row = {
    id: T,
    name: 'Stale Counter MTT',
    format_contract: 'mtt-v2',
    tournament_type: 'MTT',
    variant: 'freezeout',
    max_players: null,
    min_players: 4,
    current_players: 1,
    start_time: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    prize_pool_finalized: false,
    guaranteed_prize: 0,
    prize_pool: 480,
    buy_in_amount: 20,
    buy_in_fee: 2,
    ...opts.target,
  };
  const abi = opts.abi ?? 'unlimited-mtt-v2';
  vi.spyOn(supabase as any, 'rpc').mockImplementation(async (name, args: any) => {
    if (name !== 'fn_ca_tournament_admission_snapshot') throw new Error(`Unexpected RPC ${name}`);
    return {
      error: null,
      data: {
        ok: true,
        admission_abi: abi,
        entries: args.p_tournament_ids.map((id: string) => ({
          tournament_id: id,
          format_contract: target.format_contract,
          effective_max_players:
            abi === 'unlimited-mtt-v2' &&
            (target.format_contract === 'mtt-v1' || target.format_contract === 'mtt-v2')
              ? null
              : target.max_players,
        })),
      },
    } as any;
  });
  // Horses and humans alike: the roster is every registered/playing row.
  const roster = Array.from({ length: opts.roster }, (_, i) => ({
    id: `p${String(i).padStart(4, '0')}`,
    tournament_id: T,
  }));
  const rosterReads: Array<{ ids: string[]; statuses: string[] }> = [];
  vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
    let status: string | undefined;
    let cursor: string | null = null;
    let limit = 1000;
    const inFilters: Record<string, string[]> = {};
    const b: Record<string, any> = {};
    for (const method of ['select', 'is', 'not', 'lte', 'lt', 'order', 'range', 'update'])
      b[method] = () => b;
    b.in = (key: string, values: string[]) => {
      inFilters[key] = values;
      return b;
    };
    b.limit = (n: number) => {
      limit = n;
      return b;
    };
    b.eq = (key: string, value: string) => {
      if (key === 'status') status = value;
      return b;
    };
    b.gt = (key: string, value: string) => {
      if (key === 'id') cursor = value;
      return b;
    };
    b.then = (resolve: (v: unknown) => unknown) => {
      let data: unknown[] = [];
      if (table === 'tournaments' && status === 'REGISTERING') data = cursor ? [] : [target];
      if (table === 'tournament_players') {
        rosterReads.push({
          ids: inFilters.tournament_id ?? [],
          statuses: inFilters.status ?? [],
        });
        data = roster
          .filter((r) => (inFilters.tournament_id ?? []).includes(r.tournament_id))
          .filter((r) => cursor === null || r.id > cursor)
          .slice(0, limit);
      }
      return Promise.resolve({ data, count: 0, error: null }).then(resolve);
    };
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
    engineStartBudget: 8,
    readSeatFirstPaidSeats: vi.fn(async () => new Map([[T, opts.paidSeats ?? 0]])),
    readPendingSatelliteTicketTargets: vi.fn(async () => new Set()),
    directAdmissionIsCurrent: (g: number) => running && server.lifecycleGeneration === g,
    sleep: vi.fn(async () => {
      await server.drainDiscoveryJobs();
      running = false;
    }),
    ensureTournamentManagerAdmission: vi.fn(async () => undefined),
    tournamentRecurring: { topUpWithHorses: vi.fn(async () => 0) },
  });
  return { server, rosterReads };
}

describe('a past-start event is started from its roster, not a stale counter', () => {
  it('sends a past-start mtt-v2 with 24 entrants and a counter of 1 to the start branch', async () => {
    const { server, rosterReads } = harness({ target: { current_players: 1 }, roster: 24 });
    await server.discoverTournaments();
    expect(server.ensureTournamentManagerAdmission).toHaveBeenCalledWith(
      T,
      'start',
      expect.stringContaining('24 players'),
      1
    );
    expect(server.tournamentRecurring.topUpWithHorses).not.toHaveBeenCalled();
    // One batched read for the board, counting horses and humans alike.
    expect(rosterReads).toHaveLength(1);
    expect(rosterReads[0].ids).toEqual([T]);
    expect(rosterReads[0].statuses).toEqual(['registered', 'playing']);
  });

  it('still tops up an event whose roster is genuinely short, whatever the counter says', async () => {
    const { server } = harness({ target: { current_players: 9 }, roster: 2 });
    await server.discoverTournaments();
    expect(server.ensureTournamentManagerAdmission).not.toHaveBeenCalled();
    expect(server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledWith(
      T,
      4,
      expect.any(Object)
    );
  });

  it('leaves a seat-first game on its paid-seat gate and never reads its roster', async () => {
    const seatFirst = {
      format_contract: 'spin-v1',
      tournament_type: 'SPIN',
      variant: 'spin',
      max_players: 3,
      min_players: 3,
      current_players: 3,
    };
    const full = harness({
      target: seatFirst,
      roster: 0,
      abi: 'legacy-capacity-v1',
      paidSeats: 3,
    });
    await full.server.discoverTournaments();
    expect(full.server.ensureTournamentManagerAdmission).toHaveBeenCalledWith(
      T,
      'start',
      expect.stringContaining('seats sold (3/3)'),
      1
    );
    expect(full.rosterReads).toHaveLength(0);

    vi.restoreAllMocks();
    const short = harness({
      target: { ...seatFirst, current_players: 3 },
      roster: 3,
      abi: 'legacy-capacity-v1',
      paidSeats: 1,
    });
    await short.server.discoverTournaments();
    expect(short.server.ensureTournamentManagerAdmission).not.toHaveBeenCalled();
    expect(short.rosterReads).toHaveLength(0);
  });
});

describe('a top-up that finds the field already there says so', () => {
  function topUpHarness(counter: number) {
    const svc = new TournamentRecurringService() as any;
    const row = {
      variant: 'freezeout',
      format_contract: 'mtt-v2',
      max_players: null,
      club_id: null,
      start_time: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      prize_pool_finalized: false,
      current_players: counter,
    };
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    vi.spyOn(supabase, 'rpc').mockImplementation(rpc as never);
    vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
      const b: Record<string, any> = {};
      for (const m of ['select', 'eq', 'in', 'is', 'gt', 'order', 'limit', 'range']) b[m] = () => b;
      const answer = () => ({ data: table === 'tournaments' ? row : [], error: null, count: 24 });
      b.maybeSingle = async () => answer();
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve);
      return b as never;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    return { svc, rpc, warn };
  }

  it('names the event and both numbers once when the counter disagreed with the roster', async () => {
    const { svc, rpc, warn } = topUpHarness(1);
    expect(await svc.topUpWithHorses(T, 4)).toBe(0);
    expect(await svc.topUpWithHorses(T, 4)).toBe(0);
    const lines = warn.mock.calls.map(([line]) => String(line)).filter((l) => l.includes(T));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('roster already holds 24');
    expect(lines[0]).toContain('current_players reads 1');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('stays quiet when the counter and the roster agree', async () => {
    const { svc, warn } = topUpHarness(24);
    expect(await svc.topUpWithHorses(T, 4)).toBe(0);
    expect(warn.mock.calls.filter(([line]) => String(line).includes(T))).toHaveLength(0);
  });
});
