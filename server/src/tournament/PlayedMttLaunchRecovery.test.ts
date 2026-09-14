import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPlayedMttLaunchProof } from './playedMttLaunchRecovery.js';

const { from, rpc, reportError } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from, rpc },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError }));
import { TournamentManagerBase } from './TournamentManagerBase.js';

const EVENT = 'c3000000-0000-4000-8000-000000000001';
const GENERATION = 'c6000000-0000-4000-8000-000000000001';
const FIRST = '2026-09-08T14:01:44.798851+00:00';
const proof = {
  ok: true,
  hands_dealt: 199,
  first_hand_at: FIRST,
  dealt_field: 34,
  required_players: 3,
  playing: 2,
  eliminated: 32,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T20:00:00Z'));
  from.mockReset();
  rpc.mockReset();
  reportError.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  const row: any = {
    id: EVENT,
    status: 'REGISTERING',
    tournament_type: 'MTT',
    variant: 'freezeout',
    max_players: 500,
    prize_pool_finalized: true,
    prize_pool: 153,
    current_level: 21,
    level_started_at: '2026-09-08T14:53:31.061Z',
    starting_chips: 12000,
    blind_structure: [],
    started_at: null,
  };
  const state: any = Object.assign(Object.create(TournamentManagerBase.prototype), {
    tournamentId: EVENT,
    tournamentLeaseGeneration: GENERATION,
    running: true,
    lifecycleEpoch: { isCurrent: () => state.running },
    assertLifecycleCurrent: () => {
      if (!state.running) throw new Error('stale lifecycle');
    },
    unregisterEliminationScheduler: vi.fn(),
    resumeLifecycle: vi.fn(async () => {}),
    resume: vi.fn(() => {
      throw new Error('self-joining public resume');
    }),
    createTablesAndSeatPlayers: vi.fn(() => {
      throw new Error('fresh setup must not run');
    }),
  });
  const receipt: any = { launch_id: null, started_at: FIRST, completed: false };
  from.mockImplementation((name: string) => {
    if (name === 'tournaments')
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: structuredClone(row), error: null }) }),
        }),
      };
    if (name === 'tournament_players')
      return { select: () => ({ eq: () => ({ in: async () => ({ count: 2, error: null }) }) }) };
    throw new Error('Unexpected relation ' + name);
  });
  const respond = (name: string, args: any) => {
    if (name === 'fn_prove_played_launch_recovery')
      return {
        error: null,
        data:
          args.p_started_at === null
            ? {
                ok: false,
                reason: 'the_receipt_is_not_the_deal_that_happened',
                first_hand_at: FIRST,
              }
            : structuredClone(proof),
      };
    if (name === 'fn_begin_tournament_launch_atomic') {
      receipt.launch_id ??= args.p_launch_id;
      return {
        error: null,
        data: {
          ok: true,
          claimed: true,
          replay: receipt.launch_id !== args.p_launch_id,
          completed: receipt.completed,
          status: row.status,
          lease_generation: GENERATION,
          ...receipt,
        },
      };
    }
    if (name === 'fn_complete_tournament_launch_atomic') {
      row.status = 'RUNNING';
      row.started_at = FIRST;
      receipt.completed = true;
      return {
        error: null,
        data: {
          ok: true,
          completed: true,
          status: 'RUNNING',
          started_at: FIRST,
          completed_at: new Date().toISOString(),
          lease_generation: GENERATION,
        },
      };
    }
    throw new Error('Unexpected RPC ' + name);
  };
  rpc.mockImplementation(async (name: string, args: any) => respond(name, args));
  return { row, state, receipt, respond };
}

