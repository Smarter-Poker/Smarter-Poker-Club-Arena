// Explicit route/health/database doubles exercise outer ownership only. They
// cannot qualify actual Auth sessions, funded routes, or a native engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  qualifyFinancialScenario,
  financialEngineHealth,
} from '../../operations/release/native/financial-route-suite.mjs';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('native health reader fixes the internal destination, refuses redirects and bounds its body read', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://engine:8080/health');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ running: true }), { status: 200 });
  });
  const response = await financialEngineHealth();
  assert.equal(response.status(), 200);
  assert.deepEqual(await response.json(), { running: true });
});
test('oversized native health responses are cancelled before an unbounded body is retained', async (t) => {
  let cancelled = false;
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(128 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        })
      )
  );
  await assert.rejects(financialEngineHealth(), /FINANCIAL_HEALTH_SIZE/);
  assert.equal(cancelled, true);
});
function fixture() {
  const source = 'a'.repeat(40),
    calls = [];
  const users = [id(3), id(4)].map((user) => ({
    id: user,
    session: {
      user: { id: user },
      access_token:
        'e30.' +
        Buffer.from(
          JSON.stringify({
            sub: user,
            role: 'authenticated',
            exp: Math.floor(Date.now() / 1000) + 3600,
          })
        ).toString('base64url') +
        '.signature',
    },
  }));
  const args = {
    tuple: { 'club-arena-engine': { source_sha: source } },
    schema: { fixture_sha256: 'b'.repeat(64), catalogue_digest: 'c'.repeat(64) },
    runtimeImage: 'isolated-test-image',
    fixture: {
      version: 1,
      scope: 'isolated-club-arena-fixture',
      table_id: id(1),
      spectator_user_id: id(5),
      source_contract: {
        version: 1,
        source_sha: source,
        current_database_contract_ready: true,
        exclusions: [],
      },
      financial_scenario: { version: 1, table_id: id(1), club_id: id(2), users },
    },
    observations: {
      binding: { table_id: id(1), spectator_user_id: id(5) },
      async catalogue() {
        calls.push('catalogue');
        return { catalogue_digest: args.schema.catalogue_digest };
      },
    },
    request: {
      async get(url) {
        assert.equal(url, 'http://engine:8080/health');
        calls.push('health');
        return {
          status: () => 200,
          json: async () => ({ releaseSha: source, instanceId: 'one', running: true }),
        };
      },
    },
    async runRoute(config) {
      calls.push('route');
      assert.deepEqual(config.users, users);
      assert.equal(config.owner.clubId, id(2));
      assert.equal(config.owner.tableId, id(1));
      assert.equal(config.owner.sourceSha, source);
      assert.deepEqual(config.owner.actorIds, [id(3), id(4)]);
      assert.deepEqual(await config.readEngineIdentity(), {
        source_sha: source,
        instance_id: 'one',
        running: true,
      });
      return { scope: 'independent-financial-route-observations', product_certificate: false };
    },
  };
  return { args, calls };
}
test('outer financial scenario binds ordinary actors and checks catalogue before and after without product authority', async () => {
  const { args, calls } = fixture();
  const result = await qualifyFinancialScenario(args);
  assert.deepEqual(calls, ['catalogue', 'health', 'route', 'health', 'catalogue']);
  assert.equal(result.scope, 'club-arena-financial-route');
  assert.equal(result.product_certificate, false);
  assert.deepEqual(result.cleanup, { complete: false, owner: 'outer-native-driver' });
});
test('partial source cannot reach a route, health read or database observation', async () => {
  const { args, calls } = fixture();
  args.fixture.source_contract.current_database_contract_ready = false;
  args.fixture.source_contract.exclusions = ['application-role-acl-baseline'];
  await assert.rejects(qualifyFinancialScenario(args));
  assert.deepEqual(calls, []);
});
test('foreign scope, spectator actor and privileged or additional credentials are rejected before actions', async () => {
  for (const change of [
    (args) => {
      args.fixture.financial_scenario.table_id = id(9);
    },
    (args) => {
      args.observations.binding.table_id = id(9);
    },
    (args) => {
      args.fixture.spectator_user_id = id(3);
      args.observations.binding.spectator_user_id = id(3);
    },
    (args) => {
      args.fixture.financial_scenario.users[0].session.refresh_token = 'private';
    },
    (args) => {
      args.fixture.financial_scenario.service_key = 'private';
    },
  ]) {
    const { args, calls } = fixture();
    change(args);
    await assert.rejects(qualifyFinancialScenario(args));
    assert.deepEqual(calls, []);
  }
});
test('wrong engine source stops before the actor route', async () => {
  const { args, calls } = fixture();
  args.tuple['club-arena-engine'].source_sha = 'd'.repeat(40);
  await assert.rejects(qualifyFinancialScenario(args), /ENGINE_SOURCE_MISMATCH/);
  assert.ok(!calls.includes('route'));
});
test('financial failure propagates and cannot emit a passing native result', async () => {
  const { args } = fixture();
  args.runRoute = async () => {
    throw new Error('actual-route-failed');
  };
  await assert.rejects(qualifyFinancialScenario(args), /actual-route-failed/);
});
test('post-action schema mutation prevents a financial result', async () => {
  const { args } = fixture();
  let reads = 0;
  args.observations.catalogue = async () => ({
    catalogue_digest: reads++ ? 'changed' : args.schema.catalogue_digest,
  });
  await assert.rejects(qualifyFinancialScenario(args));
});
