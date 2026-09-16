import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script =
  process.env.QUEUE_PR_TEST_SCRIPT ||
  fileURLToPath(new URL('../../.github/scripts/queue-pr.sh', import.meta.url));
const head = 'a'.repeat(40);
const snapshot = (patch = {}) => ({
  state: 'OPEN',
  isDraft: false,
  mergeStateStatus: 'BLOCKED',
  autoMergeRequest: null,
  baseRefName: 'main',
  headRefOid: head,
  labels: [],
  ...patch,
});
const response = (value, status = 0) => ({ stdout: JSON.stringify(value), status });
const failure = { stderr: 'GraphQL: request refused', status: 1 };
const protectedRules = response([
  {
    type: 'required_status_checks',
    parameters: {
      required_status_checks: [{ context: 'CI' }],
    },
  },
]);

// Only gh is replaced. Every case executes the actual Bash helper and jq.
// Unexpected extra commands fail instead of repeating the last fixture reply.
function run(t, replies) {
  const dir = mkdtempSync(join(tmpdir(), 'ca-queue-pr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'replies.json'), JSON.stringify(replies));
  writeFileSync(
    join(dir, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.QUEUE_FIXTURE;
const log = path.join(root, 'calls.json');
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log)) : [];
const replies = JSON.parse(fs.readFileSync(path.join(root, 'replies.json')));
const reply = replies[calls.length];
calls.push(process.argv.slice(2));
fs.writeFileSync(log, JSON.stringify(calls));
if (!reply) { process.stderr.write('Unexpected command'); process.exit(99); }
process.stdout.write(reply.stdout || '');
process.stderr.write(reply.stderr || '');
process.exitCode = reply.status || 0;
`,
    { mode: 0o755 }
  );
  const result = spawnSync('bash', [script, 'owner/repo', '42'], {
    encoding: 'utf8',
    timeout: 15000,
    env: { PATH: `${dir}:${process.env.PATH}`, QUEUE_FIXTURE: dir },
  });
  assert.ifError(result.error);
  const calls = JSON.parse(readFileSync(join(dir, 'calls.json'), 'utf8'));
  assert.equal(calls.length, replies.length, `${result.stdout}\n${result.stderr}`);
  for (const args of calls.filter((args) => args[1] === 'merge')) {
    assert.ok(!args.includes('--admin'));
    assert.equal(args[args.indexOf('--match-head-commit') + 1], head);
  }
  return { ...result, calls };
}

for (const [name, patch] of [
  ['draft', { isDraft: true }],
  ['closed', { state: 'CLOSED' }],
  ['already queued', { autoMergeRequest: {} }],
  ['hold label', { labels: [{ name: 'hold' }] }],
]) {
  test(`initial ${name} does not request a merge`, (t) => {
    assert.equal(run(t, [response(snapshot(patch))]).status, 0);
  });
}
test('eligible PR requests protected auto-merge pinned to the observed head', (t) => {
  assert.equal(run(t, [response(snapshot()), response({})]).status, 0);
});
for (const [name, patch] of [
  ['draft', { isDraft: true }],
  ['closed', { state: 'CLOSED' }],
  ['merged', { state: 'MERGED' }],
  ['queued by another actor', { autoMergeRequest: {} }],
  ['new head', { headRefOid: 'b'.repeat(40) }],
  ['new base', { baseRefName: 'release' }],
  ['hold label', { labels: [{ name: 'do-not-merge' }] }],
]) {
  test(`a concurrent ${name} after auto-merge refusal is a bounded no-op`, (t) => {
    assert.equal(
      run(t, [
        response(snapshot({ mergeStateStatus: name === 'draft' ? 'BLOCKED' : 'CLEAN' })),
        failure,
        response(snapshot(patch)),
      ]).status,
      0
    );
  });
}
test('unchanged permission failure remains a failure', (t) => {
  const r = run(t, [response(snapshot()), failure, response(snapshot())]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Could not arm protected auto-merge/);
});
test('stale CLEAN state cannot trigger a direct merge after checks change', (t) => {
  assert.equal(
    run(t, [response(snapshot({ mergeStateStatus: 'CLEAN' })), failure, response(snapshot())])
      .status,
    1
  );
});
for (const state of ['CLEAN', 'HAS_HOOKS']) {
  test(`fresh ${state} fallback retains required checks and the same head`, (t) => {
    assert.equal(
      run(t, [
        response(snapshot()),
        failure,
        response(snapshot({ mergeStateStatus: state })),
        protectedRules,
        response({}),
      ]).status,
      0
    );
  });
}
test('a clean PR without required checks cannot merge directly', (t) => {
  assert.equal(
    run(t, [
      response(snapshot()),
      failure,
      response(snapshot({ mergeStateStatus: 'CLEAN' })),
      response([]),
    ]).status,
    1
  );
});
test('draft conversion during direct merge is also a bounded no-op', (t) => {
  assert.equal(
    run(t, [
      response(snapshot()),
      failure,
      response(snapshot({ mergeStateStatus: 'CLEAN' })),
      protectedRules,
      failure,
      response(snapshot({ isDraft: true })),
    ]).status,
    0
  );
});
test('an unchanged direct-merge failure is not reported as success', (t) => {
  assert.equal(
    run(t, [
      response(snapshot()),
      failure,
      response(snapshot({ mergeStateStatus: 'CLEAN' })),
      protectedRules,
      failure,
      response(snapshot()),
    ]).status,
    1
  );
});
test('failed refresh does not infer the PR became a draft', (t) => {
  assert.equal(run(t, [response(snapshot()), failure, failure]).status, 1);
});
test('incomplete refresh fails closed before a direct merge', (t) => {
  assert.equal(
    run(t, [response(snapshot()), failure, response({ ...snapshot(), headRefOid: null })]).status,
    1
  );
});

// These existing event owners must be usable within the local-compute policy.
// Credential-bearing consumers stay off the untrusted PR test lanes.
for (const [file, lane, trusted] of [
  ['agent-autopilot.yml', 'smarter-local-publish', true],
  ['agent-open-pr.yml', 'smarter-local-publish', true],
  ['agent-branch-proposal.yml', 'smarter-local-linux-arm64', false],
]) {
  test(`${file} retains its trust boundary on the approved local lane`, () => {
    const source = readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes(`runs-on: [self-hosted, ${lane}]`));
    assert.doesNotMatch(source, /runs-on:.*(?:ubuntu-|macos-|windows-)/);
    assert.doesNotMatch(source, /^\s+schedule:|--admin|continue-on-error:/m);
    if (trusted) {
      assert.match(source, /ref: \$\{\{ github.event.repository.default_branch \}\}/);
      assert.match(source, /actions\/create-github-app-token@v3/);
      assert.match(source, /secrets.AUTOPILOT_APP_PRIVATE_KEY/);
      assert.match(source, /head(?:_repository|.repo).full_name == github.repository/);
    } else {
      assert.doesNotMatch(source, /secrets\.|actions\/checkout|create-github-app-token/);
      assert.match(source, /contents: read/);
    }
  });
}
