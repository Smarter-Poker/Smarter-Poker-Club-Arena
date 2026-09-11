/**
 * Tell the database what this deploy run actually did.
 *
 * Each release run writes one append-only receipt for later audit and incident
 * review. Live release identity is proved directly by the deployment workflow;
 * this recorder does not dispatch, reconcile, poll, or mutate a release.
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
const strictReceipt = process.env.STRICT_RECEIPT === '1';

function warn(message) {
  if (strictReceipt) {
    console.error(`::error title=DEPLOY TRUTH NOT RECORDED::${message}`);
    process.exit(1);
  }
  console.log(`::warning title=DEPLOY TRUTH NOT RECORDED::${message}`);
  process.exit(0);
}

if (!url) warn('DATABASE_URL is not configured; the append-only release receipt was not recorded.');
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
  const receiptId = rows[0]?.id;
  if (receiptId === undefined || receiptId === null || String(receiptId).trim() === '') {
    warn('the append-only receipt function returned no receipt id.');
  }
  console.log(
    `deploy truth recorded: attempt ${receiptId} target=${targetSha.slice(0, 8)} shipped=${shipped}` +
      (reason ? ` reason=${reason}` : '')
  );
} catch (err) {
  warn(`${err?.message || err}`);
} finally {
  await client.end().catch(() => {});
}
