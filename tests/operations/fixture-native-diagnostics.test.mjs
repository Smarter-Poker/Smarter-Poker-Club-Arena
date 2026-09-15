import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import * as runtimeFiles from '../../operations/release/fixture/runtime-files.mjs';
import {
  nativeFailureDiagnostic,
  nativeChildFailure,
  realtimeLogDiagnostic,
  realtimeLogMarkers,
  realtimeDatabaseErrorNames,
} from '../../operations/release/fixture/runtime-files.mjs';

// Execute the maintained probe and final catch's diagnostic call without
// starting PostgreSQL, browsers, or the application fixture.
function postgrestProbe(fetchImpl = fetch) {
  const source = readFileSync(new URL('../../operations/release/fixture/native-smoke.mjs', import.meta.url), 'utf8');
  const probe = source.slice(source.indexOf('async function healthy('), source.indexOf('async function start('));
  const terminal = source.match(/const diagnostic = nativeFailureDiagnostic\([\s\S]*?\n  \);/)[0];
  return Function('fetch', 'AbortSignal', 'databaseOwner', 'postgrestReadinessDiagnostic', 'nativeFailureDiagnostic', `
    let stage = 'postgrest-server-ready';
    let postgrestReadiness = null;
    ${probe}
    return { healthy, failure(error) { ${terminal} return diagnostic; } };
  `)(fetchImpl, AbortSignal, { signal: new AbortController().signal }, runtimeFiles.postgrestReadinessDiagnostic, nativeFailureDiagnostic);
}

async function postgrestServer(handler, action) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await action(`http://127.0.0.1:${server.address().port}/`); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test('PostgREST actual readiness probe retains only status and validated code in terminal failure', async () => {
  await postgrestServer((request, response) => {
    response.writeHead(503, { 'content-type': 'application/json', 'x-private': 'PRIVATE HEADER' });
    response.end(JSON.stringify({ code: 'PGRST002', message: 'PRIVATE SQL PASSWORD', details: 'PRIVATE TOKEN' }));
  }, async (url) => {
    const probe = postgrestProbe();
    assert.equal(await probe.healthy(url, { authorization: 'PRIVATE TOKEN' }), false);
    const actual = probe.failure(new Error('PRIVATE URL AND PASSWORD'));
    assert.deepEqual(actual, { status: 'failed', stage: 'postgrest-server-ready', error: 'Error',
      postgrest_http_status: 503, postgrest_code: 'PGRST002' });
    assert.ok(!JSON.stringify(actual).includes('PRIVATE'));
  });
});

test('PostgREST probe bounds non-2xx bodies, validates SQLSTATE and preserves the success predicate', async () => {
  const responses = [
    [new Response(JSON.stringify({ code: '42501', message: 'PRIVATE SQL' }), { status: 403 }), { postgrest_http_status: 403, postgrest_code: '42501' }],
    [new Response(JSON.stringify({ code: 'PGRST002\n' }), { status: 503 }), { postgrest_http_status: 503 }],
    [new Response(JSON.stringify({ code: 'PRIVATE SECRET' }), { status: 500 }), { postgrest_http_status: 500 }],
    [new Response(JSON.stringify({ code: 'PGRST002', message: 'x'.repeat(4096) }), { status: 503 }), { postgrest_http_status: 503 }],
    [new Response('PRIVATE NOT JSON', { status: 500 }), { postgrest_http_status: 500 }],
  ];
  const probe = postgrestProbe(async () => responses[0][0]);
  while (responses.length) {
    const expected = responses[0][1];
    assert.equal(await probe.healthy('http://127.0.0.1/'), false);
    assert.deepEqual(probe.failure(new Error()), { status: 'failed', stage: 'postgrest-server-ready', error: 'Error', ...expected });
    responses.shift();
  }
  const success = postgrestProbe(async () => ({ ok: true, status: 204, get body() { throw new Error('must not read successful body'); } }));
  assert.equal(await success.healthy('http://127.0.0.1/'), true);
});

