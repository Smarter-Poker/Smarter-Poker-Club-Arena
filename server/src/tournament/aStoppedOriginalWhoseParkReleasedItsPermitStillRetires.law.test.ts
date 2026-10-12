/**
 * A STOPPED ORIGINAL WHOSE PARK RELEASED ITS PERMIT STILL RETIRES (2026-10-01).
 *
 * Table a2d8a54e ($100 Freeroll 6:00 AM, nine seated players): a lost
 * fn_f06_begin_hand left the dealer's permit `unknown`; the zombie watchdog
 * stopped the engine at 11:49:22Z and the Manager parked the table as break
 * c0b625dd's stopped original. The first custody claim missed. Before the
 * retry, the :53 maintenance announcement ran the stopped-custody park, which
 * released that never-started permit `never_started` in its own transaction
 * (f06_absent_permit_releases, 11:53:01Z) and dropped the permit object. From
 * then on every retirement of the break refused with
 * `f06_stopped_original_permit_mismatch` - 426 times - because the original no
 * longer held the permit the movement admission asked for, and the table
 * dealt nothing until the process was replaced.
 *
 * The law: the park's release is the never-started proof. A stopped original
 * whose park named its permit back is admitted to movement under the exact
 * park claim, without a live permit and without a second no-start write; any
 * other identity, or a park claim that is not exact, still refuses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  rpcCalls: [] as { name: string; args: any }[],
  echoRelease: true,
}));

vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: { hand_number: 12 }, error: null }),
            }),
          }),
        }),
      }),
      upsert: async () => ({ error: null }),
    }),
    rpc: async (name: string, args: any) => {
      db.rpcCalls.push({ name, args });
      if (name !== 'fn_park_stopped_time_bank_custody')
        return { data: null, error: { message: `unexpected rpc ${name}` } };
      return {
        data: {
          ok: true,
          table_id: args.p_table_id,
          hand_number: args.p_hand_number,
          parked_at: args.p_parked_at,
          unstarted_permit_released: db.echoRelease ? (args.p_unstarted_permit_id ?? null) : null,
        },
        error: null,
      };
    },
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/supabase.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../services/supabase.js')),
  loadTable: async () => ({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tournament_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    small_blind: 1,
    big_blind: 2,
    max_players: 6,
    game_variant: 'nlh',
  }),
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { F06HandPermit } from '../services/F06HandPermit.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';

const table = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tournament = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const generation = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const permitId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const originalCustody = '99999999-9999-4999-8999-999999999999';
const breakId = '11111111-1111-4111-8111-111111111111';
const parkCustody = '22222222-2222-4222-8222-222222222222';
const owner = '33333333-3333-4333-8333-333333333333';
const otherGeneration = '44444444-4444-4444-8444-444444444444';
const user = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const stay = 'cccccccc-cccc-4ccc-8ccc-000000000001';

const binding = {
  breakId,
  tableId: table,
  tableIncarnation: '7',
  tournamentId: tournament,
  custodyId: parkCustody,
  durableRevision: '1',
  leaseGeneration: generation,
};

/** The production permit class, its BEGIN lost: phase `unknown`. */
async function unknownPermit(): Promise<F06HandPermit> {
  const permit = new F06HandPermit(
    {
      tournament_id: tournament,
      lease_generation: generation,
      table_id: table,
      lifecycle: '7',
      permit_id: permitId,
      hand_number: '13',
      custody_id: originalCustody,
    },
    async () => ({
      data: null,
      error: { message: 'canceling statement due to statement timeout' },
    }),
    () => true
  );
  await expect(permit.reserve()).rejects.toThrow('f06_permit_unproven');
  expect(permit.recoveryState()).toBe('unknown');
  return permit;
}