describe('a dealt MTT reaches its existing launch authority before the fresh field gate', () => {
  it.each(['MTT', 'SATELLITE'])(
    'records and resumes a %s without fresh setup or timestamp truncation',
    async (type) => {
      const { row, state } = fixture();
      row.tournament_type = type;
      await state.startLifecycle(1);
      expect(rpc.mock.calls.map(([name]) => name)).toEqual([
        'fn_prove_played_launch_recovery',
        'fn_prove_played_launch_recovery',
        'fn_begin_tournament_launch_atomic',
        'fn_complete_tournament_launch_atomic',
      ]);
      expect(rpc.mock.calls[1][1].p_started_at).toBe(FIRST);
      expect(rpc.mock.calls[2][1].p_started_at).toBe(FIRST);
      expect(rpc.mock.calls[2][1].p_lease_generation).toBe(GENERATION);
      expect(row).toMatchObject({
        status: 'RUNNING',
        current_level: 21,
        prize_pool: 153,
        starting_chips: 12000,
      });
      expect(state.resumeLifecycle).toHaveBeenCalledOnce();
      expect(state.resumeLifecycle).toHaveBeenCalledWith(1);
      expect(state.resume).not.toHaveBeenCalled();
      expect(state.createTablesAndSeatPlayers).not.toHaveBeenCalled();
      expect(from.mock.calls.map(([name]) => name)).toEqual(['tournaments']);
    }
  );
  it('leaves a fresh short field at the existing minimum-player gate', async () => {
    const { state } = fixture();
    rpc.mockResolvedValue({ error: null, data: { ok: false, reason: 'no_hand_was_dealt' } });
    await state.startLifecycle(1);
    expect(rpc).toHaveBeenCalledOnce();
    expect(state.running).toBe(false);
    expect(state.resumeLifecycle).not.toHaveBeenCalled();
    expect(from.mock.calls.map(([name]) => name)).toEqual(['tournaments', 'tournament_players']);
  });
  it.each(['SPIN', 'SNG'])('does not apply generic MTT recovery to %s', async (type) => {
    const { row, state } = fixture();
    row.tournament_type = type;
    expect(await state.resumePlayedMttLaunch(1, row)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['first proof unavailable', 'proof refused', 'claim refused', 'completion refused'])(
    'admits no dealer when %s',
    async (fault) => {
      const { state, respond } = fixture();
      rpc.mockImplementation(async (name: string, args: any) => {
        if (fault === 'first proof unavailable' && name === 'fn_prove_played_launch_recovery')
          return { error: { message: 'transport failed' }, data: null };
        if (
          fault === 'proof refused' &&
          name === 'fn_prove_played_launch_recovery' &&
          args.p_started_at !== null
        )
          return { data: { ok: false, reason: 'unseated' }, error: null };
        if (fault === 'claim refused' && name === 'fn_begin_tournament_launch_atomic')
          return { data: { ok: false, reason: 'launch_lease_lost' }, error: null };
        if (fault === 'completion refused' && name === 'fn_complete_tournament_launch_atomic')
          return { data: { ok: false, reason: 'launch_seats_unproven' }, error: null };
        return respond(name, args);
      });
      await state.startLifecycle(1);
      expect(state.running).toBe(false);
      expect(state.resumeLifecycle).not.toHaveBeenCalled();
      expect(state.createTablesAndSeatPlayers).not.toHaveBeenCalled();
    }
  );
  it('adopts an already completed exact receipt without replaying fresh setup', async () => {
    const { row, state, receipt } = fixture();
    receipt.completed = true;
    receipt.launch_id = GENERATION;
    rpc.mockImplementationOnce(async () => ({
      error: null,
      data: {
        ok: false,
        reason: 'the_receipt_is_not_the_deal_that_happened',
        first_hand_at: FIRST,
      },
    }));
    row.status = 'RUNNING';
    // Simulate the cached REGISTERING discovery snapshot, while begin sees the durable completed receipt.
    const cached = { ...row, status: 'REGISTERING' };
    expect(await state.resumePlayedMttLaunch(1, cached)).toBe(true);
    expect(rpc.mock.calls.some(([name]) => name === 'fn_complete_tournament_launch_atomic')).toBe(
      false
    );
    expect(state.resumeLifecycle).toHaveBeenCalledOnce();
  });
  it('does not proceed after a lease lifecycle is replaced during the first read', async () => {
    const { row, state } = fixture();
    rpc.mockImplementationOnce(async () => {
      state.running = false;
      return {
        error: null,
        data: {
          ok: false,
          reason: 'the_receipt_is_not_the_deal_that_happened',
          first_hand_at: FIRST,
        },
      };
    });
    await expect(state.resumePlayedMttLaunch(1, row)).rejects.toThrow('stale lifecycle');
    expect(rpc).toHaveBeenCalledOnce();
    expect(state.resumeLifecycle).not.toHaveBeenCalled();
  });
});

describe('played field proof is exact and finite', () => {
  it.each([
    { ok: false },
    { playing: 0 },
    { hands_dealt: 0 },
    { dealt_field: 2 },
    { eliminated: 31 },
    { playing: '2' },
    { required_players: 2 },
    { first_hand_at: '2026-09-08T14:01:44.798852+00:00' },
  ])('refuses malformed proof %j', (patch) => {
    expect(() => readPlayedMttLaunchProof({ ...proof, ...patch }, FIRST)).toThrow();
  });
  it('accepts the last survivor of an already played three-person field', () => {
    expect(() =>
      readPlayedMttLaunchProof({ ...proof, playing: 1, eliminated: 33 }, FIRST)
    ).not.toThrow();
  });
});
