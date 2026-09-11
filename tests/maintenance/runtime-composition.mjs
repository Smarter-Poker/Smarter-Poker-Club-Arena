// Socket-only native PG17 + unchanged production TypeScript composition.
// Physical engines are explicitly instrumented stand-ins. SQL, store parsing,
// runtime ownership, thaw client, reconnect credit and freeze modules are real.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import * as fixture from './runtime-fixture.mjs';
import { precisionCase } from './runtime-precision-case.mjs';
import { globalTailCases } from './runtime-global-tail-cases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const state = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.ok(
  state.socket.startsWith('/tmp/ca-e2-owned-') ||
    state.socket.startsWith('/private/tmp/ca-e2-owned-')
);
const evidence = resolve(process.argv[3]);
const source = resolve(
  process.env.CA_MAINTENANCE_RUNTIME_SOURCE ?? join(root, '../codex-pipeline-maintenance')
);
const require = createRequire(join(source, 'server/package.json'));
const ts = require('typescript');
const files = [
  'OperationMaintenanceRuntime.ts',
  'operationMaintenanceStore.ts',
  'operationPolicy.ts',
  'operationPolicy.json',
  'maintenanceThawV3.ts',
  'reconnectFreeze.ts',
  'freezeState.ts',
];
const original = new Map();
const hashes = {};
for (const name of files) {
  const p = join(source, 'server/src/maintenance', name);
  const bytes = await readFile(p);
  original.set(name, bytes);
  hashes[p] = createHash('sha256').update(bytes).digest('hex');
}
const localInputs = [
  'integration.mjs',
  'runtime-fixture.mjs',
  'runtime-composition.mjs',
  'runtime-precision-case.mjs',
  'runtime-global-tail-cases.mjs',
];
for (const name of localInputs) {
  const p = join(root, 'tests/maintenance', name);
  hashes[p] = createHash('sha256')
    .update(await readFile(p))
    .digest('hex');
}
await writeFile(
  join(evidence, 'runtime-inputs.json'),
  JSON.stringify({ node: process.version, typescript: ts.version, source, hashes }, null, 2)
);
const authority = join(evidence, 'authority');
await mkdir(authority, { recursive: true });
// Preserve the original 17-case source and receipt. Its final template contains
// only setup, never any test's activated operation, clocks or mutable state.
const bootstrap = await promisify(execFile)(
  process.execPath,
  [join(root, 'tests/maintenance/integration.mjs'), process.argv[2], authority],
  { maxBuffer: 8e6 }
);
await writeFile(join(authority, 'native.log'), bootstrap.stdout);
const authorityCases = JSON.parse(await readFile(join(authority, 'cases.json'), 'utf8'));
assert.equal(authorityCases.length, 17);
const management = await fixture.connect(state, 'postgres');
const cases = [];
let active;
const caseFilter = process.env.CA_MAINTENANCE_RUNTIME_CASES
  ? new RegExp(process.env.CA_MAINTENANCE_RUNTIME_CASES)
  : null;
const until = async (predicate, label, limit = 25000) => {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(30);
  }
  throw new Error('Timed out: ' + label);
};
const test = async (name, body) => {
  if (caseFilter && !caseFilter.test(name)) return;
  const start = Date.now();
  try {
    await body();
    cases.push({ name, status: 'passed', milliseconds: Date.now() - start });
  } catch (e) {
    cases.push({ name, status: 'failed', message: e.stack, milliseconds: Date.now() - start });
  } finally {
    if (active) {
      await active.close();
      active = null;
    }
    await writeFile(join(evidence, 'cases.json'), JSON.stringify(cases, null, 2));
  }
};

