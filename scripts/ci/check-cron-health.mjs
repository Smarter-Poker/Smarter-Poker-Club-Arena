#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SOMETHING HAS TO READ cron.job_run_details
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-08-31)
 *
 * sp_upcoming_tournament_pushes ran every minute and FAILED 4,017 CONSECUTIVE
 * TIMES over nearly three days. It joins public.user_presence, a table that
 * does not exist. It sends the "your tournament starts in 15 minutes"
 * reminders, so for three days nobody was reminded of anything.
 *
 * Every one of those 4,017 failures was sitting in cron.job_run_details. The
 * platform simply had nothing that reads it.
 *
 * There WAS a watcher - v_system_health_cron - and its filter was
 *
 *     WHERE jobname LIKE 'home%' OR 'pnm%' OR 'flag-garbage%'
 *
 * three name prefixes out of 75 active jobs. Every scheduled thing built since
 * that view was written lived outside it. The view is widened in
 * 20260831193608; this is the half that makes somebody look.
 *
 * VERDICTS, from fn_ca_cron_health:
 *   critical  ran and NEVER ONCE SUCCEEDED - broken, not flaky
 *   warn      failed at least once but also succeeded
 *   ok        ran, never failed
 *   idle      active but no runs in the window (normal for a weekly job)
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/ci/check-cron-health.mjs [--window '24 hours'] [--warn-fails] [--json]
 *
 * Exit: 0 no criticals · 1 a job never succeeded · 2 script error
 */
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

const args = process.argv.slice(2);
const AS_JSON = args.includes('--json');
const FAIL_ON_WARN = args.includes('--warn-fails');

function argValue(name, dflt) {
  const i = args.indexOf(name);
  return i === -1 || !args[i + 1] ? dflt : args[i + 1];
}

const WINDOW = argValue('--window', '24 hours');
const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_BASE || !KEY) {
  console.error('check-cron-health: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

async function cronHealth() {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/fn_ca_cron_health`, {
    method: 'POST',
    headers: supabaseServerHeaders(KEY, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ p_window: WINDOW }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `fn_ca_cron_health returned ${res.status}. If it is missing, apply ` +
        `20260831193608_nothing_was_watching_the_scheduled_work. ${body.slice(0, 300)}`
    );
  }
  return res.json();
}

function line(j) {
  return `  ${j.verdict.toUpperCase().padEnd(8)} ${String(j.jobname).padEnd(38)} ${String(j.failures).padStart(5)} failed / ${String(j.runs).padStart(5)} runs   ${j.schedule}`;
}

async function main() {
  const jobs = await cronHealth();
  const critical = jobs.filter((j) => j.verdict === 'critical');
  const warn = jobs.filter((j) => j.verdict === 'warn');
  const idle = jobs.filter((j) => j.verdict === 'idle');
  const ok = jobs.filter((j) => j.verdict === 'ok');

  if (AS_JSON) {
    console.log(JSON.stringify({ window: WINDOW, jobs }, null, 1));
  } else {
    console.log('');
    console.log(
      `[cron-health] ${jobs.length} active job(s) over ${WINDOW}: ` +
        `${ok.length} ok · ${warn.length} warn · ${critical.length} critical · ${idle.length} idle`
    );
    console.log('');
    if (critical.length) {
      console.log('  RAN AND NEVER SUCCEEDED - these are broken, not flaky:');
      for (const j of critical) {
        console.log(line(j));
        if (j.last_error) console.log(`           ${String(j.last_error).split('\n')[0]}`);
      }
      console.log('');
    }
    if (warn.length) {
      console.log('  Failed at least once:');
      for (const j of warn) console.log(line(j));
      console.log('');
    }
    if (idle.length) {
      // Said out loud rather than dropped: "no runs" and "no failures" look
      // identical in a count, and only one of them is fine.
      console.log(`  Idle (no runs in the window): ${idle.map((j) => j.jobname).join(', ')}`);
      console.log('');
    }
  }

  if (critical.length > 0) process.exit(1);
  if (FAIL_ON_WARN && warn.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('check-cron-health failed:', err.message);
  process.exit(2);
});
