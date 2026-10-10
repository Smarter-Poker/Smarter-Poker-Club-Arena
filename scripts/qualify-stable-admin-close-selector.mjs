import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const caRoot = process.argv[2] || path.resolve(import.meta.dirname, '..');
if (!caRoot) throw Error('Pass the qualified Club Arena source checkout as argv[2]');
const { fixtureSql } = await import(
  pathToFileURL(path.resolve(caRoot, 'scripts/qualification/stable-admin-floor/fixture.mjs')).href
);
const root = path.resolve(import.meta.dirname, '..');
const base = process.env.TMPDIR;
if (!base || (!base.startsWith('/Volumes/SmarterWork/agent-work/') && !process.env.CI))
  throw Error('Owned SSD TMPDIR required locally');
const pg = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const dir = fs.mkdtempSync(path.join(base, 'close-'));
const port = String(45000 + Math.floor(Math.random() * 15000));
const db = `qual_floor_${randomUUID().replaceAll('-', '')}`;
const args = [
  '-h',
  dir,
  '-p',
  port,
  '-U',
  process.env.USER || 'postgres',
  '-d',
  db,
  '-v',
  'ON_ERROR_STOP=1',
];
function run(bin, argv, options = {}) {
  const result = spawnSync(path.join(pg, bin), argv, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    let startupLog = '';
    if (bin === 'pg_ctl' && argv.includes('start')) {
      const log = path.join(dir, 'postgres.log');
      if (fs.existsSync(log)) {
        const descriptor = fs.openSync(log, 'r');
        try {
          const size = fs.fstatSync(descriptor).size;
          const tail = Buffer.alloc(Math.min(size, 8192));
          fs.readSync(descriptor, tail, 0, tail.length, Math.max(0, size - tail.length));
          startupLog = `\nOwned PostgreSQL startup log (last 8192 bytes):\n${tail.toString('utf8')}`;
        } finally {
          fs.closeSync(descriptor);
        }
      }
    }
    throw Error(`${bin} failed: ${result.stderr || result.stdout}${startupLog}`);
  }
  return result.stdout;
}
function query(sql) {
  return run('psql', args, { input: sql });
}
let started = false;
try {
  run('initdb', ['-D', path.join(dir, 'data'), '-A', 'trust', '--no-locale']);
  run('pg_ctl', [
    '-D',
    path.join(dir, 'data'),
    '-l',
    path.join(dir, 'postgres.log'),
    '-o',
    `-k ${dir} -p ${port} -c listen_addresses='' -c shared_memory_type=mmap`,
    '-w',
    'start',
  ]);
  started = true;
  run('createdb', ['-h', dir, '-p', port, '-U', process.env.USER || 'postgres', db]);
  query(
    `DO $$ BEGIN IF current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999 OR current_database()<>'${db}' OR inet_server_addr() IS NOT NULL OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace) THEN RAISE EXCEPTION 'fresh isolated PG17 only'; END IF; END $$;`
  );
  query(fixtureSql());
  query(
    "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres SUPERUSER; END IF; END $$; ALTER FUNCTION public.fn_ca_engine_operator_command(uuid,uuid,text,text,text) OWNER TO postgres;"
  );
  query(
    "ALTER TABLE tables ADD COLUMN game_type text DEFAULT 'cash', ADD COLUMN is_deleted boolean DEFAULT false;"
  );
  console.log(
    query(
      "SELECT md5(pg_get_functiondef('public.fn_ca_engine_operator_command(uuid,uuid,text,text,text)'::regprocedure)) AS original_digest;"
    )
  );
  const behavior = fs.readFileSync(
    path.join(root, 'scripts/qualification/stable-admin-close-selector/behavior.sql'),
    'utf8'
  );
  console.log(query(behavior.replaceAll('EXPECT_REFUSAL', 'false')));
  query(
    fs.readFileSync(
      path.join(root, 'supabase/migrations/20261010131117_close_cash_targets_are_executable.sql'),
      'utf8'
    )
  );
  console.log(query(behavior.replaceAll('EXPECT_REFUSAL', 'true')));
  console.log(
    query(
      "SELECT floor_assert((SELECT prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[] FROM pg_proc WHERE oid='public.fn_ca_engine_operator_command(uuid,uuid,text,text,text)'::regprocedure) AND NOT has_function_privilege('authenticated','public.fn_ca_engine_operator_command(uuid,uuid,text,text,text)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_ca_engine_operator_command(uuid,uuid,text,text,text)','EXECUTE') AND has_function_privilege('service_role','public.fn_ca_engine_operator_command(uuid,uuid,text,text,text)','EXECUTE'),'original owner security preserved');"
    )
  );
  // An uncommitted deleted-target update must serialize with capture, then
  // refuse atomically after its actual row version becomes visible.
  const child = spawn(path.join(pg, 'psql'), args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '',
    error = '';
  child.stdout.on('data', (b) => (output += b));
  child.stderr.on('data', (b) => (error += b));
  const exited = new Promise((resolve, reject) =>
    child.once('exit', (code) => (code === 0 ? resolve() : reject(Error(error))))
  );
  child.stdin.end(
    "BEGIN; UPDATE tables SET is_deleted=true WHERE id='30000000-0000-4000-8000-000000000002'; SELECT 'TARGET_LOCKED'; SELECT pg_sleep(2); COMMIT;"
  );
  const deadline = Date.now() + 10000;
  while (!output.includes('TARGET_LOCKED')) {
    if (Date.now() > deadline) throw Error('target lock not acquired');
    await new Promise((r) => setTimeout(r, 20));
  }
  const at = Date.now();
  query(
    "SET request.jwt.claim.role='service_role'; DO $$ BEGIN BEGIN PERFORM fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000090','floor','close_cash','Concurrent changed target refusal'); RAISE EXCEPTION 'invalid target admitted'; EXCEPTION WHEN SQLSTATE '22023' THEN IF SQLERRM<>'cash_floor_close_target_not_executable' THEN RAISE; END IF; END; END $$;"
  );
  if (Date.now() - at < 1000) throw Error('command did not wait original target row lock');
  await exited;
  query(
    "SELECT floor_assert(NOT EXISTS(SELECT 1 FROM ca_engine_operator_commands) AND NOT EXISTS(SELECT 1 FROM ca_operator_table_closes) AND (SELECT count(*)=2 AND sum(stack)=55.50 FROM table_seats WHERE left_at IS NULL) AND (SELECT balance=30 AND state='active' FROM poker_diamond_custody),'concurrent refusal preserves all original custody'); UPDATE tables SET is_deleted=false;"
  );
  console.log('CLOSE_SELECTOR_NATIVE_RACE_PASS');
  const rollback = fs.readFileSync(
    path.join(root, 'scripts/qualification/stable-admin-close-selector/rollback.sql'),
    'utf8'
  );
  const migration = fs.readFileSync(
    path.join(root, 'supabase/migrations/20261010131117_close_cash_targets_are_executable.sql'),
    'utf8'
  );
  if (
    !migration.includes(
      rollback
        .split('\n')
        .filter(Boolean)
        .map((line) => '-- ' + line)
        .join('\n')
    )
  )
    throw Error('embedded rollback differs');
  query(rollback);
  console.log(query(behavior.replaceAll('EXPECT_REFUSAL', 'false')));
  query(
    'ALTER FUNCTION public.fn_ca_engine_operator_command(uuid,uuid,text,text,text) OWNER TO service_role;'
  );
  let ownerRefused = false;
  try {
    query(migration);
  } catch (error) {
    if (!error.message.includes('close_cash_owner_security_changed')) throw error;
    ownerRefused = true;
  }
  if (!ownerRefused) throw Error('migration accepted function-owner drift');
  query(
    'ALTER FUNCTION public.fn_ca_engine_operator_command(uuid,uuid,text,text,text) OWNER TO postgres; GRANT EXECUTE ON FUNCTION public.fn_ca_engine_operator_command(uuid,uuid,text,text,text) TO service_role;'
  );
  query(migration);
  console.log(query(behavior.replaceAll('EXPECT_REFUSAL', 'true')));
  console.log(
    query(
      "SELECT md5(pg_get_functiondef('public.fn_ca_engine_operator_command(uuid,uuid,text,text,text)'::regprocedure)) AS qualified_postimage;"
    )
  );
  console.log(
    query(
      fs.readFileSync(
        path.join(caRoot, 'scripts/qualification/stable-admin-floor/behavior.sql'),
        'utf8'
      )
    )
  );
  console.log('CLOSE_SELECTOR_ORIGINAL_FINANCIAL_BEHAVIOR_PASS');
  console.log('CLOSE_SELECTOR_NATIVE_PASS');
} finally {
  if (started) run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'immediate', '-w', 'stop']);
  fs.rmSync(dir, { recursive: true, force: true });
}