async function modules(label, bridge) {
  const dir = join(evidence, 'source', label),
    maintenance = join(dir, 'server/src/maintenance');
  await mkdir(maintenance, { recursive: true });
  await mkdir(join(dir, 'server/src/services/supabase'), { recursive: true });
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
  for (const [name, bytes] of original) {
    const content = name.endsWith('.json')
      ? bytes
      : ts.transpileModule(bytes.toString(), {
          fileName: name,
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            verbatimModuleSyntax: false,
          },
        }).outputText;
    await writeFile(join(maintenance, name.replace(/\.ts$/, '.js')), content);
  }
  const key = 'native-maintenance-transport:' + label;
  globalThis[Symbol.for(key)] = bridge;
  await writeFile(
    join(dir, 'server/src/services/supabase.js'),
    `const transport=globalThis[Symbol.for(${JSON.stringify(key)})];export const maintenanceSupabase=transport;export const supabase=transport;\n`
  );
  // DataActorContext is replaced only at the transport boundary. The dedicated
  // SQL connection has the actual service_role and JWT claims throughout.
  await writeFile(
    join(dir, 'server/src/services/supabase/dataActorContext.js'),
    'export const bindToProcessRoot=call=>call;\n'
  );
  const load = (name) => import(pathToFileURL(join(maintenance, name + '.js')).href);
  return {
    runtime: await load('OperationMaintenanceRuntime'),
    store: await load('operationMaintenanceStore'),
    thaw: await load('maintenanceThawV3'),
    freeze: await load('freezeState'),
    reconnect: await load('reconnectFreeze'),
  };
}

async function setup(label, { fault, afterRpc, waveGapMs = 180 } = {}) {
  const database = 'mt_runtime_' + label;
  await management.query('CREATE DATABASE ' + database + ' TEMPLATE maintenance_template');
  const c = await fixture.connect(state, database),
    rpc = await fixture.connect(state, database),
    listener = await fixture.connect(state, database);
  const base = await fixture.readBase(c);
  const trace = [],
    errors = [],
    engines = new Map();
  let runtime,
    mods,
    changed,
    subscribed = false,
    notificationPaused = false;
  const record = (kind, values = {}) => {
    const row = { sequence: trace.length, at: new Date().toISOString(), kind, ...values };
    trace.push(row);
    return row;
  };
  await rpc.query(
    `SET ROLE service_role;SET request.jwt.claim.role='service_role';SET request.jwt.claims='{"role":"service_role"}'`
  );
  const namedQuery = async (name, args) => {
    assert.match(
      name,
      /^fn_(engine_maintenance_|claim_engine_maintenance_|authorize_engine_maintenance_|ack_engine_maintenance_|thaw_platform$)/
    );
    const entries = Object.entries(args);
    for (const [key] of entries) assert.match(key, /^p_[a-z_]+$/);
    return (
      await rpc.query(
        `SELECT public.${name}(${entries.map(([k], i) => k + ' => $' + (i + 1)).join(',')}) v`,
        entries.map(([, v]) => v)
      )
    ).rows[0].v;
  };
  const bridge = {
    async rpc(name, args) {
      record('rpc_begin', { name, args });
      try {
        const override = await fault?.({
          name,
          args,
          query: () => namedQuery(name, args),
          rpc,
          c,
          record,
          runtime,
          engines,
          mods,
        });
        const data = override?.handled ? override.data : await namedQuery(name, args);
        record('rpc_commit', { name, data });
        await afterRpc?.({ name, args, data, c, record, runtime, engines, mods });
        return { data, error: null };
      } catch (error) {
        record('rpc_error', { name, error: error.message });
        return { data: null, error: { message: error.message } };
      }
    },
    channel(name) {
      assert.equal(name, 'engine-operation-maintenance');
      const channel = {
        on(type, filter, callback) {
          assert.equal(type, 'postgres_changes');
          assert.deepEqual(filter, {
            event: '*',
            schema: 'public',
            table: 'engine_maintenance_operation_signal',
          });
          changed = callback;
          return channel;
        },
        subscribe(callback) {
          void listener
            .query('LISTEN release_journal_events')
            .then(() => {
              subscribed = true;
              record('subscribed');
              callback('SUBSCRIBED');
            })
            .catch((e) => errors.push(e.message));
          return channel;
        },
      };
      return channel;
    },
    async removeChannel() {
      changed = null;
      await listener.query('UNLISTEN release_journal_events');
    },
  };
  listener.on('notification', (message) => {
    if (message.channel === 'release_journal_events' && message.payload === 'maintenance') {
      record('database_notification', { deliveryPaused: notificationPaused });
      if (!notificationPaused) changed?.();
    }
  });
  mods = await modules(label, bridge);
  for (const id of base.tables) {
    const clock = { reconnectGrantedAtMs: 0, reconnectDeadlineMs: 0 },
      expired = { reconnectGrantedAtMs: 0, reconnectDeadlineMs: 0 };
    const e = {
      paused: false,
      landed: true,
      pending: false,
      resumes: 0,
      pauses: 0,
      clock,
      expired,
      pauseForMaintenance(duration, interval) {
        this.paused = true;
        this.pauses++;
        record('physical_pause', { id, duration, interval });
      },
      isMaintenanceDrained() {
        return this.paused && this.landed && !this.pending;
      },
      retryMaintenancePresence() {
        record('presence_retry', { id });
      },
      resumeFromMaintenance() {
        this.paused = false;
        this.resumes++;
        mods.reconnect.thawTableReconnectClock(id, clock);
        mods.reconnect.thawTableReconnectClock(id, expired);
        record('physical_resume', {
          id,
          count: this.resumes,
          globalFrozen: mods.freeze.isMaintenanceFrozen(),
          tableFrozen: mods.freeze.isMaintenanceFrozenForTable(id),
          clock: { ...clock },
          expired: { ...expired },
        });
      },
    };
    engines.set(id, e);
  }
  const store = mods.store.createOperationMaintenanceStore(fixture.sha);
  const makeRuntime = () =>
    new mods.runtime.OperationMaintenanceRuntime({
      store,
      engines: () => engines,
      emit(id, payload) {
        record('frame', { id, payload });
      },
      report(error) {
        errors.push(String(error));
        record('runtime_error', { error: String(error) });
      },
      thaw(request, signal) {
        return mods.thaw.runMaintenanceThawV3(
          request,
          async (args) => {
            const r = await bridge.rpc('fn_thaw_platform', args);
            if (r.error) throw new Error(r.error.message);
            return r.data;
          },
          { signal, maxCalls: 30, pauseMs: 20 }
        );
      },
      planWaves(all) {
        const selected = new Map(all);
        return [base.tables.slice(0, 2).sort().reverse(), base.tables.slice(2)].map((w) =>
          w.map((id) => [id, selected.get(id)])
        );
      },
      waveGapMs,
      onActivated() {
        record('activated');
      },
    });
  runtime = makeRuntime();
  const x = {
    c,
    rpc,
    listener,
    base,
    trace,
    errors,
    engines,
    mods,
    runtime,
    store,
    record,
    pauseNotifications() {
      notificationPaused = true;
    },
    async restart() {
      await runtime.stop();
      runtime = makeRuntime();
      this.runtime = runtime;
      await runtime.start();
    },
    async snapshot() {
      return (
        await fixture.engine(c, 'fn_engine_maintenance_operation', [
          runtime.snapshot().operation?.intervalId ?? null,
        ])
      ).operation;
    },
    async start() {
      await runtime.start();
      await until(() => subscribed, 'subscription');
    },
    initializeClocks(s) {
      const start = Date.parse(s.freeze_started_at);
      for (const e of engines.values()) {
        Object.assign(e.clock, {
          reconnectGrantedAtMs: start - 1000,
          reconnectDeadlineMs: start + 20000,
        });
        Object.assign(e.expired, {
          reconnectGrantedAtMs: start - 100000,
          reconnectDeadlineMs: start - 1,
        });
      }
    },
    async close() {
      await runtime.stop();
      await writeFile(
        join(evidence, label + '-trace.json'),
        JSON.stringify({ trace, errors, snapshot: runtime.snapshot() }, null, 2)
      );
      await Promise.all([c, rpc, listener].map((client) => client.end()));
      mods.freeze.setMaintenanceFrozen(false);
    },
  };
  active = x;
  return x;
}

