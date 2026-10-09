import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  buildFinancialCandidate,
  readFinancialDraft,
} from './leaderboard-financial-integration-candidate.mjs';

const source = readFileSync(
  new URL('./leaderboard-isolation-preflight.sh', import.meta.url),
  'utf8'
);
const modes = ['payout', 'funding', 'concurrency', 'unknown-ack'];
const cleanupStart = source.indexOf('cleanup_complete=false\n');
const cleanupEnd = source.indexOf('failure() {');
const sourceReadStart = source.indexOf('source_client() {');
const sourceReadEnd = source.indexOf('unset DATABASE_URL PGDATABASE PGOPTIONS\n');

test('every distinct financial candidate preserves real fresh export/restore and original cleanup', () => {
  for (const mode of modes) {
    const output = buildFinancialCandidate(source, mode);
    const parse = spawnSync('bash', ['-n'], { input: output, encoding: 'utf8' });
    assert.equal(parse.status, 0, parse.stderr);
    const lint = spawnSync('shellcheck', ['-s', 'bash', '-'], {
      input: output,
      encoding: 'utf8',
    });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    assert.ok(output.includes(source.slice(cleanupStart, cleanupEnd)));
    assert.ok(output.includes(source.slice(sourceReadStart, sourceReadEnd)));
    assert.equal(output.split('docker network create --internal').length, 2);
    assert.match(output, /unset DATABASE_URL PGDATABASE PGOPTIONS PGHOST PGUSER PGPASSWORD/);
    const cmp = output.indexOf("|| failure 'isolated catalog differs from current source'");
    const invoke = output.indexOf('# Selected mode runs only AFTER');
    const cleanup = output.indexOf("cleanup || failure 'explicit cleanup verification failed'");
    assert.ok(cmp < invoke && invoke < cleanup);
    const diagnostic = output.indexOf('{ if ! node "$here/leaderboard-financial-diagnostics.mjs"');
    assert.ok(invoke < diagnostic && diagnostic < cleanup);
    assert.match(output, /Financial Diagnostic Receipt Refused; Raw Evidence Remains Private/);
    assert.ok(output.indexOf('unset DATABASE_URL') < invoke);
    assert.match(
      output,
      /Other modes, production Auth\/binary\/config parity, full financial qualification and launch completion remain unqualified/
    );
    assert.doesNotMatch(output.slice(invoke), /source_client|DATABASE_URL=|PGDATABASE=|\|\| true/);
  }
});

test('rollback modes stream authorization and only selected companion through one guarded socket', () => {
  for (const mode of ['payout', 'funding']) {
    const output = buildFinancialCandidate(source, mode);
    assert.match(output, /sed '\$d' "\$here\/leaderboard-isolated-authorization-draft.sql"/);
    assert.match(
      output,
      new RegExp(
        `cat "\\$scratch/financial-${mode}-authorization.sql" "\\$here/leaderboard-isolated-${mode === 'payout' ? 'payout-regression' : 'funding-policy'}-draft.sql"`
      )
    );
    assert.match(
      output,
      /timeout 180 docker exec -i "\$container" psql -h \/tmp -XAtq -U "\$bootstrap" -d postgres -v ON_ERROR_STOP=1/
    );
    assert.doesNotMatch(
      output,
      /bash "\$here\/leaderboard-(?:isolated-concurrency|unknown-ack)-draft.sh"/
    );
    assert.doesNotMatch(output, /cat "\$here\/leaderboard-isolated-concurrency-fixture-draft.sql"/);
  }
});

test('concurrency creates its own fixture; unknown-ack commits fresh fixture without settling it first', () => {
  const concurrency = buildFinancialCandidate(source, 'concurrency');
  assert.match(
    concurrency,
    /bash "\$here\/leaderboard-isolated-concurrency-draft.sh" "\$container" "\$scratch"/
  );
  assert.doesNotMatch(concurrency, /sed '\$d'/);
  const unknown = buildFinancialCandidate(source, 'unknown-ack');
  assert.match(
    unknown,
    /cat "\$scratch\/financial-unknown-ack-authorization.sql" "\$here\/leaderboard-isolated-concurrency-fixture-draft.sql"/
  );
  assert.match(
    unknown,
    /bash "\$here\/leaderboard-unknown-ack-draft.sh" "\$container" "\$scratch"/
  );
  assert.doesNotMatch(unknown, /bash "\$here\/leaderboard-isolated-concurrency-draft.sh"/);
  assert.ok(
    unknown.indexOf('cat "$scratch/financial-unknown-ack-authorization.sql"') <
      unknown.indexOf('bash "$here/leaderboard-unknown-ack-draft.sh"')
  );
  assert.match(unknown, /leaderboard-unknown-ack-proxy-draft.mjs.*\|\| failure/);
});

