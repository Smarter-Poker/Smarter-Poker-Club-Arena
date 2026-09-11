import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCluster } from './postgres-fixture.mjs';
import { call, connect } from '../../operations/release/journal.mjs';
import { factDigest, fixtureSlots } from '../../operations/release/component-certificate.mjs';
import {
  ComponentBaselineResolver,
  baselineGeneration,
} from '../../operations/release/component-baseline.mjs';

const engine = 'club-arena-engine',
  web = 'club-arena-web',
  repo = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const sha = (c) => c.repeat(40),
  digest = (c) => c.repeat(64);
const migrations = [
  '20260911160341_provider_operation_boundary.sql',
  '20260911190350_component_certification_and_durable_fixture_claims.sql',
  '20260911192023_bind_existing_static_publisher_to_private_release_journal.sql',
  '20260911194548_aggregate_component_qualification_under_one_release_operatio.sql',
  '20260911210645_resolve_continuous_component_baselines_from_owned_certificat.sql',
].map((name) => new URL('../../supabase/migrations/' + name, import.meta.url));
let cluster;
const clients = new Set();
before(async () => {
  cluster = await createCluster();
});
afterEach(async () => {
  for (const c of clients) await c.end().catch(() => {});
  clients.clear();
});
after(async () => {
  await cluster.close();
});
async function open(config) {
  const c = await connect(config);
  clients.add(c);
  return c;
}
function identity(c, target) {
  return {
    source_sha: sha(c),
    identity: 'sha256:' + digest(c),
    ...(target === web ? { manifest_digest: digest(c) } : {}),
  };
}
function bootstrap() {
  return {
    before_components: { [engine]: identity('1', engine), [web]: identity('1', web) },
    retained_artifacts: Object.fromEntries(
      [engine, web].map((target, i) => [
        target,
        {
          target,
          ...identity('1', target),
          build_run_id: String(10 + i),
          artifact_id: String(20 + i),
          archive_digest: 'sha256:' + digest('2'),
        },
      ])
    ),
  };
}

