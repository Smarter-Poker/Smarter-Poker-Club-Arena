import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Owner, 2026-10-31: eed06fe5 is replaced at a drained hand boundary, never by
 * a full-heap legacy census that cannot fit its allowance, and that census is
 * refused before any notice. docs/changelog/2026-10-31-eed-cutover-at-a-drained-hand-boundary.md
 */
const ROOT = process.cwd();
const transaction = readFileSync(join(ROOT, 'server/scripts/engine-release-transaction.sh'), 'utf8');
const helper = readFileSync(join(ROOT, 'server/scripts/engine-release-inflight-hands.py'), 'utf8');
const migration = readFileSync(
  join(ROOT, 'supabase/migrations/20261031212432_release_drained_predecessor_witness.sql'),
  'utf8'
);

describe('eed06fe5 is replaced at a drained hand boundary', () => {
  it('executes the real queue, census-fit, strict-certificate and witness cases', () => {
    const result = spawnSync('python3', [join(ROOT, 'tests/operations/eed-drained-cutover.test.py')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Ran 21 tests');
  }, 70_000);

  it('keeps the measured census rule beside its measurement', () => {
    expect(transaction).toContain('LEGACY_CENSUS_MS_PER_HEAP_MB=12\n');
    expect(transaction).toContain('LEGACY_CENSUS_ALLOWANCE_MS=30300\n');
    expect(transaction).toContain('run 41233374402');
  });

  it('decides the census before the wait loop, where no notice can yet exist', () => {
    const gate = transaction.indexOf('if ! legacy_census_fits; then\n    switch_to_drained_predecessor_cutover');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(transaction.indexOf('while :; do', gate));
    expect(transaction).toContain('refusing before any notice so no break is spent');
  });

  it('never opens the census intent without a fresh fit, and never coerces an unreadable heap', () => {
    const intent = transaction.indexOf('    record_floor_runtime_entry\n    LEGACY_CHECKPOINT_ATTEMPTED=1');
    const recheck = transaction.lastIndexOf(
      'if [ "$CHECKPOINT_PREDECESSOR_SHA" = "$CHECKPOINT_EED_SHA" ] && ! legacy_census_fits; then',
      intent
    );
    expect(recheck).toBeGreaterThan(0);
    expect(transaction.slice(recheck, intent)).toContain('switch_to_drained_predecessor_cutover');
    const fit = transaction.slice(transaction.indexOf('legacy_census_fits() {'));
    expect(fit.slice(0, fit.indexOf('\n}\n'))).toContain('raise SystemExit(3)');
  });

  it('admits only the strict certificate and reads the witness before the locked certificate', () => {
    expect(transaction).toContain('STRICT_RESTART_CERTIFICATE="${DRAINED_PREDECESSOR_CUTOVER:-0}"');
    expect(transaction).toContain('if os.environ.get("STRICT_RESTART_CERTIFICATE")=="1": raise SystemExit(1)');
    const witness = transaction.indexOf('        if ! drained_predecessor_witness; then');
    const locked = transaction.indexOf('BREAK_REMAINING_MS="$(maintenance_certificate "$BREAK_LOCKED_MIN_BREAK_MS")"');
    expect(witness).toBeGreaterThan(0);
    expect(witness).toBeLessThan(locked);
  });

  it('judges movement, never existence, and reads both halves before judging', () => {
    expect(helper).toContain('"moving_tournament_hands"');
    expect(helper).toContain('if moving or lightning or rows:');
    expect(migration).toContain("'contract', 'drained-predecessor-witness-v1'");
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.fn_ca_release_drained_predecessor_witness\(integer, integer\) FROM PUBLIC, anon, authenticated;/);
    expect(migration).toContain('TO service_role;');
    expect(migration).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});
