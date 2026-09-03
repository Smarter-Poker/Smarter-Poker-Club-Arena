-- ═══════════════════════════════════════════════════════════════════════════
-- DOUBLE-BOARD BOMB POT (2026-08-20, Dan's competitor-parity directive)
--
-- 1. tables.bomb_pot_double_board — per-table opt-in: bomb-pot hands deal
--    TWO full boards and split every pot in half across them at showdown.
--    The engine downgrades to a single board when the deck cannot cover
--    players × holeCards + 10 board cards (e.g. 9-handed PLO5).
-- 2. hand_history.community_cards2 — board 2 persistence, same text[] shape
--    as community_cards. NULL on every single-board hand, so existing
--    consumers (replay, BBJ detector, integrity feed) see no change.
--
-- Tier 2: additive columns only, both nullable-or-defaulted. No backfill
-- needed; no RLS change (columns inherit the row policies of their tables).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS bomb_pot_double_board boolean NOT NULL DEFAULT false;

ALTER TABLE public.hand_history
  ADD COLUMN IF NOT EXISTS community_cards2 text[] NULL;

-- Post-apply assertions: both columns exist with the expected types.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tables'
      AND column_name = 'bomb_pot_double_board' AND data_type = 'boolean'
  ) THEN
    RAISE EXCEPTION 'assertion failed: tables.bomb_pot_double_board missing or wrong type';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'hand_history'
      AND column_name = 'community_cards2' AND data_type = 'ARRAY'
  ) THEN
    RAISE EXCEPTION 'assertion failed: hand_history.community_cards2 missing or wrong type';
  END IF;
END $$;
