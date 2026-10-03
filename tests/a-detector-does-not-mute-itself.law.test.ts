/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A DETECTOR DOES NOT MUTE ITSELF WITH ITS OWN OUTPUT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md 10.83 gives `check-main-is-green.mjs` one job: say so when a
 * workflow is red on `main` and nobody is being told. CLAUDE.md 10.86 names
 * the estate's signature failure - a detector that answers confidently when it
 * cannot tell. This is that failure in its purest form, because the detector
 * was not merely guessing: it was reading back a sentence it had written
 * itself and treating it as somebody else's assurance.
 *
 * ── WHAT IT DID, MEASURED 2026-09-30 ────────────────────────────────────────
 * One line decided everything:
 *
 *     for (const r of red) r.loud = hasOpenAlarm(r.name, r.since);
 *
 * and the alarm fired only on `!r.loud`. `hasOpenAlarm` matches exactly two
 * things - the `main-health-reader` label and the marker from
 * `workflowAlarmMarker` - and THIS DETECTOR IS THE ONLY THING IN THE ESTATE
 * THAT WRITES EITHER. The `Raise the durable alarm` step copies the detector's
 * whole log into the issue; the log prints a marker for every red workflow;
 * the next hourly run reads those markers back as "somebody already has this".
 *
 * A closed loop, needing no human and no second component. Issue #4332 carried
 * markers for TEN workflows and every one of them was muted by it:
 *
 *     Applied Migrations Are Recorded   50 consecutive failures, >=29.9 days
 *     Estate Integrity                  65 consecutive,           21.5 days
 *     Production Integrity Audit        96 consecutive,          >=19.0 days
 *     Trusted Money Trigger Recovery    11 consecutive,           12.4 days
 *     Telemetry Exposure                14 consecutive,            6.8 days
 *     Post-Deploy E2E (production)      58 consecutive,          >=36.8 hours
 *     Cron Health                        9 consecutive,            2.8 days
 *     Schema Integrity Audit            14 consecutive,            2.5 days
 *     Auto-Deploy Hetzner Engine, Settlement Lane Doctrine (since green)
 *
 * The job printed "At least one failure is fresh or already tracked; retaining
 * the alarm" and exited 0. `Nothing is silently red on main` was GREEN while a
 * workflow that had not been green in a month sat under it.
 *
 * ── WHY THE EXEMPTION EXISTED, AND WHAT IT IS NOW ───────────────────────────
 * It was written for one real case (10.83): a production audit that exits
 * non-zero in order to RAISE an alarm is doing its job, and flagging it as a
 * defect teaches everyone to ignore the detector inside a week. That reasoning
 * is right. INFERRING it from "an open issue names this workflow" is not, and
 * inferring it from an issue this detector wrote is a loop.
 *
 * So the exemption is now DECLARED, in `SELF_ALARMING_WORKFLOWS`, naming the
 * label of the issue the workflow itself files - never this detector's label -
 * and it applies only while such an issue is open and has been touched since
 * the failure episode began. The registry is empty, which is a measurement:
 * none of the ten qualified. Every one is a real defect or an un-cleared
 * backlog.
 *
 * ── THE LAW ─────────────────────────────────────────────────────────────────
 *   1. The main-health marker is a receipt, not a mute switch. A workflow the
 *      detector's own issue names is reported as `tracked` and still alarms.
 *   2. The 10.83 exemption is declared, never inferred, and never satisfied by
 *      MAIN_HEALTH_READER_LABEL.
 *   3. Age escalates and never mutes: the report is oldest-first and the
 *      annotation names the worst, so a month-old failure reads louder than a
 *      fresh one rather than hiding behind it.
 *   4. The reader is unchanged and named: `production-integrity-audit.yml`,
 *      job `main_is_green`, which files and updates the durable issue and
 *      carries the detector's exit code into the job conclusion.
 *
 * ── AND THE OTHER DIRECTION: ITS OWN VERDICT IS NOT EVIDENCE (2026-10-03) ────
 * The 2026-09-30 fix removed a detector muting OTHER workflows with its own
 * output. It left the mirror image standing one level up, which is CLAUDE.md
 * 10.86 rule 4: the detector reads EVERY active workflow, including the one it
 * runs inside, so its exit code decided its own next input. Green was
 * unreachable by arithmetic - with the entire estate green and every other job
 * in this workflow green, the previous run's failure still put `Production
 * Integrity Audit` in `red`, past the threshold, and alarmed. Measured on run
 * 37098827354: "Production Integrity Audit - 112 consecutive failed verdict(s)
 * over at least 21.5 days, no green run in the window", reported by a job
 * inside that workflow.
 *
 * `SELF_ALARMING_WORKFLOWS` cannot reach it and must not be bent to: an entry
 * names the label of the issue THAT workflow files and never
 * MAIN_HEALTH_READER_LABEL, and the main-health issue is this workflow's only
 * write path. Nor is the answer to skip the workflow - it has eleven jobs and
 * nine of them read production, so a wholesale exemption would hide a red
 * `Live chip and diamond supply still conserves` from everybody, which is 10.83
 * in a fresh coat.
 *
 *   5. Only the circular part is removed. This detector's own workflow - the
 *      one `GITHUB_WORKFLOW` names, never a hardcoded title - stops alarming
 *      only when EVERY failing job in its latest verdict is the job that runs
 *      this detector. Any other failing job alarms exactly as before.
 *   6. It is read from the Actions jobs API, a structural fact about the run.
 *      It is never inferred from an issue, a label, or a marker this detector
 *      wrote - that was the 2026-09-30 bug and it stays fixed.
 *   7. An unreadable or empty job list is not "nothing else failed". It alarms
 *      (10.86 rule 2).
 *   8. A self-referential red is still printed in the report, still carries its
 *      marker into the durable issue, and still raises a run annotation naming
 *      its age - and it can never close the durable alarm, because the close
 *      step greps for the exact all-green sentence this detector prints only
 *      when nothing at all is red.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  classifyRedState,
  classifyWorkflow,
  issueCarriesWorkflowAlarm,
  MAIN_HEALTH_JOB_NAME,
  MAIN_HEALTH_READER_LABEL,
  onlyFailingJobIs,
  RED_STATE,
  SELF_ALARMING_WORKFLOWS,
  workflowAlarmMarker,
} from '../scripts/ci/lib/workflowVerdicts.mjs';

const ROOT = join(__dirname, '..');
const DETECTOR = 'scripts/ci/check-main-is-green.mjs';
const LIB = 'scripts/ci/lib/workflowVerdicts.mjs';
const HOST = '.github/workflows/production-integrity-audit.yml';
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/**
 * The file with its comments blanked.
 *
 * Written after this law failed on its own evidence: the detector's header now
 * QUOTES the line that was removed - `r.loud = hasOpenAlarm(...)` - so that the
 * next reader knows what was wrong and why. A pin that cannot tell code from
 * prose forbids explaining the bug, which is the one thing that stops it coming
 * back. Lengths are preserved so an offset still means something.
 */
function executable(path: string): string {
  const src = read(path);
  let out = '';
  for (let i = 0; i < src.length; i += 1) {
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      out += '\n';
      continue;
    }
    if (src.startsWith('/*', i)) {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      for (; i < end; i += 1) out += src[i] === '\n' ? '\n' : ' ';
      i -= 1;
      continue;
    }
    out += src[i];
  }
  return out;
}

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-30T13:47:11Z');

/** A red verdict shaped exactly as `classifyWorkflow` produces one. */
const redFor = (name: string, hours: number) => ({
  name,
  consecutive: 49,
  hours,
  since: new Date(NOW - hours * HOUR).toISOString(),
  url: 'https://github.com/x/y/actions/runs/1',
  lastGreen: null,
  seen: 60,
  verdicts: 49,
  windowLimited: true,
});

describe('a marker this detector wrote never silences this detector', () => {
  it('a tracked failure past the threshold still alarms', () => {
    // The exact shape of the 2026-09-30 loop: our own issue names it, and it
    // has been red for 29 days.
    const verdict = classifyRedState(redFor('Applied Migrations Are Recorded', 29.9 * 24), {
      tracked: true,
      selfAlarmed: false,
      thresholdHours: 6,
    });
    expect(verdict.state).toBe(RED_STATE.TRACKED);
    expect(
      verdict.alarms,
      "A workflow named by the detector's OWN issue must still alarm. " +
        'Suppressing it is the closed loop that kept ten workflows green-looking.'
    ).toBe(true);
  });

  it('tracked and silent differ only in the word, never in whether they alarm', () => {
    const red = redFor('Estate Integrity', 21.5 * 24);
    const tracked = classifyRedState(red, { tracked: true, thresholdHours: 6 });
    const silent = classifyRedState(red, { tracked: false, thresholdHours: 6 });
    expect(tracked.state).toBe(RED_STATE.TRACKED);
    expect(silent.state).toBe(RED_STATE.SILENT);
    expect(tracked.alarms).toBe(silent.alarms);
    expect(tracked.alarms).toBe(true);
  });

  it('a fresh red is still given room to be fixed', () => {
    const verdict = classifyRedState(redFor('CI - Build & Type Safety', 1.4), {
      tracked: false,
      thresholdHours: 6,
    });
    expect(verdict.state).toBe(RED_STATE.FRESH);
    expect(verdict.alarms).toBe(false);
  });

  it('the detector no longer subtracts a tracked workflow from its alarm set', () => {
    const src = executable(DETECTOR);
    expect(
      /r\.loud\s*=/.test(src),
      'The blanket mute is back. An open issue naming a workflow is a receipt, ' +
        'not permission to stop reporting it.'
    ).toBe(false);
    expect(src).not.toMatch(/!\s*r\.loud/);
    // Non-vacuity: the header still EXPLAINS the removed line, and a pin that
    // could not tell that from the line itself would forbid the explanation.
    expect(read(DETECTOR)).toContain('r.loud = hasOpenAlarm');
    // The alarm set is whatever the classification says alarms, nothing less.
    expect(src).toContain('red.filter((r) => r.alarms)');
    expect(src).toContain('classifyRedState');
  });

  it('the receipt itself is unchanged, so the issue stays authoritative', () => {
    // The ownership contract that makes the issue machine-readable is not what
    // was wrong, and removing it would lose the "this is not new" signal.
    const since = '2026-09-01T00:00:00Z';
    const owned = {
      updated_at: '2026-09-30T00:00:00Z',
      labels: [{ name: MAIN_HEALTH_READER_LABEL }],
      body: `x ${workflowAlarmMarker('Estate Integrity')} y`,
    };
    expect(issueCarriesWorkflowAlarm(owned, 'Estate Integrity', since)).toBe(true);
    expect(issueCarriesWorkflowAlarm(owned, 'Another Workflow', since)).toBe(false);
    expect(read(DETECTOR)).toContain('issueCarriesWorkflowAlarm');
  });
});

describe('the 10.83 exemption is declared, never inferred', () => {
  it('is empty, because nothing measured on 2026-09-30 qualified', () => {
    expect(
      [...SELF_ALARMING_WORKFLOWS.keys()],
      'Adding an entry here stops a workflow being reported. Every entry must ' +
        'state reason, declaredOn and the alarmLabel of the issue THAT workflow ' +
        'files, and must be justified in the pull request.'
    ).toEqual([]);
  });

  it('every entry, if one is ever added, carries its evidence and a foreign label', () => {
    for (const [name, entry] of SELF_ALARMING_WORKFLOWS) {
      expect(typeof entry?.reason, `${name} must say why`).toBe('string');
      expect((entry?.reason || '').length, `${name} must say why`).toBeGreaterThan(20);
      expect(entry?.declaredOn, `${name} must be dated`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(
        entry?.alarmLabel,
        `${name} must name the label of the issue IT files, never this detector's`
      ).toBeTruthy();
      expect(entry?.alarmLabel).not.toBe(MAIN_HEALTH_READER_LABEL);
    }
  });

  it('a declared workflow that has gone quiet is not exempt', () => {
    const registry = new Map([
      [
        'An Audit',
        {
          reason: 'its red run is how it delivers the finding to its reader',
          declaredOn: '2026-09-30',
          alarmLabel: 'audit-finding',
        },
      ],
    ]);
    const red = redFor('An Audit', 48);
    expect(
      classifyRedState(red, { tracked: false, selfAlarmed: true, thresholdHours: 6, registry })
        .state
    ).toBe(RED_STATE.SELF_ALARMING);
    expect(
      classifyRedState(red, { tracked: false, selfAlarmed: false, thresholdHours: 6, registry })
        .alarms,
      'Declared self-alarming but currently saying nothing is the 10.83 bug itself.'
    ).toBe(true);
  });

  it("the declaration cannot be satisfied by this detector's own label", () => {
    expect(read(DETECTOR)).toContain('label === MAIN_HEALTH_READER_LABEL');
    expect(read(LIB)).toContain('It may never be');
  });
});

