import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261011190124_operations_counts_follow_membership_and_live_tables.sql',
  'utf8'
);
const replacements = [
  ...sql.matchAll(/v_old := \$old\$([\s\S]*?)\$old\$;\s*v_new := \$new\$([\s\S]*?)\$new\$;/g),
];

describe('Club Operations Qualified Count Repair', () => {
  it('runs native PostgreSQL qualification in the existing required accounting job', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toMatch(
      /Club operations overview counts and authority match their live sources[\s\S]*?if: matrix\.shard == 1[\s\S]*?run: python3 -B scripts\/ci\/test-club-operations-overview-postgres\.py/
    );
    const harness = readFileSync('scripts/ci/test-club-operations-overview-postgres.py', 'utf8');
    expect(harness).toContain("listen_addresses=''");
    expect(harness).toContain("'--auth-host=reject'");
    expect(harness).toContain('MIGRATION.read_text()');
    expect(harness).toContain('metadata() == original_metadata');
  });
  it('pins both the observed complete definition and body, and requires the exact postimage', () => {
    expect(sql).toContain('ff2f0b8132efc1c1091594d230c990d6');
    expect(sql).toContain('56fce10a30115b2d8b84891229af5de7');
    expect(sql).toContain('0cc301a559126c36a249454976733a4c');
    expect(sql.match(/BEGIN;/g)).toHaveLength(1);
    expect(sql).toContain("BEGIN;\nSET LOCAL lock_timeout = '3s';");
    expect(sql.match(/COMMIT;/g)).toHaveLength(1);
    expect(sql.match(/must occur exactly once/g)).toHaveLength(6);
    expect(replacements).toHaveLength(6);
  });
  it('new-member counts exclude membership requests without changing wallet sums', () => {
    expect(replacements[0][2]).toContain("NOT IN ('banned', 'suspended', 'pending')");
    expect(replacements[0][2]).toContain("cm.created_at > now() - interval '7 days'");
    expect(
      replacements.every(
        (pair) => !/sum\(|chip_balance|chip_treasury|settlement_locked/.test(pair[1] + pair[2])
      )
    ).toBe(true);
  });
  it('presence counts require a live seat or an accepted membership with canonical profile presence', () => {
    expect(replacements[1][2]).toContain("t.status IN ('running', 'waiting', 'active')");
    expect(replacements[1][2]).toContain('ts.left_at IS NULL AND ts.user_id IS NOT NULL');
    expect(replacements[1][2]).toContain('UNION');
    expect(replacements[2][2]).toContain(
      "coalesce(cm.status, 'active') IN ('active', 'approved', 'automatic')"
    );
    expect(replacements[2][2]).toContain('EXISTS (SELECT 1 FROM public.profiles pp');
    expect(
      replacements.every((pair) => !/is_horse|horse_profile|profiles\.role/.test(pair[1] + pair[2]))
    ).toBe(true);
  });
  it('cash rake reads its authoritative rollup independently of missing hand counts', () => {
    expect(replacements[3][1]).toContain('FROM club_hand_daily d');
    expect(replacements[3][2]).toContain('SELECT d.hands FROM club_hand_daily d');
    expect(replacements[3][2]).toContain('SELECT d.rake FROM ca_club_rake_daily d');
    expect(
      replacements[3][2].match(/stat_date = \(now\(\) AT TIME ZONE 'UTC'\)::date/g)
    ).toHaveLength(2);
    expect(replacements[3][2]).not.toContain('IF NOT FOUND');
  });
  it('integrity flags include club members with inherited platform flags once', () => {
    expect(replacements[4][2]).toContain("coalesce(f.status, 'open') = 'open'");
    expect(replacements[4][2]).toContain('f.club_id IS NULL AND EXISTS');
    expect(replacements[4][2]).toContain('cm.club_id = p_club_id AND cm.user_id = f.player_id');
    expect(replacements[4][2]).not.toContain('JOIN club_members');
  });
  it('activity hand reads change only the club-scoping plan under exact source guards', () => {
    expect(sql).toContain('6e4702f9aa88dabc1e472a399df319f1');
    expect(sql).toContain('50002a220d610b93ed9b368e619e321c');
    expect(sql).toContain('c9d199dd6f2a4be40aa3846acabb5c98');
    expect(replacements[5][1]).toBe(
      'JOIN tables t ON t.id = hh.table_id\n     WHERE t.club_id = p_club_id'
    );
    expect(replacements[5][2]).toBe(
      'WHERE hh.table_id = ANY(ARRAY(SELECT t.id FROM tables t WHERE t.club_id = p_club_id))'
    );
  });
  it('reuses the maintained function definition, preserving owner, grants, security and financial authorization', () => {
    expect(sql).toContain('EXECUTE v_definition;');
    expect(sql).toContain('EXECUTE replace(v_definition,v_old,v_new);');
    expect(sql).not.toMatch(/\b(?:GRANT|REVOKE|DROP FUNCTION|ALTER OWNER)\b/);
    expect(
      replacements.every(
        (pair) => !/v_finance|v_staff|v_control|auth\.|fn_club_bank_role/.test(pair[1] + pair[2])
      )
    ).toBe(true);
  });
});
