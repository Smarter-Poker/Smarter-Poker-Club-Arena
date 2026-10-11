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
      /Data console native PostgreSQL contracts[\s\S]*?if: matrix\.shard == 2[\s\S]*?PG17_BINDIR: \/usr\/lib\/postgresql\/17\/bin[\s\S]*?run: npm run test:data:postgres/
    );
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    expect(scripts['test:data:postgres']).toBe(
      'bash scripts/ci/test-data-console-postgres-contracts.sh'
    );
    const entry = readFileSync('scripts/ci/test-data-console-postgres-contracts.sh', 'utf8');
    expect(entry).toContain('set -euo pipefail');
    expect(entry).toContain('PG_BIN="${PG_BIN:-${PG17_BINDIR:-/usr/lib/postgresql/17/bin}}"');
    expect(entry).toContain(
      'python3 -B "$repo/scripts/ci/test-club-operations-overview-postgres.py"'
    );
    expect(entry.split('test-club-operations-overview-postgres.py')).toHaveLength(2);
    const harness = readFileSync('scripts/ci/test-club-operations-overview-postgres.py', 'utf8');
    expect(harness).toContain("listen_addresses=''");
    expect(harness).toContain("'--auth-host=reject'");
    expect(harness).toContain('MIGRATION.read_text()');
    expect(harness).toContain('metadata() == original_metadata');
  });
  it('pins both the observed complete definition and body, and requires the exact postimage', () => {
    expect(sql).toContain('ff2f0b8132efc1c1091594d230c990d6');
    expect(sql).toContain('56fce10a30115b2d8b84891229af5de7');
    expect(sql).toContain('f37429f441b5a31bceb13700d6b8d015');
    expect(sql.match(/BEGIN;/g)).toHaveLength(1);
    expect(sql).toContain("BEGIN;\nSET LOCAL lock_timeout = '3s';");
    expect(sql.match(/COMMIT;/g)).toHaveLength(1);
    expect(sql.match(/must occur exactly once/g)).toHaveLength(12);
    expect(replacements).toHaveLength(12);
  });
  it('new-member counts exclude membership requests without changing wallet sums', () => {
    expect(replacements[0][2]).toContain(
      "coalesce(cm.status, 'approved') IN ('active', 'approved')"
    );
    expect(replacements[0][2]).toContain("pr.status = 'deleted'");
    expect(replacements[0][2]).toContain('count(DISTINCT cm.user_id)');
    expect(replacements[0][2]).toContain("cm.created_at > now() - interval '7 days'");
    const financial = /coalesce\(sum\(cm\.chip_balance\)[\s\S]*?, 0\)/;
    expect(replacements[0][2].match(financial)?.[0]).toBe(replacements[0][1].match(financial)?.[0]);
    expect(
      replacements
        .slice(1)
        .every(
          (pair) => !/sum\(|chip_balance|chip_treasury|settlement_locked/.test(pair[1] + pair[2])
        )
    ).toBe(true);
  });
  it('presence counts require a live seat or an accepted membership with canonical profile presence', () => {
    expect(replacements[1][2]).toContain("t.status IN ('running', 'waiting')");
    expect(replacements[1][2]).toContain('ts.left_at IS NULL');
    expect(replacements[1][2]).toContain('ts.user_id IS NOT NULL');
    expect(replacements[1][2]).toContain('t.club_id = p_club_id OR ts.club_id = p_club_id');
    expect(replacements[1][2]).toContain('count(DISTINCT ts.user_id)');
    expect(replacements[2][2]).toContain('UNION');
    expect(replacements[2][2]).toContain(
      "coalesce(cm.status, 'approved') IN ('active', 'approved')"
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
  it('bomb reporting changes only club scoping in both live reads and catchup rollup', () => {
    expect(sql).toContain('a37016388c8957533a8a7f1e0b610065');
    expect(sql).toContain('78e78fee19b842a9b54ed9703784551e');
    expect(sql).toContain('db2daf3cd7367513cf219d75ea1377ba');
    expect(sql).toContain('f8b2e4eda1ee5c7d75243f1448566ea2');
    for (const pair of replacements.slice(6, 8)) {
      expect(pair[1]).toMatch(
        /^JOIN public\.tables t ON t\.id = h\.table_id\n +WHERE t\.club_id = p_club_id$/
      );
      expect(pair[2]).toBe(
        'WHERE h.table_id = ANY(ARRAY(SELECT t.id FROM public.tables t WHERE t.club_id = p_club_id))'
      );
    }
  });
  it('the full dashboard shares only the roster personnel definitions', () => {
    expect(sql).toContain('f82002cb3b36a4454a9f6e17af141985');
    expect(sql).toContain('e9df60b641c83580253c29cac60f53bd');
    expect(sql).toContain('0d64c2d9d5f63a68418ce21c4442b8f0');
    expect(replacements.slice(8)).toHaveLength(4);
    for (const pair of replacements.slice(8)) {
      expect(pair[2]).toContain("coalesce(cm.status, 'approved') IN ('active', 'approved')");
      expect(pair[2]).toContain("pr.status = 'deleted'");
      expect(pair[1] + pair[2]).not.toMatch(
        /rake_today|rake_week|daily_series|tournament_fees|active_tables|total_tables/
      );
    }
    expect(replacements[8][2]).toContain('count(DISTINCT cm.user_id)');
    expect(replacements[9][2]).toContain('t.club_id = p_club_id OR ts.club_id = p_club_id');
    expect(replacements[10][2]).toContain("cm.created_at > now() - interval '7 days'");
    expect(replacements[11][2]).toContain('count(DISTINCT ts.user_id)');
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