describe('age escalates and never mutes', () => {
  it('the report is ordered oldest first', () => {
    expect(read(DETECTOR)).toContain('red.sort((a, b) => b.hours - a.hours)');
  });

  it('the annotation names the worst one and how long it has run', () => {
    const src = read(DETECTOR);
    expect(src).toContain('const worst = overdue[0]');
    expect(src).toMatch(/the oldest is \$\{worst\.name\}/);
    // A chronic alarm whose wording never changes is the same blind spot as no
    // alarm, so the text has to carry a number that moves.
    expect(src).toMatch(/hrs\(worst\.hours\)/);
  });
});

describe('the reader is unchanged and still named', () => {
  const yml = read(HOST);

  it('production-integrity-audit runs the detector and files the durable issue', () => {
    expect(yml).toContain(DETECTOR);
    expect(yml).toContain('main-health-reader');
    expect(yml).toContain('- name: Raise the durable alarm for a silently red main');
  });

  it("the job conclusion is the detector's own exit code", () => {
    expect(yml).toContain('CODE: ${{ steps.main-green.outputs.code }}');
    expect(yml).toContain('exit "$CODE"');
  });

  it('a green run still cannot close the issue on a partial log', () => {
    // The close step greps for the exact all-green sentence before touching
    // the issue, so the detector must keep printing that exact sentence.
    expect(yml).toContain("OK - every workflow's latest VERDICT on main is green.");
    expect(read(DETECTOR)).toContain("OK - every workflow's latest VERDICT on ${BRANCH} is green.");
  });
});

