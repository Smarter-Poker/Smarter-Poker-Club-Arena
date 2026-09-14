/** Actual manager + actual maintenance SQL/Store. Only network transport and
 * table-engine infrastructure are substituted. Enabled by the owned PG17 runner. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
import { createOperationMaintenanceStore } from '../maintenance/operationMaintenanceStore.js';
import type { OperationTournamentProof } from '../maintenance/OperationTournament.js';
const enabled = !!process.env.CA_TOURNAMENT_NATIVE_CLUSTER;
const sessions: any[] = [],
  managers: any[] = [],
  trace: any[] = [];
let fixture: any, state: any, management: any, Base: any, supabase: any, maintenanceSupabase: any;
const structure = [{ smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 }];
const until = async (predicate: () => Promise<boolean>, label: string) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(label);
};
describe.skipIf(!enabled)('native actual manager and committed SQL clock adoption', () => {
  beforeAll(async () => {
    state = JSON.parse(await readFile(process.env.CA_TOURNAMENT_NATIVE_CLUSTER!, 'utf8'));
    expect(state.socket).toMatch(/^\/(?:private\/)?tmp\/ca-e2-owned-[^/]+\/socket$/);
    expect(state.database).toBe('e2_bee519fa');
    const modulePath = pathToFileURL(
      join(process.env.CA_TOURNAMENT_AUTHORITY_SOURCE!, 'tests/maintenance/runtime-fixture.mjs')
    ).href;
    fixture = await import(/* @vite-ignore */ modulePath);
    management = await fixture.connect(state, 'postgres');
    sessions.push(management);
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
    ({ TournamentManagerBase: Base } = await import('./TournamentManagerBase.js'));
    ({ supabase, maintenanceSupabase } = await import('../services/supabase.js'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  }, 60000);
  afterAll(async () => {
    for (const manager of managers) manager.fenceForServerShutdown();
    await Promise.all(sessions.map((c) => c.end()));
    setMaintenanceFrozen(false);
    vi.restoreAllMocks();
    if (enabled)
      await writeFile(
        join(process.env.CA_TOURNAMENT_NATIVE_EVIDENCE!, 'manager-trace.json'),
        JSON.stringify(trace, null, 2)
      );
  });
  async function setup(label: string, ownBreak = false) {
    const database = 'manager_' + label;
    await management.query('CREATE DATABASE ' + database + ' TEMPLATE maintenance_template');
    const c = await fixture.connect(state, database),
      rpc = await fixture.connect(state, database),
      rows = await fixture.connect(state, database);
    sessions.push(c, rpc, rows);
    const base = await fixture.readBase(c);
    const held = await fixture.fixtureHold(c, { seconds: 960, plan: false });
    await fixture.seedClocks(c, held.s);
    // Fixture-only immutable structure setup; tested services retain all native triggers.
    await c.query('BEGIN; SET LOCAL session_replication_role=replica');
    await c.query(
      `UPDATE public.tournaments SET current_level=0,blind_structure=$1,on_break=$2,addon_period_triggered=false,add_on_available=false,prize_pool_finalized=true WHERE id=$3`,
      [JSON.stringify(structure), ownBreak, base.event]
    );
    await c.query('COMMIT');
    // The sealed E2 schema loader omits table ACLs. Install only this fixture's
    // service table reads (including invoker-trigger lookups) and only three
    // writable clock columns. Authority RPC/private-journal ACLs are unchanged.
    await c.query(
      'GRANT USAGE ON SCHEMA auth TO service_role; GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role; GRANT UPDATE(on_break,break_ends_at,level_started_at) ON public.tournaments TO service_role'
    );
    await rpc.query(
      `SET ROLE service_role; SET request.jwt.claim.role='service_role'; SET request.jwt.claims='{"role":"service_role"}'`
    );
    await rows.query(
      `SET ROLE service_role; SET request.jwt.claim.role='service_role'; SET request.jwt.claims='{"role":"service_role"}'`
    );
    const writes: any[] = [];
    const control = { readFails: false, loseWriteReply: false, afterRow: async () => {} };
    const rpcBridge = async (name: string, args: any) => {
      expect(name).toMatch(
        /^fn_(engine_maintenance_|claim_engine_maintenance_|authorize_engine_maintenance_|ack_engine_maintenance_|close_tournament_entry_window$)/
      );
      const entries = Object.entries(args);
      entries.forEach(([key]) => expect(key).toMatch(/^p_[a-z_]+$/));
      try {
        const result = (
          await rpc.query(
            `SELECT public.${name}(${entries.map(([k], i) => k + '=>$' + (i + 1)).join(',')}) v`,
            entries.map(([, v]) => v)
          )
        ).rows[0].v;
        trace.push({ label, rpc: name, result });
        return { data: result, error: null };
      } catch (error: any) {
        return { data: null, error: { message: error.message } };
      }
    };
    vi.spyOn(maintenanceSupabase, 'rpc').mockImplementation(rpcBridge as never);
    if (supabase !== maintenanceSupabase)
      vi.spyOn(supabase, 'rpc').mockImplementation(rpcBridge as never);
    vi.spyOn(supabase, 'from').mockImplementation((table: unknown) => {
      expect(table).toBe('tournaments');
      let id: string,
        patch: any,
        projection = '';
      const execute = async () => {
        try {
          if (patch) {
            const fields = Object.entries(patch);
            fields.forEach(([key]) =>
              expect(key).toMatch(/^(on_break|break_ends_at|level_started_at)$/)
            );
            await rows.query(
              `UPDATE public.tournaments SET ${fields.map(([key], i) => key + '=$' + (i + 1)).join(',')} WHERE id=$${fields.length + 1}`,
              [...fields.map(([, value]) => value), id!]
            );
            writes.push({ ...patch });
            if (control.loseWriteReply) throw new Error('native committed response lost');
            return { data: null, error: null };
          }
          if (control.readFails) throw new Error('native readback unavailable');
          const columns = projection.split(',').map((name) => name.trim());
          columns.forEach((name) => expect(name).toMatch(/^[a-z][a-z_]*$/));
          const data = (
            await rows.query(
              `SELECT to_jsonb(t) data FROM (SELECT ${columns.join(',')} FROM public.tournaments WHERE id=$1) t`,
              [id!]
            )
          ).rows[0]?.data;
          await control.afterRow();
          trace.push({ label, row: data });
          return { data, error: null };
        } catch (error: any) {
          trace.push({ label, rowError: error.message });
          return { data: null, error: { message: error.message } };
        }
      };
      const query: any = {
        select: (columns: string) => {
          projection = columns;
          return query;
        },
        update: (value: any) => {
          patch = value;
          return query;
        },
        eq: (_key: string, value: string) => {
          id = value;
          return query;
        },
        maybeSingle: execute,
        then: (yes: any, no: any) => execute().then(yes, no),
      };
      return query;
    });
    const data = (
      await c.query('SELECT to_jsonb(t) data FROM public.tournaments t WHERE id=$1', [base.event])
    ).rows[0].data;
    class Harness extends Base {
      frames: any[] = [];
      requestEliminationSweep = vi.fn(() => true);
      constructor() {
        super(base.event, {});
      }
      protected async recalculateEliminatedPrizes() {
        return true;
      }
      protected async broadcast(event: string, payload: any) {
        this.frames.push({ event, payload });
        return true;
      }
      activate() {
        this.lifecycleEpoch.begin();
        this.running = true;
        this.currentLevel = data.current_level;
        this.tournamentCache = data;
        this.blindTimerStartedAt = Date.parse(data.level_started_at);
        this.onBreak = data.on_break;
        this.savedBlindTimerRemaining = 120000;
        for (const id of base.tables.slice(0, 2))
          this.tableEngines.set(id, { resumeDealing() {}, fenceForEngineLeaseLoss() {} });
      }
      clock() {
        return { anchor: this.blindTimerStartedAt, timer: this.blindTimer };
      }
    }
    const manager = new Harness();
    manager.activate();
    managers.push(manager);
    const store = createOperationMaintenanceStore('a'.repeat(40));
    let operation = (await store.loadOperation()).operation!;
    manager.adoptOperationMaintenance(operation);
    const proof = async (): Promise<OperationTournamentProof> => {
      operation = (await store.loadOperation(operation.intervalId)).operation!;
      return {
        state: operation,
        readback: async () => (await store.loadOperation(operation.intervalId)).operation!,
        isCurrent: () => true,
        now: () => Date.now(),
      };
    };
    const authorize = async () => {
      await store.reportOperationReady(operation, base.tables, [
        base.tables.slice(0, 2),
        base.tables.slice(2),
      ]);
      const ready = await fixture.current(c, held.s);
      await fixture.release(c, held.o, ready);
      operation = (await store.loadOperation(operation.intervalId)).operation!;
      await fixture.thaw(c, await fixture.current(c, held.s));
      const receipt = await store.releaseOperationWave(operation, 0, base.tables.slice(0, 2));
      await sleep(Math.max(0, receipt.creditedThroughAt - Date.now()) + 15);
      return receipt;
    };
    const ack = async (receipt: any) =>
      store.acknowledgeOperationWave(operation, 0, receipt.receiptId, receipt.tableIds, Date.now());
    return { c, base, manager, store, operation, proof, writes, control, authorize, ack };
  }
  it('adopts the actual committed wave suffix after a 16-minute hold with no manager anchor write', async () => {
    const x = await setup('wave');
    expect(x.manager.clock().timer).toBeNull();
    const receipt = await x.authorize();
    await expect(x.manager.resumeOperationClock(await x.proof())).rejects.toThrow(
      'wave_not_acknowledged'
    );
    await sleep(100);
    await x.ack(receipt);
    const exact = (
      await x.c.query('SELECT level_started_at FROM public.tournaments WHERE id=$1', [x.base.event])
    ).rows[0].level_started_at.getTime();
    x.control.readFails = true;
    await expect(x.manager.resumeOperationClock(await x.proof())).rejects.toThrow(
      'anchor_unreadable'
    );
    expect(x.manager.clock().timer).toBeNull();
    x.control.readFails = false;
    await x.manager.resumeOperationClock(await x.proof());
    expect(x.manager.clock().anchor).toBe(exact);
    expect(x.manager.clock().timer).not.toBeNull();
    expect(Date.now() - exact).toBeLessThan(12000); // Original 10s played, not the held 16 minutes.
    expect(x.writes).toEqual([]);
    await x.manager.resumeOperationClock(await x.proof());
    expect(x.writes).toEqual([]);
    trace.push({ case: 'wave', exact, now: Date.now(), writes: x.writes });
  }, 20000);
  it('refuses a real authority revocation between the clock row and strict operation readback', async () => {
    const x = await setup('revocation');
    const receipt = await x.authorize();
    await x.ack(receipt);
    const proof = await x.proof();
    x.control.afterRow = async () =>
      x.store.reportOperationRecovery(proof.state, 'native manager readback revocation');
    await expect(x.manager.resumeOperationClock(proof)).rejects.toThrow('readback_owner_changed');
    expect(x.manager.clock().timer).toBeNull();
    expect(x.writes).toEqual([]);
  }, 20000);
  it('writes an own-break clear and exact anchor atomically and reconciles a genuinely committed lost response', async () => {
    const x = await setup('ownbreak', true);
    const first = await x.authorize();
    await x.ack(first);
    await x.manager.resumeOperationClock(await x.proof());
    await x.manager.resumeFromBreak(); // The separate own break remains held globally.
    expect(x.manager.isOnBreak()).toBe(true);
    expect(x.writes).toEqual([]);
    let state = (await x.proof()).state;
    const second = await x.store.releaseOperationWave(state, 1, x.base.tables.slice(2));
    await sleep(Math.max(0, second.creditedThroughAt - Date.now()) + 15);
    await x.store.acknowledgeOperationWave(state, 1, second.receiptId, second.tableIds, Date.now());
    state = (await x.proof()).state;
    await until(async () => {
      state = await x.store.completeOperationResume(state, [first.receiptId, second.receiptId]);
      return state.phase === 'resumed';
    }, 'global certificate did not release');
    setMaintenanceFrozen(false);
    x.control.loseWriteReply = true;
    const started = Date.now();
    await x.manager.resumeOperationGlobal(await x.proof());
    const data = (
      await x.c.query('SELECT on_break,level_started_at FROM public.tournaments WHERE id=$1', [
        x.base.event,
      ])
    ).rows[0];
    expect(data.on_break).toBe(false);
    expect(x.writes).toHaveLength(1);
    expect(Object.keys(x.writes[0]).sort()).toEqual([
      'break_ends_at',
      'level_started_at',
      'on_break',
    ]);
    expect(data.level_started_at.getTime()).toBe(x.manager.clock().anchor);
    expect(data.level_started_at.getTime()).toBeGreaterThanOrEqual(started - 480000);
    expect(x.manager.frames.filter((f: any) => f.event === 'break_ended')).toHaveLength(1);
    await x.manager.resumeFromBreak();
    expect(x.writes).toHaveLength(1);
  }, 20000);
});
