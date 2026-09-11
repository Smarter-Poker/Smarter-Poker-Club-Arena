import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { receiptZip } from './static-artifact-fixture.mjs';
import {
  compatibilityPlan,
  GitHubComponentCompatibility,
} from '../../operations/release/component-compatibility.mjs';
import { ComponentCompatibilityReadiness } from '../../operations/release/mixed-readiness.mjs';
const sha = (c) => c.repeat(40),
  hash = (c) => c.repeat(64),
  engine = 'club-arena-engine',
  web = 'club-arena-web';
const component = (source, target) => ({
  source_sha: sha(source),
  identity: `sha256:${hash(source)}`,
  ...(target === web ? { manifest_digest: hash(source) } : {}),
});
function fixture() {
  const aggregate = randomUUID();
  const built = (target) => ({
    ...component('b', target),
    build_operation_id: randomUUID(),
    qualification_result_event: randomUUID(),
    build_run_id: '7',
    github_artifact_id: target === engine ? '8' : '9',
    github_archive_digest: `sha256:${hash('c')}`,
    aggregate_operation_id: aggregate,
  });
  const snapshot = {
    queue: {
      release_id: randomUUID(),
      resolution_head_sha: sha('b'),
      resolution_manifest_digest: hash('a'),
      resolution_manifest: { components: [{ target: engine }, { target: web }] },
    },
    admission: { intent: { target: engine } },
    receipts: {
      INTEGRATION: { data: { expected_base_sha: sha('a'), merged_tree_sha: sha('d') } },
      BUILD: {
        event_id: randomUUID(),
        data: {
          aggregate_operation_id: aggregate,
          source_sha: sha('b'),
          artifact: { components: { [engine]: built(engine), [web]: built(web) } },
        },
      },
    },
  };
  const before = { [engine]: component('a', engine), [web]: component('a', web) };
  const contract = {
    version: 1,
    cutover_order: [engine, web],
    schema: {
      fixture_sha256: hash('a'),
      catalogue_digest: hash('b'),
      database_contract_digest: hash('c'),
      artifact_id: '11',
      archive_digest: `sha256:${hash('d')}`,
      build_run_id: '10',
    },
    retained_artifacts: Object.fromEntries(
      [engine, web].map((target, i) => [
        target,
        {
          ...before[target],
          artifact_id: String(20 + i),
          build_run_id: '19',
          archive_digest: `sha256:${hash('e')}`,
        },
      ])
    ),
  };
  return { snapshot, before, contract };
}
const config = {
  repositoryId: '12',
  workflowId: 13,
  workflowPath: '.github/workflows/release-component-qualification.yml',
  controlRef: 'heads/release-controls',
  controlSha: sha('c'),
  runtimeImage: `registry.example/fixture@sha256:${hash('d')}`,
};

test('one installed compatibility order supports web-only and mixed releases without changing the contract', async () => {
  const f = fixture();
  const originalContract = structuredClone(f.contract);
  const readiness = new ComponentCompatibilityReadiness({
    contract: f.contract,
    readBefore: async () => f.before,
    qualifier: { verify() {} },
  });
  const webOnly = structuredClone(f.snapshot);
  webOnly.queue.resolution_manifest.components = [{ target: web }];
  delete webOnly.receipts.BUILD.data.artifact.components[engine];
  const { plan: webPlan } = await readiness.qualification(webOnly);
  assert.deepEqual(webPlan.cutover_order, [web]);
  assert.deepEqual(
    webPlan.tuples.map((tuple) => [tuple[engine].source_sha, tuple[web].source_sha]),
    [
      [sha('a'), sha('a')],
      [sha('a'), sha('b')],
    ]
  );
  f.snapshot.queue.resolution_manifest.components.reverse();
  const { plan: mixedPlan } = await readiness.qualification(f.snapshot);
  assert.deepEqual(mixedPlan.cutover_order, [engine, web]);
  assert.deepEqual(
    mixedPlan.tuples.map((tuple) => [tuple[engine].source_sha, tuple[web].source_sha]),
    [
      [sha('a'), sha('a')],
      [sha('b'), sha('a')],
      [sha('b'), sha('b')],
    ]
  );
  assert.deepEqual(f.contract, originalContract);
});

test('invalid or missing installed compatibility order is refused before native reads', async () => {
  const f = fixture();
  let reads = 0;
  for (const cutover_order of [
    undefined,
    null,
    [],
    [web, engine],
    [engine, engine, web],
    [engine, web, 'foreign'],
    [web],
  ]) {
    const readiness = new ComponentCompatibilityReadiness({
      contract: { ...f.contract, cutover_order },
      readBefore: async () => {
        reads++;
        return f.before;
      },
      qualifier: { verify() {} },
    });
    await assert.rejects(readiness.qualification(f.snapshot), /COMPONENT_CUTOVER_ORDER_REQUIRED/);
  }
  assert.equal(reads, 0);
});