async function prepared(x, seconds = 960, { failReady = false } = {}) {
  await x.start();
  assert.equal(x.runtime.enabled(), false);
  const hold = await fixture.fixtureHold(x.c, {
    seconds,
    plan: false,
    historicalReady: seconds >= 1800,
  });
  x.initializeClocks(hold.s);
  if (seconds >= 1800) {
    // Local historical fixture was drained before its deadline. The real runtime
    // may adopt and report recovery, but cannot retroactively mint ready evidence.
    await until(
      () => x.runtime.snapshot().operation?.phase === 'recovery_required',
      'deadline reports recovery'
    );
  } else
    await until(
      async () => (await x.snapshot())?.phase === 'ready',
      'durable runtime readiness',
      failReady ? 15000 : 8000
    );
  const s = await x.snapshot();
  assert.equal(s.generation, 2);
  assert.equal(Date.parse(s.freeze_started_at), Date.parse(hold.s.freeze_started_at));
  assert.equal(
    x.trace.filter(
      (t) => t.kind === 'rpc_commit' && t.name === 'fn_claim_engine_maintenance_operation'
    ).length,
    1
  );
  assert.ok(x.trace.some((t) => t.kind === 'database_notification'));
  assert.deepEqual(
    [...x.engines.values()].map((e) => e.resumes),
    [0, 0, 0]
  );
  assert.equal(x.mods.freeze.isMaintenanceFrozen(), true);
  return { ...hold, s };
}

