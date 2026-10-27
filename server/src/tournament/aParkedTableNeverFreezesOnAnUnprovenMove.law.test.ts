/**
 * LAW: A PARKED TABLE NEVER FREEZES ON AN UNPROVEN MOVE (2026-10-25).
 *
 * Production 2026-10-24, event 12135e5b (Union PKO Afternoon, PLO4), Table 13
 * (3e3d1587): a rebuy bust on Table 16 was re-seated onto Table 13 while its
 * hand was in flight, balancing parked Table 13 (break 5135b05b), and every
 * movement admission refused
 *   f06_movement_admission_unproven [55000]: F06_MOVEMENT_WHOLE_ROSTER_REQUIRED
 * The only withdrawal the manager knew was the capacity one, so the table
 * dealt nothing for 3h46m.
 *
 * A park that has not begun, has existed for UNPROVEN_MOVEMENT_PARK_GRACE_MS,
 * and whose movement admission still refuses is withdrawn through
 * fn_f06_withdraw_unproven_movement_park, its dealer is stopped and
 * readmitted exactly as after the capacity withdrawal, and the refusal is
 * still thrown and reported. Any other refusal never withdraws it.
 *
 * Real TournamentManager, retirement custody and RPC wrapper.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { TournamentManager, movementProofRefusal } from './TournamentManager.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { GameServer } from '../GameServer.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
import { supabase } from '../services/supabase.js';

const id = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = id(1),
  source = id(2),
  lease = id(3),
  breakId = id(4),
  custody = id(5);

afterEach(() => {
  vi.restoreAllMocks();
});

type Admit = 'refuse' | 'refuse_other' | 'prove';
type Door = 'withdrawn' | 'proven' | 'absent';

function fixture(
  admit: Admit = 'refuse',
  door: Door = 'withdrawn',
  metadata: { park_created_at?: unknown; generation?: string } = {}
) {
  const generation = metadata.generation ?? lease;
  const calls: { name: string; params: any }[] = [];
  const park = {
    ...(Object.hasOwn(metadata, 'park_created_at')
      ? { park_created_at: metadata.park_created_at }
      : {}),
    ok: true,
    reason: null,
    break_id: breakId,
    tournament_id: event,
    source_table_id: source,
    lifecycle: '7',
    state: 'park_requested' as const,
    revision: '1',
    custody_id: custody,
    custody_generation: generation,
    members: [],
    terminal_handoff_required: false,
  };
  const engine: any = new ServerTableEngine(source);
  const server: any = Object.create(GameServer.prototype);
  Object.assign(server, {
    running: true,
    tableEngines: new Map([[source, engine]]),
    tournamentOwnedTables: new Set([source]),
    tournamentRetirementCustody: new TournamentRetirementCustody(),
    maintenanceBreak: { adopt: vi.fn() },
  });
  const manager: any = new TournamentManager(event, server, generation, performance.now() + 60000);
  Object.assign(manager, { running: true, eliminationSweepDeadlineAt: 0 });
  manager.tableEngines.set(source, engine);
  const token = {};
  manager.lifecycleEpoch.current = () => token;
  manager.lifecycleIsCurrent = () => true;
  manager.requestUrgentEliminationSweepAfter = vi.fn();
  manager.readmitContinuedNoStartTable = vi.fn(async () => {});
  manager.durableTournamentBreaks.set(breakId, park);
  engine.running = true;
  vi.spyOn(engine, 'getF06RetainedPermit').mockReturnValue(null);
  const install = vi.spyOn(engine, 'installF06MovementAdmission').mockImplementation(() => {});
  const start = vi.spyOn(engine, 'start').mockResolvedValue(undefined as never);
  const releasePause = vi.spyOn(engine, 'releaseTournamentMovePause');
  const stop = vi.spyOn(engine, 'stop').mockImplementation(async () => {
    engine.running = false;
  });
  vi.spyOn(engine, 'hasReleasedProcessOwnership').mockImplementation(() => !engine.running);

  const query: any = {
    select: () => query,
    eq: () => query,
    lte: () => query,
    limit: async () => ({ data: [], error: null }),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(query);
  vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, params: any) => {
    calls.push({ name, params });
    if (name === 'fn_f06_table_state')
      return {
        data: { ok: true, table_id: source, lifecycle: '7', excluded: true, break_id: breakId },
        error: null,
      };
    if (name === 'fn_f06_break_state') return { data: { ...park }, error: null };
    if (name === 'fn_f06_admit_parked_movement') {
      if (admit === 'prove')
        return {
          data: {
            ok: true,
            mode: 'movement_only',
            admission_id: params.p_admission_id,
            tournament_id: event,
            lease_generation: generation,
            table_id: source,
            lifecycle: '7',
            break_id: breakId,
            custody_id: params.p_custody_id,
            revision: '2',
            proof_hash: 'a'.repeat(64),
          },
          error: null,
        };
      return {
        data: null,
        error:
          admit === 'refuse'
            ? { code: '55000', message: 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' }
            : { code: '55000', message: 'F06_MOVEMENT_CAS_CHANGED_BUT_NOT_NAMED x' },
      };
    }
    if (name === 'fn_f06_withdraw_unproven_movement_park') {
      if (door === 'proven')
        return { data: null, error: { code: '55000', message: 'F06_WITHDRAWAL_MOVEMENT_PROVEN' } };
      if (door === 'absent')
        return { data: null, error: { code: 'PGRST202', message: 'not found' } };
      return {
        data: {
          ok: true,
          state: 'withdrawn_unproven_movement',
          receipt_id: id(90),
          tournament_id: event,
          table_id: source,
          lifecycle: '7',
          break_id: breakId,
          park_custody_id: park.custody_id,
          park_revision: park.revision,
          lease_generation: generation,
          original_generation: generation,
          permit_id: id(91),
          hand_number: '46740543',
          roster_size: 5,
          movement_refusal: 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED',
          credit: 0,
        },
        error: null,
      };
    }
    throw new Error(`unexpected RPC ${name}`);
  }) as any);
  const admitOnce = () =>
    manager.startParkedMovementEngine(engine, source, '7', () => true) as Promise<void>;
  return { manager, engine, calls, park, stop, start, install, releasePause, admitOnce };
}

const names = (calls: { name: string }[]) => calls.map((c) => c.name);

it('the 12135e5b shape: a park refused by its movement proof is withdrawn after the grace and the table deals again', async () => {
  const f = fixture();
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);

  // First refusal: still reported, nothing withdrawn yet (a bust being
  // recorded is the commonest transient refusal).
  await expect(f.admitOnce()).rejects.toThrow(
    'f06_movement_admission_unproven [55000]: F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'
  );
  expect(f.manager.lastBreakPreparationRefusal(breakId)).toBe(
    'movement_unproven:F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'
  );
  expect(names(f.calls)).not.toContain('fn_f06_withdraw_unproven_movement_park');
  expect(f.stop).not.toHaveBeenCalled();

  // Still refused after the grace: the park is withdrawn, never begun.
  now += TournamentManager.UNPROVEN_MOVEMENT_PARK_GRACE_MS;
  await expect(f.admitOnce()).resolves.toBeUndefined();
  const withdraw = f.calls.find((c) => c.name === 'fn_f06_withdraw_unproven_movement_park');
  expect(withdraw?.params).toEqual({
    p_tournament_id: event,
    p_lease_generation: lease,
    p_table_id: source,
    p_lifecycle: '7',
    p_break_id: breakId,
    p_park_custody_id: custody,
    p_park_revision: '1',
  });
  expect(names(f.calls)).not.toContain('fn_f06_begin_break');
  expect(names(f.calls)).not.toContain('fn_f06_withdraw_unplaceable_park');
  expect(f.install).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.releasePause).toHaveBeenCalled();
  expect(f.manager.readmitContinuedNoStartTable).toHaveBeenCalledWith(source, f.engine);
  expect(f.manager.durableTournamentBreaks.has(breakId)).toBe(false);
  expect(f.manager.lastBreakPreparationRefusal(breakId)).toBeNull();
});

it('when the database finds the roster proven the park stands, its dealer is untouched, and the refusal still throws', async () => {
  const f = fixture('refuse', 'proven', { park_created_at: new Date(0).toISOString() });
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await expect(f.admitOnce()).rejects.toThrow(/F06_MOVEMENT_WHOLE_ROSTER_REQUIRED/);
  now += TournamentManager.UNPROVEN_MOVEMENT_PARK_GRACE_MS;
  await expect(f.admitOnce()).rejects.toThrow(/F06_MOVEMENT_WHOLE_ROSTER_REQUIRED/);
  expect(names(f.calls)).toContain('fn_f06_withdraw_unproven_movement_park');
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.manager.readmitContinuedNoStartTable).not.toHaveBeenCalled();
  expect(f.manager.durableTournamentBreaks.has(breakId)).toBe(true);
});

it('a database without the door withdraws nothing and keeps refusing exactly as before', async () => {
  const f = fixture('refuse', 'absent');
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await expect(f.admitOnce()).rejects.toThrow(/F06_MOVEMENT_WHOLE_ROSTER_REQUIRED/);
  now += TournamentManager.UNPROVEN_MOVEMENT_PARK_GRACE_MS;
  await expect(f.admitOnce()).rejects.toThrow(/F06_MOVEMENT_WHOLE_ROSTER_REQUIRED/);
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.manager.durableTournamentBreaks.has(breakId)).toBe(true);
});

it('a refusal that is not a named movement refusal is never a reason to withdraw', async () => {
  const f = fixture('refuse_other', 'withdrawn', { park_created_at: new Date(0).toISOString() });
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await expect(f.admitOnce()).rejects.toThrow(/f06_movement_admission_unproven/);
  now += TournamentManager.UNPROVEN_MOVEMENT_PARK_GRACE_MS * 10;
  await expect(f.admitOnce()).rejects.toThrow(/f06_movement_admission_unproven/);
  expect(names(f.calls)).not.toContain('fn_f06_withdraw_unproven_movement_park');
  expect(f.stop).not.toHaveBeenCalled();
});

it('a park whose roster is proven is admitted as before and never withdrawn', async () => {
  const f = fixture('prove', 'withdrawn', { park_created_at: new Date(0).toISOString() });
  await expect(f.admitOnce()).resolves.toBeUndefined();
  expect(f.install).toHaveBeenCalledTimes(1);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(names(f.calls)).not.toContain('fn_f06_withdraw_unproven_movement_park');
  expect(f.stop).not.toHaveBeenCalled();
});

it('names only the door own F06_MOVEMENT_* 55000 refusals', () => {
  expect(
    movementProofRefusal(
      new Error('f06_movement_admission_unproven [55000]: F06_MOVEMENT_WHOLE_ROSTER_REQUIRED')
    )
  ).toBe('F06_MOVEMENT_WHOLE_ROSTER_REQUIRED');
  expect(
    movementProofRefusal(
      new Error('f06_movement_admission_unproven [55000]: F06_MOVEMENT_ELIMINATION_UNPROVEN')
    )
  ).toBe('F06_MOVEMENT_ELIMINATION_UNPROVEN');
  expect(movementProofRefusal(new Error('f06_movement_admission_unproven [owner_changed]'))).toBe(
    null
  );
  expect(
    movementProofRefusal(new Error('f06_movement_admission_unproven [22023]: F06_MOVEMENT_X'))
  ).toBe(null);
  expect(
    movementProofRefusal(new Error('f06_movement_admission_unproven [55000]: PLATFORM_FROZEN'))
  ).toBe(null);
  expect(movementProofRefusal(new Error('f06_movement_owner_changed'))).toBe(null);
});

it('the original park grace survives a fresh successor manager instead of starting again', async () => {
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const park_created_at = new Date(now).toISOString();
  const first = fixture('refuse', 'withdrawn', { park_created_at });
  await expect(first.admitOnce()).rejects.toThrow(/F06_MOVEMENT_WHOLE_ROSTER_REQUIRED/);
  expect(names(first.calls)).not.toContain('fn_f06_withdraw_unproven_movement_park');
  expect(first.stop).not.toHaveBeenCalled();

  now += TournamentManager.UNPROVEN_MOVEMENT_PARK_GRACE_MS;
  const successor = fixture('refuse', 'withdrawn', { park_created_at, generation: id(30) });
  await expect(successor.admitOnce()).resolves.toBeUndefined();
  const withdrawals = successor.calls.filter(
    (c) => c.name === 'fn_f06_withdraw_unproven_movement_park'
  );
  expect(withdrawals).toHaveLength(1);
  expect(withdrawals[0].params).toEqual({
    p_tournament_id: event,
    p_lease_generation: id(30),
    p_table_id: source,
    p_lifecycle: '7',
    p_break_id: breakId,
    p_park_custody_id: custody,
    p_park_revision: '1',
  });
  expect(names(successor.calls)).not.toContain('fn_f06_request_park');
  expect(names(successor.calls)).not.toContain('fn_f06_begin_break');
  expect(successor.stop).toHaveBeenCalledTimes(1);
  expect(successor.manager.readmitContinuedNoStartTable).toHaveBeenCalledWith(
    source,
    successor.engine
  );
});

it('a future durable creation time cannot spend the grace through the local fallback', async () => {
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = fixture('refuse', 'withdrawn', {
    park_created_at: new Date(now + 600_000).toISOString(),
  });
  await expect(f.admitOnce()).rejects.toThrow(/F06_MOVEMENT_WHOLE_ROSTER_REQUIRED/);
  now += TournamentManager.UNPROVEN_MOVEMENT_PARK_GRACE_MS;
  await expect(f.admitOnce()).rejects.toThrow(/F06_MOVEMENT_WHOLE_ROSTER_REQUIRED/);
  expect(names(f.calls)).not.toContain('fn_f06_withdraw_unproven_movement_park');
  expect(f.stop).not.toHaveBeenCalled();
});

it.each(['not-a-time', '2026-02-30T00:00:00Z', '2026-10-27', null, 0])(
  'invalid durable park age %j cannot reach movement or change the dealer',
  async (park_created_at) => {
    const f = fixture('refuse', 'withdrawn', { park_created_at });
    await expect(f.admitOnce()).rejects.toThrow(/F06 invalid park creation time/);
    expect(names(f.calls)).not.toContain('fn_f06_admit_parked_movement');
    expect(names(f.calls)).not.toContain('fn_f06_withdraw_unproven_movement_park');
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  }
);
