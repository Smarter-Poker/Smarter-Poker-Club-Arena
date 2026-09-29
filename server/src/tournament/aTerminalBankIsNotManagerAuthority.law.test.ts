/**
 * A TERMINAL ENGINE'S FROZEN TIME BANK IS NOT MANAGER AUTHORITY (2026-09-26).
 *
 * The engine collapsed about an hour after each of the day's restarts
 * (f1d956c3 at 04:45Z, 209d1b45 at ~07:52Z: 436 managers quarantined, 487
 * tables stalled). A manager lost its lease, its table engines went terminal
 * holding stopped time-bank custody, and #5255's write of that custody went
 * out under the DEAD manager's data-actor headers. The database's request
 * hook fences every request of a lease that is no longer current, GET
 * included, so in the sixteen minutes before the 08:55Z restart:
 *
 *   698      [savePresenceAtPark] ...: TOURNAMENT_MANAGER_FENCED
 *   134,904  Tournament table ... retained time-bank custody
 *   100,607  f06_mixed_bank_evidence_unavailable   (the retirement's read)
 *
 * The bank never reached disk, the stop could never pass, the retirement
 * could never read its evidence, and stopped_bank_custody_stuck held the
 * restart certificate shut until someone restarted the engine by hand.
 *
 * The fake database below enforces the one rule that mattered: a request
 * made inside a tournament authority whose generation is dead is refused
 * with the production error. The law: custody is written and read as the
 * process, through a write that cannot clobber newer state, and is
 * acknowledged only when the database confirms it.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const FENCED = 'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current';

const db = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  deadGenerations: new Set<string>(),
  laterHandTables: new Set<string>(),
  rpcFails: false,
  rpcCalls: [] as { name: string; args: any; authority: unknown }[],
  upserts: [] as { row: any; authority: unknown }[],
  authority: (() => null) as () => { tournamentId: string; leaseGeneration: string } | null,
}));

vi.mock('../services/supabase/client.js', () => {
  /* The request hook, reduced to its rule: a marked manager request whose
     lease generation is not current is refused, reads included. */
  const fenced = () => {
    const authority = db.authority();
    return authority !== null && db.deadGenerations.has(authority.leaseGeneration);
  };
  const presence = {
    upsert: async (row: any) => {
      const authority = db.authority();
      db.upserts.push({ row, authority });
      if (fenced()) return { error: { message: FENCED } };
      db.rows.set(row.table_id, structuredClone(row));
      return { error: null };
    },
    select: () => ({
      eq: (_column: string, tableId: string) => ({
        maybeSingle: async () =>
          fenced()
            ? { data: null, error: { message: FENCED } }
            : { data: structuredClone(db.rows.get(tableId) ?? null), error: null },
      }),
      in: (_column: string, tableIds: string[]) => {
        // Captured when the request is SENT - a builder sends when consumed.
        const run = () =>
          fenced()
            ? { data: null, error: { message: FENCED } }
            : {
                data: tableIds.filter((id) => db.rows.has(id)).map((id) => db.rows.get(id)),
                error: null,
              };
        return {
          then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
        };
      },
    }),
  };
  const handHistory = {
    select: () => ({
      eq: () => ({
        order: () => ({
          limit: () => ({ maybeSingle: async () => ({ data: { hand_number: 12 }, error: null }) }),
        }),
      }),
    }),
  };
  return {
    supabase: {
      from: (name: string) => (name === 'hand_history' ? handHistory : presence),
      rpc: async (name: string, args: any) => {
        const authority = db.authority();
        db.rpcCalls.push({ name, args, authority });
        if (fenced()) return { data: null, error: { message: FENCED } };
        if (name !== 'fn_park_stopped_time_bank_custody')
          return { data: null, error: { message: `unexpected rpc ${name}` } };
        // fn_park_stopped_time_bank_custody: service actor only.
        if (authority !== null)
          return { data: null, error: { message: 'STOPPED_CUSTODY_SERVICE_REQUIRED' } };
        if (db.rpcFails) return { data: null, error: { message: 'fetch failed' } };
        const existing = db.rows.get(args.p_table_id);
        const refuse = (refused: string) => ({
          data: { ok: false, refused, table_id: args.p_table_id },
          error: null,
        });
        if (existing?.engine_instance === 'f06_mixed_custody')
          return refuse('mixed_custody_adopted');
        if (
          existing?.time_bank_snapshot &&
          existing.time_bank_snapshot.handNumber > args.p_hand_number
        )
          return refuse('newer_park');
        if (db.laterHandTables.has(args.p_table_id)) return refuse('hand_after_custody');
        db.rows.set(args.p_table_id, {
          table_id: args.p_table_id,
          disconnect_states: args.p_disconnect_states,
          parked_at: args.p_parked_at,
          engine_instance: args.p_engine_instance,
          time_bank_snapshot: {
            version: 1,
            parkedAt: args.p_parked_at,
            handNumber: args.p_hand_number,
            players: args.p_players,
          },
        });
        return {
          data: {
            ok: true,
            table_id: args.p_table_id,
            hand_number: args.p_hand_number,
            parked_at: args.p_parked_at,
          },
          error: null,
        };
      },
    },
    maintenanceSupabase: {},
  };
});
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