test('PostgREST real fetch refusal and original one-second timeout emit only fixed categories', async () => {
  let closedUrl;
  await postgrestServer((_request, response) => response.end(), async (url) => { closedUrl = url; });
  const probe = postgrestProbe();
  assert.equal(await probe.healthy(closedUrl), false);
  assert.equal(probe.failure(new Error()).postgrest_fetch_failure, 'connection-refused');
  await postgrestServer((_request, _response) => {}, async (url) => {
    const started = Date.now();
    assert.equal(await probe.healthy(url), false);
    assert.equal(probe.failure(new Error()).postgrest_fetch_failure, 'timeout');
    assert.ok(Date.now() - started >= 900 && Date.now() - started < 3000);
  });
  await postgrestServer((_request, response) => {
    response.writeHead(503); response.write('{"code":"PGRST002","message":"PRIVATE');
  }, async (url) => {
    assert.equal(await probe.healthy(url), false);
    assert.deepEqual(probe.failure(new Error()), { status: 'failed', stage: 'postgrest-server-ready', error: 'Error',
      postgrest_http_status: 503, postgrest_fetch_failure: 'timeout' });
  });
});

test('PostgREST terminal diagnostic rejects forged fields and cannot attach them to another stage', () => {
  for (const value of [true, null, [], 'PRIVATE', 99, 600, 500.5]) {
    assert.equal(nativeFailureDiagnostic('postgrest-server-ready', new Error(), { postgrest_http_status: value }).postgrest_http_status, undefined);
  }
  for (const value of ['PGRST002\n', '42501\n', 'PRIVATE', [], true, null]) {
    assert.equal(nativeFailureDiagnostic('postgrest-server-ready', new Error(), { postgrest_http_status: 503, postgrest_code: value }).postgrest_code, undefined);
    assert.equal(nativeFailureDiagnostic('postgrest-server-ready', new Error(), { postgrest_fetch_failure: value }).postgrest_fetch_failure, undefined);
  }
  assert.deepEqual(nativeFailureDiagnostic('gotrue-server-ready', new Error(), { postgrest_http_status: 503, postgrest_code: 'PGRST002' }),
    { status: 'failed', stage: 'gotrue-server-ready', error: 'Error' });
});

test('actual preimage entrypoint retains argument and package refusals without private errors', async () => {
  const script = fileURLToPath(
    new URL('../../operations/release/fixture/fixture-server.mjs', import.meta.url)
  );
  for (const [args, stage] of [
    [[script, 'preimage', 'PRIVATE ARGUMENT'], 'fixture-preimage-arguments'],
    // Deterministic package refusal before any filesystem or service mutation.
    [
      ['--import', 'data:text/javascript,process.getuid=()=>-1', script, 'preimage'],
      'fixture-preimage-package',
    ],
  ]) {
    await assert.rejects(
      promisify(execFile)(process.execPath, args, { timeout: 5000 }),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        const lines = error.stderr.trim().split('\n');
        assert.equal(lines.length, 2);
        assert.deepEqual(JSON.parse(lines[0]), {
          status: 'failed',
          stage,
          error: 'AssertionError',
        });
        assert.equal(lines[1], 'FIXTURE_COMMAND_REFUSED');
        assert.ok(!error.stderr.includes('PRIVATE'));
        return true;
      }
    );
  }
});

test('Realtime database errors expose fixed categories without SQL, role names or credentials', () => {
  const actual = realtimeLogDiagnostic(
    'Postgrex.Error: insufficient_privilege PRIVATE_ROLE PRIVATE_JWT\n' +
      'postgres: {code: :undefined_column, query: PRIVATE_SQL}\npassword=PRIVATE_SECRET'
  );
  assert.deepEqual(actual.realtime_database_errors, ['insufficient_privilege', 'undefined_column']);
  assert.ok(!JSON.stringify(actual).includes('PRIVATE'));
  assert.equal(
    realtimeLogDiagnostic('Postgrex.Error PRIVATE_SQL').realtime_database_errors,
    undefined
  );
  assert.deepEqual(
    realtimeLogDiagnostic(realtimeDatabaseErrorNames.join(' ')).realtime_database_errors,
    realtimeDatabaseErrorNames
  );
});

