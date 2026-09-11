import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCluster } from './postgres-fixture.mjs';
import { call, connect, policy } from '../../operations/release/journal.mjs';
import { providerCall, ProviderRunner } from '../../operations/release/provider-journal.mjs';
import { VercelPromoteAdapter } from '../../operations/release/adapters/vercel.mjs';
import { controllerSession } from '../../operations/release/controller.mjs';

let cluster;
const clients = new Set();
const migration = new URL(
  '../../supabase/migrations/20260911160341_provider_operation_boundary.sql',
  import.meta.url
);
const sha = (char) => char.repeat(40);
const installation = { bundle_digest: 'b'.repeat(64), config_digest: 'c'.repeat(64) };
before(async () => {
  cluster = await createCluster();
});
after(async () => {
  await Promise.all([...clients].map((c) => c.end().catch(() => {})));
  await cluster?.close();
});
async function db(config) {
  const client = await connect(config);
  clients.add(client);
  return client;
}
async function snapshot(client, id = null) {
  return call(client, 'inspect', [id]);
}
async function reconciliation(client) {
  const s = await snapshot(client);
  await call(client, 'reconcile', [
    s.controller.epoch,
    s.controller.last_event,
    {
      instance_id: s.controller.instance_id,
      verified: true,
      repository_heads: Object.fromEntries(
        policy.participants.map((p) => [p.repository, sha('a')])
      ),
      components: Object.fromEntries(policy.participants.map((p) => [p.target, { fixture: true }])),
      unresolved_external_ids: s.external
        .filter((e) => ['INTENT', 'UNKNOWN'].includes(e.status))
        .map((e) => e.id),
      receipt_refs: ['isolated-native-provider-fixture'],
    },
    'fixture-verifier',
    'Native test state reconciliation',
  ]);
}
function apiFixture() {
  const state = {
    postCount: 0,
    failResponse: false,
    substate: 'STAGED',
    current: 'dpl_prior',
    domainsCurrent: 'dpl_prior',
    last: {
      type: 'promote',
      fromDeploymentId: 'dpl_old',
      toDeploymentId: 'dpl_prior',
      requestedAt: 100,
      jobStatus: 'succeeded',
    },
  };
  const request = async (path, options = {}) => {
    if (options.method === 'POST') {
      state.postCount++;
      if (state.failResponse) throw new Error('lost after acceptance');
      return { status: 201 };
    }
    if (path.includes('/domains?'))
      return {
        domains: [
          { name: 'smarter.poker', projectId: 'prj_op66GkZyZcygXQKm76iyycfVFAQx', verified: true },
        ],
        pagination: { next: null },
      };
    if (path.startsWith('/v9/projects'))
      return {
        id: 'prj_op66GkZyZcygXQKm76iyycfVFAQx',
        accountId: 'team_owner',
        autoAssignCustomDomains: false,
        targets: { production: { id: state.current } },
        lastAliasRequest: state.last,
      };
    if (path.startsWith('/v13/deployments'))
      return {
        id: 'dpl_candidate',
        projectId: 'prj_op66GkZyZcygXQKm76iyycfVFAQx',
        ownerId: 'team_owner',
        readyState: 'READY',
        readySubstate: state.substate,
        target: 'production',
        meta: { githubCommitSha: sha('1') },
      };
    if (path.startsWith('/v4/aliases'))
      return {
        alias: 'smarter.poker',
        projectId: 'prj_op66GkZyZcygXQKm76iyycfVFAQx',
        deploymentId: state.domainsCurrent,
        deployment: { id: state.domainsCurrent },
      };
    throw new Error('unexpected endpoint');
  };
  return {
    state,
    adapter: new VercelPromoteAdapter({
      projectId: 'prj_op66GkZyZcygXQKm76iyycfVFAQx',
      teamId: 'team_owner',
      domains: ['smarter.poker'],
      request,
    }),
    complete() {
      state.current = state.domainsCurrent = 'dpl_candidate';
      state.substate = 'PROMOTED';
      state.last = {
        type: 'promote',
        fromDeploymentId: 'dpl_prior',
        toDeploymentId: 'dpl_candidate',
        requestedAt: 200,
        jobStatus: 'succeeded',
      };
    },
  };
}
async function setup() {
  const config = await cluster.database({
    additionalMigrations: [
      migration,
      new URL(
        '../../supabase/migrations/20260911190350_component_certification_and_durable_fixture_claims.sql',
        import.meta.url
      ),
    ],
  });
  const admin = await db(config);
  const role = `provider_${randomUUID().replaceAll('-', '')}`;
  await admin.query(
    `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEROLE; GRANT release_journal_controller TO ${role}`
  );
  const clientConfig = { ...config, user: role };
  const client = await db(clientConfig);
  const owner = await call(client, 'acquire_owner', [randomUUID(), 'fixture-controller']);
  const installed = await providerCall(admin, 'register_provider_installation', [
    installation.bundle_digest,
    {
      config_digest: installation.config_digest,
      controller_principal: role,
      host_id: 'isolated-native-fixture',
      service: 'club-arena-release-controller.service',
      native_lock_path: '/var/lib/club-arena-release-controller/controller.lock',
      schema_version: 1,
      provider_schema_version: 1,
      adapters: ['vercel-promote'],
    },
    Object.fromEntries(
      [
        'installed_code',
        'identity_membership',
        'exclusive_native_service',
        'legacy_writers_retired',
        'candidate_build_authority_isolated',
        'provider_scope',
        'compatible_recovery',
      ].map((k) => [k, ['native-fixture-only']])
    ),
    'fixture-verifier',
  ]);
  // Only an isolated superuser fixture enables execution. There is no activation
  // API/CLI or connection to any production database/provider in these tests.
  await admin.query(
    'UPDATE release_ops.controller SET execution_enabled=true,installed_adapter_receipt=$1',
    [installed.id]
  );
  await reconciliation(admin);
  const admission = await call(admin, 'enqueue', [
    randomUUID(),
    {
      repository: 'Smarter-Poker/Smarter-Poker-World-Hub',
      project: 'prj_op66GkZyZcygXQKm76iyycfVFAQx',
      target: 'world-hub-web',
      head_sha: sha('a'),
      purpose: 'release',
      manifest: { components: [{ target: 'world-hub-web', compatibility: 'expand' }] },
      dependencies: [],
    },
    'fixture-submitter',
  ]);
  const args = [owner.owner_id, owner.epoch, admission.id];
  await call(client, 'claim_next', [
    owner.owner_id,
    owner.epoch,
    new Date(Date.now() + 3600000).toISOString(),
    'fixture-controller',
  ]);
  async function row() {
    return (await snapshot(client, admission.id)).queue[0];
  }
  async function transition(state) {
    return call(client, 'transition', [
      ...args,
      (await row()).state_version,
      state,
      'fixture-controller',
      'Native provider fixture transition',
    ]);
  }
  async function receipt(kind, data) {
    const event = await call(client, 'record_receipt', [
      ...args,
      randomUUID(),
      kind,
      {
        manifest_digest: admission.manifest_digest,
        receipt_refs: ['native-only-fixture'],
        success: true,
        ...data,
      },
      'fixture-controller',
    ]);
    await call(client, 'select_receipt', [
      ...args,
      (await row()).state_version,
      event,
      'fixture-controller',
    ]);
    return event;
  }
  const v = await receipt('VALIDATION', {
    accepted_head_sha: sha('a'),
    expected_base_sha: sha('9'),
    tested_tree_sha: sha('8'),
  });
  await transition('MERGING');
  const i = await receipt('INTEGRATION', {
    merged_sha: sha('1'),
    validation_receipt: v,
    accepted_head_sha: sha('a'),
    expected_base_sha: sha('9'),
    merged_tree_sha: sha('8'),
  });
  await transition('BUILDING');
  const b = await receipt('BUILD', {
    integration_receipt: i,
    source_sha: sha('1'),
    artifact: { components: { 'world-hub-web': { identity: 'dpl_candidate' } } },
  });
  await transition('STAGED');
  const s = await receipt('STAGED', { build_receipt: b, compatibility_verified: true });
  await transition('READY');
  const request = {
    target: 'world-hub-web',
    manifest_digest: admission.manifest_digest,
    source_sha: sha('1'),
    project_id: 'prj_op66GkZyZcygXQKm76iyycfVFAQx',
    team_id: 'team_owner',
    deployment_id: 'dpl_candidate',
    domains: ['smarter.poker'],
    expected_current: { deployment_id: 'dpl_prior', last_alias_requested_at: 100 },
  };
  await receipt('READINESS', {
    stage_receipt: s,
    technical_gates_passed: true,
    expected_current: request.expected_current,
    provider_requests: { 'vercel-promote': request },
  });
  await transition('APPLYING');
  const plan = await providerCall(admin, 'submit_provider_plan', [
    admission.id,
    'exact-promote',
    'vercel-promote',
    request,
    'fixture-operator',
  ]);
  const fixture = apiFixture();
  const runner = new ProviderRunner({
    client,
    owner,
    installation,
    adapters: { 'vercel-promote': fixture.adapter },
  });
  return { config, clientConfig, admin, client, owner, admission, plan, request, fixture, runner };
}

