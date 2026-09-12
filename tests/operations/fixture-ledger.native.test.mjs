import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { createCluster } from './postgres-fixture.mjs';
import { call, connect, policy } from '../../operations/release/journal.mjs';
import { providerCall, ProviderRunner } from '../../operations/release/provider-journal.mjs';
import {
  certificationCall,
  CertificateCallback,
  GitHubCertificateIdentity,
} from '../../operations/release/certification-callback.mjs';
import {
  fixtureSlots,
  certificateReports,
  factDigest,
} from '../../operations/release/component-certificate.mjs';
import { staticArtifactFixture, receiptZip } from './static-artifact-fixture.mjs';
import { GitHubStaticAdapter } from '../../operations/release/adapters/github-static.mjs';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { operationPolicyDigest } from '../../operations/release/operation-policy.mjs';
import { SourceCoordinator } from '../../operations/release/source-coordinator.mjs';
import { baselineGeneration } from '../../operations/release/component-baseline.mjs';

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
  for (const c of clients) await c.end().catch(() => {});
  await cluster.close();
});
async function db(config) {
  const c = await connect(config);
  clients.add(c);
  return c;
}
const sha = 'a'.repeat(40),
  repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const semanticSchema = {
  fixture_sha256: '5'.repeat(64),
  catalogue_digest: '6'.repeat(64),
  artifact_id: '888',
  archive_digest: `sha256:${'7'.repeat(64)}`,
  build_run_id: '889',
};
const migrations = [
  '20260911160341_provider_operation_boundary.sql',
  '20260911190350_component_certification_and_durable_fixture_claims.sql',
  '20260911192023_bind_existing_static_publisher_to_private_release_journal.sql',
  '20260911194548_aggregate_component_qualification_under_one_release_operatio.sql',
  '20260911210645_resolve_continuous_component_baselines_from_owned_certificat.sql',
].map((name) => new URL(`../../supabase/migrations/${name}`, import.meta.url));

