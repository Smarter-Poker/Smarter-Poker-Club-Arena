import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error Native workflow script is tested through its public operation.
import { retireSupersededPrCi } from '../../scripts/ci/retire-superseded-pr-ci.mjs';

const repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const headSha = 'a'.repeat(40);
function fixture({
  changesHead = false,
  stopsNormally = false,
  fork = false,
  changesBeforeForce = false,
  ignoresForce = false,
} = {}) {
  const current = {
    id: 100,
    workflow_id: 7,
    event: 'pull_request',
    head_sha: headSha,
    path: '.github/workflows/ci.yml',
    pull_requests: [{ number: 9 }],
    status: 'in_progress',
  };
  const obsolete = { ...current, id: 90, head_sha: 'b'.repeat(40) };
  const writes: string[] = [];
  let reads = 0;
  const request = async (method: string, path: string) => {
    if (method === 'POST') {
      writes.push(path);
      return {};
    }
    if (path.endsWith('/pulls/9')) {
      reads++;
      return {
        state: 'open',
        head: {
          sha:
            (changesHead && reads >= 2) || (changesBeforeForce && reads >= 3)
              ? 'c'.repeat(40)
              : headSha,
          repo: { full_name: fork ? 'another/fork' : repository },
        },
        base: { repo: { full_name: repository } },
      };
    }
    if (path.endsWith('/runs/100')) return current;
    if (path.endsWith('/runs/90'))
      return {
        ...obsolete,
        status:
          (stopsNormally && writes.length) ||
          (!ignoresForce && writes.some((p) => p.endsWith('/force-cancel')))
            ? 'completed'
            : 'queued',
      };
    if (path.includes('/workflows/7/runs?'))
      return {
        workflow_runs: [
          current,
          obsolete,
          { ...obsolete, id: 91, head_sha: headSha },
          { ...obsolete, id: 92, pull_requests: [{ number: 10 }] },
          { ...obsolete, id: 93, event: 'push' },
          { ...obsolete, id: 94, workflow_id: 8 },
          { ...obsolete, id: 95, status: 'completed' },
        ],
      };
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  return { writes, request };
}
const run = (f: ReturnType<typeof fixture>) =>
  retireSupersededPrCi({
    repository,
    runId: 100,
    prNumber: 9,
    headSha,
    request: f.request,
    wait: async () => {},
    log: () => {},
  });

describe('current PR event retires only its own obsolete CI', () => {
  it('uses force only when ordinary cancellation did not stop the old run', async () => {
    const f = fixture();
    await run(f);
    expect(f.writes).toEqual([
      `/repos/${repository}/actions/runs/90/cancel`,
      `/repos/${repository}/actions/runs/90/force-cancel`,
    ]);
  });
  it('does not claim completion from an accepted but unconfirmed force request', async () => {
    const f = fixture({ ignoresForce: true });
    await expect(run(f)).rejects.toThrow('has not confirmed terminal cancellation');
  });
  it('allows delayed terminal readback without submitting another cancellation', async () => {
    const f = fixture({ ignoresForce: true });
    const original = f.request;
    let forcedReads = 0;
    f.request = async (method, path) => {
      const result = await original(method, path);
      if (
        method === 'GET' &&
        path.endsWith('/runs/90') &&
        f.writes.some((p) => p.endsWith('/force-cancel'))
      ) {
        forcedReads++;
        return { ...result, status: forcedReads >= 3 ? 'completed' : 'in_progress' };
      }
      return result;
    };
    expect((await run(f)).retired).toEqual([90]);
    expect(f.writes).toHaveLength(2);
  });
  it('never forces a run that stopped normally', async () => {
    const f = fixture({ stopsNormally: true });
    await run(f);
    expect(f.writes).toEqual([`/repos/${repository}/actions/runs/90/cancel`]);
  });
  it('loses cancellation authority when another push becomes current', async () => {
    const f = fixture({ changesHead: true });
    await run(f);
    expect(f.writes).toEqual([]);
  });
  it('rechecks ownership before forcing a still-running older attempt', async () => {
    const f = fixture({ changesBeforeForce: true });
    await run(f);
    expect(f.writes).toEqual([`/repos/${repository}/actions/runs/90/cancel`]);
  });
  it('cannot force when the normal cancellation request itself was not acknowledged', async () => {
    const f = fixture();
    const original = f.request;
    f.request = async (method, path) => {
      if (method === 'POST') throw new Error('transport outcome unknown');
      return original(method, path);
    };
    await expect(run(f)).rejects.toThrow('transport outcome unknown');
    expect(f.writes).toEqual([]);
  });
  it('refuses a run that does not belong to the expected CI workflow', async () => {
    const f = fixture();
    const original = f.request;
    f.request = async (method, path) => {
      const result = await original(method, path);
      return path.endsWith('/runs/100')
        ? { ...result, path: '.github/workflows/production.yml' }
        : result;
    };
    await expect(run(f)).rejects.toThrow('expected PR workflow identity');
    expect(f.writes).toEqual([]);
  });
  it('does not grant a fork cancellation authority', async () => {
    const f = fixture({ fork: true });
    await run(f);
    expect(f.writes).toEqual([]);
  });
  it('does nothing when it cannot establish the current PR state', async () => {
    const f = fixture();
    const original = f.request;
    f.request = async (method, path) => {
      if (path.endsWith('/pulls/9')) throw new Error('unavailable');
      return original(method, path);
    };
    await expect(run(f)).rejects.toThrow('unavailable');
    expect(f.writes).toEqual([]);
  });
  it('is wired to the existing event and retains required failure reporting', () => {
    const ci = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('node scripts/ci/retire-superseded-pr-ci.mjs');
    expect(ci).toContain('actions: write');
    expect(ci).toContain('if: always()');
    expect(ci).toContain('Required $suite checks were unexpectedly skipped.');
    expect(ci).toContain(
      'for dependency in "server:$MATRIX_RESULT" "accounting:$ACCOUNTING_RESULT"'
    );
  });
});
