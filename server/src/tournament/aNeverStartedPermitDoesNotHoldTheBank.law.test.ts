/**
 * A NEVER-STARTED PERMIT DOES NOT HOLD THE BANK (2026-09-27).
 *
 * Six tournaments lost their lease at 2026-09-26 15:07Z while each table
 * engine held one F06 permit it had reserved for the next hand and never
 * started. The stopped-custody park refused `hand_after_custody` over the
 * `reserved` row, every stop failed "retained time-bank custody" (16,400
 * retries per manager), stopped_bank_custody_stuck held the restart
 * certificate shut at 26 hourly countdowns, and no release was admitted for
 * 24 hours. The permit could not be cancelled the ordinary way because that
 * door (fn_f06_cancel_prepared_hand) requires the live lease the engine had
 * just lost; and the park could not tell a reserved-never-started hand from a
 * reserved-and-dealt one, because `start` is a fence the engine holds
 * locally.
 *
 * The law: the engine attests, by id and hand number, the one permit above
 * its custody it never started; the same guarded function releases it
 * `never_started` in the park's own transaction, under the exact refusals the
 * ordinary door applies, and the engine treats its preparation as resolved
 * only when the database names that permit back. A permit whose `start` ran
 * is never attested, and the park keeps refusing over it.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  permits: new Map<string, { state: string; hand_number: number; generation: string }>(),
  liveGenerations: new Set<string>(),
  startWitnesses: new Set<string>(),
  echoRelease: true,
  rpcCalls: [] as { name: string; args: any }[],
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
      const refuse = (refused: string, extra: Record<string, unknown> = {}) => ({
        data: { ok: false, refused, table_id: args.p_table_id, ...extra },
        error: null,
      });
      /* The database half, reduced to its rules (20260927150704). */
      let released: string | null = null;
      if (args.p_unstarted_permit_id !== undefined) {
        const permit = db.permits.get(args.p_unstarted_permit_id);
        if (!permit || permit.hand_number !== args.p_unstarted_hand_number)
          return refuse('unstarted_permit_not_this_engines');
        if (permit.state === 'never_started') released = args.p_unstarted_permit_id;
        else {
          if (permit.state !== 'reserved')
            return refuse('hand_after_custody', { evidence: 'f06_hand_permits' });
          if (db.liveGenerations.has(args.p_generation))
            return refuse('unstarted_permit_generation_live');
          if (db.startWitnesses.has(args.p_unstarted_permit_id))
            return refuse('hand_after_custody', { evidence: 'unstarted_permit_start_witness' });
          permit.state = 'never_started';
          released = args.p_unstarted_permit_id;
        }
      }
      // #5409 (20260927142925): a reserved permit of the caller's own generation
      // is not evidence of a later hand; anything else above the custody refuses.
      for (const [id, permit] of db.permits)
        if (
          permit.hand_number > args.p_hand_number &&
          permit.state !== 'never_started' &&
          !(permit.state === 'reserved' && permit.generation === args.p_generation)
        )
          return refuse('hand_after_custody', { evidence: 'f06_hand_permits', permit: id });
      db.rows.set(args.p_table_id, { hand: args.p_hand_number, players: args.p_players });
      return {
        data: {
          ok: true,
          table_id: args.p_table_id,
          hand_number: args.p_hand_number,
          parked_at: args.p_parked_at,
          unstarted_permit_released: db.echoRelease ? released : null,
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

const table = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tournament = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const generation = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const permitId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const custodyId = '99999999-9999-4999-8999-999999999999';
const user = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const stay = 'cccccccc-cccc-4ccc-8ccc-000000000001';

/** The permit an engine reserved for hand 13 through the production class. */
async function reservedPermit(): Promise<F06HandPermit> {
  const binding = {
    tournament_id: tournament,
    lease_generation: generation,
    table_id: table,
    lifecycle: '7',
    permit_id: permitId,
    hand_number: '13',
    custody_id: custodyId,
  };
  const permit = new F06HandPermit(
    binding,
    async () => ({ data: { ok: true, ...binding, generation, state: 'reserved' }, error: null }),
    () => true
  );
  await permit.reserve();
  db.permits.set(permitId, { state: 'reserved', hand_number: 13, generation });
  return permit;
}

/**
 * A tournament table engine under its manager's lease, terminal at hand 12
 * with one player's bank frozen, holding the permit it reserved for hand 13.
 */
async function terminalEngineHolding(permit: F06HandPermit) {
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
  e.f06CurrentPermit = permit;
  await e.stop();
  expect(e.stoppedTimeBankCustody.handNumber).toBe(12);
  expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(true);
  // An attempted permit is a hand that may have happened, not an unresolved preparation.
  expect(e.hasUnresolvedF06Preparation()).toBe(permit.recoveryState() !== 'attempted');
  db.rpcCalls.length = 0;
  return e;
}

const parkCall = () => db.rpcCalls.find((c) => c.name === 'fn_park_stopped_time_bank_custody');

beforeEach(() => {
  db.rows.clear();
  db.permits.clear();
  db.liveGenerations.clear();
  db.startWitnesses.clear();
  db.echoRelease = true;
  db.rpcCalls.length = 0;
});

describe('the production wedge, reproduced', () => {
  it('without the attestation the reserved permit stays open and the preparation stays unresolved', async () => {
    const e = await terminalEngineHolding(await reservedPermit());
    // The engine of every release before this one sends eight arguments.
    e.unstartedPermitAttestation = () => null;
    await e.persistStoppedTimeBankCustody();
    expect(parkCall()!.args).not.toHaveProperty('p_unstarted_permit_id');
    // #5409 lets the bank land over the engine's own reserved permit ...
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(false);
    // ... but the permit is still open for the successor to meet, and this
    // engine still reports an unresolved preparation to the restart census.
    expect(db.permits.get(permitId)!.state).toBe('reserved');
    expect(e.hasUnresolvedF06Preparation()).toBe(true);
  });
});

describe('a never-started permit is attested and released with the park', () => {
  it('names the permit above the custody, and the acknowledged release resolves the preparation', async () => {
    const e = await terminalEngineHolding(await reservedPermit());
    await e.persistStoppedTimeBankCustody();
    expect(parkCall()!.args).toMatchObject({
      p_table_id: table,
      p_tournament_id: tournament,
      p_generation: generation,
      p_hand_number: 12,
      p_unstarted_permit_id: permitId,
      p_unstarted_hand_number: 13,
    });
    expect(db.permits.get(permitId)!.state).toBe('never_started');
    expect(db.rows.get(table)).toMatchObject({ hand: 12 });
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(false);
    expect(e.hasUnresolvedF06Preparation()).toBe(false);
    expect(e.maintenanceDurabilityReason() ?? '').not.toMatch(/^stopped_bank_custody_/);
  });

  it('a permit whose start ran is never attested and never closed by the park', async () => {
    const permit = await reservedPermit();
    permit.start(() => {});
    const e = await terminalEngineHolding(permit);
    await e.persistStoppedTimeBankCustody();
    expect(parkCall()!.args).not.toHaveProperty('p_unstarted_permit_id');
    // The hand that may have happened is left for the abandoned-generation
    // door to decide from rows; this path never voids it.
    expect(db.permits.get(permitId)!.state).toBe('reserved');
    expect(e.f06CurrentPermit).toBe(permit);
  });

  it("a permit of another generation or table is not this engine's to attest", async () => {
    const permit = await reservedPermit();
    (permit as any).binding = Object.freeze({
      ...permit.binding,
      lease_generation: '11111111-1111-4111-8111-111111111111',
    });
    const e = await terminalEngineHolding(permit);
    await e.persistStoppedTimeBankCustody();
    expect(parkCall()!.args).not.toHaveProperty('p_unstarted_permit_id');
    expect(db.permits.get(permitId)!.state).toBe('reserved');
    expect(e.hasUnresolvedF06Preparation()).toBe(true);
  });

  it('the database refuses a generation that still holds the lease, and nothing is acknowledged', async () => {
    db.liveGenerations.add(generation);
    const e = await terminalEngineHolding(await reservedPermit());
    await e.persistStoppedTimeBankCustody();
    expect(e.stoppedCustodyParkOutcome).toEqual({
      status: 'refused',
      reason: 'unstarted_permit_generation_live',
    });
    expect(db.permits.get(permitId)!.state).toBe('reserved');
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(true);
    expect(e.hasUnresolvedF06Preparation()).toBe(true);
  });

  it('a durable witness of a start refuses the claimed no-start, hand_after_custody as before', async () => {
    db.startWitnesses.add(permitId);
    const e = await terminalEngineHolding(await reservedPermit());
    await e.persistStoppedTimeBankCustody();
    expect(e.stoppedCustodyParkOutcome).toEqual({
      status: 'refused',
      reason: 'hand_after_custody',
    });
    expect(db.permits.get(permitId)!.state).toBe('reserved');
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(true);
    expect(e.hasUnresolvedF06Preparation()).toBe(true);
  });

  it('a park that does not name the permit back leaves the preparation unresolved', async () => {
    db.echoRelease = false;
    const e = await terminalEngineHolding(await reservedPermit());
    await e.persistStoppedTimeBankCustody();
    expect(e.stoppedCustodyParkOutcome).toEqual({
      status: 'parked',
      unstartedPermitReleased: null,
    });
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(false);
    expect(e.hasUnresolvedF06Preparation()).toBe(true);
  });
});

describe('the wiring', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('the attestation is sent by the process-root park and only for a permit that never started', () => {
    const engine = read('../engine/ServerTableEngineBase.ts');
    const fn = engine.slice(
      engine.indexOf('private async persistStoppedCustodyForRestart('),
      engine.indexOf('protected async persistPresenceForRestart(')
    );
    expect(fn).toContain('this.unstartedPermitAttestation(custody.handNumber)');
    expect(fn).toContain('outcome.unstartedPermitReleased === unstartedPermit.permitId');
    const attest = engine.slice(
      engine.indexOf('private unstartedPermitAttestation('),
      engine.indexOf('protected async persistPresenceForRestart(')
    );
    expect(attest).toContain(
      "phase !== 'reserved' && phase !== 'unknown' && phase !== 'terminated'"
    );
    expect(attest).toContain('handNumber <= custodyHandNumber');
    const snapshots = read('../services/supabase/snapshots.ts');
    expect(snapshots).toContain('p_unstarted_permit_id: unstarted.permitId');
    expect(snapshots).toContain('reply.unstarted_permit_released === unstarted.permitId');
  });

  it('the database releases only a reserved permit of a dead generation with no start witness, in the park transaction', () => {
    const migration = read(
      '../../../supabase/migrations/20260927150704_a_never_started_permit_does_not_hold_the_stopped_bank.sql'
    );
    for (const guard of [
      'p_unstarted_permit_id uuid DEFAULT NULL',
      'p_unstarted_hand_number bigint DEFAULT NULL',
      'p_unstarted_hand_number <= p_hand_number',
      "v_permit.state <> 'reserved' OR v_permit.evidence_id IS NOT NULL",
      'public.fn_engine_lease_stale_seconds()',
      "'unstarted_permit_generation_live'",
      "'unstarted_permit_start_witness'",
      'smarter_private.f06_hand_dispatch',
      'public.table_hole_cards',
      'public.hand_private_state',
      'INSERT INTO smarter_private.f06_prepared_hand_cancellations',
      "SET state = 'never_started', evidence_id = p_unstarted_permit_id",
      "'unstarted_permit_released', v_released",
      'DROP FUNCTION public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text);',
      "current_setting('app.smarter_data_actor', true) IS DISTINCT FROM 'service'",
      'FROM PUBLIC, anon, authenticated',
      'TO service_role',
    ])
      expect(migration, guard).toContain(guard);
    // The ordinary refusals are all still there, verbatim.
    for (const guard of [
      "'newer_park'",
      'AND h.generation = p_generation',
      "'mixed_transfer_recorded'",
      "'mixed_custody_adopted'",
      "'custody_transfer_busy'",
      "'concurrent_park'",
      'ON CONFLICT (table_id) DO NOTHING',
    ])
      expect(migration, guard).toContain(guard);
    expect(migration).not.toMatch(/ON CONFLICT \(table_id\) DO UPDATE/);
  });
});
