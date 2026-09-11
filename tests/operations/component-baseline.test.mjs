import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ComponentBaselineResolver,
  baselineGeneration,
} from '../../operations/release/component-baseline.mjs';
import { ComponentCompatibilityReadiness } from '../../operations/release/mixed-readiness.mjs';

const engine = 'club-arena-engine',
  web = 'club-arena-web',
  targets = [engine, web];
const sha = (c) => c.repeat(40),
  hash = (c) => c.repeat(64);
const component = (c, target) => ({
  source_sha: sha(c),
  identity: `sha256:${hash(c)}`,
  ...(target === web ? { manifest_digest: hash(c) } : {}),
});
function fixture() {
  const q = {
    release_id: randomUUID(),
    attempt_id: randomUUID(),
    resolution_head_sha: sha('c'),
    resolution_manifest_digest: hash('c'),
    resolution_manifest: { components: targets.map((target) => ({ target })) },
  };
  const aggregate = randomUUID();
  const snapshot = {
    queue: q,
    admission: { intent: { target: engine } },
    receipts: {
      INTEGRATION: { data: { expected_base_sha: sha('b'), merged_tree_sha: sha('c') } },
      BUILD: {
        event_id: randomUUID(),
        data: {
          aggregate_operation_id: aggregate,
          source_sha: sha('c'),
          artifact: {
            components: Object.fromEntries(
              targets.map((target, i) => [
                target,
                {
                  ...component('c', target),
                  build_operation_id: randomUUID(),
                  qualification_result_event: randomUUID(),
                  build_run_id: String(30 + i),
                  github_artifact_id: String(40 + i),
                  github_archive_digest: `sha256:${hash('d')}`,
                  aggregate_operation_id: aggregate,
                },
              ])
            ),
          },
        },
      },
    },
  };
  const before = Object.fromEntries(targets.map((target) => [target, component('b', target)]));
  const retained = Object.fromEntries(
    targets.map((target, i) => [
      target,
      {
        target,
        ...before[target],
        build_run_id: String(20 + i),
        artifact_id: String(22 + i),
        archive_digest: `sha256:${hash('e')}`,
      },
    ])
  );
  const completed = {
    version: 1,
    release_id: q.release_id,
    attempt_id: q.attempt_id,
    origin: 'completed',
    baseline_release_id: randomUUID(),
    baseline_event_id: randomUUID(),
    generation_event_id: randomUUID(),
    generation_event_no: 50,
    certificate_operation_id: randomUUID(),
    cleanup_receipt: randomUUID(),
    before_components: before,
    retained_artifacts: retained,
  };
  const contract = {
    version: 1,
    cutover_order: targets,
    schema: {
      fixture_sha256: hash('a'),
      catalogue_digest: hash('b'),
      database_contract_digest: hash('c'),
      artifact_id: '2',
      archive_digest: `sha256:${hash('a')}`,
      build_run_id: '1',
    },
    // Stale bootstrap is deliberate: certified receipt ancestry must replace it.
    before_components: Object.fromEntries(
      targets.map((target) => [target, component('a', target)])
    ),
    retained_artifacts: Object.fromEntries(
      targets.map((target) => [
        target,
        {
          ...component('a', target),
          build_run_id: '1',
          artifact_id: '2',
          archive_digest: `sha256:${hash('a')}`,
        },
      ])
    ),
  };
  let durable = completed,
    observed = before,
    reads = 0;
  const resolver = new ComponentBaselineResolver({
    resolve: async () => {
      reads++;
      return structuredClone(durable);
    },
    observe: async () => structuredClone(observed),
    bootstrap: contract,
  });
  const readiness = new ComponentCompatibilityReadiness({
    contract,
    resolveBaseline: (s) => resolver.read(s),
    qualifier: { verify() {} },
  });
  return {
    snapshot,
    completed,
    contract,
    resolver,
    readiness,
    setDurable: (v) => {
      durable = v;
    },
    setObserved: (v) => {
      observed = v;
    },
    get reads() {
      return reads;
    },
  };
}
async function freeze(f) {
  const { plan } = await f.readiness.qualification(f.snapshot);
  const event = randomUUID(),
    id = randomUUID();
  f.snapshot.compatibility_plan = {
    id,
    event_id: event,
    attempt_id: f.snapshot.queue.attempt_id,
    phase: 'COMPATIBILITY',
    request: { qualification: plan },
  };
  const frozen = {
    ...f.completed,
    origin: 'attempt',
    baseline_release_id: f.snapshot.queue.release_id,
    baseline_event_id: event,
    generation_event_id: event,
    generation_event_no: 80,
    plan_id: id,
    captured_baseline: plan.baseline,
    readiness_event_id: null,
    publication_results: [],
    pending_external: [],
  };
  delete frozen.certificate_operation_id;
  delete frozen.cleanup_receipt;
  f.setDurable(frozen);
  return { plan, frozen };
}
function publishEngine(f, frozen) {
  const built = f.snapshot.receipts.BUILD.data.artifact.components[engine];
  const request = {
    target: engine,
    source_sha: built.source_sha,
    artifact_image_id: built.identity,
  };
  const ready = randomUUID();
  f.snapshot.receipts.READINESS = {
    event_id: ready,
    data: { provider_requests: { 'hetzner-intake': request } },
  };
  const operation = {
    id: randomUUID(),
    epoch: randomUUID(),
    kind: 'PUBLISH',
    status: 'SUCCEEDED',
    readiness_event: ready,
    intent: {
      target: engine,
      adapter: 'hetzner-intake',
      manifest_digest: f.snapshot.queue.resolution_manifest_digest,
      provider_request: request,
    },
    result: {
      outcome: 'SUCCEEDED',
      source_sha: built.source_sha,
      image_id: built.identity,
      result: 'sealed',
    },
  };
  frozen.readiness_event_id = ready;
  frozen.publication_results = [operation];
  f.setObserved({ ...frozen.before_components, [engine]: component('c', engine) });
  f.setDurable(frozen);
  return operation;
}

