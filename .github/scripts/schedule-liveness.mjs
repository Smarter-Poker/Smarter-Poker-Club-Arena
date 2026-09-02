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

async function api(path, method = 'GET', body = undefined) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

/**
 * ── SELF-HEAL (added 2026-09-01, the day this failure actually happened) ──
 *
 * A single overdue workflow is a dropped tick: common, transient, not worth
 * acting on. SEVERAL overdue at once is the other thing - the repo-level
 * schedule-REGISTRATION wedge that follows workflow-file churn. Measured
 * live on 2026-09-01: every CA schedule silent for 2.5 hours after three
 * workflow-editing merges, while World Hub's crons fired normally and
 * githubstatus said all operational. The proven remedy, applied by hand that
 * day, is to disable and re-enable each scheduled workflow, which makes
 * GitHub re-register its cron. This automates exactly that.
 *
 * Guard rails: only fires at WEDGE_MIN simultaneous overdue workflows; only
 * touches workflows whose state is `active` (a deliberately disabled one
 * stays disabled); refuses to run again within REHEAL_COOLDOWN_H hours, using
 * the audit issue itself as the memory, so a wedge the cycle cannot fix does
 * not flap; and it NEVER fails the job - the heal is best-effort and the
 * issue is the record either way.
 */
const WEDGE_MIN = Number(process.env.SCHEDULE_WEDGE_MIN || 3);
const REHEAL_COOLDOWN_H = Number(process.env.REHEAL_COOLDOWN_H || 6);
const MAX_HEAL_ATTEMPTS = Number(process.env.MAX_HEAL_ATTEMPTS || 3);
const WEDGE_ISSUE_TITLE = 'Cron registration wedge: schedules stopped firing repo-wide';
/** Written into the issue so attempts can be counted on the next run. */
const ATTEMPT_MARKER = '<!-- heal-attempt -->';

/**
 * ── WHAT TO DO THIS RUN (added 2026-09-02, the day the cooldown backfired) ──
 *
 * MEASURED. A heal ran at 14:56 and did not work. The estate then sat without
 * a single scheduled tick for five and a half hours - build-for-world-hub's
 * every-30-minute publish safety net included - because the cooldown keyed
 * on a heal having RUN rather than on it having WORKED, and the healer had put
 * itself to sleep until 20:56. Twelve workflows were overdue and the one thing
 * built to fix that had decided it was not its turn.
 *
 * The cooldown is still right in shape: cycling registrations every few
 * minutes would be flapping. What was wrong is the question it asked. This
 * function is only ever reached when schedules are STILL overdue, so being
 * inside the cooldown is not evidence that the last heal is working - it is
 * evidence that it is not.
 *
 * So: retry, up to MAX_HEAL_ATTEMPTS, recording each attempt on the SAME issue
 * so the count survives between runs. When the attempts are spent, stop
 * cycling and say plainly that this wedge is beyond the remedy, because a
 * fourth identical attempt is not persistence, it is noise.
 *
 * Pure and exported so the decision can be tested without a live wedge.
 */
export function healDecision({ recentIssue, attempts = 0, now = Date.now(), cooldownH = REHEAL_COOLDOWN_H, maxAttempts = MAX_HEAL_ATTEMPTS }) {
  if (!recentIssue) return { act: 'heal', attempt: 1, why: 'no prior wedge issue - first heal of this episode' };
  const ageH = (now - Date.parse(recentIssue.created_at)) / 3600_000;
  if (ageH >= cooldownH) {
    return { act: 'heal', attempt: 1, why: `prior wedge #${recentIssue.number} is ${ageH.toFixed(1)}h old, past the ${cooldownH}h cooldown - new episode` };
  }
  if (attempts >= maxAttempts) {
    return { act: 'escalate', attempt: attempts, why: `${attempts} cycle attempts on #${recentIssue.number} and schedules are still overdue - the cycle remedy does not fix this wedge` };
  }
  return { act: 'retry', attempt: attempts + 1, why: `heal #${attempts} on #${recentIssue.number} did not restore ticks - schedules are still overdue, so retrying` };
}

