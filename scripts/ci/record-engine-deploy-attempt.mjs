/**
 * Tell the database what this deploy run actually did.
 *
 * auto-deploy-hetzner is green whether it ships or skips, and skipping is
 * usually correct: the restart windows exist so a restart never voids a live
 * hand. The cost is that no green tick has ever meant "the engine is running
 * this commit". fn_ca_engine_deploy_truth_watch answers that question from the
 * database, by comparing engine_table_leases.engine_version (what is RUNNING)
 * against the rows this script writes (what was OFFERED).
 *
 * The reason it is written from here rather than read from the GitHub API is
 * the 2026-08-31 night: GitHub Actions stopped starting jobs for this repo
 * entirely, and a watchdog that lives in Actions goes quiet in exactly the
 * incident it exists for. A pipeline that reports in makes SILENCE an alarm.
 *
 * This must never fail a deploy. Every error path exits 0 with a warning.
 */
import process from 'node:process';

const url = process.env.DATABASE_URL;
const targetSha = (process.env.TARGET_SHA || '').trim();
const shipped = process.env.SHIPPED === 'true';
const reason = (process.env.REASON || '').slice(0, 500);
const runId = (process.env.RUN_ID || '').slice(0, 120);
const actor = (process.env.RUN_ACTOR || '').slice(0, 120);

function warn(message) {
  console.log(`::warning title=DEPLOY TRUTH NOT RECORDED::${message}`);
  process.exit(0);
}

if (!url) warn('DATABASE_URL is not configured; the deploy-truth watchdog will read this run as silence.');
if (!targetSha) warn('No target sha to record.');

let Client;
try {
  ({ Client } = await import('pg'));
} catch {
  warn('the pg module is unavailable on this runner.');
}

const client = new Client({ connectionString: url, connectionTimeoutMillis: 15000, statement_timeout: 15000 });
try {
  await client.connect();
  const { rows } = await client.query(
    'SELECT public.fn_ca_record_engine_deploy_attempt($1, $2, $3, $4, $5) AS id',
    [targetSha, shipped, reason || null, runId || null, actor || null]
  );
  console.log(
    `deploy truth recorded: attempt ${rows[0]?.id} target=${targetSha.slice(0, 8)} shipped=${shipped}` +
      (reason ? ` reason=${reason}` : '')
  );
} catch (err) {
  warn(`${err?.message || err}`);
} finally {
  await client.end().catch(() => {});
}
