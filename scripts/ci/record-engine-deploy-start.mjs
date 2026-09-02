// Record that an auto-deploy-hetzner run STARTED, before tests run. The DB-side
// dispatcher (fn_ca_deploy_dispatch_tick) reads ca_engine_deploy_runs_started
// at :41 to know a run is already in flight for the coming window and must not
// be duplicated. Best-effort: any failure here exits 0 so a deploy is never
// blocked by bookkeeping. Mirrors record-engine-deploy-attempt.mjs.
import process from 'node:process';

const url = process.env.DATABASE_URL;
const targetSha = (process.env.TARGET_SHA || '').trim();
const runId = (process.env.RUN_ID || '').slice(0, 120);
const actor = (process.env.RUN_ACTOR || '').slice(0, 120);

function done(message) {
  if (message) console.log(`::warning title=DEPLOY START NOT RECORDED::${message}`);
  process.exit(0);
}

if (!url) done('DATABASE_URL is not configured.');
if (!targetSha) done('No target sha to record.');
if (!runId) done('No run id to record.');

let Client;
try {
  ({ Client } = await import('pg'));
} catch {
  done('the pg module is unavailable on this runner.');
}

const client = new Client({ connectionString: url, connectionTimeoutMillis: 15000, statement_timeout: 15000 });
try {
  await client.connect();
  const { rows } = await client.query(
    'SELECT public.fn_ca_record_engine_deploy_start($1, $2, $3) AS started_at',
    [runId, targetSha, actor || null]
  );
  console.log(`deploy start recorded: run ${runId} target=${targetSha.slice(0, 8)} at ${rows[0]?.started_at}`);
} catch (err) {
  done(`${err?.message || err}`);
} finally {
  await client.end().catch(() => {});
}
