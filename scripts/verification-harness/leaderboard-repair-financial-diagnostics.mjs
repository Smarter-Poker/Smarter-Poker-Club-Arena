// Prospective V2 receipt diagnostics only; never emit private raw output.
import assert from 'node:assert/strict';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const repairCases = Object.freeze([
  'missing_close_refuses_without_movement',
  'stale_close_refuses_without_movement',
  'new_player_zero_baseline_pays',
  'complete_close_pays_once',
  'genuine_empty_close_is_distinct',
  'positive_awards_only_for_cent_tie',
  'affiliate_union_promo_pays_once',
  'canonical_monthly_pays_once',
  'insufficient_promo_bank_available_refuses',
  'recipient_failure_rolls_back_then_retries',
  'affiliate_union_underfunded_refuses',
  'settlement_sql_roles_refuse',
]);
const extendedStages = Object.freeze([
  'fixture',
  'actual_shortage',
  'sql_role_refusal',
  'actual_settlement',
  'independent_readback',
]);
const maximum = 65536;
export const openingCases = Object.freeze([
  'paid_opening_promo_seed_zero',
  'combined_promo_conservation',
  'display_only',
  'insufficient_bank_atomic',
  'overlay_atomic',
  'same_identity_retry',
  'nested_publish_rollback',
  'bbj_spins_unchanged',
]);
const openingStages = Object.freeze([
  'prepare',
  'actual_opening',
  'independent_readback',
  'retry',
  'deferred_constraints',
]);
export function repairFinancialDiagnostics(mode, input) {
  assert.ok(mode === 'v2-payout' || mode === 'opening');
  const selected = mode === 'opening' ? openingCases : repairCases;
  assert.equal(typeof input, 'string');
  assert.ok(Buffer.byteLength(input) <= maximum);
  const rows = new Map();
  for (const line of input.split('\n')) {
    if (!line.includes('|')) continue;
    const parts = line.split('|');
    assert.equal(parts.length, 4);
    const [name, passed, state, stage] = parts;
    assert.ok(selected.includes(name) && !rows.has(name));
    assert.ok(passed === 't' || passed === 'f');
    if (passed === 't') assert.ok(state === '' && stage === '');
    else {
      assert.ok(/^[0-9A-Z]{5}$/.test(state) && state !== '00000');
      assert.ok(
        (mode === 'opening'
          ? openingStages
          : repairCases.indexOf(name) < 6
            ? ['case_execution']
            : extendedStages
        ).includes(stage)
      );
    }
    rows.set(name, { passed, state, stage });
  }
  const baselineStopped =
    mode === 'v2-payout' &&
    rows.size === 6 &&
    repairCases.slice(0, 6).every((name) => rows.has(name)) &&
    [...rows.values()].some(({ passed }) => passed === 'f');
  assert.ok(rows.size === selected.length || baselineStopped);
  const output = (baselineStopped ? repairCases.slice(0, 6) : selected)
    .map((name) => {
      const { passed, state, stage } = rows.get(name);
      return `Financial Repair Diagnostic: mode=${mode} case=${name} pass=${passed} stage=${stage || 'none'} SQLSTATE=${state || 'unknown'}`;
    })
    .join('\n');
  return baselineStopped
    ? `${output}\nFinancial Repair Diagnostic: mode=v2-payout extended=not-executed result=not-qualified`
    : output;
}
export function boundedRepairRead(path) {
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
    console.log(repairFinancialDiagnostics(process.argv[2], boundedRepairRead(process.argv[3])));
  } catch {
    console.error(
      'Financial Repair Diagnostic: unknown; private evidence unreadable or outside reviewed contract'
    );
    process.exitCode = 1;
  }
}
