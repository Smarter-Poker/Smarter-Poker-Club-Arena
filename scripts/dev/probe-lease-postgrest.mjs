#!/usr/bin/env node
/** Native loopback transport rehearsal. No supplied database URL or production credentials. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, createHmac } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), '../..');
const args = process.argv.slice(2);
assert.ok(
  [2, 3, 4].includes(args.length),
  'usage: probe-lease-postgrest.mjs ABSOLUTE_POSTGREST_BINARY ABSOLUTE_EVIDENCE_DIRECTORY [ISOLATED_POOL_ACQUISITION_SECONDS] [ISOLATED_POOL_SIZE]'
);
const [binary, evidence, poolSecondsText = '10', poolSizeText = '6'] = args;
const poolSeconds = Number(poolSecondsText);
const poolSize = Number(poolSizeText);
assert.ok(Number.isInteger(poolSeconds) && poolSeconds >= 1 && poolSeconds <= 10);
assert.ok(Number.isInteger(poolSize) && poolSize >= 6 && poolSize <= 24);
assert.ok(path.isAbsolute(binary) && path.isAbsolute(evidence));
// Never let inherited production credentials, URLs, PG settings or error-reporting
// configuration enter the process importing the actual service client.
if (process.env.LEASE_PROBE_ISOLATED !== '1') {
  const child = spawn(process.execPath, [self, ...args], {
    env: { PATH: process.env.PATH, LANG: 'C', LEASE_PROBE_ISOLATED: '1' },
    stdio: 'inherit',
  });
  child.once('exit', (code) => process.exit(code ?? 1));
} else {
  await run();
}

async function run() {
  assert.ok(
    !Object.keys(process.env).some((k) =>
      /^(SUPABASE|VITE_SUPABASE|PGHOST|PGPASSWORD|PGSERVICE|PGRST_|SENTRY_DSN)/.test(k)
    ),
    'inherited service configuration refused'
  );
  const require = createRequire(path.join(root, 'server/package.json'));
  const { Client } = require('pg');
  const esbuild = require('esbuild');
  const pgbin = '/opt/homebrew/opt/postgresql@17/bin';
  assert.match(
    execFileSync(path.join(pgbin, 'postgres'), ['--version'], { encoding: 'utf8' }),
    / 17\./
  );
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(version, 'PostgREST 14.5');
  fs.mkdirSync(evidence, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-postgrest-lease-'));
  const socket = path.join(temp, 'socket');
  fs.mkdirSync(socket);
  const localBuild = fs.mkdtempSync(path.join(root, 'server/work-postgrest-probe-'));
  const port = 55461;
  const httpPort = 35461;
  const origin = `http://127.0.0.1:${httpPort}`;
  const clients = [];
  let booted = false,
    rest,
    gateway,
    log;
  const receipt = {
    startedAt: new Date().toISOString(),
    node: process.version,
    postgrest: version,
    postgrestSha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    probeSha256: createHash('sha256').update(fs.readFileSync(self)).digest('hex'),
    sourceSha: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    statementTimeoutMs: 8000,
    poolSize,
    poolAcquisitionTimeoutSeconds: poolSeconds,
    clientTimeoutMs: 15000,
    cases: [],
    productionChanges: 0,
  };
  const pg = (name, args) =>
    execFileSync(path.join(pgbin, name), args, { encoding: 'utf8', stdio: 'pipe' });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  try {
    pg('initdb', [
      '-D',
      path.join(temp, 'data'),
      '-U',
      'lease_probe',
      '-A',
      'trust',
      '--no-locale',
      '-E',
      'UTF8',
    ]);
    pg('pg_ctl', [
      '-D',
      path.join(temp, 'data'),
      '-l',
      path.join(temp, 'postgres.log'),
      '-o',
      `-h '' -k '${socket}' -p ${port}`,
      '-w',
      'start',
    ]);
    booted = true;
    const control = new Client({
      host: socket,
      port,
      database: 'postgres',
      user: 'lease_probe',
      ssl: false,
    });
    clients.push(control);
    await control.connect();
    await control.query(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN; ALTER ROLE service_role SET statement_timeout='8s';
      CREATE ROLE authenticator LOGIN NOINHERIT; GRANT service_role TO authenticator;
      CREATE FUNCTION public.fn_engine_lease_stale_seconds() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 30';`);
    for (const scope of ['table', 'tournament']) {
      await control.query(`CREATE TABLE public.engine_${scope}_leases(${scope}_id uuid PRIMARY KEY,
        instance_id text NOT NULL,protocol_version integer NOT NULL,lease_generation uuid NOT NULL,heartbeat_at timestamptz NOT NULL);
        INSERT INTO public.engine_${scope}_leases VALUES ('${id(1)}','engine',2,'${id(11)}',clock_timestamp());`);
    }
    const migration = fs.readFileSync(
      path.join(
        root,
        'supabase/migrations/20260908221010_lease_heartbeats_skip_busy_generations.sql'
      ),
      'utf8'
    );
    await control.query(migration);
    receipt.heartbeatMigrationSha256 = createHash('sha256').update(migration).digest('hex');
    // The delay is a local fixture around the exact installed heartbeat function.
    // pg_stat_activity observes real execution, not an in-process promise count.
    await control.query(`CREATE FUNCTION public.probe_heartbeat(p_scope text,p_delay double precision,p_marker text)
      RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
      DECLARE result jsonb;
      BEGIN
        RAISE LOG 'D6_PROBE_ENTER|%|%',p_marker,extract(epoch FROM clock_timestamp())*1000;
        PERFORM set_config('application_name','d6-probe:'||p_marker,true);
        PERFORM pg_sleep(p_delay);
        IF p_scope='table' THEN
          SELECT to_jsonb(x) INTO result FROM heartbeat_table_leases_v4('engine','[{"table_id":"${id(1)}","lease_generation":"${id(11)}"}]',30) x;
        ELSIF p_scope='tournament' THEN
          SELECT to_jsonb(x) INTO result FROM heartbeat_tournament_leases_v4('engine','[{"tournament_id":"${id(1)}","lease_generation":"${id(11)}"}]',30) x;
        ELSE RAISE EXCEPTION 'invalid fixture scope'; END IF;
        RETURN jsonb_build_object('heartbeat',result,'statement_timeout',current_setting('statement_timeout'),'pid',pg_backend_pid());
      END $$;
      REVOKE ALL ON FUNCTION public.probe_heartbeat(text,double precision,text) FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO service_role;
      GRANT EXECUTE ON FUNCTION public.probe_heartbeat(text,double precision,text) TO service_role;`);
    const secret = 'isolated-postgrest-fixture-secret-with-no-external-authority';
    const config = `db-uri = "postgresql://authenticator@/postgres?host=${socket}&port=${port}"
db-schemas = "public"
db-pool = ${poolSize}
db-pool-acquisition-timeout = ${poolSeconds}
server-host = "127.0.0.1"
server-port = ${httpPort}
jwt-secret = "${secret}"
log-level = "warn"
`;
    fs.writeFileSync(path.join(temp, 'postgrest.conf'), config, { mode: 0o600 });
    log = fs.openSync(path.join(evidence, 'postgrest.log'), 'w');
    rest = spawn(binary, [path.join(temp, 'postgrest.conf')], {
      stdio: ['ignore', log, log],
      env: { PATH: process.env.PATH, LANG: 'C' },
    });
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ role: 'service_role', exp: Math.floor(Date.now() / 1000) + 600 })
    ).toString('base64url');
    const token = `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
    process.env.SUPABASE_URL = origin;
    process.env.SUPABASE_SERVICE_ROLE_KEY = token;
    process.env.SUPABASE_TIMEOUT_MS = '15000';
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(origin, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) break;
      } catch {}
      assert.ok(attempt < 100, 'local PostgREST did not become ready');
      await sleep(50);
    }
    const clientSource = path.join(root, 'server/src/services/supabase/client.ts');
    receipt.clientSourceSha256 = createHash('sha256')
      .update(fs.readFileSync(clientSource))
      .digest('hex');
    const output = path.join(localBuild, 'client.mjs');
    await esbuild.build({
      entryPoints: [clientSource],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent',
    });
    const { supabase } = await import(pathToFileURL(output));
    // Native PostgREST has no Supabase gateway's /rest/v1 prefix. Only the SDK's
    // REST base URL is adapted; its actual bounded fetch and RPC parser run.
    supabase.rest.url = origin;
    const active = async () =>
      (
        await control.query(
          "SELECT application_name,pid FROM pg_stat_activity WHERE application_name LIKE 'd6-probe:%' AND state='active'"
        )
      ).rows;
    const rpc = async (scope, delay, marker) => {
      const start = performance.now();
      const value = await supabase.rpc('probe_heartbeat', {
        p_scope: scope,
        p_delay: delay,
        p_marker: marker,
      });
      return {
        marker,
        settledAtEpochMs: Date.now(),
        elapsedMs: Math.round(performance.now() - start),
        status: value.status,
        code: value.error?.code ?? null,
        message: value.error?.message ?? null,
        data: value.data,
        ownExecutingAtSettlement: (await active()).filter(
          (row) => row.application_name === `d6-probe:${marker}`
        ),
      };
    };
    const fresh = async () => {
      for (const scope of ['table', 'tournament'])
        await control.query(`UPDATE engine_${scope}_leases SET heartbeat_at=clock_timestamp()`);
    };
    await fresh();
    const role = await rpc('table', 0, 'role');
    assert.equal(role.data?.statement_timeout, '8s');
    receipt.cases.push({ name: 'real_role_setting', result: role });
    await fresh();
    const six = Array.from({ length: 6 }, (_, i) =>
      rpc(i < 3 ? 'table' : 'tournament', 6, `six-${i}`)
    );
    await sleep(300);
    const physicalSix = await active();
    const results = await Promise.all(six);
    assert.equal(physicalSix.length, 6);
    assert.ok(results.every((r) => r.data && r.elapsedMs >= 5900 && r.elapsedMs < 10000));
    receipt.cases.push({
      name: 'six_real_six_second_requests',
      physical: physicalSix.length,
      results,
    });
    for (const stalled of ['table', 'tournament']) {
      await fresh();
      const held = Array.from({ length: 3 }, (_, i) => rpc(stalled, 30, `held-${stalled}-${i}`));
      await sleep(250);
      assert.equal((await active()).length, 3);
      const peer = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          rpc(stalled === 'table' ? 'tournament' : 'table', 0, `peer-${i}`)
        )
      );
      assert.ok(peer.every((r) => r.data && r.elapsedMs < 1500));
      assert.equal((await active()).length, 3);
      const capped = await Promise.all(held);
      assert.ok(
        capped.every((r) => r.code === '57014' && r.elapsedMs >= 7800 && r.elapsedMs < 11000)
      );
      assert.equal((await active()).length, 0);
      receipt.cases.push({ name: `${stalled}_cannot_starve_peer`, peer, capped });
    }
    // Six unrelated API calls consume the shared DB pool, then the six admitted
    // renewals queue. Queue time plus a valid <8s statement exceeds the 15s
    // HTTP budget. Observe whether PostgREST really cancels each underlying call.
    await fresh();
    const blockers = Array.from({ length: poolSize }, (_, i) => rpc('table', 7.7, `external-${i}`));
    await sleep(150);
    assert.equal((await active()).length, poolSize);
    const queued = Array.from({ length: 6 }, (_, i) =>
      rpc(i < 3 ? 'table' : 'tournament', 7.7, `queued-${i}`)
    );
    await Promise.all(blockers);
    const queuedResults = await Promise.all(queued);
    const remaining = await active();
    const drainStart = performance.now();
    while ((await active()).length && performance.now() - drainStart < 10000) await sleep(25);
    const drainedAfterMs = Math.round(performance.now() - drainStart);
    // An empty activity sample does not prove a timed-out HTTP request cannot
    // begin later. Observe an additional full configured pool + SQL horizon,
    // and inspect server-side entry logs, which survive transaction rollback.
    const latePhysical = [];
    const observationStart = performance.now();
    while (performance.now() - observationStart < (poolSeconds + 8) * 1000) {
      const rows = (await active()).filter((row) =>
        row.application_name.startsWith('d6-probe:queued-')
      );
      if (rows.length)
        latePhysical.push({ elapsedMs: Math.round(performance.now() - observationStart), rows });
      await sleep(100);
    }
    const serverLog = fs.readFileSync(path.join(temp, 'postgres.log'), 'utf8');
    fs.writeFileSync(path.join(evidence, 'postgres.log'), serverLog);
    const entries = [...serverLog.matchAll(/D6_PROBE_ENTER\|([^|\s]+)\|([\d.]+)/g)].map(
      (match) => ({ marker: match[1], enteredAtEpochMs: Number(match[2]) })
    );
    const enteredAfterSettlement = entries.filter((entry) => {
      const settled = queuedResults.find((r) => r.marker === entry.marker);
      return settled && entry.enteredAtEpochMs > settled.settledAtEpochMs;
    });
    receipt.cases.push({
      name: 'queue_plus_statement_cancellation_horizon',
      queuedResults,
      executingAfterClientSettlement: remaining,
      drainedAfterMs,
      additionalObservationMs: Math.round(performance.now() - observationStart),
      latePhysical,
      enteredAfterSettlement,
      queuedEntries: entries.filter((entry) => entry.marker.startsWith('queued-')),
    });
    let hidden =
      remaining.length ||
      queuedResults.some((r) => r.ownExecutingAtSettlement.length) ||
      latePhysical.length ||
      enteredAfterSettlement.length;
    if (poolSize >= 12) {
      // Execute the actual admission method and its actual constants, selected
      // structurally from GameServer. Only the work callback is replaced by the
      // native fixture RPC; the full engine proof/loss behavior has its own tests.
      const ts = require('typescript');
      const gamePath = path.join(root, 'server/src/GameServer.ts');
      const gameSource = fs.readFileSync(gamePath, 'utf8');
      const ast = ts.createSourceFile(gamePath, gameSource, ts.ScriptTarget.Latest, true);
      const game = ast.statements.find(
        (node) => ts.isClassDeclaration(node) && node.name?.text === 'GameServer'
      );
      const method = game?.members.find(
        (node) =>
          ts.isMethodDeclaration(node) && node.name.getText(ast) === 'admitOwnershipLeaseRenewal'
      );
      assert.ok(method, 'actual GameServer admission method missing');
      const constants = ast.statements.filter(
        (node) =>
          ts.isVariableStatement(node) &&
          node.declarationList.declarations.some((decl) =>
            [
              'OWNERSHIP_LEASE_RENEWAL_CADENCE_MS',
              'OWNERSHIP_LEASE_MAX_IN_FLIGHT_PER_SCOPE',
            ].includes(decl.name.getText(ast))
          )
      );
      assert.equal(constants.length, 2);
      const admissionSource = [
        `import { tableLeaseMonotonicNow, TABLE_LEASE_PROOF_WINDOW_MS } from ${JSON.stringify(path.join(root, 'server/src/services/tableLease.ts'))};`,
        `import { TOURNAMENT_LEASE_PROOF_WINDOW_MS } from ${JSON.stringify(path.join(root, 'server/src/services/tournamentLease.ts'))};`,
        'const reportError = (error) => { throw error; };',
        ...constants.map((node) => node.getText(ast)),
        'export class AdmissionHarness { ownershipLeaseRenewalScopes = new Map(); constructor(work) { this.performOwnedEngineLeaseProofRenewal = work; }',
        method.getText(ast),
        '}',
      ].join('\n');
      const admissionFile = path.join(localBuild, 'admission.ts');
      const admissionOutput = path.join(localBuild, 'admission.mjs');
      fs.writeFileSync(admissionFile, admissionSource);
      await esbuild.build({
        entryPoints: [admissionFile],
        outfile: admissionOutput,
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        logLevel: 'silent',
      });
      const { AdmissionHarness } = await import(pathToFileURL(admissionOutput));
      const admittedResults = [],
        admissions = [],
        activity = [];
      let sequence = 0,
        observing = true,
        maximum = 0;
      const admission = new AdmissionHarness(async (scope) => {
        const result = await rpc(
          scope === 'cash' ? 'table' : 'tournament',
          7.9,
          `admitted-${sequence++}`
        );
        admittedResults.push(result);
      });
      await fresh();
      const occupied = Array.from({ length: poolSize }, (_, i) =>
        rpc('table', 7.9, `occupier-${i}`)
      );
      await sleep(150);
      assert.equal((await active()).length, poolSize);
      const started = performance.now();
      const observation = (async () => {
        let previous = -1;
        while (observing) {
          const count = (await active()).filter((row) =>
            row.application_name.startsWith('d6-probe:admitted-')
          ).length;
          maximum = Math.max(maximum, count);
          if (count !== previous)
            activity.push({ elapsedMs: Math.round(performance.now() - started), executing: count });
          previous = count;
          await sleep(25);
        }
      })();
      try {
        for (const tick of [0, 5005, 10010, 15100]) {
          while (performance.now() - started < tick)
            await sleep(Math.min(25, tick - (performance.now() - started)));
          for (const scope of ['cash', 'tournament'])
            admissions.push(admission.admitOwnershipLeaseRenewal(scope));
        }
        await Promise.all([...occupied, ...admissions]);
      } finally {
        observing = false;
        await observation;
      }
      receipt.cases.push({
        name: 'actual_admission_replacement_with_large_pool',
        gameServerSha256: createHash('sha256').update(gameSource).digest('hex'),
        admissionMethodSha256: createHash('sha256').update(method.getText(ast)).digest('hex'),
        maximumPhysicalRenewals: maximum,
        requestsIssued: admittedResults.length,
        activity,
        results: admittedResults,
      });
      fs.writeFileSync(
        path.join(evidence, 'postgres.log'),
        fs.readFileSync(path.join(temp, 'postgres.log'))
      );
      hidden ||= maximum > 6;

      // A gateway may return an error while retaining an already accepted
      // upstream operation. Releasing all buffered requests at one controlled
      // boundary reproduces that uncertainty without relying on a real outage.
      // Nothing outside loopback is contacted; the downstream's termination
      // intentionally does not cancel the gateway's independent upstream work.
      const gatewayEvents = [],
        gatewayWork = [],
        gatewayResults = [];
      const gatewayActivity = [];
      const gatewayOrigin = 'http://127.0.0.1:35462';
      const forwardAt = performance.now() + 20_000;
      let gatewaySequence = 0,
        gatewayMaximum = 0,
        gatewayObserving = true;
      gateway = createServer(async (request, response) => {
        try {
          assert.equal(request.method, 'POST');
          assert.equal(request.url, '/rpc/probe_heartbeat');
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          assert.ok(body.length < 4096);
          const payload = JSON.parse(body.toString('utf8'));
          const event = {
            marker: payload.p_marker,
            acceptedAtEpochMs: Date.now(),
            downstreamOutcome: gatewayEvents.length % 2 === 0 ? 'early_504' : 'early_disconnect',
          };
          gatewayEvents.push(event);
          gatewayWork.push(
            (async () => {
              await sleep(Math.max(0, forwardAt - performance.now()));
              event.forwardedAtEpochMs = Date.now();
              const upstream = await fetch(origin + request.url, {
                method: 'POST',
                body,
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              });
              event.upstreamStatus = upstream.status;
              event.upstreamBody = await upstream.json();
              event.upstreamCompletedAtEpochMs = Date.now();
            })()
          );
          event.downstreamEndedAtEpochMs = Date.now();
          if (event.downstreamOutcome === 'early_disconnect') response.destroy();
          else {
            response.writeHead(504, { 'Content-Type': 'application/json' });
            response.end(
              JSON.stringify({
                code: 'FIXTURE_GATEWAY_UNKNOWN',
                message: 'Accepted upstream outcome unknown',
              })
            );
          }
        } catch (error) {
          response.destroy(error);
        }
      });
      await new Promise((resolve, reject) => {
        gateway.once('error', reject);
        gateway.listen(35462, '127.0.0.1', resolve);
      });
      supabase.rest.url = gatewayOrigin;
      const gatewayAdmission = new AdmissionHarness(async (scope) => {
        gatewayResults.push(
          await rpc(
            scope === 'cash' ? 'table' : 'tournament',
            7.9,
            `gateway-admitted-${gatewaySequence++}`
          )
        );
      });
      await fresh();
      const gatewayStarted = performance.now();
      const gatewayObservation = (async () => {
        let previous = -1;
        while (gatewayObserving) {
          const count = (await active()).filter((row) =>
            row.application_name.startsWith('d6-probe:gateway-admitted-')
          ).length;
          gatewayMaximum = Math.max(gatewayMaximum, count);
          if (count !== previous)
            gatewayActivity.push({
              elapsedMs: Math.round(performance.now() - gatewayStarted),
              executing: count,
            });
          previous = count;
          await sleep(25);
        }
      })();
      try {
        for (const tick of [0, 5005, 10010, 15100]) {
          while (performance.now() - gatewayStarted < tick)
            await sleep(Math.min(25, tick - (performance.now() - gatewayStarted)));
          await Promise.all(
            ['cash', 'tournament'].map((scope) =>
              gatewayAdmission.admitOwnershipLeaseRenewal(scope)
            )
          );
        }
        assert.equal(gatewayEvents.length, 8);
        assert.equal(gatewayResults.length, 8);
        assert.ok(gatewayResults.every((result) => result.data === null));
        await Promise.all(gatewayWork);
        await sleep(50);
      } finally {
        gatewayObserving = false;
        await gatewayObservation;
        supabase.rest.url = origin;
      }
      const afterClientSettlement = gatewayEvents.filter(
        (event) =>
          event.forwardedAtEpochMs >
          gatewayResults.find((result) => result.marker === event.marker).settledAtEpochMs
      );
      assert.equal(afterClientSettlement.length, 8);
      assert.ok(gatewayEvents.every((event) => event.upstreamStatus === 200));
      receipt.cases.push({
        name: 'actual_admission_gateway_early_close_delayed_forward',
        maximumPhysicalRenewals: gatewayMaximum,
        requestsIssued: gatewayResults.length,
        acceptedBeforeClientSettlementButForwardedAfter: afterClientSettlement.length,
        activity: gatewayActivity,
        events: gatewayEvents,
        results: gatewayResults,
        limitation:
          'Controlled loopback gateway fault, not a measurement of installed gateway configuration.',
      });
      hidden ||= gatewayMaximum > 6;
      fs.writeFileSync(
        path.join(evidence, 'postgres.log'),
        fs.readFileSync(path.join(temp, 'postgres.log'))
      );
    }
    receipt.result = hidden ? 'GAP_REPRODUCED' : 'PASS';
    if (hidden) process.exitCode = 2;
    receipt.limitation = `Isolated PostgREST 14.5 pool=${poolSize}/acquisition=${poolSeconds}s with an additional full pool+SQL observation horizon. Installed acquisition was separately read as10s on2026-09-11; this fixture makes no production configuration change and does not certify gateway behavior. For pools>=12 it executes the structurally extracted actual GameServer admission method with real five-second ticks and a native RPC callback; full proof/loss behavior remains covered separately.`;
  } catch (error) {
    receipt.result = 'FAILED';
    receipt.error = { name: error.name, message: error.message };
    process.exitCode = 1;
  } finally {
    if (gateway) await new Promise((resolve) => gateway.close(resolve));
    if (rest && rest.exitCode === null) {
      rest.kill('SIGTERM');
      await Promise.race([
        new Promise((r) => rest.once('exit', r)),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
      if (rest.exitCode === null) rest.kill('SIGKILL');
    }
    await Promise.allSettled(clients.map((c) => c.end()));
    if (booted) pg('pg_ctl', ['-D', path.join(temp, 'data'), '-m', 'immediate', '-w', 'stop']);
    if (log !== undefined) fs.closeSync(log);
    receipt.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(receipt, null, 2) + '\n');
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(localBuild, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ result: receipt.result, cases: receipt.cases.length, evidence }));
}
