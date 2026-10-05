// A production e2e spec never writes a hand or ledger table.
//
// Every spec under tests/e2e runs against the deployed production database
// (post-deploy-e2e.yml). tests/e2e/production-daily-missions.spec.ts used to
// certify the settled-hand Daily Missions trigger by inserting a synthetic
// hand_history row (table_id NULL, winners [], pot 600, hand_number
// 1.7e9-1.8e9) through the service role and deleting it in a finally block.
// Every run put a winnerless 600-chip hand into the live hand ledger; every
// run that was cancelled or timed out before its finally left one there. Four
// survived (2026-09-11, 09-19, 09-23, 09-24) and tripped the cash-pot
// conservation no_winner_recorded monitor twelve times (board #5070, incident
// e2e-synthetic-hands). The trigger is now certified on a private native
// PostgreSQL by scripts/ci/test-daily-missions-hand-trigger-postgres.py, and
// this guard keeps any production spec from writing one of these tables again.
//
// Two layers. At run time, serviceRequest in
// tests/e2e/support/temporaryCustomizationAccount.ts, the only service-role
// request path, refuses every hand or ledger write and every hand, rake,
// settlement, payout, jackpot or seat RPC before it leaves the runner
// (tests/e2e/support/productionLedgerWritePolicy.mjs). On every pull request
// this scan reads the specs with the same lists. It fails closed: a helper
// write or service RPC whose target it cannot read as a string literal is
// refused too, because "could not tell" is not "clean"; and any literal REST
// path to a ledger table is refused, which covers a hand-built fetch().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HAND_LEDGER_RPC,
  LEDGER_TABLES,
  assertProductionLedgerWriteAllowed,
} from '../e2e/support/productionLedgerWritePolicy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = '.github/workflows/production-e2e-synthetic-hand-guard.yml';
const E2E = join(ROOT, 'tests', 'e2e');

// The ledger tables, the hand/ledger RPC rule  live in
// the runtime policy module that the service-role request layer enforces, so
// the static scan and the run-time refusal can never disagree.
export { LEDGER_TABLES, HAND_LEDGER_RPC };

const WRITE_HELPER =
  /(?<!function\s)\b(insert|update|upsert|delete)ServiceRows\s*(?:<[\s\S]*?>)?\s*\(\s*[\w$.!]+\s*,\s*([^,)]+)/g;
