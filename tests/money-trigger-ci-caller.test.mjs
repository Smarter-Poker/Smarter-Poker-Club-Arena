import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const lines = workflow.split('\n');
const name = '      - name: Supabase Invariants - A Money Trigger Declares Itself';
const start = lines.indexOf(name);
assert.notEqual(start, -1, 'the actual money-trigger workflow step must exist');
const run = lines.findIndex((line, index) => index > start && line === '        run: |');
assert.notEqual(run, -1, 'the actual step must retain a literal shell body');
const body = [];
for (const line of lines.slice(run + 1)) {
  if (line.trim() && !line.startsWith('          ')) break;
  body.push(line.slice(10));
}
const header = lines.slice(start, run).join('\n');
const strict = 'scripts/ci/check-money-trigger-declared.mjs';
const protection = 'scripts/ci/assert-money-trigger-protection.mjs';

// Exercise the maintained workflow shell verbatim. Only child outcomes are
// controlled: no real GitHub request, credential, SQL, dispatch or proof is used.
function invoke({ checker = 0, guard = 0, tee = 0, signal = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-trigger-caller-'));
  try {
    const calls = path.join(dir, 'calls');
    const summary = path.join(dir, 'summary');
    const harness = [
      'node() {',
      '  printf "%s\\n" "$*" >> "$CALL_LOG"',
      '  case "$1" in',
      '    scripts/ci/check-money-trigger-declared.mjs)',
      '      if [ "$CHECKER_SIGNAL" = "1" ]; then',
      '        (exec sh -c \'kill -TERM $$\')',
      '      else',
      '        return "$CHECKER_STATUS"',
      '      fi ;;',
      '    scripts/ci/assert-money-trigger-protection.mjs)',
      '      [ "$GITHUB_TOKEN" = "modeled-standard-token" ] || return 99',
      '      [ "$MONEY_TRIGGER_REPORTER_APP_ID" = "4962039" ] || return 99',
      '      return "$GUARD_STATUS" ;;',
      '    *) return 98 ;;',
      '  esac',
      '}',
      'tee() { cat; return "$TEE_STATUS"; }',
      ...body,
    ].join('\n');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', harness], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        CALL_LOG: calls,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_TOKEN: 'modeled-standard-token',
        MONEY_TRIGGER_REPORTER_APP_ID: '4962039',
        CHECKER_STATUS: String(checker),
        CHECKER_SIGNAL: signal ? '1' : '0',
        GUARD_STATUS: String(guard),
        TEE_STATUS: String(tee),
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null, result.stderr);
    return {
      status: result.status,
      calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [],
      summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ordinary same-file success does not request historical protection', () => {
  const result = invoke({ guard: 1 });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [strict]);
});

test('literal policy refusal delegates only to mandatory App-bound protection', () => {
  const result = invoke({ checker: 1 });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [strict, protection]);
  assert.match(result.summary, /independently required.*App.*verdict/i);
  assert.doesNotMatch(result.summary, /every trigger.*declares itself/i);
});

for (const guard of [1, 127]) {
  test('policy refusal cannot pass failed or unavailable protection: ' + guard, () => {
    const result = invoke({ checker: 1, guard });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, [strict, protection]);
  });
}

for (const checker of [2, 3, 127]) {
  test('unreadable or unknown checker result cannot delegate: ' + checker, () => {
    const result = invoke({ checker });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, [strict]);
  });
}

test('terminated checker cannot delegate', () => {
  const result = invoke({ signal: true });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, [strict]);
});

for (const checker of [0, 1]) {
  test('a log pipeline failure is not policy exit 1: checker ' + checker, () => {
    const result = invoke({ checker, tee: 1 });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, [strict]);
  });
}

test('actual caller binds only the standard token and configured public App identity', () => {
  assert.match(header, /^        env:\n          GITHUB_TOKEN: \$\{\{ github\.token \}\}\n          MONEY_TRIGGER_REPORTER_APP_ID: \$\{\{ vars\.MONEY_TRIGGER_REPORTER_APP_ID \}\}$/m);
  assert.doesNotMatch(header, /secrets\.|PRIVATE_KEY|REPORTER_TOKEN/);
});

test('caller regression is enforced by the existing pull-request repository check job', () => {
  const job = workflow.split('\n  typecheck_compile:\n')[1]?.split(/\n  [a-z_]+:\n/)[0];
  assert.ok(job, 'the existing repository-check job must exist');
  assert.match(job, /if: github\.event_name == 'pull_request'/);
  assert.match(job, /run: node --test tests\/money-trigger-ci-caller\.test\.mjs/);
});
