import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(__dirname, '../..', path), 'utf8');

const migration = read(
  'supabase/migrations/20260831235992_leaderboard_reward_program_versions.sql'
);
const service = read('src/services/LeaderboardService.ts');
const wizard = read('src/components/leaderboard/LeaderboardPrizeWizard.tsx');
const page = read('src/pages/LeaderboardPage.tsx');

describe('leaderboard reward program versioning contract', () => {
  it('publishes append-only versions with one immutable funding owner snapshot', () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS public.leaderboard_reward_program_versions'
    );
    expect(migration).toContain('UNIQUE (club_id, version)');
    expect(migration).toContain('UNIQUE (club_id, operation_id)');
    expect(migration).toContain('leaderboard_reward_program_versions_are_immutable');
    expect(migration).toContain("funding_owner_type IN ('union', 'club')");
    expect(migration).toContain('funding_union_id');
    expect(migration).toContain('published_by');
    expect(migration).toContain('program_hash');
    expect(migration).not.toContain('club_id uuid NOT NULL REFERENCES public.clubs');
    expect(migration).not.toContain('funding_union_id uuid REFERENCES public.unions');
  });

  it('prevents lost updates and makes a retried publication return the same version', () => {
    expect(migration).toContain('p_expected_version integer');
    expect(migration).toContain('p_operation_id uuid');
    expect(migration).toContain('Leaderboard Prize Setup Changed In Another Session');
    expect(migration).toContain('WHERE existing.club_id = p_club_id');
    expect(migration).toContain('AND existing.operation_id = p_operation_id');
    expect(service).toContain('p_expected_version: setup.program_version');
    expect(service).toContain('const operationId = uuid()');
    expect(service).toContain('p_operation_id: operationId');
    expect(service).toContain("supabase.rpc('fn_get_leaderboard_reward_plan'");
  });

  it('activates weekly and monthly rules only at the next canonical UTC boundary', () => {
    expect(migration).toContain("fn_leaderboard_period_window('weekly', 0)");
    expect(migration).toContain("fn_leaderboard_period_window('monthly', 0)");
    expect(migration).toContain('weekly_effective_from');
    expect(migration).toContain('monthly_effective_from');
    expect(migration).toContain('fn_get_leaderboard_reward_plan');
    expect(migration).toContain('p_period_start date');
  });

  it('keeps direct writes closed and exposes only published plans to players', () => {
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('Leaderboard Reward Programs Are Public After Publication');
    expect(migration).toContain('FOR SELECT TO authenticated');
    expect(migration).not.toMatch(/FOR (INSERT|UPDATE|DELETE) TO authenticated/i);
    expect(migration).toContain('FROM PUBLIC, anon');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_publish_leaderboard_reward_program\([\s\S]*?FROM PUBLIC, anon, authenticated;\s*GRANT EXECUTE ON FUNCTION public\.fn_publish_leaderboard_reward_program\([\s\S]*?\) TO service_role;/
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_save_leaderboard_reward_setup\([\s\S]*?FROM PUBLIC, anon;\s*GRANT EXECUTE ON FUNCTION public\.fn_save_leaderboard_reward_setup\([\s\S]*?\) TO authenticated, service_role;/
    );
  });

  it('makes the publication boundary explicit in the owner and player UI', () => {
    expect(wizard).toContain('Publish Prize Program');
    expect(wizard).toContain('Starts Next Period');
    expect(wizard).toContain('Current Standings Keep Their Published Rules');
    expect(page).toContain('Program Version');
    expect(page).toContain('settings.program_version');
    expect(page).toContain('settings.weekly_effective_from');
    expect(page).toContain('settings.monthly_effective_from');
    expect(page).toContain('rewardPlan.prizes');
    expect(page).not.toContain('new Map(plan.map((prize) => [prize.rank, prize.amount]))');
  });
});