async function selfHeal(late) {
  // The wedge issue is the memory that survives between runs.
  let recentIssue = null;
  let attempts = 0;
  const listRes = await api(`/issues?state=all&labels=cron-wedge&per_page=5`);
  if (listRes.ok) {
    const issues = await listRes.json();
    recentIssue =
      issues
        .filter((i) => i.title === WEDGE_ISSUE_TITLE)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] || null;
    if (recentIssue) attempts = await countAttempts(recentIssue);
  }

  const decision = healDecision({ recentIssue, attempts });
  say(`[schedule-liveness] ${decision.why}`);

  if (decision.act === 'escalate') {
    // Stop cycling. Say it once, loudly, where a human will see it, and mark
    // the issue so the next run does not re-escalate into a comment storm.
    const labelled = (recentIssue.labels || []).some(
      (l) => (typeof l === 'string' ? l : l.name) === 'cron-wedge-persistent'
    );
    say(
      `::error title=CRON WEDGE BEYOND THE CYCLE FIX::${attempts} disable/enable cycles have not restored ` +
        `scheduled ticks (#${recentIssue.number}). Scheduled work is NOT running.`
    );
    if (!labelled) {
      await api(`/labels`, 'POST', { name: 'cron-wedge-persistent', color: '5319E7' }).catch(() => {});
      await api(`/issues/${recentIssue.number}/labels`, 'POST', { labels: ['cron-wedge-persistent'] }).catch(() => {});
      await api(`/issues/${recentIssue.number}/comments`, 'POST', {
        body: [
          `**${attempts} cycle attempts have not restored scheduled ticks. This needs a human.**`,
          '',
          `Still overdue right now: ${late.length} workflow(s), worst \`${late[0].file}\` at ${late[0].ageMin} min against a ${late[0].budget} min budget.`,
          '',
          'The disable/enable remedy fixed the 2026-09-01 wedge and does not fix this one, so',
          'stop expecting it to. What to check, in order:',
          '',
          '1. https://www.githubstatus.com - Actions degradation is the cheapest explanation.',
          '2. Repository -> Settings -> Actions: is Actions restricted, or is the repo out of',
          '   included minutes? A billing stop silences schedules while `push` events keep working,',
          '   which is exactly the shape seen here.',
          '3. Actions -> each workflow page -> is there a "This scheduled workflow was disabled',
          '   because of repository inactivity" banner?',
          '',
          'What is NOT affected, so nobody panics: `push` and `pull_request` triggers still fire,',
          'so a merge still publishes and CI still gates. What IS lost is every safety net that',
          'is scheduled - `build-for-world-hub`\'s */30 retry and this watchdog\'s hourly sweep',
          'among them - so a publish that fails will not be retried automatically until this is fixed.',
        ].join('\n'),
      }).catch(() => {});
    }
    return;
  }

  /**
   * SCOPE. The old heal cycled only the workflows it had measured as late.
   * This wedge is repo-level - on 2026-09-02 twelve workflows were dead at
   * once and a four-workflow cycle did nothing - and the remedy that worked by
   * hand on 2026-09-01 was applied to every scheduled workflow. So cycle them
   * all. A workflow that is deliberately disabled is still left alone.
   */
  const all = scheduledWorkflows();
  const cycled = [];
  for (const w of all) {
    const wfRes = await api(`/actions/workflows/${encodeURIComponent(w.file)}`);
    if (!wfRes.ok) continue;
    const wf = await wfRes.json();
    if (wf.state !== 'active') {
      say(`[schedule-liveness] ${w.file} is '${wf.state}' - deliberately off, leaving it alone.`);
      continue;
    }
    const off = await api(`/actions/workflows/${wf.id}/disable`, 'PUT');
    const on = await api(`/actions/workflows/${wf.id}/enable`, 'PUT');
    if (off.ok && on.ok) {
      cycled.push(w.file);
      say(`[schedule-liveness] re-registered schedule for ${w.file}`);
    } else {
      // Enable is the half that must not be left undone.
      if (!on.ok) await api(`/actions/workflows/${wf.id}/enable`, 'PUT');
      say(`[schedule-liveness] could not cycle ${w.file} (disable ${off.status}/enable ${on.status})`);
    }
  }

  /**
   * A cycle that cycled NOTHING is not a heal, and must not leave a cooldown
   * marker behind - that would buy six hours of silence for work that never
   * happened. The old code filed the issue unconditionally.
   */
  if (cycled.length === 0) {
    say('[schedule-liveness] cycled nothing (API refused every workflow) - not filing a cooldown marker.');
    say('::warning title=CRON WEDGE NOT HEALED::the heal could not cycle a single workflow; check the token\'s actions:write scope.');
    return;
  }

  const evidence = [
    `${late.length} scheduled workflows were simultaneously overdue by more than`,
    `${TOLERANCE}x their own interval - the repo-level schedule-registration wedge`,
    `(first seen 2026-09-01 after workflow-file churn; GitHub itself was healthy).`,
    '',
    `Cycled ${cycled.length} scheduled workflow(s) to force GitHub to re-register their crons:`,
    '',
    ...cycled.map((f) => `- \`${f}\``),
  ];

  if (decision.act === 'retry') {
    // Same episode: append to the existing issue so the attempt count is
    // countable next run, rather than filing a second issue nobody links up.
    await api(`/issues/${recentIssue.number}/comments`, 'POST', {
      body: [
        `${ATTEMPT_MARKER} **Heal attempt ${decision.attempt} of ${MAX_HEAL_ATTEMPTS}.**`,
        '',
        `The previous attempt did not restore ticks: schedules are still overdue, worst \`${late[0].file}\` at ${late[0].ageMin} min against a ${late[0].budget} min budget.`,
        '',
        ...evidence,
        '',
        `If ticks are still silent on the next run, attempt ${decision.attempt + 1} follows; after ${MAX_HEAL_ATTEMPTS} this stops cycling and asks for a human.`,
      ].join('\n'),
    }).catch(() => {});
    say(`[schedule-liveness] retry ${decision.attempt}/${MAX_HEAL_ATTEMPTS}: cycled ${cycled.length}, recorded on #${recentIssue.number}.`);
    return;
  }

  await api(`/labels`, 'POST', { name: 'cron-wedge', color: 'B60205' }).catch(() => {});
  await api(`/issues`, 'POST', {
    title: WEDGE_ISSUE_TITLE,
    labels: ['cron-wedge'],
    body: [
      `${ATTEMPT_MARKER} **Heal attempt 1 of ${MAX_HEAL_ATTEMPTS}.**`,
      '',
      ...evidence,
      '',
      'The next scheduled ticks prove whether it worked - check',
      `\`gh run list --repo ${REPO} --event schedule --limit 5\` after the next boundary.`,
      '',
      'This issue is the running record for this wedge. If ticks are still silent when this',
      `check next runs, it retries and comments here; after ${MAX_HEAL_ATTEMPTS} attempts it stops`,
      'cycling and asks for a human rather than pretending the remedy is working.',
      '',
      'Close it once ticks are confirmed flowing.',
    ].join('\n'),
  }).catch(() => {});
  say(`[schedule-liveness] wedge heal complete: cycled ${cycled.length}, issue filed.`);
}

/**
 * How many heal attempts this wedge has already had. The body is attempt 1 and
 * each retry adds a marked comment, so the marker is counted in both.
 */
async function countAttempts(issue) {
  let n = String(issue.body || '').includes(ATTEMPT_MARKER) ? 1 : 0;
  const res = await api(`/issues/${issue.number}/comments?per_page=100`);
  if (res.ok) {
    const comments = await res.json();
    n += comments.filter((c) => String(c.body || '').includes(ATTEMPT_MARKER)).length;
  }
  // An issue filed before the marker existed still counts as one attempt.
  return Math.max(n, 1);
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

// Several overdue at once is not dropped ticks - it is the registration
// wedge, and that one this script now repairs itself (see selfHeal above).
if (late.length >= WEDGE_MIN) {
  await selfHeal(late);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
}
process.exit(0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) await main();
