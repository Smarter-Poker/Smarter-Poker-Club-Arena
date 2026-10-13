// Native fixture only: never connects to a network/database credential store.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  qualifyRakeReportHistory,
  RAKE_REPORT_MIGRATION,
} from '../ci/rake-report-history-baseline.mjs';

const socket = process.env.RAKE_FIXTURE_SOCKET;
const port = process.env.RAKE_FIXTURE_PORT;
if (!socket || resolve(socket) !== socket || !basename(dirname(socket)).startsWith('rake-agent-report.') ||
    !/^[0-9]{4,5}$/.test(port ?? '')) {
  throw new Error('Only the owned native rake fixture socket is allowed');
}
// The accounting job already installs the server lockfile closure. Local
// client checks install the root closure. Require the selected owner's exact
// locked driver, never an ambient module or another checkout's dependencies.
let pg;
for (const owner of ['../../', '../../server/']) {
  const ownerRoot = fileURLToPath(new URL(owner, import.meta.url));
  const require = createRequire(new URL(owner + 'package.json', import.meta.url));
  let packagePath;
  try { packagePath = require.resolve('pg/package.json'); }
  catch (error) { if (error.code === 'MODULE_NOT_FOUND') continue; throw error; }
  const installed = JSON.parse(readFileSync(packagePath, 'utf8'));
  const locked = JSON.parse(readFileSync(new URL(owner + 'package-lock.json', import.meta.url), 'utf8'));
  if (!realpathSync(packagePath).startsWith(resolve(ownerRoot, 'node_modules') + '/') ||
      installed.version !== locked.packages['node_modules/pg']?.version)
    throw new Error('Native report fixture PostgreSQL driver is not owned and locked');
  pg = require('pg');
  console.log(`Native report fixture locked PostgreSQL driver ${installed.version}`);
  break;
}
if (!pg) throw new Error('Native report fixture requires the existing locked PostgreSQL driver');
const client = new pg.Client({ host: socket, port: Number(port), user: 'postgres', database: 'postgres' });
const sql = readFileSync(`supabase/migrations/${RAKE_REPORT_MIGRATION}`, 'utf8');
await client.connect();
try {
  await client.query(`
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);
    CREATE TABLE public.clubs(id uuid PRIMARY KEY);
    INSERT INTO public.clubs SELECT DISTINCT club_id FROM public.agent_commissions WHERE club_id IS NOT NULL;
    UPDATE smarter_private.agent_commission_report_days SET complete=false WHERE day=current_date-2;
  `);
  await client.query('INSERT INTO supabase_migrations.schema_migrations VALUES($1,$2,ARRAY[$3::text])',
    [RAKE_REPORT_MIGRATION.slice(0,14), RAKE_REPORT_MIGRATION.slice(15,-4), sql]);
  const journalHash = async () => (await client.query(
    "SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY a.id)::text) AS hash FROM public.agent_commissions a"
  )).rows[0].hash;
  const before = await journalHash();
  await client.query('SET jit=on');
  const dryLogs = [];
  await qualifyRakeReportHistory(client, sql, true, (line) => dryLogs.push(line));
  if ((await client.query('SHOW jit')).rows[0].jit !== 'off')
    throw new Error('finite report plan kept unnecessary JIT enabled');
  if (!dryLogs.some((line) => /[1-9][0-9]* unqualified closed club-days/.test(line)))
    throw new Error('native qualification fixture did not exercise a real unqualified day');
  const logs = [];
  await qualifyRakeReportHistory(client, sql, false, (line) => logs.push(line));
  if (!logs.some((line) => line.includes('QUALIFIED club=')))
    throw new Error('native report day was not committed and read back');
  if (before !== await journalHash()) throw new Error('qualification changed the original journal');
  const replay = [];
  await qualifyRakeReportHistory(client, sql, false, (line) => replay.push(line));
  if (!replay.some((line) => line.includes('0 unqualified closed club-days')) ||
      replay.some((line) => line.includes('sending once')))
    throw new Error('already-qualified installation repeated a day write');
  console.log('RAKE_REPORT_INSTALLATION_NATIVE_PASS dry plan, separate day writes, durable markers, unchanged journal, replay noop');
} finally {
  await client.end();
}