// Deliberately synthetic journal history, inserted by this disposable cluster's
// administrator. This suite proves the real SQL read/admission boundary and
// corruption refusals, not provider execution, native serving or product tests.
async function setup() {
  const config = await cluster.database({ additionalMigrations: migrations }),
    admin = await open(config);
  const principal = 'baseline_' + randomUUID().replaceAll('-', '');
  await admin.query(
    `CREATE ROLE ${principal} LOGIN; GRANT release_journal_controller TO ${principal}`
  );
  const client = await open({ ...config, user: principal }),
    owner = await call(client, 'acquire_owner', [randomUUID(), 'baseline-fixture']);
  const f = { admin, client, config, owner, principal, sequence: 0, seed: bootstrap() };
  f.insert = async (table, row) => {
    const keys = Object.keys(row);
    await admin.query(
      `INSERT INTO release_ops.${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
      keys.map((k) => row[k])
    );
  };
  f.event = async (release, kind = 'FIXTURE', data = {}) =>
    (
      await admin.query('SELECT release_ops.event($1,$2,$3,$4) AS id', [
        release,
        kind,
        'synthetic-baseline-boundary',
        data,
      ])
    ).rows[0].id;
  f.replica = async (fn) => {
    await admin.query("SET session_replication_role='replica'");
    try {
      return await fn();
    } finally {
      await admin.query("SET session_replication_role='origin'");
    }
  };
  f.install = randomUUID();
  await f.insert('provider_installations', {
    id: f.install,
    bundle_digest: digest('b'),
    binding: {
      config_digest: digest('c'),
      controller_principal: principal,
      github: { control_sha: sha('c') },
      compatibility: { bootstrap: f.seed },
    },
    evidence: { synthetic: true },
    principal: 'fixture',
    event_id: await f.event(null),
  });
  await admin.query('UPDATE release_ops.controller SET installed_adapter_receipt=$1', [f.install]);
  f.release = async (components = [engine, web], state = 'STAGED') => {
    const id = randomUUID(),
      attempt = randomUUID(),
      seq = ++f.sequence,
      manifest = { components: components.map((target) => ({ target })) };
    await f.insert('admissions', {
      id,
      admission_seq: seq,
      canonical_digest: digest(String(seq)),
      manifest_digest: digest('a'),
      intent: { repository: repo, target: components[0], manifest },
      principal: 'fixture',
      actor: 'fixture',
    });
    await f.insert('queue', {
      release_id: id,
      queue_order: seq,
      state,
      attempt_id: attempt,
      attempt_deadline: new Date(Date.now() + 3600000),
      resolution_head_sha: sha('a'),
      resolution_manifest: manifest,
      resolution_manifest_digest: digest('a'),
    });
    return { id, attempt, manifest };
  };
  f.activate = async (release) =>
    admin.query('UPDATE release_ops.controller SET active_release=$1', [release.id]);
  f.resolve = async (release) =>
    (
      await client.query('SELECT release_ops.component_compatibility_baseline($1) AS value', [
        release.id,
      ])
    ).rows[0].value;
  f.operation = async (
    release,
    kind,
    adapter,
    request,
    { status = 'SUCCEEDED', result = {}, planId = randomUUID() } = {}
  ) => {
    const id = randomUUID(),
      intent = {
        adapter,
        target: request.target,
        manifest_digest: digest('a'),
        provider_request: request,
        plan_id: planId,
      };
    const intentEvent = await f.event(release.id, 'EXTERNAL_INTENT', intent);
    await f.insert('external_operations', {
      id,
      release_id: release.id,
      operation_key: id,
      owner_id: f.owner.owner_id,
      epoch: f.owner.epoch,
      kind,
      intent,
      intent_event: intentEvent,
      resume_state: 'STAGED',
      status,
      result,
      terminal_event:
        status === 'SUCCEEDED' ? await f.event(release.id, 'EXTERNAL_SUCCEEDED') : null,
    });
    await f.insert('provider_submissions', {
      operation_id: id,
      installation_id: f.install,
      owner_id: f.owner.owner_id,
      epoch: f.owner.epoch,
      event_id: await f.event(release.id),
    });
    return { id, kind, epoch: f.owner.epoch, status, intent, result };
  };
  f.complete = async ({ changed = [engine, web], c = '3', previous } = {}) =>
    f.replica(async () => {
      const release = await f.release(changed, 'VERIFIED'),
        buildEvent = await f.event(release.id),
        readyEvent = await f.event(release.id);
      const buildPlan = randomUUID(),
        request = { phase: 'BUILD', source_sha: sha(c), components: changed };
      await f.insert('source_plans', {
        id: buildPlan,
        release_id: release.id,
        attempt_id: release.attempt,
        phase: 'BUILD',
        adapter: 'component-aggregate',
        request,
        event_id: await f.event(release.id),
      });
      const parent = await f.operation(release, 'BUILD', 'component-aggregate', request, {
          planId: buildPlan,
        }),
        artifacts = {};
      for (const [index, target] of changed.entries()) {
        const child = randomUUID(),
          resultEvent = await f.event(release.id),
          run = String(100 * f.sequence + index);
        const artifact = {
          ...identity(c, target),
          build_operation_id: child,
          build_run_id: run,
          github_artifact_id: String(200 * f.sequence + index),
          github_archive_digest: 'sha256:' + digest('d'),
          aggregate_operation_id: parent.id,
          qualification_result_event: resultEvent,
        };
        artifacts[target] = artifact;
        await f.insert('qualification_children', {
          id: child,
          parent_id: parent.id,
          target,
          adapter: target === engine ? 'github-workflow' : 'github-static',
          request: { source_sha: sha(c) },
          event_id: await f.event(release.id),
        });
        await f.insert('qualification_submissions', {
          child_id: child,
          owner_id: f.owner.owner_id,
          epoch: f.owner.epoch,
          event_id: await f.event(release.id),
        });
        await f.insert('qualification_results', {
          child_id: child,
          outcome: 'SUCCEEDED',
          result: {
            provider_operation_id: run,
            proof: { artifact: { components: { [target]: artifact } } },
          },
          event_id: resultEvent,
        });
      }
      await admin.query('UPDATE release_ops.external_operations SET result=$2 WHERE id=$1', [
        parent.id,
        { proof: { artifact: { components: artifacts } } },
      ]);
      await f.insert('receipts', {
        release_id: release.id,
        receipt_key: 'BUILD',
        kind: 'BUILD',
        event_id: buildEvent,
        data: {
          success: true,
          source_sha: sha(c),
          aggregate_operation_id: parent.id,
          artifact: { components: artifacts },
        },
      });
      await f.insert('receipts', {
        release_id: release.id,
        receipt_key: 'READINESS',
        kind: 'READINESS',
        event_id: readyEvent,
        data: { success: true },
      });
      const tuple = {},
        publications = {};
      for (const target of [engine, web]) {
        if (!changed.includes(target)) {
          tuple[target] = {
            ...previous.tuple[target],
            mode: 'retained',
            verified_receipt_id: previous.certEvent,
            compatibility_receipt_id: readyEvent,
          };
          delete tuple[target].publication_operation_id;
          continue;
        }
        const artifact = artifacts[target],
          adapter = target === engine ? 'hetzner-intake' : 'github-static',
          planId = randomUUID();
        const pubRequest = {
          target,
          source_sha: sha(c),
          ...(target === engine
            ? { artifact_image_id: artifact.identity, run_key: artifact.build_run_id + '-1' }
            : {
                artifact,
                build_operation_id: artifact.build_operation_id,
                build_run_id: artifact.build_run_id,
              }),
        };
        await f.insert('provider_plans', {
          id: planId,
          release_id: release.id,
          operation_key: planId,
          adapter,
          request: pubRequest,
          readiness_event: readyEvent,
          event_id: await f.event(release.id),
          event_no: 1,
        });
        const result = {
          outcome: 'SUCCEEDED',
          ...(target === engine
            ? { source_sha: sha(c), image_id: artifact.identity, result: 'sealed' }
            : { proof: { component: artifact, publication_claim: randomUUID() } }),
        };
        const pub = await f.operation(release, 'PUBLISH', adapter, pubRequest, { planId, result });
        publications[target] = pub;
        tuple[target] = {
          ...identity(c, target),
          mode: 'changed',
          publication_operation_id: pub.id,
        };
      }
      const certPlan = randomUUID(),
        certRequest = {
          certificate_version: 2,
          component_tuple: tuple,
          manifest_digest: digest('a'),
        };
      await f.insert('source_plans', {
        id: certPlan,
        release_id: release.id,
        attempt_id: release.attempt,
        phase: 'CERTIFY',
        adapter: 'github-certification',
        request: certRequest,
        event_id: await f.event(release.id),
      });
      const cert = await f.operation(release, 'CERTIFY', 'github-certification', certRequest, {
          planId: certPlan,
        }),
        accounts = {};
      for (const slot of fixtureSlots) {
        const user_id = randomUUID(),
          email = user_id + '@example.invalid';
        accounts[slot] = {
          user_id,
          email,
          auth_absent: true,
          resources_absent: true,
          evidence_sha256: digest('e'),
        };
        await f.insert('certification_fixture_intents', {
          plan_id: certPlan,
          slot,
          user_id,
          email,
          event_id: await f.event(release.id),
        });
      }
      const runId = String(900 + f.sequence),
        cleanupEvent = await f.event(release.id),
        cleanup = { operation_id: cert.id, run_id: runId, run_attempt: 1, accounts };
      await f.insert('certification_run_claims', {
        operation_id: cert.id,
        run_id: runId,
        identity: {},
        event_id: await f.event(release.id),
      });
      await f.insert('certification_cleanup_barriers', {
        operation_id: cert.id,
        event_id: await f.event(release.id),
      });
      await f.insert('certification_cleanup_receipts', {
        operation_id: cert.id,
        event_id: cleanupEvent,
        data: cleanup,
      });
      const proof = {
        operation_id: cert.id,
        request: certRequest,
        success: true,
        cleanup_receipt: cleanupEvent,
        served_components: tuple,
        cleanup_complete: true,
        unchanged_release: true,
      };
      await admin.query('UPDATE release_ops.external_operations SET result=$2 WHERE id=$1', [
        cert.id,
        { provider_operation_id: runId, proof },
      ]);
      const certEvent = await f.event(release.id);
      await f.insert('receipts', {
        release_id: release.id,
        receipt_key: 'CERTIFICATION',
        kind: 'CERTIFICATION',
        event_id: certEvent,
        data: { ...proof, build_receipt: buildEvent },
      });
      await admin.query('UPDATE release_ops.queue SET selected_receipts=$2 WHERE release_id=$1', [
        release.id,
        { BUILD: buildEvent, READINESS: readyEvent, CERTIFICATION: certEvent },
      ]);
      const generation = await f.event(release.id, 'STATE_VERIFIED', { state_version: 1 });
      return {
        ...release,
        tuple,
        artifacts,
        buildEvent,
        readyEvent,
        certEvent,
        cert,
        cleanupEvent,
        cleanup,
        generation,
        publications,
      };
    });
  return f;
}

test('consecutive certificates select latest completed tuple and exact retained original child ancestry', async () => {
  const f = await setup(),
    first = await f.complete(),
    second = await f.complete({ changed: [web], c: '4', previous: first }),
    active = await f.release();
  await f.activate(active);
  const result = await f.resolve(active);
  assert.equal(result.origin, 'completed');
  assert.equal(result.baseline_event_id, second.certEvent);
  assert.equal(result.generation_event_id, second.generation);
  assert.equal(result.cleanup_receipt, second.cleanupEvent);
  assert.equal(
    result.retained_artifacts[engine].build_run_id,
    first.artifacts[engine].build_run_id
  );
  assert.equal(result.retained_artifacts[web].build_run_id, second.artifacts[web].build_run_id);
  assert.deepEqual(result.retained_artifacts[engine].ancestry, [second.certEvent, first.certEvent]);
  const resolver = new ComponentBaselineResolver({
    resolve: () => f.resolve(active),
    observe: async (expected) => expected,
  });
  const resolved = await resolver.read({
    queue: { release_id: active.id, attempt_id: active.attempt },
  });
  assert.equal(resolved.before_components[engine].source_sha, sha('3'));
  assert.equal(resolved.before_components[web].source_sha, sha('4'));
  await assert.rejects(f.resolve(first), /READER_SCOPE_REQUIRED/);
});

test('absent cleanup, ambiguous receipts, foreign artifact and cyclic retained ancestry cannot become a baseline', async () => {
  const f = await setup(),
    first = await f.complete(),
    second = await f.complete({ changed: [web], c: '4', previous: first }),
    active = await f.release();
  await f.activate(active);
  async function mutation(sql, args, restore, restoreArgs, reason) {
    await f.replica(() => f.admin.query(sql, args));
    try {
      await assert.rejects(f.resolve(active), reason);
    } finally {
      await f.replica(() => f.admin.query(restore, restoreArgs));
    }
  }
  await mutation(
    'DELETE FROM release_ops.certification_cleanup_receipts WHERE operation_id=$1',
    [first.cert.id],
    'INSERT INTO release_ops.certification_cleanup_receipts(operation_id,event_id,data) VALUES($1,$2,$3)',
    [first.cert.id, first.cleanupEvent, first.cleanup],
    /CLEAN_CERTIFICATE_REQUIRED/
  );
  await f.replica(() =>
    f.admin.query(
      "INSERT INTO release_ops.receipts SELECT release_id,'AMBIGUOUS',kind,data,event_id,recovery_id FROM release_ops.receipts WHERE event_id=$1",
      [first.certEvent]
    )
  );
  await assert.rejects(f.resolve(active), /CERTIFICATE_AMBIGUOUS/);
  await f.replica(() =>
    f.admin.query("DELETE FROM release_ops.receipts WHERE receipt_key='AMBIGUOUS'")
  );
  const child = first.artifacts[engine].build_operation_id,
    original = (
      await f.admin.query(
        'SELECT result FROM release_ops.qualification_results WHERE child_id=$1',
        [child]
      )
    ).rows[0].result;
  const forged = structuredClone(original);
  forged.proof.artifact.components[engine].github_archive_digest = 'sha256:' + digest('f');
  await mutation(
    'UPDATE release_ops.qualification_results SET result=$2 WHERE child_id=$1',
    [child, forged],
    'UPDATE release_ops.qualification_results SET result=$2 WHERE child_id=$1',
    [child, original],
    /CHILD_PROVENANCE_REQUIRED/
  );
  // Corrupt all mutually bound certificate copies so ancestry itself, rather
  // than a superficial proof mismatch, is what rejects the cycle.
  const stored = await f.admin.query('SELECT data FROM release_ops.receipts WHERE event_id=$1', [
    second.certEvent,
  ]);
  const cyclic = structuredClone(stored.rows[0].data);
  cyclic.served_components[engine].verified_receipt_id = second.certEvent;
  cyclic.request.component_tuple = cyclic.served_components;
  const oldOp = (
    await f.admin.query('SELECT intent,result FROM release_ops.external_operations WHERE id=$1', [
      second.cert.id,
    ])
  ).rows[0];
  const newIntent = { ...oldOp.intent, provider_request: cyclic.request },
    newResult = { ...oldOp.result, proof: { ...cyclic } };
  delete newResult.proof.build_receipt;
  await f.replica(async () => {
    await f.admin.query('UPDATE release_ops.receipts SET data=$2 WHERE event_id=$1', [
      second.certEvent,
      cyclic,
    ]);
    await f.admin.query(
      'UPDATE release_ops.external_operations SET intent=$2,result=$3 WHERE id=$1',
      [second.cert.id, newIntent, newResult]
    );
    await f.admin.query('UPDATE release_ops.source_plans SET request=$2 WHERE id=$1', [
      oldOp.intent.plan_id,
      cyclic.request,
    ]);
  });
  await assert.rejects(f.resolve(active), /ANCESTRY_CYCLE/);
});

test('bootstrap is explicit and plan capture pins its provenance across later history and process restart', async () => {
  const f = await setup(),
    active = await f.release();
  await f.activate(active);
  const initial = await f.resolve(active);
  assert.equal(initial.origin, 'bootstrap');
  assert.equal(initial.before_components, undefined);
  const resolver = new ComponentBaselineResolver({
    resolve: () => f.resolve(active),
    observe: async (expected) => expected,
    bootstrap: f.seed,
  });
  const resolved = await resolver.read({
    queue: { release_id: active.id, attempt_id: active.attempt },
  });
  const planId = randomUUID(),
    event = await f.event(active.id),
    inputs = Object.fromEntries(
      Object.values(f.seed.retained_artifacts).map((p) => [factDigest(p), p])
    );
  const qualification = {
    release_id: active.id,
    manifest_digest: digest('a'),
    build_receipt: randomUUID(),
    baseline: baselineGeneration(resolved),
    tuples: [f.seed.before_components],
    artifact_inputs: inputs,
    cutover_order: [engine, web],
  };
  await f.admin.query(`GRANT INSERT ON release_ops.source_plans TO ${f.principal}`);
  const insert = async (q) =>
    f.client.query(
      "INSERT INTO release_ops.source_plans(id,release_id,attempt_id,phase,adapter,request,event_id) VALUES($1,$2,$3,'COMPATIBILITY','github-compatibility',$4,$5)",
      [planId, active.id, active.attempt, { qualification: q }, event]
    );
  await assert.rejects(
    insert({ ...qualification, baseline: { origin: 'completed' } }),
    /BASELINE_CAPTURE_REQUIRED/
  );
  const bad = structuredClone(qualification);
  Object.values(bad.artifact_inputs)[0].archive_digest = 'sha256:' + digest('f');
  await assert.rejects(insert(bad), /BASELINE_CAPTURE_ARTIFACT_REQUIRED/);
  await insert(qualification);
  await f.complete();
  const captured = await f.resolve(active);
  assert.equal(captured.origin, 'attempt');
  assert.deepEqual(captured.before_components, f.seed.before_components);
  assert.deepEqual(
    captured.captured_baseline,
    initial.origin === 'bootstrap' ? qualification.baseline : null
  );
  // A new owner session reads the same immutable attempt inputs, not the later
  // completed history or a changed bootstrap configuration.
  await f.client.end();
  clients.delete(f.client);
  f.client = await open({ ...f.config, user: f.principal });
  await call(f.client, 'acquire_owner', [randomUUID(), 'baseline-restart']);
  const restarted = (
    await f.client.query('SELECT release_ops.component_compatibility_baseline($1) AS value', [
      active.id,
    ])
  ).rows[0].value;
  assert.deepEqual(restarted, captured);
});

test('newer unresolved or failed publication refuses older completed and bootstrap fallback', async () => {
  const f = await setup(),
    first = await f.complete(),
    active = await f.release();
  await f.activate(active);
  const failedRelease = await f.release([engine], 'RECOVERY_REQUIRED');
  const op = await f.replica(() =>
    f.operation(
      failedRelease,
      'PUBLISH',
      'hetzner-intake',
      { target: engine, source_sha: sha('4') },
      { status: 'UNKNOWN' }
    )
  );
  await assert.rejects(f.resolve(active), /NEWER_EFFECT_UNRESOLVED/);
  await f.replica(() =>
    f.admin.query("UPDATE release_ops.external_operations SET status='FAILED' WHERE id=$1", [op.id])
  );
  await assert.rejects(f.resolve(active), /NEWER_EFFECT_UNRESOLVED/);
  await f.replica(() =>
    f.admin.query("UPDATE release_ops.external_operations SET status='NOT_ACCEPTED' WHERE id=$1", [
      op.id,
    ])
  );
  assert.equal((await f.resolve(active)).baseline_event_id, first.certEvent);
});

test('attempt baseline preserves engine-first publication prefix and exposes failed or unknown next effects', async () => {
  const f = await setup(),
    first = await f.complete(),
    active = await f.release();
  await f.activate(active);
  const baseline = await f.resolve(active),
    planId = randomUUID(),
    event = await f.event(active.id),
    ready = await f.event(active.id);
  const qualification = {
    baseline: baselineGeneration(baseline),
    tuples: [baseline.before_components],
    artifact_inputs: Object.fromEntries(
      Object.values(baseline.retained_artifacts).map((p) => [factDigest(p), p])
    ),
  };
  await f.replica(async () => {
    await f.insert('source_plans', {
      id: planId,
      release_id: active.id,
      attempt_id: active.attempt,
      phase: 'COMPATIBILITY',
      adapter: 'github-compatibility',
      request: { qualification },
      event_id: event,
    });
    await f.admin.query('UPDATE release_ops.queue SET selected_receipts=$2 WHERE release_id=$1', [
      active.id,
      { READINESS: ready },
    ]);
  });
  const pubPlan = randomUUID(),
    request = { target: engine, source_sha: sha('4'), artifact_image_id: 'sha256:' + digest('4') };
  const pub = await f.replica(async () => {
    await f.insert('provider_plans', {
      id: pubPlan,
      release_id: active.id,
      operation_key: pubPlan,
      adapter: 'hetzner-intake',
      request,
      readiness_event: ready,
      event_id: await f.event(active.id),
      event_no: 1,
    });
    return f.operation(active, 'PUBLISH', 'hetzner-intake', request, {
      planId: pubPlan,
      result: {
        outcome: 'SUCCEEDED',
        source_sha: sha('4'),
        image_id: 'sha256:' + digest('4'),
        result: 'sealed',
      },
    });
  });
  let captured = await f.resolve(active);
  assert.deepEqual(captured.before_components, baseline.before_components);
  assert.equal(captured.publication_results[0].id, pub.id);
  assert.equal(captured.publication_results[0].readiness_event, ready);
  assert.deepEqual(captured.pending_external, []);
  const nextPlan = randomUUID(),
    nextRequest = { target: web, source_sha: sha('4') };
  const next = await f.replica(async () => {
    await f.insert('provider_plans', {
      id: nextPlan,
      release_id: active.id,
      operation_key: nextPlan,
      adapter: 'github-static',
      request: nextRequest,
      readiness_event: ready,
      event_id: await f.event(active.id),
      event_no: 1,
    });
    return f.operation(active, 'PUBLISH', 'github-static', nextRequest, {
      planId: nextPlan,
      status: 'UNKNOWN',
    });
  });
  captured = await f.resolve(active);
  assert.equal(captured.pending_external[0].id, next.id);
  assert.deepEqual(captured.before_components, baseline.before_components);
  await f.replica(() =>
    f.admin.query("UPDATE release_ops.external_operations SET status='FAILED' WHERE id=$1", [
      next.id,
    ])
  );
  captured = await f.resolve(active);
  assert.equal(captured.pending_external[0].status, 'FAILED');
  assert.equal(captured.publication_results[0].status, 'SUCCEEDED');
  assert.equal(
    captured.retained_artifacts[engine].build_run_id,
    first.artifacts[engine].build_run_id
  );
});

test('RECOVERED needs a new successful clean certificate and exact recovery source revision', async () => {
  const f = await setup(),
    first = await f.complete(),
    recovered = await f.complete({ c: '4' }),
    active = await f.release();
  await f.activate(active);
  const recovery = randomUUID();
  await f.replica(async () => {
    await f.insert('recovery_revisions', {
      id: recovery,
      release_id: recovered.id,
      recovery_key: 'fixture-forward-revert',
      digest: digest('e'),
      intent: { purpose: 'forward-revert' },
      prior_attempt_id: randomUUID(),
      attempt_id: recovered.attempt,
      deadline: new Date(Date.now() + 3600000),
      budget_seconds: 3600,
      owner_id: f.owner.owner_id,
      epoch: f.owner.epoch,
      event_id: await f.event(recovered.id),
    });
    await f.admin.query(
      "UPDATE release_ops.queue SET state='RECOVERED',recovery_id=$2 WHERE release_id=$1",
      [recovered.id, recovery]
    );
    await f.admin.query('UPDATE release_ops.receipts SET recovery_id=$2 WHERE release_id=$1', [
      recovered.id,
      recovery,
    ]);
    await f.admin.query(
      'UPDATE release_ops.provider_plans SET recovery_id=$2 WHERE release_id=$1',
      [recovered.id, recovery]
    );
    await f.event(recovered.id, 'STATE_RECOVERED', { state_version: 1 });
  });
  await assert.rejects(f.resolve(active), /RECOVERED_SOURCE_REQUIRED/);
  await f.replica(() =>
    f.admin.query('UPDATE release_ops.receipts SET data=data||$2::jsonb WHERE event_id=$1', [
      recovered.certEvent,
      { recovery_revision_id: recovery, source_reconciled: true, source_revision: sha('a') },
    ])
  );
  assert.equal((await f.resolve(active)).baseline_event_id, recovered.certEvent);
  // A cleanup-only recovery cannot rewrite the original failed certificate into
  // this success. The earlier failure belongs to a different operation.
  await f.replica(async () =>
    f.insert('certification_cleanup_recoveries', {
      id: randomUUID(),
      operation_id: first.cert.id,
      original_run: { conclusion: 'failure' },
      event_id: await f.event(first.id),
    })
  );
  assert.equal((await f.resolve(active)).baseline_event_id, recovered.certEvent);
  await f.replica(async () =>
    f.insert('certification_cleanup_recoveries', {
      id: randomUUID(),
      operation_id: recovered.cert.id,
      original_run: { conclusion: 'failure' },
      event_id: await f.event(recovered.id),
    })
  );
  await assert.rejects(f.resolve(active), /CLEAN_CERTIFICATE_REQUIRED/);
});