test('qualified immutable plan and installed identity gates reject candidate or submitter authority', async () => {
  const f = await setup();
  await f.admin.query('SET ROLE release_journal_submitter');
  await assert.rejects(
    providerCall(f.admin, 'submit_provider_plan', [
      f.admission.id,
      'bad',
      'vercel-promote',
      f.request,
      'candidate',
    ]),
    /permission denied/
  );
  await assert.rejects(
    providerCall(f.admin, 'register_provider_installation', ['a'.repeat(64), {}, {}, 'candidate']),
    /permission denied/
  );
  await f.admin.query('RESET ROLE');
  await assert.rejects(
    providerCall(f.admin, 'submit_provider_plan', [
      f.admission.id,
      'other',
      'vercel-promote',
      { ...f.request, deployment_id: 'dpl_other' },
      'fixture',
    ]),
    /RELEASE_PROVIDER_QUALIFIED_PLAN_REQUIRED/
  );
  await assert.rejects(
    f.admin.query('UPDATE release_ops.provider_plans SET request=$1', [{}]),
    /RELEASE_HISTORY_IMMUTABLE/
  );
  await f.admin.query('UPDATE release_ops.controller SET execution_enabled=false');
  await assert.rejects(f.runner.submit(f.plan), /RELEASE_EXECUTION_NOT_ACTIVATED/);
  assert.equal(f.fixture.state.postCount, 0);
});

