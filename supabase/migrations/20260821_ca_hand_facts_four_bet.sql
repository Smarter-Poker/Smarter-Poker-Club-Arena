-- =====================================================================
-- 20260821_ca_hand_facts_four_bet.sql
-- Tier 2: one additive column plus column comments. Idempotent.
--
-- A 4-bet was neither distinguished by `pfr` nor captured by
-- `three_bet`, so the fact table could not answer any 4-bet question.
-- Like everything else on this table, it is captured at settlement or
-- not at all: hand_history is purged at 7 days, so a column added later
-- starts empty forever. Added now rather than when somebody first asks.
--
-- Committed separately because the column was first applied directly
-- against production during the 2026-08-21 audit, leaving it live but
-- absent from the migration history. CLAUDE.md RULE 2 requires the
-- schema to be reproducible from supabase/migrations alone.
-- =====================================================================

ALTER TABLE public.ca_hand_facts
  ADD COLUMN IF NOT EXISTS four_bet boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.ca_hand_facts.four_bet IS
  'Player made the third voluntary preflop raise (the 4-bet). Blinds are not in the action log, so the open is raise index 0, the 3-bet index 1 and the 4-bet index 2. A 5-bet sets neither this nor three_bet, matching the usual tracker scoping.';

COMMENT ON COLUMN public.ca_hand_facts.faced_three_bet IS
  'Player OPENED (first voluntary raise) and was then 3-bet. Deliberately excludes facing a 4-bet after 3-betting, and excludes cold-callers facing a squeeze, to match the standard tracker definition.';

COMMENT ON COLUMN public.ca_hand_facts.folded_to_three_bet IS
  'Player faced a 3-bet and folded WITHOUT having answered it first. A fold after 4-betting is a fold to the 4-bet or 5-bet and is not counted here.';

COMMENT ON COLUMN public.ca_hand_facts.rake_paid IS
  'Contribution-weighted share of the hand rake, matching how atomic_distribute_rake apportions it. Hardcoded 0 before 2026-08-21 - rows written earlier understate rake.';

COMMENT ON COLUMN public.ca_hand_facts.was_all_in IS
  'True when the player was all-in, INCLUDING getting there by calling. The action log records a stack-consuming call as action=call, so this also derives from presence in the all-in equity runout.';

COMMENT ON COLUMN public.ca_hand_facts.saw_flop IS
  'Player did not fold PREFLOP and the board reached three cards. A later fold does not clear it - they still saw the flop.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ca_hand_facts'
      AND column_name = 'four_bet'
  ) THEN
    RAISE EXCEPTION 'ASSERT FAILED: ca_hand_facts.four_bet missing.';
  END IF;
  RAISE NOTICE 'four_bet present.';
END $$;