test('plan preserves exact before/intermediate/after states and retains original artifact provenance', () => {
  const f = fixture(),
    plan = compatibilityPlan(f.snapshot, f.before, f.contract);
  assert.equal(plan.tuples.length, 3);
  assert.equal(Object.keys(plan.artifact_inputs).length, 4);
  assert.deepEqual(
    plan.tuples.map((t) => [t[engine].source_sha, t[web].source_sha]),
    [
      [sha('a'), sha('a')],
      [sha('b'), sha('a')],
      [sha('b'), sha('b')],
    ]
  );
  delete f.contract.retained_artifacts[web];
  assert.throws(
    () => compatibilityPlan(f.snapshot, f.before, f.contract),
    /RETAINED_COMPONENT_ARTIFACT_REQUIRED/
  );
});

test('owned dispatch uses current pinned control ref and response loss is reconciled without another dispatch', async () => {
  const f = fixture(),
    plan = compatibilityPlan(f.snapshot, f.before, f.contract),
    operation = { id: randomUUID() };
  let submissions = 0,
    changed = false;
  const adapter = new GitHubComponentCompatibility({
    ...config,
    request: async (route, options) => {
      if (route.endsWith('/dispatches')) {
        submissions++;
        assert.equal(options.body.ref, 'release-controls');
        assert.equal(options.body.inputs.operation_id, operation.id);
        throw new Error('lost response after accepted request');
      }
      if (route.includes('/git/ref/'))
        return { object: { type: 'commit', sha: changed ? sha('e') : config.controlSha } };
      if (route.includes('/runs?')) return { total_count: 0, workflow_runs: [] };
      return { id: config.workflowId, path: config.workflowPath, state: 'active' };
    },
  });
  const request = adapter.requestFor(plan, f.snapshot);
  await assert.rejects(adapter.submit(request, operation), /lost response/);
  assert.equal(
    (await adapter.reconcile(request, operation)).reason,
    'COMPATIBILITY_RUN_NOT_VISIBLE'
  );
  assert.equal((await adapter.reconcile(request, operation)).terminal, false);
  assert.equal(submissions, 1);
  changed = true;
  await assert.rejects(adapter.preflight(request), /CONTROL_CHANGED/);
});

test('failed or ambiguous run cannot be upgraded to a passing semantic receipt', async () => {
  const f = fixture(),
    plan = compatibilityPlan(f.snapshot, f.before, f.contract),
    id = randomUUID();
  const run = {
    id: 42,
    workflow_id: 13,
    path: config.workflowPath,
    head_sha: config.controlSha,
    event: 'workflow_dispatch',
    display_title: `release:${id}:COMPATIBILITY`,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'failure',
    repository: { id: 12 },
    head_repository: { id: 12 },
  };
  let duplicate = false;
  let cleanup;
  const adapter = new GitHubComponentCompatibility({
    ...config,
    request: async (route) => {
      if (route.includes('/runs?'))
        return { total_count: duplicate ? 2 : 1, workflow_runs: duplicate ? [run, run] : [run] };
      if (route.endsWith('/runs/42')) return run;
      if (route.endsWith('/runs/42/artifacts?per_page=100'))
        return {
          total_count: cleanup ? 1 : 0,
          artifacts: cleanup
            ? [
                {
                  id: 50,
                  name: `release-compatibility-cleanup-${id}`,
                  expired: false,
                  digest: `sha256:${createHash('sha256').update(cleanup).digest('hex')}`,
                },
              ]
            : [],
        };
      if (route.endsWith('/artifacts/50/zip')) return cleanup;
      return { id: 13, path: config.workflowPath, state: 'active' };
    },
  });
  assert.equal(
    (await adapter.reconcile(adapter.requestFor(plan, f.snapshot), { id })).reason,
    'COMPATIBILITY_FAILURE_CLEANUP_UNPROVEN'
  );
  await assert.rejects(adapter.verify(plan, id), /SEMANTIC_QUALIFICATION_REQUIRED/);
  const { factDigest } = await import('../../operations/release/component-certificate.mjs');
  const cleanupReport = {
    version: 1,
    operation_id: id,
    run_id: '42',
    run_attempt: 1,
    request_digest: factDigest(plan),
    complete: true,
    images_removed: true,
    fixtures: [
      { index: 0, tuple_digest: factDigest(plan.tuples[0]), complete: true, remaining_objects: 0 },
    ],
  };
  cleanup = receiptZip(cleanupReport);
  assert.equal(
    (await adapter.reconcile(adapter.requestFor(plan, f.snapshot), { id })).outcome,
    'FAILED'
  );
  cleanup = receiptZip({ ...cleanupReport, images_removed: false });
  assert.equal(
    (await adapter.reconcile(adapter.requestFor(plan, f.snapshot), { id })).terminal,
    false
  );
  duplicate = true;
  await assert.rejects(adapter.verify(plan, id), /RUN_AMBIGUOUS/);
});
