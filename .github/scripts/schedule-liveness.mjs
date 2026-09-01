#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SCHEDULED WORKFLOW THAT STOPS FIRING SAYS NOTHING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED, 2026-09-01. auto-deploy-hetzner.yml moved to an hourly cron at
 * 13:00 UTC. Between then and 18:52 sixteen scheduled ticks were due and
 * exactly ONE ran, so the engine served a 03:54 image for fourteen and a half
 * hours with five merged pull requests unshipped. Every workflow run in that
 * window was green, because none of them happened.
 *
 * GitHub scheduled workflows are best-effort. They are delayed under load and
 * are sometimes dropped outright, and nothing in the repository noticed:
 * cron-health.yml asks the DATABASE which scheduled work is failing, so it
 * watches the horse jobs and not GitHub Actions cron at all.
 *
 * WHY THIS IS NOT ITSELF A SCHEDULED WORKFLOW. A watchdog that shares a
 * failure domain with the thing it watches is not a watchdog - the repo
 * already says so about publish-watchdog, and it is doubly true here: a cron
 * that alarms about cron cannot alarm when cron is the thing that broke. This
 * runs as a job inside publish-watchdog.yml, on `workflow_run`, which fires
 * whenever anything else finishes. On the day this was written that trigger
 * fired eight or more times while the schedule fired once.
 *
 * WHAT IT DOES. Reads every workflow file that declares a `schedule:`, works
 * out the longest gap its cron should ever leave, asks the API when that
 * workflow last ran with `event=schedule`, and reports the ones that are
 * overdue by a wide margin. The watchlist is derived from the workflow files
 * themselves, so a new scheduled workflow is covered the day it is added and
 * there is no list to keep up to date.
 *
 * IT NEVER FAILS THE JOB. Being overdue is information, and GitHub dropping a
 * tick is common enough that a red X here would be noise within a day. It
 * writes a step summary and a warning; the engine watchdog beside it is what
 * actually repairs the case that matters, by dispatching the deploy itself.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.env.REPO || 'Smarter-Poker/Smarter-Poker-Club-Arena';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const DIR = '.github/workflows';
/** How many missed ticks before it is worth saying out loud. */
const TOLERANCE = Number(process.env.SCHEDULE_TOLERANCE || 3);

const say = (m) => console.log(m);
const summary = [];

/**
 * The longest gap a cron expression should ever leave, in minutes.
 *
 * Deliberately crude: only the minute and hour fields, and only the shapes
 * that actually appear in this repo (lists, steps, wildcards). Anything it
 * cannot read returns null and is skipped rather than guessed at - a wrong
 * expectation would produce a false alarm, which is what this is trying to
 * remove from the world.
 */
export function maxGapMinutes(cron) {
  const parts = String(cron).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;

  // Anything narrowing the day is a schedule this cannot reason about simply.
  if (dom !== '*' || mon !== '*' || dow !== '*') return null;

  const expand = (field, max) => {
    if (field === '*') return Array.from({ length: max }, (_, i) => i);
    const out = new Set();
    for (const piece of field.split(',')) {
      const step = /^\*\/(\d+)$/.exec(piece);
      if (step) {
        for (let i = 0; i < max; i += Number(step[1])) out.add(i);
        continue;
      }
      if (/^\d+$/.test(piece)) {
        out.add(Number(piece));
        continue;
      }
      return null; // ranges and other shapes: not read here
    }
    return [...out].sort((a, b) => a - b);
  };

  const mins = expand(min, 60);
  const hours = expand(hour, 24);
  if (!mins || !hours || mins.length === 0 || hours.length === 0) return null;

  // Every firing instant in a day, then the widest hole between them.
  const instants = [];
  for (const h of hours) for (const m of mins) instants.push(h * 60 + m);
  instants.sort((a, b) => a - b);
  let worst = 0;
  for (let i = 1; i < instants.length; i++) worst = Math.max(worst, instants[i] - instants[i - 1]);
  // The wrap from the last firing of one day to the first of the next.
  worst = Math.max(worst, 1440 - instants[instants.length - 1] + instants[0]);
  return worst;
}

function scheduledWorkflows() {
  const out = [];
  for (const file of readdirSync(DIR)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const text = readFileSync(join(DIR, file), 'utf8');
    const crons = [...text.matchAll(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    if (crons.length === 0) continue;
    const gaps = crons.map(maxGapMinutes).filter((g) => g !== null);
    if (gaps.length === 0) continue;
    // Several crons on one workflow are alternatives; the tightest one is the
    // promise the workflow is making.
    out.push({ file, expectedGapMin: Math.min(...gaps), crons });
  }
  return out;
}

async function lastScheduledRun(file) {
  if (!TOKEN) return undefined;
  const url =
    `https://api.github.com/repos/${REPO}/actions/workflows/${encodeURIComponent(file)}` +
    `/runs?event=schedule&per_page=1`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return undefined;
  const body = await res.json();
  const run = body.workflow_runs?.[0];
  return run ? Date.parse(run.created_at) : null; // null = never ran on a schedule
}

/* Guarded so the arithmetic above can be imported and tested. A module that
   runs its whole body on import cannot be unit tested, and the cron maths is
   exactly the part worth pinning. */
async function main() {
const workflows = scheduledWorkflows();
say(`[schedule-liveness] ${workflows.length} workflow(s) declare a schedule`);

if (!TOKEN) {
  say('[schedule-liveness] SKIP: no token, so the API cannot be asked when these last ran.');
  process.exit(0);
}

const late = [];
for (const w of workflows) {
  const last = await lastScheduledRun(w.file);
  if (last === undefined) continue; // unreadable: say nothing rather than guess
  const ageMin = last === null ? Infinity : Math.round((Date.now() - last) / 60000);
  const budget = w.expectedGapMin * TOLERANCE;
  if (ageMin > budget) {
    late.push({ ...w, ageMin, budget, never: last === null });
  }
}

if (late.length === 0) {
  say('[schedule-liveness] OK - every scheduled workflow has fired within its budget.');
  process.exit(0);
}

late.sort((a, b) => b.ageMin / b.budget - a.ageMin / a.budget);
say(`::warning title=SCHEDULES NOT FIRING::${late.length} scheduled workflow(s) are overdue by more than ${TOLERANCE}x their own interval.`);
summary.push('### Scheduled workflows that are not firing', '');
summary.push('| Workflow | Cron | Expected gap | Last scheduled run |');
summary.push('|---|---|---|---|');
for (const w of late) {
  const when = w.never ? '**never**' : `${w.ageMin} min ago`;
  say(`  ${w.file}: expected every ${w.expectedGapMin}m, last scheduled run ${when}`);
  summary.push(`| \`${w.file}\` | \`${w.crons[0]}\` | ${w.expectedGapMin} min | ${when} |`);
}
summary.push(
  '',
  'GitHub scheduled workflows are best-effort and are sometimes dropped outright.',
  'This is information, not a failure: the engine watchdog in this same workflow',
  'repairs the case that matters by dispatching the deploy itself.'
);

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
}
process.exit(0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) await main();
