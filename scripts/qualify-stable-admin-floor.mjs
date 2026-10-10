import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fixtureSql, root } from './qualification/stable-admin-floor/fixture.mjs';
const base = process.env.TMPDIR;
if (!base || (!base.startsWith('/Volumes/SmarterWork/agent-work/') && !process.env.CI))
  throw Error('Owned SSD TMPDIR required locally');
const pg = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const dir = fs.mkdtempSync(path.join(base, 'floor-native-'));
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
  const behavior = fs.readFileSync(
    path.join(root, 'scripts/qualification/stable-admin-floor/behavior.sql'),
    'utf8'
  );
  console.log(query(behavior));
  // Native admission race: an already admitted seating transaction holds the
  // shared edge. Park must wait its commit; later occupancy must be refused.
  query("DELETE FROM ca_operator_table_closes; UPDATE tables SET status='running';");
  const child = spawn(path.join(pg, 'psql'), args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (b) => {
    output += b;
  });
  child.stdin.end(
    "BEGIN; INSERT INTO table_seats(id,user_id,table_id,stack,occupancy_id,seat_number) VALUES(gen_random_uuid(),'10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001',7,'50000000-0000-4000-8000-000000000008',2); SELECT 'ADMISSION_LOCKED'; SELECT pg_sleep(2); COMMIT;"
  );
  await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (output.includes('ADMISSION_LOCKED')) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - startedAt > 10000) {
        clearInterval(poll);
        reject(Error('admission connection did not acquire lock'));
      }
    }, 20);
  });
  const start = Date.now();
  query(
    "SET request.jwt.claim.role='service_role'; SELECT fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000008','floor','park','Native concurrent admission boundary');"
  );
  if (Date.now() - start < 1000) throw Error('park crossed admitted transaction');
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null)
      return child.exitCode === 0 ? resolve() : reject(Error('admission failed'));
    child.once('exit', (code) => (code === 0 ? resolve() : reject(Error('admission failed'))));
  });
  query(
    "DO $$ BEGIN BEGIN INSERT INTO table_seats(id,user_id,table_id,stack,occupancy_id) VALUES(gen_random_uuid(),'10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001',1,gen_random_uuid()); RAISE EXCEPTION 'park raced admission'; EXCEPTION WHEN object_in_use THEN NULL; END; END $$;"
  );
  console.log('STABLE_ADMIN_FLOOR_NATIVE_CONCURRENCY_PASS');
  // Two original cashout requests race the same native occupancy lock. Both
  // return the same retained receipt; its balance and journals move once.
  const cashout =
    "SET request.jwt.claim.role='service_role'; SET request.jwt.claims='{\"role\":\"service_role\"}'; SELECT fn_cashout_seat_occupancy('10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001',2,'50000000-0000-4000-8000-000000000008','forced');";
  const callers = [0, 1].map(
    () =>
      new Promise((resolve, reject) => {
        const process = spawn(path.join(pg, 'psql'), args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let error = '';
        process.stderr.on('data', (b) => {
          error += b;
        });
        process.stdout.resume();
        process.once('exit', (code) => (code === 0 ? resolve() : reject(Error(error))));
        process.stdin.end(cashout);
      })
  );
  await Promise.all(callers);
  query(
    "SELECT floor_assert((SELECT chip_balance=132.50 FROM club_members) AND (SELECT count(*)=2 AND sum(amount)=32.50 FROM wallet_transactions) AND (SELECT count(*)=3 FROM seat_cashout_receipts),'concurrent original cashout moves money once');"
  );
  console.log('STABLE_ADMIN_FLOOR_NATIVE_CASHOUT_RACE_PASS');
  // Independent connection proves durable applied command after interruption.
  console.log(
    query(
      "SELECT floor_assert((SELECT status='applying' FROM ca_engine_operator_commands WHERE id='70000000-0000-4000-8000-000000000006'),'new connection sees retained application');"
    )
  );
} finally {
  if (started) run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'immediate', '-w', 'stop']);
  fs.rmSync(dir, { recursive: true, force: true });
}
