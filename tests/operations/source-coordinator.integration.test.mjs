import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCluster } from './postgres-fixture.mjs';
import { call, connect, policy } from '../../operations/release/journal.mjs';
import { ProviderRunner, providerCall } from '../../operations/release/provider-journal.mjs';
import { SourceCoordinator } from '../../operations/release/source-coordinator.mjs';
import { GitHubMergeAdapter } from '../../operations/release/adapters/github.mjs';

const repo = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const target = 'club-arena-engine';
const sha = (x) => x.repeat(40);
const install = { bundle_digest: 'b'.repeat(64), config_digest: 'c'.repeat(64) };
const github = {
  repo,
  controlSha: sha('c'),
  workflowId: 123,
  runtimeImage: `node:22-slim@sha256:${'e'.repeat(64)}`,
};
const migration = new URL(
  '../../supabase/migrations/20260911160341_provider_operation_boundary.sql',
  import.meta.url
);
let cluster;
const connections = new Set();
before(async () => {
  cluster = await createCluster();
});
after(async () => {
  for (const c of connections) await c.end().catch(() => {});
  await cluster.close();
});
async function db(config) {
  const c = await connect(config);
  connections.add(c);
  return c;
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
  const admin = await db(config),
    name = `source_${randomUUID().replaceAll('-', '')}`;
  await admin.query(
    `CREATE ROLE ${name} LOGIN NOSUPERUSER; GRANT release_journal_controller TO ${name}`
  );
  const client = await db({ ...config, user: name });
  let owner = await call(client, 'acquire_owner', [randomUUID(), 'source-test']);
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
      adapters: ['github-merge', 'github-workflow', 'hetzner-intake'],
      github: {
        control_sha: github.controlSha,
        workflow_id: github.workflowId,
        runtime_image: github.runtimeImage,
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
      s.controller.epoch,
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
      'Isolated source phase reconciliation',
    ]);
  }
  await reconcile();
  const intent = (head, pr) => ({
    repository: repo,
    project: 'engine-01',
    target,
    head_sha: head,
    pull_request: pr,
    purpose: 'release',
    manifest: { components: [{ target }] },
    dependencies: [],
  });
  const first = await call(admin, 'enqueue', ['first', intent(sha('a'), 42), 'first-agent']);
  const second = await call(admin, 'enqueue', ['second', intent(sha('d'), 43), 'second-agent']);
  const counts = { validation: 0, merge: 0, build: 0, publish: 0 };
  let merged = false,
    readback = false;
  const merge = new GitHubMergeAdapter({
    repo,
    request: async (path, options) => {
      if (options?.method === 'PUT') {
        counts.merge++;
        merged = true;
        throw new Error('lost merge response');
      }
      if (path.includes('/pulls/'))
        return {
          number: 42,
          state: merged ? 'closed' : 'open',
          merged,
          draft: false,
          base: { repo: { full_name: repo }, ref: 'main', sha: sha('b') },
          head: { sha: sha('a') },
          mergeable: true,
          merge_commit_sha: merged ? sha('f') : sha('e'),
        };
      return {
        sha: merged ? sha('f') : sha('e'),
        tree: { sha: sha('1') },
        parents: merged ? [{ sha: sha('b') }] : [{ sha: sha('b') }, { sha: sha('a') }],
      };
    },
  });
  const workflow = {
    ...github,
    validate() {},
    async preflight() {
      return { control_sha: github.controlSha };
    },
    async submit(r) {
      counts[r.phase.toLowerCase()]++;
      throw new Error('lost dispatch acknowledgement');
    },
    async reconcile(r) {
      if (!readback) return { terminal: false, reason: 'exact run not visible' };
      return {
        terminal: true,
        outcome: 'SUCCEEDED',
        provider_operation_id: '567',
        proof: { artifact: { components: { [target]: { identity: `sha256:${'1'.repeat(64)}` } } } },
      };
    },
  };
  let runner = new ProviderRunner({
    client,
    owner,
    installation: install,
    adapters: { 'github-merge': merge, 'github-workflow': workflow },
  });
  const maintenance = {
    beforePublish: async () => ({ ready: true, operation_id: 'fixture-maintenance' }),
    afterPublish: async () => ({ ready: true, operation_id: 'fixture-maintenance' }),
  };
  let coordinator = new SourceCoordinator({ runner, github, maintenance });
  const tick = () => coordinator.tick({ mode: 'EXECUTE', now: Date.now() + 60000 });
  return {
    admin,
    client,
    config,
    first,
    second,
    counts,
    github,
    intent,
    reconcile,
    tick,
    visible() {
      readback = true;
    },
    get runner() {
      return runner;
    },
    get coordinator() {
      return coordinator;
    },
    async takeover() {
      await client.end();
      const successor = await db({ ...config, user: name });
      owner = await call(successor, 'acquire_owner', [randomUUID(), 'source-successor']);
      runner = new ProviderRunner({
        client: successor,
        owner,
        installation: install,
        adapters: runner.adapters,
      });
      coordinator = new SourceCoordinator({ runner, github, maintenance });
      await reconcile();
    },
  };
}