try {
  for (const seconds of [960, 1800])
    await test(`real_runtime_${seconds}s_notification_claim_ready_waves_clocks`, async () => {
      const observations = [];
      const x = await setup('clock_' + seconds, {
        afterRpc: async (h) => {
          if (h.name !== 'fn_ack_engine_maintenance_wave') return;
          const views = await Promise.all(
            [x.base.tables[0], x.base.tables[2], null].map((id) =>
              fixture.call(x.c, 'public.fn_maintenance_break_state_v2', [id, h.args.p_interval_id])
            )
          );
          const wave = h.data.operation.resume_waves[h.args.p_wave_index];
          assert.ok(wave.resumed_at);
          assert.equal(views[h.args.p_wave_index === 0 ? 0 : 1].active, false);
          assert.equal(views[2].active, true);
          if (h.args.p_wave_index === 0) {
            assert.equal(views[1].active, true);
            assert.equal(x.engines.get(x.base.tables[2]).resumes, 0);
            assert.equal(x.mods.freeze.isMaintenanceFrozenForTable(x.base.tables[2]), true);
          }
          observations.push({
            index: h.args.p_wave_index,
            views,
            wave,
            clocks: await fixture.clockReceipt(x.c, currentHold.s, clockFixture),
          });
        },
      });
      let currentHold = await prepared(x, seconds);
      const clockFixture = await fixture.seedClocks(x.c, currentHold.s);
      assert.equal(
        (
          await fixture.call(x.c, 'public.fn_maintenance_break_state_v2', [
            x.base.tables[0],
            currentHold.s.interval_id,
          ])
        ).active,
        true
      );
      currentHold.s = (await fixture.release(x.c, currentHold.o, currentHold.s)).s;
      await until(
        () => x.runtime.snapshot().operation?.phase === 'resumed',
        'full actual runtime resume',
        40000
      );
      assert.deepEqual(
        [...x.engines.values()].map((e) => e.resumes),
        [1, 1, 1]
      );
      assert.deepEqual(x.errors, []);
      assert.equal(x.mods.freeze.isMaintenanceFrozen(), false);
      assert.equal(observations.length, 2);
      const done = await x.snapshot(),
        final = await fixture.clockReceipt(x.c, currentHold.s, clockFixture);
      assert.equal(new Set(final.targets.map((t) => t.step)).size, 14);
      assert.equal(
        final.level,
        observations[0].clocks.level,
        'Tournament clock stays at its own acknowledged wave'
      );
      assert.equal(
        Date.parse(final.level) - Date.parse(clockFixture.before),
        Date.parse(done.resume_waves[0].resumed_at) - Date.parse(done.freeze_started_at)
      );
      assert.equal(
        Date.parse(final.seat) - Date.parse(clockFixture.before),
        Date.parse(done.resume_waves[1].resumed_at) - Date.parse(done.freeze_started_at)
      );
      for (const [id, e] of x.engines) {
        const wave = done.resume_waves.find((w) => w.table_ids.includes(id));
        assert.equal(e.clock.reconnectThawedAtMs, Date.parse(wave.resumed_at));
        assert.ok(
          e.clock.reconnectDeadlineMs >= Date.parse(done.freeze_started_at) + 20000 + seconds * 1000
        );
        assert.equal(e.expired.reconnectDeadlineMs, Date.parse(done.freeze_started_at) - 1);
      }
      const begin = x.trace.findIndex(
        (t) => t.kind === 'rpc_commit' && t.name === 'fn_claim_engine_maintenance_operation'
      );
      const resume = x.trace.filter((t) => t.kind === 'physical_resume');
      assert.ok(resume.every((t) => t.sequence > begin && t.globalFrozen && !t.tableFrozen));
      for (const r of resume) {
        const wave = done.resume_waves.find((w) => w.table_ids.includes(r.id));
        const ack = x.trace.find(
          (t) =>
            t.kind === 'rpc_commit' &&
            t.name === 'fn_ack_engine_maintenance_wave' &&
            t.data.operation.resume_waves[wave.index].resumed_at
        );
        const ended = x.trace.find(
          (t) => t.kind === 'frame' && t.id === r.id && t.payload.type === 'MAINTENANCE_BREAK_ENDED'
        );
        assert.ok(ack.sequence > r.sequence && ended.sequence > ack.sequence);
      }
      await x.runtime.refresh();
      assert.deepEqual(
        [...x.engines.values()].map((e) => e.resumes),
        [1, 1, 1]
      );
      await writeFile(
        join(evidence, 'runtime-clock-' + seconds + '.json'),
        JSON.stringify(
          {
            done,
            observations,
            final,
            limits:
              'Instrumented synchronous engine pause/resume; actual SQL, TS runtime/store/v3/reconnect/freeze modules.',
          },
          null,
          2
        )
      );
    });
  await test('failed_ready_sql_transaction_retries_same_owner', async () => {
    let failed = false;
    const x = await setup('ready_retry', {
      fault: async (h) => {
        if (h.name === 'fn_engine_maintenance_ready' && !failed) {
          failed = true;
          await h.rpc.query('BEGIN');
          try {
            await h.query();
          } finally {
            await h.rpc.query('ROLLBACK');
          }
          throw new Error('native injected failed readiness transaction');
        }
      },
    });
    const hold = await prepared(x, 960, { failReady: true });
    assert.ok(hold.s.ready_at ?? x.runtime.readyForRestart());
    assert.equal(
      x.trace.filter((t) => t.kind === 'rpc_begin' && t.name === 'fn_engine_maintenance_ready')
        .length,
      2
    );
    assert.equal(x.runtime.readyForRestart(), true);
    assert.equal(
      (
        await fixture.one(
          x.c,
          "SELECT count(*)::int n FROM release_ops.maintenance_events WHERE kind='ENGINE_READY'"
        )
      ).n,
      1
    );
  });
  await test('revoked_release_before_boundary_never_physically_resumes', async () => {
    let revoked = false;
    const x = await setup('revoked', {
      afterRpc: async (h) => {
        if (h.name === 'fn_thaw_platform' && h.data.complete && !revoked) {
          revoked = true;
          await fixture.engine(h.c, 'fn_engine_maintenance_recovery', [
            h.args.p_announced_at ? x.runtime.snapshot().operation.intervalId : null,
            h.args.p_ownership_token,
            'native release revoked',
          ]);
          await until(
            () => x.runtime.snapshot().operation?.phase === 'recovering',
            'revocation notification'
          );
        }
      },
    });
    const hold = await prepared(x);
    await fixture.seedClocks(x.c, hold.s);
    await fixture.release(x.c, hold.o, hold.s);
    await until(() => revoked, 'real thaw complete before pending boundary', 25000);
    await sleep(5500);
    assert.deepEqual(
      [...x.engines.values()].map((e) => e.resumes),
      [0, 0, 0]
    );
    assert.equal(x.runtime.active(), true);
    assert.equal(x.mods.freeze.isMaintenanceFrozen(), true);
    assert.equal(
      x.trace.filter((t) => t.kind === 'frame' && t.payload.type === 'MAINTENANCE_BREAK_ENDED')
        .length,
      0
    );
  });
  await test('uncertain_wave_ack_preserves_hold_and_never_duplicates_resume', async () => {
    let failed = false;
    const x = await setup('unknown', {
      fault: async (h) => {
        if (h.name === 'fn_ack_engine_maintenance_wave' && !failed) {
          failed = true;
          await h.rpc.query('BEGIN');
          try {
            await h.query();
          } finally {
            await h.rpc.query('ROLLBACK');
          }
          throw new Error('native injected unknown wave acknowledgment');
        }
      },
    });
    const hold = await prepared(x);
    await fixture.seedClocks(x.c, hold.s);
    await fixture.release(x.c, hold.o, hold.s);
    await until(() => x.runtime.snapshot().releaseInDoubt, 'unknown physical outcome');
    const counts = [...x.engines.values()].map((e) => e.resumes);
    assert.deepEqual(counts, [1, 1, 0]);
    await x.runtime.refresh();
    await x.runtime.refresh();
    await sleep(300);
    assert.deepEqual(
      [...x.engines.values()].map((e) => e.resumes),
      counts
    );
    const s = await x.snapshot();
    assert.equal(s.resume_waves[0].resumed_at, null);
    assert.ok(s.resume_waves[0].receipt_id);
    assert.equal(
      (
        await fixture.call(x.c, 'public.fn_maintenance_break_state_v2', [
          x.base.tables[0],
          s.interval_id,
        ])
      ).active,
      true
    );
    assert.equal(
      x.trace.filter((t) => t.kind === 'frame' && t.payload.type === 'MAINTENANCE_BREAK_ENDED')
        .length,
      0
    );
    assert.equal(x.mods.freeze.isMaintenanceFrozen(), true);
  });
  await test('sql_suffix_refusal_cannot_emit_ended_or_clear_global_hold', async () => {
    let injected = false;
    const x = await setup('suffix_refusal', {
      afterRpc: async (h) => {
        if (
          h.name === 'fn_authorize_engine_maintenance_wave' &&
          h.data.operation.resume_waves[0].receipt_id
        )
          await sleep(
            Math.max(
              0,
              Date.parse(h.data.operation.resume_waves[0].credited_through_at) - Date.now()
            ) + 30
          );
      },
      fault: async (h) => {
        if (h.name === 'fn_ack_engine_maintenance_wave' && !injected) {
          injected = true;
          // This fixture trigger produces an actual native credit-worker exception.
          // The production ACK catches it and returns a durable recovery snapshot.
          await h.c.query(
            "CREATE FUNCTION pg_temp.native_suffix_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'native suffix write unavailable'; END $$; CREATE TRIGGER native_suffix_refusal BEFORE UPDATE ON public.engine_maintenance_thaw_targets FOR EACH ROW EXECUTE FUNCTION pg_temp.native_suffix_refusal()"
          );
        }
      },
    });
    const hold = await prepared(x);
    await fixture.seedClocks(x.c, hold.s);
    await fixture.release(x.c, hold.o, hold.s);
    await until(
      () =>
        x.trace.some((t) => t.kind === 'rpc_commit' && t.name === 'fn_ack_engine_maintenance_wave'),
      'actual SQL suffix refusal',
      30000
    );
    await sleep(500);
    const response = x.trace.find(
      (t) => t.kind === 'rpc_commit' && t.name === 'fn_ack_engine_maintenance_wave'
    ).data;
    assert.equal(response.operation.phase, 'recovery_required');
    assert.equal(response.operation.resume_waves[0].resumed_at, null);
    assert.equal(
      (
        await fixture.call(x.c, 'public.fn_maintenance_break_state_v2', [
          x.base.tables[0],
          hold.s.interval_id,
        ])
      ).active,
      true
    );
    assert.equal(
      x.trace.filter((t) => t.kind === 'frame' && t.payload.type === 'MAINTENANCE_BREAK_ENDED')
        .length,
      0,
      'A returned SQL recovery snapshot is not a successful ACK'
    );
    assert.equal(x.mods.freeze.isMaintenanceFrozen(), true);
  });
  await test('fractional_database_checkpoint_refuses_truncated_ack_then_credits_actual_resume', () =>
    precisionCase({ setup, prepared, until, evidence }));
  await test('revoked_native_authorization_readback_refuses_resume_without_notification', async () => {
    let injected = false;
    const x = await setup('authorization_revoked', {
      fault: async (h) => {
        if (h.name === 'fn_authorize_engine_maintenance_wave' && !injected) {
          injected = true;
          const first = await h.query();
          assert.ok(first.operation.resume_waves[0].receipt_id);
          // A delayed realtime hint cannot turn a recovering durable readback into
          // physical permission. Both responses come from the actual same SQL RPC.
          x.pauseNotifications();
          await fixture.engine(h.c, 'fn_engine_maintenance_recovery', [
            h.args.p_interval_id,
            h.args.p_ownership_token,
            'native authority revoked before resume',
          ]);
          const data = await h.query();
          assert.equal(data.operation.phase, 'recovering');
          return { handled: true, data };
        }
      },
    });
    const hold = await prepared(x);
    await fixture.seedClocks(x.c, hold.s);
    await fixture.release(x.c, hold.o, hold.s);
    await until(
      () => x.runtime.snapshot().releaseInDoubt,
      'unauthorized response refused before physical action',
      25000
    );
    assert.deepEqual(
      [...x.engines.values()].map((e) => e.resumes),
      [0, 0, 0]
    );
    assert.equal(
      x.trace.filter((t) => t.kind === 'rpc_begin' && t.name === 'fn_ack_engine_maintenance_wave')
        .length,
      0
    );
    assert.ok(x.errors.some((e) => e.includes('maintenance_wave_authorization_incomplete')));
    assert.equal(x.mods.freeze.isMaintenanceFrozen(), true);
  });
  await test('native_store_future_ack_retries_one_captured_physical_boundary', async () => {
    let captured = 0,
      observedFutureRefusal = false;
    const x = await setup('future_ack', {
      fault: async (h) => {
        if (h.name !== 'fn_ack_engine_maintenance_wave' || observedFutureRefusal) return;
        try {
          const data = await h.query();
          return { handled: true, data };
        } catch (error) {
          assert.equal(error.message, 'MAINTENANCE_ACTUAL_RESUME_TIME_IN_FUTURE');
          observedFutureRefusal = true;
          h.record('native_future_refusal_before_delivery', { captured });
          // Delay delivery of this real pre-write refusal until the captured
          // clock boundary. The retry still carries the identical timestamp.
          await sleep(Math.max(1, captured - Date.now() + 1));
          throw error;
        }
      },
    });
    const h = await fixture.fixtureHold(x.c, { seconds: 960 });
    await fixture.seedClocks(x.c, h.s);
    h.s = (await fixture.release(x.c, h.o, h.s)).s;
    const base = await fixture.thaw(x.c, h.s);
    await sleep(Math.max(0, Date.parse(base.credited_through_at) - Date.now() + 10));
    const snapshot = await fixture.engine(x.c, 'fn_authorize_engine_maintenance_wave', [
      h.s.interval_id,
      h.s.ownership_token,
      0,
      x.base.tables.slice(0, 2),
    ]);
    const wave = snapshot.operation.resume_waves[0];
    await sleep(Math.max(0, Date.parse(wave.credited_through_at) - Date.now() + 10));
    // A controlled 1s clock skew makes the real SQL pre-write refusal observable
    // despite native query setup latency. This is a Store boundary fixture;
    // physical engines are instrumented and no production clock is replaced.
    captured = Date.now() + 1000;
    for (const id of wave.table_ids) x.engines.get(id).resumeFromMaintenance();
    await x.store.acknowledgeOperationWave(
      x.mods.store.parseOperationSnapshot(snapshot).operation,
      0,
      wave.receipt_id,
      wave.table_ids,
      captured
    );
    const attempts = x.trace.filter(
      (t) => t.kind === 'rpc_begin' && t.name === 'fn_ack_engine_maintenance_wave'
    );
    assert.equal(observedFutureRefusal, true);
    assert.equal(attempts.length, 2);
    assert.equal(new Set(attempts.map((t) => JSON.stringify(t.args))).size, 1);
    assert.ok(
      x.trace.some(
        (t) => t.kind === 'rpc_error' && t.error === 'MAINTENANCE_ACTUAL_RESUME_TIME_IN_FUTURE'
      )
    );
    const accepted = x.trace.find(
      (t) => t.kind === 'rpc_commit' && t.name === 'fn_ack_engine_maintenance_wave'
    );
    assert.equal(Date.parse(accepted.data.operation.resume_waves[0].resumed_at), captured);
    assert.deepEqual(
      [...x.engines.values()].map((e) => e.resumes),
      [1, 1, 0]
    );
  });
  await globalTailCases({ test, setup, prepared, until, evidence });
} finally {
  if (active) await active.close();
  await management.end();
  for (const [p, expected] of Object.entries(hashes))
    assert.equal(
      createHash('sha256')
        .update(await readFile(p))
        .digest('hex'),
      expected,
      'Proof input changed: ' + p
    );
  await writeFile(
    join(evidence, 'runtime-receipt.json'),
    JSON.stringify(
      {
        authorityCases,
        runtimeCases: cases,
        caseFilter: caseFilter?.source ?? null,
        hashes,
        limits: [
          'Socket-only PostgreSQL, not PostgREST/Supabase Realtime transport',
          'Instrumented engine pause/resume, not whole GameServer',
          'Historical clock rows are explicit fixture setup; actual authorities apply every credit',
        ],
      },
      null,
      2
    )
  );
}
console.log(JSON.stringify(cases));
assert.ok(
  cases.every((c) => c.status === 'passed'),
  'Native runtime composition has failed cases'
);
