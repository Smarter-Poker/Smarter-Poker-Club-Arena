import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createCluster } from './postgres-fixture.mjs';
import { staticArtifactFixture, receiptZip } from './static-artifact-fixture.mjs';
import { call, connect, policy } from '../../operations/release/journal.mjs';
import { ProviderRunner, providerCall } from '../../operations/release/provider-journal.mjs';
import { SourceCoordinator } from '../../operations/release/source-coordinator.mjs';
import { AggregateQualificationAdapter } from '../../operations/release/aggregate-qualification.mjs';
import { StaticReadiness } from '../../operations/release/static-readiness.mjs';
import {
  EngineReadiness,
  readDoorCatalogue,
  catalogueDigest,
} from '../../operations/release/engine-readiness.mjs';
import {
  MixedReadiness,
  ComponentCompatibilityReadiness,
  validateMixedCompatibility,
} from '../../operations/release/mixed-readiness.mjs';
import { factDigest, certificateReports } from '../../operations/release/component-certificate.mjs';
import { operationPolicyDigest } from '../../operations/release/operation-policy.mjs';
import { certificationCall } from '../../operations/release/certification-callback.mjs';
import { GitHubComponentCompatibility } from '../../operations/release/component-compatibility.mjs';
import { ComponentBaselineResolver } from '../../operations/release/component-baseline.mjs';

const engine = 'club-arena-engine',
  web = 'club-arena-web';
const repo = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const sha = (c) => c.repeat(40),
  image = (c) => `sha256:${c.repeat(64)}`;
const install = { bundle_digest: 'b'.repeat(64), config_digest: 'c'.repeat(64) };
const migrations = [
  '20260911160341_provider_operation_boundary.sql',
  '20260911190350_component_certification_and_durable_fixture_claims.sql',
  '20260911192023_bind_existing_static_publisher_to_private_release_journal.sql',
  '20260911194548_aggregate_component_qualification_under_one_release_operatio.sql',
  '20260911210645_resolve_continuous_component_baselines_from_owned_certificat.sql',
].map((name) => new URL(`../../supabase/migrations/${name}`, import.meta.url));
let cluster;
const clients = new Set(),
  artifacts = new Set();
before(async () => {
  cluster = await createCluster();
});
after(async () => {
  for (const client of clients) await client.end().catch(() => {});
  for (const artifact of artifacts) await artifact.close();
  await cluster.close();
});
const evidence = (keys) =>
  Object.fromEntries(keys.map((k) => [k, ['isolated-provider-contract-fixture']]));
async function db(config) {
  const client = await connect(config);
  clients.add(client);
  return client;
}