// This seed isolates the callback authority after plan admission. It makes no
// static-publisher or browser certification claim; those have separate cases.
async function setup({
  admissionTarget = 'club-arena-engine',
  createCertificate = true,
  semanticBootstrap,
} = {}) {
  const config = await cluster.database({ additionalMigrations: migrations });
  const admin = await db(config),
    controllerName = `controller_${randomUUID().replaceAll('-', '')}`,
    callbackName = `callback_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE ROLE ${controllerName} LOGIN NOSUPERUSER; GRANT release_journal_controller TO ${controllerName};
    CREATE ROLE ${callbackName} LOGIN NOSUPERUSER; GRANT release_certification_callback TO ${callbackName}`);
  const client = await db({ ...config, user: controllerName }),
    callback = await db({ ...config, user: callbackName });
  const owner = await call(client, 'acquire_owner', [randomUUID(), 'native-controller']);
  const installation = await providerCall(admin, 'register_provider_installation', [
    'b'.repeat(64),
    {
      config_digest: 'c'.repeat(64),
      controller_principal: controllerName,
      host_id: 'native-fixture',
      service: 'club-arena-release-controller.service',
      native_lock_path: '/var/lib/club-arena-release-controller/controller.lock',
      schema_version: 1,
      provider_schema_version: 1,
      adapters: [
        'github-certification',
        'github-static',
        'component-aggregate',
        'github-compatibility',
      ],
      compatibility: {
        schema: semanticSchema,
        cutover_order: ['club-arena-engine', 'club-arena-web'],
        ...(semanticBootstrap ? { bootstrap: semanticBootstrap } : {}),
      },
      github: {
        control_sha: sha,
        workflow_id: 123,
        certification_workflow_id: 234,
        static_workflow_id: 235,
        component_qualification_workflow_id: 236,
        component_runtime_image: `node:22-slim@sha256:${'d'.repeat(64)}`,
        runtime_image: `node:22-slim@sha256:${'d'.repeat(64)}`,
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
    [installation.id]
  );
  const observed = await call(admin, 'inspect');
  await call(admin, 'reconcile', [
    owner.epoch,
    observed.controller.last_event,
    {
      instance_id: observed.controller.instance_id,
      verified: true,
      repository_heads: Object.fromEntries(policy.participants.map((p) => [p.repository, sha])),
      components: Object.fromEntries(policy.participants.map((p) => [p.target, {}])),
      unresolved_external_ids: [],
      receipt_refs: ['native-fixture-only'],
    },
    'native-verifier',
    'Isolated callback authority fixture',
  ]);
  const release = await call(admin, 'enqueue', [
    'fixture',
    {
      repository,
      project: policy.participants.find((p) => p.target === admissionTarget).project,
      target: admissionTarget,
      head_sha: sha,
      pull_request: 42,
      purpose: 'release',
      manifest: { components: [{ target: admissionTarget }] },
      dependencies: [],
    },
    'native-fixture',
  ]);
  const q = await call(client, 'claim_next', [
    owner.owner_id,
    owner.epoch,
    new Date(Date.now() + 3600000).toISOString(),
    'native-controller',
  ]);
  assert.equal(q.release_id, release.id);
  const binding = {
    principal: callbackName,
    repository,
    repository_id: '12345',
    workflow_id: '234',
    workflow_path: '.github/workflows/post-deploy-e2e.yml',
    control_sha: sha,
    control_ref: 'refs/heads/main',
    audience: 'club-arena-release-certification',
    url: 'https://release.example.invalid/certification',
  };
  const ingress = (
    await admin.query('SELECT release_ops.register_certification_ingress($1,$2,$3) AS v', [
      binding,
      Object.fromEntries(
        [
          'installed_code',
          'authenticated_ingress',
          'identity_membership',
          'exact_workflow',
          'reserved_auth_uuid',
          'cleanup_authority',
        ].map((k) => [k, ['native-fixture-only']])
      ),
      'native-verifier',
    ])
  ).rows[0].v;
  if (!createCertificate)
    return {
      config,
      admin,
      client,
      callback,
      callbackName,
      owner,
      release,
      q,
      binding,
      ingress,
      args: [owner.owner_id, owner.epoch],
      installation: { bundle_digest: 'b'.repeat(64), config_digest: 'c'.repeat(64) },
    };
  const fixture_roster = Object.fromEntries(
    fixtureSlots.map((slot) => {
      const user_id = randomUUID();
      return [slot, { user_id, email: `ca-customization-cert-${slot}-${user_id}@example.invalid` }];
    })
  );
  const component_tuple = {
    'club-arena-engine': {
      mode: 'changed',
      source_sha: sha,
      identity: `sha256:${'1'.repeat(64)}`,
      publication_operation_id: randomUUID(),
    },
    'club-arena-web': {
      mode: 'retained',
      source_sha: sha,
      identity: `sha256:${'2'.repeat(64)}`,
      manifest_digest: '2'.repeat(64),
      verified_receipt_id: randomUUID(),
      compatibility_receipt_id: randomUUID(),
    },
  };
  const request = {
    certificate_version: 2,
    phase: 'CERTIFY',
    repository,
    target: 'club-arena-engine',
    control_sha: sha,
    admission_sha: sha,
    workflow_id: 234,
    repository_id: '12345',
    release_id: release.id,
    manifest_digest: q.resolution_manifest_digest,
    component_tuple,
    fixture_roster,
    fixture_authority: {
      url: binding.url,
      audience: binding.audience,
      installation_receipt: ingress.id,
    },
    operation_policy_digest: operationPolicyDigest,
  };
  await admin.query("UPDATE release_ops.queue SET state='VERIFYING' WHERE release_id=$1", [
    release.id,
  ]);
  const event = (
    await admin.query(
      "SELECT release_ops.event($1,'CALLBACK_FIXTURE_SEED','native-fixture',$2) AS v",
      [release.id, request]
    )
  ).rows[0].v;
  const plan = (
    await admin.query(
      "INSERT INTO release_ops.source_plans(release_id,attempt_id,phase,adapter,request,event_id) VALUES($1,$2,'CERTIFY','github-certification',$3,$4) RETURNING *",
      [release.id, q.attempt_id, request, event]
    )
  ).rows[0];
  for (const [slot, account] of Object.entries(fixture_roster))
    await admin.query(
      'INSERT INTO release_ops.certification_fixture_intents(plan_id,slot,user_id,email,event_id) VALUES($1,$2,$3,$4,$5)',
      [plan.id, slot, account.user_id, account.email, event]
    );
  const args = [owner.owner_id, owner.epoch];
  const operation = await providerCall(client, 'begin_source_plan', [
    ...args,
    plan.id,
    'b'.repeat(64),
    'c'.repeat(64),
    'native-controller',
  ]);
  await providerCall(client, 'authorize_provider_submit', [
    ...args,
    operation.id,
    'b'.repeat(64),
    'c'.repeat(64),
    'native-controller',
  ]);
  const identity = {
    repository_id: '12345',
    workflow_id: '234',
    control_sha: sha,
    run_id: '345',
    run_attempt: 1,
  };
  const invoke = (
    action,
    slot = null,
    key = null,
    proof = null,
    who = identity,
    connection = callback
  ) =>
    certificationCall(connection, 'certification_fixture_callback', [
      operation.id,
      who,
      action,
      slot,
      key,
      proof,
    ]);
  return {
    config,
    admin,
    client,
    callback,
    callbackName,
    owner,
    release,
    plan,
    operation,
    request,
    binding,
    identity,
    invoke,
    args,
  };
}

test('callback ingress registration refuses every additional journal writer role', async () => {
  const t = await setup();
  const evidence = Object.fromEntries(
    [
      'installed_code',
      'authenticated_ingress',
      'identity_membership',
      'exact_workflow',
      'reserved_auth_uuid',
      'cleanup_authority',
      'same_run_artifact_gate',
      'native_origin_transaction',
    ].map((k) => [k, ['native-fixture']])
  );
  for (const role of [
    'release_journal_controller',
    'release_journal_operator',
    'release_journal_verifier',
    'release_journal_submitter',
  ]) {
    await t.admin.query(`GRANT ${role} TO ${t.callbackName}`);
    await assert.rejects(
      t.admin.query('SELECT release_ops.register_certification_ingress($1,$2,$3)', [
        t.binding,
        evidence,
        'native-verifier',
      ]),
      /INGRESS_INSTALLATION_REQUIRED/
    );
    await assert.rejects(
      t.admin.query('SELECT release_ops.register_static_publication_ingress($1,$2,$3)', [
        {
          ...t.binding,
          workflow_id: '235',
          workflow_path: '.github/workflows/publish-club-arena.yml',
          audience: 'club-arena-static-publication',
          url: 'https://release.example.invalid/static-publication',
        },
        evidence,
        'native-verifier',
      ]),
      /INGRESS_INSTALLATION_REQUIRED/
    );
    await t.admin.query(`REVOKE ${role} FROM ${t.callbackName}`);
  }
});

test('real PG persists the exact roster before one-use effects; duplicate/lost callback never grants creation again', async () => {
  const t = await setup(),
    key = randomUUID();
  const context = await certificationCall(t.callback, 'certification_callback_context', [
    t.operation.id,
  ]);
  assert.equal(Object.keys(context.request.fixture_roster).length, 9);
  const first = await t.invoke('consume', 'buyer', key);
  assert.equal(first.may_create, true);
  assert.equal(first.user_id, t.request.fixture_roster.buyer.user_id);
  const duplicate = await t.invoke('consume', 'buyer', key);
  assert.equal(duplicate.may_create, false);
  assert.equal(duplicate.claim_event, first.claim_event);
  await assert.rejects(t.invoke('consume', 'buyer', randomUUID()), /ALREADY_CONSUMED/);
  await assert.rejects(
    t.invoke('consume', 'observer', randomUUID(), null, { ...t.identity, run_id: '346' }),
    /RUN_ALREADY_OWNED/
  );
  const rows = await t.admin.query('SELECT count(*) FROM release_ops.certification_fixture_claims');
  assert.equal(rows.rows[0].count, '1');
});

test('real concurrent callback connections serialize one slot and cleanup permanently closes all create doors', async () => {
  const t = await setup(),
    other = await db({ ...t.config, user: t.callbackName }),
    key = randomUUID();
  const values = await Promise.all([
    t.invoke('consume', 'missions', key),
    t.invoke('consume', 'missions', key, null, t.identity, other),
  ]);
  assert.deepEqual(values.map((x) => x.may_create).sort(), [false, true]);
  await t.invoke('begin-cleanup');
  await assert.rejects(t.invoke('consume', 'observer', randomUUID()), /WINDOW_CLOSED/);
  await assert.rejects(
    t.admin.query('DELETE FROM release_ops.certification_fixture_intents'),
    /IMMUTABLE/
  );
  await assert.rejects(
    t.callback.query('SELECT * FROM release_ops.controller'),
    /permission denied/
  );
  await assert.rejects(
    call(t.callback, 'acquire_owner', [randomUUID(), 'forbidden']),
    /permission denied/
  );
});

test('cancelled runner cannot terminalize or free the global owner before exact nine-account cleanup', async () => {
  const t = await setup();
  await t.invoke('consume', 'postdeploy', randomUUID());
  const resolve = (proof) =>
    call(t.client, 'resolve_external', [
      ...t.args,
      t.operation.id,
      'CANCELLED',
      {
        operation_id: t.operation.id,
        terminal: true,
        outcome: 'CANCELLED',
        manifest_digest: t.request.manifest_digest,
        provider_operation_id: '345',
        proof,
        receipt_refs: ['native-fixture-only'],
      },
      'native-controller',
    ]);
  await assert.rejects(resolve({}), /DURABLE_FIXTURE_CLEANUP_REQUIRED/);
  await t.invoke('begin-cleanup');
  const proof = {
    operation_id: t.operation.id,
    run_id: '345',
    run_attempt: 1,
    accounts: Object.fromEntries(
      Object.entries(t.request.fixture_roster).map(([slot, account]) => [
        slot,
        { ...account, auth_absent: true, resources_absent: true, evidence_sha256: 'd'.repeat(64) },
      ])
    ),
  };
  const missing = structuredClone(proof);
  delete missing.accounts.freeze;
  await assert.rejects(
    t.invoke('cleanup-complete', null, null, missing),
    /EXACT_FIXTURE_CLEANUP_REQUIRED/
  );
  const dirty = structuredClone(proof);
  dirty.accounts.buyer.resources_absent = false;
  await assert.rejects(
    t.invoke('cleanup-complete', null, null, dirty),
    /EXACT_FIXTURE_CLEANUP_REQUIRED/
  );
  await assert.rejects(
    t.invoke('cleanup-complete', null, null, proof),
    /EXACT_FIXTURE_CLEANUP_REQUIRED/
  );
  await t.invoke('creation-result', 'postdeploy', null, {
    ...t.request.fixture_roster.postdeploy,
    outcome: 'CREATED',
  });
  const receipt = await t.invoke('cleanup-complete', null, null, proof);
  assert.equal((await t.invoke('cleanup-complete', null, null, proof)).duplicate, true);
  const terminal = await resolve({
    cleanup_receipt: receipt.cleanup_receipt,
    operation_id: t.operation.id,
    run_id: '345',
    run_attempt: 1,
    control_sha: sha,
    request: t.request,
  });
  assert.equal(terminal.status, 'CANCELLED');
  const current = await call(t.admin, 'inspect');
  assert.equal(current.controller.active_release, t.release.id); // owned recovery still required
});

function signer(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' },
    token(claims, header = {}) {
      const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid, ...header })).toString(
        'base64url'
      );
      const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
    },
  };
}
test('actual signed OIDC claims and rotated JWKS gate the real PG callback; wrong repo/run/audience/replay refuse', async () => {
  const t = await setup(),
    first = signer('first'),
    rotated = signer('rotated'),
    now = Date.now();
  let keys = [first.jwk],
    reads = 0;
  const verifier = new GitHubCertificateIdentity({
    binding: t.binding,
    now: () => now,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://token.actions.githubusercontent.com/.well-known/jwks');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['Cache-Control'], 'no-cache');
      reads++;
      return new Response(JSON.stringify({ keys }));
    },
  });
  const claims = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: t.binding.audience,
    sub: `repo:${repository}:ref:refs/heads/main`,
    repository,
    repository_id: '12345',
    sha,
    workflow_sha: sha,
    ref: 'refs/heads/main',
    workflow_ref: `${repository}/.github/workflows/post-deploy-e2e.yml@refs/heads/main`,
    event_name: 'workflow_dispatch',
    run_id: '345',
    run_attempt: '1',
    jti: randomUUID(),
    iat: Math.floor(now / 1000),
    nbf: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 300,
  };
  assert.equal((await verifier.authenticate(first.token(claims))).run_id, '345');
  keys = [rotated.jwk];
  assert.equal((await verifier.authenticate(rotated.token(claims))).run_id, '345');
  assert.equal(reads, 2);
  for (const changes of [
    { aud: 'wrong' },
    { repository_id: '999' },
    { run_attempt: '2' },
    { workflow_sha: 'b'.repeat(40) },
    { exp: Math.floor(now / 1000) - 1 },
    { iss: 'https://evil.invalid' },
  ])
    await assert.rejects(verifier.authenticate(rotated.token({ ...claims, ...changes })));
  await assert.rejects(
    verifier.authenticate(rotated.token(claims, { jku: 'https://evil.invalid' }))
  );
  const run = {
    id: 345,
    run_attempt: 1,
    workflow_id: 234,
    head_sha: sha,
    path: t.binding.workflow_path,
    event: 'workflow_dispatch',
    repository: { id: 12345 },
    head_repository: { id: 12345 },
    display_title: `release:${t.operation.id}:CERTIFY`,
    status: 'in_progress',
  };
  const handler = new CertificateCallback({
    identity: verifier,
    database: () => db({ ...t.config, user: t.callbackName }),
    github: async (route) =>
      route.includes('/runs?') ? { total_count: 1, workflow_runs: [run] } : run,
    componentReadback: async () => ({ served_components: t.request.component_tuple }),
  });
  const key = randomUUID(),
    body = { operation_id: t.operation.id, action: 'consume', slot: 'freeze', claim_key: key },
    authorization = `Bearer ${rotated.token(claims)}`;
  assert.equal((await handler.handle({ authorization, body })).may_create, true);
  assert.equal((await handler.handle({ authorization, body })).may_create, false);
});

