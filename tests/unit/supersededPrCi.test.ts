import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const script = resolve(__dirname, '../../scripts/ci/superseded-pr-ci.mjs');
let code: {
  cancellationDecision: (snapshot: any) => { eligible: boolean; reason: string };
  inspectSupersededPrCi: (options: any) => Promise<any>;
  githubClient: (execute: any) => any;
};
beforeAll(async () => {
  code = await import(script);
});
const repository = { id: 1132369872, full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena' };
const prefix = `repos/${repository.full_name}`;
const workflowPath = `${prefix}/actions/workflows/ci.yml`;
const oldSha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);
const clone = <T>(value: T): T => structuredClone(value);

// Same shape as the actual API: old run.head_sha stays old while its associated
// pull_requests[].head.sha already reflects the current PR head.
function snapshot() {
  const association = {
    id: 4508452490,
    number: 4333,
    base: { ref: 'main', sha: 'd'.repeat(40), repo: { id: repository.id } },
    head: { ref: 'backup/fixture', sha: newSha, repo: { id: repository.id } },
  };
  const successor = {
    id: 200,
    run_attempt: 1,
    workflow_id: 247739539,
    path: '.github/workflows/ci.yml',
    event: 'pull_request',
    repository: clone(repository),
    head_repository: clone(repository),
    head_branch: 'backup/fixture',
    head_sha: newSha,
    pull_requests: [association],
    status: 'in_progress',
    conclusion: null,
  };
  return {
    workflow: { id: 247739539, path: '.github/workflows/ci.yml', state: 'active' },
    pr: {
      id: association.id,
      number: association.number,
      state: 'open',
      base: { ref: 'main', repo: clone(repository) },
      head: { ref: 'backup/fixture', sha: newSha, repo: clone(repository) },
    },
    successor,
    candidate: { ...clone(successor), id: 100, head_sha: oldSha },
  };
}

function provider(changeAtRecheck?: (state: any) => void, failRead = 0) {
  const state = snapshot();
  const calls: { method: string; path: string }[] = [];
  let workflowReads = 0;
  let reads = 0;
  let inventory: any[] | undefined;
  const api = {
    get: vi.fn(async (path: string) => {
      calls.push({ method: 'GET', path });
      if (++reads === failRead) throw new Error('synthetic API failure');
      if (path === workflowPath) {
        if (++workflowReads === 2) changeAtRecheck?.(state);
        return clone(state.workflow);
      }
      if (path === `${prefix}/actions/runs/200`) return clone(state.successor);
      if (path === `${prefix}/actions/runs/100`) return clone(state.candidate);
      if (path === `${prefix}/pulls/4333`) return clone(state.pr);
      const extra = inventory?.find((run) => path === `${prefix}/actions/runs/${run.id}`);
      if (extra) return clone(extra);
      if (path.includes('/actions/workflows/247739539/runs?')) {
        expect(path).toContain('event=pull_request&branch=backup%2Ffixture&status=');
        const rows = path.includes('status=queued')
          ? []
          : (inventory ?? [state.candidate, state.successor]);
        return { total_count: rows.length, workflow_runs: clone(rows) };
      }
      throw new Error(`unexpected fixture GET: ${path}`);
    }),
    cancel: vi.fn(async (id: number) => {
      calls.push({ method: 'POST', path: `${prefix}/actions/runs/${id}/cancel` });
    }),
  };
  return {
    state,
    api,
    calls,
    inventory: (rows: any[]) => {
      inventory = rows;
    },
  };
}

