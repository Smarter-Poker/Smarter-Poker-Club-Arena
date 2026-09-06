/**
 * What has the deploy pipeline actually been DOING?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * engine-watchdog.sh already answers "is the engine behind main" (it opens the
 * staleness issue) and "is the deploy train failing" (it reads run
 * conclusions). Between those two questions there is a hole, and on 2026-09-05
 * the platform sat in it for three days:
 *
 *   the train was GREEN - every run reported success -
 *   and 52 of 98 attempts in 72 hours had shipped NOTHING.
 *
 * A run that skips is often correct: the engine may already be on the commit.
 * So the RATE alone is not a fault, and a rule that alarms on it would cry
 * wolf every quiet hour. What is never correct is the pipeline reporting
 * success while production stays behind - and at that moment the one thing
 * nobody had was the pipeline's own account of WHY, which is sitting in
 * ca_engine_deploy_attempts the whole time.
 *
 * So this does not raise anything. It answers the question, and
 * engine-watchdog.sh pastes the answer into the staleness issue it was already
 * going to open. Two hours of my reading the ledger by hand becomes a table in
 * the issue body, which is where the next person will start.
 *
 * ── OUTPUT CONTRACT ──────────────────────────────────────────────────────────
 * Prints Markdown to stdout and always exits 0. Empty output means "nothing to
 * say" - the caller must treat that as normal, never as an error. A watchdog
 * that fails because its optional evidence is unavailable is worse than one
 * that reports without it.
 */
import process from 'node:process';

const url = process.env.DATABASE_URL;
const LOOKBACK_HOURS = Number(process.env.SHIP_RATE_LOOKBACK_HOURS || 24);

/** Nothing to say beats a broken watchdog. Every failure path is silent. */
function quiet() {
  process.exit(0);
}

if (!url) quiet();

let Client;
try {
  ({ Client } = await import('pg'));
} catch {
  quiet();
}

const client = new Client({
  connectionString: url,
  connectionTimeoutMillis: 15000,
  statement_timeout: 15000,
});

try {
  await client.connect();

  const { rows: totals } = await client.query(
    `SELECT count(*) FILTER (WHERE shipped)     AS shipped,
            count(*) FILTER (WHERE NOT shipped) AS skipped,
            count(*)                            AS total
       FROM public.ca_engine_deploy_attempts
      WHERE at > now() - ($1 || ' hours')::interval`,
    [LOOKBACK_HOURS]
  );

  const { rows: reasons } = await client.query(
    `SELECT coalesce(reason, '(none recorded)') AS reason, count(*) AS n
       FROM public.ca_engine_deploy_attempts
      WHERE at > now() - ($1 || ' hours')::interval
        AND NOT shipped
      GROUP BY 1
      ORDER BY n DESC
      LIMIT 6`,
    [LOOKBACK_HOURS]
  );

  /**
   * A commit OFFERED again and again and never shipped is the sharpest signal
   * in the table: it is the pipeline, not the code, refusing. Staleness alone
   * cannot distinguish "nothing has merged" from "everything that merged was
   * turned away".
   */
  const { rows: stranded } = await client.query(
    `SELECT left(target_sha, 8) AS sha, count(*) AS offers, max(at) AS last_offered
       FROM public.ca_engine_deploy_attempts a
      WHERE a.at > now() - ($1 || ' hours')::interval
        AND NOT a.shipped
        AND NOT EXISTS (
              SELECT 1 FROM public.ca_engine_deploy_attempts s
               WHERE s.target_sha = a.target_sha AND s.shipped)
      GROUP BY 1
     HAVING count(*) >= 2
      ORDER BY offers DESC, last_offered DESC
      LIMIT 5`,
    [LOOKBACK_HOURS]
  );

  const t = totals[0];
  if (!t || Number(t.total) === 0) quiet();

  const out = [];
  out.push(`### What the deploy pipeline says it did (last ${LOOKBACK_HOURS}h)`);
  out.push('');
  out.push(
    `**${t.shipped} of ${t.total} attempts shipped.** ${t.skipped} reported success ` +
      `having deployed nothing. Read from \`ca_engine_deploy_attempts\`, which the ` +
      `pipeline writes itself - a green tick in \`gh run list\` does not mean a deploy.`
  );

  if (reasons.length) {
    out.push('');
    out.push('| reason given for not shipping | runs |');
    out.push('| --- | --- |');
    for (const r of reasons) out.push(`| ${r.reason} | ${r.n} |`);
  }

  if (stranded.length) {
    out.push('');
    out.push(
      'These commits were offered to production and turned away every time, ' +
        'and none of them has ever shipped. When this list is non-empty the ' +
        'pipeline is the problem, not the code:'
    );
    out.push('');
    out.push('| commit | times refused | last offered |');
    out.push('| --- | --- | --- |');
    for (const s of stranded) {
      out.push(`| \`${s.sha}\` | ${s.offers} | ${new Date(s.last_offered).toISOString()} |`);
    }
  }

  console.log(out.join('\n'));
} catch {
  quiet();
} finally {
  await client.end().catch(() => {});
}
