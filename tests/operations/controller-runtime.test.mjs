import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { controllerRuntime } from '../../operations/release/controller-runtime.mjs';
import {
  staticControlFiles,
  staticControlReceipt,
} from '../../operations/release/static-control-closure.mjs';
import {
  observePublishedEngine,
  privateComponentDatabase,
} from '../../operations/release/component-native-readers.mjs';

const control = 'a'.repeat(40),
  source = 'b'.repeat(40),
  image = `sha256:${'c'.repeat(64)}`;
const id = '11111111-1111-4111-8111-111111111111';
const config = () => ({
  mode: 'EXECUTE',
  github: {
    repo: 'Smarter-Poker/Smarter-Poker-Club-Arena',
    repositoryId: 123,
    controlRef: 'heads/release-control',
    controlSha: control,
    workflowId: 100,
    credential_name: 'github',
    runtimeImage: `node:22@sha256:${'d'.repeat(64)}`,
    certificationVersion: 2,
    certificationWorkflowId: 200,
    frontendWorkflowId: 300,
    staticWorkflowId: 400,
    frontendRuntimeImage: `node:22@sha256:${'e'.repeat(64)}`,
    fixtureAuthority: {
      url: 'https://release.example.invalid/certification',
      audience: 'club-arena-release-certification',
      installation_receipt: id,
    },
    staticAuthority: {
      url: 'https://release.example.invalid/static-publication',
      audience: 'club-arena-static-publication',
      installation_receipt: id,
    },
  },
  engine: { controlSha: control, protocol: 2, host_alias: 'club-arena-engine-fixture' },
  engine_staging: true,
  admission: {
    credential_name: 'admission',
    database_credential_name: 'submitter',
    database_ca_path: '/fixture/ca.pem',
    database_principal: 'fixture_submitter',
    repositories: ['Smarter-Poker/Smarter-Poker-Club-Arena'],
  },
  readiness: {
    database_credential_name: 'catalogue',
    database_ca_path: '/fixture/ca.pem',
    database_principal: 'fixture_catalogue',
  },
  components: {
    database_credential_name: 'callback',
    database_ca_path: '/fixture/ca.pem',
    database_principal: 'fixture_callback',
    static_host_alias: 'club-arena-static-fixture',
    static_control_receipt_path: '/fixture/closure.json',
  },
});
async function dependencies() {
  const files = Object.fromEntries(
    await Promise.all(
      staticControlFiles.map(async (name) => [
        name,
        { bytes: await readFile(new URL(`../../${name}`, import.meta.url)), mode: '100644' },
      ])
    )
  );
  const closure = staticControlReceipt({ sourceSha: control, repositoryId: 123, files });
  const calls = [];
  return {
    calls,
    options: {
      credential: async (name) => {
        calls.push(`credential:${name}`);
        return Buffer.from(`fixture-${name}`);
      },
      installedFile: async (name) => {
        calls.push(`file:${name}`);
        return Buffer.from(name.endsWith('.json') ? JSON.stringify(closure) : 'fixture-ca');
      },
      githubFetch: async () => {
        throw new Error('Unexpected provider call during assembly');
      },
      openDatabase: async () => {
        throw new Error('Unexpected database call during assembly');
      },
    },
  };
}
test('OBSERVE assembly has no credential reads, callback, provider or admission capability', async () => {
  const c = config();
  c.mode = 'OBSERVE';
  const d = await dependencies();
  const r = await controllerRuntime(c, d.options);
  assert.deepEqual(d.calls, []);
  assert.deepEqual(r.adapters, {});
  assert.equal(r.certificateCallback, undefined);
  assert.equal(r.staticPublicationCallback, undefined);
  assert.equal(r.staticReadiness, undefined);
  assert.equal(r.mixedReadiness, undefined);
});
test('actual entrypoint graph supplies component adapters and both authenticated callbacks without submitting effects', async () => {
  const d = await dependencies();
  const r = await controllerRuntime(config(), d.options);
  assert.deepEqual(
    Object.keys(r.adapters).sort(),
    [
      'component-aggregate',
      'engine-stage',
      'github-certification',
      'github-frontend',
      'github-merge',
      'github-static',
      'github-workflow',
      'hetzner-intake',
    ].sort()
  );
  assert.equal(r.adapters['component-aggregate'].adapters, r.adapters);
  assert.equal(
    r.certificateCallback.componentReadback,
    r.adapters['github-certification'].componentReadback
  );
  assert.equal(r.certificateCallback.database, r.staticPublicationCallback.database);
  assert.equal(r.certificateCallback.identity.binding.control_ref, 'refs/heads/release-control');
  assert.equal(r.staticPublicationCallback.identity.binding.workflow_id, '400');
  assert.equal(r.staticPublicationCallback.identity.binding.control_ref, 'refs/heads/main');
  assert.equal(r.certificateCallback.identity.binding.principal, 'fixture_callback');
  assert.equal(typeof r.readiness.retainedFrontendEvidence, 'function');
  assert.equal(
    r.staticReadiness,
    undefined,
    'absent semantic execution must not install fake readiness'
  );
  await assert.rejects(r.certificateCallback.handle({ authorization: 'Bearer invalid', body: {} }));
});
test('semantic configuration wires the owned qualifier into both static and mixed readiness', async () => {
  const c = config();
  c.github.componentQualificationWorkflowId = 500;
  c.github.componentRuntimeImage = `qualifier@sha256:${'f'.repeat(64)}`;
  c.components.compatibility = {
    contract: { version: 1, cutover_order: ['club-arena-engine', 'club-arena-web'] },
  };
  const d = await dependencies();
  const r = await controllerRuntime(c, d.options);
  assert.equal(r.adapters['github-compatibility'].workflowId, 500);
  assert.equal(r.staticReadiness.compatibilityReadiness, r.mixedReadiness.compatibilityReadiness);
  assert.equal(
    r.staticReadiness.compatibilityReadiness.qualifier,
    r.adapters['github-compatibility']
  );
  assert.equal(r.mixedReadiness.engineReadiness, r.readiness);
  await assert.rejects(
    r.staticReadiness.compatibilityReadiness.qualification({
      queue: { resolution_manifest: { components: [] } },
    }),
    /RELEASE_COMPONENT_PREHISTORY_REQUIRED/
  );
});
for (const missing of [
  'components',
  'admission',
  'fixtureAuthority',
  'staticAuthority',
  'staticWorkflowId',
  'static_control_receipt_path',
]) {
  test(`component assembly fails closed for missing ${missing}`, async () => {
    const c = config();
    if (['components', 'admission'].includes(missing)) delete c[missing];
    else if (missing === 'static_control_receipt_path') delete c.components[missing];
    else delete c.github[missing];
    const d = await dependencies();
    await assert.rejects(controllerRuntime(c, d.options));
  });
}
test('ordinary engine configuration keeps its source contract and missing publication input refuses certification', async () => {
  const c = config();
  delete c.components;
  delete c.github.certificationVersion;
  delete c.github.staticWorkflowId;
  delete c.github.frontendWorkflowId;
  const d = await dependencies();
  const r = await controllerRuntime(c, d.options);
  assert.equal(r.adapters['component-aggregate'], undefined);
  assert.equal(r.certificateCallback, undefined);
  await assert.rejects(
    r.adapters['github-certification'].publicationReadback({ publication_operation_id: id }),
    /RELEASE_CERTIFICATION_PUBLICATION_REQUIRED/
  );
});
test('native engine certification readback observes original operation once and never resumes partial acceptance', async () => {
  const request = {
    target: 'club-arena-engine',
    source_sha: source,
    control_sha: control,
    manifest_digest: 'f'.repeat(64),
    run_key: '123-1',
    expected_current: { source_sha: control, image_id: image },
    artifact_image_id: image,
    server_tree_sha: source,
    not_after_epoch: Math.floor(Date.now() / 1000) + 3600,
    actor: 'fixture',
  };
  const operation = {
    id,
    epoch: id,
    status: 'SUCCEEDED',
    request,
    result: { outcome: 'SUCCEEDED', source_sha: source, image_id: image },
  };
  const calls = [];
  const intake = {
    request: async (action, envelope) => {
      calls.push({ action, envelope });
      return { terminal: false, acceptance_state: 'PARTIAL' };
    },
  };
  await assert.rejects(
    observePublishedEngine(intake, operation),
    /RELEASE_ORIGINAL_ENGINE_SEAL_REQUIRED/
  );
  assert.deepEqual(
    calls.map((x) => x.action),
    ['observe']
  );
  assert.equal(calls[0].envelope.operation_id, id);
  intake.request = async (action) => {
    calls.push({ action });
    return {
      terminal: true,
      outcome: 'SUCCEEDED',
      operation_id: id,
      run_key: '123-1',
      source_sha: source,
      control_sha: control,
      image_id: image,
      result: 'sealed',
    };
  };
  assert.deepEqual(await observePublishedEngine(intake, operation), {
    source_sha: source,
    image_id: image,
  });
  assert.deepEqual(
    calls.map((x) => x.action),
    ['observe', 'observe']
  );
});
test('private callback connection admits only verified TLS and its non-owner principal, releases failed connection slots', async () => {
  const role = {
    rolname: 'fixture_callback',
    rolcanlogin: true,
    callback: true,
    controller: false,
    rolsuper: false,
    rolbypassrls: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
  };
  let active = 0,
    max = 0,
    closed = 0,
    encrypted = true;
  const open = async () => {
    active++;
    max = Math.max(max, active);
    return {
      connection: { stream: { encrypted, authorized: true } },
      query: async () => ({ rows: [{ ...role }] }),
      end: async () => {
        active--;
        closed++;
      },
    };
  };
  const acquire = privateComponentDatabase({}, 'fixture_callback', open);
  const first = await acquire();
  let secondResolved = false;
  const pending = acquire().then((x) => {
    secondResolved = true;
    return x;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondResolved, false);
  await first.end();
  const second = await pending;
  await second.end();
  assert.equal(max, 1);
  role.controller = true;
  await assert.rejects(acquire(), /PRIVATE_COMPONENT_IDENTITY_REQUIRED/);
  role.controller = false;
  encrypted = false;
  await assert.rejects(acquire(), /PRIVATE_COMPONENT_TLS_REQUIRED/);
  encrypted = true;
  const last = await acquire();
  await last.end();
  assert.equal(active, 0);
  assert.equal(closed, 5);
});
