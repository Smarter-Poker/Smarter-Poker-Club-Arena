import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createObservationClient } from './component-observation-client.mjs';
import { requireSchemaSourceContract } from './component-source-contract.mjs';
import { waitForExactEngineReady } from './component-semantic-readiness.mjs';
import { prepareOracleHome } from './component-semantic-home.mjs';
import { runTournamentPlayerUI } from '../fixture/representative/tournament-player-ui-run.mjs';
import { requiredPlayerUIFlows } from '../fixture/representative/tournament-player-ui-evidence.mjs';

export async function qualifyTournamentPlayerUI({
  tuple,
  schema,
  runtimeImage,
  control,
  fixture,
  observations,
  browser,
}) {
  requireSchemaSourceContract(fixture.source_contract);
  assert.equal(fixture.scope, 'isolated-club-arena-fixture');
  assert.equal(fixture.base_url, 'https://smarter.poker/hub/club-arena/');
  assert.equal(fixture.engine_health_url, 'https://engine.smarter.poker/health');
  assert.equal(observations.binding.control_sha, control.control_sha);
  const catalogue = async () =>
    assert.equal((await observations.catalogue()).catalogue_digest, schema.catalogue_digest);
  await catalogue();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  let readiness, proof;
  const identities = async () => {
    for (const origin of [
      'https://ca-static.smarter.poker/',
      'https://smarter.poker/hub/club-arena/',
    ]) {
      const r = await context.request.get(`${origin}build-info.json`, { timeout: 10000 });
      assert.equal(r.status(), 200);
      assert.equal((await r.json()).ca_sha, tuple['club-arena-web'].source_sha);
    }
    const r = await context.request.get(fixture.engine_health_url, { timeout: 10000 });
    assert.equal(r.status(), 200);
    const h = await r.json();
    assert.equal(h.releaseSha, tuple['club-arena-engine'].source_sha);
    assert.equal(h.running, true);
  };
  try {
    readiness = await waitForExactEngineReady({
      request: context.request,
      healthUrl: fixture.engine_health_url,
      sourceSha: tuple['club-arena-engine'].source_sha,
    });
    await identities();
    proof = await runTournamentPlayerUI({
      browser,
      observations,
      ingress: {
        ...fixture.tournament_player_ui,
        source_contract: fixture.source_contract,
        control_sha: control.control_sha,
        schema_catalogue_digest: schema.catalogue_digest,
        runtime_image: runtimeImage,
        engine_sha: tuple['club-arena-engine'].source_sha,
        web_sha: tuple['club-arena-web'].source_sha,
      },
    });
    await identities();
    await catalogue();
  } finally {
    await context.close();
  }
  const cases = ['MTT', 'SPIN', 'SNG'].flatMap((format) =>
    requiredPlayerUIFlows(format).map((flow) => ({ name: `${format}:${flow}`, passed: true }))
  );
  return {
    version: 1,
    scope: 'isolated-tournament-player-ui-observations',
    product_certificate: false,
    tuple,
    runtime_image: runtimeImage,
    schema_fixture_sha256: schema.fixture_sha256,
    schema_catalogue_digest: schema.catalogue_digest,
    success: true,
    executed: cases.length,
    failed: 0,
    skipped: 0,
    retries: 0,
    cases,
    engine_readiness: readiness,
    proof,
    cleanup: { complete: false, owner: 'outer-native-driver' },
  };
}

if (process.argv[1]?.endsWith('/tournament-player-ui-suite.mjs')) {
  let observations, browser;
  try {
    assert.equal(process.env.HOME, '/tmp/qualification');
    assert.equal(process.env.TMPDIR, '/tmp');
    assert.equal(process.env.XDG_CACHE_HOME, '/tmp/qualification/cache');
    await prepareOracleHome();
    const plan = JSON.parse(await readFile('/inputs/plan.json', 'utf8'));
    const fixture = JSON.parse(
      await readFile('/run/club-arena-qualification/fixture.json', 'utf8')
    );
    const control = JSON.parse(await readFile('/inputs/observation-control.json', 'utf8'));
    observations = createObservationClient(fixture.observation_bridge, control);
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const result = await qualifyTournamentPlayerUI({
      tuple: plan.tuples[Number(process.argv[2])],
      schema: plan.schema,
      runtimeImage: process.argv[3],
      control,
      fixture,
      observations,
      browser,
    });
    process.stdout.write(`TOURNAMENT_PLAYER_UI_RESULT:${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('RELEASE_TOURNAMENT_PLAYER_UI_FAILED\n');
    process.exitCode = 1;
  } finally {
    await browser?.close();
    observations?.close();
  }
}
