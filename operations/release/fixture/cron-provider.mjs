import assert from 'node:assert/strict';
import {
  assertFixtureServiceBootstrap,
  assertApplicationOwnerBoundary,
} from './service-role-boundary.mjs';

// The scheduler library is genuine; launching jobs is disabled in this isolated
// fixture. This qualifies its C metadata API, never background execution.
export const cronPostgresArguments = Object.freeze([
  '-c',
  'cron.database_name=club_arena_qualification',
  '-c',
  'cron.launch_active_jobs=off',
  '-c',
  'cron.enable_superuser_jobs=off',
]);

const functions = [
  ['cron.alter_job(bigint,text,text,text,text,boolean)', '5e814176c72d942a3db7ad6d949424d7'],
  ['cron.job_cache_invalidate()', 'd274e5ebc3de07c1cb068b8cb2fbfd26'],
  ['cron.schedule(text,text)', 'b3a464e5efed87e0ca18254b65e41db0'],
  ['cron.schedule(text,text,text)', '5c92925f774018cbc464e282ae2fdd71'],
  [
    'cron.schedule_in_database(text,text,text,text,text,boolean)',
    '5c92925f774018cbc464e282ae2fdd71',
  ],
  ['cron.unschedule(bigint)', '04ce3d2d0c8733820cdb658e2ede8283'],
  ['cron.unschedule(text)', '822f4a93b894c6f6f302bf93ad08988a'],
];

export async function assertFixtureCronCatalog(db) {
  const result = await db.query(`SELECT e.extversion='1.6.4'
    AND pg_get_userbyid(e.extowner)='supabase_admin'
    AND e.extnamespace='pg_catalog'::regnamespace
    AND (SELECT pg_get_userbyid(nspowner)='supabase_admin' FROM pg_namespace WHERE nspname='cron')
    AND has_schema_privilege('postgres','cron','USAGE')
    AND NOT has_schema_privilege('postgres','cron','CREATE') AS owned_extension
    FROM pg_extension e WHERE e.extname='pg_cron'`);
  assert.deepEqual(result.rows, [{ owned_extension: true }], 'FIXTURE_CRON_EXTENSION_REQUIRED');
  const catalog = await db.query(`SELECT p.oid::regprocedure::text AS identity,
    md5(p.prosrc) AS body_md5, pg_get_userbyid(p.proowner) AS owner,
    l.lanname AS language, p.probin AS library, e.extname AS extension,
    p.prosecdef AS security_definer, p.proisstrict AS strict, p.proconfig AS config,
    ARRAY(SELECT a::text FROM unnest(p.proacl) a ORDER BY a::text) AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang
    LEFT JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
    LEFT JOIN pg_extension e ON e.oid=d.refobjid
    WHERE n.nspname='cron' ORDER BY p.oid::regprocedure::text`);
  assert.deepEqual(
    catalog.rows,
    functions.map(([identity, body_md5]) => ({
      identity,
      body_md5,
      owner: 'supabase_admin',
      language: 'c',
      library: '$libdir/pg_cron',
      extension: 'pg_cron',
      security_definer: false,
      strict: [
        'cron.schedule(text,text)',
        'cron.unschedule(bigint)',
        'cron.unschedule(text)',
      ].includes(identity),
      config: null,
      acl: [
        ...([
          'cron.alter_job(bigint,text,text,text,text,boolean)',
          'cron.schedule_in_database(text,text,text,text,text,boolean)',
        ].includes(identity)
          ? []
          : ['=X/supabase_admin']),
        'postgres=X*/supabase_admin',
        'supabase_admin=X/supabase_admin',
      ],
    })),
    'FIXTURE_CRON_NATIVE_FUNCTIONS_REQUIRED'
  );
}