describe('only obsolete exact Club Arena pull-request CI is eligible', () => {
  it('uses run.head_sha and accepts an active or successful exact-head successor', () => {
    const s = snapshot();
    expect(code.cancellationDecision(s).eligible).toBe(true);
    s.successor.status = 'completed';
    s.successor.conclusion = 'success' as any;
    expect(code.cancellationDecision(s).eligible).toBe(true);
  });

  const invalid: [string, (s: any) => void][] = [
    [
      'workflow id',
      (s) => {
        s.workflow.id++;
      },
    ],
    [
      'workflow path',
      (s) => {
        s.workflow.path = '.github/workflows/auto-deploy-hetzner.yml';
      },
    ],
    [
      'disabled workflow',
      (s) => {
        s.workflow.state = 'disabled_manually';
      },
    ],
    [
      'foreign repo id',
      (s) => {
        s.candidate.repository.id++;
      },
    ],
    [
      'foreign repo name',
      (s) => {
        s.candidate.repository.full_name = 'other/repository';
      },
    ],
    [
      'fork source',
      (s) => {
        s.candidate.head_repository.id++;
      },
    ],
    [
      'different workflow id',
      (s) => {
        s.candidate.workflow_id++;
      },
    ],
    [
      'publisher',
      (s) => {
        s.candidate.path = '.github/workflows/publish-club-arena.yml';
      },
    ],
    [
      'native engine operation',
      (s) => {
        s.candidate.path = '.github/workflows/auto-deploy-hetzner.yml';
      },
    ],
    [
      'path prefix trick',
      (s) => {
        s.candidate.path += '.evil';
      },
    ],
    [
      'repository dispatch',
      (s) => {
        s.candidate.event = 'repository_dispatch';
      },
    ],
    [
      'workflow dispatch',
      (s) => {
        s.candidate.event = 'workflow_dispatch';
      },
    ],
    [
      'push event',
      (s) => {
        s.candidate.event = 'push';
      },
    ],
    [
      'scheduled run',
      (s) => {
        s.candidate.event = 'schedule';
      },
    ],
    [
      'ambiguous PRs',
      (s) => {
        s.candidate.pull_requests.push(clone(s.candidate.pull_requests[0]));
      },
    ],
    [
      'missing PR',
      (s) => {
        s.candidate.pull_requests = [];
      },
    ],
    [
      'different PR id',
      (s) => {
        s.candidate.pull_requests[0].id++;
      },
    ],
    [
      'different PR number',
      (s) => {
        s.candidate.pull_requests[0].number++;
      },
    ],
    [
      'foreign association',
      (s) => {
        s.candidate.pull_requests[0].head.repo.id++;
      },
    ],
    [
      'closed PR',
      (s) => {
        s.pr.state = 'closed';
      },
    ],
    [
      'live foreign PR',
      (s) => {
        s.pr.head.repo.id++;
      },
    ],
    [
      'different base branch',
      (s) => {
        s.pr.base.ref = 'release';
      },
    ],
    [
      'different branch',
      (s) => {
        s.candidate.head_branch = 'other';
      },
    ],
    [
      'current head target',
      (s) => {
        s.candidate.head_sha = newSha;
      },
    ],
    [
      'successor target',
      (s) => {
        s.candidate.id = s.successor.id;
      },
    ],
    [
      'unproven successor head',
      (s) => {
        s.successor.head_sha = 'c'.repeat(40);
      },
    ],
    [
      'short source hash',
      (s) => {
        s.candidate.head_sha = oldSha.slice(0, 8);
      },
    ],
    [
      'failed successor',
      (s) => {
        s.successor.status = 'completed';
        s.successor.conclusion = 'failure';
      },
    ],
    [
      'canceled successor',
      (s) => {
        s.successor.status = 'completed';
        s.successor.conclusion = 'cancelled';
      },
    ],
    [
      'only queued successor',
      (s) => {
        s.successor.status = 'queued';
      },
    ],
    [
      'finished candidate',
      (s) => {
        s.candidate.status = 'completed';
        s.candidate.conclusion = 'success';
      },
    ],
    [
      'missing run attempt',
      (s) => {
        delete s.candidate.run_attempt;
      },
    ],
  ];
  it.each(invalid)('refuses %s', (_name, change) => {
    const s = snapshot();
    change(s);
    expect(code.cancellationDecision(s).eligible).toBe(false);
  });

  it.each(invalid)('rechecks %s after preview, before any cancellation', async (_name, change) => {
    const p = provider(change);
    const result = await code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200, apply: true });
    expect(p.api.cancel).not.toHaveBeenCalled();
    expect(result.decisions[0].action).toBe('refused');
  });
});

