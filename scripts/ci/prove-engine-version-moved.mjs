#!/usr/bin/env node
/**
 * A DEPLOY THAT PROVES ITSELF (2026-09-05).
 *
 * On 2026-09-04/05 a deploy run reported success and shipped nothing: the
 * container came back on the OLD image and /health.version did not change.
 * Every check the workflow has asks the engine over HTTP for a version and
 * compares it with the target; none of them asked what the engine WROTE
 * about itself, and none compared against what was running BEFORE.
 *
 * Two modes, one file, so the two halves cannot drift:
 *
 *   MODE=record  At the START of the job. Reads the version production is
 *                running right now and appends PRE_CUTOVER_VERSION and
 *                PRE_CUTOVER_SOURCE to $GITHUB_ENV. Never fails the job.
 *
 *   MODE=prove   After the cutover and the promote. Polls for up to
 *                TIMEOUT_S (240) until the running version equals TARGET_SHA's
 *                short form. FAILS THE JOB (exit 1) when the poll runs out and
 *                the version still equals PRE_CUTOVER_VERSION, or names some
 *                third build. Raises an in-app notification the way
 *                publish-watchdog.sh does when the credentials are present.
 *
 * THE WITNESS IS THE DATABASE FIRST. public.engine_leader.engine_version is
 * written by the running leader itself (claim_engine_leadership, renewed every
 * 10 s from INSTANCE_VERSION = GIT_COMMIT_SHA[0:8]). It cannot be served by a
 * proxy, a cache or an unmanaged twin answering the hostname. It is read over
 * DATABASE_URL (pg, the same route record-engine-deploy-attempt.mjs uses) or,
 * failing that, over Supabase REST with the service role. /health.version with
 * a cache-buster is the fallback witness, and the report says which one spoke.
 *
 * UNREADABLE IS NOT "BEHIND". If no witness can be read at all, prove exits 0
 * with a warning: the verify step before this one has already read /health
 * successfully, and the watchdog's rule holds here too - guessing from silence
 * would roll back a build that is fine.
 */
import process from 'node:process';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

const MODE = (process.env.MODE || 'prove').trim();
const ENGINE_URL = (process.env.ENGINE_URL || 'https://engine.smarter.poker').replace(/\/$/, '');
const DATABASE_URL = process.env.DATABASE_URL || '';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TARGET = (process.env.TARGET_SHA || '').trim().slice(0, 8);
const PRE = (process.env.PRE_CUTOVER_VERSION || '').trim();
const PRE_SOURCE = (process.env.PRE_CUTOVER_SOURCE || 'unknown').trim();
const TIMEOUT_S = Number(process.env.TIMEOUT_S || 240);
const POLL_S = Number(process.env.POLL_S || 10);
const RUN_URL = process.env.RUN_URL || '';

const say = (m) => console.log(m);
const summary = (m) => {
  if (process.env.GITHUB_STEP_SUMMARY) {
    import('node:fs').then((fs) => fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, m + '\n'));
  }
};

