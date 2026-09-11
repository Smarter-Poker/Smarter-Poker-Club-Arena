import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../operations/release/package.json', import.meta.url));
const { Client } = require('pg');
const state = JSON.parse(await readFile(process.argv[2], 'utf8'));
const evidence = process.argv[3];
const settings = {
  host: state.socket,
  port: state.port,
  database: state.database,
  user: 'postgres',
};
const admin = new Client(settings);
await admin.connect();
const clients = [admin];
const client = async (database = state.database) => {
  const c = new Client({ ...settings, database });
  await c.connect();
  clients.push(c);
  return c;
};
const results = [];
const digest = '1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda';
const call = async (c, name, args = []) =>
  (await c.query(`SELECT ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) v`, args)).rows[0]
    .v;
const as = async (c, role, body) => {
  await c.query('SET ROLE ' + role);
  try {
    return await body();
  } finally {
    await c.query('RESET ROLE');
  }
};
const test = async (name, body) => {
  const begin = Date.now();
  try {
    await body();
  } catch (e) {
    e.message = name + ': ' + e.message;
    throw e;
  }
  results.push({ name, status: 'passed', milliseconds: Date.now() - begin });
  await writeFile(evidence + '/cases.json', JSON.stringify(results, null, 2));
};
const clone = async (name) => {
  await admin.query(`CREATE DATABASE ${name} TEMPLATE maintenance_template`);
  return client(name);
};
const one = async (c, q, args = []) => (await c.query(q, args)).rows[0];
const actor = 'native-maintenance-proof';
const sha = 'a'.repeat(40),
  manifest = { components: [{ target: 'club-arena-engine', compatibility: 'expand' }] };
