// Local source contracts and shell stubs only; no database/runtime proof.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  buildFinancialRepairCandidate,
  readRepairInput,
} from './leaderboard-financial-repair-integration-candidate.mjs';

const source = readRepairInput('leaderboard-isolation-preflight.sh');
const modes = ['v2-payout', 'capture-compatibility', 'opening'];
const gate = "|| failure 'isolated catalog differs from current source'";
const cleanup = "cleanup || failure 'explicit cleanup verification failed'";
test('all modes retain fresh read-only restore, exact catalog gate and original owned cleanup', () => {
  const cleanupBody = source.slice(
    source.indexOf('cleanup_complete=false\n'),
    source.indexOf('failure() {')
  );
  const readBody = source.slice(
    source.indexOf('source_client() {'),
    source.indexOf('unset DATABASE_URL PGDATABASE PGOPTIONS\n')
  );
  for (const mode of modes) {
    const output = buildFinancialRepairCandidate(source, mode);
    assert.equal(spawnSync('bash', ['-n'], { input: output, encoding: 'utf8' }).status, 0);
    const lint = spawnSync('shellcheck', ['-s', 'bash', '-'], { input: output, encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    assert.ok(output.includes(cleanupBody));
    assert.ok(output.includes(readBody));
    assert.equal(output.split(gate).length, 2);
    assert.ok(output.indexOf(gate) < output.indexOf('# Candidate invocation only AFTER'));
    assert.ok(
      output.indexOf('unset DATABASE_URL PGDATABASE PGOPTIONS PGHOST PGUSER PGPASSWORD') <
        output.indexOf(gate)
    );
    assert.ok(output.indexOf('# Candidate invocation only AFTER') < output.indexOf(cleanup));
    assert.equal(output.split('docker network create --internal').length, 2);
    assert.doesNotMatch(
      output.slice(output.indexOf('# Candidate invocation only AFTER')),
      /source_client|DATABASE_URL=|PGPASSWORD=|\|\| true/
    );
    assert.match(
      output,
      /production installation, Auth parity, worker\/UI, concurrency and unknown-ack qualification remain separate/
    );
  }
});
test('installation order and transaction owners differ deliberately between modes', () => {
  const payout = buildFinancialRepairCandidate(source, 'v2-payout');
  const compatibility = buildFinancialRepairCandidate(source, 'capture-compatibility');
  const opening = buildFinancialRepairCandidate(source, 'opening');
  function ordered(output, stages) {
    let previous = -1;
    for (const stage of stages) {
      const position = output.indexOf(`repair_sql '${stage}'`);
      assert.ok(position > previous, stage);
      previous = position;
    }
  }
  ordered(payout, ['capture', 'ranking', 'payout', 'config', 'opening', 'fixture']);
  ordered(compatibility, ['bootstrap', 'capture', 'fixture']);
  ordered(opening, ['config', 'opening', 'fixture']);
  for (const output of [payout, compatibility]) {
    assert.match(
      output,
      /printf '%s\\n' 'SET ROLE postgres;' >"\$scratch\/repair-capture.sql" \|\| failure/
    );
    assert.match(
      output,
      /cat "\$here\/leaderboard-capture-basis-candidate.sql" >>"\$scratch\/repair-capture.sql" \|\| failure/
    );
    assert.match(
      output,
      /printf '%s\\n' 'RESET ROLE;' >>"\$scratch\/repair-capture.sql" \|\| failure/
    );
    assert.equal(output.split('SET ROLE postgres;').length, 2);
  }
  assert.doesNotMatch(opening, /SET ROLE postgres;/);
  assert.match(compatibility, /printf '%s\\n' 'COMMIT;'/);
  assert.doesNotMatch(payout, /printf '%s\\n' 'COMMIT;'/);
  assert.doesNotMatch(opening, /printf '%s\\n' 'COMMIT;'/);
  for (const output of [payout, compatibility, opening]) {
    assert.ok(output.indexOf('chmod 600 "$scratch"/repair-*.sql') < output.indexOf("repair_sql '"));
    assert.match(
      output,
      /psql -h \/tmp -XAtq -U "\$bootstrap" -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate/
    );
    assert.doesNotMatch(
      output,
      /leaderboard-isolated-concurrency-draft.sh|leaderboard-unknown-ack-draft.sh/
    );
  }
});
test('unreviewed modes and whole input drift fail closed before generation', () => {
  for (const mode of [
    '',
    'all',
    'concurrency',
    'unknown-ack',
    'constructor',
    'v2-payout;echo unsafe',
  ])
    assert.throws(() => buildFinancialRepairCandidate(source, mode));
  for (const changed of [source + '\n', source.replace(gate, 'weakened'), source + cleanup])
    assert.throws(() => buildFinancialRepairCandidate(changed, 'opening'));
  for (const mode of modes) {
    assert.throws(() =>
      buildFinancialRepairCandidate(source, mode, (name) => readRepairInput(name) + '\n')
    );
  }
});
function scratch() {
  const parent =
    process.env.TMPDIR || (process.env.CI === 'true' ? process.env.RUNNER_TEMP : undefined);
  assert.ok(
    parent &&
      (parent.startsWith('/Volumes/SmarterWork/agent-work/') ||
        (process.env.CI === 'true' && parent === process.env.RUNNER_TEMP))
  );
  return mkdtempSync(join(parent, 'repair-contract-'));
}
test('failed private preparation never admits a client or compatibility COMMIT', () => {
  const output = buildFinancialRepairCandidate(source, 'capture-compatibility');
  const prepare = output.slice(output.indexOf('[[ "$(tail -n 1'), output.indexOf('repair_sql() {'));
  for (const missing of ['none', 'authorization', 'capture', 'compatibility']) {
    const directory = scratch();
    try {
      if (missing !== 'authorization')
        writeFileSync(
          join(directory, 'leaderboard-isolated-authorization-draft.sql'),
          'BEGIN;\nSELECT 1;\nROLLBACK;\n'
        );
      if (missing !== 'capture')
        writeFileSync(
          join(directory, 'leaderboard-capture-basis-candidate.sql'),
          'BEGIN;\nSELECT 2;\nCOMMIT;\n'
        );
      if (missing !== 'compatibility')
        writeFileSync(
          join(directory, 'leaderboard-capture-basis-regression-candidate.sql'),
          'BEGIN;\nSELECT 3;\nROLLBACK;\n'
        );
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail\numask 077\nfailure(){ exit 42; }\n${prepare}\nprintf admitted >"$scratch/admitted"\n`,
        ],
        {
          encoding: 'utf8',
          timeout: 3000,
          env: { ...process.env, here: directory, scratch: directory },
        }
      );
      assert.equal(existsSync(join(directory, 'admitted')), missing === 'none');
      if (missing === 'none') {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          readFileSync(join(directory, 'repair-bootstrap.sql'), 'utf8'),
          'BEGIN;\nSELECT 1;\nCOMMIT;\n'
        );
        assert.equal(
          readFileSync(join(directory, 'repair-capture.sql'), 'utf8'),
          'SET ROLE postgres;\nBEGIN;\nSELECT 2;\nCOMMIT;\nRESET ROLE;\n'
        );
      } else assert.notEqual(result.status, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
test('failure diagnostics expose only fixed stage and strict SQLSTATE, preserving actual failure', () => {
  const output = buildFinancialRepairCandidate(source, 'opening');
  const body = output.slice(
    output.indexOf('repair_sql() {'),
    output.indexOf("repair_sql 'config'")
  );
  for (const privateError of [
    'ERROR:  55000\nSECRET_SQL_TOKEN_NEVER_EMIT\n',
    'ERROR:  SECRET_SQL_TOKEN_NEVER_EMIT\n',
    'ERROR:  55000 SECRET_SQL_TOKEN_NEVER_EMIT\n',
  ]) {
    const directory = scratch();
    try {
      writeFileSync(join(directory, 'input.sql'), 'PRIVATE_SQL_NEVER_EMIT\n');
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail\nfailure(){ exit 42; }\ntimeout(){ shift; "$@"; }\ndocker(){ printf '%s' "$PRIVATE_ERROR"; return 9; }\n${body}\nrepair_sql 'fixture' "$scratch/input.sql"\n`,
        ],
        {
          encoding: 'utf8',
          timeout: 3000,
          env: {
            ...process.env,
            scratch: directory,
            container: 'stub',
            bootstrap: 'stub',
            PRIVATE_ERROR: privateError,
          },
        }
      );
      assert.equal(result.status, 42);
      assert.doesNotMatch(result.stdout + result.stderr, /SECRET_SQL_TOKEN|PRIVATE_SQL/);
      assert.match(result.stderr, /Mode=opening Stage=fixture SQLSTATE=(55000|unknown) Exit=9/);
      assert.equal(readFileSync(join(directory, 'repair-fixture.log'), 'utf8'), privateError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
test('manual workflow enforces contracts and preserves main-only owned cleanup without raw artifacts', () => {
  const workflow = readFileSync(
    new URL(
      '../../.github/workflows/leaderboard-isolated-financial-repair-qualification.yml',
      import.meta.url
    ),
    'utf8'
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /timeout-minutes: 20/);
  assert.match(workflow, /leaderboard-financial-repair-integration-candidate.test.mjs/);
  assert.match(workflow, /node-version: '22'/);
  assert.match(workflow, /shellcheck "\$candidate"/);
  assert.match(workflow, /trap cleanup_candidate EXIT/);
  assert.doesNotMatch(
    workflow,
    /upload-artifact|continue-on-error|schedule:|pull_request:|push:|cat .*log/
  );
});
