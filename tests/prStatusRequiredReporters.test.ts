import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  commitState,
  readPages,
  requiredContextProblems,
  stateForChecks,
} from '../scripts/ci/pr-status.mjs';

const sha = 'a'.repeat(40);
const authority = 4962039;
const required = new Map([['Money trigger declaration authority', new Set([authority])]]);
const check = (extra = {}) => ({
  id: 10,
  name: 'Money trigger declaration authority',
  head_sha: sha,
  app: { id: authority, slug: 'trusted-fixture' },
  status: 'completed',
  conclusion: 'success',
  ...extra,
});
const verdict = (checks) => requiredContextProblems(required, checks, sha);

describe('required standalone verdicts retain source and reporter authority', () => {
  it('observes a standalone App success without any Actions workflow', async () => {
    const calls: string[] = [];
    const st = await commitState(sha, required, async (path) => {
      calls.push(path);
      if (path.startsWith('/actions/runs?')) return { total_count: 0, workflow_runs: [] };
      if (path.startsWith(`/commits/${sha}/check-runs?filter=all`))
        return { total_count: 1, check_runs: [check()] };
      throw Error(`Unexpected request ${path}`);
    });
    expect(st.state).toBe('GREEN');
    expect(st.requiredProblems).toEqual([]);
    expect(calls).toHaveLength(2);
  });
  it('retains the actual failed workflow job and step without accepting a workflow badge', async () => {
    const run = {
      id: 50,
      workflow_id: 4,
      head_sha: sha,
      name: 'CI',
      status: 'completed',
      conclusion: 'failure',
    };
    const job = {
      id: 51,
      run_id: 50,
      head_sha: sha,
      name: check().name,
      status: 'completed',
      conclusion: 'failure',
      steps: [{ name: 'Financial invariants', conclusion: 'failure' }],
    };
    const st = await commitState(sha, required, async (path) => {
      if (path.startsWith('/actions/runs?')) return { total_count: 1, workflow_runs: [run] };
      if (path.includes('/check-runs?'))
        return { total_count: 1, check_runs: [check({ conclusion: 'failure' })] };
      return { total_count: 1, jobs: [job] };
    });
    expect(st.state).toBe('RED');
    expect(st.failures).toMatchObject([
      { job: check().name, step: 'Financial invariants', required: true },
    ]);
  });
  it('refuses a workflow inventory from another commit', async () => {
    await expect(
      commitState(sha, required, async () => ({
        total_count: 1,
        workflow_runs: [{ id: 1, workflow_id: 1, head_sha: 'b'.repeat(40) }],
      }))
    ).rejects.toThrow(/identity/);
  });
  it('does not accept the same name from a foreign reporter', () => {
    expect(verdict([check({ app: { id: 15368, slug: 'foreign-fixture' } })])).toEqual([
      { context: check().name, integrationId: authority, state: 'missing', conclusions: [] },
    ]);
  });
  it.each(['failure', 'cancelled', 'timed_out'])(
    'a newer %s attempt supersedes old success',
    (conclusion) => {
      const problems = verdict([check(), check({ id: 11, conclusion })]);
      expect(problems[0].state).toBe('not_successful');
      expect(stateForChecks({ failures: [], activeRuns: [], requiredProblems: problems })).toBe(
        'RED'
      );
    }
  );
  it.each(['skipped', 'neutral'])(
    'a newer %s verdict is known unexecuted, never green',
    (conclusion) => {
      const problems = verdict([check(), check({ id: 11, conclusion })]);
      expect(problems[0]).toMatchObject({ state: 'not_run', conclusions: [conclusion] });
      expect(stateForChecks({ failures: [], activeRuns: [], requiredProblems: problems })).toBe(
        'NOT_RUN'
      );
      expect(
        stateForChecks({
          failures: [],
          activeRuns: [],
          requiredProblems: [...problems, { state: 'not_successful' }],
        })
      ).toBe('RED');
      expect(
        stateForChecks({
          failures: [],
          activeRuns: [],
          requiredProblems: [...problems, { state: 'missing' }],
        })
      ).toBe('RED');
      expect(stateForChecks({ failures: [], activeRuns: [{}], requiredProblems: problems })).toBe(
        'RUNNING'
      );
    }
  );
  it('a queued trusted attempt cannot borrow an old or foreign success', () => {
    const problems = verdict([
      check(),
      check({ id: 11, status: 'queued', conclusion: null }),
      check({ id: 12, app: { id: 15368, slug: 'foreign-fixture' } }),
    ]);
    expect(problems[0].state).toBe('running');
    expect(stateForChecks({ failures: [], activeRuns: [], requiredProblems: problems })).toBe(
      'RUNNING'
    );
  });
  it('a newer successful attempt supersedes its own prior failure', () => {
    expect(verdict([check({ conclusion: 'failure' }), check({ id: 11 })])).toEqual([]);
  });
  it.each([{ head_sha: 'b'.repeat(40) }, { app: null }, { status: undefined }, { id: undefined }])(
    'refuses missing or wrong source identity: %j',
    (extra) => {
      expect(() => verdict([check(extra)])).toThrow(/identity, reporter or status/);
    }
  );
  it('preserves all reporter constraints when two rules name the same context', () => {
    const both = new Map([[check().name, new Set([authority, 15368])]]);
    expect(requiredContextProblems(both, [check()], sha)).toEqual([
      { context: check().name, integrationId: 15368, state: 'missing', conclusions: [] },
    ]);
  });
  it.each([0, -1])('nonpositive check or App ID %s is unreadable', (id) => {
    const unbound = new Map([[check().name, new Set([null])]]);
    expect(() => requiredContextProblems(unbound, [check({ id })], sha)).toThrow();
    expect(() => requiredContextProblems(unbound, [check({ app: { id } })], sha)).toThrow();
  });
  it.each(['workflow_dispatch', 'workflow_run', 'schedule'])(
    'an Actions %s success does not satisfy a PR rule',
    async (event) => {
      const actionsRequired = new Map([[check().name, new Set([15368])]]);
      const run = {
        id: 50,
        workflow_id: 4,
        check_suite_id: 55,
        head_sha: sha,
        name: 'CI',
        event,
        status: 'completed',
        conclusion: 'success',
      };
      const st = await commitState(sha, actionsRequired, async (path) => {
        if (path.startsWith('/actions/runs?')) return { total_count: 1, workflow_runs: [run] };
        if (path.includes('/check-runs?'))
          return {
            total_count: 1,
            check_runs: [
              check({ app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 55 } }),
            ],
          };
        return { total_count: 0, jobs: [] };
      });
      expect(st.state).toBe('RED');
      expect(st.requiredProblems[0].state).toBe('missing');
    }
  );
  it.each([
    'push',
    'pull_request',
    'pull_request_review',
    'pull_request_target',
    'deployment',
    'deployment_status',
    'merge_group',
  ])('eligible Actions %s can satisfy the exact App rule', async (event) => {
    const run = {
      id: 50,
      workflow_id: 4,
      check_suite_id: 55,
      head_sha: sha,
      name: 'CI',
      event,
      status: 'completed',
      conclusion: 'success',
    };
    const st = await commitState(sha, new Map([[check().name, new Set([15368])]]), async (path) => {
      if (path.startsWith('/actions/runs?')) return { total_count: 1, workflow_runs: [run] };
      if (path.includes('/check-runs?'))
        return {
          total_count: 1,
          check_runs: [
            check({ app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 55 } }),
          ],
        };
      return { total_count: 0, jobs: [] };
    });
    expect(st.state).toBe('GREEN');
  });
  it('an Actions check with no matching run source stays unknown', async () => {
    await expect(
      commitState(sha, required, async (path) =>
        path.startsWith('/actions/runs?')
          ? { total_count: 0, workflow_runs: [] }
          : {
              total_count: 1,
              check_runs: [
                check({ app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 55 } }),
              ],
            }
      )
    ).rejects.toThrow(/workflow source/);
  });
  it('an unbound context cannot hide a failing reporter behind another success', () => {
    const unbound = new Map([[check().name, new Set([null])]]);
    expect(
      requiredContextProblems(
        unbound,
        [
          check(),
          check({ id: 11, app: { id: 15368, slug: 'foreign-fixture' }, conclusion: 'failure' }),
        ],
        sha
      )[0].state
    ).toBe('not_successful');
  });
  it('unreadable rules stay unknown even with an active run', () => {
    expect(stateForChecks({ failures: [], activeRuns: [{}], requiredProblems: null })).toBe(
      'UNKNOWN'
    );
  });
  it('reads a required verdict on the second counted page', async () => {
    const seen: string[] = [];
    const checks = await readPages(
      `/commits/${sha}/check-runs?filter=all`,
      'check_runs',
      async (path) => {
        seen.push(path);
        return {
          total_count: 101,
          check_runs: path.endsWith('page=1')
            ? Array.from({ length: 100 }, (_, id) => check({ id: id + 1, name: 'Other' }))
            : [check({ id: 101 })],
        };
      }
    );
    expect(verdict(checks)).toEqual([]);
    expect(seen).toHaveLength(2);
  });
  it.each([
    {},
    { total_count: 1, check_runs: [] },
    { total_count: 0, check_runs: [check()] },
    { total_count: 1001, check_runs: [] },
    { total_count: 2, check_runs: [check(), check()] },
  ])('rejects malformed, truncated or unbounded pages: %j', async (response) => {
    await expect(
      readPages('/checks?filter=all', 'check_runs', async () => response)
    ).rejects.toThrow();
  });
  it('does not combine changing inventories across pages', async () => {
    let n = 0;
    await expect(
      readPages('/checks?filter=all', 'check_runs', async () =>
        ++n === 1
          ? {
              total_count: 101,
              check_runs: Array.from({ length: 100 }, (_, id) => check({ id: id + 1 })),
            }
          : { total_count: 102, check_runs: [check({ id: 101 })] }
      )
    ).rejects.toThrow(/changing/);
  });
});

