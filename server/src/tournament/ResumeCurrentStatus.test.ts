import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function fixture(status: unknown = 'RUNNING') {
  const row: any = {
    id: 'resume-current-event',
    club_id: 'club',
    status,
    blind_structure: [{ smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 }],
    current_level: 0,
    level_started_at: new Date(Date.now() - 120_000).toISOString(),
    prize_pool_finalized: true,
    on_break: false,
  };
  const read = vi.fn(async () => ({ data: row, error: null as any }));
  const from = vi.spyOn(supabase, 'from').mockImplementation(
    (name: string) =>
      ({
        select: () => ({
          eq: () => ({
            maybeSingle: read,
            in: async () => ({
              data: [{ id: 'source', small_blind: 25, big_blind: 50, ante: 0, stakes: '25/50' }],
              count: 1,
              error: null,
            }),
          }),
        }),
      }) as never
  );
  const state: any = Object.assign(Object.create(TournamentManagerBase.prototype), {
    tournamentId: row.id,
    running: true,
    tournamentCache: null,
    lifecycleEpoch: { isCurrent: () => true },
    assertLifecycleCurrent: vi.fn(),
    readTournamentClub: vi.fn(async () => {}),
    tableEngines: new Map(),
    createManagedTableEngine: vi.fn(() => ({ setHub: vi.fn() })),
    wireEliminationWake: vi.fn(),
    admitManagedTableEngine: vi.fn(),
    startManagedTableEngine: vi.fn(),
    restoreDrawnFirstButtons: vi.fn(async () => {}),
    drainTableEngineStartJobs: vi.fn(async () => {}),
    startBlindTimer: vi.fn(),
    startEliminationChecker: vi.fn(),
    unregisterEliminationScheduler: vi.fn(),
    reconcileTournamentEntryWindow: vi.fn(async () => {}),
    requestEliminationSweep: vi.fn(),
  });
  return { row, read, from, state };
}

function expectNoGameplay({ state, from }: ReturnType<typeof fixture>) {
  expect(state.running).toBe(false);
  expect(state.tournamentCache).toBeNull();
  expect(from.mock.calls.map(([name]) => name)).toEqual(['tournaments']);
  for (const method of [
    'readTournamentClub',
    'createManagedTableEngine',
    'admitManagedTableEngine',
    'startManagedTableEngine',
    'startBlindTimer',
    'startEliminationChecker',
    'reconcileTournamentEntryWindow',
    'requestEliminationSweep',
  ])
    expect(state[method], method).not.toHaveBeenCalled();
}

describe('a discovery row is not authority to resume a completed tournament', () => {
  it.each([
    'COMPLETED',
    'CANCELLED',
    'CANCELED',
    'COMPLETING',
    'REGISTERING',
    null,
    'unrecognized',
  ])('does not adopt gameplay from current status %s', async (status) => {
    const f = fixture(status);
    await f.state.resumeLifecycle(1);
    expectNoGameplay(f);
  });
  it('rejects an errored read even if it includes a plausible RUNNING row', async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce({ data: f.row, error: { message: 'read failed' } });
    await f.state.resumeLifecycle(1);
    expectNoGameplay(f);
  });
  it('rejects a row whose identity is not the admitted event', async () => {
    const f = fixture();
    f.row.id = 'different-event';
    await f.state.resumeLifecycle(1);
    expectNoGameplay(f);
  });
  it('still restores a running field and its clock', async () => {
    const f = fixture();
    await f.state.resumeLifecycle(1);
    expect(f.state.running).toBe(true);
    expect(f.state.admitManagedTableEngine).toHaveBeenCalledOnce();
    expect(f.state.startManagedTableEngine).toHaveBeenCalledOnce();
    expect(f.state.startBlindTimer).toHaveBeenCalledOnce();
    expect(f.state.startEliminationChecker).toHaveBeenCalledOnce();
    expect(f.state.requestEliminationSweep).toHaveBeenCalledWith('engine.resume');
  });
  it('routes a completion racing discovery back to the existing exact-manager retirement', async () => {
    const f = fixture();
    let release!: (value: any) => void;
    f.read.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const resume = f.state.resumeLifecycle(1);
    f.row.status = 'COMPLETED';
    release({ data: f.row, error: null });
    await resume;
    expectNoGameplay(f);
    const server: any = Object.assign(Object.create(GameServer.prototype), {
      directAdmissionIsCurrent: () => true,
      ownsTournamentManager: (_id: string, manager: unknown) => manager === f.state,
      stopTournamentManagerIfOwned: vi.fn(async () => true),
      holdIfBreakIsRunning: vi.fn(),
    });
    await server.finishTournamentManagerAdmission(f.state.tournamentId, f.state, 1);
    expect(server.stopTournamentManagerIfOwned).toHaveBeenCalledOnce();
    expect(server.stopTournamentManagerIfOwned).toHaveBeenCalledWith(
      f.state.tournamentId,
      f.state,
      'GameServer.tournament_standdown_stop_failed'
    );
    expect(server.holdIfBreakIsRunning).not.toHaveBeenCalled();
  });
});
