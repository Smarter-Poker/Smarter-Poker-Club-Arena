import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fixtureSql, root } from './qualification/stable-admin-floor/fixture.mjs';
const base = process.env.TMPDIR;
if (!base || (!base.startsWith('/Volumes/SmarterWork/agent-work/') && !process.env.CI))
  throw Error('Owned SSD TMPDIR required locally');
const pg = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const dir = fs.mkdtempSync(path.join(base, 'lightning-rejoin-'));
const port = String(45000 + Math.floor(Math.random() * 15000));
const db = `qual_lightning_rejoin_${randomUUID().replaceAll('-', '')}`;
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
  if (result.status !== 0) throw Error(`${bin} failed: ${result.stderr || result.stdout}`);
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
    fs.readFileSync(path.join(root, 'scripts/qualification/lightning-rejoin/schema.sql'), 'utf8')
  );
  query(
    fs.readFileSync(
      path.join(root, 'scripts/qualification/lightning-rejoin/installed-pool-owners.sql'),
      'utf8'
    )
  );
  const { original } = await import('./qualification/stable-admin-floor/fixture.mjs');
  query(
    original(
      'supabase/migrations/20261026212123_lucky_owner_requested_account_balance.sql',
      'fn_lightning_rejoin_seated'
    )
  );
  console.log(
    query(
      fs.readFileSync(
        path.join(root, 'scripts/qualification/lightning-rejoin/behavior.sql'),
        'utf8'
      )
    )
  );
} finally {
  if (started) run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'immediate', '-w', 'stop']);
  fs.rmSync(dir, { recursive: true, force: true });
}