test('before-submit commits precede exactly one provider action; accepted response is UNKNOWN until exact terminal readback', async () => {
  const f = await setup();
  const submit = f.fixture.adapter.submit.bind(f.fixture.adapter);
  f.fixture.adapter.submit = async (request) => {
    const check = await f.admin.query(
      'SELECT (SELECT count(*)::int FROM release_ops.external_operations) AS intents,(SELECT count(*)::int FROM release_ops.provider_submissions) AS authorizations'
    );
    assert.deepEqual(check.rows[0], { intents: 1, authorizations: 1 });
    return submit(request);
  };
  assert.equal((await f.runner.submit(f.plan)).status, 'UNKNOWN');
  await f.runner.submit(f.plan);
  assert.equal(f.fixture.state.postCount, 1);
  const before = await snapshot(f.client);
  assert.equal(before.controller.active_release, f.admission.id);
  assert.equal(before.queue[0].state, 'UNKNOWN_EXTERNAL_OUTCOME');
  f.fixture.complete();
  await f.runner.reconcile(before.external[0]);
  const after = await snapshot(f.client, f.admission.id);
  assert.equal(after.external[0].status, 'SUCCEEDED');
  assert.equal(after.queue[0].state, 'APPLYING');
  assert.equal(after.controller.active_release, f.admission.id); // certification still absent
});