/** A stopped tournament original holding that permit, then the :53 park. */
async function parkedOriginal(): Promise<any> {
  const e = new ServerTableEngine(table, {
    scope: 'tournament',
    verified: true,
    generation,
    tournamentId: tournament,
    proofDeadlineMonotonicMs: Number.MAX_SAFE_INTEGER,
  } as any) as any;
  e.lifecycleCanMutate = () => true;
  e.tableInfo = { id: table, tournament_id: tournament, tournament_type: 'mtt' };
  e.handCount = 12;
  e.parkWriteRetryMs = 0;
  e.flushSnapshot = vi.fn().mockResolvedValue(undefined);
  e.adoptSeatRoster([{ user_id: user, occupancy_id: stay, seat_number: 1, stack: 1500 }]);
  e.timeBankEngine.initializePlayer(table, user, { remainingSeconds: 40, usesRemaining: 2 });
  e.timeBankMeta.set(user, { initialSeconds: 40, baseSeconds: 40, dbConsumedSeconds: 0 });
  e.f06CurrentPermit = await unknownPermit();
  await e.stop();
  await e.persistStoppedTimeBankCustody();
  return e;
}

const exactPark =
  (overrides: Record<string, unknown> = {}) =>
  async () => ({
    ok: true,
    state: 'park_requested',
    break_id: breakId,
    custody_id: parkCustody,
    revision: '1',
    custody_generation: generation,
    tournament_id: tournament,
    source_table_id: table,
    lifecycle: '7',
    ...overrides,
  });

async function admit(engine: any, park: () => Promise<unknown>, b: typeof binding = binding) {
  const registry = new TournamentRetirementCustody<any>();
  const global = new Map([[table, engine]]);
  const local = new Map([[table, engine]]);
  const moved: string[] = [];
  await registry.withCustody(
    b,
    global,
    local,
    () => true,
    async (custody) => {
      await engine.admitF06StoppedOriginalMovement(owner, custody, park);
      expect(await engine.parkForTournamentMove(owner, 0)).toBe(true);
      moved.push(
        await engine.executeTournamentMoveAtBoundary(owner, async () => 'canonical-move-ack')
      );
    },
    async () => {}
  );
  return moved;
}

beforeEach(() => {
  db.rpcCalls.length = 0;
  db.echoRelease = true;
});

describe('the production wedge, reproduced', () => {
  it('the park releases the unknown permit and drops the object the old admission demanded', async () => {
    const e = await parkedOriginal();
    const park = db.rpcCalls.find((c) => c.name === 'fn_park_stopped_time_bank_custody');
    expect(park?.args.p_unstarted_permit_id).toBe(permitId);
    expect(e.f06CurrentPermit).toBeNull();
    expect(e.hasUnresolvedF06Preparation()).toBe(false);
  });
});

describe('the park release is the never-started proof', () => {
  it('admits movement under the exact park claim, with no second no-start write', async () => {
    const e = await parkedOriginal();
    db.rpcCalls.length = 0;
    expect(await admit(e, exactPark())).toEqual(['canonical-move-ack']);
    expect(db.rpcCalls.map((c) => c.name)).not.toContain('fn_f06_finish_original_no_start');
  });

  it('a park claim that is not exact never admits movement', async () => {
    for (const overrides of [
      { custody_id: originalCustody },
      { revision: '2' },
      { state: 'begun' },
      { lifecycle: '8' },
      { source_table_id: breakId },
      { custody_generation: otherGeneration },
    ]) {
      const e = await parkedOriginal();
      await expect(admit(e, exactPark(overrides))).rejects.toThrow('f06_original_custody_unproven');
      expect(e.hasClaimedTournamentMoveBoundary()).toBe(false);
    }
  });

  it('a break for another table incarnation or generation is not this permit', async () => {
    for (const b of [
      { ...binding, tableIncarnation: '8' },
      { ...binding, leaseGeneration: otherGeneration },
    ]) {
      const e = await parkedOriginal();
      await expect(admit(e, exactPark(), b)).rejects.toThrow(
        'f06_stopped_original_permit_mismatch'
      );
      expect(e.hasClaimedTournamentMoveBoundary()).toBe(false);
    }
  });

  it('a park that did not name the permit back leaves the live-permit path, not this proof', async () => {
    db.echoRelease = false;
    const e = await parkedOriginal();
    expect(e.f06CurrentPermit).not.toBeNull();
    expect(e.f06ParkReleasedPermit).toBeNull();
  });

  it('an original with no permit and no park release still refuses', async () => {
    db.echoRelease = false;
    const e = await parkedOriginal();
    e.f06CurrentPermit = null;
    await expect(admit(e, exactPark())).rejects.toThrow('f06_stopped_original_permit_mismatch');
  });
});
