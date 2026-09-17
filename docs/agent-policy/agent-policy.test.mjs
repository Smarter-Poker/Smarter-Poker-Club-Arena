import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  POLICY_VERSION,
  verifyPolicy,
  comparePolicies,
  classifyDelivery,
  inspectCandidate,
  nextAction,
  duration,
  providerTiming,
  deliveryReport,
  referenceRole,
} from './agent-policy.mjs';
const dir = dirname(fileURLToPath(import.meta.url));
const sha = 'a'.repeat(40),
  other = 'b'.repeat(40),
  time = '2026-09-17T18:00:00Z';
const temporary = (t) => {
  const path = mkdtempSync(join(tmpdir(), 'agent-policy-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const environment = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
const runGit = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    env: environment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

test('maintained policy bundle verifies its real version, hashes and reference roles', () => {
  assert.equal(verifyPolicy(dir).policyVersion, POLICY_VERSION);
  const manifest = JSON.parse(readFileSync(join(dir, 'policy-manifest.json')));
  assert.equal(referenceRole('docs/agent-policy/OPERATING-LAW.md', manifest), 'active-policy');
  assert.equal(referenceRole('docs/changelog/2026-08-01.md', manifest), 'historical-evidence');
  assert.equal(referenceRole('PUBLISHING.md', manifest), 'scope-specific-reference');
});
test('stale bytes, missing files, incomplete manifests and symlinks refuse', (t) => {
  const root = temporary(t);
  cpSync(dir, root, { recursive: true });
  const policy = join(root, 'OPERATING-LAW.md');
  const original = readFileSync(policy);
  writeFileSync(policy, 'Policy version: 2.8\n');
  assert.throws(() => verifyPolicy(root), /drift/);
  writeFileSync(policy, original);
  assert.equal(comparePolicies(dir, root).copiesAgree, true);
  rmSync(policy);
  assert.throws(() => verifyPolicy(root));
  symlinkSync(join(dir, 'OPERATING-LAW.md'), policy);
  assert.throws(() => verifyPolicy(root), /regular file/);
  rmSync(policy);
  writeFileSync(policy, original);
  const manifestPath = join(root, 'policy-manifest.json'),
    manifest = JSON.parse(readFileSync(manifestPath));
  delete manifest.files['HARDENING.md'];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyPolicy(root), /Incomplete/);
});
test('public check and read commands actually verify and emit the complete policy content', () => {
  const result = spawnSync(process.execPath, [join(dir, 'agent-policy.mjs'), 'read'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(readFileSync(join(dir, 'HARDENING.md'), 'utf8')));
  assert.match(result.stdout, /policy-content-emitted/);
  assert.equal(
    spawnSync(process.execPath, [join(dir, 'agent-policy.mjs'), 'check', '--bad', dir]).status,
    1
  );
});
test('client-only and existing-API use publish immediately regardless of clock or unrelated engine', () => {
  const route = classifyDelivery(['src/pages/Lobby.tsx', 'src/services/ExistingEngineApi.ts']);
  assert.equal(route.engineActivationRequired, false);
  const action = nextAction({
    checks: 'passed',
    access: 'available',
    helper: 'available',
    ...route,
    unrelatedEnginePending: true,
    minute: 11,
  });
  assert.equal(action.action, 'publish-and-verify-now');
  assert.equal(action.hourlyWait, false);
});
test('engine preparation never waits; only actual engine activation needs certification', () => {
  const route = classifyDelivery(['server/src/engine/Table.ts']);
  assert.equal(route.engineActivationRequired, true);
  assert.equal(route.engineReasons.length, 1);
  assert.equal(
    nextAction({ checks: 'passed', access: 'available', ...route }).certificateRequired,
    true
  );
  assert.equal(
    nextAction({ checks: 'passed', access: 'available', ...route }).hourlyWaitForPreparation,
    false
  );
});
test('a new engine contract needs named evidence, while database checks are not engine activation', () => {
  assert.equal(
    classifyDelivery(['supabase/migrations/change.sql']).engineActivationRequired,
    false
  );
  assert.throws(
    () => classifyDelivery(['src/App.tsx'], { dependency: 'new RPC' }),
    /source evidence/
  );
  assert.equal(
    classifyDelivery(['src/App.tsx'], {
      dependency: 'new RPC v2',
      evidence: 'server/src/router.ts exports v2 only in candidate',
    }).engineActivationRequired,
    true
  );
  assert.equal(classifyDelivery(['package.json']).classificationComplete, false);
  assert.throws(() => classifyDelivery([]), /unavailable/);
  assert.throws(() => classifyDelivery(['../secret']), /malformed/);
});
test('failed builds and failed prechecks demand repair without invented hourly cooldown', () => {
  for (const outcome of ['build-failed', 'check-failed', 'preflight-failed']) {
    const result = nextAction({ outcome });
    assert.equal(result.action, 'diagnose-fix-revalidate-and-submit');
    assert.equal(result.hourlyWait, false);
    assert.equal(result.retry, false);
  }
});
test('unknown outcome preserves the operation and refuses blind retry; published means verify', () => {
  assert.deepEqual(nextAction({ outcome: 'unknown', operation: 'receiver-42' }), {
    action: 'read-owning-operation',
    retry: false,
    operation: 'receiver-42',
    independentWork: true,
  });
  assert.equal(nextAction({ outcome: 'published' }).action, 'verify-live-identity-and-behavior');
  assert.equal(nextAction({ outcome: 'published' }).retry, false);
  assert.equal(
    nextAction({ outcome: 'cutover-failed', access: 'available' }).reassessCertificateNow,
    true
  );
});
test('missing access blocks only dependent work; unavailable helper is not a chat wait', () => {
  for (const access of ['missing', 'unknown', undefined]) {
    const action = nextAction({ access });
    assert.equal(action.dependentActionAllowed, false);
    assert.equal(action.independentWork, true);
    assert.equal(action.ownerApprovalRequired, false);
  }
  const action = nextAction({ access: 'available', helper: 'unavailable' });
  assert.equal(action.waitForChat, false);
  assert.equal(action.confirmNoOtherWriter, true);
});
test('a real isolated Git diff includes deletions and both rename paths, preserving exact identity', (t) => {
  const root = temporary(t);
  runGit(root, 'init', '-b', 'test');
  runGit(root, 'config', 'user.name', 'Policy Test');
  runGit(root, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'old.md'), 'old');
  runGit(root, 'add', 'old.md');
  runGit(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture base');
  const base = runGit(root, 'rev-parse', 'HEAD');
  runGit(root, 'mv', 'old.md', 'new.md');
  runGit(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture rename');
  const report = inspectCandidate(root, base);
  assert.deepEqual(report.paths.sort(), ['new.md', 'old.md']);
  assert.equal(report.trackedWorktreeClean, true);
  assert.equal(report.head, runGit(root, 'rev-parse', 'HEAD'));
  assert.equal(report.delivery.engineActivationRequired, false);
  writeFileSync(join(root, 'new.md'), 'dirty');
  assert.equal(inspectCandidate(root, base).trackedWorktreeClean, false);
});
test('missing, mismatched, cancelled, skipped or unsourced evidence never becomes pass', () => {
  const report = (evidence) =>
    deliveryReport({ schemaVersion: 1, revision: sha, requiredEvidence: ['checks'], evidence });
  const good = {
    id: 'checks',
    revision: sha,
    status: 'passed',
    source: 'Actions run 42 job 23',
    observedAt: time,
  };
  assert.equal(report([good]).suppliedRequirementsSatisfied, true);
  for (const evidence of [
    [],
    [{ ...good, revision: other }],
    [{ ...good, source: '' }],
    [{ ...good, observedAt: '' }],
    [{ ...good, status: 'skipped' }],
    [{ ...good, status: 'cancelled' }],
  ]) {
    assert.equal(report(evidence).suppliedRequirementsSatisfied, false);
    assert.equal(report(evidence).results[0].status, 'unknown');
  }
  assert.throws(() => report([good, good]), /Duplicate/);
  assert.equal(report([{ ...good, status: 'failed' }]).results[0].status, 'failed');
});
test('phase timing preserves missing and invalid data instead of inventing zero or total savings', () => {
  assert.equal(duration(time, '2026-09-17T18:02:00Z'), 120);
  assert.equal(duration(time, '2026-09-17T17:59:00Z'), null);
  assert.equal(duration(null, time), null);
  assert.equal(duration('2026-09-17T18:00:00', time), null);
  const result = deliveryReport({
    schemaVersion: 1,
    revision: sha,
    requiredEvidence: ['live'],
    evidence: [],
    intervals: [
      { phase: 'publication', start: time, end: '2026-09-17T18:02:00Z', source: 'Publisher run42' },
    ],
  });
  assert.equal(result.timing.find((v) => v.phase === 'publication').seconds, 120);
  assert.equal(result.timing.find((v) => v.phase === 'activation').seconds, null);
});
test('provider timing requires all pages and exact run ownership', () => {
  const run = { id: 42, head_sha: sha, created_at: time, run_started_at: '2026-09-17T18:00:30Z' };
  const jobs = {
    total_count: 1,
    jobs: [
      {
        id: 9,
        run_id: 42,
        name: 'Checks',
        started_at: '2026-09-17T18:00:40Z',
        completed_at: '2026-09-17T18:01:40Z',
        conclusion: 'success',
      },
    ],
  };
  const result = providerTiming(run, jobs);
  assert.equal(result.runQueueSeconds, 30);
  assert.equal(result.jobs[0].executionSeconds, 60);
  assert.equal(result.jobs[0].runnerQueueSeconds, null);
  assert.throws(() => providerTiming(run, { ...jobs, total_count: 2 }), /paginate/);
  assert.throws(() => providerTiming({ ...run, id: 43 }, jobs), /another run/);
});

test('the actual hook receipt preserves failure and pending hosted proof in isolated Git metadata', (t) => {
  const root = temporary(t);
  runGit(root, 'init', '-b', 'test');
  runGit(root, 'config', 'user.name', 'Policy Test');
  runGit(root, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'scope.md'), 'candidate');
  runGit(root, 'add', 'scope.md');
  runGit(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture');
  for (const code of ['0', '1']) {
    const result = spawnSync(
      process.execPath,
      [join(dir, 'agent-policy.mjs'), 'hook-report', String(Math.floor(Date.now() / 1000)), code],
      { cwd: root, env: environment(), encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(join(root, '.git/agent-policy-preflight.json')));
    assert.equal(receipt.results[0].status, code === '0' ? 'passed' : 'failed');
    assert.equal(receipt.suppliedRequirementsSatisfied, false);
    assert.ok(receipt.remaining.includes('live-verification'));
    assert.equal(receipt.revision, runGit(root, 'rev-parse', 'HEAD'));
  }
});
test('the actual CI summary command does not convert a skipped required result to success', () => {
  const result = spawnSync(process.execPath, [join(dir, 'agent-policy.mjs'), 'ci-report'], {
    encoding: 'utf8',
    env: {
      ...environment(),
      POLICY_CI_REVISION: sha,
      POLICY_CI_NEEDS: JSON.stringify({
        compiler: { result: 'success' },
        publication: { result: 'skipped' },
      }),
      GITHUB_RUN_ID: '42',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.results[0].status, 'passed');
  assert.equal(report.results[1].status, 'unknown');
  assert.equal(report.suppliedRequirementsSatisfied, false);
});

test('test-only engine source does not request activation and unknown inputs require inspection', () => {
  const route = classifyDelivery(['server/src/engine/Foo.test.ts']);
  assert.equal(route.engineActivationRequired, false);
  assert.deepEqual(route.components, ['verification']);
  assert.equal(
    nextAction({ checks: 'passed', access: 'available', ...classifyDelivery(['package.json']) })
      .action,
    'inspect-unclassified-inputs-and-contracts'
  );
});

test('invoking the actual checker through a symlink cannot silently skip validation', (t) => {
  const root = temporary(t),
    bundle = join(root, 'bundle'),
    alias = join(root, 'alias');
  cpSync(dir, bundle, { recursive: true });
  symlinkSync(bundle, alias, 'dir');
  writeFileSync(join(bundle, 'OPERATING-LAW.md'), 'stale policy');
  const result = spawnSync(process.execPath, [join(alias, 'agent-policy.mjs'), 'check'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Policy drift/);
});
