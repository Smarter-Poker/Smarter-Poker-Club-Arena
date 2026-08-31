import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    __dirname,
    '../../supabase/migrations/20260831002500_leaderboard_historical_period_contract.sql'
  ),
  'utf8'
);

describe('historical leaderboard period contract', () => {
  it('records every live historical ranking definition in forward-only migration history', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_by_dates');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.fn_global_leaderboard_by_dates');
    expect(migration).toContain('CREATE FUNCTION public.fn_user_rank_by_dates');
    expect(migration).toContain('CREATE FUNCTION public.fn_user_rank_global_by_dates');
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.fn_user_rank_by_dates');
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.fn_user_rank_global_by_dates');
  });

  it('keeps historical windows UTC, start-inclusive, end-exclusive and snapshot safe', () => {
    expect(migration).toContain("v_today date := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date");
    expect(migration).toContain('v_use_live := (v_end > v_today)');
    expect(migration).toContain('snapshot_date <= v_start');
    expect(migration).toContain('snapshot_date <= v_end');
    expect(migration).toContain('v_end_snap <= v_baseline');
  });

  it('preserves ties, active totals, pagination, movement and rate qualification', () => {
    expect(migration).toContain('rank() OVER (ORDER BY s.score DESC NULLS LAST) AS rk_now');
    expect(migration).toContain('count(*) OVER () AS total_active');
    expect(migration).toContain('r.rk_old - r.rk_now');
    expect(migration).toContain("p_metric NOT IN ('roi','bb100')");
    expect(migration).toContain('OFFSET GREATEST(COALESCE(p_offset,0),0)');
    expect(migration).not.toContain('dense_rank()');
  });

  it('returns personal ranks in the JSON shape consumed by PostgREST clients', () => {
    expect(migration.match(/RETURNS jsonb/g)).toHaveLength(2);
    expect(migration).toContain("'found', true, 'rank', r.rank, 'total', r.total_ranked");
    expect(migration).toContain("WHEN 'hands_played'    THEN r.hands_played");
    expect(migration).toContain("WHEN 'tournaments_won' THEN r.tournaments_won");
    expect(migration).toContain("WHEN 'roi'");
    expect(migration).toContain("WHEN 'bb100'");
  });

  it('closes anonymous SECURITY DEFINER execution and introduces no money movement', () => {
    expect(migration).toContain('FROM PUBLIC, anon');
    expect(migration).toContain('TO authenticated, service_role');
    expect(migration).not.toMatch(/UPDATE\s+public\.(union_wallets|clubs|club_members)/i);
    expect(migration).not.toContain('credit_player_wallet');
  });
});
