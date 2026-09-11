import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFailureDiagnostic } from '../../operations/release/fixture/runtime-files.mjs';

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