test('complete private preparation precedes the sole client; failed reads never reach COMMIT', () => {
  const generated = buildFinancialCandidate(source, 'unknown-ack');
  const start = generated.indexOf(
    'sed \'$d\' "$here/leaderboard-isolated-authorization-draft.sql"'
  );
  const end = generated.indexOf('\nbash "$here/leaderboard-unknown-ack-draft.sh"', start);
  assert.ok(start >= 0 && end > start);
  const stream = generated.slice(start, end);
  assert.doesNotMatch(stream, /\}\s*\|\s*timeout/);
  const driver = readFinancialDraft('leaderboard-isolated-concurrency-draft.sh');
  const driverStart = driver.indexOf('sed \'$d\' "$auth" >');
  const driverEnd = driver.indexOf('\n# Refuse absent', driverStart);
  assert.ok(driverStart >= 0 && driverEnd > driverStart);
  const scratchParent =
    process.env.TMPDIR || (process.env.CI === 'true' ? process.env.RUNNER_TEMP : undefined);
  assert.ok(
    scratchParent &&
      (scratchParent.startsWith('/Volumes/SmarterWork/agent-work/') ||
        (process.env.CI === 'true' && scratchParent === process.env.RUNNER_TEMP)),
    'Explicit owned SSD TMPDIR or hosted runner scratch required'
  );
  const formerLivePipeline = `{ sed '$d' "$auth"; cat "$fixture"; } | sql`;
  for (const body of [stream, driver.slice(driverStart, driverEnd), formerLivePipeline]) {
    for (const missing of ['none', 'authorization', 'companion']) {
      const root = mkdtempSync(join(scratchParent, 'financial-private-input-'));
      try {
        const scratch = join(root, 'scratch');
        mkdirSync(scratch, { mode: 0o700 });
        const auth = join(root, 'leaderboard-isolated-authorization-draft.sql');
        const fixture = join(root, 'leaderboard-isolated-concurrency-fixture-draft.sql');
        if (missing !== 'authorization') writeFileSync(auth, 'BEGIN;\nSELECT 1;\nROLLBACK;\n');
        if (missing !== 'companion') writeFileSync(fixture, 'SELECT 2;\nCOMMIT;\n');
        const script = `set -euo pipefail\numask 077\nfailure(){ exit 42; }\ntimeout(){ shift; "$@"; }\ndocker(){ printf invoked >"$scratch/invoked"; cat >"$scratch/observed"; }\nsql(){ docker; }\n${body}\n`;
        const result = spawnSync('bash', ['-c', script], {
          encoding: 'utf8',
          timeout: 3000,
          env: {
            ...process.env,
            here: root,
            scratch,
            auth,
            fixture,
            container: 'synthetic',
            bootstrap: 'synthetic',
          },
        });
        if (missing === 'none') {
          assert.equal(result.status, 0, result.stderr);
          assert.equal(
            readFileSync(join(scratch, 'observed'), 'utf8'),
            'BEGIN;\nSELECT 1;\nSELECT 2;\nCOMMIT;\n'
          );
        } else if (body === formerLivePipeline) {
          // The former pipeline starts its live client even when input
          // preparation fails. Errexit may stop the producer before COMMIT;
          // this demonstrates client admission, not a committed SQL effect.
          assert.notEqual(result.status, 0);
          assert.equal(existsSync(join(scratch, 'invoked')), true);
        } else {
          assert.notEqual(result.status, 0);
          assert.equal(existsSync(join(scratch, 'invoked')), false);
          assert.equal(existsSync(join(scratch, 'observed')), false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test('unknown, combined modes, changed/duplicate anchors and transaction-boundary drift refuse', () => {
  for (const mode of [
    undefined,
    '',
    'all',
    'payout,funding',
    'constructor',
    'unknown-ack;echo injected',
  ]) {
    assert.throws(() => buildFinancialCandidate(source, mode));
  }
  for (const anchor of [
    '# One explicit preflight. Never invoked by a schedule and never calls a payout.',
    'unset DATABASE_URL PGDATABASE PGOPTIONS\n',
    "cleanup || failure 'explicit cleanup verification failed'",
    'cmp -s "$scratch/source-before.json" "$scratch/isolated.json" || failure \'isolated catalog differs from current source\'',
  ]) {
    assert.throws(() =>
      buildFinancialCandidate(source.replace(anchor, 'changed-anchor'), 'payout')
    );
    assert.throws(() => buildFinancialCandidate(source + '\n' + anchor, 'payout'));
  }
  for (const mode of modes) {
    assert.throws(() =>
      buildFinancialCandidate(source, mode, (name) =>
        readFinancialDraft(name).replace(/ROLLBACK;\n$|COMMIT;\n$/, 'COMMIT;\nCOMMIT;\n')
      )
    );
  }
});

test('reviewed draft bytes cannot drift silently and generator never runs a candidate', () => {
  for (const mode of modes) {
    assert.throws(() =>
      buildFinancialCandidate(source, mode, (name) => `${readFinancialDraft(name)}\n-- drift\n`)
    );
  }
  const generator = readFileSync(
    new URL('./leaderboard-financial-integration-candidate.mjs', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(generator, /spawnSync|execSync|writeFile|child_process/);
});

test('payout verdicts never store arbitrary exception messages; driver receipts are fixed stages', () => {
  const payout = readFinancialDraft('leaderboard-isolated-payout-regression-draft.sql');
  assert.match(payout, /passed boolean, sqlstate text, stage text/);
  assert.match(payout, /GET STACKED DIAGNOSTICS error_state=RETURNED_SQLSTATE/);
  assert.doesNotMatch(payout, /failure_message|left\(failure_message/);
  for (const name of [
    'leaderboard-isolated-concurrency-draft.sh',
    'leaderboard-unknown-ack-draft.sh',
  ]) {
    const driver = readFinancialDraft(name);
    assert.match(driver, /printf 'FINANCIAL_DRIVER\|f\|\|%s\\n' "\$diagnostic_stage"/);
    assert.match(driver, /diagnostic_stage='own_cleanup'/);
  }
});

test('financial fixture service writers retain an existing synthetic journal actor in every session', () => {
  for (const name of [
    'leaderboard-isolated-funding-policy-draft.sql',
    'leaderboard-capture-payout-fixture-candidate.mjs',
    'leaderboard-isolated-payout-regression-draft.sql',
    'leaderboard-isolated-historical-replay-candidate.sql',
    'leaderboard-isolated-worker-regression-candidate.sql',
    'leaderboard-isolated-concurrency-draft.sh',
    'leaderboard-unknown-ack-draft.sh',
  ]) {
    const input = readFinancialDraft(name);
    const writers = [
      ...input.matchAll(
        /(?:PERFORM|SELECT) set_config\('request.jwt.claims','([^']+)',true\);\n\s*(?:PERFORM|SELECT) set_config\('request.jwt.claim.sub','([^']*)',true\);\n\s*(?:PERFORM|SELECT) set_config\('request.jwt.claim.role','service_role',true\);/g
      ),
    ];
    assert.ok(writers.length > 0, `No service writer checked: ${name}`);
    for (const writer of writers) {
      assert.deepEqual(
        JSON.parse(writer[1]),
        {
          sub: '90000000-0000-4000-8000-000000000001',
          role: 'service_role',
        },
        name
      );
      assert.equal(writer[2], '90000000-0000-4000-8000-000000000001', name);
    }
    assert.doesNotMatch(
      input,
      /set_config\('request.jwt.claims','\{"role":"service_role"\}',true\)/,
      name
    );
  }
  assert.match(
    readFinancialDraft('leaderboard-isolated-funding-policy-draft.sql'),
    /set_config\('request.jwt.claims','\{"role":"anon"\}',true\);\n\s*PERFORM set_config\('request.jwt.claim.sub','',true\)/
  );
});

test('authorization is validated before companion doors regain deferred transaction checks', () => {
  const auth = readFileSync(
    new URL('./leaderboard-isolated-authorization-draft.sql', import.meta.url),
    'utf8'
  );
  assert.match(
    auth,
    /SET CONSTRAINTS ALL IMMEDIATE;[\s\S]*SET CONSTRAINTS ALL DEFERRED;\nROLLBACK;\n$/
  );
  assert.equal(auth.match(/^SET CONSTRAINTS ALL DEFERRED;$/gm)?.length, 1);
  for (const name of [
    'leaderboard-isolated-payout-regression-draft.sql',
    'leaderboard-isolated-funding-policy-draft.sql',
    'leaderboard-isolated-concurrency-fixture-draft.sql',
    'leaderboard-isolated-opening-policy-draft.sql',
  ]) {
    const companion = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.match(companion, /SET CONSTRAINTS ALL IMMEDIATE;\n(?:ROLLBACK|COMMIT);\n$/);
  }
});