describe('fresh authority and bounded API behavior', () => {
  it.each(['push', 'repository_dispatch', 'workflow_dispatch', 'schedule'])(
    'refuses a %s source run before looking up or canceling other runs',
    async (event) => {
      const p = provider();
      p.state.successor.event = event;
      await expect(
        code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200, apply: true })
      ).rejects.toThrow('not-pull-request-ci');
      expect(p.api.get).toHaveBeenCalledTimes(2);
      expect(p.api.cancel).not.toHaveBeenCalled();
    }
  );

  it.each([
    '.github/workflows/auto-deploy-hetzner.yml',
    '.github/workflows/publish-club-arena.yml',
  ])('refuses native operation source %s even if it carries the CI workflow ID', async (path) => {
    const p = provider();
    p.state.successor.path = path;
    await expect(
      code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200, apply: true })
    ).rejects.toThrow('foreign-run-path');
    expect(p.api.get).toHaveBeenCalledTimes(2);
    expect(p.api.cancel).not.toHaveBeenCalled();
  });

  it('defaults to dry-run and repeats the same final authority reads without a POST', async () => {
    const p = provider();
    const result = await code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200 });
    expect(result.mode).toBe('dry-run');
    expect(result.decisions[0]).toMatchObject({ runId: 100, action: 'would-cancel' });
    expect(p.api.cancel).not.toHaveBeenCalled();
    expect(p.calls.slice(-4).map((c) => c.path)).toEqual([
      workflowPath,
      `${prefix}/actions/runs/100`,
      `${prefix}/actions/runs/200`,
      `${prefix}/pulls/4333`,
    ]);
  });

  it('only posts the old run ID, immediately after the final live PR read', async () => {
    const p = provider();
    const result = await code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200, apply: true });
    expect(p.api.cancel).toHaveBeenCalledExactlyOnceWith(100);
    const post = p.calls.findIndex((c) => c.method === 'POST');
    expect(p.calls[post - 1]).toEqual({ method: 'GET', path: `${prefix}/pulls/4333` });
    expect(result.decisions[0].action).toBe('cancel-requested');
  });

  it.each(['candidate', 'successor'])(
    'refuses a new %s attempt between preview and cancel',
    async (field) => {
      const p = provider((s) => {
        s[field].run_attempt++;
      });
      const result = await code.inspectSupersededPrCi({
        api: p.api,
        sourceRunId: 200,
        apply: true,
      });
      expect(p.api.cancel).not.toHaveBeenCalled();
      expect(result.decisions[0].reason).toBe('run-identity-changed');
    }
  );

  it('refuses when the final live PR head returns to the old candidate', async () => {
    const p = provider((s) => {
      s.pr.head.sha = oldSha;
    });
    await code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200, apply: true });
    expect(p.api.cancel).not.toHaveBeenCalled();
  });

  it('allows normal source status advancement and mutable repository metadata', async () => {
    const p = provider((s) => {
      s.successor.status = 'completed';
      s.successor.conclusion = 'success';
      s.successor.repository.pushed_at = '2026-09-11T18:00:00Z';
      s.candidate.pull_requests[0].base.sha = 'e'.repeat(40);
    });
    await code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200, apply: true });
    expect(p.api.cancel).toHaveBeenCalledExactlyOnceWith(100);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])(
    'API read failure %s issues no cancellation',
    async (failAt) => {
      const p = provider(undefined, failAt);
      await expect(
        code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200, apply: true })
      ).rejects.toThrow();
      expect(p.api.cancel).not.toHaveBeenCalled();
    }
  );

  it('deduplicates a run discovered twice', async () => {
    const p = provider();
    p.inventory([p.state.candidate, clone(p.state.candidate)]);
    await code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200, apply: true });
    expect(p.api.cancel).toHaveBeenCalledExactlyOnceWith(100);
  });

  it('re-reads the PR for each target and refuses the next after a concurrent push', async () => {
    const p = provider();
    p.inventory([p.state.candidate, { ...clone(p.state.candidate), id: 101 }]);
    p.api.cancel.mockImplementation(async (id: number) => {
      p.calls.push({ method: 'POST', path: `${prefix}/actions/runs/${id}/cancel` });
      p.state.pr.head.sha = 'c'.repeat(40);
    });
    const result = await code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200, apply: true });
    expect(p.api.cancel).toHaveBeenCalledExactlyOnceWith(100);
    expect(result.decisions[1]).toMatchObject({ runId: 101, action: 'refused' });
  });

  it('refuses a truncated API inventory before any mutation', async () => {
    const p = provider();
    const get = p.api.get.getMockImplementation()!;
    p.api.get.mockImplementation(async (path) => {
      const value = await get(path);
      if (path.includes('/runs?')) value.total_count++;
      return value;
    });
    await expect(
      code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200, apply: true })
    ).rejects.toThrow('incomplete-or-overflowed-run-inventory');
    expect(p.api.cancel).not.toHaveBeenCalled();
  });

  it('refuses contradictory duplicates before any mutation', async () => {
    const p = provider();
    p.inventory([p.state.candidate, { ...p.state.candidate, head_sha: 'c'.repeat(40) }]);
    await expect(
      code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200, apply: true })
    ).rejects.toThrow('inconsistent-duplicate-run');
    expect(p.api.cancel).not.toHaveBeenCalled();
  });

  it('refuses an overflowing inventory before any mutation', async () => {
    const p = provider();
    p.inventory(Array.from({ length: 21 }, (_, i) => ({ ...p.state.candidate, id: 100 + i })));
    await expect(
      code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200, apply: true })
    ).rejects.toThrow('incomplete-or-overflowed-run-inventory');
    expect(p.api.cancel).not.toHaveBeenCalled();
  });

  it('does not silently retry or proceed after a cancellation API failure', async () => {
    const p = provider();
    p.api.cancel.mockRejectedValue(new Error('cancel unavailable'));
    await expect(
      code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200, apply: true })
    ).rejects.toThrow('cancel unavailable');
    expect(p.api.cancel).toHaveBeenCalledTimes(1);
  });

  it('refuses invalid source IDs or non-boolean apply before any API read', async () => {
    const p = provider();
    for (const sourceRunId of [0, -1, 1.5, '200', Number.MAX_SAFE_INTEGER + 1]) {
      await expect(code.inspectSupersededPrCi({ api: p.api, sourceRunId })).rejects.toThrow();
    }
    await expect(
      code.inspectSupersededPrCi({ api: p.api, sourceRunId: 200, apply: 'true' })
    ).rejects.toThrow();
    expect(p.api.get).not.toHaveBeenCalled();
  });
});

