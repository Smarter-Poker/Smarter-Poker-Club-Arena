import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = (p: string) => readFileSync(p, 'utf8');
const pins = JSON.parse(read('scripts/ci/fixtures/weekly-indexed-reads/replacement.json'));
const migration = read(
  'supabase/migrations/20261016184511_weekly_watermark_eligibility_uses_its_existing_ordered_index.sql'
);
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
describe('weekly close reads original cash maxima and accrued rake through existing indexes', () => {
  it.each(['scope', 'helper'])(
    'changes only the exact %s query and preserves every other owner byte',
    (owner) => {
      const before = read(`scripts/ci/fixtures/weekly-indexed-reads/${owner}-before.sql`);
      const kind = owner === 'scope' ? 'watermark' : 'cash';
      const old = pins[`old_${kind}`];
      const next = pins[`new_${kind}`];
      expect(md5(before)).toBe(pins[`${owner}_before`]);
      expect(before.split(old)).toHaveLength(2);
      expect(md5(before.replace(old, next))).toBe(pins[`${owner}_after`]);
      expect(before.replace(old, next).replace(next, old)).toBe(before);
      expect(migration).toContain(`$old_query$${old}$old_query$`);
      expect(migration).toContain(`$new_query$${next}$new_query$`);
      expect(migration).toContain(pins[`${owner}_after`]);
      const source40 = JSON.stringify(
        JSON.parse(read('scripts/ci/fixtures/inventory-proof-lifetime-sources.json'))
      );
      expect(source40).not.toContain(
        owner === 'scope' ? 'fn_process_weekly_accounting_scope(' : 'fn_accounting_week_clubs('
      );
    }
  );
  it('preserves the original tuple watermark and historical cash scope', () => {
    const original = pins.old_watermark.slice(pins.old_watermark.indexOf('AND (rr.club_id'));
    expect(pins.new_watermark).toContain(original);
    expect(pins.new_watermark).toContain('rr.is_tournament IS NOT TRUE');
    expect(pins.new_watermark).toContain(
      "SELECT watermark.high_water_mark FROM public.daemon_state watermark WHERE watermark.daemon='rakeback_settler'"
    );
    expect(pins.new_cash).toContain(
      's.coordinator_union_id=p_union_id AND s.earned_at>=p_from AND s.earned_at<p_to ORDER BY s.earned_at DESC LIMIT 1 OFFSET 0'
    );
    expect(pins.new_cash).not.toContain('union_clubs');
    for (const guard of [
      'operator_refused',
      'freeze_or_override_refused',
      'scheduler_owned',
      'history_replay',
      'cash_index_required',
      'watermark_key_required',
      'scope_preimage_authority_refused',
      'helper_preimage_authority_refused',
    ])
      expect(migration).toContain(`weekly_index_reads_${guard}`);
    expect(migration).not.toMatch(
      /CREATE INDEX|UPDATE\s+(?:public\.)?(?:chip_ledger|club_members|ca_settlements)|ALTER FUNCTION/i
    );
  });
  it('runs both actual PostgreSQL qualifications in the existing required accounting step', () => {
    const parent = read('scripts/ci/test_launch_reset_floor.py');
    for (const name of [
      'test-weekly-indexed-reads-postgres.py',
      'test-weekly-cash-cohort-postgres.py',
    ])
      expect(parent).toContain(`'${name}'`);
    const native = read('scripts/ci/test-weekly-indexed-reads-postgres.py');
    expect(native).toContain('actual_candidate_installation_rollback_replay_and_authority');
    expect(native).toContain('independent_python_expected_sets');
    expect(read('scripts/ci/test-weekly-cash-cohort-postgres.py')).toContain(
      'cash_boundary_parity_failed'
    );
  });
});
