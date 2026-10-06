import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schemaCacheDiagnostics } from './diagnostics.mjs';
test('retains fixed schema-cache cause and only known object names', () => {
  const log =
    JSON.stringify({
      code: '42501',
      message: 'permission denied for schema "smarter_private"',
      details: 'postgres://user:secret@private-host/db',
      hint: 'Bearer secret',
    }) +
    '\n' +
    JSON.stringify({ code: '42P01', message: 'relation "untrusted_secret" does not exist' });
  assert.deepEqual(schemaCacheDiagnostics(log, ['smarter_private']), [
    { codes: ['42501'], category: 'permission-denied', objects: ['smarter_private'] },
    { codes: ['42P01'], category: 'missing-relation', objects: [] },
  ]);
  assert.equal(
    JSON.stringify(schemaCacheDiagnostics(log, ['smarter_private'])).includes('secret'),
    false
  );
});
test('bounds, deduplicates and refuses arbitrary messages', () => {
  assert.deepEqual(schemaCacheDiagnostics('Bearer secret\nSQL SELECT secret'), []);
  assert.equal(
    schemaCacheDiagnostics(
      Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({ code: String(42000 + i), message: 'unknown' })
      ).join('\n')
    ).length,
    8
  );
  assert.equal(
    schemaCacheDiagnostics(
      Array(100).fill('{"code":"42P01","message":"relation does not exist"}').join('\n')
    ).length,
    1
  );
});

test('accepts actual PostgreSQL unquoted names only from the allowlist', () => {
  assert.deepEqual(
    schemaCacheDiagnostics(
      'permission denied for schema smarter_private\npermission denied for function fn_ca_commit_hand_submission\npermission denied for function arbitrary_secret',
      ['smarter_private', 'fn_ca_commit_hand_submission']
    ),
    [
      { codes: [], category: 'permission-denied', objects: ['smarter_private'] },
      { codes: [], category: 'permission-denied', objects: ['fn_ca_commit_hand_submission'] },
      { codes: [], category: 'permission-denied', objects: [] },
    ]
  );
});
