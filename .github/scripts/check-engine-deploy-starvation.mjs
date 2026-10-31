/**
 * IS THE ENGINE PIPELINE STARVING?
 *
 * `audit-engine-provenance.sh` already answers "is production running main".
 * It answers it as a BOOLEAN, and it has been answering "no" continuously
 * since 2026-09-11 00:25 - issue #4219 has been open the whole time. A
 * condition that is always true is a condition nobody reads, so when
 * production went from one release behind to FOURTEEN releases and four and a
 * half hours behind on 2026-09-12, nothing anywhere changed state. There was
 * no new signal to notice.
 *
 * This asks the different question: is the pipeline getting WORSE, and is the
 * pipeline itself the reason. It reads the append-only ledger that the release
 * receipt writes (`ca_engine_deploy_attempts`) and nothing else. It has no
 * dispatch, retry, repair, or mutation authority of any kind.
 *
 * THE THRESHOLD, AND THE MEASUREMENT IT CAME FROM (CLAUDE.md 10.84).
 *
 * The historical measurement below used hourly engine breaks. The current
 * engine schedule is daily at 04:00 America/Chicago (CLAUDE.md 13). This
 * read-only observer retains the measured count/time thresholds; it grants
 * no release, retry, emergency or maintenance authority. The historical
 * accepted latency was about two hourly breaks
 * (docs/changelog/2026-09-10-every-engine-merge-starts-its-own-train.md:
 * "Worst-case latency is about two breaks"). Beyond that it is not latency,
 * it is starvation.
 *
 * Measured against the complete ledger on 2026-09-12
 * (2026-09-01 14:58Z to 2026-09-12 05:00Z, 94 episodes of consecutive
 * non-shipping attempts):
 *
 *   episodes with >= 3 attempts .................. 28
 *   episodes spanning >= 120 minutes ............. 15
 *   episodes meeting BOTH (this rule fires) ...... 15   (1.4 per day)
 *   episodes with >= 3 attempts, under 120 min ... 13   (deliberately silent:
 *                                                       these self-resolved
 *                                                       inside two breaks)
 *   worst episode ................................ 30 attempts / 739.4 minutes
 *
 * Requiring BOTH conditions is the whole design. Attempts alone pages on a
 * normal merge burst - five engine merges in twenty minutes is a Tuesday, and
 * four of them being superseded is the queue working correctly. Time alone
 * pages on a quiet weekend when nobody merged anything. Together they mean
 * exactly "commits are being offered to production and production is not
 * taking them", which is the only version of this that is an incident.
 */
import process from 'node:process';

export const ATTEMPTS_THRESHOLD = 3;
export const SPAN_MINUTES_THRESHOLD = 120;

/** A stand-down is the release lane refusing code that was never the problem. */
const STOOD_DOWN = /stood down before cutover|is stale; protected main requires/i;
const BEFORE_INTAKE = /release refused before host intake|deployment job did not run/i;
const SEALED_WITHOUT_PROOF =
  /the release sealed but production identity could not be independently proved/i;

/**
 * The whole decision, as a pure function, so it can be proved against real
 * measured episodes without a database. `rows` are the unshipped attempts
 * since the last shipped one, oldest first.
 */
