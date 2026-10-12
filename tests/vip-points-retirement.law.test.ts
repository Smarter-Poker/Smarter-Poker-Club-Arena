import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20261012063724_retire_unauthorized_vip_points.sql',
  'utf8'
);
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

describe('VIP rewards have no points currency', () => {
  it('retires the live award/redemption boundaries without deleting historical money records', () => {
    expect(migration).toContain("'vip_points_retired'");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.fn_award_vip_credit');
    expect(migration).toContain('RETURN 0;');
    expect(migration).toContain('zz_retired_vip_points_ledger BEFORE INSERT');
    expect(migration).toContain('zz_retired_vip_points_carry BEFORE INSERT OR UPDATE');
    expect(migration).toContain('zz_retired_vip_reward_claims BEFORE INSERT');
    expect(migration).not.toMatch(/DROP\s+TABLE|DELETE\s+FROM|TRUNCATE/i);
    expect(migration).not.toMatch(
      /UPDATE\s+public\.(?:profiles|diamond_transactions|wallets|leaderboard\w*)/i
    );
    expect(migration).toContain('VIP retirement owner/ACL predecessor drift');
  });

  it('runs its actual PostgreSQL scenario in a required accounting shard', () => {
    expect(ci).toMatch(/name: Retired VIP points[^\n]*\n\s+if: matrix.shard == 2/);
    expect(ci).toContain('run: bash scripts/dev/test-retired-vip-points-postgres.sh');
  });
});