test('real PG serializes qualification, one exact merge and build; UNKNOWN survives takeover and next PR stays untouched through served certification', async () => {
  const t = await setup();
  assert.equal((await t.tick()).state, 'CLAIMED');
  assert.equal((await t.tick()).state, 'SOURCE_PLAN_PERSISTED');
  await t.tick();
  assert.equal(t.counts.validation, 1);
  await t.takeover();
  await t.tick();
  assert.equal(t.counts.validation, 1);
  assert.equal((await t.coordinator.snapshot()).queue.state, 'UNKNOWN_EXTERNAL_OUTCOME');
  t.visible();
  for (let n = 0; n < 14; n++) await t.tick();
  let s = await t.coordinator.snapshot();
  assert.equal(s.queue.state, 'STAGED');
  assert.deepEqual(t.counts, { validation: 1, merge: 1, build: 1, publish: 0 });
  let inventory = await call(t.admin, 'inspect');
  assert.equal(inventory.controller.active_release, t.first.id);
  assert.equal(inventory.queue.find((q) => q.release_id === t.second.id).state, 'QUEUED');
  assert.equal((await t.tick()).state, 'INSTALLED_STAGING_PROOF_REQUIRED');
  const selected = async (kind, data) => {
    s = await t.coordinator.snapshot();
    await t.coordinator.selected(s.queue, kind, randomUUID(), data);
  };
  await selected('STAGED', {
    build_receipt: s.receipts.BUILD.event_id,
    compatibility_verified: true,
  });
  await t.tick();
  s = await t.coordinator.snapshot();
  const request = {
    target,
    manifest_digest: t.first.manifest_digest,
    source_sha: sha('f'),
    control_sha: sha('c'),
    run_key: '123-1',
    server_tree_sha: sha('2'),
    artifact_image_id: `sha256:${'1'.repeat(64)}`,
    actor: 'native-controller',
    not_after_epoch: Math.floor(Date.now() / 1000) + 1000,
    expected_current: { source_sha: sha('9') },
  };
  await selected('READINESS', {
    stage_receipt: s.receipts.STAGED.event_id,
    technical_gates_passed: true,
    expected_current: request.expected_current,
    provider_requests: { 'hetzner-intake': request },
  });
  t.runner.adapters['hetzner-intake'] = {
    validate() {},
    async preflight() {
      return {};
    },
    async submit() {
      t.counts.publish++;
      return { terminal: false };
    },
    async reconcile() {
      return { terminal: true, outcome: 'SUCCEEDED' };
    },
  };
  for (let n = 0; n < 7; n++) await t.tick();
  s = await t.coordinator.snapshot();
  assert.equal(s.queue.state, 'VERIFYING');
  assert.equal((await t.tick()).state, 'EXACT_SERVED_CERTIFICATION_REQUIRED');
  inventory = await call(t.admin, 'inspect');
  assert.equal(inventory.controller.active_release, t.first.id);
  await selected('CERTIFICATION', {
    build_receipt: s.receipts.BUILD.event_id,
    cleanup_complete: true,
    unchanged_release: true,
    certification_run_id: 'exact-correlated-native-fixture',
    served_components: s.receipts.BUILD.data.artifact.components,
  });
  assert.equal((await t.tick()).state, 'SERVED_CERTIFICATION_SELECTED_AND_VERIFIED');
  assert.equal((await t.tick()).state, 'CLAIMED');
  assert.equal((await t.coordinator.snapshot()).queue.release_id, t.second.id);
});

test('durable authenticated delivery identity deduplicates and rejects content changes through COMMIT', async () => {
  const t = await setup(),
    id = randomUUID(),
    intent = t.intent(sha('a'), 42);
  const args = [id, '1'.repeat(64), 'delivery', intent, 'signed-github-actor'];
  const one = await providerCall(t.admin, 'enqueue_delivery', args);
  assert.equal(one.id, t.first.id);
  assert.deepEqual(await providerCall(t.admin, 'enqueue_delivery', args), one);
  await assert.rejects(
    providerCall(t.admin, 'enqueue_delivery', [id, '2'.repeat(64), ...args.slice(2)]),
    /RELEASE_EVENT_DELIVERY_MISMATCH/
  );
  assert.equal((await call(t.admin, 'inspect')).queue.length, 2);
});

test('source plans reject foreign repository, changed workflow and stale submit authorization', async () => {
  const t = await setup();
  await t.tick();
  await t.tick();
  const s = await t.coordinator.snapshot();
  await assert.rejects(
    providerCall(t.runner.client, 'submit_source_plan', [
      ...t.runner.args(),
      t.first.id,
      'VALIDATION',
      { ...s.plan.request, workflow_id: 124 },
      ...t.runner.installArgs(),
      'source-fixture',
    ]),
    /RELEASE_SOURCE_WORKFLOW_SCOPE_INVALID/
  );
  let paused;
  const barrier = new Promise((r) => {
    paused = r;
  });
  let resume;
  t.runner.adapters['github-workflow'].preflight = async () => {
    paused();
    await new Promise((r) => {
      resume = r;
    });
    return {};
  };
  const predecessor = t.runner;
  const send = predecessor.submit(s.plan, 'begin_source_plan');
  await barrier;
  // Simulate native predecessor losing its database session during preflight.
  await t.takeover();
  resume();
  await assert.rejects(send);
  assert.equal(t.counts.validation, 0);
  assert.equal((await t.coordinator.snapshot()).queue.state, 'UNKNOWN_EXTERNAL_OUTCOME');
});
