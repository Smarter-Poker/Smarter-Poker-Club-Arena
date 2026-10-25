/**
 * SUPERSEDED CI STOPS AT THE PUSH (2026-10-25).
 *
 * Measured 2026-10-24/25: the account sat at ~176-203 queued runs with ~20
 * jobs running, and `Publish Club Arena` published nothing from 21:16 to
 * ~23:15 UTC because each of its stages waited 20-45 minutes for a runner.
 * Over 300 pull-request CI runs (2026-10-23 22:07 to 2026-10-25 03:36 UTC),
 * 124 were superseded while still alive; in a 70-run sample 46% of their
 * runner time (2,272 runner-seconds per run) was spent after a newer push of
 * the same branch already existed. ci.yml's own retire step only acted once
 * the NEW run's `changes` job got a runner - after that same queue wait.
 *
 * What this pins:
 *  1. ci-supersede.yml joins ci.yml's group for the REPLACED head and cancels
 *     it when the event arrives, with no runner, no permissions and no code.
 *  2. ci.yml's own group still cannot cancel the run for the current head.
 *  3. ci.yml's heavy jobs stop in a cancelled run (`!cancelled()`), while every
 *     required aggregate keeps `always()`, so a cancelled run reports red and
 *     never skipped-as-green.
 *  4. Every other pull-request workflow cancels its superseded run per PR,
 *     and no production writer cancels at all.
 *  5. A docs-only pull request runs none of the heavy suites, and the ungated
 *     repository checks still run for it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
// @ts-expect-error Native classifier module, exercised through its export.
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

type Job = {
  name?: string;
  if?: string;
  needs?: string | string[];
  uses?: string;
  steps?: { uses?: string; run?: string }[];
};
type Workflow = {
  on?: unknown;
  true?: unknown;
  permissions?: unknown;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean | string } | string;
  jobs: Record<string, Job>;
};

const root = resolve(__dirname, '..');
const dir = resolve(root, '.github/workflows');
const text = (file: string) => readFileSync(resolve(dir, file), 'utf8');
const load = (file: string): Workflow => parse(text(file));
const squash = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const triggers = (wf: Workflow) => {
  const on = (wf.on ?? wf.true) as unknown;
  if (typeof on === 'string') return { [on]: null } as Record<string, unknown>;
  if (Array.isArray(on)) return Object.fromEntries(on.map((t) => [t, null]));
  return (on ?? {}) as Record<string, unknown>;
};
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
const ci = load('ci.yml');
const helper = load('ci-supersede.yml');

const CI_GROUP =
  'ci-${{ github.event.pull_request.number || github.ref }}-${{ github.event.pull_request.head.sha || github.sha }}';
const HELPER_GROUP =
  "ci-${{ github.event.pull_request.number }}-${{ github.event.action == 'synchronize' && github.event.before || github.event.pull_request.head.sha }}";

// The ruleset's own list, read from where it is applied.
const REQUIRED = [
  ...readFileSync(resolve(root, 'scripts/ci/apply-main-ruleset.mjs'), 'utf8')
    .match(/const REQUIRED_CHECKS = \[([\s\S]*?)\];/)![1]
    .matchAll(/'([^']+)'/g),
].map((m) => m[1]);

describe('a replaced pull request head is cancelled when the event arrives', () => {
  it('runs only on the two events that replace or retire a head', () => {
    expect(triggers(helper)).toEqual({
      pull_request: { branches: ['main'], types: ['synchronize', 'closed'] },
    });
  });

  it('joins the group of the replaced head, never the current one', () => {
    const c = helper.concurrency as { group: string; 'cancel-in-progress': boolean };
    expect(c.group).toBe(HELPER_GROUP);
    expect(c['cancel-in-progress']).toBe(true);
    // On a synchronize the replaced head is `before`; the head after the push
    // is never in that group.
    expect(c.group).toContain("github.event.action == 'synchronize' && github.event.before");
  });

  it('names exactly the group ci.yml uses for a pull request event', () => {
    const c = ci.concurrency as { group: string; 'cancel-in-progress': boolean };
    expect(c.group).toBe(CI_GROUP);
    // Rendered for PR 42: both resolve to ci-42-<sha> for the same sha.
    const sha = 'b'.repeat(40);
    const ciRendered = CI_GROUP.replace(
      '${{ github.event.pull_request.number || github.ref }}',
      '42'
    ).replace('${{ github.event.pull_request.head.sha || github.sha }}', sha);
    const helperRendered = HELPER_GROUP.replace(
      '${{ github.event.pull_request.number }}',
      '42'
    ).replace(
      "${{ github.event.action == 'synchronize' && github.event.before || github.event.pull_request.head.sha }}",
      sha
    );
    expect(helperRendered).toBe(ciRendered);
    expect(ciRendered).toBe(`ci-42-${sha}`);
  });

  it('keeps ci.yml unable to cancel the run for the current head', () => {
    expect((ci.concurrency as Record<string, unknown>)['cancel-in-progress']).toBe(false);
  });

  it('holds no permissions, runs no job, checks out nothing and reads no secret', () => {
    expect(helper.permissions).toEqual({});
    const jobs = Object.values(helper.jobs);
    expect(jobs.length).toBe(1);
    for (const job of jobs) {
      expect(squash(job.if)).toBe('${{ false }}');
      expect(job.uses).toBeUndefined();
      for (const step of job.steps ?? []) expect(step.uses).toBeUndefined();
    }
    expect(text('ci-supersede.yml')).not.toMatch(/secrets\.|github\.token|GH_TOKEN/);
  });

  it('is the only other workflow that names a ci- group, so it cannot reach a writer', () => {
    const others = files.filter((f) => {
      if (f === 'ci.yml' || f === 'ci-supersede.yml') return false;
      const c = load(f).concurrency;
      const group = typeof c === 'string' ? c : c?.group;
      return typeof group === 'string' && group.startsWith('ci-');
    });
    expect(others).toEqual([]);
  });
});

describe('a cancelled CI run stops its heavy work and still reports red', () => {
  const HEAVY = [
    'fixture_native',
    'unit_shards',
    'accounting_postgres',
    'server_shards',
    'css-beats-e2e',
    'diamond-playfield-e2e',
  ];

  it('gates every heavy job on !cancelled(), so it does not start in a cancelled run', () => {
    for (const id of HEAVY) expect(squash(ci.jobs[id].if), id).toMatch(/^!cancelled\(\) && /);
  });

  it('keeps every required aggregate on always(), so a cancelled run is red, not skipped', () => {
    for (const name of REQUIRED) {
      const carriers = Object.values(ci.jobs).filter((job) => job.name === name);
      expect(carriers.length, name).toBe(1);
      expect(squash(carriers[0].if), name).toMatch(/^always\(\)/);
    }
  });

  it('runs nothing else on always()', () => {
    const allowed = new Set([...REQUIRED, 'What this run verified']);
    const extra = Object.entries(ci.jobs)
      .filter(([, job]) => squash(job.if).includes('always()'))
      .filter(([, job]) => !allowed.has(job.name ?? ''))
      .map(([id]) => id);
    expect(extra).toEqual([]);
  });

  it('still runs a heavy job when the classifier itself did not succeed', () => {
    for (const id of HEAVY)
      expect(squash(ci.jobs[id].if), id).toContain("needs.changes.result != 'success'");
  });
});

describe('every other pull request workflow cancels its superseded run per PR', () => {
  // ci.yml: keyed on the head sha on purpose; ci-supersede.yml cancels for it.
  // money-trigger-recovery.yml: the trusted reporter of a required check,
  // keyed on the head sha with its own environment; never cancelled.
  const EXEMPT = new Set(['ci.yml', 'ci-supersede.yml', 'money-trigger-recovery.yml']);
  const prWorkflows = files.filter((f) => {
    const t = triggers(load(f));
    return 'pull_request' in t || 'pull_request_target' in t;
  });

  it('finds the pull request workflows', () => {
    expect(prWorkflows.length).toBeGreaterThan(40);
  });

  for (const file of prWorkflows.filter((f) => !EXEMPT.has(f))) {
    it(`${file} cancels its superseded pull request run, per PR`, () => {
      const wf = load(file);
      const c = wf.concurrency;
      expect(c && typeof c === 'object', file).toBe(true);
      const conc = c as { group: string; 'cancel-in-progress': boolean | string };
      const cancel = conc['cancel-in-progress'];
      // agent-autopilot.yml (#8012): its `closed` run is what dispatches a
      // merged migration, so it sits in its own `-merged` group and is never
      // cancelled; every other event of the PR is.
      const autopilotMerged =
        file === 'agent-autopilot.yml' &&
        typeof cancel === 'string' &&
        squash(cancel) === "${{ github.event.action != 'closed' }}" &&
        /-merged/.test(conc.group);
      expect(
        cancel === true ||
          autopilotMerged ||
          (typeof cancel === 'string' &&
            squash(cancel) === "${{ github.event_name == 'pull_request' }}"),
        file
      ).toBe(true);
      // pull_request_target runs with github.ref = the base branch, so only the
      // PR number keeps one PR from cancelling another's run.
      const perPr =
        'pull_request_target' in triggers(wf)
          ? /github\.event\.pull_request\.number/
          : /github\.ref|github\.event\.pull_request\.number|github\.head_ref/;
      expect(conc.group, file).toMatch(perPr);
    });
  }

  it('never cancels the publisher, a deploy, a migration or the money reporter', () => {
    for (const file of [
      'publish-club-arena.yml',
      'auto-deploy-hetzner.yml',
      'apply-merged-migration.yml',
      'deploy-monitoring.yml',
      'money-trigger-recovery.yml',
    ]) {
      const c = load(file).concurrency as Record<string, unknown>;
      expect(c['cancel-in-progress'], file).toBe(false);
    }
    expect((load('publish-club-arena.yml').concurrency as Record<string, unknown>).group).toBe(
      'publish-club-arena-production'
    );
  });
});

describe('a docs-only pull request runs no heavy suite', () => {
  const NONE = { src: false, server: false, tests: false, phase4: false, fixture: false };

  it.each([
    ['docs/changelog/2026-10-25-anything.md'],
    ['docs/club-operations/OPERATIONS-UPGRADE-PLAN.md'],
    ['CLAUDE.md', 'PUBLISHING.md', 'README.md'],
    ['docs/changelog/2026-10-25-a.md', 'docs/notes.md', 'AGENTS.md'],
  ])('%s classifies as touching nothing a heavy suite reads', (...paths) => {
    expect(classifyChangedPaths(paths)).toEqual(NONE);
  });

  it('still runs the suites that read docs/laws.d and docs/evidence', () => {
    expect(classifyChangedPaths(['docs/laws.d/x.md']).tests).toBe(true);
    expect(classifyChangedPaths(['docs/evidence/phase13/x.json'])).toMatchObject({
      server: true,
      tests: true,
    });
  });

  it.each([
    ['src/App.tsx', 'src'],
    ['tests/unit/anything.test.ts', 'tests'],
    ['server/src/index.ts', 'server'],
    ['supabase/migrations/20261025000000_x.sql', 'server'],
    ['.github/workflows/ci.yml', 'tests'],
  ])('%s still admits the suites that read it', (path, flag) => {
    expect(classifyChangedPaths([path, 'docs/changelog/x.md'])[flag]).toBe(true);
  });

  it('skips each heavy job only on the flags the docs-only answer leaves false', () => {
    expect(squash(ci.jobs.unit_shards.if)).toContain(
      "needs.changes.outputs.src == 'true' || needs.changes.outputs.tests == 'true'"
    );
    for (const id of ['accounting_postgres', 'server_shards'])
      expect(squash(ci.jobs[id].if), id).toContain("needs.changes.outputs.server == 'true'");
    for (const id of ['build', 'css-beats-e2e', 'diamond-playfield-e2e', 'css-beats-gate'])
      expect(squash(ci.jobs[id].if), id).toContain("needs.changes.outputs.src == 'true'");
    expect(squash(ci.jobs.fixture_native.if)).toContain("needs.changes.outputs.fixture != 'false'");
  });

  it('keeps the repository-wide checks ungated by the diff', () => {
    for (const id of ['typecheck_compile', 'typecheck', 'source_windows', 'stub_gate'])
      expect(squash(ci.jobs[id].if), id).not.toContain('needs.changes.outputs');
  });
});
