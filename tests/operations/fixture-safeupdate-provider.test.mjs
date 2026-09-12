import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureFixtureSafeupdate,
  assertFixtureSafeupdateSession,
  assertSafeupdateSqlRefusal,
} from '../../operations/release/fixture/safeupdate-provider.mjs';

test('configuration rejects an ordinary caller before mutation', async () => {
  const calls = [];
  await assert.rejects(
    configureFixtureSafeupdate({
      query: async (sql) => {
        calls.push(sql);
        return { rows: [{ owned_service_bootstrap: false }] };
      },
    }),
    /FIXTURE_SERVICE_BOOTSTRAP_IDENTITY_REQUIRED/
  );
  assert.equal(calls.length, 1);
});

test('configuration rejects a reused or preconfigured authenticator', async () => {
  const calls = [];
  await assert.rejects(
    configureFixtureSafeupdate({
      query: async (sql) => {
        calls.push(sql);
        return {
          rows: [
            sql.includes('owned_service_bootstrap')
              ? { owned_service_bootstrap: true }
              : { fresh_authenticator: false },
          ],
        };
      },
    }),
    /FIXTURE_SAFEUPDATE_FRESH_AUTHENTICATOR_REQUIRED/
  );
  assert.equal(calls.length, 2);
});

test('configuration failure rolls back without committing a partial setting', async () => {
  const calls = [],
    failure = new Error('configuration denied');
  await assert.rejects(
    configureFixtureSafeupdate({
      query: async (sql) => {
        calls.push(sql);
        if (sql.includes('owned_service_bootstrap'))
          return { rows: [{ owned_service_bootstrap: true }] };
        if (sql.includes('AS fresh_authenticator'))
          return { rows: [{ fresh_authenticator: true }] };
        if (sql.startsWith('ALTER ROLE')) throw failure;
        return { rows: [] };
      },
    }),
    (error) => error === failure
  );
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.ok(!calls.includes('COMMIT'));
});

test('a stale session cannot qualify the native hook through metadata alone', async () => {
  const calls = [];
  await assert.rejects(
    assertFixtureSafeupdateSession({
      query: async (sql) => {
        calls.push(sql);
        return { rows: [{ fresh_native_session: false }] };
      },
    }),
    /FIXTURE_SAFEUPDATE_NATIVE_SESSION_REQUIRED/
  );
  assert.equal(calls.length, 1);
});

test('unrelated SQL failures and successful unsafe statements are refused', async () => {
  for (const code of [undefined, '42501', '42P01']) {
    const calls = [];
    await assert.rejects(
      assertSafeupdateSqlRefusal(
        {
          query: async (sql) => {
            calls.push(sql);
            if (sql === 'unsafe' && code)
              throw Object.assign(new Error('different failure'), { code });
            return { rows: [] };
          },
        },
        'unsafe',
        '21000'
      ),
      /FIXTURE_SAFEUPDATE_EXACT_REFUSAL_REQUIRED/
    );
    assert.deepEqual(calls.slice(-2), [
      'ROLLBACK TO SAVEPOINT fixture_safeupdate_refusal',
      'RELEASE SAVEPOINT fixture_safeupdate_refusal',
    ]);
  }
});
