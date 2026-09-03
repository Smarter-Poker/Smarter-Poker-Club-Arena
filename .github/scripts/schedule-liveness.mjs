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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RE-REGISTERING A CRON IS NOT THE SAME AS DOING THE WORK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED, 2026-09-02. The automated heal cycled registrations at 14:56 and
 * ticks did not come back. A wider cycle of all 15 by hand at 16:32 did not
 * bring them back either. Meanwhile `push`, `pull_request` and
 * `workflow_dispatch` all fired normally all afternoon, and githubstatus said
 * Actions was operational. So the wedge is specifically in SCHEDULE delivery,
 * and cycling registrations is a remedy that sometimes works on it.
 *
 * The estate does not actually need the cron. It needs THE WORK the cron
 * stands for - above all `build-for-world-hub`'s every-30-minute retry, which
 * is the net that catches a publish that failed. `workflow_dispatch` demonstrably
 * still works, and this check already runs on `workflow_run`, which fires many
 * times an hour whatever the scheduler is doing. So when a scheduled workflow
 * has not run by ANY means inside the interval it promises, run it.
 *
 * This is the difference between a watchdog that reports a wedge and one that
 * survives it.
 *
 * GUARDS, because a dispatcher that loops is worse than a silent cron:
 *  - only workflows whose file declares `workflow_dispatch`;
 *  - never this workflow itself, which would be a self-trigger loop;
 *  - never one with a run already in flight;
 *  - staleness measured over runs of EVERY event, not just `schedule`, so a
 *    workflow this function already rescued is not rescued again a minute
 *    later - that is what makes the loop converge;
 *  - a hard cap per run.
 */
const MAX_DISPATCH = Number(process.env.MAX_STARVED_DISPATCH || 4);
const SELF_WORKFLOW = process.env.SELF_WORKFLOW_FILE || 'publish-watchdog.yml';

export function dispatchDecision({
  file,
  declaresDispatch,
  isSelf,
  busy,
  minutesSinceAnyRun,
  expectedGapMin,
}) {
  if (isSelf) return { dispatch: false, why: `${file} is this workflow - dispatching it would loop` };
  if (!declaresDispatch)
    return { dispatch: false, why: `${file} has no workflow_dispatch trigger - cannot be run by hand` };
  if (busy) return { dispatch: false, why: `${file} already has a run in flight` };
  if (minutesSinceAnyRun !== null && minutesSinceAnyRun < expectedGapMin)
    return {
      dispatch: false,
      why: `${file} ran ${minutesSinceAnyRun}m ago by some other trigger, inside its ${expectedGapMin}m interval - not starved`,
    };
  return { dispatch: true, why: `${file} has not run by any trigger in ${minutesSinceAnyRun === null ? 'ever' : minutesSinceAnyRun + 'm'}, past its ${expectedGapMin}m interval` };
}

/**
 * Events that never do a scheduled job's work. A `pull_request` run of
 * agent-autopilot.yml arms auto-merge for ONE pull request; its sweep job is
 * gated `github.event_name != 'pull_request'` and does not run at all. Counting
 * those runs as "the workflow ran" kept this dispatcher from ever dispatching
 * the sweep: measured 2026-09-03, autopilot had run 10 times in the last hour,
 * every one of them pull_request, and its sweep had run twice in six hours on
 * a thirty-minute cron. The starved question is "did the SCHEDULED work happen", and a
 * per-PR run is not evidence of that.
 */
export const PER_ITEM_EVENTS = new Set(['pull_request', 'pull_request_target', 'issue_comment', 'issues', 'check_run', 'check_suite']);

/** When did this workflow last run by a trigger that does its scheduled work? null = never. */
async function lastAnyRun(file) {
  const res = await api(`/actions/workflows/${encodeURIComponent(file)}/runs?per_page=30`);
  if (!res.ok) return undefined;
  const body = await res.json().catch(() => null);
  if (!body) return undefined;
  const run = (body.workflow_runs ?? []).find((r) => !PER_ITEM_EVENTS.has(r.event));
  return run ? Date.parse(run.created_at) : null;
}

