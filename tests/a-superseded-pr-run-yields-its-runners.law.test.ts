/**
 * LAW: A SUPERSEDED PULL REQUEST RUN YIELDS ITS RUNNERS; A PRODUCTION RUN NEVER DOES
 * (2026-10-25).
 *
 * Measured 2026-10-24 21:02Z to 2026-10-25 03:02Z: 1,767 workflow runs, 12,303
 * runner-minutes, ~146 runs queued behind the hosted-runner cap at the worst
 * point, and the median CI job waited 22 minutes for a runner (p90 46). The
 * Club Arena publisher sat queued for 1.5 hours and Apply Merged Migration
 * dispatches waited 20+ minutes behind that queue.
 *
 * In those six hours 118 heavy ci.yml jobs STARTED after their pull request
 * head had already been replaced, using 1,099 runner-minutes on commits nobody
 * would merge. ci.yml cannot simply cancel in progress: its group is keyed on
 * the head sha on purpose (six PRs were once stranded by a required check left
 * `cancelled` on their head, see ci.yml and ci-tells-the-truth-faster.law).
 * So each heavy job checks once, when it finally holds a runner, and cancels
 * its own run only when a newer run for the newer head is proven
 * (scripts/ci/yield-superseded-pr-ci.mjs).
 *
 * This law pins four things:
 *   1. every pull_request / pull_request_target workflow lets a newer push to
 *      the same PR replace an older run - by cancel-in-progress keyed per PR, or,
 *      for the two named exceptions, by the mechanism written down for them;
 *   2. nothing that publishes, deploys, stages, applies a migration or records
 *      production evidence can be cancelled mid-run;
 *   3. the yield step sits in exactly the heavy ci.yml jobs, right after
 *      Checkout, and never in a fast gate or a required aggregator;
 *   4. the yield itself only ever cancels a proven-obsolete run of its own.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Native workflow script is tested through its public operation.
import { yieldIfSuperseded } from '../scripts/ci/yield-superseded-pr-ci.mjs';

const root = resolve(__dirname, '..');
const dir = resolve(root, '.github/workflows');
type Concurrency = { group?: string; 'cancel-in-progress'?: boolean | string };
type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
};
type Job = { concurrency?: Concurrency; permissions?: Record<string, string>; steps?: Step[] };
type Workflow = {
  on?: unknown;
  true?: unknown;
  concurrency?: Concurrency | string;
  jobs?: Record<string, Job>;
};

const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
const text = (file: string) => readFileSync(resolve(dir, file), 'utf8');
const load = (file: string): Workflow => parse(text(file));
const triggers = (wf: Workflow): string[] => {
  const on = wf.on ?? wf.true;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on as string[];
  return Object.keys((on as Record<string, unknown>) ?? {});
};
const prTriggered = (wf: Workflow) =>
  triggers(wf).some((t) => t === 'pull_request' || t === 'pull_request_target');

// The two pull-request workflows that must NOT cancel a run in progress, and
// what they do instead. Adding a name here needs the same kind of reason.
const PR_EXCEPTIONS: Record<string, string> = {
  'ci.yml':
    'Required checks. Group keyed on the head sha with cancel-in-progress false (a cancelled ' +
    'head stranded six PRs). Superseded runs yield from inside each heavy job instead.',
  'money-trigger-recovery.yml':
    'Its trusted reporter opens and closes the required "Money trigger declaration authority" ' +
    'check run; a cancel between the two would strand that check. One group per head sha.',
};

// Workflows that change production, or record evidence of it. None may be
// cancelled mid-run, at workflow or job level, by any expression.
const NEVER_CANCEL = [
  'publish-club-arena.yml',
  'apply-merged-migration.yml',
  'stage-engine-release.yml',
  'auto-deploy-hetzner.yml',
  'post-deploy-e2e.yml',
  'deploy-monitoring.yml',
  'applied-migrations-recorded.yml',
  'money-trigger-recovery.yml',
  'engine-drill.yml',
  'engine-rollback-drill.yml',
  'main-rewind-guard.yml',
];

describe('a newer push to a pull request replaces its older runs', () => {
  const prFiles = files.filter((f) => prTriggered(load(f)));

  it('found the pull-request workflows', () => {
    expect(prFiles.length).toBeGreaterThan(40);
    for (const f of Object.keys(PR_EXCEPTIONS)) expect(prFiles).toContain(f);
  });

  it.each(prFiles.filter((f) => !(f in PR_EXCEPTIONS)))(
    '%s cancels a superseded run of the same pull request',
    (file) => {
      const wf = load(file);
      const c = wf.concurrency;
      expect(c && typeof c === 'object', `${file} declares no workflow concurrency`).toBe(true);
      const { group = '', 'cancel-in-progress': cancel } = c as Concurrency;
      // pull_request_target runs on the BASE ref, so github.ref would put every
      // pull request in one group and let them cancel each other.
      if (triggers(wf).includes('pull_request_target'))
        expect(group, file).toContain('github.event.pull_request.number');
      else expect(group, file).toMatch(/github\.ref|github\.event\.pull_request\.number/);
      expect(
        cancel === true ||
          (typeof cancel === 'string' && /github\.event_name == 'pull_request'/.test(cancel)),
        `${file} must cancel superseded pull request runs`
      ).toBe(true);
    }
  );

  it('keeps ci.yml on its head-sha group and never cancels in progress', () => {
    const c = load('ci.yml').concurrency as Concurrency;
    expect(c.group).toContain('github.event.pull_request.head.sha');
    expect(c['cancel-in-progress']).toBe(false);
  });

  it('keeps the Money trigger reporter on one never-cancelled group per head sha', () => {
    const c = load('money-trigger-recovery.yml').concurrency as Concurrency;
    expect(c.group).toContain('github.event.pull_request.head.sha');
    expect(c['cancel-in-progress']).toBe(false);
  });

  it('keeps the production half of a mixed workflow out of the cancelling group', () => {
    const op = load('operational-alert-addressing.yml').concurrency as Concurrency;
    expect(op.group).toContain("github.event_name == 'workflow_run' && 'live'");
    expect(op['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
    const eta = load('explicit-table-access.yml').concurrency as Concurrency;
    expect(eta.group).toContain('github.sha');
    expect(eta['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });
});

describe('nothing that changes production is cancelled mid-run', () => {
  const never = (c: Concurrency | string | undefined, where: string) => {
    if (c && typeof c === 'object' && 'cancel-in-progress' in c)
      expect(c['cancel-in-progress'], where).toBe(false);
  };

  it.each(NEVER_CANCEL)('%s never cancels in progress, at workflow or job level', (file) => {
    const wf = load(file);
    never(wf.concurrency, file);
    for (const [name, job] of Object.entries(wf.jobs ?? {}))
      never(job.concurrency, `${file}:${name}`);
    expect(triggers(wf), `${file} must not inherit the pull_request rule`).not.toContain(
      'pull_request'
    );
  });

  it('every auto-deploy and post-deploy workflow either never cancels or is a credential-free PR replay', () => {
    // maintenance-window-migrations.yml and post-deploy-verdict-rules.yml carry
    // production-sounding names but only replay their decision rules on a pull
    // request, against a throwaway native database or fixtures, with no secret.
    // The real window apply is stage-engine-release.yml's window-migrations job
    // and the real verification is post-deploy-e2e.yml, both pinned above.
    const named = files.filter((f) =>
      /^(auto-deploy-|post-deploy-|maintenance-window-migrations)/.test(f)
    );
    expect(named).toEqual(
      expect.arrayContaining([
        'auto-deploy-hetzner.yml',
        'post-deploy-e2e.yml',
        'post-deploy-verdict-rules.yml',
        'maintenance-window-migrations.yml',
      ])
    );
    for (const file of named) {
      const wf = load(file);
      const cancels = [
        wf.concurrency,
        ...Object.values(wf.jobs ?? {}).map((j) => j.concurrency),
      ].some(
        (c) =>
          c &&
          typeof c === 'object' &&
          c['cancel-in-progress'] !== false &&
          c['cancel-in-progress'] !== undefined
      );
      if (!cancels) continue;
      expect(triggers(wf), `${file} cancels, so it must be a pull_request-only replay`).toEqual([
        'pull_request',
      ]);
      expect(text(file), `${file} cancels, so it must hold no credential`).not.toMatch(/secrets\./);
    }
  });

  it('the daily window apply inside stage-engine-release never cancels', () => {
    const job = load('stage-engine-release.yml').jobs!['window-migrations'];
    expect(job.concurrency).toEqual({
      group: 'daily-maintenance-window-migrations',
      'cancel-in-progress': false,
    });
  });
});

describe('a heavy ci.yml job yields when its sha is no longer the head', () => {
  const ci = load('ci.yml');
  const YIELD = 'Yield if this sha is no longer the pull request head';
  const HEAVY = [
    'unit_shards',
    'accounting_postgres',
    'server_shards',
    'build',
    'css-beats-e2e',
    'diamond-playfield-e2e',
  ];

  it.each(HEAVY)('%s yields right after Checkout, with write access to its own run', (name) => {
    const job = ci.jobs![name];
    const steps = job.steps!;
    const at = steps.findIndex((s) => s.name === YIELD);
    expect(at, `${name} has no yield step`).toBeGreaterThan(0);
    expect(steps[at - 1].uses).toMatch(/^actions\/checkout@/);
    expect(steps.filter((s) => s.name === YIELD)).toHaveLength(1);
    const step = steps[at];
    // No `if`: the script itself does nothing outside a pull_request run, and an
    // accounting setup step must run in every shard.
    expect(step.if).toBeUndefined();
    expect(step.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(step.run).toBe('node "$GITHUB_WORKSPACE/scripts/ci/yield-superseded-pr-ci.mjs"');
    expect(job.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      actions: 'write',
    });
  });

  it('no fast gate or required aggregator carries it', () => {
    for (const [name, job] of Object.entries(ci.jobs!)) {
      if (HEAVY.includes(name)) continue;
      expect(
        (job.steps ?? []).some((s) => s.name === YIELD || /yield-superseded/.test(s.run ?? '')),
        name
      ).toBe(false);
    }
  });
});

describe('the yield cancels only a proven-obsolete run of its own', () => {
  const repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
  const sha = (c: string) => c.repeat(40);
  const base = {
    eventName: 'pull_request',
    repository,
    runId: 500,
    prNumber: 9,
    headSha: sha('a'),
  };
  function world({
    prHead = [sha('b')],
    successors = [{ id: 600, head_sha: sha('b'), pr: 9 }],
    state = 'open',
    headRepo = repository,
    runPath = '.github/workflows/ci.yml',
  }: {
    prHead?: string[];
    successors?: { id: number; head_sha: string; pr: number; workflow_id?: number }[];
    state?: string;
    headRepo?: string;
    runPath?: string;
  } = {}) {
    const writes: string[] = [];
    const reads: string[] = [];
    let prReads = 0;
    const request = async (method: string, path: string) => {
      if (method === 'POST') {
        writes.push(path);
        return {};
      }
      reads.push(path);
      if (path.endsWith('/actions/runs/500'))
        return {
          id: 500,
          event: 'pull_request',
          head_sha: sha('a'),
          path: runPath,
          workflow_id: 7,
          pull_requests: [{ number: 9 }],
        };
      if (path.endsWith('/pulls/9')) {
        const head = prHead[Math.min(prReads++, prHead.length - 1)];
        return {
          state,
          head: { sha: head, repo: { full_name: headRepo } },
          base: { repo: { full_name: repository } },
        };
      }
      if (path.includes('/actions/workflows/7/runs?'))
        return {
          workflow_runs: successors.map((s) => ({
            id: s.id,
            workflow_id: s.workflow_id ?? 7,
            event: 'pull_request',
            head_sha: s.head_sha,
            pull_requests: [{ number: s.pr }],
          })),
        };
      throw new Error(`Unexpected request ${method} ${path}`);
    };
    return { writes, reads, request };
  }
  const run = (w: ReturnType<typeof world>, extra = {}) =>
    yieldIfSuperseded({ ...base, request: w.request, log: () => {}, ...extra });

  it('does nothing at all outside a pull_request run', async () => {
    const w = world();
    expect(await run(w, { eventName: 'schedule' })).toMatchObject({ yielded: false });
    expect(w.reads).toEqual([]);
    expect(w.writes).toEqual([]);
  });

  it('keeps running while this sha is the pull request head', async () => {
    const w = world({ prHead: [sha('a')] });
    expect(await run(w)).toMatchObject({ yielded: false, reason: 'still-the-pull-request-head' });
    expect(w.writes).toEqual([]);
  });

  it('keeps running until the new head has its own newer run', async () => {
    for (const successors of [
      [],
      [{ id: 400, head_sha: sha('b'), pr: 9 }],
      [{ id: 600, head_sha: sha('b'), pr: 10 }],
      [{ id: 600, head_sha: sha('c'), pr: 9 }],
      [{ id: 600, head_sha: sha('b'), pr: 9, workflow_id: 8 }],
    ]) {
      const w = world({ successors });
      expect(await run(w)).toMatchObject({ yielded: false });
      expect(w.writes).toEqual([]);
    }
  });

  it('never acts for a fork, a closed pull request or a moving head', async () => {
    for (const w of [
      world({ headRepo: 'someone/fork' }),
      world({ state: 'closed' }),
      world({ prHead: [sha('b'), sha('c')] }),
      world({ prHead: [sha('b'), sha('a')] }),
    ]) {
      expect(await run(w)).toMatchObject({ yielded: false });
      expect(w.writes).toEqual([]);
    }
  });

  it('refuses an identity it cannot prove, before any write', async () => {
    const w = world({ runPath: '.github/workflows/other.yml' });
    await expect(run(w)).rejects.toThrow('expected PR workflow identity');
    await expect(run(world(), { headSha: 'not-a-sha' })).rejects.toThrow('identity is invalid');
    expect(w.writes).toEqual([]);
  });

  it('cancels then force-cancels only its own run once the successor is proven', async () => {
    const w = world();
    expect(await run(w)).toEqual({
      yielded: true,
      reason: 'superseded',
      successor: 600,
      head: sha('b'),
    });
    expect(w.writes).toEqual([
      `/repos/${repository}/actions/runs/500/cancel`,
      `/repos/${repository}/actions/runs/500/force-cancel`,
    ]);
    // The head is read twice: once to decide, once immediately before the write.
    expect(w.reads.filter((p) => p.endsWith('/pulls/9'))).toHaveLength(2);
  });

  it('fails open: the entry point turns any error into a warning and keeps the job', () => {
    const src = readFileSync(resolve(root, 'scripts/ci/yield-superseded-pr-ci.mjs'), 'utf8');
    expect(src).toContain("if (eventName !== 'pull_request') return;");
    expect(src).toMatch(/main\(\)\.catch\(\(error\) => \{\s*console\.log\(\s*`::warning::/);
    expect(src).not.toMatch(/process\.exit\(|exitCode\s*=/);
  });
});

describe('explicit table access runs when its answer can change', () => {
  it('triggers on every migration and on every file its checker reads', () => {
    const on = load('explicit-table-access.yml').on as Record<string, { paths?: string[] }>;
    const checker = readFileSync(
      resolve(root, 'scripts/ci/check-explicit-table-access.mjs'),
      'utf8'
    );
    expect(checker).toContain("'--', 'supabase/migrations'");
    const imports = [...checker.matchAll(/from '\.\/([^']+)'/g)].map((m) => `scripts/ci/${m[1]}`);
    expect(imports).toContain('scripts/ci/recording-only.mjs');
    for (const event of ['pull_request', 'push']) {
      const paths = on[event].paths!;
      for (const p of [
        'supabase/migrations/**',
        'scripts/ci/check-explicit-table-access.mjs',
        'scripts/ci/recorded-migrations.manifest.json',
        'tests/explicit-table-access.test.mjs',
        '.github/workflows/explicit-table-access.yml',
        ...imports,
      ])
        expect(paths, `${event} misses ${p}`).toContain(p);
    }
  });

  it('is not a required check, so a path filter cannot strand a pull request', () => {
    const required = readFileSync(resolve(root, 'scripts/ci/apply-main-ruleset.mjs'), 'utf8');
    expect(required).not.toMatch(/Explicit table access|explicit-access/);
  });
});
