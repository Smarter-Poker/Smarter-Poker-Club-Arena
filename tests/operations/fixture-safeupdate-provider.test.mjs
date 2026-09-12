import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureFixtureSafeupdate,
  assertFixtureSafeupdateSession,
  assertFixtureSafeupdateHttp,
  assertSafeupdateSqlRefusal,
} from '../../operations/release/fixture/safeupdate-provider.mjs';

function ordinarySession({ protectedReadAllowed = false } = {}) {
  const calls = [];
  let role = 'authenticator';
  return {
    calls,
    async query(sql) {
      calls.push({ sql, role });
      // Reproduce PostgreSQL's visibility boundary even inside a larger
      // identity query. A positive read of the preload list is the old bug.
      if (sql.includes("current_setting('session_preload_libraries')")) {
        if (protectedReadAllowed) return { rows: [{ current_setting: 'safeupdate' }] };
        throw Object.assign(new Error('protected setting'), { code: '42501' });
      }
      if (sql.includes('AS fresh_native_session'))
        return { rows: [{ fresh_native_session: true }] };
      if (sql === 'SET LOCAL ROLE authenticated') role = 'authenticated';
      if (sql === 'ROLLBACK') role = 'authenticator';
      if (sql === 'SET LOCAL safeupdate.enabled=off')
        throw Object.assign(new Error('protected mutation'), { code: '42501' });
      if (/^(UPDATE|DELETE|WITH changed)/.test(sql) && !sql.includes('WHERE'))
        throw Object.assign(new Error('unqualified DML'), { code: '21000' });
      if (sql === 'SELECT * FROM public.fixture_safeupdate_probe ORDER BY id')
        return { rows: [{ id: 1, marker: 11 }] };
      if (sql === 'SELECT current_user AS role') return { rows: [{ role }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

test('ordinary native proof preserves protected-read refusal for both SQL identities', async () => {
  const db = ordinarySession();
  await assertFixtureSafeupdateSession(db);
  assert.deepEqual(
    db.calls
      .filter(({ sql }) => sql.includes("current_setting('session_preload_libraries')"))
      .map(({ role }) => role),
    ['authenticator', 'authenticated']
  );
  assert.equal(db.calls.at(-2).sql, 'ROLLBACK');
});

test('unexpected protected-setting visibility fails and still rolls back', async () => {
  const db = ordinarySession({ protectedReadAllowed: true });
  await assert.rejects(
    assertFixtureSafeupdateSession(db),
    /FIXTURE_SAFEUPDATE_EXACT_REFUSAL_REQUIRED/
  );
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
});

test('HTTP proof rejects broadened setting access before any probe-row mutation', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const body = url.endsWith('/fixture_safeupdate_session')
      ? {
          session_user: 'authenticator',
          current_user: 'authenticated',
          database: 'club_arena_qualification',
          enabled: 'on',
          setting_type: 'bool',
          setting_context: 'superuser',
        }
      : 'safeupdate';
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    await assert.rejects(
      assertFixtureSafeupdateHttp(
        {
          query: async (sql) => {
            assert.equal(sql, 'SELECT * FROM public.fixture_safeupdate_probe ORDER BY id');
            return {
              rows: [
                { id: 1, marker: 10 },
                { id: 2, marker: 20 },
              ],
            };
          },
        },
        'synthetic-fixture-token'
      )
    );
    assert.deepEqual(calls, [
      'http://127.0.0.1:3000/rpc/fixture_safeupdate_session',
      'http://127.0.0.1:3000/rpc/fixture_safeupdate_protected_setting',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
