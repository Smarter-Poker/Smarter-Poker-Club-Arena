import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = readFileSync(
  process.env.ORIGIN_VERDICT_TEST_WORKFLOW ??
    new URL('../../.github/workflows/post-deploy-e2e.yml', import.meta.url),
  'utf8'
);
const program = workflow.match(
  /node - "\$JOBS_JSON" "\$GITHUB_OUTPUT" <<'NODE'\n([\s\S]*?)\n\s+NODE\n/
)?.[1];
assert.ok(program, 'execute the actual trusted workflow verdict program');

const step = (name, conclusion) => ({ name, status: 'completed', conclusion });
function origin({ conclusion = 'success', standdown = false } = {}) {
  return {
    name: 'publish-to-origin',
    status: 'completed',
    conclusion,
    steps: [
      step('Stand down if the origin already serves a newer bundle', 'success'),
      step(
        'Publish through the host-owned immutable transaction',
        standdown ? 'skipped' : 'success'
      ),
      step('Verify the origin serves this bundle', standdown ? 'skipped' : 'success'),
    ],
  };
}

function verdict(jobs, conclusion = 'success', status = 'completed', payload) {
  const directory = mkdtempSync(join(tmpdir(), 'origin-verdict-'));
  const input = join(directory, 'jobs.json');
  const output = join(directory, 'output');
  try {
    writeFileSync(input, JSON.stringify(payload ?? { total_count: jobs.length, jobs }));
    const result = spawnSync(process.execPath, ['-', input, output], {
      input: program,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 128 * 1024,
      env: { ...process.env, SOURCE_RUN_STATUS: status, SOURCE_RUN_CONCLUSION: conclusion },
    });
    assert.ifError(result.error);
    return { ...result, output: existsSync(output) ? readFileSync(output, 'utf8') : '' };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function refused(result) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.output, '', 'a refused verdict grants no browser or skip outcome');
}

test('cancelled publisher with zero jobs has no publication to certify', () => {
  const result = verdict([], 'cancelled');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'should_run=false\n');
  assert.match(result.stdout, /cancelled before any job started/);
});

for (const conclusion of ['failure', 'success', 'skipped', 'timed_out', '']) {
  test('zero jobs with conclusion ' + JSON.stringify(conclusion) + ' remains a failure', () => {
    refused(verdict([], conclusion));
  });
}

test('an unfinished event cannot assert a cancelled no-publication outcome', () => {
  refused(verdict([], 'cancelled', 'in_progress'));
});

test('a cancelled attempt with a failed origin still fails', () => {
  refused(verdict([origin({ conclusion: 'failure' })], 'cancelled'));
});

test('a cancelled attempt with any other started job cannot claim zero publication', () => {
  refused(verdict([{ name: 'build', status: 'completed', conclusion: 'cancelled' }], 'cancelled'));
});

for (const conclusion of ['success', 'failure', 'cancelled']) {
  test('verified origin requires browsers even when whole attempt is ' + conclusion, () => {
    const result = verdict([origin()], conclusion);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, 'should_run=true\n');
  });
}

test('a proved safe forward stand-down still certifies the served route', () => {
  const result = verdict([origin({ standdown: true })]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'should_run=true\n');
});

test('missing proof steps and duplicate origin jobs remain failures', () => {
  const missing = origin();
  missing.steps.pop();
  refused(verdict([missing]));
  refused(verdict([origin(), origin()]));
});

test('malformed or incomplete pages cannot be used as absence proof', () => {
  for (const payload of [
    {},
    { total_count: 101, jobs: [] },
    { jobs: [] },
    { total_count: 0, jobs: 'not-an-array' },
    { total_count: -1, jobs: [] },
  ]) {
    refused(verdict([], 'cancelled', 'completed', payload));
  }
});
