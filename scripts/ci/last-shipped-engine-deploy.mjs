/**
 * How long has it been since WE last restarted the engine?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The restart-coalescing gate in auto-deploy-hetzner.yml used to read
 * `/health.uptime`. Uptime answers "when did this process start". The gate is
 * asking "when did the deploy pipeline last bounce production", and those two
 * are only the same number when nothing else ever restarts the engine.
 *
 * Something else does. MEASURED 2026-09-05 on the live box: sp-autoheal
 * restarted the engine five times that day - 16:06, 16:42, 17:49, 18:26 and
 * 19:04 UTC - none of them a deploy and none of them inside the announced :55
 * break. Every one of those reset uptime to zero, and any deploy arriving in
 * the following twenty minutes then read a young engine and coalesced. Run
 * 33981313111 (attempt 134, 17:33:36Z) is the recorded case: "Engine restarted
 * only 900s ago (< 1200s) and is healthy with 289 tables - coalescing", against
 * a commit production was demonstrably not serving.
 *
 * The workflow's own 2026-08-24 note predicted this exact failure ("it restarts
 * for reasons other than deploys - a healthcheck kill, a promoted standby, a
 * crash - and when it does, its uptime is permanently under the threshold") and
 * the bypass it added only covers an UNHEALTHY engine or one with zero tables.
 * A healthy engine that was bounced by its own sidecar is the case that slips
 * through, and it is also the common one.
 *
 * So ask the ledger instead. `ca_engine_deploy_attempts` records every attempt
 * with `shipped`, written by record-engine-deploy-attempt.mjs at the end of
 * every run. The newest `shipped = true` row IS the last time this pipeline
 * restarted production, and nothing that happens on the host can move it.
 *
 * ── OUTPUT CONTRACT ──────────────────────────────────────────────────────────
 * Prints ONE line to stdout, nothing else, and always exits 0:
 *
 *   <integer>   seconds since the last shipped deploy
 *   NEVER       the table has no shipped row at all (fresh database)
 *   ERR         the ledger could not be read
 *
 * NEVER and ERR both mean DO NOT COALESCE, and that is deliberate. Failing
 * closed here means declining to ship, which is the failure this whole change
 * exists to remove; and the downstream protection is not this gate anyway - the
 * break gate still refuses to restart outside an announced :55 window, so the
 * worst case of failing open is one extra restart inside a break players were
 * warned about. Spacing is a courtesy. The break is the law.
 *
 * This must never fail a deploy. Every error path exits 0 with a warning.
 */
import process from 'node:process';

const url = process.env.DATABASE_URL;

function answer(value, warning) {
  if (warning) console.log(`::warning title=DEPLOY SPACING UNREADABLE::${warning}`);
  console.log(value);
  process.exit(0);
}

if (!url) answer('ERR', 'DATABASE_URL is not configured; spacing cannot be read from the deploy ledger.');

let Client;
try {
  ({ Client } = await import('pg'));
} catch {
  answer('ERR', 'the pg module is unavailable on this runner.');
}

const client = new Client({ connectionString: url, connectionTimeoutMillis: 15000, statement_timeout: 15000 });
try {
  await client.connect();
  const { rows } = await client.query(
    `SELECT EXTRACT(EPOCH FROM (now() - max(at)))::bigint AS age_s
       FROM public.ca_engine_deploy_attempts
      WHERE shipped IS TRUE`
  );
  const age = rows[0]?.age_s;
  if (age === null || age === undefined) answer('NEVER');
  answer(String(Math.max(0, Number(age))));
} catch (err) {
  answer('ERR', `${err?.message || err}`);
} finally {
  await client.end().catch(() => {});
}