const components = Object.fromEntries(
  ['database', 'engine', 'client', 'controller', 'host_cutover', 'retained_recovery'].map((x) => [
    x,
    {
      policy_version: 2,
      policy_digest: digest,
      artifact_digest: 'b'.repeat(64),
      receipt_refs: ['native-fixture:' + x],
    },
  ])
);
components.host_cutover.principal = 'maintenance_native_actuator';
const compatibilityEvidence = {
  forward_verified: true,
  retained_recovery_verified: true,
  long_hold_clock_verified: true,
  resume_waves_verified: true,
};
let base;
async function owner(c) {
  const o = await call(c, 'release_ops.acquire_owner', [randomUUID(), actor]);
  await c.query('UPDATE release_ops.controller SET reconciliation_required=false');
  return o;
}
async function activation(c, o) {
  return as(c, 'release_journal_controller', () =>
    call(c, 'release_ops.activate_operation_maintenance', [
      o.owner_id,
      o.epoch,
      base.compatibility,
      actor,
    ])
  );
}
async function need(c) {
  return as(c, 'release_journal_verifier', () =>
    call(c, 'release_ops.register_engine_maintenance_need', [
      base.release,
      base.ready,
      base.plan,
      {
        purpose: 'engine_replacement',
        policy_digest: digest,
        scope: { type: 'platform' },
        receipt_refs: ['native-qualified-need'],
        actual_recovery_ms: 150000,
        recovery_margin_ms: 10000,
      },
      actor,
    ])
  );
}
async function admission(c, o, n) {
  return as(c, 'release_journal_controller', () =>
    call(c, 'release_ops.admit_engine_maintenance', [
      o.owner_id,
      o.epoch,
      base.release,
      n,
      150000,
      150000,
      10000,
      actor,
    ])
  );
}
const engine = (c, name, args) => as(c, 'service_role', () => call(c, 'public.' + name, args));
async function ready(c, s, groups) {
  const ids = groups.flat();
  return engine(c, 'fn_engine_maintenance_ready', [
    s.interval_id,
    s.ownership_token,
    ids,
    {
      policy_version: 2,
      policy_digest: digest,
      runtime_version: sha,
      between_hands: true,
      parked: true,
      pending_mutations: 0,
      resume_wave_table_ids: groups,
    },
  ]);
}
async function current(c, s) {
  return (await engine(c, 'fn_engine_maintenance_operation', [s.interval_id])).operation;
}
async function fixtureHold(c, { seconds = 0, phase = 'last_hand', plan = true } = {}) {
  const o = await owner(c);
  await activation(c, o);
  const n = await need(c);
  // Fixture administrator constructs a previously admitted historical hold. The
  // tested RPCs never accept a caller freeze time; normal admission is tested separately.
  const { rows } = await c.query(
    `INSERT INTO release_ops.maintenance_operations(release_id,need_receipt,activation_receipt,controller_owner,controller_epoch,phase,scope,freeze_started_at,target_at,forward_deadline_at,deadline_at,reason,declared_by)
 SELECT $1,$2,$3,$4,$5,$6,'{"type":"platform"}',t,t+interval '300seconds',t+interval '1200seconds',t+interval '1800seconds','Engine maintenance',$7 FROM (SELECT date_trunc('milliseconds',clock_timestamp())-make_interval(secs=>$8) t) x RETURNING *`,
    [base.release, n, base.compatibility, o.owner_id, o.epoch, phase, actor, seconds]
  );
  let s = rows[0];
  await c.query(
    'INSERT INTO release_ops.maintenance_tables SELECT $1,id,tournament_id FROM public.tables WHERE id=ANY($2::uuid[])',
    [s.interval_id, base.tables]
  );
  await c.query('BEGIN');
  await call(c, 'release_ops.maintenance_permit', [s.interval_id, true]);
  await c.query(
    `INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,reason,declared_by,enforce_freeze,ownership_token) VALUES(true,'counting_down',$1,$1,$2,'Engine maintenance',$3,true,$4)`,
    [s.freeze_started_at, s.target_at, actor, s.ownership_token]
  );
  await call(c, 'release_ops.maintenance_permit', [s.interval_id, false]);
  await c.query('COMMIT');
  if (plan) {
    s = (await ready(c, s, [base.tables.slice(0, 2), base.tables.slice(2)])).operation;
  }
  return { o, n, s };
}
async function publication(c, s) {
  const e = randomUUID(),
    ev = await call(c, 'release_ops.event', [base.release, 'NATIVE_PUBLISH_PROOF', actor, {}]);
  const intent = {
    target: 'club-arena-engine',
    manifest_digest: base.manifest_digest,
    provider_request: base.request,
    plan_id: base.plan,
    installation_id: base.installation,
  };
  const result = {
    terminal: true,
    outcome: 'SUCCEEDED',
    provider: 'hetzner-engine',
    operation_id: e,
    manifest_digest: base.manifest_digest,
    run_key: base.request.run_key,
    source_sha: sha,
    control_sha: sha,
    image_id: base.request.artifact_image_id,
    result: 'sealed',
    receipt_refs: ['native:' + ev],
  };
  await c.query(
    `INSERT INTO release_ops.external_operations(id,release_id,operation_key,owner_id,epoch,kind,intent,intent_event,resume_state,status,result,terminal_event)
 SELECT $1,$2,$3,owner_id,epoch,'PUBLISH',$4,$5,'APPLYING','SUCCEEDED',$6,$5 FROM release_ops.controller WHERE singleton`,
    [e, base.release, 'publish:' + e, intent, ev, result]
  );
  const proof = {
    policy_digest: digest,
    source_sha: sha,
    image_id: base.request.artifact_image_id,
    readiness_event: base.ready,
    schema_compatible: true,
    retained_recovery_compatible: true,
    checks: Object.fromEntries(
      [
        'native_seal',
        'local_runtime',
        'public_runtime',
        'database_leader',
        'retired_writers',
        'schema',
        'retained_recovery',
      ].map((k) => [k, ['native:' + k]])
    ),
  };
  const receipt = await as(c, 'release_journal_verifier', () =>
    call(c, 'release_ops.register_maintenance_safe_resume', [s.operation_id, e, proof, actor])
  );
  return { e, receipt, proof };
}
async function release(c, o, s) {
  const p = await publication(c, s);
  return {
    p,
    s: (
      await as(c, 'release_journal_controller', () =>
        call(c, 'release_ops.authorize_maintenance_release', [
          o.owner_id,
          o.epoch,
          s.operation_id,
          p.receipt,
          actor,
        ])
      )
    ).operation,
  };
}
async function thaw(c, s) {
  let result;
  for (let i = 0; i < 20; i++) {
    result = await engine(c, 'fn_thaw_platform', [
      s.freeze_started_at,
      s.freeze_started_at,
      1,
      s.ownership_token,
      actor,
    ]);
    if (result.complete) return result;
  }
  throw new Error('Thaw did not complete: ' + JSON.stringify(result));
}
try {
  await test('native_support_installs_inactive', async () => {
    const r = await one(
      admin,
      'SELECT public.fn_engine_maintenance_operation() v,public.fn_maintenance_break_state_v2() b'
    );
    assert.equal(r.v.policy_version, 1);
    assert.equal(r.v.operation, null);
    assert.equal(r.b.activation_receipt, null);
  });
  // Native fixture journal establishes an installed-adapter receipt without
  // pretending to install a real provider. Role-checked maintenance APIs begin below.
  const o = await owner(admin);
  const initialAdmission = await call(admin, 'release_ops.enqueue', [
    'maintenance-native',
    {
      repository: 'Smarter-Poker/Smarter-Poker-Club-Arena',
      project: 'engine-01',
      target: 'club-arena-engine',
      head_sha: sha,
      purpose: 'release',
      manifest,
      dependencies: [],
    },
    actor,
  ]);
  const releaseId = initialAdmission.id;
  const ev = await call(admin, 'release_ops.event', [
    releaseId,
    'NATIVE_PREPARED_RELEASE',
    actor,
    {},
  ]);
  const installation = randomUUID();
  await admin.query(
    'INSERT INTO release_ops.provider_installations(id,bundle_digest,binding,evidence,principal,event_id) VALUES($1,$2,$3,$4,$5,$6)',
    [installation, 'a'.repeat(64), { policy_digest: digest }, { native_fixture: true }, actor, ev]
  );
  await admin.query(
    `UPDATE release_ops.controller SET execution_enabled=true,installed_adapter_receipt=$1,active_release=$2,reconciliation_required=false`,
    [installation, releaseId]
  );
  const build = await call(admin, 'release_ops.event', [releaseId, 'NATIVE_BUILD', actor, {}]);
  const readyEvent = await call(admin, 'release_ops.event', [releaseId, 'NATIVE_READY', actor, {}]);
  const request = {
    target: 'club-arena-engine',
    manifest_digest: initialAdmission.manifest_digest,
    source_sha: sha,
    control_sha: sha,
    run_key: 'native-001',
    server_tree_sha: sha,
    artifact_image_id: 'sha256:' + 'c'.repeat(64),
    actor,
    not_after_epoch: Math.floor(Date.now() / 1000) + 3600,
    expected_current: { source_sha: 'd'.repeat(40), image_id: 'sha256:' + 'e'.repeat(64) },
  };
  const buildData = {
    source_sha: sha,
    artifact: { components: { 'club-arena-engine': { identity: request.artifact_image_id } } },
  };
  const readyData = { provider_requests: { 'hetzner-intake': request } };
  await admin.query(
    `INSERT INTO release_ops.receipts VALUES($1,'build','BUILD',$2,$3,NULL),($1,'ready','READINESS',$4,$5,NULL)`,
    [releaseId, buildData, build, readyData, readyEvent]
  );
  await admin.query(
    `UPDATE release_ops.queue SET state='APPLYING',selected_receipts=$1,attempt_deadline=clock_timestamp()+interval '6hours',owner_id=$2,epoch=$3 WHERE release_id=$4`,
    [{ BUILD: build, READINESS: readyEvent }, o.owner_id, o.epoch, releaseId]
  );
  const plan = await call(admin, 'release_ops.submit_provider_plan', [
    releaseId,
    'native-engine-plan',
    'hetzner-intake',
    request,
    actor,
  ]);
  await admin.query(
    'CREATE ROLE maintenance_native_actuator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;GRANT release_journal_actuator TO maintenance_native_actuator'
  );
  const compatibility = await as(admin, 'release_journal_verifier', () =>
    call(admin, 'release_ops.register_maintenance_compatibility', [
      installation,
      components,
      compatibilityEvidence,
      actor,
    ])
  );
  const event = (await one(admin, 'SELECT id FROM public.tournaments LIMIT 1')).id;
  const table = (await one(admin, 'SELECT to_jsonb(t) v FROM public.tables t LIMIT 1')).v;
  const tables = [randomUUID(), randomUUID(), randomUUID()];
  await admin.query('BEGIN;SET LOCAL session_replication_role=replica;');
  const columns = (
    await admin.query(
      "SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) names FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attnum>0 AND NOT attisdropped AND attgenerated=''"
    )
  ).rows[0].names;
  for (let i = 0; i < tables.length; i++) {
    const row = {
      ...table,
      id: tables[i],
      name: 'Native maintenance ' + i,
      tournament_id: i < 2 ? event : null,
      club_id: i < 2 ? table.club_id : null,
      game_type: i < 2 ? 'tournament' : 'cash',
      status: 'running',
      lifecycle: 'live',
      terminal_closed_at: null,
      seat_game_scope: null,
      seat_admission_key: null,
    };
    await admin.query(
      `INSERT INTO public.tables(${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::public.tables,$1)`,
      [row]
    );
  }
  await admin.query('COMMIT');
  base = {
    release: releaseId,
    manifest_digest: initialAdmission.manifest_digest,
    ready: readyEvent,
    build,
    plan: plan.id,
    request,
    installation,
    compatibility,
    tables,
    event,
  };
  await admin.query('SELECT pg_advisory_unlock_all()');
  await admin.end();
  clients.splice(clients.indexOf(admin), 1);
  const management = await client('postgres');
  await management.query('CREATE DATABASE maintenance_template TEMPLATE ' + state.database);
  // clone() only needs the independent management connection.
  admin.query = management.query.bind(management);
  await test('six_component_activation_requires_retained_recovery', async () => {
    const c = await clone('mt_activation');
    const o = await owner(c);
    const missing = { ...components };
    delete missing.retained_recovery;
    await assert.rejects(
      as(c, 'release_journal_verifier', () =>
        call(c, 'release_ops.register_maintenance_compatibility', [
          installation,
          missing,
          compatibilityEvidence,
          actor,
        ])
      ),
      /COMPATIBILITY_PROOF_REQUIRED/
    );
    await assert.rejects(
      as(c, 'service_role', () =>
        call(c, 'release_ops.activate_operation_maintenance', [
          o.owner_id,
          o.epoch,
          compatibility,
          actor,
        ])
      ),
      /permission denied/
    );
    const a = await activation(c, o);
    assert.equal(a.policy_version, 2);
    assert.equal(a.activation_receipt, compatibility);
    const b = await as(c, 'anon', () => call(c, 'public.fn_maintenance_break_state_v2'));
    assert.equal(b.policy_version, 2);
    assert.equal(b.active, false);
    assert.equal(b.activation_receipt, compatibility);
  });
  await test('native_admission_db_clock_exact_and_legacy_writers_refused', async () => {
    const c = await clone('mt_admit'),
      o = await owner(c);
    await activation(c, o);
    const n = await need(c);
    const r = await admission(c, o, n);
    const s = r.operation;
    assert.equal(Date.parse(s.target_at) - Date.parse(s.freeze_started_at), 300000);
    assert.equal(Date.parse(s.deadline_at) - Date.parse(s.freeze_started_at), 1800000);
    assert.ok(Date.now() - Date.parse(s.freeze_started_at) < 3000);
    assert.deepEqual(s.resume_waves, []);
    assert.equal((await admission(c, o, n)).operation.interval_id, s.interval_id);
    await assert.rejects(
      engine(c, 'fn_clear_engine_maintenance_break', [
        'counting_down',
        s.freeze_started_at,
        s.freeze_started_at,
        s.target_at,
        'Engine maintenance',
        s.ownership_token,
      ]),
      /REQUIRES_OPERATION_AUTHORITY/
    );
    await assert.rejects(
      c.query("UPDATE public.engine_maintenance_break SET reason='forged'"),
      /ROW_OWNED/
    );
    await assert.rejects(
      c.query('UPDATE release_ops.controller SET active_release=NULL'),
      /ACTIVE_RELEASE_CANNOT_BE_REPLACED/
    );
    await assert.rejects(
      c.query(
        "UPDATE release_ops.maintenance_operations SET freeze_started_at=freeze_started_at+interval '1second',target_at=target_at+interval '1second',forward_deadline_at=forward_deadline_at+interval '1second',deadline_at=deadline_at+interval '1second'"
      ),
      /IDENTITY_IMMUTABLE/
    );
    assert.equal((await one(c, 'SELECT public.fn_platform_frozen() v')).v, true);
  });
  await test('concurrent_engine_adoption_has_one_winner_and_old_token_fails', async () => {
    const c = await clone('mt_adopt');
    const { s } = await fixtureHold(c);
    const other = await client('mt_adopt');
    const answers = await Promise.allSettled(
      [c, other].map((x) =>
        engine(x, 'fn_claim_engine_maintenance_operation', [
          s.interval_id,
          s.ownership_token,
          randomUUID(),
          actor,
        ])
      )
    );
    assert.equal(answers.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(answers.filter((x) => x.status === 'rejected').length, 1);
    const now = await current(c, s);
    assert.equal(now.generation, 2);
    assert.equal(Date.parse(now.freeze_started_at), Date.parse(s.freeze_started_at));
    await assert.rejects(
      engine(c, 'fn_engine_maintenance_recovery', [
        s.interval_id,
        s.ownership_token,
        'retired process',
      ]),
      /STALE_ENGINE_OWNER/
    );
  });
  await test('wave_plan_refuses_split_event_inventory_and_rewrite', async () => {
    const c = await clone('mt_plan');
    const { s } = await fixtureHold(c, { plan: false });
    await assert.rejects(
      ready(
        c,
        s,
        base.tables.map((x) => [x])
      ),
      /EVENT_WAVE_SPLIT/
    );
    await ready(c, s, [base.tables.slice(0, 2), base.tables.slice(2)]);
    await assert.rejects(
      ready(c, s, [base.tables.slice(2), base.tables.slice(0, 2)]),
      /PLAN_IMMUTABLE/
    );
  });
  await test('step_budget_is_current_owned_and_replay_is_readback_only', async () => {
    const c = await clone('mt_budget');
    const { o, n, s } = await fixtureHold(c, { seconds: 960 });
    const args = [
      o.owner_id,
      o.epoch,
      s.operation_id,
      'publish:' + base.plan,
      150000,
      150000,
      10000,
      'engine_cutover',
      n,
      actor,
    ];
    const a = await as(c, 'release_journal_controller', () =>
      call(c, 'release_ops.authorize_maintenance_step', args)
    );
    assert.equal(a.authorized, true);
    const b = await as(c, 'release_journal_controller', () =>
      call(c, 'release_ops.authorize_maintenance_step', args)
    );
    assert.equal(b.authorized, false);
    assert.equal(b.step.id, a.step.id);
    args[3] = 'too-late';
    args[4] = 300000;
    const denied = await as(c, 'release_journal_controller', () =>
      call(c, 'release_ops.authorize_maintenance_step', args)
    );
    assert.equal(denied.authorized, false);
    assert.equal(denied.snapshot.operation.phase, 'recovery_required');
  });
  await test('maximum_deadline_never_releases_and_public_known_hold_survives', async () => {
    const c = await clone('mt_deadline');
    const { s } = await fixtureHold(c, { seconds: 1801, plan: false });
    const currentState = await current(c, s);
    assert.equal(currentState.phase, 'recovery_required');
    assert.equal(currentState.release_receipt, null);
    await assert.rejects(
      engine(c, 'fn_thaw_platform', [
        s.freeze_started_at,
        s.freeze_started_at,
        1801,
        s.ownership_token,
        actor,
      ]),
      /RELEASE_NOT_AUTHORIZED/
    );
    const b = await as(c, 'anon', () =>
      call(c, 'public.fn_maintenance_break_state_v2', [base.tables[0], s.interval_id])
    );
    assert.equal(b.active, true);
    assert.equal(b.interval_id, s.interval_id);
    assert.equal(b.release_receipt, null);
  });
  await test('private_permits_and_verifier_boundaries_resist_forged_context', async () => {
    const c = await clone('mt_acl');
    const { s } = await fixtureHold(c);
    for (const role of ['anon', 'authenticated', 'service_role', 'release_journal_controller']) {
      await assert.rejects(
        as(c, role, () =>
          c.query(
            'INSERT INTO release_ops.maintenance_write_permits VALUES(pg_backend_pid(),pg_current_xact_id(),$1)',
            [s.interval_id]
          )
        ),
        /permission denied/
      );
    }
    await assert.rejects(
      as(c, 'service_role', async () => {
        await c.query(
          'SET app.freeze_bypass=\'on\'; SET request.jwt.claims=\'{"role":"service_role"}\''
        );
        return c.query("UPDATE public.engine_maintenance_break SET reason='forged'");
      }),
      /ROW_OWNED|permission denied/
    );
    await assert.rejects(
      as(c, 'release_journal_controller', () =>
        call(c, 'release_ops.register_maintenance_safe_resume', [
          s.operation_id,
          randomUUID(),
          {},
          actor,
        ])
      ),
      /permission denied/
    );
  });
  await test('safe_resume_requires_exact_current_publication_and_before_final_certification', async () => {
    const c = await clone('mt_safe');
    const { o, s } = await fixtureHold(c);
    await assert.rejects(
      as(c, 'release_journal_controller', () =>
        call(c, 'release_ops.authorize_maintenance_release', [
          o.owner_id,
          o.epoch,
          s.operation_id,
          randomUUID(),
          actor,
        ])
      ),
      /PROOF_STALE_OR_UNKNOWN/
    );
    const p = await publication(c, s);
    const r = await as(c, 'release_journal_controller', () =>
      call(c, 'release_ops.authorize_maintenance_release', [
        o.owner_id,
        o.epoch,
        s.operation_id,
        p.receipt,
        actor,
      ])
    );
    assert.equal(r.operation.phase, 'release_authorized');
    assert.equal(
      (
        await one(
          c,
          "SELECT state,selected_receipts?'CERTIFICATION' cert FROM release_ops.queue WHERE release_id=$1",
          [base.release]
        )
      ).cert,
      false
    );
  });
  await test('actuator_exact_host_binding_single_use_and_lost_response_readback', async () => {
    const c = await clone('mt_actuator');
    const { o, n, s } = await fixtureHold(c);
    const step = await as(c, 'release_journal_controller', () =>
      call(c, 'release_ops.authorize_maintenance_step', [
        o.owner_id,
        o.epoch,
        s.operation_id,
        'publish:' + base.plan,
        150000,
        150000,
        10000,
        'engine_cutover',
        n,
        actor,
      ])
    );
    assert.equal(step.authorized, true);
    const external = randomUUID(),
      ev = await call(c, 'release_ops.event', [
        base.release,
        'NATIVE_PROVIDER_SUBMISSION',
        actor,
        {},
      ]);
    await c.query(
      `INSERT INTO release_ops.external_operations(id,release_id,operation_key,owner_id,epoch,kind,intent,intent_event,resume_state,status)
 VALUES($1,$2,'native-host-send',$3,$4,'PUBLISH',$5,$6,'APPLYING','INTENT')`,
      [
        external,
        base.release,
        o.owner_id,
        o.epoch,
        {
          target: 'club-arena-engine',
          manifest_digest: base.manifest_digest,
          provider_request: base.request,
          plan_id: base.plan,
          installation_id: base.installation,
        },
        ev,
      ]
    );
    const host = new Client({
      ...settings,
      database: 'mt_actuator',
      user: 'maintenance_native_actuator',
    });
    await host.connect();
    clients.push(host);
    assert.equal(await call(host, 'release_ops.schema_version'), 1);
    assert.equal(await call(host, 'release_ops.provider_schema_version'), 1);
    await assert.rejects(host.query('SELECT * FROM release_ops.controller'), /permission denied/);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(
        (
          await one(
            c,
            "SELECT has_function_privilege($1,'release_ops.schema_version()','EXECUTE') allowed",
            [role]
          )
        ).allowed,
        false
      );
      assert.equal(
        (
          await one(
            c,
            "SELECT has_function_privilege($1,'release_ops.provider_schema_version()','EXECUTE') allowed",
            [role]
          )
        ).allowed,
        false
      );
    }
    const args = [
      o.owner_id,
      o.epoch,
      s.operation_id,
      step.step.id,
      external,
      'b'.repeat(64),
      actor,
    ];
    await assert.rejects(
      call(host, 'release_ops.consume_engine_maintenance_step', args),
      /STEP_NOT_CURRENT/
    );
    await c.query('INSERT INTO release_ops.provider_submissions VALUES($1,$2,$3,$4,$5)', [
      external,
      base.installation,
      o.owner_id,
      o.epoch,
      ev,
    ]);
    await assert.rejects(
      call(host, 'release_ops.consume_engine_maintenance_step', [
        ...args.slice(0, 5),
        'c'.repeat(64),
        actor,
      ]),
      /BINDING_MISMATCH/
    );
    const used = await call(host, 'release_ops.consume_engine_maintenance_step', args);
    assert.equal(used.consumed, true);
    assert.equal(used.authority.interval.phase, 'applying');
    assert.deepEqual(used.authority.provider_request, base.request);
    const replay = await call(host, 'release_ops.consume_engine_maintenance_step', args);
    assert.equal(replay.consumed, false);
    assert.equal(replay.receipt_id, used.receipt_id);
    assert.equal(
      (await call(host, 'release_ops.engine_maintenance_actuator_context', [external])).consumption
        .receipt_id,
      used.receipt_id
    );
    await c.query('SELECT pg_advisory_unlock_all()');
    await assert.rejects(
      call(host, 'release_ops.consume_engine_maintenance_step', args),
      /OWNER_NOT_LIVE/
    );
    assert.equal(
      (await call(host, 'release_ops.engine_maintenance_actuator_context', [external])).consumption
        .receipt_id,
      used.receipt_id
    );
  });
  await test('observation_budget_is_persisted_and_verification_context_is_bounded', async () => {
    const c = await clone('mt_observe');
    const { o, n, s } = await fixtureHold(c);
    const context = await as(c, 'release_journal_verifier', () =>
      call(c, 'release_ops.engine_maintenance_verification_context', [base.release, s.operation_id])
    );
    assert.equal(context.operation.operation_id, s.operation_id);
    assert.equal(context.need_receipt, n);
    assert.equal(context.need_evidence.actual_recovery_ms, 150000);
    const args = [o.owner_id, o.epoch, s.operation_id, actor];
    const first = await as(c, 'release_journal_controller', () =>
      call(c, 'release_ops.authorize_maintenance_observation', args)
    );
    assert.equal(first.authorized, true);
    const second = await as(c, 'release_journal_controller', () =>
      call(c, 'release_ops.authorize_maintenance_observation', args)
    );
    assert.equal(second.authorized, false);
    assert.equal(second.next_check_at, first.next_check_at);
  });
  await test('source_acl_drift_refuses_whole_migration_transaction', async () => {
    const c = await client('maintenance_preflight');
    await c.query(
      'GRANT EXECUTE ON FUNCTION public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text) TO anon'
    );
    const sql = await readFile(state.migration_file, 'utf8');
    await assert.rejects(c.query(sql), /MAINTENANCE_SOURCE_DRIFT/);
    await c.query('ROLLBACK');
    assert.equal(
      (await one(c, "SELECT to_regclass('release_ops.maintenance_operations') v")).v,
      null
    );
  });
  await test('legacy_v3_inflight_keeps_original_token_clock_and_blocks_activation', async () => {
    const c = await clone('mt_legacy');
    const o = await owner(c);
    const dates = await one(
      c,
      "SELECT date_trunc('milliseconds',clock_timestamp())-interval '400 seconds' start"
    );
    const start = dates.start.toISOString(),
      announced = new Date(dates.start.getTime() - 120000).toISOString(),
      ends = new Date(dates.start.getTime() + 300000).toISOString(),
      token = randomUUID();
    await c.query(
      `INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,reason,declared_by,enforce_freeze,ownership_token) VALUES(true,'counting_down',$1,$2,$3,'Legacy maintenance',$4,true,$5)`,
      [announced, start, ends, actor, token]
    );
    await assert.rejects(activation(c, o), /LEGACY_INTERVAL_UNRESOLVED/);
    const first = await engine(c, 'fn_thaw_platform', [announced, start, 1, token, actor]);
    assert.equal(first.complete, false);
    await assert.rejects(activation(c, o), /LEGACY_INTERVAL_UNRESOLVED/);
    const newToken = randomUUID();
    const claim = await engine(c, 'fn_claim_engine_maintenance_break', [token, newToken, actor]);
    assert.equal(claim.ok, true);
    const stale = await engine(c, 'fn_thaw_platform', [announced, start, 1, token, actor]);
    assert.equal(stale.reason, 'maintenance_ownership_changed');
    let r;
    for (let i = 0; i < 10; i++) {
      r = await engine(c, 'fn_thaw_platform', [announced, start, 1, newToken, actor]);
      if (r.complete) break;
    }
    assert.equal(r.complete, true);
    assert.equal(r.ownership_token, newToken);
    assert.equal((await engine(c, 'fn_engine_maintenance_operation')).policy_version, 1);
    assert.equal((await one(c, 'SELECT public.fn_platform_frozen() v')).v, true);
  });

  async function seedClocks(c, s) {
    const seat = (
      await one(
        c,
        'SELECT to_jsonb(x) v FROM public.table_seats x WHERE user_id IS NOT NULL LIMIT 1'
      )
    ).v;
    const user = seat.user_id;
    const club = (await one(c, 'SELECT club_id FROM public.tournaments WHERE id=$1', [base.event]))
      .club_id;
    const game = randomUUID(),
      chest = randomUUID(),
      award = randomUUID(),
      tx = randomUUID(),
      stay = randomUUID(),
      rejoin = randomUUID(),
      move = randomUUID(),
      snapshot = randomUUID(),
      wait = randomUUID();
    const start = Date.parse(s.freeze_started_at),
      live = new Date(start + 20000).toISOString(),
      before = new Date(start - 10000).toISOString();
    const reconnect = {
      live: {
        state: 'MISSING',
        reconnectDeadlineMs: start + 20000,
        reconnectGrantedAtMs: start - 1000,
        graceDeadlineMs: start + 10000,
      },
      expired: {
        state: 'MISSING',
        reconnectDeadlineMs: start - 1,
        reconnectGrantedAtMs: start - 100000,
      },
    };
    await c.query('BEGIN;SET LOCAL session_replication_role=replica');
    await c.query(
      `INSERT INTO public.cash_games(id,club_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot) VALUES($1,$2,'Native clock fixture','classic','nlh',1,2,6,'{}')`,
      [game, club]
    );
    await c.query(
      `UPDATE public.tables SET cluster_id=$1,club_id=$2,seat_game_scope=NULL,seat_admission_key=NULL,break_eligible_since=$3,bomb_pot_next_due_at=$4 WHERE id=$5`,
      [game, club, before, live, base.tables[2]]
    );
    await c.query(
      `UPDATE public.table_seats SET table_id=$1,sit_out_at=$2,is_sitting_out=true,left_at=NULL,active_game_scope='cluster:'||$3::text WHERE id=$4`,
      [base.tables[2], before, game, seat.id]
    );
    await c.query(
      `INSERT INTO public.table_waitlist(id,table_id,user_id,hold_expires_at) VALUES($1,$2,$3,$4)`,
      [wait, base.tables[2], user, live]
    );
    await c.query(
      `UPDATE public.tournaments SET status='RUNNING',on_break=false,level_started_at=$1,addon_period_ends_at=$2 WHERE id=$3`,
      [before, live, base.event]
    );
    await c.query(
      `UPDATE public.tournament_players SET rebuy_prompt_until=$1 WHERE id=(SELECT id FROM public.tournament_players WHERE tournament_id=$2 LIMIT 1)`,
      [live, base.event]
    );
    await c.query(
      `INSERT INTO public.chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,reversible_until) VALUES($1,$2,$3,$3,1,'peer_transfer',$4)`,
      [tx, club, user, live]
    );
    await c.query(
      `INSERT INTO public.tournament_bounty_chests(id,tournament_id,seq,tier,amount_cents) VALUES($1,$2,99999,'base',100)`,
      [chest, base.event]
    );
    await c.query(
      `INSERT INTO public.tournament_bounty_awards(id,tournament_id,chest_id,eliminated_user_id,amount_cents,tier,op_id,reveal_deadline_at) VALUES($1,$2,$3,$4,100,'base',$5,$6)`,
      [award, base.event, chest, user, randomUUID(), live]
    );
    await c.query(
      `INSERT INTO public.cash_player_session(id,player_id,scope_type,scope_id,table_id,stay_running,stay_last_tick_at) VALUES($1,$2,'table',$3,$3,true,$4)`,
      [stay, user, base.tables[2], before]
    );
    await c.query(
      `INSERT INTO public.cash_rejoin_constraints(id,player_id,club_id,variant,sb,bb,required_stack,expires_at) VALUES($1,$2,$3,'nlh',1,2,100,$4)`,
      [rejoin, user, club, live]
    );
    await c.query(
      `INSERT INTO public.cash_seat_moves(id,game_id,player_id,from_table_id,to_table_id,reason,expires_at,source_occupancy_id,source_seat_number) VALUES($1,$2,$3,$4,$5,'balance',$6,$7,1)`,
      [move, game, user, base.tables[2], base.tables[0], live, seat.occupancy_id]
    );
    await c.query(
      `INSERT INTO public.engine_presence_parked(table_id,parked_at,disconnect_states) VALUES($1,$2,$3)`,
      [base.tables[0], s.freeze_started_at, reconnect]
    );
    await c.query(
      `INSERT INTO public.hand_state_snapshots(id,table_id,hand_number,state_json,config_json,dealer_seat,players_json,updated_at,disconnect_states,is_complete) VALUES($1,$2,42,'{}','{}',1,'[]',$3,$4,false)`,
      [snapshot, base.tables[2], s.freeze_started_at, reconnect]
    );
    await c.query('COMMIT');
    return {
      seat: seat.id,
      user,
      game,
      chest,
      award,
      tx,
      stay,
      rejoin,
      move,
      snapshot,
      wait,
      live,
      before,
      reconnect,
    };
  }
  async function clockReceipt(c, s, fixture) {
    const r = await one(
      c,
      `SELECT
 (SELECT sit_out_at FROM public.table_seats WHERE id=$1) seat,
 (SELECT level_started_at FROM public.tournaments WHERE id=$2) level,
 (SELECT reversible_until FROM public.chip_transactions WHERE id=$3) reversible,
 (SELECT disconnect_states FROM public.engine_presence_parked WHERE table_id=$4) reconnect,
 (SELECT jsonb_agg(to_jsonb(x) ORDER BY step,target_id) FROM public.engine_maintenance_thaw_targets x WHERE freeze_started_at=$5) targets`,
      [fixture.seat, base.event, fixture.tx, base.tables[0], s.freeze_started_at]
    );
    return JSON.parse(JSON.stringify(r));
  }
  async function acceptedHandDuringWave(c, s, f) {
    const table = base.tables[0];
    const generation = randomUUID();
    const instance = 'maintenance-native-accepted-hand';
    const roster = (
      await c.query(
        'SELECT to_jsonb(p) v FROM public.tournament_players p WHERE tournament_id=$1 AND user_id<>$2 ORDER BY user_id LIMIT 2',
        [base.event, f.user]
      )
    ).rows.map((x) => x.v);
    assert.equal(roster.length, 2);
    const seat = (
      await one(
        c,
        'SELECT to_jsonb(s) v FROM public.table_seats s WHERE user_id IS NOT NULL LIMIT 1'
      )
    ).v;
    await c.query('BEGIN;SET LOCAL session_replication_role=replica');
    await c.query(
      "UPDATE public.tournaments SET status='RUNNING',prize_pool_finalized=false WHERE id=$1",
      [base.event]
    );
    const seats = [];
    for (let i = 0; i < 2; i++) {
      const player = roster[i];
      const id = randomUUID();
      await c.query(
        'UPDATE public.table_seats SET left_at=clock_timestamp(),active_game_scope=NULL,active_parent_key=NULL WHERE user_id=$1 AND left_at IS NULL',
        [player.user_id]
      );
      await c.query(
        "UPDATE public.tournament_players SET status='playing',chips=10,table_id=$1,seat_number=$2,eliminated_at=NULL,position=NULL,prize=0 WHERE id=$3",
        [table, i + 1, player.id]
      );
      const row = {
        ...seat,
        id,
        table_id: table,
        seat_number: i + 1,
        user_id: player.user_id,
        stack: 10,
        status: 'active',
        left_at: null,
        joined_at: new Date(Date.now() - 60000).toISOString(),
        is_sitting_out: false,
        is_away: false,
        sit_out_at: null,
        leave_pending: false,
        occupancy_id: randomUUID(),
        active_game_scope: 'tournament:' + base.event,
        active_parent_key: 'running',
        terminal_closed_at: null,
      };
      await c.query(
        'INSERT INTO public.table_seats SELECT (jsonb_populate_record(NULL::public.table_seats,$1)).*',
        [row]
      );
      seats.push(row);
    }
    await c.query('UPDATE public.tables SET current_players=2 WHERE id=$1', [table]);
    await c.query(
      "INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,engine_version,lease_generation,protocol_version) VALUES($1,$2,'native-proof',$3,2) ON CONFLICT(tournament_id) DO UPDATE SET instance_id=excluded.instance_id,lease_generation=excluded.lease_generation,protocol_version=2,heartbeat_at=clock_timestamp()",
      [base.event, instance, generation]
    );
    await c.query('COMMIT');
    const stacks = seats.map((x, i) => ({
      user_id: x.user_id,
      seat_id: x.id,
      seat_joined_at: x.joined_at,
      stack_before: 10,
      stack: i === 0 ? 11 : 9,
    }));
    const hand = {
      id: randomUUID(),
      table_id: table,
      tournament_id: base.event,
      hand_number: 8900777,
      game_variant: 'nlh',
      small_blind: 1,
      big_blind: 2,
      pot_size: 2,
      rake_amount: 0,
      bbj_amount: 0,
      players: stacks,
      actions: [],
      winners: [{ userId: seats[0].user_id, amount: 2 }],
      _accepted_post_commit_facts: {
        contributions: Object.fromEntries(seats.map((x) => [x.user_id, 1])),
        returned_uncalled: {},
        insurance: [],
      },
    };
    const obligations = {
      version: 1,
      time_banks: seats.map((x) => ({
        user_id: x.user_id,
        seat_id: x.id,
        seat_joined_at: x.joined_at,
        uses_remaining: 4,
        seconds_remaining: 29,
      })),
      promo_playthrough: [],
      insurance: [],
      pending_addons: null,
      rake: null,
      bbj_contribution: null,
    };
    const args = [
      table,
      hand.hand_number,
      JSON.stringify(stacks),
      0,
      0,
      'maintenance-native-new-hand',
      0,
      hand,
      '[]',
      instance,
      generation,
      obligations,
    ];
    const guard = await one(
      c,
      `SELECT t.tgenabled,md5(p.prosrc) body_md5 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.table_seats'::regclass AND t.tgname='zz_freeze_guard'`
    );
    const sourceGuards = JSON.parse(
      await readFile(new URL('./current-gameplay-freeze-guard.json', import.meta.url), 'utf8')
    );
    assert.equal(guard.tgenabled, 'O');
    assert.equal(guard.body_md5, sourceGuards[0].body_md5);
    assert.equal(
      (
        await one(
          c,
          `SELECT has_function_privilege('service_role','public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)','EXECUTE') allowed`
        )
      ).allowed,
      false
    );
    assert.equal(
      (
        await one(
          c,
          `SELECT has_function_privilege('authenticated','public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)','EXECUTE') allowed`
        )
      ).allowed,
      false
    );
    await c.query(
      `SET request.jwt.claim.role='service_role';SET request.jwt.claims='{"role":"service_role"}'`
    );
    try {
      assert.equal(
        (
          await one(
            c,
            "SELECT public.fn_platform_frozen() frozen,coalesce(current_setting('app.freeze_bypass',true),'') bypass"
          )
        ).frozen,
        true
      );
      assert.notEqual(
        (await one(c, "SELECT coalesce(current_setting('app.freeze_bypass',true),'') bypass"))
          .bypass,
        'on'
      );
      assert.equal(
        (await call(c, 'public.fn_maintenance_break_state_v2', [table, s.interval_id])).active,
        false
      );
      assert.equal(
        (await call(c, 'public.fn_maintenance_break_state_v2', [base.tables[2], s.interval_id]))
          .active,
        true
      );
      const fenced = await engine(c, 'fn_ca_commit_hand_settlement', [
        ...args.slice(0, 10),
        randomUUID(),
        obligations,
      ]);
      assert.equal(fenced.success, false);
      assert.equal(fenced.reason, 'hand_lease_lost');
      assert.equal(
        (
          await one(
            c,
            'SELECT count(*)::int n FROM public.hand_atomic_commits WHERE table_id=$1 AND hand_number=$2',
            [table, hand.hand_number]
          )
        ).n,
        0
      );
      const result = await engine(c, 'fn_ca_commit_hand_settlement', args);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.atomic_hand_commit, true);
      const readback = async () =>
        one(
          c,
          `SELECT (SELECT jsonb_agg(jsonb_build_object('id',id,'stack',stack,'time_bank_remaining',time_bank_remaining) ORDER BY id) FROM public.table_seats WHERE id=ANY($1::uuid[])) seats,(SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'chips',chips) ORDER BY user_id) FROM public.tournament_players WHERE id=ANY($2::uuid[])) roster,(SELECT to_jsonb(x) FROM public.hand_atomic_commits x WHERE table_id=$3 AND hand_number=$4) commit,(SELECT count(*)::int FROM public.hand_history WHERE id=$5) history,(SELECT count(*)::int FROM public.hand_projection_outbox WHERE hand_id=$5) outbox`,
          [seats.map((x) => x.id), roster.map((x) => x.id), table, hand.hand_number, hand.id]
        );
      const before = await readback();
      assert.equal(before.history, 1);
      assert.equal(before.outbox, 1);
      assert.deepEqual(
        before.seats.map((x) => x.stack).sort((a, b) => a - b),
        [9, 11]
      );
      assert.deepEqual(
        before.roster.map((x) => x.chips).sort((a, b) => a - b),
        [9, 11]
      );
      assert.ok(before.commit.stack_result.conservation_checked);
      const replay = await engine(c, 'fn_ca_commit_hand_settlement', args);
      assert.equal(replay.success, true);
      assert.deepEqual(await readback(), before);
      assert.equal(
        (await call(c, 'public.fn_maintenance_break_state_v2', [base.tables[2], s.interval_id]))
          .active,
        true
      );
      assert.equal((await one(c, 'SELECT public.fn_platform_frozen() frozen')).frozen, true);
      await writeFile(
        evidence + '/accepted-hand-during-wave.json',
        JSON.stringify(
          {
            interval_id: s.interval_id,
            result,
            replay,
            readback: before,
            later_wave_held: true,
            global_freeze: true,
            no_bypass: true,
            freeze_guard: guard,
            private_stack_core_server_execute: false,
          },
          null,
          2
        )
      );
    } finally {
      await c.query('RESET request.jwt.claim.role;RESET request.jwt.claims');
    }
  }
  for (const seconds of [960, 1800])
    await test(`actual_v3_${seconds}_seconds_all14_targets_wave_suffix_and_replay`, async () => {
      const c = await clone('mt_clock_' + seconds);
      let { o, s } = await fixtureHold(c, { seconds, plan: seconds < 1800 });
      if (seconds >= 1800) {
        // Fixture represents a hold already drained before its original deadline.
        await c.query(
          "UPDATE release_ops.maintenance_operations SET ready_at=freeze_started_at+interval '120seconds' WHERE interval_id=$1",
          [s.interval_id]
        );
        for (let i = 0; i < 2; i++)
          await c.query(
            'INSERT INTO release_ops.maintenance_waves(interval_id,wave_index,table_ids,ownership_token) VALUES($1,$2,$3,$4)',
            [
              s.interval_id,
              i,
              i === 0 ? base.tables.slice(0, 2) : base.tables.slice(2),
              s.ownership_token,
            ]
          );
      }
      const f = await seedClocks(c, s);
      s = (await release(c, o, s)).s;
      const t = await thaw(c, s);
      assert.equal(t.released, true);
      assert.ok(t.effective_frozen_seconds >= seconds, t);
      const first = await clockReceipt(c, s, f);
      assert.equal(new Set(first.targets.map((x) => x.step)).size, 14);
      const ledger = await one(
        c,
        'SELECT * FROM public.engine_maintenance_thaws WHERE freeze_started_at=$1',
        [s.freeze_started_at]
      );
      assert.equal(
        (
          await one(
            c,
            'SELECT extract(epoch FROM sit_out_at-$1::timestamptz)=$2::numeric exact FROM public.table_seats WHERE id=$3',
            [f.before, ledger.frozen_seconds, f.seat]
          )
        ).exact,
        true
      );
      assert.equal(
        first.reconnect.expired.reconnectDeadlineMs,
        f.reconnect.expired.reconnectDeadlineMs
      );
      assert.ok(
        first.reconnect.live.reconnectDeadlineMs >
          f.reconnect.live.reconnectDeadlineMs + seconds * 1000
      );
      const replayThaw = await thaw(c, s);
      for (const key of [
        'complete',
        'released',
        'ownership_token',
        'freeze_started_at',
        'credited_through_at',
        'effective_frozen_seconds',
        'shifted',
      ])
        assert.deepEqual(replayThaw[key], t[key]);
      assert.deepEqual(await clockReceipt(c, s, f), first);
      const waveReceipts = [];
      let eventClock;
      for (let i = 0; i < 2; i++) {
        let snapshot;
        for (let n = 0; n < 10; n++) {
          snapshot = await engine(c, 'fn_authorize_engine_maintenance_wave', [
            s.interval_id,
            s.ownership_token,
            i,
            i === 0 ? base.tables.slice(0, 2) : base.tables.slice(2),
          ]);
          if (snapshot.operation.resume_waves[i].receipt_id) break;
        }
        const w = snapshot.operation.resume_waves[i];
        assert.ok(w.receipt_id, w);
        assert.equal(
          (
            await as(c, 'anon', () =>
              call(c, 'public.fn_maintenance_break_state_v2', [w.table_ids[0], s.interval_id])
            )
          ).active,
          true
        );
        await sleep(Math.max(0, Date.parse(w.credited_through_at) - Date.now()) + 30);
        const actual = new Date(Date.now()).toISOString();
        const ack = await engine(c, 'fn_ack_engine_maintenance_wave', [
          s.interval_id,
          s.ownership_token,
          i,
          w.receipt_id,
          w.table_ids,
          actual,
        ]);
        assert.equal(ack.operation.phase, 'releasing');
        assert.equal(Date.parse(ack.operation.resume_waves[i].resumed_at), Date.parse(actual));
        waveReceipts.push(w.receipt_id);
        const tableView = await as(c, 'anon', () =>
          call(c, 'public.fn_maintenance_break_state_v2', [w.table_ids[0], s.interval_id])
        );
        assert.equal(tableView.active, false);
        assert.equal(tableView.release_receipt, w.receipt_id);
        assert.equal(
          (
            await as(c, 'anon', () =>
              call(c, 'public.fn_maintenance_break_state_v2', [null, s.interval_id])
            )
          ).active,
          true
        );
        const after = await clockReceipt(c, s, f);
        if (i === 0 && seconds === 960)
          await test('canonical_new_hand_settles_after_wave_ack_while_later_wave_held', () =>
            acceptedHandDuringWave(c, s, f));
        if (i === 0) {
          eventClock = after.level;
          assert.equal(
            Date.parse(after.level) - Date.parse(f.before),
            Date.parse(actual) - Date.parse(s.freeze_started_at)
          );
        } else
          assert.equal(
            after.level,
            eventClock,
            'Already resumed event must not receive another wave suffix'
          );
        const beforeReplay = await clockReceipt(c, s, f);
        await engine(c, 'fn_ack_engine_maintenance_wave', [
          s.interval_id,
          s.ownership_token,
          i,
          w.receipt_id,
          w.table_ids,
          actual,
        ]);
        assert.deepEqual(await clockReceipt(c, s, f), beforeReplay);
      }
      let done = await engine(c, 'fn_ack_engine_maintenance_resumed', [
        s.interval_id,
        s.ownership_token,
        waveReceipts,
      ]);
      while (done.operation.phase !== 'resumed') {
        const boundary = done.operation.global_tail?.credited_through_at;
        await sleep(
          done.operation.global_tail?.receipt_id
            ? Math.max(1, Date.parse(boundary) - Date.now() + 5)
            : 20
        );
        done = await engine(c, 'fn_ack_engine_maintenance_resumed', [
          s.interval_id,
          s.ownership_token,
          waveReceipts,
        ]);
      }
      assert.equal(done.operation.global_tail.status, 'released');
      assert.equal(done.operation.phase, 'resumed');
      const b = await as(c, 'anon', () =>
        call(c, 'public.fn_maintenance_break_state_v2', [base.tables[0], s.interval_id])
      );
      assert.equal(b.active, false);
      assert.equal(b.release_receipt, waveReceipts[0]);
      const final = await clockReceipt(c, s, f);
      assert.equal(final.level, eventClock);
      await writeFile(
        evidence + '/clock-diagnostic.json',
        JSON.stringify(
          {
            s,
            f,
            first,
            final,
            done,
            operation: await one(
              c,
              'SELECT to_jsonb(x) v FROM release_ops.maintenance_operations x WHERE interval_id=$1',
              [s.interval_id]
            ),
          },
          null,
          2
        )
      );
      assert.equal(
        Date.parse(final.reversible) - Date.parse(f.live),
        Date.parse(done.operation.observed_at) > 0
          ? (
              await one(
                c,
                'SELECT resumed_at FROM release_ops.maintenance_operations WHERE interval_id=$1',
                [s.interval_id]
              )
            ).resumed_at.getTime() - Date.parse(s.freeze_started_at)
          : 0
      );
      await writeFile(
        evidence + `/clock-${seconds}.json`,
        JSON.stringify(
          {
            initial_seconds: seconds,
            base_thaw: t,
            final_snapshot: done,
            all14: true,
            first_wave_clock_unchanged_after_second: true,
          },
          null,
          2
        )
      );
    });
  await test('authorized_unacked_wave_adoption_is_unknown_without_more_credit', async () => {
    const c = await clone('mt_unknown');
    let { o, s } = await fixtureHold(c, { seconds: 960 });
    const f = await seedClocks(c, s);
    s = (await release(c, o, s)).s;
    await thaw(c, s);
    const authorized = await engine(c, 'fn_authorize_engine_maintenance_wave', [
      s.interval_id,
      s.ownership_token,
      0,
      base.tables.slice(0, 2),
    ]);
    assert.ok(authorized.operation.resume_waves[0].receipt_id);
    const before = await clockReceipt(c, s, f);
    const adopted = await engine(c, 'fn_claim_engine_maintenance_operation', [
      s.interval_id,
      s.ownership_token,
      randomUUID(),
      actor,
    ]);
    assert.equal(adopted.operation.phase, 'recovery_required');
    assert.deepEqual(await clockReceipt(c, s, f), before);
    assert.deepEqual(adopted.operation.resume_waves, authorized.operation.resume_waves);
  });

  console.log(JSON.stringify(results));
} finally {
  await Promise.all(clients.map((c) => c.end().catch(() => {})));
}
