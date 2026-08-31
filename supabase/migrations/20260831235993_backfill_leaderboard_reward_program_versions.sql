-- Data migration: preserve already-published mutable leaderboard setups as V1.
-- Schema creation is intentionally separate in 20260831235992. Existing plans
-- keep the canonical period in which owners already advertised them; every new
-- publication after this migration begins at the next UTC boundary.
--
-- Idempotent on (club_id, version). This inserts audit rows and moves no money.

INSERT INTO public.leaderboard_reward_program_versions (
  club_id, version, operation_id, rewards_enabled, payout_metric,
  weekly_prizes, monthly_prizes, suggestion_key,
  funding_owner_type, funding_union_id,
  weekly_effective_from, monthly_effective_from,
  published_at, published_by, program_hash
)
SELECT
  settings.club_id,
  1,
  gen_random_uuid(),
  settings.rewards_enabled,
  settings.payout_metric,
  settings.weekly_prizes,
  settings.monthly_prizes,
  settings.suggestion_key,
  settings.funding_owner_type,
  settings.funding_union_id,
  weekly_bounds.start_date,
  monthly_bounds.start_date,
  COALESCE(settings.setup_completed_at, settings.updated_at, settings.created_at),
  COALESCE(settings.updated_by, settings.setup_completed_by, club.owner_id),
  md5(jsonb_build_object(
    'club_id', settings.club_id,
    'version', 1,
    'rewards_enabled', settings.rewards_enabled,
    'payout_metric', settings.payout_metric,
    'weekly_prizes', settings.weekly_prizes,
    'monthly_prizes', settings.monthly_prizes,
    'funding_owner_type', settings.funding_owner_type,
    'funding_union_id', settings.funding_union_id,
    'weekly_effective_from', weekly_bounds.start_date,
    'monthly_effective_from', monthly_bounds.start_date
  )::text)
FROM public.club_leaderboard_settings settings
JOIN public.clubs club ON club.id = settings.club_id
CROSS JOIN LATERAL public.fn_leaderboard_period_window(
  'weekly', 0, COALESCE(settings.setup_completed_at, settings.updated_at, settings.created_at)
) weekly_bounds
CROSS JOIN LATERAL public.fn_leaderboard_period_window(
  'monthly', 0, COALESCE(settings.setup_completed_at, settings.updated_at, settings.created_at)
) monthly_bounds
WHERE settings.setup_completed_at IS NOT NULL
ON CONFLICT (club_id, version) DO NOTHING;