export function assess({ rows, lastShipped, now = Date.now() }) {
  if (!rows.length) {
    return { starving: false, attempts: 0, spanMinutes: 0, supersededCount: 0, lastShipped };
  }
  const spanMinutes = Math.round(((now - new Date(rows[0].at).getTime()) / 60000) * 10) / 10;
  const attempts = rows.length;
  const supersededCount = rows.filter((r) => STOOD_DOWN.test(r.reason || '')).length;
  const beforeIntakeCount = rows.filter((r) => BEFORE_INTAKE.test(r.reason || '')).length;
  const sealedWithoutProofCount = rows.filter((r) =>
    SEALED_WITHOUT_PROOF.test(r.reason || '')
  ).length;
  const starving = attempts >= ATTEMPTS_THRESHOLD && spanMinutes >= SPAN_MINUTES_THRESHOLD;
  // When most of the backlog stood down, the code being offered was never the
  // problem and re-pushing it will not help. Say so, because the instinct is
  // to go looking at the engine - which is where four and a half hours went
  // on 2026-09-12.
  const verdict = !starving
    ? `Within the accepted envelope (fires at >= ${ATTEMPTS_THRESHOLD} attempts AND >= ${SPAN_MINUTES_THRESHOLD} minutes).`
    : supersededCount * 2 >= attempts
      ? `THE PIPELINE IS THE PROBLEM, NOT THE CODE: ${supersededCount} of ${attempts} attempts stood down before cutover because protected main had moved.`
      : beforeIntakeCount > 0
        ? `${beforeIntakeCount} of ${attempts} attempts stopped before host intake; inspect their production prerequisites and the remaining recorded outcomes before re-pushing.`
        : sealedWithoutProofCount === attempts
          ? 'The release transactions sealed, but production identity is unproved; read the reasons above before retrying.'
          : 'No release is independently proved shipped; inspect the recorded outcomes before inferring activation or retrying.';
  return { starving, attempts, spanMinutes, supersededCount, verdict, lastShipped };
}

/**
 * "I could not tell" is a THIRD outcome and must never render as green.
 * AGENT-PLAYBOOK section 8: a fallback that cannot answer must say so.
 */
function unknown(message) {
  console.log(`::warning title=ENGINE DEPLOY STARVATION UNKNOWN::${message}`);
  process.exit(0);
}

/* c8 ignore start - the transport half; the decision above is what is tested */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) unknown('DATABASE_URL is not configured, so the deploy ledger could not be read.');

  let Client;
  try {
    ({ Client } = await import('pg'));
  } catch {
    unknown('the pg module is unavailable on this runner.');
  }

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 15000,
    statement_timeout: 20000,
  });

  let rows;
  let lastShipped;
  try {
    await client.connect();
    // Everything since the last release that actually reached production.
    const result = await client.query(`
      SELECT at, target_sha, reason
        FROM public.ca_engine_deploy_attempts
       WHERE shipped = false
         AND at > COALESCE(
               (SELECT max(at) FROM public.ca_engine_deploy_attempts WHERE shipped),
               '-infinity'::timestamptz)
       ORDER BY at
    `);
    rows = result.rows;
    const shippedResult = await client.query(
      'SELECT max(at) AS at FROM public.ca_engine_deploy_attempts WHERE shipped'
    );
    lastShipped = shippedResult.rows[0]?.at ?? null;
  } catch (err) {
    unknown(`the deploy ledger could not be read: ${err?.message || err}`);
  } finally {
    await client.end().catch(() => {});
  }

  const verdict = assess({ rows, lastShipped });
  if (!rows.length) {
    console.log(
      'Engine deploy pipeline is not starving: the most recent attempt shipped' +
        (lastShipped ? ` (${new Date(lastShipped).toISOString()}).` : '.')
    );
    process.exit(0);
  }

  const reasonCounts = new Map();
  for (const r of rows) {
    const key = (r.reason || '(no reason recorded)').slice(0, 120);
    reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
  }

  const detail =
    `${verdict.attempts} consecutive engine release attempts have shipped nothing over ` +
    `${verdict.spanMinutes} minutes. Last shipped: ` +
    `${lastShipped ? new Date(lastShipped).toISOString() : 'never'}. ` +
    `Oldest unshipped commit offered: ${String(rows[0].target_sha).slice(0, 12)}.`;

  console.log(detail);
  console.log('  Reasons recorded by the pipeline itself:');
  for (const [reason, n] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)} x ${reason}`);
  }

  if (!verdict.starving) {
    console.log(verdict.verdict);
    process.exit(0);
  }
  console.log(`::error title=ENGINE DEPLOY STARVATION::${detail} ${verdict.verdict}`);
  process.exit(1);
}
/* c8 ignore stop */

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
