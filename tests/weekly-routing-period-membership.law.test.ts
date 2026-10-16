import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (path: string) => readFileSync(path, 'utf8');
const base = 'scripts/ci/fixtures/weekly-routing-period-membership';
const pins = JSON.parse(read(`${base}/replacement.json`));
const migration = read(
  'supabase/migrations/20261016233224_weekly_routing_excludes_a_club_that_joined_after_its_week.sql'
);
const md5 = (value: string) => createHash('md5').update(value).digest('hex');

describe('a weekly routing scope preserves the period that earned it', () => {
  it('changes only the union club discovery branch of the complete resolver', () => {
    const before = read(`${base}/resolver-before.sql`);
    const after = read(`${base}/resolver-after.sql`);
    expect(md5(before)).toBe(pins.before_md5);
    expect(md5(after)).toBe(pins.after_md5);
    expect(before.split(pins.old)).toHaveLength(2);
    expect(after).toBe(before.replace(pins.old, pins.new));
    expect(after.replace(pins.new, pins.old)).toBe(before);
    expect(migration).toContain(`$old$${pins.old}$old$`);
    expect(migration).toContain(`$new$${pins.new}$new$`);
    expect(after).toContain('OR uc.joined_at IS NULL OR uc.joined_at<p_period_end');
    expect(after).toContain(
      '(isfinite(p_period_start) AND isfinite(p_period_end) AND p_period_end>p_period_start) IS NOT TRUE'
    );
    expect(after).toContain(' ELSE club_ids:=ARRAY[p_scope_id];END IF;');
  });

  it('keeps exact earning-view witnesses, own and NULL clubs, and one fee witness per unaccepted club', () => {
    expect(pins.new).toContain('accepted_cash AS MATERIALIZED');
    expect(pins.new).toContain('fee_candidates AS MATERIALIZED');
    expect(pins.new).toContain('c.club_id IS NOT DISTINCT FROM k.club_id');
    expect(pins.new).toContain("rs.source_type='cash_rake_accrual'");
    expect(pins.new).toContain("rs.source_type='tournament_fee_accrual'");
    expect(pins.new).toContain('rs.source_id=fee.id');
    expect(pins.new).toContain('rs.earned_at>=p_period_start AND rs.earned_at<p_period_end');
    expect(pins.new).toContain('rs.club_id IS NULL');
    expect(pins.new).not.toContain('club_id<>p_scope_id');
    expect(migration).toContain(pins.view_md5);
  });

  it('installs once under exact authority without changing any payment or sealed source', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    for (const guard of [
      'operator_refused',
      'freeze_or_override_refused',
      'scheduler_owned',
      'history_replay',
      'inventory_seal_required',
      'exact_payable_view_required',
      'preimage_authority_refused',
      'exact_replacement_refused',
      'postimage_refused',
      'installed_authority_refused',
      'inventory_seal_changed',
    ])
      expect(migration).toContain(`routing_period_${guard}`);
    expect(migration).toContain("proacl::text IS DISTINCT FROM '{postgres=X/postgres}'");
    expect(migration).toContain(
      "proowner<>'postgres'::regrole OR NOT prosecdef OR provolatile<>'v'"
    );
    expect(migration).toContain("proconfig IS DISTINCT FROM ARRAY['search_path=public']");
    expect(migration).not.toMatch(/CREATE\s+INDEX|ALTER\s+FUNCTION|\bGRANT\b|\bREVOKE\b/i);
    expect(migration).not.toMatch(
      /(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:public\.)?(?:chip_ledger|club_members|union_clubs|agent_commission_settlements|accounting_routed_settlement_runs)\b/i
    );
    const sealed = JSON.parse(read('scripts/ci/fixtures/inventory-proof-lifetime-sources.json'));
    expect(
      sealed.functions.map((entry: { signature: string }) => entry.signature.split('(')[0])
    ).not.toContain(pins.signature.split('(')[0]);
  });

  it('executes the complete resolver and guarded installer in the existing required accounting parent', () => {
    const invocation =
      "print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-routing-period-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))";
    expect(
      read('scripts/ci/test_launch_reset_floor.py')
        .split('\n')
        .filter((line) => line === invocation)
    ).toHaveLength(1);
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 -B scripts/ci/test_launch_reset_floor.py --candidate-migration'
    );
  });
});