test('private Realtime crashes retain only fixed presence bits and hashed source frames', () => {
  const output =
    'PRIVATE JWT\n** (MatchError) PRIVATE SQL\n (realtime) lib/realtime/example.ex:42: private_value\n' +
    '(realtime) lib/realtime/example.ex:42: private_value\nApplication realtime exited: shutdown';
  const actual = realtimeLogDiagnostic(output);
  assert.equal(
    actual.realtime_log_markers,
    ['MatchError', 'Application realtime exited', 'shutdown'].reduce(
      (value, marker) => value + 2 ** realtimeLogMarkers.indexOf(marker),
      0
    )
  );
  assert.deepEqual(actual.realtime_frames, [
    createHash('sha256').update('example.ex').digest('hex') + ':42',
  ]);
  assert.ok(!JSON.stringify(actual).includes('PRIVATE'));
  assert.ok(!JSON.stringify(actual).includes('example.ex'));
  assert.deepEqual(realtimeLogDiagnostic(null), {});
  assert.deepEqual(realtimeLogDiagnostic('a'.repeat(8 * 1024 * 1024 + 1)), {});
  assert.equal(
    realtimeLogDiagnostic(Array.from({ length: 20 }, (_, i) => `file.ex:${i + 1}`).join('\n'))
      .realtime_frames.length,
    8
  );
});

test('actual native child exit and signal retain only reviewed service identity and status', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
  child.nativeName = 'realtime';
  assert.equal(nativeChildFailure([child]), null);
  await once(child, 'exit');
  const record = nativeFailureDiagnostic('realtime-server-ready', nativeChildFailure([child]));
  assert.deepEqual(record, {
    status: 'failed',
    stage: 'realtime-server-ready',
    error: 'Error',
    native_service: 'realtime',
    service_exit_code: 7,
  });
  const killed = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  killed.nativeName = 'realtime';
  const exited = once(killed, 'exit');
  killed.kill('SIGKILL');
  await exited;
  assert.equal(
    nativeFailureDiagnostic('realtime-server-ready', nativeChildFailure([killed])).service_signal,
    'SIGKILL'
  );
  for (const value of ['PRIVATE TOKEN', [], null, true]) {
    const hidden = nativeFailureDiagnostic('realtime-server-ready', {
      name: 'Error',
      native_service: value,
      service_signal: value,
    });
    assert.equal(hidden.native_service, undefined);
    assert.equal(hidden.service_signal, undefined);
  }
});

test('listener diagnostics permit only reviewed reasons and bounded integer counts', () => {
  const endpoint = nativeFailureDiagnostic('realtime-loopback-and-gateway', {
    name: 'Error',
    listener_reason: 'listener-set',
    listener_http_port: 4000,
    listener_http_address: 'ipv4-loopback',
  });
  assert.equal(endpoint.listener_http_port, 4000);
  assert.equal(endpoint.listener_http_address, 'ipv4-loopback');
  for (const invalid of ['PRIVATE ADDRESS', 'ipv4-loopback\n', [], null, true]) {
    assert.equal(
      nativeFailureDiagnostic('realtime-loopback-and-gateway', {
        name: 'Error',
        listener_reason: 'listener-set',
        listener_http_address: invalid,
      }).listener_http_address,
      undefined
    );
  }
  for (const invalid of [-1, 65536, '1', true, null, [], 1.5]) {
    const result = nativeFailureDiagnostic('realtime-loopback-and-gateway', {
      name: 'Error',
      listener_reason: 'listener-set',
      listener_other4: invalid,
    });
    assert.equal(result.listener_reason, 'listener-set');
    assert.equal(result.listener_other4, undefined);
  }
  for (const invalid of ['PRIVATE ADDRESS', 'header\n', null, [], true]) {
    const result = nativeFailureDiagnostic('realtime-loopback-and-gateway', {
      name: 'Error',
      listener_reason: invalid,
      listener_other4: 1,
    });
    assert.deepEqual(result, {
      status: 'failed',
      stage: 'realtime-loopback-and-gateway',
      error: 'Error',
    });
  }
});

