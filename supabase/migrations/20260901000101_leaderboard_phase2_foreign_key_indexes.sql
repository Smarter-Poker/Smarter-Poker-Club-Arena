-- Cover the four leaderboard reward foreign keys reported by the production
-- performance advisor. These tables are currently tiny; IF NOT EXISTS keeps
-- the forward migration replay-safe.

CREATE INDEX IF NOT EXISTS idx_club_lb_settings_funding_union
  ON public.club_leaderboard_settings (funding_union_id)
  WHERE funding_union_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_club_lb_settings_setup_completed_by
  ON public.club_leaderboard_settings (setup_completed_by)
  WHERE setup_completed_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_club_lb_settings_updated_by
  ON public.club_leaderboard_settings (updated_by)
  WHERE updated_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lb_reward_versions_supersedes
  ON public.leaderboard_reward_program_versions (supersedes_program_id)
  WHERE supersedes_program_id IS NOT NULL;