import {
  bindTournamentDataAuthorityMethods,
  currentTournamentDataAuthority,
  runWithTournamentDataAuthority,
} from '../services/supabase/dataActorContext.js';
import { loadTimeBanksFromPark, savePresenceAtPark } from '../services/supabase/snapshots.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { readMixedF06PresenceEvidence } from './mixedF06Custody.js';

db.authority = currentTournamentDataAuthority;

const table = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tournament = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEAD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const user = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const stay = 'cccccccc-cccc-4ccc-8ccc-000000000001';
const asDeadManager = <T>(work: () => T) =>
  runWithTournamentDataAuthority({ tournamentId: tournament, leaseGeneration: DEAD }, work);

/** A tournament table engine that went terminal holding one player's bank at hand 12. */
async function terminalEngineOfADeadManager() {
  const e = new ServerTableEngine(table) as any;
  e.lifecycleCanMutate = () => true;
  e.tableInfo = { id: table, tournament_id: tournament, tournament_type: 'mtt' };
  e.handCount = 12;
  e.parkWriteRetryMs = 0;
  e.flushSnapshot = vi.fn().mockResolvedValue(undefined);
  e.adoptSeatRoster([{ user_id: user, occupancy_id: stay, seat_number: 1, stack: 1500 }]);
  e.timeBankEngine.initializePlayer(table, user, { remainingSeconds: 40, usesRemaining: 2 });
  e.timeBankMeta.set(user, { initialSeconds: 40, baseSeconds: 40, dbConsumedSeconds: 0 });
  await e.stop();
  expect(e.stoppedTimeBankCustody.handNumber).toBe(12);
  expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(true);
  // Exactly as production: every method runs in the manager's authority.
  bindTournamentDataAuthorityMethods({ tournamentId: tournament, leaseGeneration: DEAD }, e);
  // ... and that manager's lease is gone.
  db.deadGenerations.add(DEAD);
  db.upserts.length = 0;
  db.rpcCalls.length = 0;
  return e;
}

async function announceBreak(e: any) {
  e.pauseForMaintenance(60_000);
  await e.presenceSave;
}

beforeEach(() => {
  db.rows.clear();
  db.deadGenerations.clear();
  db.laterHandTables.clear();
  db.rpcFails = false;
  db.rpcCalls.length = 0;
  db.upserts.length = 0;
});