test('actual failed command retains only exit status and unique source-backed failure codes', async () => {
  let failure;
  try {
    await promisify(execFile)(process.execPath, [
      '-e',
      'process.stderr.write("running db migrations: PRIVATE SQL PASSWORD (SQLSTATE 42501)");process.exit(1)',
    ]);
  } catch (error) {
    failure = error;
  }
  assert.deepEqual(nativeFailureDiagnostic('gotrue-migrate-command', failure), {
    status: 'failed',
    stage: 'gotrue-migrate-command',
    error: 'Error',
    exit_code: 1,
    command_phase: 'auth-migrations',
    command_sqlstate: '42501',
  });
  for (const code of [0, 256, -1, 1.5, '1', true, null]) {
    assert.equal(
      nativeFailureDiagnostic('gotrue-migrate-command', { name: 'Error', code }).exit_code,
      undefined
    );
  }
  const ambiguous = nativeFailureDiagnostic('gotrue-migrate-command', {
    name: 'Error',
    code: 1,
    stderr: 'opening db connection checking database connection (SQLSTATE 42501) (SQLSTATE 42P01)',
  });
  assert.equal(ambiguous.command_phase, undefined);
  assert.equal(ambiguous.command_sqlstate, undefined);
});

test('database diagnostics retain SQLSTATE and bounded query position without private fields', () => {
  const error = Object.assign(new Error('PRIVATE PASSWORD'), {
    name: 'error',
    code: '42710',
    position: '194',
    query: 'PRIVATE SQL',
    detail: 'PRIVATE ROW',
  });
  assert.deepEqual(nativeFailureDiagnostic('postgresql-bootstrap-roles', error), {
    status: 'failed',
    stage: 'postgresql-bootstrap-roles',
    error: 'error',
    sqlstate: '42710',
    position: 194,
  });
});

test('untrusted codes, names and positions cannot become diagnostic text', () => {
  for (const code of ['SECRET TOKEN', '42P01\n', '', 42710, ['42P01']]) {
    assert.deepEqual(
      nativeFailureDiagnostic('initialization', { name: 'error', code, position: '1' }),
      {
        status: 'failed',
        stage: 'initialization',
        error: 'error',
      }
    );
  }
  for (const position of ['0', '-1', '1000000', '1\n', 'PRIVATE SQL', 1, ['1']]) {
    assert.deepEqual(
      nativeFailureDiagnostic('initialization', { name: 'error', code: '42P01', position }),
      {
        status: 'failed',
        stage: 'initialization',
        error: 'error',
        sqlstate: '42P01',
      }
    );
  }
  for (const error of [
    null,
    undefined,
    { name: 'SECRET TOKEN', code: '42P01' },
    { name: ['Error'] },
  ]) {
    assert.deepEqual(nativeFailureDiagnostic('initialization', error), {
      status: 'failed',
      stage: 'initialization',
      error: 'Error',
    });
  }
  assert.deepEqual(nativeFailureDiagnostic('initialization', { name: 'Error', code: '42P01' }), {
    status: 'failed',
    stage: 'initialization',
    error: 'Error',
  });
});

test('database source routines are restricted to reviewed PostgreSQL slot/file/ACL labels', () => {
  const error = { name: 'error', code: '42501', routine: 'CheckSlotPermissions' };
  assert.equal(
    nativeFailureDiagnostic('postgresql-wal2json-native-slot', error).routine,
    error.routine
  );
  for (const routine of ['PRIVATE SQL', 'CheckSlotPermissions\n', ['CheckSlotPermissions']]) {
    assert.equal(
      nativeFailureDiagnostic('postgresql-wal2json-native-slot', { ...error, routine }).routine,
      undefined
    );
  }
});

test('unknown PostgreSQL source locations are represented only by digests', () => {
  const diagnostic = nativeFailureDiagnostic('postgresql-wal2json-native-slot', {
    name: 'error',
    code: '42501',
    routine: 'PRIVATE ROUTINE',
    file: 'PRIVATE FILE',
  });
  for (const [field, value] of [
    ['routine', 'PRIVATE ROUTINE'],
    ['file', 'PRIVATE FILE'],
  ]) {
    assert.equal(diagnostic[`${field}_sha256`], createHash('sha256').update(value).digest('hex'));
  }
  assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE'));
});

test('only the fixed native smoke source line is retained from a private stack', () => {
  const record = nativeFailureDiagnostic('postgresql-start', {
    name: 'AssertionError',
    stack:
      'PRIVATE VALUE\n at services (file:///opt/qualification/runtime/native-smoke.mjs:324:5)\nPRIVATE VALUE',
  });
  assert.deepEqual(record, {
    status: 'failed',
    stage: 'postgresql-start',
    error: 'AssertionError',
    native_line: 324,
  });
});
