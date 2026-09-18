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

/**
 * THE HEAVY MATRIX RUNS FOR THE HEAD THAT WILL BE MERGED (2026-09-18).
 *
 * The concurrency group is keyed on the head sha on purpose, so a superseded
 * run is no longer cancelled - which is what stopped six pull requests being
 * stranded by a required check that would never speak again, and what made
 * every push to a branch pay for a complete fan-out. Measured 2026-09-17: 309
 * CI runs across 95 branches, and the five busiest branches ran 34, 28, 17, 15
 * and 13 times each. The account hit its Actions spending limit on 2026-09-18
 * and took the engine release route down with it.
 *
 * So the heavy jobs now ask whether this sha is still the pull request head.
 * A cost control that can quietly stop gating is worse than the cost, so what
 * is pinned here is the two properties that make it safe:
 *
 *   1. FAIL OPEN. Anything other than a proven `false` runs the job, and an
 *      unreadable answer writes `true`.
 *   2. THE FAST GATES ARE NEVER GATED. source_windows, stub_gate and the
 *      typecheck jobs run on every push; two of them are ungated precisely
 *      because something once reached main unseen.
 */
describe('the heavy matrix runs for the head that will be merged', () => {
  const ci = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const job = (name: string) => {
    const start = ci.indexOf(`\n  ${name}:\n`);
    expect(start, `job ${name} not found - re-point this law`).toBeGreaterThan(-1);
    const next = ci.slice(start + 1).search(/\n {2}[a-z0-9_-]+:\n/);
    return next === -1 ? ci.slice(start) : ci.slice(start, start + 1 + next);
  };

  it('every heavy job is gated on the head still being current', () => {
    for (const name of [
      'fixture_native',
      'unit_shards',
      'accounting_postgres',
      'server_shards',
      'build',
      'css-beats-e2e',
    ]) {
      expect(job(name), `${name} pays for a sha nobody will merge`).toContain(
        "needs.changes.outputs.head_current != 'false'"
      );
    }
  });

  it('the gate fails open: only a proven false may skip', () => {
    // `== 'true'` would skip the matrix whenever the output were missing or
    // empty - a new job, a renamed output, a step that did not run - and a
    // cost control must never be able to hide a failure.
    expect(ci).not.toContain("needs.changes.outputs.head_current == 'true'");
    const step = job('changes');
    expect(step, 'an unreadable pull request head must run everything').toContain(
      'could not read the pull request head; running everything'
    );
    expect(step).toContain('head_current=true');
    expect(step).toContain('head_current=false');
  });

  it('the fast gates are never gated on it', () => {
    for (const name of ['source_windows', 'stub_gate', 'typecheck', 'typecheck_compile']) {
      expect(job(name), `${name} is a fast gate and must run on every push`).not.toContain(
        'head_current'
      );
    }
  });

  it('a skip for a superseded sha is explained, never passed in silence', () => {
    // The server aggregator refuses a skip it cannot account for. This case is
    // legitimate, so it is named - it does not widen the silent path.
    const server = job('server');
    expect(server).toContain('HEAD_CURRENT');
    expect(server).toContain('SUPERSEDED');
    expect(server).toContain('Required $suite checks were unexpectedly skipped.');
    expect(job('verdict')).toContain('SUPERSEDED SHA');
  });
});
