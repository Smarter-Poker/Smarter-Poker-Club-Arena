import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const { Client } = createRequire(root + '/server/package.json')('pg');
const pg = process.env.HORSE_PROOF_PG_BIN,
  output = process.argv[2];
if (!pg || !output) throw Error('Existing PostgreSQL runtime and new output required');
const dir = mkdtempSync('/tmp/horse-telemetry-native-'),
  data = dir + '/data',
  socket = dir + '/socket';
mkdirSync(socket, { mode: 0o700 });
const names = [
  'fn_ca_knockout_door_stalled',
  'fn_ca_orphaned_running_tournaments',
  'fn_ca_rake_rollup_writer_silent',
  'fn_ca_stranded_completing_tournaments',
  'fn_ca_tables_that_cannot_deal',
];
let c,
  running = false,
  proof;
const results = [];
try {
  execFileSync(
    pg + '/initdb',
    ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '--encoding=UTF8'],
    { stdio: 'pipe' }
  );
  execFileSync(
    pg + '/pg_ctl',
    [
      '-D',
      data,
      '-l',
      dir + '/postgres.log',
      '-o',
      '-k ' +
        socket +
        " -p 55439 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
      '-w',
      'start',
    ],
    { stdio: 'pipe' }
  );
  running = true;
  c = new Client({
    host: socket,
    port: 55439,
    user: 'postgres',
    database: 'postgres',
    statement_timeout: 5000,
  });
  await c.connect();
  await c.query(
    "CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;GRANT USAGE ON SCHEMA auth TO PUBLIC;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;CREATE TABLE ca_bbj_policy(id integer PRIMARY KEY,pivot_threshold numeric,standard_main numeric,standard_backup numeric,pivot_main numeric,pivot_backup numeric);INSERT INTO ca_bbj_policy VALUES(1,100000,0.4,0.4,0.15,0.3);REVOKE ALL ON ca_bbj_policy FROM PUBLIC,anon,authenticated,service_role;"
  );
  // These fixture-only bodies test permissions; production diagnostic bodies
  // are not replaced by the migration and their live hashes are checked separately.
  for (const name of names)
    await c.query(
      `CREATE FUNCTION ${name}(integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT jsonb_build_object('fixtureOnlyDiagnostic',true)$$`
    );
  const old = readFileSync(
    root +
      '/supabase/migrations/20260911220331_the_pivot_the_page_shows_is_the_pivot_the_bank_applies.sql',
    'utf8'
  ).match(
    /CREATE OR REPLACE FUNCTION public\.fn_bbj_allocation_policy\(\)[\s\S]+?\$function\$;/
  )[0];
  await c.query(old);
  await c.query(
    'REVOKE ALL ON FUNCTION fn_bbj_allocation_policy() FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION fn_bbj_allocation_policy() TO authenticated,service_role'
  );
  await c.query('SET ROLE authenticated');
  const before = (await c.query('SELECT fn_bbj_allocation_policy() value')).rows[0].value;
  assert.equal(before.standard_promo, 0.2);
  assert.equal(
    (await c.query('SELECT fn_ca_tables_that_cannot_deal(5) value')).rows[0].value
      .fixtureOnlyDiagnostic,
    true
  );
  await c.query('RESET ROLE');
  results.push({
    case: 'pre-change account role can reach diagnostics and policy without a subject',
    passed: true,
  });
  const hashes = async () =>
    (
      await c.query(
        'SELECT proname,md5(prosrc) hash FROM pg_proc WHERE proname=ANY($1) ORDER BY proname',
        [names]
      )
    ).rows;
  const originalHashes = await hashes();
  await c.query(
    readFileSync(
      root +
        '/supabase/migrations/20260914000107_preserve_player_rules_close_operator_telemetry.sql',
      'utf8'
    )
  );
  assert.deepEqual(await hashes(), originalHashes);
  for (const role of ['anon', 'authenticated']) {
    await c.query('SET ROLE ' + role);
    for (const name of names)
      await assert.rejects(c.query('SELECT ' + name + '(5)'), (e) => e.code === '42501');
    if (role === 'anon')
      await assert.rejects(c.query('SELECT fn_bbj_allocation_policy()'), (e) => e.code === '42501');
    else
      assert.equal((await c.query('SELECT fn_bbj_allocation_policy() value')).rows[0].value, null);
    await c.query('RESET ROLE');
  }
  results.push({
    case: 'five diagnostics deny both player roles; accountless role receives no policy; diagnostic bodies unchanged',
    passed: true,
  });
  await c.query(
    "SELECT set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false)"
  );
  await c.query('SET ROLE authenticated');
  assert.deepEqual(
    (await c.query('SELECT fn_bbj_allocation_policy() value')).rows[0].value,
    before
  );
  await assert.rejects(c.query('SELECT * FROM ca_bbj_policy'), (e) => e.code === '42501');
  await c.query('RESET ROLE');
  results.push({
    case: 'authenticated account keeps exact player-facing rates without direct policy-table access',
    passed: true,
  });
  await c.query(
    "SELECT set_config('request.jwt.claim.role','service_role',false),set_config('request.jwt.claim.sub','',false)"
  );
  await c.query('SET ROLE service_role');
  assert.deepEqual(
    (await c.query('SELECT fn_bbj_allocation_policy() value')).rows[0].value,
    before
  );
  for (const name of names)
    assert.equal(
      (await c.query('SELECT ' + name + '(5) value')).rows[0].value.fixtureOnlyDiagnostic,
      true
    );
  await c.query('RESET ROLE');
  results.push({
    case: 'service request without user subject keeps all diagnostics and identical allocator policy',
    passed: true,
  });
  proof = {
    results,
    productionPostgrestVerified: false,
    diagnosticBodiesModeled: false,
    diagnosticAclFixtureOnly: true,
  };
} finally {
  if (c) await c.end();
  if (running) {
    execFileSync(pg + '/pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    running = false;
  }
  rmSync(dir, { recursive: true, force: true });
  if (proof) {
    proof.cleanup = { stopped: !running, removed: true };
    writeFileSync(output, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  }
}