/** Run the work the wedged crons stand for. Best effort; never fails the job. */
async function dispatchStarved(late) {
  const branchRes = await api('');
  const branch = branchRes.ok ? (await branchRes.json()).default_branch || 'main' : 'main';
  let sent = 0;
  for (const w of late) {
    if (sent >= MAX_DISPATCH) {
      say(`[schedule-liveness] dispatch cap ${MAX_DISPATCH} reached; the rest wait for the next run.`);
      break;
    }
    const text = readFileSync(join(DIR, w.file), 'utf8');
    const declaresDispatch = /^\s*workflow_dispatch:/m.test(text);
    const last = await lastAnyRun(w.file);
    const minutesSinceAnyRun =
      last === undefined ? 0 : last === null ? null : Math.round((Date.now() - last) / 60000);
    const busy = last === undefined ? true : await isBusy(w.file);
    const d = dispatchDecision({
      file: w.file,
      declaresDispatch,
      isSelf: w.file === SELF_WORKFLOW,
      busy,
      minutesSinceAnyRun,
      expectedGapMin: w.expectedGapMin,
    });
    if (!d.dispatch) {
      say(`[schedule-liveness] not dispatching: ${d.why}`);
      continue;
    }
    const res = await api(`/actions/workflows/${encodeURIComponent(w.file)}/dispatches`, 'POST', {
      ref: branch,
    });
    if (res.ok) {
      sent += 1;
      say(`[schedule-liveness] DISPATCHED ${w.file} - ${d.why}`);
      summary.push(`- Dispatched \`${w.file}\` by hand: its schedule is wedged and the work was overdue.`);
    } else {
      say(`[schedule-liveness] could not dispatch ${w.file} (${res.status})`);
    }
  }
  if (sent > 0) {
    say(
      `::warning title=SCHEDULES WEDGED, WORK DISPATCHED ANYWAY::${sent} overdue workflow(s) were started by hand because their cron is not firing.`
    );
  }
  return sent;
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
  const deferred = [];
  for (const w of all) {
    const wfRes = await api(`/actions/workflows/${encodeURIComponent(w.file)}`);
    if (!wfRes.ok) continue;
    const wf = await wfRes.json();
    if (wf.state !== 'active') {
      say(`[schedule-liveness] ${w.file} is '${wf.state}' - deliberately off, leaving it alone.`);
      continue;
    }
    /**
     * NEVER CYCLE A WORKFLOW THAT IS RUNNING (2026-09-02, learned the hard way).
     * Disabling a workflow CANCELS its in-flight runs. Cycling by hand at 16:32
     * killed the CI run on the pull request that was fixing a red main, and had
     * the timing been a minute different it would have cancelled a
     * build-for-world-hub publish instead - this heal exists to protect
     * publishing, so cancelling one to fix the schedule would be the cure
     * causing the disease. A workflow that is mid-run is also demonstrably
     * registered enough to run, so it is the least urgent one to cycle anyway.
     * It gets cycled on the next attempt, when it is idle.
     */
    if (await isBusy(wf.id)) {
      deferred.push(w.file);
      say(`[schedule-liveness] ${w.file} has a run in flight - not cycling it, that would cancel the run.`);
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
    ...(deferred.length
      ? [
          '',
          `Left alone because they had a run in flight (disabling cancels runs), to be cycled next attempt:`,
          '',
          ...deferred.map((f) => `- \`${f}\``),
        ]
      : []),
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
 * Is this workflow currently running anything? Disabling it would cancel that
 * run, so the answer decides whether it is safe to cycle.
 *
 * Fails CLOSED: if the API cannot be read, treat the workflow as busy and
 * leave it alone. A missed cycle costs one more attempt; a wrong cycle costs a
 * cancelled publish.
 */
async function isBusy(workflowIdOrFile) {
  // The API accepts either the numeric id or the workflow file name here.
  const ref = encodeURIComponent(String(workflowIdOrFile));
  for (const status of ['in_progress', 'queued']) {
    const res = await api(`/actions/workflows/${ref}/runs?status=${status}&per_page=1`);
    if (!res.ok) return true;
    const body = await res.json().catch(() => null);
    if (!body) return true;
    if ((body.total_count || 0) > 0) return true;
  }
  return false;
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ROOT CAUSE, MEASURED (2026-09-02 evening), AND WHY THE ORDER BELOW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every `schedule:` in Club Arena adds up to ~324 scheduled runs a day. Over
 * the 48 hours to 18:45 UTC GitHub delivered 65 - about 10%. World Hub asks
 * for ~129 a day and was delivered 19%. The seven repos together ask for
 * roughly 700+ a day. GitHub's own docs say the schedule event is best-effort
 * and that under load "some queued jobs may be dropped"; measured here, most
 * of them are, all the time, and the busiest repo is dropped hardest - today
 * to zero from 14:42.
 *
 * Nothing about registration was ever wrong. Disabling and re-enabling
 * workflows (this file's original remedy, and 15 cycled by hand at 16:32)
 * changed nothing, because there was nothing to re-register - and it CANCELS
 * that workflow's in-flight runs, which killed a CI run on the pull request
 * fixing a red main. The estate had also been compensating for the drops by
 * asking for MORE ticks (three per hour for one deploy), which under
 * fair-share throttling only deepens the drop.
 *
 * So the remedy is not to re-register the cron. It is to stop needing it:
 * this check runs on `workflow_run`, which GitHub delivers reliably many times
 * an hour, and `workflow_dispatch` is delivered reliably too. When a scheduled
 * workflow has not run by ANY trigger inside its promised interval, it is
 * dispatched. That is the first and normally only action taken here.
 *
 * Cycling registrations is kept as code, off by default. It fixed one wedge
 * on 2026-09-01 and nothing since; set SCHEDULE_CYCLE_REGISTRATIONS=1 on the
 * workflow to bring it back if a future wedge turns out to be a real
 * registration fault rather than this one.
 */
const sent = await dispatchStarved(late);

if (late.length >= WEDGE_MIN) {
  if (process.env.SCHEDULE_CYCLE_REGISTRATIONS === '1') {
    await selfHeal(late);
  } else {
    say(
      `[schedule-liveness] ${late.length} scheduled workflow(s) overdue; ${sent} dispatched directly. ` +
        'Registration cycling is off (see the root-cause note above).'
    );
  }
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