test('original intent timestamp survives repeated projection; wrong and missing intent events refuse', async () => {
  const t = await setup();
  const original = (
    await t.admin.query('SELECT created_at FROM release_ops.events WHERE id=$1', [
      t.operation.intent_event,
    ])
  ).rows[0].created_at;
  for (let i = 0; i < 2; i++) {
    const projected = await providerCall(t.client, 'provider_operation_context', [
      ...t.args,
      t.operation.id,
    ]);
    assert.equal(Date.parse(projected.created_at), original.getTime());
  }
  await assert.rejects(
    providerCall(t.client, 'provider_operation_context', [...t.args, randomUUID()]),
    /EXTERNAL_INTENT_EVENT_REQUIRED/
  );
  for (const [kind, data, releaseId] of [
    ['OTHER_EVENT', t.operation.intent, t.release.id],
    ['EXTERNAL_INTENT', { wrong: true }, t.release.id],
    ['EXTERNAL_INTENT', t.operation.intent, null],
  ]) {
    const event = (
      await t.admin.query('SELECT release_ops.event($1,$2,$3,$4) AS v', [
        releaseId,
        kind,
        'native-negative-fixture',
        data,
      ])
    ).rows[0].v;
    const malformed = (
      await t.admin.query(
        `INSERT INTO release_ops.external_operations
      (release_id,operation_key,owner_id,epoch,kind,intent,intent_event,resume_state,status)
      VALUES($1,$2,$3,$4,'CERTIFY',$5,$6,'VERIFYING','NOT_ACCEPTED') RETURNING id`,
        [t.release.id, randomUUID(), t.owner.owner_id, t.owner.epoch, t.operation.intent, event]
      )
    ).rows[0].id;
    await assert.rejects(
      providerCall(t.client, 'provider_operation_context', [...t.args, malformed]),
      /EXTERNAL_INTENT_EVENT_REQUIRED/
    );
  }
});

test('read-only reconciliation and disabled execution cannot authorize cleanup dispatch; a lost reply is never resent', async () => {
  const t = await setup();
  let submissions = 0;
  const original = {
    ...t.identity,
    operation_id: t.operation.id,
    status: 'completed',
    conclusion: 'cancelled',
  };
  const adapter = {
    validate() {},
    async reconcile(request, operation) {
      return {
        terminal: false,
        cleanup_required: !operation.cleanup_recovery,
        reason: 'CLEANUP_PENDING',
      };
    },
    async cleanupOriginal() {
      return original;
    },
    async submitCleanup() {
      submissions++;
      throw new Error('lost accepted cleanup dispatch reply');
    },
  };
  const runner = new ProviderRunner({
    client: t.client,
    owner: t.owner,
    installation: { bundle_digest: 'b'.repeat(64), config_digest: 'c'.repeat(64) },
    adapters: { 'github-certification': adapter },
  });
  await runner.reconcile(t.operation, { execute: false });
  assert.equal(submissions, 0);
  assert.equal(
    (
      await t.admin.query(
        'SELECT count(*)::integer AS n FROM release_ops.certification_cleanup_recoveries'
      )
    ).rows[0].n,
    0
  );
  await t.admin.query('UPDATE release_ops.controller SET execution_enabled=false');
  await assert.rejects(
    providerCall(t.client, 'authorize_certification_cleanup', [
      ...t.args,
      t.operation.id,
      original,
      'b'.repeat(64),
      'c'.repeat(64),
      'native-controller',
    ]),
    /EXECUTION_NOT_ACTIVATED/
  );
  await runner.reconcile(t.operation, { execute: true });
  assert.equal(submissions, 0);
  await t.admin.query('UPDATE release_ops.controller SET execution_enabled=true');
  await runner.reconcile(t.operation, { execute: true });
  assert.equal(submissions, 1);
  const recovery = (
    await providerCall(t.client, 'provider_operation_context', [...t.args, t.operation.id])
  ).cleanup_recovery;
  assert.ok(recovery.id);
  await runner.reconcile(t.operation, { execute: false });
  await runner.reconcile(t.operation, { execute: true });
  assert.equal(submissions, 1);
  assert.equal(
    (await providerCall(t.client, 'provider_operation_context', [...t.args, t.operation.id]))
      .cleanup_recovery.id,
    recovery.id
  );
});

