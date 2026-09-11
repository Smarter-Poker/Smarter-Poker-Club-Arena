// Runs in the installed, isolated fixture image. This is the trusted product
// oracle; candidate JavaScript, HTML, SQL and image health metadata never write
// a passing report. No package install or candidate test file is executed here.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import pg from 'pg';
import { EngineSocketJournal } from '../../../tests/e2e/support/liveTableRealtime.ts';

import { verifyPersistedHand, schemaCatalogue } from './component-semantic-observations.mjs';
import { waitForExactEngineReady } from './component-semantic-readiness.mjs';
import { prepareOracleHome } from './component-semantic-home.mjs';
export const semanticCaseNames = Object.freeze([
  'exact-schema-catalogue',
  'authenticated-web-bundle',
  'engine-browser-causal-hand',
  'completed-hand-persisted',
  'spectator-does-not-acquire-seat',
]);

export async function qualifyProduct({ tuple, schema, runtimeImage, fixture, db, browser }) {
  assert.equal(fixture.version, 1);
  assert.equal(fixture.scope, 'isolated-club-arena-fixture');
  assert.match(fixture.table_id, /^[0-9a-f-]{36}$/);
  assert.match(fixture.spectator_user_id, /^[0-9a-f-]{36}$/);
  // Hostnames deliberately match compiled production URLs. The native driver
  // creates an INTERNAL Docker network with these aliases and no published
  // host port; nothing here may fall back to the real site or database.
  assert.equal(fixture.base_url, 'https://smarter.poker/hub/club-arena/');
  assert.equal(fixture.engine_health_url, 'https://engine.smarter.poker/health');
  assert.equal(await schemaCatalogue(db), schema.catalogue_digest);
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: fixture.storage_state,
  });
  let causal, persisted, engineReadiness;
  try {
    engineReadiness = await waitForExactEngineReady({
      request: context.request,
      healthUrl: fixture.engine_health_url,
      sourceSha: tuple['club-arena-engine'].source_sha,
    });
    const page = await context.newPage();
    const bad = [];
    page.on('pageerror', (error) => bad.push(error.name));
    const journal = new EngineSocketJournal(page);
    const started = Date.now(),
      tableId = fixture.table_id;
    // Arm before navigation: a cached document or old protocol cannot hide
    // missed startup events by starting the measurement afterwards.
    const subscription = Promise.all([
      journal.waitForFrame(
        { direction: 'sent', tableId, type: 'SUBSCRIBE', since: started },
        15000,
        'web did not subscribe'
      ),
      journal.waitForFrame(
        { direction: 'received', tableId, type: 'SUBSCRIBED', since: started },
        15000,
        'engine did not acknowledge web'
      ),
      journal.waitForFrame(
        { direction: 'received', tableId, type: 'SNAPSHOT', since: started },
        15000,
        'engine snapshot missing'
      ),
    ]);
    const navigation = page.goto(`${fixture.base_url}table/${tableId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await Promise.all([subscription, navigation]);
    assert.equal(
      new URL(page.url()).pathname,
      `/hub/club-arena/table/${tableId}`,
      'fixture authentication must reach the actual table'
    );
    await expect(page.getByTestId('table-connection-banner')).not.toBeVisible();
    const served = await context.request.get(`${fixture.base_url}build-info.json`);
    assert.equal(served.status(), 200);
    assert.equal((await served.json()).ca_sha, tuple['club-arena-web'].source_sha);
    causal = await journal.waitForCausalHandCycle(
      tableId,
      started,
      120000,
      45000,
      'actual browser/engine combination did not complete and advance a hand'
    );
    // The DB writer is asynchronous. Poll only this exact known hand, with a
    // bounded deadline; no retry of gameplay and no replacement hand identity.
    const deadline = Date.now() + 15000;
    for (;;) {
      const observed = await db.query(
        'SELECT count(*)::integer AS count FROM public.hand_history WHERE table_id=$1 AND hand_number=$2',
        [tableId, causal.handNumber]
      );
      if (observed.rows[0].count > 0) break;
      assert.ok(Date.now() < deadline, 'browser-observed hand did not persist before the deadline');
      await new Promise((r) => setTimeout(r, 100));
    }
    persisted = await verifyPersistedHand(db, tableId, causal, fixture.spectator_user_id);
    assert.deepEqual(bad, [], 'candidate browser threw an error');
    assert.equal(
      await schemaCatalogue(db),
      schema.catalogue_digest,
      'application execution changed the schema'
    );
  } finally {
    await context.close();
  }
  return {
    version: 1,
    scope: 'club-arena-product',
    product_suite: 'live-table-schema-v1',
    tuple,
    schema_fixture_sha256: schema.fixture_sha256,
    schema_catalogue_digest: schema.catalogue_digest,
    runtime_image: runtimeImage,
    success: true,
    executed: semanticCaseNames.length,
    failed: 0,
    skipped: 0,
    retries: 0,
    cases: semanticCaseNames.map((name) => ({ name, passed: true })),
    engine_readiness: engineReadiness,
    causal_hand: persisted,
  };
}

if (process.argv[1]?.endsWith('/component-semantic-suite.mjs')) {
  assert.equal(process.env.HOME, '/tmp/qualification');
  assert.equal(process.env.TMPDIR, '/tmp');
  assert.equal(process.env.XDG_CACHE_HOME, '/tmp/qualification/cache');
  await prepareOracleHome();
  const plan = JSON.parse(await readFile('/inputs/plan.json', 'utf8'));
  const fixture = JSON.parse(await readFile('/run/club-arena-qualification/fixture.json', 'utf8'));
  // Only a local socket to the disposable database. Never DATABASE_URL or an
  // inherited service credential from Actions/controller/gameplay.
  const db = new pg.Client({
    host: '/run/postgresql',
    database: 'club_arena_qualification',
    user: 'qualification_reader',
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  let browser;
  try {
    await db.connect();
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const result = await qualifyProduct({
      tuple: plan.tuples[Number(process.argv[2])],
      schema: plan.schema,
      runtimeImage: process.argv[3],
      fixture,
      db,
      browser,
    });
    process.stdout.write(`RELEASE_SEMANTIC_RESULT:${JSON.stringify(result)}\n`);
  } finally {
    await browser?.close();
    await db.end();
  }
}