describe("a detector's own verdict is not evidence about the estate", () => {
  const SELF = 'Production Integrity Audit';
  const OTHER_JOB = 'Live chip and diamond supply still conserves';

  it('the self-referential state never alarms', () => {
    // The exact 2026-10-03 fixed point: 21.5 days, no green run in the window,
    // and the only thing red was this detector's own previous exit code.
    const verdict = classifyRedState(redFor(SELF, 21.5 * 24), {
      tracked: true,
      selfReferential: true,
      thresholdHours: 6,
    });
    expect(verdict.state).toBe(RED_STATE.SELF_REFERENTIAL);
    expect(
      verdict.alarms,
      'Reporting this is the detector reading its own exit code back as a finding, ' +
        'which makes green unreachable by arithmetic.'
    ).toBe(false);
  });

  it('being tracked is still not a reason to go quiet when it is not circular', () => {
    // Rule 1 is untouched: without the structural proof, the SAME workflow at
    // the SAME age still alarms.
    const verdict = classifyRedState(redFor(SELF, 21.5 * 24), {
      tracked: true,
      selfReferential: false,
      thresholdHours: 6,
    });
    expect(verdict.state).toBe(RED_STATE.TRACKED);
    expect(verdict.alarms).toBe(true);
  });

  it('any other failing job in the same run is a real finding and alarms', () => {
    expect(
      onlyFailingJobIs(
        [
          { name: MAIN_HEALTH_JOB_NAME, conclusion: 'failure' },
          { name: OTHER_JOB, conclusion: 'failure' },
        ],
        MAIN_HEALTH_JOB_NAME
      ),
      "Nine of this workflow's jobs read production. Exempting the workflow " +
        'wholesale would hide every one of them, which is CLAUDE.md 10.83 again.'
    ).toBe(false);
    expect(
      onlyFailingJobIs([{ name: OTHER_JOB, conclusion: 'failure' }], MAIN_HEALTH_JOB_NAME)
    ).toBe(false);
  });

  it("only the detector's own job failing is the circular case", () => {
    expect(
      onlyFailingJobIs(
        [
          { name: MAIN_HEALTH_JOB_NAME, conclusion: 'failure' },
          { name: OTHER_JOB, conclusion: 'success' },
          { name: 'Explicit tournament runtime observation', conclusion: 'skipped' },
        ],
        MAIN_HEALTH_JOB_NAME
      )
    ).toBe(true);
  });

  it('timed_out and startup_failure count as failing jobs too', () => {
    expect(
      onlyFailingJobIs(
        [
          { name: MAIN_HEALTH_JOB_NAME, conclusion: 'failure' },
          { name: OTHER_JOB, conclusion: 'timed_out' },
        ],
        MAIN_HEALTH_JOB_NAME
      )
    ).toBe(false);
    expect(
      onlyFailingJobIs([{ name: OTHER_JOB, conclusion: 'startup_failure' }], MAIN_HEALTH_JOB_NAME)
    ).toBe(false);
  });

  it('an unreadable or empty job list alarms rather than reading as clean', () => {
    for (const jobs of [undefined, null, [], {}, 'nope']) {
      expect(
        onlyFailingJobIs(jobs as never, MAIN_HEALTH_JOB_NAME),
        'COULD NOT TELL must not read as "nothing else failed" (10.86 rule 2).'
      ).toBe(false);
    }
    // A run with no failing job at all is not the circular case either - the
    // workflow's red came from somewhere this read cannot see, so it alarms.
    expect(
      onlyFailingJobIs([{ name: OTHER_JOB, conclusion: 'success' }], MAIN_HEALTH_JOB_NAME)
    ).toBe(false);
  });

  it('the exemption is keyed on the running workflow, never a hardcoded title', () => {
    const src = executable(DETECTOR);
    expect(src).toContain('process.env.GITHUB_WORKFLOW');
    expect(src).toContain('red?.name !== SELF_WORKFLOW');
    expect(
      /SELF_WORKFLOW\s*=\s*['"]/.test(src),
      'A hardcoded workflow name is an allowlist, which this file refuses by design.'
    ).toBe(false);
  });

  it('it is read from the Actions jobs API and from no issue, label or marker', () => {
    const src = executable(DETECTOR);
    const start = src.indexOf('async function isSelfReferential');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toMatch(/\/actions\/runs\/.*\/jobs/);
    expect(body).toContain('onlyFailingJobIs');
    expect(body).not.toContain('MAIN_HEALTH_READER_LABEL');
    expect(body).not.toContain('openIssues');
    expect(body).not.toContain('workflowAlarmMarker');
    // Every failure path returns false, which is the loud direction.
    expect(body).toMatch(/catch\s*\{\s*return false;/);
  });

  it('the verdict carries the run id the job read belongs to', () => {
    const run = (conclusion: string, hoursAgo: number) => ({
      id: 37098827354,
      conclusion,
      created_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
      html_url: 'https://github.com/x/y/actions/runs/37098827354',
    });
    expect(classifyWorkflow(SELF, [run('failure', 1)], NOW)!.latestRunId).toBe(37098827354);
  });

  it('a self-referential red is still printed, annotated, and never closes the alarm', () => {
    const src = read(DETECTOR);
    // Printed in the oldest-first report with its own explanation.
    expect(src).toContain('RED_STATE.SELF_REFERENTIAL');
    // Announced on the run itself, with an age that moves (rule 3).
    expect(src).toContain('::warning title=This audit is red only because of its own verdict::');
    expect(src).toMatch(/for \$\{hrs\(r\.hours\)\}/);
    // The all-green sentence is printed ONLY when nothing is red at all, and the
    // close step greps for exactly that, so a self-referential red cannot close
    // the durable issue.
    const allGreen = "OK - every workflow's latest VERDICT on ${BRANCH} is green.";
    const idx = src.indexOf(allGreen);
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(0, idx)).toContain('if (red.length === 0) {');
    expect(read(HOST)).toContain("OK - every workflow's latest VERDICT on main is green.");
  });

  it('the job name it compares against is the one the workflow actually declares', () => {
    const yml = read(HOST);
    expect(yml).toContain(`name: ${MAIN_HEALTH_JOB_NAME}`);
    // ...and that job is the one that runs this detector.
    const job = yml.slice(yml.indexOf('\n  main_is_green:'), yml.indexOf('\n  ddl_reload_storms:'));
    expect(job).toContain(`name: ${MAIN_HEALTH_JOB_NAME}`);
    expect(job).toContain(DETECTOR);
  });
});
