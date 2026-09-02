/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SCHEDULED WORKFLOW THAT STOPS FIRING SAYS NOTHING (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED. auto-deploy-hetzner.yml moved to an hourly cron at 13:00 UTC.
 * Between then and 18:52 sixteen scheduled ticks were due and exactly ONE
 * ran, so the engine served a 03:54 image for fourteen and a half hours with
 * five merged pull requests unshipped. Every run in that window was green,
 * because none of them happened.
 *
 * On its first live run the new check found it was not one workflow but FOUR:
 *
 *   build-for-world-hub.yml   expected every 30m, last scheduled run 156m ago
 *   auto-deploy-hetzner.yml   expected every 50m, last scheduled run 259m ago
 *   agent-autopilot.yml       expected every 30m, last scheduled run 108m ago
 *   publish-watchdog.yml      expected every 60m, last scheduled run 184m ago
 *
 * build-for-world-hub is what publishes the Club Arena bundle, so this was
 * not confined to the engine.
 *
 * The cron arithmetic is the part worth pinning: an expectation that is too
 * tight cries wolf and one that is too loose is the silence it replaced. My
 * own first two expectations here were wrong and the code was right, which is
 * the reason these are written down rather than eyeballed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBlockAfter } from './helpers/sourceWindow';
import {
  maxGapMinutes,
  healDecision,
  dispatchDecision,
} from '../.github/scripts/schedule-liveness.mjs';

const ROOT = resolve(__dirname, '..');
const SCRIPT = readFileSync(resolve(ROOT, '.github/scripts/schedule-liveness.mjs'), 'utf8');
const WATCHDOG = readFileSync(resolve(ROOT, '.github/workflows/publish-watchdog.yml'), 'utf8');

describe('the cron arithmetic', () => {
  it('reads the widest hole a schedule leaves, not the narrowest', () => {
    // :40 :45 :50 every hour. The gaps are 5, 5, then FIFTY back round to the
    // next :40 - and it is the fifty that decides when to be worried.
    expect(maxGapMinutes('40,45,50 * * * *')).toBe(50);
  });

  it('handles the ordinary shapes this repo actually uses', () => {
    expect(maxGapMinutes('0 * * * *')).toBe(60);
    expect(maxGapMinutes('*/15 * * * *')).toBe(15);
    expect(maxGapMinutes('35 6 * * *')).toBe(1440);
    // Clustered hours: the overnight wrap is the widest hole, not the 20m step.
    expect(maxGapMinutes('0,20,40 0,3 * * *')).toBe(1220);
  });

  it('refuses to guess at a shape it cannot read', () => {
    // A wrong expectation is a false alarm, and a false alarm is how a real
    // one gets ignored. Anything narrowing the day returns null and is skipped.
    expect(maxGapMinutes('0 9 * * 1')).toBeNull();
    expect(maxGapMinutes('0 9 1 * *')).toBeNull();
    expect(maxGapMinutes('0 9-17 * * *')).toBeNull();
    expect(maxGapMinutes('nonsense')).toBeNull();
    expect(maxGapMinutes('')).toBeNull();
  });
});

