import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
it('retains one sanitized guard result through a real controller hard-kill during cleanup', () => {
  const run = spawnSync(
    process.execPath,
    [resolve('tests/operations/checkpoint-observation-loss.mjs')],
    {
      encoding: 'utf8',
      timeout: 12000,
      maxBuffer: 32768,
      env: { ...process.env, TMPDIR: process.env.TMPDIR ?? process.env.RUNNER_TEMP },
    }
  );
  expect(run.error?.message ?? null, run.stderr).toBeNull();
  expect(run.status, run.stdout + run.stderr).toBe(0);
  expect(JSON.parse(run.stdout.trim())).toMatchObject({
    ok: true,
    guardCalls: 1,
    controllerKilled: true,
    cleanupStatus: 'not_yet_verified',
    retryAllowed: false,
    inspectorClosureUnproved: true,
    privateFieldsAbsent: true,
  });
}, 15000);

it('a failed original host collector still permits native cleanup but cannot succeed', () => {
  const run = spawnSync(
    process.execPath,
    [
      resolve('tests/operations/checkpoint-observation-loss.mjs'),
      pathToFileURL(resolve('server/scripts/legacy-engine-checkpoint.mjs')).href,
      'collector_failure',
    ],
    {
      encoding: 'utf8',
      timeout: 12000,
      maxBuffer: 32768,
      env: { ...process.env, TMPDIR: process.env.TMPDIR ?? process.env.RUNNER_TEMP },
    }
  );
  expect(run.error?.message ?? null, run.stderr).toBeNull();
  expect(run.status, run.stdout + run.stderr).toBe(0);
  expect(JSON.parse(run.stdout.trim())).toMatchObject({
    ok: true,
    guardCalls: 1,
    controllerKilled: false,
    cleanupStatus: 'verified_after_collector_failure',
    retryAllowed: false,
    inspectorClosureUnproved: false,
  });
}, 15000);
