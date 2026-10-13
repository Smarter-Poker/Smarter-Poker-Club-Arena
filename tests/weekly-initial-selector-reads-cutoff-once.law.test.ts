import fs from 'node:fs';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';
const p = 'scripts/qualification/weekly-initial-selector/';
const read = (s: string) => fs.readFileSync(s, 'utf8');
const before = read(p + 'before-scope.sql');
const after = read(p + 'after-scope.sql');
const migration = read(
  'supabase/migrations/20261013163310_weekly_initial_selector_reads_launch_cutoff_once_per_cash_club.sql'
);
describe('Initial weekly cash selection preserves original work with one cutoff per club', () => {
  it('changes only the first cash selector; financial tail, second selector and fairness stay exact', () => {
    const oldStart = before.indexOf('        WITH standalone_work AS (');
    const oldEnd = before.indexOf('           UNION ALL SELECT q.standalone_club_id', oldStart);
    const newStart = after.indexOf('        WITH cash_clubs AS MATERIALIZED (');
    const newEnd = after.indexOf('           UNION ALL SELECT q.standalone_club_id', newStart);
    expect(after.slice(0, newStart)).toBe(before.slice(0, oldStart));
    expect(after.slice(newEnd)).toBe(before.slice(oldEnd));
    expect(after.slice(newStart, newEnd)).toContain(
      "SELECT c.club_id,public.fn_ca_launch_accounting_cutoff('club',c.club_id) AS cutoff FROM cash_clubs c"
    );
    expect(after.slice(newStart, newEnd)).toContain(
      'LEFT JOIN cash_cutoffs c ON c.club_id=s.club_id'
    );
    expect(after.slice(newStart, newEnd)).toContain("s.source_type='tournament_fee_accrual'");
    expect(after.slice(newStart, newEnd)).toContain(
      'ELSE s.earned_at IS NOT NULL AND isfinite(s.earned_at) AND s.earned_at>=c.cutoff END'
    );
    expect(after.slice(newStart, newEnd)).not.toContain('SELECT s.*');
    expect(migration).toContain(after.trimEnd() + ';');
  });
  it('uses the protected applier and refuses replay, stale source, maintenance or competing owners', () => {
    expect(splitConcurrentPreamble(migration).ok).toBe(true);
    for (const gate of [
      'operator_refused',
      'gate_authority_refused',
      'override_refused',
      'freeze_refused',
      'reader_owned',
      'settlement_lane_owned',
      'history_replay',
      'parent_history_refused',
      'source40_refused',
      'view_refused',
      'preimage_refused',
      'postimage_refused',
      'post_source40_refused',
    ])
      expect(migration).toContain('weekly_selector_' + gate);
    expect(migration).toContain("'f176429b58caf30468e0d1b681f8291f'");
    expect(migration).not.toMatch(
      /CREATE\s+OR\s+REPLACE\s+(?:VIEW|FUNCTION public.fn_ca_launch_accounting_)/
    );
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
  it('enforces real component outputs, independent cash boundaries and actual helper call counts in accounting CI', () => {
    const run = read(p + 'run-native.py');
    for (const required of [
      'assert b==a',
      'assert left==expected',
      "counts['cash-after']['fn_ca_launch_accounting_cutoff']==5",
      'EXPLAIN(ANALYZE TRUE',
      'exact-installer-rollback',
      'refuse-owned-',
      'replay-source-refused',
    ])
      expect(run).toContain(required);
    expect(read('.github/workflows/ci.yml')).toContain('python3 ' + p + 'run-native.py --output');
    expect(read('.github/workflows/ci.yml')).toContain(
      'path: ${{ runner.temp }}/weekly-initial-selector/'
    );
    const fixture = read(p + 'selector-fixture.sql');
    for (const boundary of [
      'cut-before',
      'cut-equal',
      'cut-after',
      'cut-equal-duplicate',
      'positive-infinity',
      'explicit-null',
    ])
      expect(fixture).toContain(boundary);
    expect(run).not.toMatch(/DATABASE_URL\]\s*|fn_ca_launch_reset_execute\(/);
  });
  it('binds every exact qualification input before starting its private database', () => {
    const binding = JSON.parse(read(p + 'source-binding.json'));
    for (const [name, pin] of Object.entries(binding.files) as [
      string,
      { bytes: number; sha256: string },
    ][]) {
      const data = fs.readFileSync(name);
      expect(data.length, name).toBe(pin.bytes);
      expect(crypto.createHash('sha256').update(data).digest('hex'), name).toBe(pin.sha256);
    }
    expect(read(p + 'run-native.py')).toContain('qualification source input differs:');
  });
});
