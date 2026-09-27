import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ frozen: false, rpc: vi.fn(), from: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { rpc: fixture.rpc, from: fixture.from },
  maintenanceSupabase: { rpc: fixture.rpc, from: fixture.from },
}));
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => fixture.frozen }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');
const event = 'aaaaaaaa-0000-4000-8000-000000000001';
const users = Array.from(
  { length: 20 },
  (_, i) => `aaaaaaaa-0000-4000-8000-${String(i + 2).padStart(12, '0')}`
);

function setup(window: unknown = { open: false, reason: 'tournament_not_rebuyable' }) {
  const manager = Object.assign(Object.create(TournamentManagerEliminations.prototype), {
    tournamentId: event,
    tournamentCache: { is_rebuy: true, free_buy: false },
    currentLevel: 20,
    eliminationMutationAllowed: vi.fn(() => true),
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
  });
  const query = {
    select: vi.fn(() => query),
    in: vi.fn(() => query),
    eq: vi.fn(async () => ({ data: users.map((id) => ({ id })), error: null })),
  };
  fixture.from.mockReturnValue(query);
  fixture.rpc.mockImplementation(async (name: string) => {
    if (name === 'fn_ca_tournament_rebuy_window') return { data: window, error: null };
    if (name === 'process_tournament_rebuy') {
      vi.setSystemTime(Date.now() + 400);
      return { data: null, error: { message: 'Tournament is not accepting rebuys or re-entries' } };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  return manager;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  fixture.frozen = false;
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the tournament input device reads the authoritative closed window once', () => {
  it.each(['MTT', 'SPIN', 'SNG'])(
    'preserves the whole %s bust budget when no new purchase can be accepted',
    async (format) => {
      const manager = setup();
      manager.tournamentCache.tournament_type = format;
      const start = Date.now();
      const result = await manager.tryTournamentRebuys(users);
      expect(fixture.rpc.mock.calls.map((call) => call[0])).toEqual([
        'fn_ca_tournament_rebuy_window',
      ]);
      expect(fixture.rpc).toHaveBeenCalledWith('fn_ca_tournament_rebuy_window', {
        p_tournament_id: event,
      });
      expect(fixture.from).not.toHaveBeenCalled();
      expect(Date.now() - start).toBe(0);
      // The later ordinary decision/zero-stack/receipt checks still own who is out.
      expect([...result.answered]).toEqual([]);
      expect([...result.rebought]).toEqual([]);
    }
  );

  it.each([
    null,
    {},
    { open: 'false' },
    { open: 0 },
    { open: false },
    { open: false, reason: 'unknown' },
    { open: true },
  ])('preserves the original money door for an open or unknown answer %j', async (window) => {
    const manager = setup(window);
    fixture.rpc.mockImplementation(async (name: string) =>
      name === 'fn_ca_tournament_rebuy_window'
        ? { data: window, error: null }
        : { data: { success: true }, error: null }
    );
    const result = await manager.tryTournamentRebuys(users);
    expect(
      fixture.rpc.mock.calls.filter((call) => call[0] === 'process_tournament_rebuy')
    ).toHaveLength(20);
    expect([...result.rebought]).toEqual(users);
    expect([...result.answered]).toEqual(users);
  });

  it('does not turn a failed read with stale closed data into a closed policy', async () => {
    const manager = setup();
    fixture.rpc.mockImplementation(async (name: string) =>
      name === 'fn_ca_tournament_rebuy_window'
        ? { data: { open: false }, error: { message: 'unavailable' } }
        : { data: { success: false }, error: null }
    );
    const result = await manager.tryTournamentRebuys(users);
    expect(
      fixture.rpc.mock.calls.filter((call) => call[0] === 'process_tournament_rebuy')
    ).toHaveLength(20);
    expect(result.rebought.size).toBe(0);
    expect(result.answered.size).toBe(20);
  });

  it('retains the executable re-entry product when the authoritative window is open', async () => {
    const manager = setup({ open: true });
    manager.tournamentCache = { is_reentry: true };
    await manager.tryTournamentRebuys(users);
    const purchases = fixture.rpc.mock.calls.filter(
      (call) => call[0] === 'process_tournament_rebuy'
    );
    expect(purchases).toHaveLength(20);
    expect(purchases.every((call) => call[1].p_rebuy_type === 'reentry')).toBe(true);
  });

  it('does no reads or purchases during maintenance', async () => {
    const manager = setup();
    fixture.frozen = true;
    await manager.tryTournamentRebuys(users);
    expect(fixture.rpc).not.toHaveBeenCalled();
    expect(fixture.from).not.toHaveBeenCalled();
  });

  it('rereads policy for each batch and does not cache an earlier open window', async () => {
    const manager = setup({ open: true });
    fixture.rpc.mockImplementation(async (name) =>
      name === 'fn_ca_tournament_rebuy_window'
        ? { data: { open: true }, error: null }
        : { data: { success: false }, error: null }
    );
    await manager.tryTournamentRebuys(users);
    fixture.rpc.mockClear();
    fixture.from.mockClear();
    fixture.rpc.mockResolvedValue({
      data: { open: false, reason: 'rebuy_window_closed' },
      error: null,
    });
    const result = await manager.tryTournamentRebuys(users);
    expect(fixture.rpc.mock.calls.map((call) => call[0])).toEqual([
      'fn_ca_tournament_rebuy_window',
    ]);
    expect(fixture.from).not.toHaveBeenCalled();
    expect(result.answered.size).toBe(0);
  });

  it('does not send a purchase after authority is lost during the policy read', async () => {
    const manager = setup({ open: true });
    fixture.rpc.mockImplementationOnce(async () => {
      manager.eliminationMutationAllowed.mockReturnValue(false);
      return { data: { open: true }, error: null };
    });
    await manager.tryTournamentRebuys(users);
    expect(fixture.rpc.mock.calls.map((call) => call[0])).toEqual([
      'fn_ca_tournament_rebuy_window',
    ]);
    expect(fixture.from).not.toHaveBeenCalled();
  });
});