test('cleanup-only recovery keeps original outcome, one dispatch, exact new run, and unresolved create blockers', async () => {
  const t = await setup();
  await t.invoke('consume', 'buyer', randomUUID());
  const original = {
    ...t.identity,
    operation_id: t.operation.id,
    status: 'completed',
    conclusion: 'cancelled',
  };
  const authorize = (run = original) =>
    providerCall(t.client, 'authorize_certification_cleanup', [
      ...t.args,
      t.operation.id,
      run,
      'b'.repeat(64),
      'c'.repeat(64),
      'native-controller',
    ]);
  await assert.rejects(authorize({ ...original, status: 'in_progress' }), /SCOPE_REFUSED/);
  await assert.rejects(authorize({ ...original, run_id: '987' }), /ALREADY_OWNED/);
  const recovery = await authorize();
  assert.equal(recovery.may_submit, true);
  assert.equal((await authorize()).may_submit, false);
  assert.equal((await authorize()).id, recovery.id);
  await assert.rejects(
    t.invoke('consume', 'observer', randomUUID()),
    /ORIGINAL_CERTIFICATION_RUN_RETIRED/
  );
  const next = { ...t.identity, run_id: '456' };
  const invoke = (
    action,
    slot = null,
    proof = null,
    identity = next,
    recoveryId = recovery.id,
    operationId = t.operation.id
  ) =>
    certificationCall(t.callback, 'certification_fixture_callback', [
      operationId,
      identity,
      action,
      slot,
      null,
      proof,
      recoveryId,
    ]);
  await assert.rejects(invoke('consume', 'observer'), /CLEANUP_ONLY_ACTION_REFUSED/);
  await assert.rejects(
    invoke('begin-cleanup', null, null, t.identity),
    /CLEANUP_ONLY_ACTION_REFUSED/
  );
  await assert.rejects(
    invoke('begin-cleanup', null, null, next, randomUUID()),
    /RECOVERY_SCOPE_REFUSED/
  );
  await assert.rejects(
    invoke('begin-cleanup', null, null, next, recovery.id, randomUUID()),
    /CALLBACK_SCOPE_REFUSED/
  );
  await invoke('begin-cleanup');
  await assert.rejects(
    invoke('begin-cleanup', null, null, { ...next, run_id: '457' }),
    /CLEANUP_RUN_ALREADY_OWNED/
  );
  const proof = {
    operation_id: t.operation.id,
    run_id: '456',
    run_attempt: 1,
    accounts: Object.fromEntries(
      Object.entries(t.request.fixture_roster).map(([slot, account]) => [
        slot,
        { ...account, auth_absent: true, resources_absent: true, evidence_sha256: 'd'.repeat(64) },
      ])
    ),
  };
  await assert.rejects(invoke('cleanup-complete', null, proof), /EXACT_FIXTURE_CLEANUP_REQUIRED/);
  await assert.rejects(
    invoke('creation-result', 'buyer', {
      ...t.request.fixture_roster.buyer,
      outcome: 'NOT_SUBMITTED',
    }),
    /CLEANUP_ONLY_ACTION_REFUSED/
  );
  await invoke('creation-result', 'buyer', {
    ...t.request.fixture_roster.buyer,
    outcome: 'CREATED',
  });
  const cleanup = await invoke('cleanup-complete', null, proof);
  const projected = await providerCall(t.client, 'provider_operation_context', [
    ...t.args,
    t.operation.id,
  ]);
  assert.equal(projected.cleanup_recovery.id, recovery.id);
  assert.equal(projected.fixture_cleanup.event_id, cleanup.cleanup_receipt);
  const result = {
    operation_id: t.operation.id,
    terminal: true,
    outcome: 'SUCCEEDED',
    provider_operation_id: '345',
    manifest_digest: t.request.manifest_digest,
    proof: {
      operation_id: t.operation.id,
      control_sha: sha,
      request: t.request,
      run_id: '345',
      run_attempt: 1,
      success: true,
      cleanup_receipt: cleanup.cleanup_receipt,
    },
    receipt_refs: ['native-fixture'],
  };
  await assert.rejects(
    call(t.client, 'resolve_external', [
      ...t.args,
      t.operation.id,
      'SUCCEEDED',
      result,
      'native-controller',
    ]),
    /FULL_COMPONENT_CERTIFICATE_REQUIRED/
  );
  result.outcome = 'CANCELLED';
  result.proof.success = false;
  assert.equal(
    (
      await call(t.client, 'resolve_external', [
        ...t.args,
        t.operation.id,
        'CANCELLED',
        result,
        'native-controller',
      ])
    ).status,
    'CANCELLED'
  );
  assert.equal((await call(t.admin, 'inspect')).controller.active_release, t.release.id);
});

