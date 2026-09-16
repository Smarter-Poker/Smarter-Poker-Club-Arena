import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
import { reportError } from '../services/errorReporter.js';
import { sliceMethod } from '../testHelpers/sourceWindow.js';
const state = vi.hoisted(() => ({ frozen: false }));
vi.mock('../maintenance/freezeState.js', async (original) => ({
  ...(await original<object>()),
  isMaintenanceFrozen: () => state.frozen,
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
// Import-time configuration diagnostics are outside each discovery operation.
// Retain error assertions for everything the operation actually executes.
beforeEach(() => vi.mocked(reportError).mockClear());
afterEach(() => {
  state.frozen = false;
  vi.restoreAllMocks();
});
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  variant: 'freezeout',
  tournament_type: 'MTT',
  start_time: new Date(Date.now() - 60_000).toISOString(),
  current_players: 24,
  min_players: 4,
  max_players: 200,
  prize_pool_finalized: false,
  ...over,
});
function harness(rows: unknown[]) {
  const server = Object.create(GameServer.prototype) as any;
  let running = true;
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    gt: vi.fn(() => query),
    lte: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(async () => ({ data: rows, error: null })),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(query as never);
  Object.assign(server, {
    lifecycleGeneration: 1,
    tournamentEngines: new Map(),
    tournamentManagerAdmissionOperations: new Map(),
    tournamentManagerAdmissionRetryTimers: new Map(),
    engineStartBudget: 2,
    discoveryJobs: new Set(),
    directAdmissionIsCurrent: (g: number) => running && g === server.lifecycleGeneration,
    sleep: vi.fn(async () => {
      running = false;
    }),
    ensureTournamentManagerAdmission: vi.fn((id: string) => {
      const pending = new Promise<void>(() => {});
      server.tournamentManagerAdmissionOperations.set(id, pending);
      return pending;
    }),
    tournamentRecurring: { topUpWithHorses: vi.fn(() => new Promise<void>(() => {})) },
  });
  return { server, query };
}
describe('scheduled starts have an independent bounded discovery path', () => {
  it('starts a due MTT without waiting for a different retained top-up or admission', async () => {
    const { server, query } = harness([
      row('ramp', { start_time: new Date(Date.now() + 300000).toISOString(), current_players: 0 }),
      row('due'),
    ]);
    Object.assign(server, {
      readSeatFirstPaidSeats: vi.fn(async () => new Map()),
      lastMttRampAt: new Map(),
      registeringButFinalizedReported: new Set(),
      pastStartTopUpClock: new Map(),
      finalizedFinishAttempt: new Map(),
    });
    const retained = server.discoverTournaments();
    server.discoveryJobs.add(retained);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledOnce();
    expect(server.ensureTournamentManagerAdmission).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    query.limit.mockResolvedValue({ data: [row('due')], error: null });
    const other = new Promise<void>(() => {});
    server.tournamentManagerAdmissionOperations.set('older-start', other);
    await server.discoverScheduledMttStarts();
    expect(server.ensureTournamentManagerAdmission).toHaveBeenCalledWith(
      'due',
      'start',
      expect.stringContaining('due'),
      1
    );
    expect(server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledTimes(1);
    expect(server.tournamentManagerAdmissionOperations.get('older-start')).toBe(other);
    expect(server.discoveryJobs.has(retained)).toBe(true);
  });
  it('bounds pending claims and starts the longest-waiting due events first', async () => {
    const { server } = harness([
      row('newest'),
      row('oldest', { start_time: new Date(Date.now() - 180000).toISOString() }),
      row('middle', { start_time: new Date(Date.now() - 120000).toISOString() }),
    ]);
    await server.discoverScheduledMttStarts();
    expect(server.ensureTournamentManagerAdmission.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'oldest',
      'middle',
    ]);
    expect(server.tournamentManagerAdmissionOperations.size).toBe(2);
  });
  it('reads past the gateway page limit before choosing the oldest due event', async () => {
    const { server } = harness([]);
    server.engineStartBudget = 1;
    const first = Array.from({ length: 1000 }, (_, i) => row(`a${String(i).padStart(4, '0')}`));
    const oldest = row('z-oldest', { start_time: new Date(Date.now() - 180000).toISOString() });
    const pages: Array<{ cursor: string | null; limit: number }> = [];
    vi.mocked(supabase.from).mockImplementation(() => {
      let cursor: string | null = null;
      let limit = 0;
      const query = {
        select: () => query,
        eq: () => query,
        gt: (key: string, value: string | number) => {
          if (key === 'id') cursor = String(value);
          return query;
        },
        lte: () => query,
        order: () => query,
        limit: (value: number) => {
          limit = value;
          return query;
        },
        then: (resolve: (value: unknown) => unknown) => {
          pages.push({ cursor, limit });
          return Promise.resolve({ data: cursor ? [oldest] : first, error: null }).then(resolve);
        },
      };
      return query as never;
    });
    await server.discoverScheduledMttStarts();
    expect(pages).toEqual([
      { cursor: null, limit: 1000 },
      { cursor: 'a0999', limit: 1000 },
    ]);
    expect(server.ensureTournamentManagerAdmission).toHaveBeenCalledOnce();
    expect(server.ensureTournamentManagerAdmission).toHaveBeenCalledWith(
      'z-oldest',
      'start',
      expect.any(String),
      1
    );
  });
  it('preserves format, time, field, finalized, and owner boundaries', async () => {
    const { server } = harness([
      row('future', { start_time: new Date(Date.now() + 61000).toISOString() }),
      row('short', { current_players: 3 }),
      row('spin', { tournament_type: 'SPIN', variant: 'spin' }),
      row('sng', { tournament_type: 'SNG', variant: 'sng' }),
      row('hu', { tournament_type: 'SNG', max_players: 2 }),
      row('paid', { prize_pool_finalized: true }),
      row('invalid', { current_players: null }),
      row('owned'),
      row('retry'),
    ]);
    server.tournamentEngines.set('owned', {});
    server.tournamentManagerAdmissionRetryTimers.set('retry', {});
    await server.discoverScheduledMttStarts();
    expect(server.ensureTournamentManagerAdmission).not.toHaveBeenCalled();
  });
  it.each([null, 2, 200])('discovers an MTT past its obsolete cap %j', async (max_players) => {
    const { server, query } = harness([row('unlimited', { max_players, current_players: 201 })]);
    await server.discoverScheduledMttStarts();
    expect(server.ensureTournamentManagerAdmission).toHaveBeenCalledWith('unlimited', 'start', expect.any(String), 1);
    expect(query.gt).not.toHaveBeenCalledWith('max_players', expect.anything());
  });
  it('discovers a satellite with the historical SNG shape', async () => {
    const { server } = harness([row('satellite', { tournament_type: 'SATELLITE', variant: 'sng', max_players: 2 })]);
    await server.discoverScheduledMttStarts();
    expect(server.ensureTournamentManagerAdmission).toHaveBeenCalledWith('satellite', 'start', expect.any(String), 1);
  });
  it.each(['satellite_target_id', 'satellite_target'])(
    'discovers a linked satellite through %s despite an old fixed-format label', async (targetKey) => {
      const { server, query } = harness([row('linked-satellite', {
        tournament_type: 'SNG', variant: 'sng', max_players: 2, [targetKey]: 'target',
      })]);
      await server.discoverScheduledMttStarts();
      expect(query.select).toHaveBeenCalledWith(expect.stringContaining(targetKey));
      expect(server.ensureTournamentManagerAdmission).toHaveBeenCalledWith(
        'linked-satellite', 'start', expect.any(String), 1
      );
    }
  );
  it('does not lower the MTT launch minimum to the old two-entry cap', async () => {
    const { server } = harness([row('too-small', { max_players: 2, min_players: 2, current_players: 2 })]);
    await server.discoverScheduledMttStarts();
    expect(server.ensureTournamentManagerAdmission).not.toHaveBeenCalled();
  });
  it('offers pre-seating through the same start authority', async () => {
    const { server } = harness([
      row('preseat', { start_time: new Date(Date.now() + 55000).toISOString() }),
    ]);
    await server.discoverScheduledMttStarts();
    expect(server.ensureTournamentManagerAdmission).toHaveBeenCalledWith(
      'preseat',
      'start',
      expect.any(String),
      1
    );
  });
  it.each(['freeze', 'generation'])('fences a read crossing %s', async (kind) => {
    const { server, query } = harness([row('due')]);
    query.limit.mockImplementation(async () => {
      if (kind === 'freeze') state.frozen = true;
      else server.lifecycleGeneration++;
      return { data: [row('due')], error: null };
    });
    await server.discoverScheduledMttStarts();
    expect(server.ensureTournamentManagerAdmission).not.toHaveBeenCalled();
  });
  it('treats a malformed board as unknown', async () => {
    const { server, query } = harness([]);
    query.limit.mockResolvedValue({ data: [{ ...row('bad'), id: null }], error: null } as never);
    await server.discoverScheduledMttStarts();
    expect(server.ensureTournamentManagerAdmission).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalled();
  });

  it('coalesces repeated due reads through the actual shared admission entry point', async () => {
    const { server } = harness([row('due')]);
    let passes = 0;
    let running = true;
    server.directAdmissionIsCurrent = () => running;
    server.sleep = vi.fn(async () => {
      if (++passes === 2) running = false;
    });
    server.ensureTournamentManagerAdmission = (
      GameServer.prototype as any
    ).ensureTournamentManagerAdmission;
    server.performTournamentManagerAdmission = vi.fn(() => new Promise<void>(() => {}));
    await server.discoverScheduledMttStarts();
    expect(server.performTournamentManagerAdmission).toHaveBeenCalledOnce();
    expect(server.tournamentManagerAdmissionOperations.size).toBe(1);
    expect(server.discoveryJobs.size).toBe(1);
  });
  it('does not read or start during the maintenance freeze', async () => {
    const { server } = harness([row('due')]);
    state.frozen = true;
    await server.discoverScheduledMttStarts();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(server.ensureTournamentManagerAdmission).not.toHaveBeenCalled();
  });
  it('keeps every unresolved admission in its capacity budget', async () => {
    const { server } = harness([row('due')]);
    const a = new Promise<void>(() => {}),
      b = new Promise<void>(() => {});
    server.tournamentManagerAdmissionOperations.set('a', a);
    server.tournamentManagerAdmissionOperations.set('b', b);
    await server.discoverScheduledMttStarts();
    expect(server.ensureTournamentManagerAdmission).not.toHaveBeenCalled();
    expect([...server.tournamentManagerAdmissionOperations.values()]).toEqual([a, b]);
  });
  it('starts the new loop under existing lifecycle supervision', () => {
    const source = readFileSync(new URL('../GameServer.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/this\.launchDiscoveryJob\(\s*this\.discoverScheduledMttStarts\(\)/);
    const lane = sliceMethod(source, 'private async discoverScheduledMttStarts(');
    expect(lane).not.toContain('topUpWithHorses');
    expect(lane).not.toContain('new TournamentManager');
    expect(lane).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
  });
});