test('consecutive certified releases replace stale bootstrap provenance without relabeling the installed contract', async () => {
  const f = fixture(),
    original = structuredClone(f.contract);
  const one = await f.readiness.qualification(f.snapshot);
  assert.equal(one.before[engine].source_sha, sha('b'));
  assert.equal(
    one.plan.artifact_inputs[Object.keys(one.plan.artifact_inputs)[0]].build_run_id,
    '20'
  );
  assert.deepEqual(one.plan.baseline, baselineGeneration(f.completed));
  const next = {
    ...f.completed,
    baseline_release_id: randomUUID(),
    baseline_event_id: randomUUID(),
    generation_event_id: randomUUID(),
    generation_event_no: 99,
    certificate_operation_id: randomUUID(),
    cleanup_receipt: randomUUID(),
    before_components: Object.fromEntries(
      targets.map((target) => [target, component('d', target)])
    ),
    retained_artifacts: Object.fromEntries(
      targets.map((target, i) => [
        target,
        {
          target,
          ...component('d', target),
          build_run_id: String(50 + i),
          artifact_id: String(60 + i),
          archive_digest: `sha256:${hash('f')}`,
        },
      ])
    ),
  };
  f.setDurable(next);
  f.setObserved(next.before_components);
  const two = await f.readiness.qualification(f.snapshot);
  assert.equal(two.before[web].source_sha, sha('d'));
  assert.equal(two.plan.baseline.generation_event_no, 99);
  assert.equal(
    Object.values(two.plan.artifact_inputs).find(
      (part) => part.source_sha === sha('d') && part.target === engine
    ).build_run_id,
    '50'
  );
  assert.deepEqual(f.contract, original);
  assert.equal(f.reads, 4, 'each native observation brackets a fresh durable generation read');
});

test('frozen attempt keeps tuple zero and original artifacts after exact engine prefix and process restart', async () => {
  const f = fixture(),
    { plan, frozen } = await freeze(f);
  const enginePublication = publishEngine(f, frozen);
  const resolved = await f.resolver.read(f.snapshot);
  assert.equal(resolved.expected_current[engine].source_sha, sha('c'));
  assert.equal(resolved.before_components[engine].source_sha, sha('b'));
  assert.equal(resolved.retained_artifacts[engine].build_run_id, '20');
  assert.equal(resolved.publication_prefix[0].operation_id, enginePublication.id);
  assert.deepEqual((await f.readiness.qualification(f.snapshot)).plan, plan);
  const restarted = new ComponentCompatibilityReadiness({
    contract: { ...f.contract, before_components: undefined, retained_artifacts: undefined },
    resolveBaseline: (s) =>
      new ComponentBaselineResolver({
        resolve: async () => structuredClone(frozen),
        observe: async () => resolved.expected_current,
      }).read(s),
    qualifier: { verify() {} },
  });
  assert.deepEqual((await restarted.qualification(f.snapshot)).plan, plan);
});

