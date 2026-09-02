import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    __dirname,
    '../../supabase/migrations/20260831000500_leaderboard_canonical_period_windows.sql'
  ),
  'utf8'
);

describe('canonical leaderboard period migration', () => {
  it('defines one UTC calendar-window contract for every leaderboard consumer', () => {
    expect(migration).toContain('fn_leaderboard_period_window');
    expect(migration).toContain("v_timezone constant text := 'UTC'");
    expect(migration).toContain("WHEN 'weekly' THEN v_today - EXTRACT(DOW FROM v_today)::integer");
    expect(migration).toContain("WHEN 'monthly' THEN date_trunc('month', v_today)::date");
    expect(migration).toContain("RAISE EXCEPTION 'Unsupported Leaderboard Period'");
  });

  it('moves current club and global rankings from rolling windows to the canonical start date', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_period_v2');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.fn_global_leaderboard_period');
    expect(migration).toContain('FROM public.fn_leaderboard_period_window(p_period, 0)');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.fn_union_leaderboard_period_v2');
    expect(migration).not.toContain("WHEN 'weekly' THEN 7");
    expect(migration).not.toContain("WHEN 'monthly' THEN 30");
  });

  it('preserves tied ranks, active-player denominators and union parity', () => {
    expect(migration).toContain('rank() OVER (ORDER BY s.score DESC NULLS LAST) AS rk_now');
    expect(migration).toContain('count(*) OVER () AS total_active');
    expect(migration).toContain(
      'WHERE (s.d_hands > 0 OR s.d_twon > 0 OR s.d_win <> 0 OR s.d_loss <> 0)'
    );
    expect(migration).toContain(
      'public.fn_union_leaderboard_period_v2(uuid,text,text,integer,integer)'
    );
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.fn_user_rank_by_dates');
  });

  it('grants the read-only boundary RPC without introducing a money path', () => {
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_leaderboard_period_window(text, integer, timestamptz) TO authenticated, service_role'
    );
    expect(migration).not.toMatch(/UPDATE\s+public\.(union_wallets|clubs|club_members)/i);
    expect(migration).not.toContain('credit_player_wallet');
  });
});
