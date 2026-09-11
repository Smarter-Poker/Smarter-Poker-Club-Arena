import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeFailureDiagnostic } from '../../operations/release/fixture/runtime-files.mjs';

test('listener diagnostics permit only reviewed reasons and bounded integer counts', () => {
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
