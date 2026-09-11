import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createCluster } from './postgres-fixture.mjs';
import { receiptZip } from './static-artifact-fixture.mjs';
import { call, connect, policy } from '../../operations/release/journal.mjs';
import { providerCall, ProviderRunner } from '../../operations/release/provider-journal.mjs';
import { SourceCoordinator } from '../../operations/release/source-coordinator.mjs';
import {
  GitHubWorkflowAdapter,
  GitHubMergeAdapter,
} from '../../operations/release/adapters/github.mjs';
import {
  GitHubFrontendQualificationAdapter,
  frontendQualificationChecks,
} from '../../operations/release/adapters/github-frontend.mjs';
import { AggregateQualificationAdapter } from '../../operations/release/aggregate-qualification.mjs';
let cluster;
const clients = new Set();
before(async () => {
  cluster = await createCluster();
});
after(async () => {
  for (const c of clients) await c.end().catch(() => {});
  await cluster.close();
});
const repo = 'Smarter-Poker/Smarter-Poker-Club-Arena',
  engine = 'club-arena-engine',
  web = 'club-arena-web';
const sha = (x) => x.repeat(40),
  install = { bundle_digest: 'b'.repeat(64), config_digest: 'c'.repeat(64) };
const migrations = [
  '20260911160341_provider_operation_boundary.sql',
  '20260911190350_component_certification_and_durable_fixture_claims.sql',
  '20260911192023_bind_existing_static_publisher_to_private_release_journal.sql',
  '20260911194548_aggregate_component_qualification_under_one_release_operatio.sql',
].map((f) => new URL('../../supabase/migrations/' + f, import.meta.url));
async function db(config) {
  const c = await connect(config);
  clients.add(c);
  return c;
}
async function setup(components) {
  const config = await cluster.database({ additionalMigrations: migrations });
  const admin = await db(config);
  const name = 'aggregate_' + randomUUID().replaceAll('-', '');
  await admin.query(
    `CREATE ROLE ${name} LOGIN NOSUPERUSER;GRANT release_journal_controller TO ${name}`
  );
  let client = await db({ ...config, user: name });
  let owner = await call(client, 'acquire_owner', [randomUUID(), 'aggregate-test']);
  const github = {
    repo,
    controlSha: sha('c'),
    controlRef: 'heads/control',
    workflowId: 123,
    repositoryId: '12345',
    certificationVersion: 2,
    runtimeImage: `node:22-bookworm@sha256:${'e'.repeat(64)}`,
  };
  const installed = await providerCall(admin, 'register_provider_installation', [
    install.bundle_digest,
    {
      config_digest: install.config_digest,
      controller_principal: name,
      host_id: 'native-test',
      service: 'club-arena-release-controller.service',
      native_lock_path: '/var/lib/club-arena-release-controller/controller.lock',
      schema_version: 1,
      provider_schema_version: 1,
      adapters: ['github-merge', 'github-workflow', 'github-frontend', 'component-aggregate'],
      github: {
        control_sha: github.controlSha,
        workflow_id: 123,
        runtime_image: github.runtimeImage,
        frontend_qualification_workflow_id: 124,
        frontend_runtime_image: github.runtimeImage,
      },
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
    'native-verifier',
  ]);
  await admin.query(
    'UPDATE release_ops.controller SET execution_enabled=true,installed_adapter_receipt=$1',
    [installed.id]
  );
  async function reconcile() {
    const s = await call(admin, 'inspect');
    await call(admin, 'reconcile', [
      owner.epoch,
      s.controller.last_event,
      {
        instance_id: s.controller.instance_id,
        verified: true,
        repository_heads: Object.fromEntries(
          policy.participants.map((p) => [p.repository, sha('a')])
        ),
        components: Object.fromEntries(policy.participants.map((p) => [p.target, {}])),
        unresolved_external_ids: s.external
          .filter((e) => ['INTENT', 'UNKNOWN'].includes(e.status))
          .map((e) => e.id),
        receipt_refs: ['native-fixture-only'],
      },
      'native-verifier',
      'Exact native fixture reconciliation',
    ]);
  }
  await reconcile();
  const intent = {
    repository: repo,
    target: components[0],
    project: policy.participants.find((p) => p.target === components[0]).project,
    head_sha: sha('a'),
    pull_request: 42,
    purpose: 'release',
    manifest: { components: components.map((target) => ({ target })) },
    dependencies: [],
  };
  const first = await call(admin, 'enqueue', ['first', intent, 'native-test']);
  const second = await call(admin, 'enqueue', [
    'second',
    { ...intent, head_sha: sha('d'), pull_request: 43 },
    'native-test',
  ]);
  const runs = new Map();
  const counts = {};
  let visible = false;
  let forged = false;
  const request = async (route, options = {}) => {
    if (route.includes('/git/ref/')) return { object: { sha: github.controlSha } };
    if (route.endsWith('/pulls/42'))
      return {
        number: 42,
        state: 'open',
        merged: false,
        draft: false,
        mergeable: true,
        base: { repo: { full_name: repo }, ref: 'main', sha: sha('b') },
        head: { sha: sha('a') },
        merge_commit_sha: sha('e'),
      };
    if (route.includes('/git/commits/'))
      return {
        sha: sha('e'),
        tree: { sha: sha('1') },
        parents: [{ sha: sha('b') }, { sha: sha('a') }],
      };
    const wf = route.match(/\/workflows\/(123|124)(?:\/|$)/);
    const id = wf ? Number(wf[1]) : null;
    if (options.method === 'POST') {
      const r = JSON.parse(options.body.inputs.request),
        op = options.body.inputs.operation_id;
      counts[r.target] = (counts[r.target] ?? 0) + 1;
      const run = {
        id: id + 1000,
        workflow_id: id,
        head_sha: github.controlSha,
        event: 'workflow_dispatch',
        path:
          id === 123
            ? '.github/workflows/release-candidate.yml'
            : '.github/workflows/release-frontend-candidate.yml',
        run_attempt: 1,
        status: 'completed',
        conclusion: 'success',
        display_title: `release:${op}:${r.phase}`,
        repository: { id: 12345 },
        head_repository: { id: 12345 },
      };
      const proof = {
        operation_id: op,
        control_sha: github.controlSha,
        run_id: String(run.id),
        success: true,
        request: r,
        ...(id === 124
          ? {
              frontend_qualification_version: 1,
              checks: frontendQualificationChecks,
              source_tree_sha: r.tested_tree_sha,
            }
          : {}),
      };
      const bytes = receiptZip(proof);
      runs.set(id, {
        run,
        proof,
        bytes,
        artifact: {
          id: run.id + 1000,
          name: `release-receipt-${op}`,
          expired: false,
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        },
      });
      throw new Error('simulated lost provider acknowledgement');
    }
    if (id && route.includes('/runs?'))
      return {
        total_count: visible && runs.has(id) ? 1 : 0,
        workflow_runs: visible && runs.has(id) ? [runs.get(id).run] : [],
      };
    if (id)
      return {
        id,
        path:
          id === 123
            ? '.github/workflows/release-candidate.yml'
            : '.github/workflows/release-frontend-candidate.yml',
        state: 'active',
      };
    for (const entry of runs.values()) {
      if (route.endsWith(`/runs/${entry.run.id}/artifacts?per_page=100`))
        return { total_count: 1, artifacts: [entry.artifact] };
      if (route.endsWith(`/artifacts/${entry.artifact.id}/zip`))
        return forged ? receiptZip({ ...entry.proof, operation_id: randomUUID() }) : entry.bytes;
      if (route.endsWith(`/runs/${entry.run.id}`)) return entry.run;
    }
    throw new Error('Unexpected native fixture API route');
  };
  const adapters = {
    'github-merge': new GitHubMergeAdapter({ repo, request }),
    'github-workflow': new GitHubWorkflowAdapter({ ...github, request }),
    'github-frontend': new GitHubFrontendQualificationAdapter({
      ...github,
      workflowId: 124,
      request,
    }),
  };
  adapters['component-aggregate'] = new AggregateQualificationAdapter({ adapters });
  let runner, coordinator;
  function bind() {
    runner = new ProviderRunner({ client, owner, installation: install, adapters });
    coordinator = new SourceCoordinator({ runner, github });
  }
  bind();
  return {
    admin,
    first,
    second,
    counts,
    runs,
    adapters,
    get runner() {
      return runner;
    },
    get coordinator() {
      return coordinator;
    },
    get args() {
      return [owner.owner_id, owner.epoch];
    },
    get client() {
      return client;
    },
    visible: (v) => {
      visible = v;
    },
    forged: (v) => {
      forged = v;
    },
    restart: async () => {
      await client.end();
      client = await db({ ...config, user: name });
      owner = await call(client, 'acquire_owner', [randomUUID(), 'restart-test']);
      bind();
      await reconcile();
    },
    tick: () => coordinator.tick({ mode: 'EXECUTE', now: Date.now() + 3600000 }),
    step: () => coordinator.tick({ mode: 'EXECUTE' }),
  };
}
for (const components of [[web], [engine, web]])
  test(`native aggregate ${components.join('+')} reserves child identities, survives lost callbacks/restart, selects only complete validation`, async () => {
    const f = await setup(components);
    for (let i = 0; i < 6; i++) {
      if ((await f.runner.snapshot()).external) break;
      await f.step();
    } // claim, validation, plan and parent authorization
    let snapshot = await f.coordinator.snapshot();
    const parent = (await f.runner.snapshot()).external;
    assert.ok(parent);
    assert.equal(parent.intent.adapter, 'component-aggregate');
    await f.runner.reconcile(parent, { execute: true }); // first exact child submission, acknowledgement lost
    let state = await providerCall(f.client, 'qualification_snapshot', [...f.args, parent.id]);
    assert.equal(state.children.length, components.length);
    assert.equal(new Set(state.children.map((c) => c.id)).size, components.length);
    assert.ok(state.children.every((c) => c.created_at));
    assert.equal(
      Object.values(f.counts).reduce((a, b) => a + b, 0),
      1
    );
    assert.equal(
      (
        await call(f.client, 'claim_next', [
          ...f.args,
          new Date(Date.now() + 3600000).toISOString(),
          'native-test',
        ])
      ).release_id,
      f.first.id
    );
    assert.notEqual(f.first.id, f.second.id);
    // An administrator can request a proof, but cannot bypass the actual native
    // terminal guard by claiming a partial aggregate has succeeded.
    await assert.rejects(
      call(f.client, 'resolve_external', [
        ...f.args,
        parent.id,
        'SUCCEEDED',
        {
          terminal: true,
          outcome: 'SUCCEEDED',
          operation_id: parent.id,
          manifest_digest: parent.intent.manifest_digest,
          receipt_refs: ['forged-partial'],
          provider_operation_id: 'aggregate:' + parent.id,
          proof: { success: true },
        },
        'native-test',
      ]),
      /COMPLETE_AGGREGATE_REQUIRED/
    );
    const originalIds = state.children.map((c) => c.id),
      originalTimes = state.children.map((c) => c.created_at);
    await f.restart();
    f.visible(true);
    // RECONCILE can recover a submitted child but never authorize the next one.
    snapshot = await f.runner.snapshot();
    await f.runner.reconcile(snapshot.external, { execute: false });
    assert.equal(
      Object.values(f.counts).reduce((a, b) => a + b, 0),
      1
    );
    for (let i = 0; i < components.length + 2; i++) {
      const current = await f.runner.snapshot();
      if (!current.external) break;
      await f.runner.reconcile(current.external, { execute: true });
    }
    state = await providerCall(f.client, 'qualification_snapshot', [...f.args, parent.id]);
    assert.deepEqual(
      state.children.map((c) => c.id),
      originalIds
    );
    assert.deepEqual(
      state.children.map((c) => c.created_at),
      originalTimes
    );
    assert.ok(state.children.every((c) => c.outcome === 'SUCCEEDED'));
    assert.deepEqual(
      Object.values(f.counts),
      components.map(() => 1)
    );
    await f.step();
    snapshot = await f.coordinator.snapshot();
    const selected = snapshot.receipts.VALIDATION;
    assert.equal(selected.data.aggregate_operation_id, parent.id);
    assert.equal(selected.data.component_qualifications.length, components.length);
    assert.deepEqual(
      selected.data.component_qualifications.map((c) => c.operation_id),
      originalIds
    );
    assert.equal(snapshot.queue.release_id, f.first.id);
    await assert.rejects(
      f.admin.query('UPDATE release_ops.qualification_children SET request=$1 WHERE id=$2', [
        {},
        originalIds[0],
      ]),
      /IMMUTABLE/
    );
  });

test('native failed child leaves later components unsubmitted and cannot become a complete selected artifact', async () => {
  const f = await setup([engine, web]);
  for (let i = 0; i < 6; i++) {
    if ((await f.runner.snapshot()).external) break;
    await f.step();
  }
  let parent = (await f.runner.snapshot()).external;
  await f.runner.reconcile(parent, { execute: true });
  f.runs.get(123).run.conclusion = 'failure';
  f.visible(true);
  parent = (await f.runner.snapshot()).external;
  await f.runner.reconcile(parent, { execute: true });
  const state = await providerCall(f.client, 'qualification_snapshot', [...f.args, parent.id]);
  assert.equal(state.children[0].outcome, 'FAILED');
  assert.equal(state.children[1].submitted, false);
  assert.deepEqual(f.counts, { [engine]: 1 });
  const stored = (
    await f.admin.query('SELECT * FROM release_ops.external_operations WHERE id=$1', [parent.id])
  ).rows[0];
  assert.equal(stored.status, 'FAILED');
  assert.deepEqual(
    stored.result.proof.component_qualifications.map((c) => c.outcome),
    ['FAILED', 'NOT_SUBMITTED']
  );
  await assert.rejects(
    call(f.client, 'record_receipt', [
      ...f.args,
      f.first.id,
      parent.id,
      'VALIDATION',
      {
        success: true,
        manifest_digest: parent.intent.manifest_digest,
        receipt_refs: ['forged'],
        aggregate_operation_id: parent.id,
        component_qualifications: stored.result.proof.component_qualifications,
      },
      'native-test',
    ]),
    /AGGREGATE_RECEIPT_REQUIRED/
  );
});

test('forged child archive stays unknown and exact later proof reconciles the original child once', async () => {
  const f = await setup([web]);
  for (let i = 0; i < 6; i++) {
    if ((await f.runner.snapshot()).external) break;
    await f.step();
  }
  let parent = (await f.runner.snapshot()).external;
  await f.runner.reconcile(parent, { execute: true });
  f.visible(true);
  f.forged(true);
  parent = (await f.runner.snapshot()).external;
  await f.runner.reconcile(parent, { execute: true });
  const state = await providerCall(f.client, 'qualification_snapshot', [...f.args, parent.id]);
  assert.equal(state.children[0].outcome, null);
  assert.equal(f.counts[web], 1);
  f.forged(false);
  await f.runner.reconcile((await f.runner.snapshot()).external, { execute: true });
  assert.equal(
    (await f.admin.query('SELECT * FROM release_ops.external_operations WHERE id=$1', [parent.id]))
      .rows[0].status,
    'SUCCEEDED'
  );
  assert.equal(f.counts[web], 1);
});
