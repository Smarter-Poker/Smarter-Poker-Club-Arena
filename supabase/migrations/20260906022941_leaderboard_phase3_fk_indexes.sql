-- LEADERBOARD PHASE 3 DEEP-AUDIT REPAIR: COVER NEW FOREIGN KEYS.
--
-- These indexes keep union funding lookups, immutable-program lineage, and
-- payout-batch program joins bounded as the reward history grows. The tables
-- contained at most one row when this repair was published, so regular index
-- creation is deliberate and does not need the operational complexity of a
-- non-transactional concurrent build.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_club_leaderboard_settings_funding_union
  ON public.club_leaderboard_settings (funding_union_id)
  WHERE funding_union_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leaderboard_payout_batches_funding_union
  ON public.leaderboard_payout_batches (funding_union_id)
  WHERE funding_union_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leaderboard_payout_batches_program
  ON public.leaderboard_payout_batches (program_id)
  WHERE program_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leaderboard_reward_programs_supersedes
  ON public.leaderboard_reward_program_versions (supersedes_program_id)
  WHERE supersedes_program_id IS NOT NULL;

COMMIT;
