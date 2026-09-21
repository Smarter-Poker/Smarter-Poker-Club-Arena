/**
 * LAW: a failed post-deploy verification reaches the alert store.
 * ═══════════════════════════════════════════════════════════════════════════
 * Added 2026-09-21 for the Production Alerts fleet.
 *
 * post-deploy-e2e.yml and deploy-monitoring.yml are the only checks that look
 * at PRODUCTION after a release. When one went red, the verdict lived in the
 * Actions UI and nowhere else - no row in World Hub's operational-alert inbox,
 * so the fleet's hourly run, the thing that decides whether a release is
 * rolled back, never saw it. A red run nobody is paged for is a comment.
 *
 * This law pins the wiring that fixes it:
 *
 *   - ONE composite action, .github/actions/report-post-deploy-failure,
 *     exists with the inputs the callers rely on, posts with curl to World
 *     Hub's intake with a bearer secret, bounded (20s, 3 retries), and can
 *     never fail the calling job;
 *   - BOTH post-deploy-e2e jobs and deploy-monitoring's deploy job call it
 *     from a step whose `if` includes failure(), with continue-on-error: true
 *     so nothing in the notifier can mask the job's real outcome;
 *   - the source/alertname pairs are the ones the fleet's rollback logic
 *     matches on, and the row is routed to the fleet's task id;
 *   - the existing evidence uploads are still there, unchanged in condition.
 *
 * Structural, not behavioural: it reads the YAML the way GitHub will.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const ROOT = join(__dirname, '..');
const ACTION_PATH = '.github/actions/report-post-deploy-failure/action.yml';
const ACTION_REF = './.github/actions/report-post-deploy-failure';
const SECRET_NAME = 'WORLD_HUB_ALERT_INTAKE_SECRET';
const INTAKE_URL = 'https://smarter.poker/api/internal/operational-alert';
const FLEET_TASK_ID = '01a09b86-5ba8-7290-8657-1041f13dd3ca';

type Step = {
  name?: string;
  id?: string;
  if?: string | boolean;
  uses?: string;
  run?: string;
  shell?: string;
  'continue-on-error'?: boolean;
  with?: Record<string, unknown>;
};
type Workflow = { jobs: Record<string, { steps: Step[] }> };
type Action = {
  inputs: Record<string, { required?: boolean; default?: unknown }>;
  runs: { using: string; steps: Step[] };
};

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const load = <T>(p: string): T => parse(read(p)) as T;

const reportingSteps = (steps: Step[]) => steps.filter((s) => s.uses === ACTION_REF);

const expectReportingStep = (
  file: string,
  job: string,
  step: Step | undefined,
  expected: { source: string; alertname: string; releasedFrom: string },
) => {
  expect(step, `${file} job ${job} has no step that uses ${ACTION_REF}`).toBeDefined();
  const s = step as Step;
  const cond = String(s.if ?? '');
  expect(cond, `${file}/${job}: reporting step must be conditioned on failure()`).toMatch(/failure\(\)/);
  expect(cond, `${file}/${job}: reporting step must not run on a green job`).not.toMatch(/^\s*always\(\)\s*$/);
  // The notifier can never mask the job's verdict, in either direction.
  expect(s['continue-on-error'], `${file}/${job}: reporting step must be continue-on-error: true`).toBe(true);
  const w = (s.with ?? {}) as Record<string, string>;
  expect(w.source).toBe(expected.source);
  expect(w.alertname).toBe(expected.alertname);
  expect(w.severity).toBe('critical');
  expect(String(w.released_sha), `${file}/${job}: released_sha must come from ${expected.releasedFrom}`)
    .toContain(expected.releasedFrom);
  expect(String(w.run_id)).toContain('github.run_id');
  expect(String(w.run_url)).toMatch(/actions\/runs\/\$\{\{\s*github\.run_id\s*\}\}/);
  expect(String(w.job_name)).toContain('github.job');
  expect(String(w.workflow_name)).toContain('github.workflow');
  expect(String(w.detail).trim().length, `${file}/${job}: detail must carry the failing context`).toBeGreaterThan(0);
  expect(String(w.step_outcomes)).toContain('toJSON(steps)');
  expect(String(w.intake_secret)).toBe(`\${{ secrets.${SECRET_NAME} }}`);
  // The fleet id is the action's default; a caller must not reroute the row.
  if (w.target_task_id !== undefined) expect(w.target_task_id).toBe(FLEET_TASK_ID);
};

describe('a failed post-deploy verification reaches the alert store', () => {
  it('one reusable composite action exists with the inputs the callers rely on', () => {
    expect(existsSync(join(ROOT, ACTION_PATH)), `${ACTION_PATH} is missing`).toBe(true);
    const action = load<Action>(ACTION_PATH);
    expect(action.runs.using).toBe('composite');
    for (const name of ['source', 'alertname', 'severity', 'released_sha', 'run_id', 'run_url', 'detail']) {
      expect(action.inputs, `input ${name} is missing`).toHaveProperty(name);
    }
    expect(action.inputs.source.required).toBe(true);
    expect(action.inputs.alertname.required).toBe(true);
    expect(action.inputs.severity.default).toBe('critical');
    expect(action.inputs.intake_url.default).toBe(INTAKE_URL);
    expect(action.inputs.target_task_id.default).toBe(FLEET_TASK_ID);
    // `secrets` is unreadable inside a composite action; the caller passes it in.
    expect(action.inputs).toHaveProperty('intake_secret');
  });

  it('the action posts with curl, bounded, authorized by bearer, and never fails the job', () => {
    const action = load<Action>(ACTION_PATH);
    const deliver = action.runs.steps.find((s) => typeof s.run === 'string');
    expect(deliver, 'the action has no run step').toBeDefined();
    const run = String((deliver as Step).run);
    expect((deliver as Step).shell).toBe('bash');
    expect((deliver as Step)['continue-on-error']).toBe(true);
    expect(run).toMatch(/curl\b/);
    expect(run).toMatch(/--max-time 20\b/);
    expect(run).toMatch(/--retry 3\b/);
    expect(run).toMatch(/-H "Authorization: Bearer \$\{INTAKE_SECRET\}"/);
    expect(run).toMatch(/-X POST "\$INTAKE_URL"/);
    // The body the intake validates: source, alertname, status firing, severity, payload.
    for (const field of ['source: $source', 'alertname: $alertname', 'status: "firing"', 'severity: $severity', 'payload: {']) {
      expect(run, `payload is missing ${field}`).toContain(field);
    }
    for (const field of ['target_task_id', 'released_sha', 'workflow', 'job', 'run_id', 'run_url', 'failed_steps', 'detail']) {
      expect(run, `payload is missing ${field}`).toMatch(new RegExp(`^\\s+${field}: \\$`, 'm'));
    }
    // Prints the intake's receipt id(s).
    expect(run).toMatch(/intake id\(s\)/);
    // Never `set -e`, never a non-zero exit, never a traced secret. Judged on
    // the code, not the comments that explain the rule.
    const code = run.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    expect(code).not.toMatch(/set -e\b|set -euo|set -x/);
    expect(code).not.toMatch(/exit [1-9]/);
    expect(run.trimEnd().endsWith('exit 0')).toBe(true);
    // An unconfigured secret skips loudly instead of failing.
    expect(run).toMatch(/::warning[^\n]*WORLD_HUB_ALERT_INTAKE_SECRET is not set/);
  });

  it('both post-deploy-e2e jobs report a failed verification', () => {
    const file = '.github/workflows/post-deploy-e2e.yml';
    const wf = load<Workflow>(file);
    for (const job of ['production-e2e', 'live-table-e2e']) {
      const steps = wf.jobs[job]?.steps ?? [];
      expect(steps.length, `${file} has no job ${job}`).toBeGreaterThan(0);
      const [step, ...extra] = reportingSteps(steps);
      expect(extra, `${file}/${job}: one reporting step, not several`).toEqual([]);
      expectReportingStep(file, job, step, {
        source: 'ci.post-deploy-e2e',
        alertname: 'PostDeployVerificationFailed',
        releasedFrom: 'steps.live.outputs.sha',
      });
      // The `live` step is what resolves the released commit; it must still exist.
      expect(steps.some((s) => s.id === 'live'), `${file}/${job}: the live step is gone`).toBe(true);
      // The evidence upload beside it is intact and on the same non-verdict condition.
      const upload = steps.find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact'));
      expect(upload, `${file}/${job}: the report upload is gone`).toBeDefined();
      expect(String((upload as Step).if)).toBe('always() && (failure() || cancelled())');
      expect(String((step as Step).if)).toContain('always() && (failure() || cancelled())');
    }
  });

  it('deploy-monitoring reports a failed monitoring deploy', () => {
    const file = '.github/workflows/deploy-monitoring.yml';
    const wf = load<Workflow>(file);
    const steps = wf.jobs.deploy?.steps ?? [];
    expect(steps.length, `${file} has no deploy job`).toBeGreaterThan(0);
    const [step, ...extra] = reportingSteps(steps);
    expect(extra, `${file}/deploy: one reporting step, not several`).toEqual([]);
    expectReportingStep(file, 'deploy', step, {
      source: 'ci.deploy-monitoring',
      alertname: 'MonitoringDeployFailed',
      releasedFrom: 'steps.target.outputs.sha',
    });
    expect(steps.some((s) => s.id === 'target'), `${file}/deploy: the target step is gone`).toBe(true);
    // The credential sweep still runs unconditionally and is not delayed by reporting.
    const sweep = steps.findIndex((s) => s.name === 'Remove Hetzner SSH credentials');
    expect(sweep).toBeGreaterThanOrEqual(0);
    expect(String(steps[sweep].if)).toBe('always()');
    expect(steps.indexOf(step as Step)).toBeGreaterThan(sweep);
  });

  it('no caller reaches World Hub with any other secret name', () => {
    for (const file of ['.github/workflows/post-deploy-e2e.yml', '.github/workflows/deploy-monitoring.yml']) {
      const body = read(file);
      const secrets = [...body.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
      expect(secrets, `${file} passes an intake secret under a different name`).toContain(SECRET_NAME);
      expect(body).not.toMatch(/CRON_SECRET/);
    }
  });
});