// Execute the actual CLI and HTTP response boundary, with no network, repository
// credential or production mutation. An HTTP error must not become GREEN/RUNNING.
const tool = resolve('scripts/ci/pr-status.mjs');
function cli(
  response,
  options: {
    movingHead?: boolean;
    pr?: boolean;
    all?: boolean;
    text?: boolean;
    merged?: boolean;
  } = {}
) {
  const source = `
    process.argv = [process.execPath, ${JSON.stringify(tool)}, ...${JSON.stringify(options.all ? ['--all'] : options.pr || options.movingHead || options.merged ? ['5400'] : ['--sha', sha])}, '--repo', 'fixture/repo', ...${JSON.stringify(options.text ? [] : ['--json'])}];
    let prReads = 0;
    globalThis.fetch = async (url, options) => {
      if (options.method && options.method !== 'GET') throw Error('Observation attempted a mutation');
      if (url.includes('/pulls?')) return new Response(JSON.stringify([{number:5400,head:{sha:'${sha}',ref:'fixture'}}]));
      if (url.endsWith('/pulls/5400')) {
        ++prReads;
        return new Response(JSON.stringify({number:5400, state: prReads > 1 && ${!!options.merged} ? 'closed' : 'open', merged: prReads > 1 && ${!!options.merged}, mergeable_state:'dirty',head:{sha:prReads > 1 && ${!!options.movingHead} ? '${'b'.repeat(40)}' : '${sha}',ref:'fixture'}}));
      }
      if (url.endsWith('/rules/branches/main')) return new Response(JSON.stringify([{type:'required_status_checks',parameters:{required_status_checks:[{context:'Money trigger declaration authority',integration_id:${authority}}]}}]));
      if (url.includes('/actions/runs?')) return new Response(JSON.stringify({total_count:0,workflow_runs:[]}));
      if (url.includes('/check-runs?')) return new Response(JSON.stringify(${JSON.stringify(response.body)}), {status:${response.status},headers:${JSON.stringify(response.headers || {})}});
      throw Error('Unexpected network target');
    };
    await import(${JSON.stringify(`file://${tool}`)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 5000,
    env: { PATH: process.env.PATH, GH_TOKEN: 'local-fixture-only' },
  });
  expect(result.error).toBeUndefined();
  return { exit: result.status, result: options.text ? result.stdout : JSON.parse(result.stdout) };
}
describe('actual read-only CLI response handling', () => {
  it('reports the exact App result through the complete CLI', () => {
    expect(cli({ status: 200, body: { total_count: 1, check_runs: [check()] } })).toMatchObject({
      exit: 0,
      result: { state: 'GREEN', sha, requiredProblems: [] },
    });
  });
  it.each(['skipped', 'neutral'])(
    'reports %s distinctly through the CLI without green exit',
    (conclusion) => {
      const response = {
        status: 200,
        body: { total_count: 1, check_runs: [check({ conclusion })] },
      };
      expect(cli(response)).toMatchObject({ exit: 5, result: { state: 'NOT_RUN' } });
      const merged = cli(response, { merged: true, text: true });
      expect(merged.exit).toBe(5);
      expect(merged.result).toContain('MERGED');
      expect(merged.result).toContain('NOT_RUN');
      expect(merged.result).not.toMatch(/will not merge|BLOCKS MERGE|DIRTY -/);
      expect(cli(response, { merged: true })).toMatchObject({
        exit: 5,
        result: { state: 'NOT_RUN', merged: true, mergeable_state: 'MERGED' },
      });
      expect(cli(response, { all: true, merged: true })).toMatchObject({
        exit: 5,
        result: [{ state: 'NOT_RUN', merged: true, mergeable_state: 'MERGED' }],
      });
      const allText = cli(response, { all: true, merged: true, text: true });
      expect(allText.exit).toBe(5);
      expect(allText.result).toContain('MERGED');
      expect(allText.result).not.toContain('1 open');
    }
  );
  it('a merged PR retains a failed check without predicting an impossible future merge', () => {
    const response = {
      status: 200,
      body: { total_count: 1, check_runs: [check({ conclusion: 'failure' })] },
    };
    const read = cli(response, { merged: true, text: true });
    expect(read.exit).toBe(1);
    expect(read.result).toContain('MERGED');
    expect(read.result).toContain('RED');
    expect(read.result).not.toMatch(/will not merge|BLOCKS MERGE|DIRTY -/);
  });
  it.each([403, 429, 503])('HTTP %s stays UNKNOWN with nonzero exit', (status) => {
    expect(cli({ status, body: { message: 'Unavailable fixture' } })).toMatchObject({
      exit: 3,
      result: { state: 'UNKNOWN' },
    });
  });
  it('a PR changing head while read cannot inherit the earlier head success', () => {
    expect(
      cli({ status: 200, body: { total_count: 1, check_runs: [check()] } }, { movingHead: true })
    ).toMatchObject({
      exit: 3,
      result: { state: 'UNKNOWN', reason: expect.stringContaining('changed head') },
    });
  });
  it('malformed success stays UNKNOWN', () => {
    expect(cli({ status: 200, body: { message: 'no inventory' } })).toMatchObject({
      exit: 3,
      result: { state: 'UNKNOWN' },
    });
  });
});
