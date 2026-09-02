-- SHOWDOWN POLISH 2026-08-25: persist what the table actually SAW at showdown.
--
-- hand_history.showdown holds one entry per showdown participant:
--   { user_id, seat, reveal_order, mucked,
--     hand_name?, hand_description? }        -- identity on REVEALED hands only
--
-- A mucked entry deliberately carries no hand identity: participants can read
-- their hands back (hand_history_authenticated_select), and a mucked range
-- must stay private (the 2026-08-17 leak rule). Replays and dispute review
-- render the reveal sequence from this column; NULL means "no showdown" or
-- "predates the column" — the same convention as pots/community_cards2.
--
-- Tier 1 (additive nullable column, no backfill, no index): nothing reads it
-- yet at apply time, and the engine writes it only for new hands.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'hand_history'
      AND column_name = 'showdown'
  ) THEN
    ALTER TABLE public.hand_history ADD COLUMN showdown jsonb;
    COMMENT ON COLUMN public.hand_history.showdown IS
      'Showdown reveal record: [{user_id, seat, reveal_order, mucked, hand_name?, hand_description?}]. Mucked entries carry no hand identity. NULL = no showdown or predates 2026-08-25.';
  END IF;
END $$;