export async function installFixtureCron(db) {
  await assertFixtureServiceBootstrap(db);
  const state = await db.query(`SELECT current_setting('cron.database_name')=current_database()
    AND current_setting('cron.launch_active_jobs')='off'
    AND current_setting('cron.enable_superuser_jobs')='off'
    AND NOT EXISTS(SELECT FROM pg_extension WHERE extname='pg_cron')
    AND NOT EXISTS(SELECT FROM pg_namespace WHERE nspname='cron') AS empty_isolated_cron`);
  assert.deepEqual(
    state.rows,
    [{ empty_isolated_cron: true }],
    'FIXTURE_CRON_EMPTY_ISOLATED_TARGET_REQUIRED'
  );
  await db.query('BEGIN');
  try {
    await db.query("CREATE EXTENSION pg_cron WITH SCHEMA pg_catalog VERSION '1.6.4'");
    await db.query('GRANT USAGE ON SCHEMA cron TO postgres WITH GRANT OPTION');
    await db.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cron TO postgres WITH GRANT OPTION');
    await assertFixtureCronCatalog(db);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export async function assertFixtureCronMetadataApi(db) {
  await assertApplicationOwnerBoundary(db);
  await assertFixtureCronCatalog(db);
  assert.deepEqual((await db.query('SELECT count(*)::int AS count FROM cron.job')).rows, [
    { count: 0 },
  ]);
  await db.query('BEGIN');
  try {
    const first = await db.query(
      "SELECT cron.schedule('fixture_cron_by_id', '* * * * *', 'SELECT 1') AS id"
    );
    const id = first.rows[0]?.id;
    assert.match(String(id), /^[1-9][0-9]*$/);
    await db.query('SELECT cron.alter_job($1::bigint, active := false)', [id]);
    assert.deepEqual(
      (await db.query('SELECT username, active, command FROM cron.job WHERE jobid=$1', [id])).rows,
      [{ username: 'postgres', active: false, command: 'SELECT 1' }]
    );
    assert.deepEqual((await db.query('SELECT cron.unschedule($1::bigint) AS removed', [id])).rows, [
      { removed: true },
    ]);
    await db.query("SELECT cron.schedule('fixture_cron_by_name', '* * * * *', 'SELECT 1')");
    assert.deepEqual(
      (await db.query("SELECT cron.unschedule('fixture_cron_by_name'::text) AS removed")).rows,
      [{ removed: true }]
    );
    // Leave one row inside the transaction so ROLLBACK must actually remove it.
    await db.query("SELECT cron.schedule('fixture_cron_rollback', '* * * * *', 'SELECT 1')");
    assert.deepEqual((await db.query('SELECT count(*)::int AS count FROM cron.job')).rows, [
      { count: 1 },
    ]);
  } finally {
    await db.query('ROLLBACK');
  }
  assert.deepEqual((await db.query('SELECT count(*)::int AS count FROM cron.job')).rows, [
    { count: 0 },
  ]);
  await db.query('BEGIN');
  let denied = false;
  try {
    await db.query(
      'CREATE FUNCTION cron.fixture_forbidden() RETURNS integer LANGUAGE sql AS $$SELECT 1$$'
    );
  } catch (error) {
    if (error.code !== '42501') throw error;
    denied = true;
  } finally {
    await db.query('ROLLBACK');
  }
  assert.ok(denied, 'FIXTURE_CRON_APPLICATION_DDL_MUST_FAIL');
  assert.equal(
    (await db.query("SELECT to_regprocedure('cron.fixture_forbidden()') IS NULL AS absent")).rows[0]
      ?.absent,
    true
  );
  await assertFixtureCronCatalog(db);
  return Object.freeze({
    source: '9490f9cc9803f75105f2f7d89839a998f011f8d8',
    extension_version: '1.6.4',
    native_functions: 7,
    metadata_api: 'schedule-alter-unschedule-rollback',
    application_ddl: 'denied',
    background_jobs: 'disabled',
    production_binary_parity: false,
    complete_cron_acl_parity: false,
  });
}