for (const aggregate of [false, true])
  test(`${aggregate ? 'aggregate' : 'ordinary'} real static artifact and private PG preserve build ownership through one same-run publication and certification`, async () => {
    const native = await staticArtifactFixture();
    const bootstrapBefore = {
      'club-arena-engine': { source_sha: '9'.repeat(40), identity: `sha256:${'9'.repeat(64)}` },
      'club-arena-web': {
        source_sha: sha,
        identity: `sha256:${native.manifestDigest}`,
        manifest_digest: native.manifestDigest,
      },
    };
    const semanticBootstrap = {
      before_components: bootstrapBefore,
      retained_artifacts: Object.fromEntries(
        Object.entries(bootstrapBefore).map(([target, component], index) => [
          target,
          {
            target,
            ...component,
            build_run_id: String(990 + index),
            artifact_id: String(992 + index),
            archive_digest: `sha256:${'9'.repeat(64)}`,
          },
        ])
      ),
    };
    const t = await setup({
      admissionTarget: 'club-arena-web',
      createCertificate: false,
      semanticBootstrap,
    });
    try {
      let q = t.q;
      const selected = {};
      const select = async (kind, data, receiptKey = randomUUID()) => {
        q = (await providerCall(t.client, 'source_snapshot', t.args)).queue;
        const event = await call(t.client, 'record_receipt', [
          ...t.args,
          t.release.id,
          receiptKey,
          kind,
          {
            ...data,
            success: true,
            manifest_digest: q.resolution_manifest_digest,
            receipt_refs: ['isolated-native-qualification'],
          },
          'native-controller',
        ]);
        q = await call(t.client, 'select_receipt', [
          ...t.args,
          t.release.id,
          q.state_version,
          event,
          'native-controller',
        ]);
        selected[kind] = event;
        return event;
      };
      const advance = async (state) => {
        q = (await providerCall(t.client, 'source_snapshot', t.args)).queue;
        q = await call(t.client, 'transition', [
          ...t.args,
          t.release.id,
          q.state_version,
          state,
          'native-controller',
          'Local qualified fixture transition',
        ]);
      };
      // Upstream source qualification is an explicit fixture input. Native
      // build/artifact/publication below use the real adapters and journal doors.
      await select('VALIDATION', {
        accepted_head_sha: sha,
        expected_base_sha: 'b'.repeat(40),
        tested_tree_sha: 'c'.repeat(40),
      });
      await advance('MERGING');
      await select('INTEGRATION', {
        validation_receipt: selected.VALIDATION,
        accepted_head_sha: sha,
        expected_base_sha: 'b'.repeat(40),
        merged_sha: sha,
        merged_tree_sha: 'c'.repeat(40),
      });
      await advance('BUILDING');
      const binding = {
        ...t.binding,
        workflow_id: '235',
        workflow_path: '.github/workflows/publish-club-arena.yml',
        audience: 'club-arena-static-publication',
        url: 'https://release.example.invalid/static-publication',
      };
      const ingress = (
        await t.admin.query(
          'SELECT release_ops.register_static_publication_ingress($1,$2,$3) AS v',
          [
            binding,
            Object.fromEntries(
              [
                'installed_code',
                'authenticated_ingress',
                'identity_membership',
                'exact_workflow',
                'same_run_artifact_gate',
                'native_origin_transaction',
              ].map((k) => [k, ['native-fixture-only']])
            ),
            'native-verifier',
          ]
        )
      ).rows[0].v;
      const request = {
        static_version: 1,
        phase: 'BUILD',
        target: 'club-arena-web',
        repository,
        repository_id: '12345',
        workflow_id: 235,
        control_sha: sha,
        source_sha: sha,
        accepted_head_sha: sha,
        manifest_digest: q.resolution_manifest_digest,
        not_after_epoch: Math.floor(Date.parse(q.attempt_deadline) / 1000),
        static_authority: {
          url: binding.url,
          audience: binding.audience,
          installation_receipt: ingress.id,
        },
      };
      if (aggregate)
        Object.assign(request, {
          expected_base_sha: 'b'.repeat(40),
          tested_tree_sha: 'c'.repeat(40),
          components: ['club-arena-web'],
        });
      const aggregateRequest = {
        aggregate_version: 1,
        phase: 'BUILD',
        repository,
        target: 'club-arena-web',
        source_sha: sha,
        control_sha: sha,
        accepted_head_sha: sha,
        expected_base_sha: 'b'.repeat(40),
        tested_tree_sha: 'c'.repeat(40),
        manifest_digest: q.resolution_manifest_digest,
        components: ['club-arena-web'],
        children: { 'club-arena-web': { adapter: 'github-static', request } },
      };
      const plan = await providerCall(
        t.client,
        aggregate ? 'submit_aggregate_source_plan' : 'submit_static_build_plan',
        [
          ...t.args,
          t.release.id,
          aggregate ? aggregateRequest : request,
          'b'.repeat(64),
          'c'.repeat(64),
          'native-controller',
        ]
      );
      let build = await providerCall(t.client, 'begin_source_plan', [
        ...t.args,
        plan.id,
        'b'.repeat(64),
        'c'.repeat(64),
        'native-controller',
      ]);
      await providerCall(t.client, 'authorize_provider_submit', [
        ...t.args,
        build.id,
        'b'.repeat(64),
        'c'.repeat(64),
        'native-controller',
      ]);
      const parentBuild = build;
      if (aggregate) {
        await providerCall(t.client, 'prepare_qualification_children', [
          ...t.args,
          build.id,
          'b'.repeat(64),
          'c'.repeat(64),
          'native-controller',
        ]);
        const children = await providerCall(t.client, 'qualification_snapshot', [
          ...t.args,
          build.id,
        ]);
        build = children.children[0];
        await providerCall(t.client, 'authorize_qualification_child', [
          ...t.args,
          build.id,
          'b'.repeat(64),
          'c'.repeat(64),
          'native-controller',
        ]);
      }
      const identity = {
        repository_id: '12345',
        workflow_id: '235',
        control_sha: sha,
        run_id: '567',
        run_attempt: 1,
      };
      const key = randomUUID();
      const grant = () =>
        certificationCall(t.callback, 'claim_static_publication', [build.id, identity, key]);
      assert.deepEqual(await grant(), { ready: false });
      let artifact = {
        identity: `sha256:${native.manifestDigest}`,
        manifest_digest: native.manifestDigest,
        source_sha: sha,
        github_artifact_id: '800',
        github_archive_digest: `sha256:${'e'.repeat(64)}`,
        github_archive_bytes: 512,
        build_operation_id: build.id,
        build_run_id: '567',
      };
      let phase = 'BUILD',
        publication,
        proof = {
          operation_id: build.id,
          request,
          control_sha: sha,
          run_id: '567',
          run_attempt: 1,
          job_id: '100',
          success: true,
          artifact: { components: { 'club-arena-web': artifact } },
        };
      let run = {
        id: 567,
        workflow_id: 235,
        path: binding.workflow_path,
        head_sha: sha,
        event: 'repository_dispatch',
        head_branch: 'main',
        run_attempt: 1,
        repository: { id: 12345 },
        head_repository: { id: 12345 },
        display_title: `release:${build.id}:STATIC`,
        status: 'in_progress',
      };
      let writes = 0;
      const github = async (route, options) => {
        if (options?.method === 'POST') {
          writes++;
          return { status: 204 };
        }
        if (route.includes('/git/ref/')) return { object: { sha } };
        if (route.endsWith('/actions/workflows/235'))
          return { id: 235, path: binding.workflow_path, state: 'active' };
        if (route.includes('/runs?')) return { total_count: 1, workflow_runs: [run] };
        if (route.endsWith('/runs/567')) return run;
        if (route.includes('/jobs?'))
          return {
            total_count: 1,
            jobs: [
              {
                id: phase === 'BUILD' ? 100 : 101,
                name: phase === 'BUILD' ? 'build-and-store' : 'publish-to-origin',
                status: 'completed',
                conclusion: 'success',
              },
            ],
          };
        const zip = receiptZip(proof),
          digest = `sha256:${createHash('sha256').update(zip).digest('hex')}`;
        if (route.endsWith('/artifacts/801/zip')) return zip;
        if (route.includes('/artifacts?'))
          return {
            total_count: 2,
            artifacts: [
              {
                id: 800,
                name: `club-arena-dist-${sha}`,
                digest: artifact.github_archive_digest,
                expired: false,
                size_in_bytes: 512,
              },
              {
                id: 801,
                name: `release-${phase === 'BUILD' ? 'build' : 'publication'}-${phase === 'BUILD' ? build.id : publication.id}`,
                digest,
                expired: false,
              },
            ],
          };
        if (route.endsWith('/artifacts/800'))
          return {
            id: 800,
            digest: artifact.github_archive_digest,
            expired: false,
            workflow_run: { id: 567 },
          };
        throw Error(`unexpected API ${route}`);
      };
      const adapter = new GitHubStaticAdapter({
        repo: repository,
        repositoryId: '12345',
        workflowId: 235,
        controlSha: sha,
        request: github,
        readNative: native.readNative,
        readPublic: native.readPublic,
      });
      await adapter.preflight(request);
      await adapter.submit(request, build);
      assert.equal(writes, 1);
      const context = aggregate
        ? build
        : await providerCall(t.client, 'provider_operation_context', [...t.args, build.id]);
      const built = await adapter.reconcile(request, context);
      assert.equal(built.outcome, 'SUCCEEDED');
      let aggregateProof;
      let buildTerminal = built;
      if (aggregate) {
        await providerCall(t.client, 'record_qualification_result', [
          ...t.args,
          build.id,
          { ...built, operation_id: build.id, manifest_digest: request.manifest_digest },
          'native-controller',
        ]);
        buildTerminal = await providerCall(t.client, 'qualification_terminal', [
          ...t.args,
          parentBuild.id,
        ]);
        aggregateProof = buildTerminal.proof;
        artifact = aggregateProof.artifact.components['club-arena-web'];
        assert.equal(artifact.build_operation_id, build.id);
        assert.equal(artifact.aggregate_operation_id, parentBuild.id);
        assert.notEqual(build.id, parentBuild.id);
        assert.deepEqual(await grant(), { ready: false });
      }
      await call(t.client, 'resolve_external', [
        ...t.args,
        parentBuild.id,
        'SUCCEEDED',
        {
          ...buildTerminal,
          operation_id: parentBuild.id,
          manifest_digest: request.manifest_digest,
          receipt_refs: ['actual-native-artifact'],
        },
        'native-controller',
      ]);
      await select(
        'BUILD',
        {
          integration_receipt: selected.INTEGRATION,
          source_sha: sha,
          artifact: aggregateProof?.artifact ?? proof.artifact,
          ...(aggregate
            ? {
                aggregate_operation_id: parentBuild.id,
                component_qualifications: aggregateProof.component_qualifications,
                build_run_id: buildTerminal.provider_operation_id,
                database_doors: aggregateProof.database_doors,
              }
            : {}),
        },
        aggregate ? parentBuild.id : randomUUID()
      );
      await advance('STAGED');
      let compatibilityReceipt = {};
      if (aggregate) {
        await assert.rejects(
          select('STAGED', { build_receipt: selected.BUILD, compatibility_verified: true }),
          /OWNED_COMPONENT_COMPATIBILITY_REQUIRED/
        );
        const before = {
          'club-arena-engine': { source_sha: '9'.repeat(40), identity: `sha256:${'9'.repeat(64)}` },
          'club-arena-web': {
            source_sha: sha,
            identity: artifact.identity,
            manifest_digest: artifact.manifest_digest,
          },
        };
        const qualification = {
          version: 1,
          release_id: t.release.id,
          manifest_digest: q.resolution_manifest_digest,
          build_receipt: selected.BUILD,
          aggregate_operation_id: parentBuild.id,
          source_sha: sha,
          component_builds: {
            'club-arena-web': {
              source_sha: sha,
              identity: artifact.identity,
              manifest_digest: artifact.manifest_digest,
              build_operation_id: build.id,
              build_run_id: artifact.build_run_id,
              qualification_result_event: artifact.qualification_result_event,
              artifact_id: artifact.github_artifact_id,
              archive_digest: artifact.github_archive_digest,
            },
          },
          cutover_order: ['club-arena-web'],
          schema: semanticSchema,
          tuples: [before, structuredClone(before)],
          artifact_inputs: Object.fromEntries(
            Object.values(semanticBootstrap.retained_artifacts).map((part) => [
              factDigest(part),
              part,
            ])
          ),
          baseline: baselineGeneration(
            await certificationCall(t.client, 'component_compatibility_baseline', [t.release.id])
          ),
        };
        const semanticRequest = {
          phase: 'COMPATIBILITY',
          repository,
          target: 'club-arena-web',
          source_sha: sha,
          accepted_head_sha: sha,
          expected_base_sha: 'b'.repeat(40),
          tested_tree_sha: 'c'.repeat(40),
          manifest_digest: q.resolution_manifest_digest,
          control_sha: sha,
          workflow_id: 236,
          runtime_image: `node:22-slim@sha256:${'d'.repeat(64)}`,
          qualification,
        };
        const prepare = (value) =>
          providerCall(t.client, 'submit_component_compatibility_plan', [
            ...t.args,
            t.release.id,
            value,
            'b'.repeat(64),
            'c'.repeat(64),
            'native-controller',
          ]);
        await assert.rejects(
          prepare({
            ...semanticRequest,
            qualification: { ...qualification, build_receipt: randomUUID() },
          }),
          /OWNED_COMPONENT_COMPATIBILITY_PLAN_REQUIRED/
        );
        const compatibilityPlan = await prepare(semanticRequest);
        assert.equal((await prepare(semanticRequest)).id, compatibilityPlan.id);
        // Semantic behavior is an explicit isolated fixture input in this journal
        // integration test; the native semantic runner has its own execution suite.
        let semanticSubmissions = 0;
        const semanticCleanup = (op) => ({
          version: 1,
          complete: true,
          images_removed: true,
          operation_id: op.id,
          run_id: '999',
          run_attempt: 1,
          request_digest: factDigest(qualification),
          fixtures: qualification.tuples.map((tuple, index) => ({
            index,
            complete: true,
            remaining_objects: 0,
            tuple_digest: factDigest(tuple),
          })),
        });
        const semanticAdapter = {
          validate() {},
          async preflight() {
            return { workflow_id: 236 };
          },
          async submit() {
            semanticSubmissions++;
            throw new Error('lost workflow dispatch reply');
          },
          async reconcile(r, op) {
            const semantic = {
              version: 1,
              verified: true,
              operation_id: op.id,
              request: qualification,
              request_digest: factDigest(qualification),
              control_sha: sha,
              workflow_id: 236,
              workflow_path: '.github/workflows/release-component-qualification.yml',
              run_id: '999',
              run_attempt: 1,
              artifact_id: '1000',
              archive_digest: `sha256:${'8'.repeat(64)}`,
              cleanup: semanticCleanup(op),
              combinations: qualification.tuples.map((tuple) => ({
                tuple_digest: factDigest(tuple),
                success: true,
                failed: 0,
                retries: 0,
                skipped: 0,
                executed: 5,
                cleanup: { complete: true, remaining_objects: 0 },
              })),
            };
            return {
              terminal: true,
              outcome: 'SUCCEEDED',
              accepted: true,
              provider_operation_id: '999',
              proof: {
                operation_id: op.id,
                request: r,
                control_sha: sha,
                run_id: '999',
                run_attempt: 1,
                success: true,
                compatibility: semantic,
              },
            };
          },
        };
        const semanticRunner = new ProviderRunner({
          client: t.client,
          owner: t.owner,
          installation: { bundle_digest: 'b'.repeat(64), config_digest: 'c'.repeat(64) },
          adapters: { 'github-compatibility': semanticAdapter },
        });
        await semanticRunner.submit(compatibilityPlan, 'begin_source_plan');
        const pending = (await semanticRunner.snapshot()).external;
        assert.equal(pending.intent.adapter, 'github-compatibility');
        await assert.rejects(
          select('STAGED', { build_receipt: selected.BUILD, compatibility_verified: true }),
          /OWNED_COMPONENT_COMPATIBILITY_REQUIRED/
        );
        assert.equal(
          (
            await t.admin.query('SELECT release_ops.component_fact_digest($1::jsonb) AS digest', [
              JSON.stringify(qualification),
            ])
          ).rows[0].digest,
          factDigest(qualification)
        );
        const semanticTerminalArgs = (terminal) => [
          ...t.args,
          pending.id,
          terminal.outcome,
          {
            ...terminal,
            operation_id: pending.id,
            manifest_digest: pending.intent.manifest_digest,
            receipt_refs: ['explicit-isolated-semantic-protocol-fixture'],
          },
          'native-controller',
        ];
        const resolveSemantic = (terminal) =>
          call(t.client, 'resolve_external', semanticTerminalArgs(terminal));
        const failure = {
          terminal: true,
          outcome: 'FAILED',
          accepted: true,
          provider_operation_id: '999',
          proof: {
            operation_id: pending.id,
            request: semanticRequest,
            control_sha: sha,
            run_id: '999',
            run_attempt: 1,
            success: false,
            cleanup: semanticCleanup(pending),
            cleanup_artifact_id: '1001',
            cleanup_archive_digest: `sha256:${'7'.repeat(64)}`,
          },
        };
        for (const corrupt of [
          (x) => {
            delete x.proof;
          },
          (x) => {
            delete x.proof.cleanup;
          },
          (x) => {
            delete x.proof.cleanup_artifact_id;
          },
          (x) => {
            x.proof.request = { ...x.proof.request, source_sha: 'f'.repeat(40) };
          },
          (x) => {
            x.proof.cleanup.operation_id = randomUUID();
          },
          (x) => {
            x.proof.cleanup.run_id = '1000';
          },
          (x) => {
            x.proof.cleanup.request_digest = '0'.repeat(64);
          },
          (x) => {
            x.proof.cleanup.images_removed = false;
          },
          (x) => {
            x.proof.cleanup.fixtures[0].tuple_digest = '0'.repeat(64);
          },
          (x) => {
            x.proof.cleanup.fixtures[0].remaining_objects = 1;
          },
          (x) => {
            x.proof.cleanup.fixtures.push(x.proof.cleanup.fixtures[0]);
          },
        ]) {
          const invalid = structuredClone(failure);
          corrupt(invalid);
          await assert.rejects(
            resolveSemantic(invalid),
            /COMPONENT_COMPATIBILITY_(PROOF|FAILURE_CLEANUP|CLEANUP)_REQUIRED/
          );
        }
        // A failed run may have started only a prefix of the planned fixtures.
        // Prove it can settle once that exact prefix and loaded images are absent,
        // then roll back this protocol probe to retain the real success scenario.
        const partialFailure = structuredClone(failure);
        partialFailure.proof.cleanup.fixtures.length = 1;
        await t.client.query('BEGIN');
        try {
          assert.equal(
            (
              await t.client.query(
                'SELECT release_ops.resolve_external($1,$2,$3,$4,$5,$6) AS value',
                semanticTerminalArgs(partialFailure)
              )
            ).rows[0].value.status,
            'FAILED'
          );
        } finally {
          await t.client.query('ROLLBACK');
        }
        const success = await semanticAdapter.reconcile(semanticRequest, pending);
        for (const corrupt of [
          (x) => {
            x.proof.compatibility.cleanup.images_removed = false;
          },
          (x) => {
            x.proof.compatibility.cleanup.fixtures.length = 1;
          },
          (x) => {
            x.proof.compatibility.combinations[0].cleanup.remaining_objects = 1;
          },
          (x) => {
            x.proof.compatibility.combinations[0].tuple_digest = '0'.repeat(64);
          },
        ]) {
          const invalid = structuredClone(success);
          corrupt(invalid);
          await assert.rejects(
            resolveSemantic(invalid),
            /EXACT_COMPONENT_COMPATIBILITY_(PROOF|CLEANUP)_REQUIRED/
          );
        }
        assert.equal(
          (await providerCall(t.client, 'source_snapshot', t.args)).compatibility_operation.status,
          'UNKNOWN'
        );
        await semanticRunner.reconcile(pending, { execute: false });
        const result = (await providerCall(t.client, 'source_snapshot', t.args))
          .compatibility_operation;
        assert.equal(result.status, 'SUCCEEDED');
        assert.equal(result.id, pending.id);
        assert.equal(semanticSubmissions, 1);
        compatibilityReceipt = {
          compatibility_operation_id: result.id,
          semantic_qualification: result.result.proof.compatibility,
        };
      }
      await select('STAGED', {
        build_receipt: selected.BUILD,
        compatibility_verified: true,
        ...compatibilityReceipt,
      });
      await advance('READY');
      const publish = {
        ...request,
        phase: 'PUBLISH',
        build_operation_id: build.id,
        build_run_id: '567',
        artifact,
        expected_current: { source_sha: sha, manifest_digest: native.manifestDigest },
      };
      // A preserved verified engine receipt is fixture prehistory. This test
      // never claims to install or recertify that engine image.
      const prior = await call(t.admin, 'enqueue', [
        'prior-engine-fixture',
        {
          repository,
          project: 'engine-01',
          target: 'club-arena-engine',
          head_sha: '9'.repeat(40),
          pull_request: 41,
          purpose: 'release',
          manifest: { components: [{ target: 'club-arena-engine' }] },
          dependencies: [],
        },
        'native-fixture',
      ]);
      const retained = {
        mode: 'retained',
        source_sha: '9'.repeat(40),
        identity: `sha256:${'9'.repeat(64)}`,
      };
      const priorEvent = (
        await t.admin.query(
          "SELECT release_ops.event($1,'RECEIPT_CERTIFICATION','native-prehistory-fixture',$2) AS v",
          [prior.id, { success: true, served_components: { 'club-arena-engine': retained } }]
        )
      ).rows[0].v;
      await t.admin.query(
        "INSERT INTO release_ops.receipts VALUES($1,'preserved','CERTIFICATION',$2,$3,NULL)",
        [
          prior.id,
          { success: true, served_components: { 'club-arena-engine': retained } },
          priorEvent,
        ]
      );
      await t.admin.query(
        "UPDATE release_ops.queue SET state='VERIFIED',selected_receipts=$2 WHERE release_id=$1",
        [prior.id, { CERTIFICATION: priorEvent }]
      );
      retained.verified_receipt_id = priorEvent;
      await select('READINESS', {
        ...compatibilityReceipt,
        stage_receipt: selected.STAGED,
        technical_gates_passed: true,
        expected_current: publish.expected_current,
        static_expected_current: publish.expected_current,
        retained_components: { 'club-arena-engine': retained },
        provider_requests: { 'github-static': publish },
      });
      await advance('APPLYING');
      const pubPlan = await providerCall(t.client, 'submit_static_publication_plan', [
        ...t.args,
        t.release.id,
        'static-publish',
        publish,
        'b'.repeat(64),
        'c'.repeat(64),
        'native-controller',
      ]);
      publication = await providerCall(t.client, 'begin_provider_plan', [
        ...t.args,
        pubPlan.id,
        'b'.repeat(64),
        'c'.repeat(64),
        'native-controller',
      ]);
      assert.deepEqual(await grant(), { ready: false });
      await adapter.preflight(publish);
      await providerCall(t.client, 'authorize_provider_submit', [
        ...t.args,
        publication.id,
        'b'.repeat(64),
        'c'.repeat(64),
        'native-controller',
      ]);
      await adapter.submit(publish, publication);
      assert.equal(writes, 1, 'PUBLISH never dispatches a second writer');
      const accepted = await grant();
      assert.equal(accepted.may_publish, true);
      assert.equal(accepted.operation_id, publication.id);
      assert.equal((await grant()).may_publish, false);
      await assert.rejects(
        certificationCall(t.callback, 'claim_static_publication', [
          build.id,
          { ...identity, run_id: '568' },
          key,
        ]),
        /RUN_MISMATCH/
      );
      await assert.rejects(
        certificationCall(t.callback, 'claim_static_publication', [
          build.id,
          identity,
          randomUUID(),
        ]),
        /ALREADY_CLAIMED/
      );
      await assert.rejects(advance('VERIFYING'), /EXTERNAL_OUTCOME_UNRESOLVED/);
      phase = 'PUBLISH';
      run = { ...run, status: 'completed', conclusion: 'success' };
      proof = {
        operation_id: publication.id,
        request: publish,
        control_sha: sha,
        run_id: '567',
        run_attempt: 1,
        job_id: '101',
        success: true,
        component: artifact,
        native: await native.readNative(),
        publication_claim: accepted.claim_receipt,
      };
      const published = await adapter.reconcile(publish, publication);
      assert.equal(published.outcome, 'SUCCEEDED');
      const pubResult = {
        ...published,
        operation_id: publication.id,
        manifest_digest: request.manifest_digest,
        receipt_refs: ['actual-native-artifact'],
      };
      await assert.rejects(
        call(t.client, 'resolve_external', [
          ...t.args,
          publication.id,
          'SUCCEEDED',
          { ...pubResult, proof: { ...published.proof, publication_claim: randomUUID() } },
          'native-controller',
        ]),
        /ONE_USE_PUBLICATION_PROOF_REQUIRED/
      );
      await call(t.client, 'resolve_external', [
        ...t.args,
        publication.id,
        'SUCCEEDED',
        pubResult,
        'native-controller',
      ]);
      await advance('VERIFYING');
      const component_tuple = {
        'club-arena-engine': { ...retained, compatibility_receipt_id: selected.READINESS },
        'club-arena-web': {
          mode: 'changed',
          source_sha: sha,
          identity: artifact.identity,
          manifest_digest: native.manifestDigest,
          publication_operation_id: publication.id,
        },
      };
      const certificate = {
        certificate_version: 2,
        phase: 'CERTIFY',
        repository,
        target: 'club-arena-web',
        release_id: t.release.id,
        admission_sha: sha,
        manifest_digest: q.resolution_manifest_digest,
        component_tuple,
        control_sha: sha,
        workflow_id: 234,
        repository_id: '12345',
        operation_policy_digest: operationPolicyDigest,
        fixture_authority: {
          url: t.binding.url,
          audience: t.binding.audience,
          installation_receipt: t.ingress.id,
        },
      };
      // Exercise the actual coordinator with the journal's publication shape.
      // Calling only the SQL plan door misses mistakes in source orchestration.
      const coordinator = new SourceCoordinator({
        runner: {
          client: t.client,
          args: () => t.args,
          installArgs: () => ['b'.repeat(64), 'c'.repeat(64)],
          actor: 'native-controller',
          adapters: { 'github-certification': { controlSha: sha, workflowId: 234 } },
        },
        github: {
          repo: repository,
          repositoryId: '12345',
          certificationVersion: 2,
          fixtureAuthority: certificate.fixture_authority,
        },
      });
      const sourceState = await coordinator.snapshot();
      const certPlan = await coordinator.plan(
        sourceState.queue,
        sourceState.admission,
        sourceState.receipts
      );
      assert.deepEqual(certPlan.request.component_tuple, certificate.component_tuple);
      assert.equal(Object.keys(certPlan.request.fixture_roster).length, 9);
      assert.equal(
        (
          await providerCall(t.client, 'submit_component_certification_plan', [
            ...t.args,
            t.release.id,
            certificate,
            'b'.repeat(64),
            'c'.repeat(64),
            'native-controller',
          ])
        ).id,
        certPlan.id
      );
      const stale = structuredClone(certificate);
      stale.component_tuple['club-arena-web'].identity = `sha256:${'0'.repeat(64)}`;
      await assert.rejects(
        providerCall(t.client, 'submit_component_certification_plan', [
          ...t.args,
          t.release.id,
          stale,
          'b'.repeat(64),
          'c'.repeat(64),
          'native-controller',
        ]),
        /TUPLE_INVALID|PUBLICATION_REQUIRED/
      );
      const certOp = await providerCall(t.client, 'begin_source_plan', [
        ...t.args,
        certPlan.id,
        'b'.repeat(64),
        'c'.repeat(64),
        'native-controller',
      ]);
      await providerCall(t.client, 'authorize_provider_submit', [
        ...t.args,
        certOp.id,
        'b'.repeat(64),
        'c'.repeat(64),
        'native-controller',
      ]);
      const certIdentity = {
        repository_id: '12345',
        workflow_id: '234',
        control_sha: sha,
        run_id: '678',
        run_attempt: 1,
      };
      const cb = (action, proof = null) =>
        certificationCall(t.callback, 'certification_fixture_callback', [
          certOp.id,
          certIdentity,
          action,
          null,
          null,
          proof,
        ]);
      await cb('begin-cleanup');
      const clean = await cb('cleanup-complete', {
        operation_id: certOp.id,
        run_id: '678',
        run_attempt: 1,
        accounts: Object.fromEntries(
          Object.entries(certPlan.request.fixture_roster).map(([slot, a]) => [
            slot,
            { ...a, auth_absent: true, resources_absent: true, evidence_sha256: 'd'.repeat(64) },
          ])
        ),
      });
      const finalProof = {
        success: true,
        operation_id: certOp.id,
        run_id: '678',
        run_attempt: 1,
        control_sha: sha,
        request: certPlan.request,
        served_components: component_tuple,
        cleanup_complete: true,
        cleanup_receipt: clean.cleanup_receipt,
        unchanged_release: true,
        reports: certificateReports.map((name) => ({
          name,
          complete: true,
          executed: 1,
          failed: 0,
          retried: 0,
          sha256: 'd'.repeat(64),
        })),
      };
      const terminal = (proof) =>
        call(t.client, 'resolve_external', [
          ...t.args,
          certOp.id,
          'SUCCEEDED',
          {
            operation_id: certOp.id,
            terminal: true,
            outcome: 'SUCCEEDED',
            provider_operation_id: '678',
            manifest_digest: request.manifest_digest,
            proof,
            receipt_refs: ['native-certificate-protocol-fixture'],
          },
          'native-controller',
        ]);
      await assert.rejects(
        terminal({ ...finalProof, reports: finalProof.reports.slice(1) }),
        /FULL_COMPONENT_CERTIFICATE_REQUIRED/
      );
      await assert.rejects(
        terminal({
          ...finalProof,
          reports: finalProof.reports.map((r, i) => (i === 0 ? { ...r, retried: 1 } : r)),
        }),
        /FULL_COMPONENT_CERTIFICATE_REQUIRED/
      );
      await terminal(finalProof);
      await select('CERTIFICATION', {
        ...finalProof,
        build_receipt: selected.BUILD,
        certification_run_id: '678',
      });
      await advance('VERIFIED');
      assert.equal((await call(t.admin, 'inspect')).controller.active_release, null);
      await writeFile(path.join(native.release, 'index.html'), 'corrupted native bytes');
      await assert.rejects(adapter.reconcile(publish, publication), /manifest/);
    } finally {
      await native.close();
    }
  });