test('complete owned prefix retains the same attempt plan before the next web-only baseline advances', async () => {
  const f = fixture(),
    { plan, frozen } = await freeze(f);
  publishEngine(f, frozen);
  const built = f.snapshot.receipts.BUILD.data.artifact.components[web];
  const request = { target: web, source_sha: built.source_sha, artifact: built };
  f.snapshot.receipts.READINESS.data.provider_requests['github-static'] = request;
  frozen.publication_results.push({
    id: randomUUID(),
    epoch: randomUUID(),
    kind: 'PUBLISH',
    status: 'SUCCEEDED',
    readiness_event: frozen.readiness_event_id,
    intent: {
      target: web,
      adapter: 'github-static',
      manifest_digest: f.snapshot.queue.resolution_manifest_digest,
      provider_request: request,
    },
    result: { outcome: 'SUCCEEDED', proof: { component: built, publication_claim: randomUUID() } },
  });
  const final = Object.fromEntries(targets.map((target) => [target, component('c', target)]));
  f.setObserved(final);
  f.setDurable(frozen);
  const complete = await f.resolver.read(f.snapshot);
  assert.equal(complete.publication_prefix.length, 2);
  assert.deepEqual((await f.readiness.qualification(f.snapshot)).plan, plan);
  const next = structuredClone(f.snapshot);
  delete next.compatibility_plan;
  delete next.receipts.READINESS;
  next.queue.release_id = randomUUID();
  next.queue.attempt_id = randomUUID();
  next.queue.resolution_manifest.components = [{ target: web }];
  const durable = {
    ...f.completed,
    release_id: next.queue.release_id,
    attempt_id: next.queue.attempt_id,
    before_components: final,
    retained_artifacts: Object.fromEntries(
      targets.map((target) => {
        const artifact = f.snapshot.receipts.BUILD.data.artifact.components[target];
        return [
          target,
          {
            target,
            ...final[target],
            build_run_id: artifact.build_run_id,
            artifact_id: artifact.github_artifact_id,
            archive_digest: artifact.github_archive_digest,
          },
        ];
      })
    ),
  };
  f.setDurable(durable);
  const result = await f.readiness.qualification(next);
  assert.deepEqual(result.plan.cutover_order, [web]);
  assert.deepEqual(result.plan.tuples[0], final);
  assert.equal(result.plan.tuples[1][engine].identity, final[engine].identity);
});

test('unknown, failed, skipped-prefix and changed publication identities refuse before native observation', async () => {
  for (const mutation of [
    (r) => (r.pending_external = [{ id: randomUUID(), status: 'UNKNOWN', kind: 'PUBLISH' }]),
    (r) => (r.publication_results[0].status = 'FAILED'),
    (r) => (r.publication_results[0].result.image_id = `sha256:${hash('f')}`),
    (r) => (r.publication_results[0].readiness_event = randomUUID()),
    (r) => r.publication_results.push(structuredClone(r.publication_results[0])),
    (r) => (r.publication_results[0].intent.target = web),
  ]) {
    const f = fixture(),
      { frozen } = await freeze(f);
    publishEngine(f, frozen);
    mutation(frozen);
    let observed = 0;
    const resolver = new ComponentBaselineResolver({
      resolve: async () => frozen,
      observe: async () => {
        observed++;
        return frozen.before_components;
      },
    });
    await assert.rejects(resolver.read(f.snapshot), /RELEASE_COMPONENT_BASELINE_/);
    assert.equal(observed, 0);
  }
});

test('missing ancestry, unproven cleanup, external native drift and generation changes all refuse', async () => {
  for (const mutation of [
    (r) => delete r.retained_artifacts[web],
    (r) => (r.retained_artifacts[engine].artifact_id = '?'),
    (r) => (r.cleanup_receipt = null),
    (r) => (r.before_components[web].manifest_digest = hash('a')),
  ]) {
    const f = fixture();
    const value = structuredClone(f.completed);
    mutation(value);
    f.setDurable(value);
    await assert.rejects(f.resolver.read(f.snapshot), /RELEASE_COMPONENT_BASELINE_/);
  }
  const f = fixture();
  f.setObserved({ ...f.completed.before_components, [engine]: component('e', engine) });
  await assert.rejects(f.resolver.read(f.snapshot), /BASELINE_NATIVE_DRIFT/);
  let calls = 0;
  const resolver = new ComponentBaselineResolver({
    resolve: async () => ({ ...f.completed, generation_event_no: ++calls === 1 ? 50 : 51 }),
    observe: async () => f.completed.before_components,
  });
  await assert.rejects(resolver.read(f.snapshot), /BASELINE_GENERATION_CHANGED/);
});

test('bootstrap requires explicit native-matching artifacts and never replaces frozen or certified history', async () => {
  const f = fixture();
  const bootstrap = {
    version: 1,
    release_id: f.snapshot.queue.release_id,
    attempt_id: f.snapshot.queue.attempt_id,
    origin: 'bootstrap',
    baseline_event_id: null,
    baseline_release_id: null,
    generation_event_id: null,
    generation_event_no: null,
  };
  f.setDurable(bootstrap);
  f.setObserved(f.contract.before_components);
  const value = await f.resolver.read(f.snapshot);
  assert.deepEqual(value.before_components, f.contract.before_components);
  const missing = new ComponentBaselineResolver({
    resolve: async () => bootstrap,
    observe: async () => f.contract.before_components,
  });
  await assert.rejects(missing.read(f.snapshot), /BOOTSTRAP_BASELINE_REQUIRED/);
  f.snapshot.compatibility_plan = { id: randomUUID() };
  await assert.rejects(f.resolver.read(f.snapshot), /BASELINE_GENERATION_REQUIRED/);
});
