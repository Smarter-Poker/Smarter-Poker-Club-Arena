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
  app: { id: authority },
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
    expect(verdict([check({ app: { id: 15368 } })])).toEqual([
      { context: check().name, integrationId: authority, state: 'missing', conclusions: [] },
    ]);
  });
  it.each(['failure', 'cancelled', 'skipped', 'neutral', 'timed_out'])(
    'a newer %s attempt supersedes old success',
    (conclusion) => {
      const problems = verdict([check(), check({ id: 11, conclusion })]);
      expect(problems[0].state).toBe('not_successful');
      expect(stateForChecks({ failures: [], activeRuns: [], requiredProblems: problems })).toBe(
        'RED'
      );
    }
  );
  it('a queued trusted attempt cannot borrow an old or foreign success', () => {
    const problems = verdict([
      check(),
      check({ id: 11, status: 'queued', conclusion: null }),
      check({ id: 12, app: { id: 15368 } }),
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
  it('an unbound context cannot hide a failing reporter behind another success', () => {
    const unbound = new Map([[check().name, new Set([null])]]);
    expect(
      requiredContextProblems(
        unbound,
        [check(), check({ id: 11, app: { id: 15368 }, conclusion: 'failure' })],
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
          ? { total_count: 101, check_runs: Array.from({ length: 100 }, (_, id) => check({ id })) }
          : { total_count: 102, check_runs: [check({ id: 101 })] }
      )
    ).rejects.toThrow(/changing/);
  });
});

// Execute the actual CLI and HTTP response boundary, with no network, repository
// credential or production mutation. An HTTP error must not become GREEN/RUNNING.
const tool = resolve('scripts/ci/pr-status.mjs');
function cli(response, movingHead = false) {
  const source = `
    process.argv = [process.execPath, ${JSON.stringify(tool)}, ...${JSON.stringify(movingHead ? ['5400'] : ['--sha', sha])}, '--repo', 'fixture/repo', '--json'];
    let prReads = 0;
    globalThis.fetch = async (url, options) => {
      if (options.method && options.method !== 'GET') throw Error('Observation attempted a mutation');
      if (url.endsWith('/pulls/5400')) return new Response(JSON.stringify({number:5400,head:{sha:++prReads === 1 ? '${sha}' : '${'b'.repeat(40)}',ref:'fixture'}}));
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
  return { exit: result.status, result: JSON.parse(result.stdout) };
}
describe('actual read-only CLI response handling', () => {
  it('reports the exact App result through the complete CLI', () => {
    expect(cli({ status: 200, body: { total_count: 1, check_runs: [check()] } })).toMatchObject({
      exit: 0,
      result: { state: 'GREEN', sha, requiredProblems: [] },
    });
  });
  it.each([403, 429, 503])('HTTP %s stays UNKNOWN with nonzero exit', (status) => {
    expect(cli({ status, body: { message: 'Unavailable fixture' } })).toMatchObject({
      exit: 3,
      result: { state: 'UNKNOWN' },
    });
  });
  it('a PR changing head while read cannot inherit the earlier head success', () => {
    expect(
      cli({ status: 200, body: { total_count: 1, check_runs: [check()] } }, true)
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
