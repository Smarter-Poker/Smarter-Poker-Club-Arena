// Safe diagnostic receipt only. Never prints raw private financial output.
import assert from 'node:assert/strict';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const cases = Object.freeze({
  payout: [
    'missing_close_refuses_without_movement',
    'stale_close_refuses_without_movement',
    'new_player_zero_baseline_pays',
    'complete_close_pays_once',
    'genuine_empty_close_is_distinct',
    'positive_awards_only_for_cent_tie',
  ],
  funding: [
    'union_promo_only_pays_once',
    'union_underfunded_refuses',
    'standalone_bank_never_falls_back',
    'positive_seed_never_used_or_released',
    'overlay_save_refuses_without_effects',
    'settlement_sql_roles_refuse',
  ],
  concurrency: ['FINANCIAL_DRIVER'],
  'unknown-ack': ['FINANCIAL_DRIVER'],
});
const stages = Object.freeze({
  payout: ['case_execution'],
  funding: [
    'fixture_identity',
    'union_mint',
    'actual_opening_seed',
    'actual_promo_funding',
    'overlay_refusal',
    'chronology_preimage',
    'historical_program',
    'actual_shortage_transition',
    'sql_role_refusal',
    'settlement_preimage',
    'actual_settlement',
    'independent_money_readback',
    'settlement_replay',
    'deferred_constraints',
  ],
  concurrency: [
    'fixture',
    'funding_barrier',
    'concurrent_callers',
    'reconciliation',
    'replay',
    'worker_exclusion',
    'worker_settlement',
    'worker_reconciliation',
    'own_cleanup',
  ],
  'unknown-ack': [
    'precondition',
    'node_compatibility',
    'quarantine',
    'durable_readback',
    'connection_loss',
    'same_identity_retry',
    'own_cleanup',
  ],
});
const maximum = 65536;
export function financialDiagnostics(mode, input) {
  assert.ok(Object.hasOwn(cases, mode));
  assert.equal(typeof input, 'string');
  assert.ok(Buffer.byteLength(input) <= maximum);
  const rows = [];
  // psql sqlstate verbosity omits messages, values, SQL and context. A
  // pre-verdict error remains a failure; this receipt only locates its input.
  const errors = [
    ...input.matchAll(/^psql:<stdin>:(\d{1,6}): (?:ERROR|FATAL|PANIC):\s+([0-9A-Z]{5})\s*$/gm),
  ];
  for (const line of input.split('\n')) {
    if (!line.includes('|')) continue; // Raw errors/notices remain private.
    const parts = line.split('|');
    assert.equal(parts.length, 4);
    const [name, passed, state, stage] = parts;
    assert.ok(cases[mode].includes(name));
    assert.ok(passed === 't' || passed === 'f');
    assert.ok(!rows.some((row) => row.name === name));
    if (passed === 't') assert.ok(state === '' && stage === '');
    else {
      assert.ok(stages[mode].includes(stage));
      assert.ok(state === '' || (/^[0-9A-Z]{5}$/.test(state) && state !== '00000'));
      if (mode === 'payout' || mode === 'funding') assert.notEqual(state, '');
    }
    rows.push({ name, passed, state, stage });
  }
  if (rows.length === 0 && errors.length === 1) {
    const [, line, state] = errors[0];
    assert.ok(Number(line) > 0 && state !== '00000');
    return `Financial Diagnostic: mode=${mode} verdicts=unavailable input_line=${line} SQLSTATE=${state}`;
  }
  assert.equal(rows.length, cases[mode].length);
  return rows
    .map(
      ({ name, passed, state, stage }) =>
        `Financial Diagnostic: mode=${mode} case=${name} pass=${passed} stage=${stage || 'none'} SQLSTATE=${state || 'unknown'}`
    )
    .join('\n');
}
function boundedRead(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    assert.ok(info.isFile() && info.size <= maximum);
    const buffer = Buffer.alloc(maximum + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    assert.ok(size <= maximum);
    return buffer.subarray(0, size).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 4);
    console.log(financialDiagnostics(process.argv[2], boundedRead(process.argv[3])));
  } catch {
    console.error(
      'Financial Diagnostic: unknown; private evidence unreadable or outside reviewed contract'
    );
    process.exitCode = 1;
  }
}