describe('transport and trusted workflow boundary', () => {
  it('requests cache revalidation on every discovery and final authority GET', async () => {
    const p = provider();
    const execute = vi.fn(async (_file: string, args: string[], _options: unknown) => ({
      stdout: JSON.stringify(await p.api.get(args.at(-1)!)),
    }));
    const result = await code.inspectSupersededPrCi({
      api: code.githubClient(execute),
      sourceRunId: 200,
    });
    expect(result.decisions[0].action).toBe('would-cancel');
    expect(execute).toHaveBeenCalledTimes(9);
    for (const [, args] of execute.mock.calls) {
      expect(args[args.indexOf('--method') + 1]).toBe('GET');
      expect(args[args.indexOf('--header') + 1]).toBe('Cache-Control: no-cache');
      expect(args).not.toContain('--cache');
    }
    expect(execute.mock.calls.at(-1)?.[1].at(-1)).toBe(`${prefix}/pulls/${p.state.pr.number}`);
  });

  it('uses the configured gh client against github.com and only the specific cancel endpoint', async () => {
    const execute = vi.fn(async (_file: string, _args: string[], _options: unknown) => ({
      stdout: '{"id":200}',
    }));
    const client = code.githubClient(execute);
    expect(await client.get(`${prefix}/actions/runs/200`)).toEqual({ id: 200 });
    await client.cancel(100);
    expect(execute.mock.calls[1]?.[1]).toEqual([
      'api',
      '--hostname',
      'github.com',
      '--method',
      'POST',
      `${prefix}/actions/runs/100/cancel`,
    ]);
    expect(() => client.cancel('100; injected')).toThrow();
    expect(() => client.get('repos/foreign/repository/actions/runs/200')).toThrow();
  });

  it('does not expose raw authentication/API diagnostics', async () => {
    const execute = vi.fn(async () => {
      throw new Error('synthetic-secret-diagnostic');
    });
    await expect(code.githubClient(execute).get(`${prefix}/actions/runs/200`)).rejects.toThrow(
      'github-api-get-failed'
    );
  });

  it('refuses malformed API JSON without trusting a partial response', async () => {
    const execute = vi.fn(async () => ({ stdout: 'not-json' }));
    await expect(code.githubClient(execute).get(`${prefix}/actions/runs/200`)).rejects.toThrow(
      'github-api-get-failed'
    );
  });

  it('default preview has read-only permissions; apply requires separate explicit activation', () => {
    const root = resolve(__dirname, '../..');
    const workflow = parse(
      readFileSync(resolve(root, '.github/workflows/pr-ci-supersession.yml'), 'utf8')
    );
    expect(Object.keys(workflow.on)).toEqual(['workflow_run']);
    expect(workflow.on.workflow_run.types).toEqual(['in_progress', 'completed']);
    expect(workflow.permissions).toEqual({});
    const preview = workflow.jobs.preview;
    expect(preview.permissions.actions).toBe('read');
    expect(preview.if).toContain('workflow_id == 247739539');
    expect(preview.if).toContain("event == 'pull_request'");
    const apply = workflow.jobs.apply;
    expect(apply.needs).toBe('preview');
    expect(apply.if).toBe("vars.CI_PR_SUPERSESSION_APPLY == 'true'");
    expect(apply.permissions.actions).toBe('write');
    for (const job of [preview, apply]) {
      expect(job['runs-on']).toBe('ubuntu-latest');
      expect(job.steps[0].with.ref).toBe('${{ github.sha }}');
      expect(job.steps[0].with['persist-credentials']).toBe(false);
      expect(
        job.steps.some((step: any) => /artifact|cache|npm (ci|install)/.test(JSON.stringify(step)))
      ).toBe(false);
    }
    expect(preview.steps.at(-1).run).not.toContain('--apply');
    expect(apply.steps.at(-1).run).toContain('--apply');
  });
});