// Provider doubles represent already-verified native product/browser receipts;
// this suite proves orchestration and PG authority, not product compatibility.
// The filesystem manifest and door catalogue reads below are real native reads.
async function setup() {
  const config = await cluster.database({ additionalMigrations: migrations });
  const admin = await db(config);
  await admin.query(
    'CREATE FUNCTION public.mixed_contract_probe() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 7 $$'
  );
  const rows = await readDoorCatalogue(admin, ['mixed_contract_probe']);
  const currentWeb = await staticArtifactFixture(sha('9'), '567');
  artifacts.add(currentWeb);
  const nextWeb = await staticArtifactFixture(sha('a'), '678');
  artifacts.add(nextWeb);
  const name = `mixed_${randomUUID().replaceAll('-', '')}`,
    callbackName = `${name}_cb`;
  await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER; GRANT release_journal_controller TO ${name};
    CREATE ROLE ${callbackName} LOGIN NOSUPERUSER; GRANT release_certification_callback TO ${callbackName}`);
  let client = await db({ ...config, user: name });
  const callback = await db({ ...config, user: callbackName });
  let owner = await call(client, 'acquire_owner', [randomUUID(), 'mixed-native']);
  const github = {
    repo,
    repositoryId: '12345',
    controlSha: sha('a'),
    workflowId: 123,
    certificationVersion: 2,
    runtimeImage: `node:22-bookworm@sha256:${'d'.repeat(64)}`,
  };
  const prior = {
    [engine]: { source_sha: sha('8'), identity: image('8') },
    [web]: {
      source_sha: sha('9'),
      identity: `sha256:${currentWeb.manifestDigest}`,
      manifest_digest: currentWeb.manifestDigest,
    },
  };
  const contract = {
    version: 1,
    before_components: prior,
    cutover_order: [engine, web],
    schema: {
      fixture_sha256: 'f'.repeat(64),
      catalogue_digest: catalogueDigest(rows),
      database_contract_digest: catalogueDigest(rows),
      artifact_id: '901',
      archive_digest: image('f'),
      build_run_id: '902',
    },
    retained_artifacts: Object.fromEntries(
      Object.entries(prior).map(([target, part], i) => [
        target,
        {
          ...part,
          artifact_id: String(903 + i),
          archive_digest: image('7'),
          build_run_id: String(905 + i),
        },
      ])
    ),
  };
  const installation = await providerCall(admin, 'register_provider_installation', [
    install.bundle_digest,
    {
      config_digest: install.config_digest,
      controller_principal: name,
      host_id: 'native-fixture',
      service: 'club-arena-release-controller.service',
      native_lock_path: '/var/lib/club-arena-release-controller/controller.lock',
      schema_version: 1,
      provider_schema_version: 1,
      adapters: [
        'github-merge',
        'github-workflow',
        'github-static',
        'component-aggregate',
        'engine-stage',
        'hetzner-intake',
        'github-compatibility',
        'github-certification',
      ],
      github: {
        control_sha: github.controlSha,
        workflow_id: 123,
        runtime_image: github.runtimeImage,
        static_workflow_id: 235,
        certification_workflow_id: 234,
        component_qualification_workflow_id: 236,
        component_runtime_image: github.runtimeImage,
      },
      engine: { control_sha: github.controlSha },
      compatibility: {
        schema: contract.schema,
        cutover_order: contract.cutover_order,
        bootstrap: { before_components: prior, retained_artifacts: contract.retained_artifacts },
      },
    },
    evidence([
      'installed_code',
      'identity_membership',
      'exclusive_native_service',
      'legacy_writers_retired',
      'candidate_build_authority_isolated',
      'provider_scope',
      'compatible_recovery',
    ]),
    'native-verifier',
  ]);
  await admin.query(
    'UPDATE release_ops.controller SET execution_enabled=true,installed_adapter_receipt=$1',
    [installation.id]
  );
  const reconcile = async () => {
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
        receipt_refs: ['isolated-provider-contract-fixture'],
      },
      'native-verifier',
      'Native fixture owner reconciliation',
    ]);
  };
  await reconcile();
  for (const [type, workflowId, workflowPath, audience, url] of [
    [
      'static_publication',
      235,
      '.github/workflows/publish-club-arena.yml',
      'club-arena-static-publication',
      'https://release.example.invalid/static-publication',
    ],
    [
      'certification',
      234,
      '.github/workflows/post-deploy-e2e.yml',
      'club-arena-release-certification',
      'https://release.example.invalid/certification',
    ],
  ]) {
    const binding = {
      principal: callbackName,
      repository: repo,
      repository_id: '12345',
      workflow_id: String(workflowId),
      workflow_path: workflowPath,
      control_sha: sha('a'),
      control_ref: 'refs/heads/main',
      audience,
      url,
    };
    const ingress = (
      await admin.query(`SELECT release_ops.register_${type}_ingress($1,$2,$3) AS v`, [
        binding,
        evidence([
          'installed_code',
          'authenticated_ingress',
          'identity_membership',
          'exact_workflow',
          ...(type === 'certification'
            ? ['reserved_auth_uuid', 'cleanup_authority']
            : ['same_run_artifact_gate', 'native_origin_transaction']),
        ]),
        'native-verifier',
      ])
    ).rows[0].v;
    github[type === 'certification' ? 'fixtureAuthority' : 'staticAuthority'] = {
      url,
      audience,
      installation_receipt: ingress.id,
    };
  }
  const intent = {
    repository: repo,
    target: web,
    project: 'club-arena-web',
    head_sha: sha('a'),
    pull_request: 42,
    purpose: 'release',
    manifest: { components: [{ target: web }, { target: engine }] },
    dependencies: [],
  };
  intent.project = policy.participants.find((p) => p.target === web).project;
  const first = await call(admin, 'enqueue', ['mixed', intent, 'native-fixture']);
  const second = await call(admin, 'enqueue', [
    'next',
    { ...intent, head_sha: sha('b'), pull_request: 43 },
    'native-fixture',
  ]);
  const counts = {
    buildEngine: 0,
    buildWeb: 0,
    stage: 0,
    semantic: 0,
    engine: 0,
    web: 0,
    certify: 0,
  };
  const order = [],
    observations = new Map();
  let visible = true,
    current = currentWeb,
    semanticReceipt,
    semanticRun,
    semanticArchive;
  const baseAdapter = {
    validate() {},
    async preflight() {
      return {};
    },
  };
  const staticAdapter = {
    ...baseAdapter,
    repo,
    repositoryId: '12345',
    controlSha: sha('a'),
    workflowId: 235,
    // A control-equality fixture: no upgrade is performed in this test.
    async qualifyControl() {
      return { control_sha: sha('a') };
    },
    async submit(r, operation) {
      if (r.phase === 'BUILD') {
        counts.buildWeb++;
        const part = {
          source_sha: sha('a'),
          identity: `sha256:${nextWeb.manifestDigest}`,
          manifest_digest: nextWeb.manifestDigest,
          build_operation_id: operation.id,
          build_run_id: '678',
          github_artifact_id: '800',
          github_archive_digest: image('e'),
          github_archive_bytes: 512,
        };
        observations.set(operation.id, {
          terminal: true,
          outcome: 'SUCCEEDED',
          provider_operation_id: '678',
          proof: {
            operation_id: operation.id,
            request: r,
            control_sha: sha('a'),
            run_id: '678',
            run_attempt: 1,
            job_id: '100',
            success: true,
            artifact: { components: { [web]: part } },
          },
        });
      } else {
        counts.web++;
        order.push(web);
        const claim = await certificationCall(callback, 'claim_static_publication', [
          r.build_operation_id,
          {
            repository_id: '12345',
            workflow_id: '235',
            control_sha: sha('a'),
            run_id: '678',
            run_attempt: 1,
          },
          randomUUID(),
        ]);
        assert.equal(claim.ready, true);
        current = nextWeb;
        observations.set(operation.id, {
          terminal: true,
          outcome: 'SUCCEEDED',
          provider_operation_id: '678',
          proof: {
            operation_id: operation.id,
            request: r,
            control_sha: sha('a'),
            run_id: '678',
            run_attempt: 1,
            job_id: '101',
            success: true,
            component: r.artifact,
            publication_claim: claim.claim_receipt,
            native: await nextWeb.readNative(),
          },
        });
      }
      throw new Error('lost static acknowledgement');
    },
    async reconcile(r, operation) {
      return visible ? observations.get(operation.id) : { terminal: false };
    },
  };
  const engineBuilder = {
    ...baseAdapter,
    ...github,
    async submit(r, operation) {
      counts.buildEngine++;
      const part = {
        source_sha: sha('a'),
        identity: image('1'),
        build_operation_id: operation.id,
        build_run_id: '677',
        archive_digest: image('2'),
        archive_bytes: 1024,
        github_artifact_id: '799',
        github_archive_digest: image('3'),
        github_archive_bytes: 512,
        server_tree_sha: sha('4'),
      };
      observations.set(operation.id, {
        terminal: true,
        outcome: 'SUCCEEDED',
        provider_operation_id: '677',
        proof: {
          operation_id: operation.id,
          request: r,
          control_sha: sha('a'),
          run_id: '677',
          success: true,
          artifact: { components: { [engine]: part } },
          database_doors: {
            names: ['mixed_contract_probe'],
            exceptions: {},
            digest: catalogueDigest({ names: ['mixed_contract_probe'], exceptions: {} }),
          },
        },
      });
      throw new Error('lost engine build acknowledgement');
    },
    async reconcile(r, operation) {
      return visible ? observations.get(operation.id) : { terminal: false };
    },
  };
  const intake = {
    ...baseAdapter,
    async preflight(r) {
      assert.equal(r.expected_current.source_sha, prior[engine].source_sha);
      assert.equal(r.expected_current.image_id, prior[engine].identity);
      return {
        ready: true,
        source_sha: prior[engine].source_sha,
        image_id: prior[engine].identity,
      };
    },
    async submit(r, operation) {
      counts.engine++;
      order.push(engine);
      observations.set(operation.id, {
        terminal: true,
        outcome: 'SUCCEEDED',
        source_sha: r.source_sha,
        image_id: r.artifact_image_id,
        result: 'sealed',
      });
      throw new Error('lost engine publication acknowledgement');
    },
    async reconcile(r, operation) {
      return visible ? observations.get(operation.id) : { terminal: false };
    },
  };
  const workflowPath = '.github/workflows/release-component-qualification.yml';
  const qualifier = new GitHubComponentCompatibility({
    repositoryId: '12345',
    controlSha: sha('a'),
    controlRef: 'heads/control',
    workflowId: 236,
    workflowPath,
    runtimeImage: github.runtimeImage,
    request: async (route, options = {}) => {
      if (options.method === 'POST') {
        counts.semantic++;
        const r = JSON.parse(options.body.inputs.request),
          operationId = options.body.inputs.operation_id,
          plan = r.qualification;
        semanticReceipt = {
          version: 1,
          success: true,
          request: plan,
          provider_request: r,
          request_digest: factDigest(plan),
          operation_id: operationId,
          control_sha: sha('a'),
          runtime_image: github.runtimeImage,
          run_id: '679',
          run_attempt: 1,
          cleanup: {
            version: 1,
            complete: true,
            images_removed: true,
            operation_id: operationId,
            run_id: '679',
            run_attempt: 1,
            request_digest: factDigest(plan),
            fixtures: plan.tuples.map((tuple, index) => ({
              index,
              complete: true,
              remaining_objects: 0,
              tuple_digest: factDigest(tuple),
            })),
          },
          combinations: plan.tuples.map((tuple) => {
            // Protocol fixture only: the actual isolated product suite is tested
            // separately and cannot run on this host without its Docker runtime.
            const native = {
              scope: 'club-arena-product',
              tuple,
              runtime_image: github.runtimeImage,
              schema_fixture_sha256: plan.schema.fixture_sha256,
              schema_catalogue_digest: plan.schema.catalogue_digest,
              product_suite: 'live-table-schema-v1',
              success: true,
              failed: 0,
              skipped: 0,
              retries: 0,
              executed: 5,
              cases: [
                'exact-schema-catalogue',
                'authenticated-web-bundle',
                'engine-browser-causal-hand',
                'completed-hand-persisted',
                'spectator-does-not-acquire-seat',
              ].map((name) => ({ name, passed: true })),
            };
            return {
              tuple_digest: factDigest(tuple),
              schema_fixture_sha256: plan.schema.fixture_sha256,
              component_builds_digest: factDigest(plan.component_builds),
              success: true,
              failed: 0,
              retries: 0,
              skipped: 0,
              executed: 5,
              cleanup: { complete: true, remaining_objects: 0 },
              native,
              native_receipt_digest: `sha256:${factDigest(native)}`,
              job_id: '102',
            };
          }),
        };
        semanticRun = {
          id: 679,
          workflow_id: 236,
          path: workflowPath,
          head_sha: sha('a'),
          event: 'workflow_dispatch',
          display_title: `release:${operationId}:COMPATIBILITY`,
          run_attempt: 1,
          status: 'completed',
          conclusion: 'success',
          repository: { id: 12345 },
          head_repository: { id: 12345 },
        };
        const bytes = receiptZip(semanticReceipt);
        semanticArchive = {
          bytes,
          id: 801,
          name: `release-compatibility-${operationId}`,
          expired: false,
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        };
        throw new Error('lost semantic dispatch acknowledgement');
      }
      if (route.endsWith('/workflows/236')) return { id: 236, path: workflowPath, state: 'active' };
      if (route.includes('/git/ref/')) return { object: { type: 'commit', sha: sha('a') } };
      if (route.includes('/runs?'))
        return {
          total_count: visible && semanticRun ? 1 : 0,
          workflow_runs: visible && semanticRun ? [semanticRun] : [],
        };
      if (route.endsWith('/runs/679')) return semanticRun;
      if (route.endsWith('/artifacts/801/zip')) return semanticArchive.bytes;
      if (route.includes('/artifacts?')) return { total_count: 1, artifacts: [semanticArchive] };
      if (route.includes('/jobs?'))
        return { total_count: 1, jobs: [{ id: 102, status: 'completed', conclusion: 'success' }] };
      throw new Error(`unexpected semantic route ${route}`);
    },
  });
  const baselineReads = [];
  let baselineEngineDrift = false;
  const baselineResolver = new ComponentBaselineResolver({
    bootstrap: contract,
    resolve: (release) =>
      certificationCall(callback, 'component_compatibility_baseline', [release]),
    observe: async (expected) => {
      baselineReads.push(structuredClone(expected));
      const native = await current.readNative();
      const enginePublished = [...observations.values()].find(
        (observation) => observation.result === 'sealed'
      );
      return {
        [engine]: baselineEngineDrift
          ? { source_sha: sha('f'), identity: image('f') }
          : enginePublished
            ? { source_sha: enginePublished.source_sha, identity: enginePublished.image_id }
            : prior[engine],
        [web]: {
          source_sha: native.source_sha,
          identity: `sha256:${native.manifest_sha256}`,
          manifest_digest: native.manifest_sha256,
        },
      };
    },
  });
  const compatibilityReadiness = new ComponentCompatibilityReadiness({
    contract,
    resolveBaseline: (snapshot) => baselineResolver.read(snapshot),
    qualifier,
  });
  const staticReadiness = new StaticReadiness({
    adapter: staticAdapter,
    readNative: (expected) => current.readNative(expected),
    readPublic: () => current.readPublic(),
    compatibilityReadiness,
    github: async (route) =>
      route.includes('/jobs?')
        ? {
            total_count: 1,
            jobs: [
              {
                id: 90,
                name: 'publish-to-origin',
                status: 'completed',
                conclusion: 'success',
                steps: [
                  {
                    name: 'Verify the origin serves this bundle',
                    status: 'completed',
                    conclusion: 'success',
                  },
                ],
              },
            ],
          }
        : {
            id: 567,
            path: '.github/workflows/publish-club-arena.yml',
            head_branch: 'main',
            event: 'push',
            status: 'completed',
            repository: { full_name: repo },
            head_repository: { full_name: repo },
            run_attempt: 1,
          },
  });
  const engineReadiness = new EngineReadiness({
    intake,
    catalogue: (names) => readDoorCatalogue(admin, names),
    publicJSON: async (url) =>
      url.includes('/health')
        ? {
            running: true,
            releaseSha: prior[engine].source_sha,
            instanceId: 'native-prior',
            maintenance: {
              policyVersion: 2,
              policyDigest: operationPolicyDigest,
              activationReceipt: 'native-fixture',
            },
          }
        : { ca_sha: current.source },
  });
  const mixedReadiness = new MixedReadiness({
    engineReadiness,
    staticReadiness,
    compatibilityReadiness,
  });
  const certifier = {
    ...baseAdapter,
    controlSha: sha('a'),
    workflowId: 234,
    async submit(r, operation) {
      counts.certify++;
      const identity = {
        repository_id: '12345',
        workflow_id: '234',
        control_sha: sha('a'),
        run_id: '680',
        run_attempt: 1,
      };
      const invoke = (action, proof) =>
        certificationCall(callback, 'certification_fixture_callback', [
          operation.id,
          identity,
          action,
          null,
          null,
          proof,
        ]);
      await invoke('begin-cleanup');
      const cleanup = await invoke('cleanup-complete', {
        operation_id: operation.id,
        run_id: '680',
        run_attempt: 1,
        accounts: Object.fromEntries(
          Object.entries(r.fixture_roster).map(([slot, account]) => [
            slot,
            {
              ...account,
              auth_absent: true,
              resources_absent: true,
              evidence_sha256: 'a'.repeat(64),
            },
          ])
        ),
      });
      observations.set(operation.id, {
        terminal: true,
        outcome: 'SUCCEEDED',
        provider_operation_id: '680',
        proof: {
          operation_id: operation.id,
          request: r,
          control_sha: sha('a'),
          run_id: '680',
          run_attempt: 1,
          success: true,
          cleanup_receipt: cleanup.cleanup_receipt,
          cleanup_complete: true,
          unchanged_release: true,
          served_components: r.component_tuple,
          reports: certificateReports.map((name) => ({
            name,
            complete: true,
            failed: 0,
            retried: 0,
            executed: 1,
            sha256: 'b'.repeat(64),
          })),
        },
      });
      throw new Error('lost certificate acknowledgement');
    },
    async reconcile(r, operation) {
      return observations.get(operation.id);
    },
  };
  const adapters = {
    'github-merge': baseAdapter,
    'github-workflow': engineBuilder,
    'github-static': staticAdapter,
    'engine-stage': {
      ...baseAdapter,
      controlSha: sha('a'),
      current: async () => ({
        source_sha: prior[engine].source_sha,
        image_id: prior[engine].identity,
      }),
      async submit(r, operation) {
        counts.stage++;
        assert.equal(r.build_run_id, '677');
        assert.equal(r.run_key, '677-1');
        return { terminal: true, outcome: 'SUCCEEDED', provider_operation_id: r.run_key };
      },
    },
    'hetzner-intake': intake,
    'github-compatibility': qualifier,
    'github-certification': certifier,
  };
  adapters['component-aggregate'] = new AggregateQualificationAdapter({ adapters });
  const maintenance = {
    beforePublish: async () => ({ ready: true }),
    afterPublish: async () => ({ ready: true }),
    context: async () => ({ operation: { phase: 'resumed', operation_id: randomUUID() } }),
  };
  let runner = new ProviderRunner({ client, owner, installation: install, adapters });
  let coordinator = new SourceCoordinator({
    runner,
    github,
    readiness: engineReadiness,
    staticReadiness,
    mixedReadiness,
    maintenance,
  });
  const tick = () => coordinator.tick({ mode: 'EXECUTE', now: Date.now() + 60000 });
  await tick();
  let s = await coordinator.snapshot();
  await coordinator.selected(s.queue, 'VALIDATION', randomUUID(), {
    accepted_head_sha: sha('a'),
    expected_base_sha: sha('b'),
    tested_tree_sha: sha('c'),
  });
  await tick();
  s = await coordinator.snapshot();
  await coordinator.selected(s.queue, 'INTEGRATION', randomUUID(), {
    accepted_head_sha: sha('a'),
    expected_base_sha: sha('b'),
    merged_sha: sha('a'),
    merged_tree_sha: sha('c'),
    validation_receipt: s.receipts.VALIDATION.event_id,
  });
  await tick();
  return {
    admin,
    first,
    second,
    counts,
    order,
    prior,
    contract,
    compatibilityReadiness,
    mixedReadiness,
    tick,
    baselineReads,
    setBaselineEngineDrift(value) {
      baselineEngineDrift = value;
    },
    get coordinator() {
      return coordinator;
    },
    get runner() {
      return runner;
    },
    setVisible(v) {
      visible = v;
    },
    async takeover() {
      await client.end();
      client = await db({ ...config, user: name });
      owner = await call(client, 'acquire_owner', [randomUUID(), 'mixed-successor']);
      runner = new ProviderRunner({ client, owner, installation: install, adapters });
      coordinator = new SourceCoordinator({
        runner,
        github,
        readiness: engineReadiness,
        staticReadiness,
        mixedReadiness,
        maintenance,
      });
      await reconcile();
    },
  };
}

async function until(t, state) {
  for (let i = 0; i < 60; i++) {
    const snapshot = await t.coordinator.snapshot();
    if (snapshot.queue?.state === state) return snapshot;
    if (
      !snapshot.queue &&
      (await call(t.admin, 'inspect')).queue.find((q) => q.release_id === t.first.id)?.state ===
        state
    )
      return snapshot;
    await t.tick();
  }
  assert.fail(
    `coordinator did not reach ${state}: ${JSON.stringify(await t.coordinator.snapshot())}`
  );
}

test('native PG mixed coordinator binds both child builds, three tuples and ordered one-use publications through fixture cleanup', async () => {
  const t = await setup();
  const staged = await until(t, 'STAGED');
  assert.equal(
    staged.receipts.BUILD.data.build_run_id,
    `aggregate:${staged.receipts.BUILD.data.aggregate_operation_id}`
  );
  assert.notEqual(
    staged.receipts.BUILD.data.artifact.components[engine].build_operation_id,
    staged.receipts.BUILD.data.artifact.components[web].build_operation_id
  );
  const ready = await until(t, 'READY');
  const proof = ready.receipts.STAGED.data;
  assert.deepEqual(proof.publication_order, [engine, web]);
  assert.equal(proof.component_readiness.semantic.request.tuples.length, 3);
  assert.deepEqual(proof.retained_components, {});
  assert.equal(
    proof.component_readiness.semantic.request.component_builds[engine].build_run_id,
    '677'
  );
  assert.equal(
    proof.component_readiness.semantic.request.component_builds[web].build_run_id,
    '678'
  );
  const applying = await until(t, 'APPLYING');
  await assert.rejects(
    providerCall(t.runner.client, 'submit_static_publication_plan', [
      ...t.runner.args(),
      t.first.id,
      'refused-out-of-order-web',
      applying.receipts.READINESS.data.provider_requests['github-static'],
      ...t.runner.installArgs(),
      t.runner.actor,
    ]),
    /COMPONENT_PUBLICATION_ORDER_REQUIRED/
  );
  assert.equal((await t.tick()).state, 'QUALIFIED_PUBLICATION_PLAN_PERSISTED');
  t.setVisible(false);
  await t.tick();
  assert.equal(t.counts.engine, 1);
  const readsBeforeUnknown = t.baselineReads.length;
  await t.takeover();
  await t.tick();
  assert.equal(
    t.baselineReads.length,
    readsBeforeUnknown,
    'unresolved publication is reconciliation only'
  );
  assert.equal(t.counts.engine, 1);
  assert.equal(t.counts.web, 0);
  assert.equal((await t.coordinator.snapshot()).queue.state, 'UNKNOWN_EXTERNAL_OUTCOME');
  t.setVisible(true);
  await t.tick();
  assert.equal((await t.coordinator.snapshot()).queue.state, 'APPLYING');
  t.setBaselineEngineDrift(true);
  await assert.rejects(t.tick(), /BASELINE_NATIVE_DRIFT/);
  assert.equal(t.counts.web, 0, 'engine prefix drift cannot authorize the next web publication');
  t.setBaselineEngineDrift(false);
  await until(t, 'VERIFYING');
  assert.deepEqual(t.order, [engine, web]);
  await until(t, 'VERIFIED');
  const inventory = await call(t.admin, 'inspect');
  assert.equal(inventory.queue.find((q) => q.release_id === t.second.id).state, 'QUEUED');
  assert.deepEqual(t.counts, {
    buildEngine: 1,
    buildWeb: 1,
    stage: 1,
    semantic: 1,
    engine: 1,
    web: 1,
    certify: 1,
  });
  const cleanup = await t.admin.query(
    'SELECT count(*) FROM release_ops.certification_cleanup_receipts'
  );
  assert.equal(cleanup.rows[0].count, '1');
  assert.equal((await t.tick()).state, 'CLAIMED');
  const next = await t.compatibilityReadiness.resolveBaseline(await t.coordinator.snapshot());
  assert.equal(next.origin, 'completed');
  assert.equal(next.baseline_release_id, t.first.id);
  assert.equal(next.before_components[engine].source_sha, sha('a'));
  assert.equal(next.retained_artifacts[engine].build_run_id, '677');
  assert.equal(next.retained_artifacts[web].build_run_id, '678');
});

test('mixed readiness refuses omitted intermediate semantics, changed child identity and staged baseline drift', async () => {
  const t = await setup();
  const state = await until(t, 'READY');
  const compatibility = await t.compatibilityReadiness.verify(state);
  for (const mutate of [
    (c) => c.semantic.request.tuples.splice(1, 1),
    (c) => (c.semantic.combinations[1].failed = 1),
    (c) => (c.semantic.request.component_builds[engine].build_run_id = '999'),
    (c) => c.semantic.request.cutover_order.reverse(),
  ]) {
    const altered = structuredClone(compatibility);
    mutate(altered);
    altered.semantic.request_digest = factDigest(altered.semantic.request);
    assert.throws(() => validateMixedCompatibility(state, altered), /RELEASE_/);
  }
  const altered = structuredClone(state);
  altered.receipts.STAGED.data.component_readiness.before_components[engine].identity = image('7');
  await assert.rejects(
    t.mixedReadiness.verify(altered, state.receipts.STAGED.data.intake_request, {
      id: state.receipts.STAGED.data.stage_operation_id,
      epoch: t.runner.owner.epoch,
    }),
    /READINESS_CHANGED_AFTER_STAGING/
  );
});

test('missing installed semantic authority keeps the mixed release staged with zero publication', async () => {
  const t = await setup();
  await until(t, 'STAGED');
  delete t.runner.adapters['github-compatibility'];
  let result;
  for (let n = 0; n < 8; n++) {
    result = await t.tick();
    if (result.state === 'INSTALLED_SEMANTIC_QUALIFIER_REQUIRED') break;
  }
  assert.equal(result.state, 'INSTALLED_SEMANTIC_QUALIFIER_REQUIRED');
  const state = await t.coordinator.snapshot();
  assert.equal(state.queue.state, 'STAGED');
  assert.equal(state.receipts.STAGED, undefined);
  assert.equal(t.counts.semantic, 0);
  assert.equal(t.counts.engine, 0);
  assert.equal(t.counts.web, 0);
  await assert.rejects(t.compatibilityReadiness.verify(state), /SEMANTIC_QUALIFICATION_REQUIRED/);
});