describe('the production deadlock, reproduced against the fence', () => {
  it("a dead manager's custody write and evidence read are both fenced", async () => {
    db.deadGenerations.add(DEAD);
    const banks = {
      [user]: {
        occupancyId: stay,
        remainingSeconds: 40,
        usesRemaining: 2,
        initialSeconds: 40,
        baseSeconds: 40,
        dbConsumedSeconds: 0,
      },
    };
    // #5255's write, as it went out: the dead manager's headers, refused.
    expect(
      await asDeadManager(() =>
        savePresenceAtPark({
          tableId: table,
          disconnectStates: {},
          handNumber: 12,
          timeBanks: banks,
        })
      )
    ).toBe(false);
    expect(db.rows.has(table)).toBe(false);
    // The retirement's evidence read, as it went out: fenced as well.
    db.rows.set(table, { table_id: table, time_bank_snapshot: null });
    const { supabase } = await import('../services/supabase/client.js');
    const shipped = await asDeadManager(
      () => supabase.from('engine_presence_parked').select('*').in('table_id', [table]) as any
    );
    expect(shipped.error?.message).toBe(FENCED);
  });
});

describe('a terminal engine writes its frozen custody as the process', () => {
  it('writes at the break announcement, at the process root, and acknowledges it', async () => {
    const e = await terminalEngineOfADeadManager();
    await announceBreak(e);
    const call = db.rpcCalls.find((c) => c.name === 'fn_park_stopped_time_bank_custody');
    expect(call, 'the custody write goes through the guarded function').toBeDefined();
    expect(call!.authority, 'and carries no manager authority').toBeNull();
    expect(call!.args).toMatchObject({
      p_table_id: table,
      p_tournament_id: tournament,
      p_hand_number: 12,
      p_players: { [user]: { occupancyId: stay, remainingSeconds: 40, usesRemaining: 2 } },
    });
    expect(db.upserts, 'no unconditional upsert is sent at all').toEqual([]);
    // The restart census asks a terminal engine exactly this, and nothing else.
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(false);
    expect(e.maintenanceDurabilityReason() ?? '').not.toMatch(/^stopped_bank_custody_/);
    // And it is the shape the next process reads back at hand 12.
    expect(await loadTimeBanksFromPark(table, 12)).toMatchObject({
      [user]: { occupancyId: stay, remainingSeconds: 40 },
    });
  });

  it("writes when the manager's stop asks, before the stop reads what is retained", async () => {
    const e = await terminalEngineOfADeadManager();
    await e.persistStoppedTimeBankCustody();
    expect(db.rpcCalls.map((c) => [c.name, c.authority])).toEqual([
      ['fn_park_stopped_time_bank_custody', null],
    ]);
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(false);
    // Once on disk it is not written again.
    await e.persistStoppedTimeBankCustody();
    expect(db.rpcCalls).toHaveLength(1);
  });

  it("never overwrites a successor's newer park, and still refuses the gate", async () => {
    const e = await terminalEngineOfADeadManager();
    const successor = {
      table_id: table,
      disconnect_states: {},
      parked_at: new Date().toISOString(),
      engine_instance: '1-successor:parked',
      time_bank_snapshot: { version: 1, parkedAt: 'x', handNumber: 13, players: { [user]: {} } },
    };
    db.rows.set(table, structuredClone(successor));
    await announceBreak(e);
    await e.persistStoppedTimeBankCustody();
    expect(db.rows.get(table)).toEqual(successor);
    expect(db.upserts, 'no fall-through upsert erases it either').toEqual([]);
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(true);
    expect(e.maintenanceDurabilityReason()).toBe('stopped_bank_custody_unwritten');
  });

  it('never writes over a hand dealt after the custody, nor over an adopted transfer', async () => {
    const e = await terminalEngineOfADeadManager();
    db.laterHandTables.add(table);
    await e.persistStoppedTimeBankCustody();
    expect(db.rows.has(table)).toBe(false);
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(true);
    db.laterHandTables.clear();
    const adopted = {
      table_id: table,
      engine_instance: 'f06_mixed_custody',
      time_bank_snapshot: null,
    };
    db.rows.set(table, adopted);
    await e.persistStoppedTimeBankCustody();
    expect(db.rows.get(table)).toEqual(adopted);
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(true);
  });

  it('an unknown answer acknowledges nothing and erases nothing', async () => {
    const e = await terminalEngineOfADeadManager();
    db.rpcFails = true;
    await announceBreak(e);
    expect(db.upserts).toEqual([]);
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(true);
    expect(e.maintenanceDurabilityReason()).toBe('stopped_bank_custody_unwritten');
    // The next ask - the stop's retry - lands it.
    db.rpcFails = false;
    await e.persistStoppedTimeBankCustody();
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(false);
  });
});

