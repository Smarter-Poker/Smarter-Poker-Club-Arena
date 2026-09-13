import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { financialActorDescriptor } from '../fixture/runtime-files.mjs';
import { requireSchemaSourceContract } from './component-source-contract.mjs';
import { createObservationClient } from './component-observation-client.mjs';
import { prepareOracleHome } from './component-semantic-home.mjs';
import { waitForExactEngineReady } from './component-semantic-readiness.mjs';
import { runFinancialRoute } from './financial-route-runner.mjs';

export const financialCaseNames = Object.freeze([
  'exact-schema-catalogue',
  'ordinary-auth-topup-replay',
  'ordinary-auth-insurance-settlement',
]);

// The only health destination is the already running isolated engine. A native
// fetch deadline covers headers and body, and redirects cannot escape the net.
export async function financialEngineHealth() {
  const response = await fetch('http://engine:8080/health', {
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert.ok(size <= 128 * 1024, 'FINANCIAL_HEALTH_SIZE');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  return { status: () => response.status, json: async () => body };
}

// Reuses the existing disposable fixture driver, but emits a distinct financial
// observation artifact. This cannot replace the browser/product certificate.
export async function qualifyFinancialScenario({
  tuple,
  schema,
  runtimeImage,
  fixture,
  observations,
  request = { get: financialEngineHealth },
  runRoute = runFinancialRoute,
}) {
  requireSchemaSourceContract(fixture.source_contract);
  assert.equal(fixture.version, 1);
  assert.equal(fixture.scope, 'isolated-club-arena-fixture');
  const scenario = fixture.financial_scenario;
  assert.deepEqual(
    scenario,
    financialActorDescriptor(
      {
        club_id: scenario?.club_id,
        table_id: fixture.table_id,
        actor_user_ids: scenario?.users?.map((user) => user.id),
      },
      scenario?.users
    )
  );
  assert.equal(observations.binding.table_id, fixture.table_id);
  assert.equal(observations.binding.spectator_user_id, fixture.spectator_user_id);
  assert.ok(!scenario.users.some((user) => user.id === fixture.spectator_user_id));
  assert.equal((await observations.catalogue()).catalogue_digest, schema.catalogue_digest);
  const engineReadiness = await waitForExactEngineReady({
    request,
    healthUrl: 'http://engine:8080/health',
    sourceSha: tuple['club-arena-engine'].source_sha,
  });
  const financial = await runRoute({
    owner: {
      tableId: fixture.table_id,
      clubId: scenario.club_id,
      actorIds: scenario.users.map((user) => user.id),
      opId: randomUUID(),
      sourceSha: tuple['club-arena-engine'].source_sha,
    },
    users: scenario.users,
    observations,
    readEngineIdentity: async () => {
      const response = await request.get('http://engine:8080/health');
      assert.equal(response.status(), 200, 'FINANCIAL_ENGINE_HEALTH');
      const health = await response.json();
      return {
        source_sha: health.releaseSha,
        instance_id: health.instanceId,
        running: health.running,
      };
    },
  });
  assert.equal(financial.scope, 'independent-financial-route-observations');
  assert.equal(financial.product_certificate, false);
  assert.equal((await observations.catalogue()).catalogue_digest, schema.catalogue_digest);
  return {
    version: 1,
    scope: 'club-arena-financial-route',
    product_certificate: false,
    tuple,
    schema_fixture_sha256: schema.fixture_sha256,
    schema_catalogue_digest: schema.catalogue_digest,
    runtime_image: runtimeImage,
    success: true,
    executed: financialCaseNames.length,
    failed: 0,
    skipped: 0,
    retries: 0,
    cases: financialCaseNames.map((name) => ({ name, passed: true })),
    engine_readiness: engineReadiness,
    financial,
    cleanup: { complete: false, owner: 'outer-native-driver' },
  };
}

if (process.argv[1]?.endsWith('/financial-route-suite.mjs')) {
  let observations;
  try {
    assert.equal(process.env.HOME, '/tmp/qualification');
    assert.equal(process.env.TMPDIR, '/tmp');
    assert.equal(process.env.XDG_CACHE_HOME, '/tmp/qualification/cache');
    await prepareOracleHome();
    const plan = JSON.parse(await readFile('/inputs/plan.json', 'utf8'));
    const fixture = JSON.parse(
      await readFile('/run/club-arena-qualification/fixture.json', 'utf8')
    );
    requireSchemaSourceContract(fixture.source_contract);
    const control = JSON.parse(await readFile('/inputs/observation-control.json', 'utf8'));
    observations = createObservationClient(fixture.observation_bridge, control);
    const result = await qualifyFinancialScenario({
      tuple: plan.tuples[Number(process.argv[2])],
      schema: plan.schema,
      runtimeImage: process.argv[3],
      fixture,
      observations,
    });
    process.stdout.write(`FINANCIAL_ROUTE_RESULT:${JSON.stringify(result)}\n`);
  } catch {
    // Assertions may contain ordinary synthetic tokens. Do not print their
    // values or raw engine/database responses to shared workflow logs.
    process.stderr.write('RELEASE_FINANCIAL_ROUTE_EXECUTION_FAILED\n');
    process.exitCode = 1;
  } finally {
    observations?.close();
  }
}