test('lost POST response and restart reconcile without resubmission or another admission', async () => {
  const f = await setup();
  f.fixture.state.failResponse = true;
  await f.runner.submit(f.plan);
  await f.client.end();
  clients.delete(f.client);
  const successor = await db(f.clientConfig);
  const owner = await call(successor, 'acquire_owner', [randomUUID(), 'successor']);
  const runner = new ProviderRunner({
    client: successor,
    owner,
    installation,
    adapters: { 'vercel-promote': f.fixture.adapter },
  });
  f.fixture.complete();
  const external = (await runner.snapshot()).external;
  assert.equal(external.status, 'UNKNOWN');
  await runner.reconcile(external);
  const s = await snapshot(successor, f.admission.id);
  assert.equal(s.external[0].status, 'SUCCEEDED');
  assert.equal(s.queue.length, 1);
  assert.equal(f.fixture.state.postCount, 1);
  assert.equal(s.controller.reconciliation_required, true);
});

test('stale owner paused during read-only preflight cannot submit after takeover', async () => {
  const f = await setup();
  f.fixture.adapter.preflight = async () => {
    await f.client.query('SELECT pg_advisory_unlock(77319011,1)');
    const next = await db(f.clientConfig);
    await call(next, 'acquire_owner', [randomUUID(), 'new-native-owner']);
    return { ready: true };
  };
  await assert.rejects(f.runner.submit(f.plan), /RELEASE_STALE_OWNER/);
  assert.equal(f.fixture.state.postCount, 0);
  assert.equal((await snapshot(f.admin)).queue[0].state, 'UNKNOWN_EXTERNAL_OUTCOME');
});

test('lost authorization COMMIT response cannot authorize a second send', async () => {
  const f = await setup();
  const op = await providerCall(f.client, 'begin_provider_plan', [
    f.owner.owner_id,
    f.owner.epoch,
    f.plan.id,
    ...Object.values(installation),
    'fixture',
  ]);
  const query = f.client.query.bind(f.client);
  let lost = false;
  f.client.query = async (...args) => {
    const result = await query(...args);
    if (args[0] === 'COMMIT' && !lost) {
      lost = true;
      throw new Error('lost commit response');
    }
    return result;
  };
  await assert.rejects(
    providerCall(f.client, 'authorize_provider_submit', [
      f.owner.owner_id,
      f.owner.epoch,
      op.id,
      ...Object.values(installation),
      'fixture',
    ]),
    /lost commit response/
  );
  f.client.query = query;
  assert.equal(
    (
      await providerCall(f.client, 'authorize_provider_submit', [
        f.owner.owner_id,
        f.owner.epoch,
        op.id,
        ...Object.values(installation),
        'fixture',
      ])
    ).may_submit,
    false
  );
  await f.runner.submit(f.plan);
  assert.equal(f.fixture.state.postCount, 0);
  assert.equal((await snapshot(f.admin)).queue[0].state, 'UNKNOWN_EXTERNAL_OUTCOME');
});

test('OBSERVE is zero-provider-I/O; incomplete domain changes and missing operation retain the barrier', async () => {
  const f = await setup();
  assert.equal((await f.runner.tick()).state, 'OBSERVE');
  assert.equal(f.fixture.state.postCount, 0);
  await f.runner.submit(f.plan);
  f.fixture.complete();
  f.fixture.state.domainsCurrent = 'dpl_prior';
  await f.runner.reconcile((await f.runner.snapshot()).external);
  assert.equal((await f.runner.snapshot()).external.status, 'UNKNOWN');
  f.fixture.state.last = null;
  await f.runner.reconcile((await f.runner.snapshot()).external);
  assert.equal((await f.runner.snapshot()).external.status, 'UNKNOWN');
  assert.equal((await snapshot(f.admin)).controller.active_release, f.admission.id);
});