/** engine_leader over pg. { version, heartbeatAgeS } or null when unreadable. */
async function readLeaderPg() {
  if (!DATABASE_URL) return null;
  let Client;
  try {
    ({ Client } = await import('pg'));
  } catch {
    return null;
  }
  const client = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 15000,
    statement_timeout: 15000,
  });
  try {
    await client.connect();
    const { rows } = await client.query(
      'SELECT engine_version, EXTRACT(EPOCH FROM (now() - heartbeat_at))::int AS age FROM public.engine_leader WHERE id = true'
    );
    if (!rows[0]) return { version: '', heartbeatAgeS: null, empty: true };
    return { version: String(rows[0].engine_version || ''), heartbeatAgeS: Number(rows[0].age) };
  } catch (err) {
    say(`  engine_leader via pg unreadable: ${err?.message || err}`);
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

/** engine_leader over Supabase REST (service role bypasses RLS). */
async function readLeaderRest() {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/engine_leader?select=engine_version,heartbeat_at&id=eq.true`,
      {
        headers: supabaseServerHeaders(SERVICE_KEY),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows[0]) return { version: '', heartbeatAgeS: null, empty: true };
    const age = Math.round((Date.now() - new Date(rows[0].heartbeat_at).getTime()) / 1000);
    return { version: String(rows[0].engine_version || ''), heartbeatAgeS: age };
  } catch (err) {
    say(`  engine_leader via REST unreadable: ${err?.message || err}`);
    return null;
  }
}

/** /health.version with a cache-buster and no-cache headers. */
async function readHealth() {
  try {
    const res = await fetch(`${ENGINE_URL}/health?nocache=${Date.now()}`, {
      headers: { 'cache-control': 'no-cache, no-store', pragma: 'no-cache' },
      signal: AbortSignal.timeout(15000),
    });
    // A standby answers 503 with the same body; the version is still real.
    const body = await res.json();
    return typeof body?.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

/** One reading from the best available witness. */
async function readOnce() {
  const leader = (await readLeaderPg()) ?? (await readLeaderRest());
  if (leader && !leader.empty && leader.version) {
    return { version: leader.version, source: 'engine_leader', heartbeatAgeS: leader.heartbeatAgeS };
  }
  const health = await readHealth();
  if (health) return { version: health, source: '/health', heartbeatAgeS: null };
  return null;
}

async function notifyInApp(message) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    say('  no Supabase credentials in this run - skipping the in-app escalation.');
    return;
  }
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/ca_incident_recipients?scope=eq.platform&active=eq.true&select=user_id`,
      {
        headers: supabaseServerHeaders(SERVICE_KEY),
        signal: AbortSignal.timeout(20000),
      }
    );
    const rows = res.ok ? await res.json() : [];
    const recipients = [...new Set((rows || []).map((r) => r.user_id).filter(Boolean))];
    if (recipients.length === 0) {
      say('  no active platform recipients - in-app escalation has nobody to reach.');
      return;
    }
    let sent = 0;
    for (const user of recipients) {
      // Title Case, no em dashes: house popup rules (CLAUDE.md 5.7).
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/fn_raise_notification`, {
        method: 'POST',
        headers: supabaseServerHeaders(SERVICE_KEY, {
          'content-type': 'application/json',
        }),
        body: JSON.stringify({
          p_user_id: user,
          p_type: 'deploy_shipped_nothing',
          p_title: 'Engine Deploy Shipped Nothing',
          p_message: message,
          p_link: '/hub/club-arena/',
          p_data: { source: 'prove-engine-version-moved.mjs', run: RUN_URL },
        }),
        signal: AbortSignal.timeout(20000),
      }).catch(() => null);
      if (r && r.ok) sent++;
    }
    say(`  in-app escalation delivered to ${sent} recipient(s).`);
  } catch (err) {
    say(`  in-app escalation failed: ${err?.message || err}`);
  }
}

async function record() {
  const reading = await readOnce();
  const version = reading?.version || '';
  const source = reading?.source || 'unreadable';
  say(`pre-cutover engine version: ${version || '<unreadable>'} (witness: ${source})`);
  if (process.env.GITHUB_ENV) {
    const fs = await import('node:fs');
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `PRE_CUTOVER_VERSION=${version}\nPRE_CUTOVER_SOURCE=${source}\n`
    );
  }
  if (!version) say('::warning::could not read the pre-cutover version; the proof will still require the target.');
  process.exit(0);
}

async function prove() {
  if (!TARGET) {
    say('::error::TARGET_SHA is required to prove a deploy.');
    process.exit(1);
  }
  say(`proving the engine moved: target ${TARGET}, was ${PRE || '<unknown>'} (${PRE_SOURCE}), budget ${TIMEOUT_S}s`);
  const deadline = Date.now() + TIMEOUT_S * 1000;
  let last = null;
  let attempt = 0;
  for (;;) {
    attempt++;
    const r = await readOnce();
    if (r) {
      last = r;
      const hb = r.heartbeatAgeS === null ? '' : `, heartbeat ${r.heartbeatAgeS}s ago`;
      say(`attempt ${attempt}: ${r.source} says ${r.version}${hb} (want ${TARGET})`);
      // The leader row must be FRESH: a stale row with the right version is
      // an old heartbeat, not proof. 60 s is six renew intervals.
      const fresh = r.heartbeatAgeS === null || r.heartbeatAgeS <= 60;
      if (r.version === TARGET && fresh) {
        say(`PROVED: ${r.source} reports ${TARGET}${PRE ? `, moved from ${PRE}` : ''}.`);
        summary(`### Deploy proved\n\n\`${r.source}\` reports \`${TARGET}\`${PRE ? ` (was \`${PRE}\`)` : ''} after ${attempt} attempt(s).`);
        process.exit(0);
      }
    } else {
      say(`attempt ${attempt}: no witness readable`);
    }
    if (Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, POLL_S * 1000));
  }

  if (!last) {
    say(`::warning title=DEPLOY PROOF INCONCLUSIVE::Neither engine_leader nor ${ENGINE_URL}/health could be read for ${TIMEOUT_S}s. Not treating silence as a failed deploy; the verify step already saw ${TARGET} in the container.`);
    summary(`### Deploy proof inconclusive\n\nNo witness answered for ${TIMEOUT_S}s. Not treated as a failure.`);
    process.exit(0);
  }

  const unchanged = PRE && last.version === PRE;
  const message = unchanged
    ? `The Engine Deploy Of ${TARGET} Reported A Successful Cutover But ${last.source} Still Reports ${PRE} After ${TIMEOUT_S} Seconds. Production Is Running The Old Build.`
    : `The Engine Deploy Of ${TARGET} Finished But ${last.source} Reports ${last.version}, Which Is Neither The Target Nor The Pre Cutover ${PRE || 'Version'}. Something Else Is Running.`;
  say(
    `::error title=DEPLOY SHIPPED NOTHING::${last.source} reports ${last.version} after ${TIMEOUT_S}s; target ${TARGET}, pre-cutover ${PRE || '<unknown>'}. ${unchanged ? 'The version did not move: the container came back on the old build.' : 'A third build is answering.'}`
  );
  summary(
    `### DEPLOY SHIPPED NOTHING\n\n| | |\n| --- | --- |\n| target | \`${TARGET}\` |\n| pre-cutover (${PRE_SOURCE}) | \`${PRE || 'unknown'}\` |\n| after ${TIMEOUT_S}s (${last.source}) | \`${last.version}\` |\n\nThe cutover reported success but the engine's own witness never moved. This step fails the job so the run is RED, not a green tick over a stale build.`
  );
  await notifyInApp(message);
  process.exit(1);
}

if (MODE === 'record') await record();
else await prove();