const RAW_SERVICE_WRITE =
  /\bserviceRequest\s*(?:<[\s\S]*?>)?\s*\(\s*[\w$.!]+\s*,\s*['"`]\/rest\/v1\/([a-z_]+)[^'"`]*['"`]\s*,\s*\{[^}]*?method\s*:\s*['"`](POST|PATCH|PUT|DELETE)['"`]/g;
const CLIENT_WRITE =
  /\.from\(\s*['"`]([a-z_]+)['"`]\s*\)\s*\.\s*(insert|upsert|update|delete)\s*\(/g;
const SERVICE_RPC =
  /(?<!function\s)\bcallServiceRpc\s*(?:<[\s\S]*?>)?\s*\(\s*[\w$.!]+\s*,\s*([^,)]+)/g;
const CLIENT_RPC = /\.rpc\(\s*(?:<[\s\S]*?>)?\s*['"`]([a-z0-9_]+)['"`]/g;
const LEDGER_REST_PATH = /\/rest\/v1\/([a-z_]+)(?![a-z_\/])/g;

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** Every write a source file makes to a ledger table, or cannot be read. */
export function ledgerWrites(source) {
  const writes = [];
  for (const match of source.matchAll(WRITE_HELPER)) {
    const argument = match[2].trim();
    const literal = /^['"`]([a-z_]+)['"`]$/.exec(argument);
    if (!literal) {
      writes.push({
        kind: `${match[1]}ServiceRows`,
        table: `<unreadable: ${argument}>`,
        line: lineOf(source, match.index),
      });
    } else if (LEDGER_TABLES.has(literal[1])) {
      writes.push({
        kind: `${match[1]}ServiceRows`,
        table: literal[1],
        line: lineOf(source, match.index),
      });
    }
  }
  for (const match of source.matchAll(RAW_SERVICE_WRITE)) {
    if (LEDGER_TABLES.has(match[1])) {
      writes.push({
        kind: `serviceRequest ${match[2]}`,
        table: match[1],
        line: lineOf(source, match.index),
      });
    }
  }
  for (const match of source.matchAll(CLIENT_WRITE)) {
    if (LEDGER_TABLES.has(match[1])) {
      writes.push({
        kind: `.from().${match[2]}`,
        table: match[1],
        line: lineOf(source, match.index),
      });
    }
  }
  for (const match of source.matchAll(SERVICE_RPC)) {
    const argument = match[1].trim();
    const literal = /^['"`]([a-z0-9_]+)['"`]$/.exec(argument);
    if (!literal) {
      writes.push({
        kind: 'callServiceRpc',
        table: `<unreadable: ${argument}>`,
        line: lineOf(source, match.index),
      });
    } else if (HAND_LEDGER_RPC.test(literal[1])) {
      writes.push({ kind: 'callServiceRpc', table: literal[1], line: lineOf(source, match.index) });
    }
  }
  for (const match of source.matchAll(CLIENT_RPC)) {
    if (HAND_LEDGER_RPC.test(match[1])) {
      writes.push({ kind: '.rpc', table: match[1], line: lineOf(source, match.index) });
    }
  }
  for (const match of source.matchAll(LEDGER_REST_PATH)) {
    // Playwright route registration installs a browser interception; it does
    // not send a request. Exempt only the literal selector, never its callback.
    const prefix = source.slice(0, match.index);
    if (/\bcontext\.route\(\s*['"]\*\*$/.test(prefix)) continue;
    if (LEDGER_TABLES.has(match[1])) {
      writes.push({ kind: 'REST path', table: match[1], line: lineOf(source, match.index) });
    }
  }
  return writes;
}

function sourceFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(c|m)?(t|j)sx?$/.test(name)) files.push(path);
  }
  return files;
}

test('the scanner sees every write shape, including one it cannot read', () => {
  const found = ledgerWrites(`
    await insertServiceRows<{ id: string }>(environment, 'hand_history', { id });
    await updateServiceRows(env, "chip_ledger", query, values);
    await deleteServiceRows(environment, TABLE, query);
    await serviceRequest<void>(environment, '/rest/v1/rake_records?id=eq.1', { method: 'DELETE' });
    await client.from('wallets').update({ balance: 1 });
    await insertServiceRows(environment, 'daily_challenge_reroll_receipts', row);
    await readServiceRows(environment, 'hand_history', query);
    export async function insertServiceRows<T>(environment: Env, table: string, rows: Rows) {}
    await callServiceRpc(environment, 'fn_ca_commit_hand_submission', body);
    await callServiceRpc<Result>(environment, rpcName, body);
    await callServiceRpc(environment, 'fn_ca_mint', body);
    await account.client.rpc('settle_hand_atomically', body);
    await account.client.rpc('claim_daily_challenges', body);
    await fetch(\`\${url}/rest/v1/table_seats?id=eq.\${id}\`, { method: 'PATCH', body });
    await fetch(\`\${url}/rest/v1/rpc/get_daily_challenge_dashboard_v3\`);
  `);
  assert.deepEqual(
    found.map(({ kind, table }) => `${kind}:${table}`),
    [
      'insertServiceRows:hand_history',
      'updateServiceRows:chip_ledger',
      'deleteServiceRows:<unreadable: TABLE>',
      'serviceRequest DELETE:rake_records',
      '.from().update:wallets',
      'callServiceRpc:fn_ca_commit_hand_submission',
      'callServiceRpc:<unreadable: rpcName>',
      '.rpc:settle_hand_atomically',
      'REST path:rake_records',
      'REST path:table_seats',
    ]
  );
});

test('the service-role request layer refuses a hand or ledger write at run time', () => {
  const refused = (request) =>
    assert.throws(() => assertProductionLedgerWriteAllowed(request), /^Error: Refused:/);
  const allowed = (request) =>
    assert.doesNotThrow(() => assertProductionLedgerWriteAllowed(request));

  // The exact write this incident was: a synthetic hand posted to production.
  refused({
    method: 'POST',
    path: '/rest/v1/hand_history',
    body: JSON.stringify({ pot_size: 600, winners: [] }),
  });
  refused({ method: 'delete', path: '/rest/v1/hand_history?id=eq.1' });
  refused({ method: 'PATCH', path: '/rest/v1/table_seats?id=eq.1', body: '{}' });
  refused({ method: 'PUT', path: '/rest/v1/chip_ledger', body: '{}' });
  refused({ method: 'POST', path: '/rest/v1/rpc/fn_ca_commit_hand_submission', body: '{}' });
  refused({ method: 'POST', path: '/rest/v1/rpc/settle_hand_atomically', body: '{}' });
  refused({ method: 'POST', path: '/rest/v1/rpc/record_hand_rake_attribution', body: '{}' });

  // Even a historical fixture prefix cannot authorize a synthetic journal entry.
  for (const reference of [
    'daily-missions-historical-multiplier:run-1',
    'daily_mission_milestones:user:run:777',
  ]) {
    refused({
      method: 'POST',
      path: '/rest/v1/diamond_transactions',
      body: JSON.stringify({ reference_id: reference, amount: 15 }),
    });
  }

  // Reads, fixture diamonds, mission state and cleanup still pass.
  allowed({ method: 'GET', path: '/rest/v1/hand_history?select=id' });
  allowed({ path: '/rest/v1/table_seats?select=id' });
  allowed({ method: 'POST', path: '/rest/v1/daily_challenge_milestone_claims', body: '{}' });
  // The settled-hand certification queues the exact outbox row the trigger
  // writes and lets the live drainer book it: a mission table, never a ledger.
  allowed({
    method: 'POST',
    path: '/rest/v1/daily_challenge_event_outbox',
    body: JSON.stringify({
      event_key: 'certification:outbox:1',
      threshold_values: { big_pots: [499, 500] },
    }),
  });
  allowed({ method: 'PATCH', path: '/rest/v1/profiles?id=eq.1', body: '{}' });
  for (const rpc of [
    'fn_ca_mint',
    'fn_ca_burn',
    'add_diamonds_to_balance',
    'deduct_diamonds',
    'enqueue_daily_challenge_event',
    'cleanup_reserved_certification_account',
  ]) {
    allowed({ method: 'POST', path: `/rest/v1/rpc/${rpc}`, body: '{}' });
  }
  allowed({ method: 'POST', path: '/auth/v1/admin/users', body: '{}' });
});

test('every service-role request passes the refusal before it is sent', () => {
  const helper = readFileSync(join(E2E, 'support', 'temporaryCustomizationAccount.ts'), 'utf8');
  assert.match(
    helper,
    /import \{ assertProductionLedgerWriteAllowed \} from '\.\/productionLedgerWritePolicy\.mjs';/
  );
  const request = helper.slice(helper.indexOf('async function serviceRequest<T>('));
  const guard = request.indexOf(
    'assertProductionLedgerWriteAllowed({ method, path, body: init.body });'
  );
  assert.ok(guard > 0, 'serviceRequest must call assertProductionLedgerWriteAllowed');
  assert.ok(guard < request.indexOf('await fetch('), 'the refusal must run before the first fetch');
  // The only other service-role fetch in the helper is the auth existence
  // read; it carries no method and no body, so it cannot write.
  const others = [...helper.matchAll(/\bawait fetch\(([\s\S]*?)\);/g)].filter(
    (match) => !match[1].startsWith('`${environment.supabaseUrl}${path}`')
  );
  assert.equal(others.length, 1);
  assert.match(others[0][1], /\/auth\/v1\/admin\/users\//);
  assert.doesNotMatch(others[0][1], /method|body/);
});

test('no production e2e spec writes a hand or ledger table', () => {
  const offenders = [];
  for (const path of sourceFiles(E2E)) {
    const file = relative(ROOT, path).split('\\').join('/');
    for (const write of ledgerWrites(readFileSync(path, 'utf8'))) {
      offenders.push(`${file}:${write.line} ${write.kind} -> ${write.table}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'A production e2e spec wrote a hand or ledger table. Certify the database behavior on a native ' +
      'PostgreSQL fixture (scripts/ci/test-*-postgres.py) and keep the production spec read-only.'
  );
});

test('the settled-hand trigger is certified natively, not by a production hand', () => {
  const spec = readFileSync(join(E2E, 'production-daily-missions.spec.ts'), 'utf8');
  assert.doesNotMatch(spec, /['"`]hand_history['"`]/);
  const native = readFileSync(
    join(ROOT, 'scripts/ci/test-daily-missions-hand-trigger-postgres.py'),
    'utf8'
  );
  assert.match(native, /fn_enqueue_hand_daily_missions/);
  assert.match(native, /trg_enqueue_hand_daily_missions/);
  const workflow = readFileSync(join(ROOT, WORKFLOW), 'utf8');
  assert.match(workflow, /run: python3 scripts\/ci\/test-daily-missions-hand-trigger-postgres\.py/);
  assert.match(
    workflow,
    /run: node --test tests\/operations\/production-e2e-ledger-write-guard\.test\.mjs/
  );
  assert.match(workflow, /PG_BIN: \/usr\/lib\/postgresql\/17\/bin/);
  assert.doesNotMatch(workflow, /continue-on-error/);
});

test('a change to either proof, a production spec or a migration runs the workflow that proves it', () => {
  const workflow = readFileSync(join(ROOT, WORKFLOW), 'utf8');
  const on = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
  assert.match(on, /\n  pull_request:\n/);
  const paths = [...on.matchAll(/^      - (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(paths, [
    'tests/e2e/**',
    'tests/operations/production-e2e-ledger-write-guard.test.mjs',
    'scripts/ci/test-daily-missions-hand-trigger-postgres.py',
    'supabase/migrations/**',
    WORKFLOW,
  ]);
});


test('browser interception selectors are not writes, but callback writes still fail', () => {
  assert.deepEqual(ledgerWrites("await context.route('**/rest/v1/table_seats*', async route => route.fulfill({body: '[]'}));"), []);
  const found = ledgerWrites("await context.route('**/rest/v1/table_seats*', async route => { await fetch('/rest/v1/table_seats', {method: 'PATCH'}); });");
  assert.deepEqual(found.map(({kind, table}) => `${kind}:${table}`), ['REST path:table_seats']);
});