test('terminal observation survives failed resolve commit and is replayed without another provider read', async () => {
  const f = await setup();
  await f.runner.submit(f.plan);
  f.fixture.complete();
  const external = (await f.runner.snapshot()).external;
  const query = f.client.query.bind(f.client);
  f.client.query = async (...args) => {
    if (String(args[0]).includes('release_ops.resolve_external'))
      throw new Error('connection lost before terminal commit');
    return query(...args);
  };
  await assert.rejects(f.runner.reconcile(external), /connection lost/);
  f.client.query = query;
  f.fixture.adapter.reconcile = async () => {
    throw new Error('must not re-read terminal receipt');
  };
  const result = await f.runner.tick({ mode: 'RECONCILE' });
  assert.equal(result.status, 'SUCCEEDED');
});

test('read-only reconciliation cannot invoke owned recovery and EXECUTE rechecks installed activation before an effect', async () => {
  const f = await setup();
  await f.runner.submit(f.plan);
  const external = (await f.runner.snapshot()).external;
  let effects = 0;
  f.fixture.adapter.reconcile = async (_request, _operation, { execute, beforeEffect }) => {
    if (execute) {
      await beforeEffect();
      effects++;
    }
    return { terminal: false, reason: 'EXPLICIT_NATIVE_RECOVERY_PENDING' };
  };
  await f.runner.reconcile(external, { execute: false });
  assert.equal(effects, 0);
  await f.admin.query('UPDATE release_ops.controller SET execution_enabled=false');
  await f.runner.reconcile(external, { execute: true });
  assert.equal(effects, 0);
  await f.admin.query('UPDATE release_ops.controller SET execution_enabled=true');
  await f.runner.reconcile(external, { execute: true });
  assert.equal(effects, 1);
});

test('readback retry budget and persisted wake time survive reconnect without a polling publisher', async () => {
  const f = await setup();
  await f.runner.submit(f.plan);
  let s = await f.runner.snapshot();
  assert.ok(Date.parse(s.observation.next_check_at) > Date.now());
  assert.equal((await f.runner.tick({ mode: 'RECONCILE' })).state, 'WAITING_READBACK');
  while (s.observation.check_no < 40) {
    await providerCall(f.client, 'record_provider_observation', [
      f.owner.owner_id,
      f.owner.epoch,
      s.external.id,
      { operation_id: s.external.id, terminal: false, reason: 'fixture-unknown' },
      'fixture',
    ]);
    s = await f.runner.snapshot();
  }
  assert.equal(
    (await f.runner.tick({ mode: 'RECONCILE' })).state,
    'UNKNOWN_READBACK_BUDGET_EXHAUSTED'
  );
  await assert.rejects(
    providerCall(f.client, 'record_provider_observation', [
      f.owner.owner_id,
      f.owner.epoch,
      s.external.id,
      { operation_id: s.external.id, terminal: false },
      'fixture',
    ]),
    /RELEASE_PROVIDER_READBACK_BUDGET_EXHAUSTED/
  );
  assert.equal(f.fixture.state.postCount, 1);
  assert.equal(s.controller.active_release, f.admission.id);
  await providerCall(f.admin, 'authorize_provider_readback', [
    s.external.id,
    'fixture-operator',
    'Provider access restored; explicit bounded readback',
  ]);
  f.fixture.complete();
  assert.equal((await f.runner.tick({ mode: 'RECONCILE' })).status, 'SUCCEEDED');
  assert.equal(f.fixture.state.postCount, 1);
});

test('actual event consumer takes fresh epoch and emits bounded OBSERVE snapshots without provider calls', async () => {
  const f = await setup();
  await f.client.end();
  clients.delete(f.client);
  const abort = new AbortController();
  const observations = [];
  let startup;
  await controllerSession(f.clientConfig, {
    installation,
    adapters: {
      'vercel-promote': {
        validate() {
          throw new Error('must never touch adapter');
        },
      },
    },
    signal: abort.signal,
    ready: (value) => {
      startup = value;
    },
    emit: (value) => {
      observations.push(value);
      abort.abort();
    },
  });
  assert.equal(startup.reconciliation_required, true);
  assert.notEqual(startup.epoch, f.owner.epoch);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].mode, 'OBSERVE');
  assert.equal(observations[0].mergeBuildOrchestrationAvailable, false);
  assert.equal(f.fixture.state.postCount, 0);
});