describe('the check cannot share a failure domain with what it watches', () => {
  it('runs as a job on workflow_run, never as its own cron', () => {
    // The whole point: a cron that alarms about cron cannot alarm when cron is
    // the thing that broke.
    expect(WATCHDOG).toContain('workflow_run:');
    expect(WATCHDOG).toMatch(/schedules:\s*\n\s*name: The schedules are actually firing/);
    expect(WATCHDOG).toContain('node .github/scripts/schedule-liveness.mjs');
  });

  it('derives its watchlist from the workflow files, with no list to maintain', () => {
    // The same principle as the layer watchlist fixed earlier today: a
    // hand-kept list goes stale and then lies.
    expect(SCRIPT).toContain('readdirSync(DIR)');
    expect(SCRIPT).toMatch(/cron:\s*\\s\*\['"\]/);
  });

  it('never fails the job', () => {
    // GitHub drops ticks often enough that a red X here would be noise within
    // a day, and the engine watchdog beside it is what actually repairs the
    // case that matters.
    expect(SCRIPT).not.toContain('process.exit(1)');
    expect(SCRIPT).toContain('process.exit(0)');
  });

  it('says nothing when it cannot read the answer', () => {
    // No token, or an API that will not answer, must produce silence rather
    // than a fabricated alarm.
    expect(SCRIPT).toContain('SKIP: no token');
    expect(SCRIPT).toMatch(/if \(last === undefined\) continue;/);
  });
});

describe('the wedge heals itself (added 2026-09-01, the day it happened live)', () => {
  // Every CA schedule went silent for 2.5h after workflow-file churn while
  // World Hub fired normally: the repo-level registration wedge. The proven
  // manual fix was disable+enable per workflow; the script now applies it.

  it('distinguishes the wedge from a dropped tick by simultaneity', () => {
    expect(SCRIPT).toMatch(/WEDGE_MIN\s*=\s*Number\(process\.env\.SCHEDULE_WEDGE_MIN \|\| 3\)/);
    expect(SCRIPT).toMatch(/late\.length >= WEDGE_MIN/);
  });

  it('heals by re-registering: disable then enable, enable never left undone', () => {
    expect(SCRIPT).toContain("/disable`, 'PUT'");
    expect(SCRIPT).toContain("/enable`, 'PUT'");
    // The retry that guarantees a workflow is never left disabled by a
    // half-failed cycle.
    expect(SCRIPT).toMatch(
      /if \(!on\.ok\) await api\(`\/actions\/workflows\/\$\{wf\.id\}\/enable`, 'PUT'\);/
    );
  });

  it('leaves deliberately disabled workflows alone', () => {
    expect(SCRIPT).toMatch(/wf\.state !== 'active'/);
  });

  it('will not flap: the audit issue is the cooldown memory', () => {
    expect(SCRIPT).toMatch(/REHEAL_COOLDOWN_H/);
    expect(SCRIPT).toContain('labels=cron-wedge');
    expect(SCRIPT).toContain('Cron registration wedge');
  });

  it('the heal is loud - an issue, not a step summary nobody reads', () => {
    expect(SCRIPT).toMatch(/api\(`\/issues`, 'POST'/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HEAL THAT DID NOT WORK IS NOT A HEAL (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED. The self-healer cycled four workflow registrations at 14:56 and it
 * did not work. The cooldown then kept it quiet until 20:56, so the estate ran
 * five and a half hours with no scheduled tick at all - including
 * build-for-world-hub's every-30-minute publish retry, the safety net that
 * exists precisely so a failed publish is not left sitting. Twelve workflows
 * were overdue and the component built to fix that had decided it was not its
 * turn.
 *
 * The cooldown's SHAPE was right: cycling registrations every few minutes is
 * flapping. The QUESTION was wrong. `selfHeal` is only reached when schedules
 * are still overdue, so "we healed recently" and "schedules are still dead"
 * together mean the heal failed - which is an argument for trying again, not
 * for going quiet.
 */
describe('the wedge healer retries a heal that did not take, and gives up out loud', () => {
  const ISSUE = { number: 2638, created_at: '2026-09-02T14:56:25Z', labels: [] };
  const NOW = Date.parse('2026-09-02T16:30:00Z'); // 1.6h later, inside the 6h cooldown

  it('heals when there is no prior wedge issue', () => {
    expect(healDecision({ recentIssue: null, now: NOW }).act).toBe('heal');
  });

  it('THE BUG: inside the cooldown with schedules still dead, it retries rather than sleeping', () => {
    // The old code returned here and did nothing for six hours. This is the
    // exact state of the estate at 16:30 on 2026-09-02.
    const d = healDecision({ recentIssue: ISSUE, attempts: 1, now: NOW });
    expect(d.act).toBe('retry');
    expect(d.attempt).toBe(2);
  });

  it('counts attempts up rather than repeating attempt one forever', () => {
    expect(healDecision({ recentIssue: ISSUE, attempts: 2, now: NOW }).attempt).toBe(3);
  });

  it('stops cycling and escalates once the attempts are spent', () => {
    const d = healDecision({ recentIssue: ISSUE, attempts: 3, now: NOW });
    expect(d.act).toBe('escalate');
    // A fourth identical attempt is not persistence, it is noise.
    expect(d.why).toMatch(/does not fix this wedge/);
  });

  it('treats a wedge past the cooldown as a fresh episode, attempts reset', () => {
    const old = { ...ISSUE, created_at: '2026-09-02T05:00:00Z' }; // 11.5h earlier
    const d = healDecision({ recentIssue: old, attempts: 3, now: NOW });
    expect(d.act).toBe('heal');
    expect(d.attempt).toBe(1);
  });

  it('respects an explicit cooldown and attempt budget', () => {
    // A one-attempt budget escalates immediately on the first failed heal.
    expect(healDecision({ recentIssue: ISSUE, attempts: 1, now: NOW, maxAttempts: 1 }).act).toBe(
      'escalate'
    );
    // A zero-hour cooldown means every run is a fresh episode.
    expect(healDecision({ recentIssue: ISSUE, attempts: 9, now: NOW, cooldownH: 0 }).act).toBe(
      'heal'
    );
  });
});

/**
 * The other half of the same bug: the old heal filed its cooldown marker
 * unconditionally, so a cycle that cycled NOTHING (a token without
 * actions:write, say) still bought six hours of silence for work that had not
 * happened. These pin the source, because the failure is a branch that only
 * runs when the API refuses.
 */
describe('the healer never buys silence for a heal it did not perform', () => {
  const src = readFileSync(resolve(__dirname, '../.github/scripts/schedule-liveness.mjs'), 'utf8');

  it('returns without filing a cooldown marker when nothing was cycled', () => {
    expect(src).toMatch(/if \(cycled\.length === 0\)/);
    // Bounded by the if-block itself, never by a byte count (see
    // tests/helpers/sourceWindow.ts for why a fixed window cost a publish outage).
    const block = sliceBlockAfter(src, 'if (cycled.length === 0)');
    expect(block).toMatch(/not filing a cooldown marker/i);
    expect(block).toMatch(/return;/);
  });

  it('cycles every scheduled workflow, not just the ones measured late', () => {
    // A repo-level wedge is not fixed by cycling a subset: on 2026-09-02 four
    // were cycled while twelve were dead.
    expect(src).toMatch(/const all = scheduledWorkflows\(\);/);
    expect(src).toMatch(/for \(const w of all\)/);
  });

  it('leaves a deliberately disabled workflow alone', () => {
    expect(src).toMatch(/deliberately off, leaving it alone/);
  });

  it('always re-enables even when the enable call failed', () => {
    expect(src).toMatch(/Enable is the half that must not be left undone/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CURE MUST NOT CAUSE THE DISEASE (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED, on myself. Cycling the 15 scheduled workflows by hand at 16:32 to
 * clear the wedge CANCELLED the in-flight CI run on the pull request that was
 * fixing a red main - "The operation was canceled" after 40+ passing files.
 * Disabling a workflow cancels its runs, and `build-for-world-hub.yml` is in
 * the cycle list, so a heal timed a minute differently would have cancelled a
 * publish. A heal that exists to protect publishing must not be able to cancel
 * one.
 *
 * A workflow that is mid-run is also, by definition, registered enough to run,
 * so it is the least urgent thing in the list to cycle. It waits for the next
 * attempt.
 */
describe('the heal never cancels a run to fix a schedule', () => {
  const src = readFileSync(resolve(__dirname, '../.github/scripts/schedule-liveness.mjs'), 'utf8');

  it('skips any workflow that has a run in flight', () => {
    expect(src).toMatch(/if \(await isBusy\(wf\.id\)\)/);
    expect(sliceBlockAfter(src, 'if (await isBusy(wf.id))')).toMatch(/continue;/);
  });

  it('asks about both in_progress and queued runs', () => {
    expect(src).toMatch(/\['in_progress', 'queued'\]/);
  });

  it('fails CLOSED - an unreadable API means busy, never free-to-cycle', () => {
    const i = src.indexOf('async function isBusy(');
    const body = src.slice(i, src.indexOf('\n}', i));
    // Every early exit inside isBusy on an API problem must return true.
    expect(body).toMatch(/if \(!res\.ok\) return true;/);
    expect(body).toMatch(/if \(!body\) return true;/);
    expect(body).not.toMatch(/if \(!res\.ok\) return false;/);
  });

  it('reports what it deferred, so a skipped cycle is visible not silent', () => {
    expect(src).toMatch(/deferred\.push\(w\.file\)/);
    expect(src).toMatch(/Left alone because they had a run in flight/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RE-REGISTERING A CRON IS NOT THE SAME AS DOING THE WORK (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED. The automated heal cycled registrations at 14:56 and ticks did not
 * return. A wider cycle of all 15 by hand at 16:32 did not bring them back
 * either. Through all of it `push`, `pull_request` and `workflow_dispatch`
 * fired normally and githubstatus reported Actions operational, so the wedge is
 * specifically in SCHEDULE delivery and re-registration is a remedy that only
 * sometimes works on it.
 *
 * The estate does not need the cron. It needs the WORK - above all
 * `build-for-world-hub`'s 30-minute retry, the net that catches a publish that
 * failed. That afternoon production sat three commits behind main with the net
 * dead. `workflow_dispatch` still worked the whole time.
 *
 * So the check now runs the starved work itself. These pin the guards, because
 * a dispatcher that loops is worse than a silent cron.
 */
describe('a wedged cron does not stop the work from happening', () => {
  const base = {
    file: 'build-for-world-hub.yml',
    declaresDispatch: true,
    isSelf: false,
    busy: false,
    minutesSinceAnyRun: 323,
    expectedGapMin: 30,
  };

  it('dispatches a workflow starved past its own interval', () => {
    // The real 16:29 measurement: 323 minutes against a 30 minute promise.
    expect(dispatchDecision(base).dispatch).toBe(true);
  });

  it('dispatches one that has never run at all', () => {
    expect(dispatchDecision({ ...base, minutesSinceAnyRun: null }).dispatch).toBe(true);
  });

  it('NEVER dispatches itself - that is the loop', () => {
    const d = dispatchDecision({ ...base, file: 'publish-watchdog.yml', isSelf: true });
    expect(d.dispatch).toBe(false);
    expect(d.why).toMatch(/loop/);
  });

  it('measures staleness over EVERY trigger, so a rescue is not repeated', () => {
    // This is what makes the workflow_run loop converge: once dispatched, the
    // workflow has run recently by SOME trigger and is no longer starved.
    const d = dispatchDecision({ ...base, minutesSinceAnyRun: 5 });
    expect(d.dispatch).toBe(false);
    expect(d.why).toMatch(/not starved/);
  });

  it('will not dispatch a workflow that is already running', () => {
    expect(dispatchDecision({ ...base, busy: true }).dispatch).toBe(false);
  });

  it('will not dispatch one that has no workflow_dispatch trigger', () => {
    // ci.yml is the real example: no dispatch trigger, and four jobs gated on
    // github.event_name == 'schedule' that a manual run would skip anyway.
    const d = dispatchDecision({ ...base, file: 'ci.yml', declaresDispatch: false });
    expect(d.dispatch).toBe(false);
    expect(d.why).toMatch(/no workflow_dispatch/);
  });
});

describe('the starved-work dispatcher is wired in and bounded', () => {
  const src = readFileSync(resolve(__dirname, '../.github/scripts/schedule-liveness.mjs'), 'utf8');

  it('runs after the heal, on every wedge, not only when the heal worked', () => {
    expect(src).toMatch(/await dispatchStarved\(late\);/);
    // It must sit OUTSIDE the `if (late.length >= WEDGE_MIN)` heal block's
    // success path - the work is overdue whether or not re-registration took.
    const heal = src.indexOf('await selfHeal(late);');
    const disp = src.indexOf('await dispatchStarved(late);');
    expect(disp).toBeGreaterThan(heal);
  });

  it('caps how many it starts in one pass', () => {
    expect(src).toMatch(/MAX_DISPATCH/);
    expect(src).toMatch(/if \(sent >= MAX_DISPATCH\)/);
  });

  it('dispatches against the repository default branch, not a guess', () => {
    expect(src).toMatch(/default_branch/);
  });

  it('treats an unreadable run history as busy rather than dispatching blind', () => {
    expect(src).toMatch(/last === undefined \? true : await isBusy/);
  });
});
