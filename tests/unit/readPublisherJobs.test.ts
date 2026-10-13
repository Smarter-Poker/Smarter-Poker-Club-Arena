import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPublisherJobs } from '../../scripts/ci/read-publisher-jobs.mjs';
const repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const run = '38465409080';
const jobs = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: start + i, name: `job${start + i}` }));
const error = (status: number) => Object.assign(new Error('read refused'), { status });
const options = (request: (path: string, timeoutMs: number) => Promise<unknown>) => ({
  request,
  now: () => 0,
  sleep: async () => {},
});

describe('complete origin metadata read', () => {
  it('uses the proven30-job request shape after the observed100-job502 refusal', async () => {
    const paths: string[] = [];
    const result = await readPublisherJobs(
      repository,
      run,
      options(async (path: string) => {
        paths.push(path);
        if (path.includes('per_page=100')) throw error(502);
        return { total_count: 9, jobs: jobs(1, 9) };
      })
    );
    expect(result.jobs).toHaveLength(9);
    expect(paths).toEqual([
      `repos/${repository}/actions/runs/${run}/jobs?filter=latest&per_page=30&page=1`,
    ]);
  });
  it('reads every page and preserves all original job and step data', async () => {
    const first = jobs(1, 30);
    first[0] = { ...first[0], steps: [{ name: 'proof', conclusion: 'success' }] } as any;
    const result = await readPublisherJobs(
      repository,
      run,
      options(async (path: string) => ({
        total_count: 31,
        jobs: path.endsWith('page=1') ? first : jobs(31, 1),
      }))
    );
    expect(result).toEqual({ total_count: 31, jobs: [...first, ...jobs(31, 1)] });
  });
  it.each([
    { total_count: 1, jobs: [] },
    { total_count: 0, jobs: jobs(1, 1) },
    { jobs: [] },
    { total_count: '0', jobs: [] },
    { total_count: 2, jobs: [{ id: 1 }, { id: 1 }] },
    { total_count: 1, jobs: [{}] },
  ])('refuses malformed or incomplete metadata %#', async (payload) => {
    await expect(
      readPublisherJobs(
        repository,
        run,
        options(async () => payload)
      )
    ).rejects.toThrow();
  });
  it('refuses a changed total or duplicate across pages', async () => {
    for (const second of [
      { total_count: 32, jobs: jobs(31, 1) },
      { total_count: 31, jobs: jobs(1, 1) },
    ])
      await expect(
        readPublisherJobs(
          repository,
          run,
          options(async (path: string) =>
            path.endsWith('page=1') ? { total_count: 31, jobs: jobs(1, 30) } : second
          )
        )
      ).rejects.toThrow();
  });
  it('retries only explicit5xx reads, with at most three attempts', async () => {
    let calls = 0;
    const result = await readPublisherJobs(
      repository,
      run,
      options(async () => {
        if (++calls < 3) throw error(502);
        return { total_count: 0, jobs: [] };
      })
    );
    expect(result).toEqual({ total_count: 0, jobs: [] });
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      readPublisherJobs(
        repository,
        run,
        options(async () => {
          calls++;
          throw error(503);
        })
      )
    ).rejects.toThrow();
    expect(calls).toBe(3);
    for (const status of [401, 403, 404, 429, undefined]) {
      calls = 0;
      await expect(
        readPublisherJobs(
          repository,
          run,
          options(async () => {
            calls++;
            throw error(status as any);
          })
        )
      ).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });
  it('refuses a late response and does not reset the budget for another page', async () => {
    let clock = 0,
      calls = 0;
    await expect(
      readPublisherJobs(repository, run, {
        now: () => clock,
        sleep: async () => {},
        request: async () => {
          calls++;
          clock = 30000;
          return { total_count: 31, jobs: jobs(1, 30) };
        },
      })
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

it('executes the maintained CLI with a physical configured-gh adapter and refuses malformed reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'publisher-jobs-cli-'));
  try {
    const executable = join(dir, 'gh');
    const invoke = (body: string, exit = 0) => {
      writeFileSync(
        executable,
        `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(dir, 'args.json'))},JSON.stringify(process.argv.slice(2)));process.stdout.write(${JSON.stringify(body)});process.exit(${exit});\n`
      );
      chmodSync(executable, 0o700);
      return spawnSync(process.execPath, ['scripts/ci/read-publisher-jobs.mjs', repository, run], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
    };
    const payload = {
      total_count: 1,
      jobs: [
        {
          id: 1,
          name: 'publish-to-origin',
          status: 'completed',
          conclusion: 'success',
          steps: [
            {
              name: 'Verify the origin serves this bundle',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
      ],
    };
    const ok = invoke(JSON.stringify(payload));
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual(payload);
    expect(JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'))).toEqual([
      'api',
      '--method',
      'GET',
      `repos/${repository}/actions/runs/${run}/jobs?filter=latest&per_page=30&page=1`,
    ]);
    for (const body of ['not json', JSON.stringify({ total_count: 1, jobs: [] })]) {
      const failed = invoke(body);
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe('');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('the original30-second workflow gate invokes this reader before unchanged job proof admission', () => {
  const source = readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8');
  expect(source).toContain('timeout 30s node scripts/ci/read-publisher-jobs.mjs');
  expect(source).toContain(
    "if (payload.total_count !== payload.jobs.length) throw new Error('Source job metadata is incomplete.');"
  );
  expect(source).toContain('if (!originSucceeded || (!publishProved && !safeStanddown))');
});
