import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { financialDiagnostics } from './leaderboard-financial-diagnostics.mjs';
import { buildFinancialCandidate } from './leaderboard-financial-integration-candidate.mjs';

const payout = [
  'missing_close_refuses_without_movement',
  'stale_close_refuses_without_movement',
  'new_player_zero_baseline_pays',
  'complete_close_pays_once',
  'genuine_empty_close_is_distinct',
  'positive_awards_only_for_cent_tie',
];
const fixture = payout
  .map((name, i) => `${name}|${i ? 't||' : 'f|P0001|case_execution'}`)
  .join('\n');
test('only complete fixed verdicts surface; arbitrary private messages never surface', () => {
  const output = financialDiagnostics(
    'payout',
    `SECRET_PRIVATE_PASSWORD\nERROR: arbitrary financial message\n${fixture}\n`
  );
  assert.match(
    output,
    /case=missing_close_refuses_without_movement pass=f stage=case_execution SQLSTATE=P0001/
  );
  assert.equal(output.split('\n').length, 6);
  assert.doesNotMatch(output, /SECRET|arbitrary|PASSWORD|ERROR:/);
  assert.match(
    financialDiagnostics('concurrency', 'private text\nFINANCIAL_DRIVER|f||concurrent_callers\n'),
    /stage=concurrent_callers SQLSTATE=unknown/
  );
  assert.match(
    financialDiagnostics('unknown-ack', 'FINANCIAL_DRIVER|f||same_identity_retry\n'),
    /stage=same_identity_retry/
  );
});
test('unknown, secret-bearing, malformed, duplicate, partial and oversized receipts refuse', () => {
  for (const input of [
    '',
    fixture.split('\n').slice(1).join('\n'),
    `${fixture}\n${fixture.split('\n')[0]}`,
    fixture.replace('P0001', 'PASSWORD_SECRET'),
    fixture.replace('case_execution', 'arbitrary_secret'),
    fixture.replace('|f|', '|true|'),
    fixture.replace('P0001', '00000'),
    fixture.replace('missing_close_refuses_without_movement', 'SECRET_UNKNOWN_CASE'),
    `${fixture}\nunknown|f|P0001|case_execution`,
    `${fixture}|extra`,
    'x'.repeat(65537),
  ])
    assert.throws(() => financialDiagnostics('payout', input));
  for (const input of [
    'FINANCIAL_DRIVER|f||SECRET',
    'FINANCIAL_DRIVER|f|secret|quarantine',
    'FINANCIAL_DRIVER|t||quarantine',
  ])
    assert.throws(() => financialDiagnostics('unknown-ack', input));
  assert.throws(() => financialDiagnostics('constructor', fixture));
});
test('funding fixed cases and stages agree with actual unchanged verdict producer', () => {
  const sql = readFileSync(
    new URL('./leaderboard-isolated-funding-policy-draft.sql', import.meta.url),
    'utf8'
  );
  const names = [
    ...sql.match(/FOREACH case_name IN ARRAY ARRAY\[([\s\S]*?)\] LOOP/)[1].matchAll(/'([^']+)'/g),
  ].map((match) => match[1]);
  const stages = [...sql.matchAll(/stage:='([^']+)'/g)].map((match) => match[1]);
  for (const stage of stages) {
    const lines = names.map((name, i) => `${name}|${i ? 't||' : `f|P0001|${stage}`}`).join('\n');
    assert.equal(financialDiagnostics('funding', lines).split('\n').length, 6);
  }
});
test('actual generated failure arm reports before cleanup and retains financial failure', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'leaderboard-isolation-preflight.sh'), 'utf8');
  const output = buildFinancialCandidate(source, 'payout');
  const arm = output.match(
    /\|\| (\{ if ! node "\$here\/leaderboard-financial-diagnostics\.mjs" 'payout' "\$scratch\/financial-payout-fixture\.log";[\s\S]*?failure 'isolated payout SQL assertions failed'; \})/
  )[1];
  for (const content of [fixture, 'SECRET_PRIVATE_PASSWORD|malformed']) {
    const scratch = mkdtempSync(join(tmpdir(), 'financial-diagnostic-test-'));
    try {
      writeFileSync(join(scratch, 'financial-payout-fixture.log'), content, { mode: 0o600 });
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail
here="$1"; scratch="$2"
failure() { echo 'FIXED_FINANCIAL_FAILURE'; exit 7; }
trap 'status=$?; echo ORIGINAL_CLEANUP; exit "$status"' EXIT
false || ${arm}`,
          'test',
          here,
          scratch,
        ],
        { encoding: 'utf8' }
      );
      assert.equal(result.status, 7);
      const combined = result.stdout + result.stderr;
      assert.doesNotMatch(combined, /SECRET_PRIVATE_PASSWORD|malformed/);
      assert.ok(
        result.stdout.indexOf('Financial Diagnostic:') <
          result.stdout.indexOf('ORIGINAL_CLEANUP') ||
          result.stderr.includes('Financial Diagnostic: unknown')
      );
      assert.match(result.stdout, /FIXED_FINANCIAL_FAILURE\nORIGINAL_CLEANUP/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test('pre-verdict psql failure locates only stdin line and SQLSTATE without accepting a verdict', () => {
  const result = financialDiagnostics(
    'payout',
    'SECRET_PASSWORD\npsql:<stdin>:245: ERROR:  P0001\n'
  );
  assert.equal(
    result,
    'Financial Diagnostic: mode=payout verdicts=unavailable input_line=245 SQLSTATE=P0001'
  );
  assert.doesNotMatch(result, /SECRET|PASSWORD|pass=t/);
  for (const input of [
    'psql:<stdin>:0: ERROR: P0001',
    'psql:<stdin>:245: ERROR: 00000',
    'psql:<stdin>:245: ERROR: P0001 SECRET',
    'psql:SECRET:245: ERROR: P0001',
    'psql:<stdin>:245: ERROR: P0001\npsql:<stdin>:246: ERROR: P0001',
    'missing_close_refuses_without_movement|f|P0001|case_execution\npsql:<stdin>:245: ERROR: P0001',
  ])
    assert.throws(() => financialDiagnostics('payout', input));
  const here = dirname(fileURLToPath(import.meta.url));
  const generated = buildFinancialCandidate(
    readFileSync(join(here, 'leaderboard-isolation-preflight.sh'), 'utf8'),
    'payout'
  );
  assert.match(generated, /-v VERBOSITY=sqlstate --file=-/);
});
