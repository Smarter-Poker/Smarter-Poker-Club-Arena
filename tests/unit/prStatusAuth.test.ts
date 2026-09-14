import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGitHubReader, GitHubReadError } from '../../scripts/ci/pr-status-http.mjs';
import { approvingReviewMinimumFromRules } from '../../scripts/ci/pr-status.mjs';

const URL = 'https://api.github.com/repos/example/project/actions/runs?head_sha=abc&per_page=100';
const CANARY = 'synthetic-private-diagnostic-canary';
const response = (status: number, body: unknown, extra = '') =>
  `HTTP/2.0 ${status} Test\r\nX-Ratelimit-Remaining: 99\r\nX-Ratelimit-Limit: 100\r\n${extra}\r\n${JSON.stringify(body)}`;

describe('configured GitHub status authentication', () => {
  it('keeps explicit token precedence and never changes identity after an HTTP rejection', async () => {
    const execute = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    const read = createGitHubReader({
      env: {
        GH_TOKEN: 'synthetic-primary',
        GITHUB_TOKEN: 'synthetic-secondary',
      },
      execute,
      fetchImpl,
    });
    expect((await read(URL)).status).toBe(401);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer synthetic-primary');
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses GITHUB_TOKEN when GH_TOKEN is absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'));
    await createGitHubReader({
      env: { GITHUB_TOKEN: 'synthetic-secondary' },
      fetchImpl,
    })(URL);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer synthetic-secondary');
  });

  it('uses configured gh with GET argv, no token extraction, and private diagnostics', async () => {
    const execute = vi
      .fn()
      .mockReturnValue(response(200, { workflow_runs: [] }, `Set-Cookie: ${CANARY}\r\n`));
    const fetchImpl = vi.fn();
    const read = createGitHubReader({
      env: { GH_DEBUG: 'api', DEBUG: '1' },
      execute,
      fetchImpl,
    });
    const result = await read(URL);
    expect(await result.json()).toEqual({ workflow_runs: [] });
    expect(result.headers.get('x-ratelimit-remaining')).toBe('99');
    expect(result.headers.get('set-cookie')).toBeNull();
    expect(execute).toHaveBeenCalledWith(
      'gh',
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        '--include',
        '--header',
        'Accept: application/vnd.github+json',
        '--header',
        'X-GitHub-Api-Version: 2022-11-28',
        URL,
      ],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30_000,
        env: expect.objectContaining({
          GH_DEBUG: '',
          DEBUG: '',
          GH_PROMPT_DISABLED: '1',
        }),
      })
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('finds Homebrew only after PATH ENOENT and retains that executable', async () => {
    const execute = vi
      .fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error(CANARY), { code: 'ENOENT' });
      })
      .mockReturnValue(response(200, {}));
    const read = createGitHubReader({ env: {}, platform: 'darwin', execute });
    await read(URL);
    await read(URL);
    expect(execute.mock.calls.map(([binary]) => binary)).toEqual([
      'gh',
      '/opt/homebrew/bin/gh',
      '/opt/homebrew/bin/gh',
    ]);
  });

  it.each([
    { code: 'ENOENT', platform: 'linux' },
    { code: 'EACCES', platform: 'darwin' },
    { status: 4, platform: 'darwin' },
    { status: 1, platform: 'darwin' },
    { code: 'ETIMEDOUT', platform: 'darwin' },
  ])('refuses missing auth/client/process failure without leaking it: %j', async (failure) => {
    const execute = vi.fn(() => {
      throw Object.assign(new Error(CANARY), { stderr: CANARY, ...failure });
    });
    const read = createGitHubReader({
      env: {},
      platform: failure.platform,
      execute,
    });
    const error = await read(URL).catch((value: Error) => value);
    expect(error).toBeInstanceOf(GitHubReadError);
    expect(String(error)).not.toContain(CANARY);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('preserves HTTP refusal and rate-limit metadata from gh exit 1', async () => {
    const execute = vi.fn(() => {
      throw Object.assign(new Error(CANARY), {
        status: 1,
        stdout: response(403, { message: CANARY }, 'Retry-After: 120\r\n'),
        stderr: CANARY,
      });
    });
    const result = await createGitHubReader({ env: {}, execute })(URL);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.headers.get('retry-after')).toBe('120');
  });

  it('preserves a 404 for optional-resource handling and plain job-log bodies', async () => {
    const execute = vi
      .fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error(CANARY), { status: 1, stdout: response(404, {}) });
      })
      .mockReturnValue('HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 99\n\nFAIL example.test.ts\n');
    const read = createGitHubReader({ env: {}, execute });
    expect((await read(URL)).status).toBe(404);
    expect(await (await read(URL)).text()).toBe('FAIL example.test.ts\n');
  });

  it('uses only the final response of a framed log redirect without exposing signed headers', async () => {
    const redirect = `HTTP/2.0 302 Found\r\nLocation: https://logs.invalid/?sig=${CANARY}\r\n\r\n`;
    const body = 'HTTP/1.1 500 is a line printed by this synthetic test\nFAIL example.test.ts\n';
    const execute = vi.fn().mockReturnValue(redirect + 'HTTP/2.0 200 OK\r\n\r\n' + body);
    const result = await createGitHubReader({ env: {}, execute })(URL);
    expect(result.status).toBe(200);
    expect(result.headers.get('location')).toBeNull();
    expect(await result.text()).toBe(body);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('preserves the final error after a redirect and refuses a truncated final frame', async () => {
    const redirect = `HTTP/2.0 302 Found\nLocation: https://logs.invalid/?sig=${CANARY}\n\n`;
    const execute = vi
      .fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error(CANARY), {
          status: 1,
          stdout: redirect + response(403, { message: CANARY }, 'Retry-After: 120\r\n'),
        });
      })
      .mockReturnValue(redirect + 'HTTP/2.0 200 OK\n');
    const read = createGitHubReader({ env: {}, execute });
    const result = await read(URL);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.headers.get('retry-after')).toBe('120');
    await expect(read(URL)).rejects.toThrow('no readable HTTP response');
  });

  it('stops after a missing Homebrew executable without another lookup or retry', async () => {
    const execute = vi.fn(() => {
      throw Object.assign(new Error(CANARY), { code: 'ENOENT' });
    });
    const read = createGitHubReader({ env: {}, platform: 'darwin', execute });
    await expect(read(URL)).rejects.toThrow('GitHub CLI is unavailable');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      '/opt/homebrew/bin/gh',
      expect.any(Array),
      expect.any(Object)
    );
  });

  it('refuses a partial success after process failure and malformed successful output', async () => {
    for (const execute of [
      vi.fn(() => {
        throw Object.assign(new Error(CANARY), {
          status: 1,
          stdout: response(200, {}),
        });
      }),
      vi.fn(() => CANARY),
    ]) {
      await expect(createGitHubReader({ env: {}, execute })(URL)).rejects.toBeInstanceOf(
        GitHubReadError
      );
    }
  });

  it('sanitizes fetch errors and never retries with the CLI', async () => {
    const execute = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new Error(CANARY));
    const error = await createGitHubReader({
      env: { GH_TOKEN: 'synthetic' },
      execute,
      fetchImpl,
    })(URL).catch((value: Error) => value);
    expect(String(error)).not.toContain(CANARY);
    expect(error).toBeInstanceOf(GitHubReadError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not send configured credentials to another API host', async () => {
    const execute = vi.fn();
    const fetchImpl = vi.fn();
    await expect(
      createGitHubReader({ env: {}, execute, fetchImpl })('https://example.invalid/repos/x/y')
    ).rejects.toBeInstanceOf(GitHubReadError);
    expect(execute).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runStatus(scenario: string, json = true, all = false) {
  const directory = mkdtempSync(join(tmpdir(), 'pr-status-auth-'));
  scratch.push(directory);
  // Real child-process boundary, entirely synthetic API/client. No network,
  // inherited credentials, or real gh credential store is available to it.
  writeFileSync(
    join(directory, 'gh'),
    `#!${process.execPath}
const scenario = process.env.SCENARIO;
const endpoint = process.argv.at(-1);
if (scenario === 'no-auth') { console.error('${CANARY}'); process.exit(4); }
if (scenario === 'network-error') { console.error('${CANARY}'); process.exit(1); }
if (scenario === 'malformed-http') { console.log('${CANARY}'); process.exit(0); }
let code = 200;
let body;
const pr = { number:7, head:{sha:'abc',ref:'example'}, mergeable:true, mergeable_state:'blocked', html_url:'https://github.com/example/project/pull/7' };
if (endpoint.includes('/rules/')) {
  body = [{ type: 'required_status_checks', parameters: { required_status_checks: [{context:'Build'}] }}];
  if (scenario === 'minimum-zero') body.push({type:'pull_request',parameters:{required_approving_review_count:0}});
  if (scenario === 'minimum-positive') body.push({type:'pull_request',parameters:{required_approving_review_count:2}});
  if (scenario === 'minimum-malformed') body.push({type:'pull_request',parameters:{required_approving_review_count:'0'}});
  if (scenario === 'unreadable-rules') { code = 403; body = {message:'${CANARY}'}; }
} else if (endpoint.includes('/pulls?')) {
  body = [pr];
} else if (endpoint.includes('/pulls/')) {
  body = pr;
} else if (endpoint.includes('/actions/runs?')) {
  body = { workflow_runs: scenario === 'no-runs' ? [] : [{id:123, name:'CI',status:scenario === 'queued'?'queued':'completed',conclusion:scenario === 'queued'?null:'success',created_at:'2026-09-14T00:00:00Z'}] };
  if (scenario === 'denied') { code = 403; body = {message:'${CANARY}'}; }
  if (scenario === 'rate-limit') { code = 429; body = {message:'${CANARY}'}; }
  if (scenario === 'malformed-json') body = null;
} else if (endpoint.includes('/jobs?')) {
  body = { jobs:[{name:'Build',status:scenario === 'queued'?'queued':'completed',conclusion:scenario === 'queued'?null:'success'}] };
} else { process.exit(9); }
console.log('HTTP/2.0 ' + code + ' Test');
console.log('X-Ratelimit-Remaining: ' + (code === 429 ? '0' : '99'));
console.log('X-Ratelimit-Limit: 100');
if (code === 429) console.log('Retry-After: 120');
console.log('Set-Cookie: ${CANARY}');
console.log('');
console.log(scenario === 'malformed-json' && body === null ? '${CANARY}' : JSON.stringify(body));
if (code >= 400) { console.error('${CANARY}'); process.exit(1); }
`,
    { mode: 0o700 }
  );
  const script = resolve(__dirname, '../../scripts/ci/pr-status.mjs');
  return spawnSync(
    process.execPath,
    [
      script,
      '--repo',
      'example/project',
      ...(all ? ['--all'] : ['7']),
      ...(json ? ['--json'] : []),
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: directory, GH_CONFIG_DIR: directory, SCENARIO: scenario },
    }
  );
}

describe('status reader CLI with configured gh authentication', () => {
  it.each([
    ['queued', 2, 'RUNNING'],
    ['green', 0, 'GREEN'],
    ['no-runs', 3, 'UNKNOWN'],
    ['no-auth', 3, 'UNKNOWN'],
    ['network-error', 3, 'UNKNOWN'],
    ['denied', 3, 'UNKNOWN'],
    ['rate-limit', 3, 'UNKNOWN'],
    ['unreadable-rules', 3, 'UNKNOWN'],
    ['malformed-json', 3, 'UNKNOWN'],
    ['malformed-http', 3, 'UNKNOWN'],
  ])('%s reports exact state and exit without exposing diagnostics', (scenario, code, state) => {
    const result = runStatus(scenario as string);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(code);
    expect(JSON.parse(result.stdout).state).toBe(state);
    expect(result.stdout + result.stderr).not.toContain(CANARY);
    if (scenario === 'rate-limit')
      expect(JSON.parse(result.stdout).reason).toContain('RATE LIMITED');
  });

  it('preserves GitHub blocked even when checks passed and auto-merge may be armed', () => {
    const result = runStatus('green', false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('GitHub still says "blocked"');
    expect(result.stdout).toContain('Auto-merge does not satisfy other merge requirements');
    expect(result.stdout).not.toContain('that clears when autopilot');
  });
});

const reviewRule = (count: unknown) => ({
  type: 'pull_request',
  parameters: { required_approving_review_count: count },
});
describe('approving-review minimum from already-read main branch rules', () => {
  it('distinguishes absent PR rules and explicit zero from unreadable rules', () => {
    expect(approvingReviewMinimumFromRules([])).toBe(0);
    expect(approvingReviewMinimumFromRules([{ type: 'required_status_checks' }])).toBe(0);
    expect(approvingReviewMinimumFromRules([reviewRule(0)])).toBe(0);
    expect(approvingReviewMinimumFromRules(null)).toBeNull();
    expect(approvingReviewMinimumFromRules(undefined)).toBeNull();
    expect(approvingReviewMinimumFromRules({})).toBeNull();
  });

  it('reports the strongest applicable minimum without evaluating actual reviews', () => {
    expect(approvingReviewMinimumFromRules([reviewRule(1), reviewRule(3), reviewRule(2)])).toBe(3);
  });

  it.each([undefined, null, '0', '2', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'keeps a malformed count %s unknown even beside a valid rule',
    (count) => {
      expect(approvingReviewMinimumFromRules([reviewRule(2), reviewRule(count)])).toBeNull();
    }
  );

  it('cannot infer zero from malformed rule entries or missing parameters', () => {
    for (const rules of [[null], [{}], ['pull_request'], [{ type: 'pull_request' }]]) {
      expect(approvingReviewMinimumFromRules(rules)).toBeNull();
    }
  });

  it.each([
    ['green', 0],
    ['minimum-zero', 0],
    ['minimum-positive', 2],
    ['unreadable-rules', null],
    ['minimum-malformed', null],
  ])('%s exposes the count or unknown in both JSON and human output', (scenario, minimum) => {
    const result = runStatus(scenario as string);
    const payload = JSON.parse(result.stdout);
    expect(payload.approvingReviewMinimum).toBe(minimum);
    // Review metadata does not change the check verdict or its exit code.
    expect(payload.state).toBe(scenario === 'unreadable-rules' ? 'UNKNOWN' : 'GREEN');
    expect(result.status).toBe(scenario === 'unreadable-rules' ? 3 : 0);
    const prose = runStatus(scenario as string, false).stdout;
    expect(prose).toContain(
      `Approving-review minimum (main branch rules): ${minimum === null ? 'UNKNOWN' : minimum}`
    );
    expect(prose).toContain('Review satisfaction not evaluated.');
    expect(prose).not.toContain('Required reviews,');
  });

  it('exposes the same scoped minimum in all-PR JSON and human output', () => {
    const result = runStatus('minimum-positive', true, true);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)[0].approvingReviewMinimum).toBe(2);
    expect(runStatus('minimum-positive', false, true).stdout).toContain(
      'Approving-review minimum (main branch rules): 2.'
    );
  });
});
