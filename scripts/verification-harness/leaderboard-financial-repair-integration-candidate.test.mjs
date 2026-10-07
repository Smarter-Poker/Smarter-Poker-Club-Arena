// Local source contracts and shell stubs only; no database/runtime proof.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  buildFinancialRepairCandidate,
  readRepairInput,
  candidateFunctionBodyMd5,
} from './leaderboard-financial-repair-integration-candidate.mjs';

const source = readRepairInput('leaderboard-isolation-preflight.sh');
const modes = [
  'v2-payout',
  'capture-compatibility',
  'opening',
  'worker',
  'historical-replay',
  'concurrency',
  'unknown-ack',
];
test('historical mode prepares every input before original paid bootstrap then all prospective replacements', () => {
  const output = buildFinancialRepairCandidate(source, 'historical-replay');
  let prior = output.indexOf('chmod 600 "$scratch"/repair-*.sql');
  for (const stage of ['historical-before', 'consolidated', 'postimage', 'historical-after']) {
    const position = output.indexOf(`repair_sql '${stage}'`);
    assert.ok(position > prior);
    prior = position;
  }
  assert.match(output, /--body-md5 "\$scratch\/repair-opening.sql" fn_complete_club_opening_setup/);
  assert.match(
    output,
    /--body-md5 "\$scratch\/repair-config.sql" fn_publish_leaderboard_reward_program/
  );
  assert.match(output, /candidate_opening_body_md5 \$opening_body/);
  assert.match(output, /candidate_publish_body_md5 \$publish_body/);
  assert.match(output, /--body-md5 "\$scratch\/repair-payout.sql" fn_payout_leaderboard/);
  assert.match(output, /candidate_payout_body_md5 \$payout_body/);
});
test('function body identity derives exact leading/trailing newlines and rejects duplicate/missing boundaries', () => {
  const name = 'fn_complete_club_opening_setup';
  const definition = `CREATE OR REPLACE FUNCTION public.${name}()\nRETURNS jsonb\nAS $function$\nBEGIN\nRETURN '{}';\nEND;\n$function$;\n`;
  assert.equal(candidateFunctionBodyMd5(definition, name), 'b86d941d4cde7d9ccbd87f8443ee2333');
  assert.equal(
    candidateFunctionBodyMd5(
      definition.replaceAll(name, 'fn_payout_leaderboard'),
      'fn_payout_leaderboard'
    ),
    'b86d941d4cde7d9ccbd87f8443ee2333'
  );
  for (const invalid of [
    '',
    definition + definition,
    definition.replace('$function$;', '$other$;'),
  ])
    assert.throws(() => candidateFunctionBodyMd5(invalid, name));
  assert.throws(() => candidateFunctionBodyMd5(definition, 'unreviewed'));
});
const gate = "|| failure 'isolated catalog differs from current source'";
const cleanup = "cleanup || failure 'explicit cleanup verification failed'";
test('prospective payout reads fixed case receipts on success and failure without hiding SQL failure', () => {
  const output = buildFinancialRepairCandidate(source, 'v2-payout');
  const body = output.slice(
    output.indexOf('repair_sql() {'),
    output.indexOf("repair_sql 'consolidated'")
  );
  assert.equal(body.split('node "$here/leaderboard-repair-financial-diagnostics.mjs"').length, 3);
  assert.match(body, /prospective verdict evidence refused/);
  assert.ok(body.indexOf('status=$?') < body.lastIndexOf('Financial Repair Diagnostic: unknown'));
  assert.ok(
    body.lastIndexOf('Financial Repair Diagnostic: unknown') <
      body.indexOf("failure 'isolated candidate assertions or installation failed'")
  );
  assert.match(output, /sha256sum "\$here\/leaderboard-repair-financial-diagnostics.mjs"/);
});
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
  const worker = buildFinancialRepairCandidate(source, 'worker');
  function ordered(output, stages) {
    let previous = -1;
    for (const stage of stages) {
      const position = output.indexOf(`repair_sql '${stage}'`);
      assert.ok(position > previous, stage);
      previous = position;
    }
  }
  ordered(payout, ['consolidated', 'postimage', 'fixture']);
  ordered(compatibility, ['bootstrap', 'capture', 'fixture']);
  ordered(opening, ['consolidated', 'postimage', 'fixture']);
  ordered(worker, ['consolidated', 'postimage', 'bootstrap', 'fixture']);
  assert.match(
    worker,
    /cat "\$scratch\/repair-authorization.sql" "\$here\/leaderboard-isolated-concurrency-fixture-draft.sql" >"\$scratch\/repair-bootstrap.sql" \|\| failure/
  );
  assert.match(
    worker,
    /cp "\$here\/leaderboard-isolated-worker-regression-candidate.sql" "\$scratch\/repair-fixture.sql" \|\| failure/
  );
  for (const output of [payout, compatibility, worker]) {
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
    assert.equal(output.split('SET ROLE postgres;').length, output === compatibility ? 2 : 3);
  }
  for (const output of [payout, opening, worker]) {
    assert.equal(output.split("repair_sql 'consolidated'").length, 2);
    assert.doesNotMatch(output, /repair_sql '(capture|ranking|payout|config|opening)'/);
    assert.match(output, /leaderboard-consolidated-migration-candidate.mjs/);
  }
  assert.match(compatibility, /printf '%s\\n' 'COMMIT;'/);
  assert.doesNotMatch(payout, /printf '%s\\n' 'COMMIT;'/);
  assert.doesNotMatch(opening, /printf '%s\\n' 'COMMIT;'/);
  for (const output of [payout, compatibility, opening, worker]) {
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
  for (const mode of ['', 'all', 'constructor', 'v2-payout;echo unsafe'])
    assert.throws(() => buildFinancialRepairCandidate(source, mode));
  for (const changed of [source + '\n', source.replace(gate, 'weakened'), source + cleanup])
    assert.throws(() => buildFinancialRepairCandidate(changed, 'opening'));
  for (const mode of modes) {
    assert.throws(() =>
      buildFinancialRepairCandidate(source, mode, (name) => readRepairInput(name) + '\n')
    );
  }
});
test('prospective concurrency and unknown-ack prepare complete inputs and safely bind private drivers', () => {
  for (const mode of ['concurrency', 'unknown-ack']) {
    const output = buildFinancialRepairCandidate(source, mode);
    const driverCall =
      'LEADERBOARD_REPAIR_HARNESS="$here" bash "$scratch/repair-driver.sh" "$container" "$scratch"';
    assert.ok(output.includes(driverCall));
    assert.ok(
      output.indexOf('chmod 600 "$scratch"/repair-*.sql') <
        output.indexOf("repair_sql 'consolidated'")
    );
    assert.ok(output.indexOf("repair_sql 'consolidated'") < output.indexOf(driverCall));
    assert.ok(
      output.includes(
        'cat "$scratch/repair-authorization.sql" "$scratch/repair-complete-companion.sql" >"$scratch/repair-bootstrap.sql" || failure'
      )
    );
    assert.ok(output.includes('here="${LEADERBOARD_REPAIR_HARNESS:?}"'));
    assert.ok(output.includes('candidate harness boundary changed'));
    if (mode === 'unknown-ack')
      assert.ok(output.indexOf("repair_sql 'bootstrap'") < output.indexOf(driverCall));
    else assert.doesNotMatch(output, /repair_sql 'bootstrap'/);
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
  const directory = mkdtempSync(join(parent, 'repair-contract-'));
  writeFileSync(
    join(directory, 'leaderboard-consolidated-postimage-candidate.sql'),
    'BEGIN;\nSELECT 9;\nROLLBACK;\n'
  );
  return directory;
}

test('all six consolidated modes qualify postimage immediately before any fixture and reject absent input', () => {
  const name = 'leaderboard-consolidated-postimage-candidate.sql';
  for (const mode of modes) {
    const output = buildFinancialRepairCandidate(source, mode);
    if (mode === 'capture-compatibility') {
      assert.doesNotMatch(output, /repair-postimage|consolidated-postimage/);
      continue;
    }
    assert.match(output, /sha256sum "\$here\/leaderboard-consolidated-postimage-candidate.sql"/);
    assert.ok(
      output.includes(
        'repair_sql \'consolidated\' "$scratch/repair-consolidated.sql"\nrepair_sql \'postimage\' "$scratch/repair-postimage.sql"'
      )
    );
    assert.ok(
      output.indexOf('cp "$here/' + name + '"') <
        output.indexOf('chmod 600 "$scratch"/repair-*.sql')
    );
    assert.throws(() =>
      buildFinancialRepairCandidate(source, mode, (input) => {
        if (input === name) throw new Error('missing');
        return readRepairInput(input);
      })
    );
  }
  const output = buildFinancialRepairCandidate(source, 'historical-replay');
  const prepare = output.slice(
    output.indexOf('# SET ROLE is scoped'),
    output.indexOf('repair_sql() {')
  );
  const directory = scratch();
  try {
    unlinkSync(join(directory, name));
    writeFileSync(join(directory, 'leaderboard-capture-basis-candidate.sql'), 'BEGIN;\nCOMMIT;\n');
    writeFileSync(
      join(directory, 'leaderboard-isolated-authorization-draft.sql'),
      'BEGIN;\nROLLBACK;\n'
    );
    writeFileSync(
      join(directory, 'leaderboard-isolated-historical-replay-candidate.sql'),
      'ROLLBACK;\n'
    );
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail\numask 077\nfailure(){ exit 42; }\nnode(){ printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }\n${prepare}\nprintf admitted >"$scratch/admitted"`,
      ],
      {
        encoding: 'utf8',
        timeout: 3000,
        env: { ...process.env, here: directory, scratch: directory },
      }
    );
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(directory, 'admitted')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('historical missing private input or body extraction failure cannot admit original COMMIT', () => {
  const output = buildFinancialRepairCandidate(source, 'historical-replay');
  const prepare = output.slice(
    output.indexOf('# SET ROLE is scoped'),
    output.indexOf('repair_sql() {')
  );
  for (const missing of ['none', 'authorization', 'capture', 'history', 'body', 'payout-body']) {
    const directory = scratch();
    try {
      if (missing !== 'capture')
        writeFileSync(
          join(directory, 'leaderboard-capture-basis-candidate.sql'),
          'BEGIN;\nSELECT 2;\nCOMMIT;\n'
        );
      if (missing !== 'authorization')
        writeFileSync(
          join(directory, 'leaderboard-isolated-authorization-draft.sql'),
          'BEGIN;\nSELECT 1;\nROLLBACK;\n'
        );
      if (missing !== 'history')
        writeFileSync(
          join(directory, 'leaderboard-isolated-historical-replay-candidate.sql'),
          '\\if :historical_before\nCOMMIT;\n\\else\nROLLBACK;\n\\endif\n'
        );
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail\numask 077\nfailure(){ exit 42; }\nnode(){ if [[ "\${2-}" == --body-md5 ]]; then [[ "$MISSING" != body ]] || return 8; if [[ "$MISSING" == payout-body && "\${4-}" == fn_payout_leaderboard ]]; then return 8; fi; printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; else printf 'PREPARED_SQL'; fi; }\n${prepare}\nprintf admitted >"$scratch/admitted"\n`,
        ],
        {
          encoding: 'utf8',
          timeout: 3000,
          env: { ...process.env, here: directory, scratch: directory, MISSING: missing },
        }
      );
      assert.equal(existsSync(join(directory, 'admitted')), missing === 'none');
      if (missing === 'none') {
        assert.equal(result.status, 0, result.stderr);
        assert.match(
          readFileSync(join(directory, 'repair-historical-before.sql'), 'utf8'),
          /BEGIN;\nSELECT 1;\n\\set historical_before true/
        );
        assert.match(
          readFileSync(join(directory, 'repair-historical-after.sql'), 'utf8'),
          /\\set candidate_opening_body_md5 a{32}/
        );
        assert.match(
          readFileSync(join(directory, 'repair-historical-after.sql'), 'utf8'),
          /\\set candidate_payout_body_md5 a{32}/
        );
      } else assert.notEqual(result.status, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
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
test('worker complete private inputs precede every client and missing companion cannot admit COMMIT', () => {
  const output = buildFinancialRepairCandidate(source, 'worker');
  const prepare = output.slice(
    output.indexOf('# SET ROLE is scoped'),
    output.indexOf('repair_sql() {')
  );
  for (const missing of ['none', 'authorization', 'companion', 'fixture']) {
    const directory = scratch();
    try {
      writeFileSync(
        join(directory, 'leaderboard-capture-basis-candidate.sql'),
        'BEGIN;\nSELECT 2;\nCOMMIT;\n'
      );
      if (missing !== 'authorization')
        writeFileSync(
          join(directory, 'leaderboard-isolated-authorization-draft.sql'),
          'BEGIN;\nSELECT 1;\nROLLBACK;\n'
        );
      if (missing !== 'companion')
        writeFileSync(
          join(directory, 'leaderboard-isolated-concurrency-fixture-draft.sql'),
          'SELECT 3;\nCOMMIT;\n'
        );
      if (missing !== 'fixture')
        writeFileSync(
          join(directory, 'leaderboard-isolated-worker-regression-candidate.sql'),
          'BEGIN;\nSELECT 4;\nROLLBACK;\n'
        );
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail\numask 077\nfailure(){ exit 42; }\nnode(){ printf 'BEGIN;\\nCOMMIT;\\n'; }\n${prepare}\nprintf admitted >"$scratch/admitted"\n`,
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
          'BEGIN;\nSELECT 1;\nSELECT 3;\nCOMMIT;\n'
        );
        assert.equal(
          readFileSync(join(directory, 'repair-fixture.sql'), 'utf8'),
          'BEGIN;\nSELECT 4;\nROLLBACK;\n'
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
    output.indexOf("repair_sql 'consolidated'")
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
            here: directory,
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
  assert.match(workflow, /leaderboard-worker-candidate.test.mjs/);
  assert.match(
    workflow,
    /node --test scripts\/verification-harness\/leaderboard-consolidated-postimage-candidate.test.mjs/
  );
  assert.match(workflow, /v2-payout\|capture-compatibility\|opening\|worker/);
  assert.match(workflow, /node-version: '22'/);
  assert.match(workflow, /shellcheck "\$candidate"/);
  assert.match(workflow, /trap cleanup_candidate EXIT/);
  assert.doesNotMatch(
    workflow,
    /upload-artifact|continue-on-error|schedule:|pull_request:|push:|cat .*log/
  );
});