describe('the retirement reads its bank evidence as the process', () => {
  it('reads the park rows from inside a dead manager, and hands its authority back', async () => {
    db.deadGenerations.add(DEAD);
    db.rows.set(table, { table_id: table, time_bank_snapshot: null });
    const seen = await asDeadManager(async () => {
      const read = await readMixedF06PresenceEvidence([table]);
      return { read, after: currentTournamentDataAuthority() };
    });
    expect(seen.read.error).toBeNull();
    expect(seen.read.data).toEqual([{ table_id: table, time_bank_snapshot: null }]);
    expect(seen.after).toMatchObject({ tournamentId: tournament, leaseGeneration: DEAD });
  });
});

describe('the wiring', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('captureMixedF06Custody reads engine_presence_parked only through the root-bound read', () => {
    const src = read('./TournamentManager.ts');
    const body = src.slice(
      src.indexOf('async captureMixedF06Custody('),
      src.indexOf('private tournamentSeatMoveSerialTail')
    );
    expect(body).toContain('readMixedF06PresenceEvidence(');
    expect(body).not.toContain(".from('engine_presence_parked')");
    const helper = read('./mixedF06Custody.ts');
    expect(helper).toMatch(/export const readMixedF06PresenceEvidence = bindToProcessRoot\(async/);
  });

  it("the manager's stop writes custody before it asks whether custody is retained", () => {
    const src = read('./TournamentManagerBase.ts');
    const stop = src.slice(src.indexOf('  stop(): Promise<void> {'));
    const write = stop.indexOf('engine.persistStoppedTimeBankCustody?.()');
    const check = stop.indexOf('`Tournament table ${tableId} retained time-bank custody`');
    expect(write).toBeGreaterThan(-1);
    expect(write).toBeLessThan(check);
  });

  it('the stopped-custody write is the guarded function at the process root, never the upsert', () => {
    const engine = read('../engine/ServerTableEngineBase.ts');
    const fn = engine.slice(
      engine.indexOf('private async persistStoppedCustodyForRestart('),
      engine.indexOf('protected async persistPresenceForRestart(')
    );
    expect(fn).toContain('parkStoppedTimeBankCustody(');
    expect(fn).not.toContain('savePresenceAtPark(');
    expect(fn).toContain("if (outcome.status !== 'parked') return true;");
    const snapshots = read('../services/supabase/snapshots.ts');
    expect(snapshots).toMatch(/export const parkStoppedTimeBankCustody = bindToProcessRoot\(/);
    expect(snapshots).toContain("rpc('fn_park_stopped_time_bank_custody'");
  });

  it('the database function refuses rather than clobbers, and only the service actor may call it', () => {
    const migration = read(
      '../../../supabase/migrations/20260926090846_a_terminal_engines_frozen_time_bank_is_not_manager_authority.sql'
    );
    for (const guard of [
      "current_setting('app.smarter_data_actor', true) IS DISTINCT FROM 'service'",
      "'newer_park'",
      "'hand_after_custody'",
      "'mixed_transfer_recorded'",
      "'mixed_custody_adopted'",
      'smarter_private.f06_retired_origin_lock(p_tournament_id)',
      'FOR UPDATE',
      'ON CONFLICT (table_id) DO NOTHING',
      'FROM PUBLIC, anon, authenticated',
      'TO service_role',
    ])
      expect(migration, guard).toContain(guard);
    expect(migration).not.toMatch(/ON CONFLICT \(table_id\) DO UPDATE/);
  });
});
