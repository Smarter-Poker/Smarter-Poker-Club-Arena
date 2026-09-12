import assert from 'node:assert/strict';
import { assertFixtureServiceBootstrap } from './service-role-boundary.mjs';

export async function configureFixtureSafeupdate(db) {
  await assertFixtureServiceBootstrap(db);
  const before = await db.query(`SELECT
    (SELECT rolcanlogin AND NOT rolsuper AND NOT rolinherit AND rolconfig IS NULL
      FROM pg_roles WHERE rolname='authenticator')
    AND NOT EXISTS(SELECT FROM pg_db_role_setting
      WHERE setrole=(SELECT oid FROM pg_roles WHERE rolname='authenticator'))
    AND NOT EXISTS(SELECT FROM pg_stat_activity WHERE usename='authenticator')
    AS fresh_authenticator`);
  assert.deepEqual(
    before.rows,
    [{ fresh_authenticator: true }],
    'FIXTURE_SAFEUPDATE_FRESH_AUTHENTICATOR_REQUIRED'
  );
  await db.query('BEGIN');
  try {
    await db.query("ALTER ROLE authenticator SET session_preload_libraries='safeupdate'");
    const after = await db.query(`SELECT rolconfig FROM pg_roles WHERE rolname='authenticator'`);
    assert.deepEqual(after.rows, [{ rolconfig: ['session_preload_libraries=safeupdate'] }]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

// Only the isolated native smoke creates these two disposable nonfinancial rows.
// Full-schema startup configures the real library without adding these objects.
export const safeupdateProbeSetupSql = `
  CREATE TABLE public.fixture_safeupdate_probe (id integer PRIMARY KEY, marker integer NOT NULL);
  INSERT INTO public.fixture_safeupdate_probe VALUES (1,10),(2,20);
  GRANT SELECT,UPDATE,DELETE ON public.fixture_safeupdate_probe TO authenticated;
  CREATE FUNCTION public.fixture_safeupdate_session() RETURNS jsonb LANGUAGE sql STABLE
    SECURITY INVOKER AS $$SELECT jsonb_build_object(
      'session_user',session_user,'current_user',current_user,
      'database',current_database(),'enabled',current_setting('safeupdate.enabled'),
      'setting_type',(SELECT vartype FROM pg_settings WHERE name='safeupdate.enabled'),
      'setting_context',(SELECT context FROM pg_settings WHERE name='safeupdate.enabled'))$$;
  REVOKE ALL ON FUNCTION public.fixture_safeupdate_session() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.fixture_safeupdate_session() TO authenticated;
  CREATE FUNCTION public.fixture_safeupdate_protected_setting() RETURNS text LANGUAGE sql STABLE
    SECURITY INVOKER AS $$SELECT current_setting('session_preload_libraries')$$;
  REVOKE ALL ON FUNCTION public.fixture_safeupdate_protected_setting() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.fixture_safeupdate_protected_setting() TO authenticated;
`;

export async function assertSafeupdateSqlRefusal(db, sql, code) {
  await db.query('SAVEPOINT fixture_safeupdate_refusal');
  let failure;
  try {
    await db.query(sql);
  } catch (error) {
    failure = error;
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT fixture_safeupdate_refusal');
    await db.query('RELEASE SAVEPOINT fixture_safeupdate_refusal');
  }
  assert.equal(failure?.code, code, 'FIXTURE_SAFEUPDATE_EXACT_REFUSAL_REQUIRED');
}

export async function assertFixtureSafeupdateSession(db) {
  const identity = await db.query(`SELECT current_database()='club_arena_qualification'
    AND inet_server_addr()='127.0.0.1'::inet AND session_user='authenticator'
    AND current_user='authenticator' AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
    AND EXISTS(SELECT FROM pg_settings WHERE name='safeupdate.enabled'
      AND vartype='bool' AND context='superuser' AND setting='on')
    AND current_setting('safeupdate.enabled')='on' AS fresh_native_session`);
  assert.deepEqual(
    identity.rows,
    [{ fresh_native_session: true }],
    'FIXTURE_SAFEUPDATE_NATIVE_SESSION_REQUIRED'
  );
  await db.query('BEGIN');
  try {
    // PostgreSQL protects the preload list even from SHOW/current_setting.
    // Keep that denial; the genuine registered setting and DML hooks prove
    // loading without granting pg_read_all_settings or adding a definer.
    await assertSafeupdateSqlRefusal(
      db,
      "SELECT current_setting('session_preload_libraries')",
      '42501'
    );
    await db.query('SET LOCAL ROLE authenticated');
    await assertSafeupdateSqlRefusal(
      db,
      "SELECT current_setting('session_preload_libraries')",
      '42501'
    );
    for (const sql of [
      'UPDATE public.fixture_safeupdate_probe SET marker=999',
      'DELETE FROM public.fixture_safeupdate_probe',
      'WITH changed AS (UPDATE public.fixture_safeupdate_probe SET marker=999 RETURNING id) SELECT * FROM changed',
      'WITH changed AS (DELETE FROM public.fixture_safeupdate_probe RETURNING id) SELECT * FROM changed',
    ])
      await assertSafeupdateSqlRefusal(db, sql, '21000');
    await assertSafeupdateSqlRefusal(db, 'SET LOCAL safeupdate.enabled=off', '42501');
    assert.equal(
      (await db.query('UPDATE public.fixture_safeupdate_probe SET marker=11 WHERE id=1')).rowCount,
      1
    );
    assert.equal(
      (await db.query('DELETE FROM public.fixture_safeupdate_probe WHERE id=2')).rowCount,
      1
    );
    assert.deepEqual(
      (await db.query('SELECT * FROM public.fixture_safeupdate_probe ORDER BY id')).rows,
      [{ id: 1, marker: 11 }]
    );
  } finally {
    await db.query('ROLLBACK');
  }
  // SET LOCAL must not leak the API role into the session after rollback.
  assert.deepEqual((await db.query('SELECT current_user AS role')).rows, [
    { role: 'authenticator' },
  ]);
}

export async function assertFixtureSafeupdateHttp(db, accessToken) {
  assert.ok(typeof accessToken === 'string' && accessToken.length > 0);
  const baseline = [
    { id: 1, marker: 10 },
    { id: 2, marker: 20 },
  ];
  const rows = async () =>
    (await db.query('SELECT * FROM public.fixture_safeupdate_probe ORDER BY id')).rows;
  assert.deepEqual(await rows(), baseline);
  async function request(path, method = 'GET', body) {
    return fetch(`http://127.0.0.1:3000/${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const session = await request('rpc/fixture_safeupdate_session');
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    session_user: 'authenticator',
    current_user: 'authenticated',
    database: 'club_arena_qualification',
    enabled: 'on',
    setting_type: 'bool',
    setting_context: 'superuser',
  });
  const protectedSetting = await request('rpc/fixture_safeupdate_protected_setting');
  assert.equal(protectedSetting.status, 403);
  assert.equal((await protectedSetting.json()).code, '42501');
  for (const method of ['PATCH', 'DELETE']) {
    const response = await request(
      'fixture_safeupdate_probe',
      method,
      method === 'PATCH' ? { marker: 999 } : undefined
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, '21000');
    assert.deepEqual(await rows(), baseline);
  }
  const updated = await request('fixture_safeupdate_probe?id=eq.1', 'PATCH', {
    marker: 11,
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), [{ id: 1, marker: 11 }]);
  const deleted = await request('fixture_safeupdate_probe?id=eq.2', 'DELETE');
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), [{ id: 2, marker: 20 }]);
  assert.deepEqual(await rows(), [{ id: 1, marker: 11 }]);
  // These successful HTTP transactions commit only fixture rows. Restore and
  // inspect them explicitly; the outer driver separately destroys all resources.
  await db.query('UPDATE public.fixture_safeupdate_probe SET marker=10 WHERE id=1');
  await db.query('INSERT INTO public.fixture_safeupdate_probe VALUES(2,20)');
  assert.deepEqual(await rows(), baseline);
  await db.query(
    'DROP FUNCTION public.fixture_safeupdate_session(); DROP FUNCTION public.fixture_safeupdate_protected_setting(); DROP TABLE public.fixture_safeupdate_probe'
  );
  assert.deepEqual(
    (
      await db.query(`SELECT to_regclass('public.fixture_safeupdate_probe') IS NULL
    AND to_regprocedure('public.fixture_safeupdate_session()') IS NULL
    AND to_regprocedure('public.fixture_safeupdate_protected_setting()') IS NULL AS absent`)
    ).rows,
    [{ absent: true }]
  );
  return Object.freeze({
    library: 'safeupdate-1.4',
    source: '104f78d27b607076b49f22927ba33828fd0a98a0',
    fresh_session: 'authenticator-native-loaded',
    protected_setting_read: 'sql-and-http-42501',
    sql_refusals: 'update-delete-cte-21000',
    ordinary_disable: '42501',
    http: 'unfiltered-denied-filtered-committed',
    probe_cleanup: 'rows-restored-objects-absent',
    production_binary_parity: false,
    complete_role_graph_parity: false,
    production_pre_request_parity: false,
  });
}
