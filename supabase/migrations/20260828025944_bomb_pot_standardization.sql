-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828025944; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- BOMB POT STANDARDIZATION (2026-08-27, Dan's Bomb Pot Rules + Architecture
-- Specification)
--
-- tables — the canonical bomb-pot configuration surface (spec §3):
--   1. bomb_pot_board_count      1 | 2 | 3 boards per bomb hand. Supersedes
--                                the boolean bomb_pot_double_board (kept for
--                                old readers; backfilled below so the two
--                                agree on every existing row).
--   2. bomb_pot_trigger_mode     'every_n_hands' (legacy default) |
--                                'once_per_orbit' | 'timed' | 'bomb_pot_only'
--   3. bomb_pot_interval_seconds TIMED mode: seconds between bombs (server
--                                clock, executed at the next hand boundary).
--   4. bomb_pot_min_players      a due bomb stays pending until this many
--                                players are dealt in (spec default 3).
--   5. bomb_pot_ante_fixed       FIXED ante mode: exact chip amount; when
--                                > 0 it overrides bomb_pot_ante_multiplier.
--
-- hand_history — auditability (spec §20):
--   6. community_cards3          board 3, same text[] shape as
--                                community_cards / community_cards2. NULL on
--                                every hand below three boards.
--   7. bomb_pot                  jsonb {trigger_reason, ante_amount,
--                                board_count} frozen at trigger time. NULL on
--                                every normal hand.
--
-- Tier 2: additive columns only, all nullable or defaulted.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS bomb_pot_board_count smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS bomb_pot_trigger_mode text NOT NULL DEFAULT 'every_n_hands',
  ADD COLUMN IF NOT EXISTS bomb_pot_interval_seconds integer NULL,
  ADD COLUMN IF NOT EXISTS bomb_pot_min_players smallint NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS bomb_pot_ante_fixed numeric NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tables_bomb_pot_board_count_check'
  ) THEN
    ALTER TABLE public.tables
      ADD CONSTRAINT tables_bomb_pot_board_count_check
      CHECK (bomb_pot_board_count BETWEEN 1 AND 3);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tables_bomb_pot_trigger_mode_check'
  ) THEN
    ALTER TABLE public.tables
      ADD CONSTRAINT tables_bomb_pot_trigger_mode_check
      CHECK (bomb_pot_trigger_mode IN ('every_n_hands', 'once_per_orbit', 'timed', 'bomb_pot_only'));
  END IF;
END $$;

UPDATE public.tables
   SET bomb_pot_board_count = 2
 WHERE bomb_pot_double_board = true
   AND bomb_pot_board_count = 1;

ALTER TABLE public.hand_history
  ADD COLUMN IF NOT EXISTS community_cards3 text[] NULL,
  ADD COLUMN IF NOT EXISTS bomb_pot jsonb NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tables'
      AND column_name = 'bomb_pot_board_count' AND data_type = 'smallint'
  ) THEN
    RAISE EXCEPTION 'assertion failed: tables.bomb_pot_board_count missing or wrong type';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tables'
      AND column_name = 'bomb_pot_trigger_mode' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'assertion failed: tables.bomb_pot_trigger_mode missing or wrong type';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'hand_history'
      AND column_name = 'community_cards3' AND data_type = 'ARRAY'
  ) THEN
    RAISE EXCEPTION 'assertion failed: hand_history.community_cards3 missing or wrong type';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'hand_history'
      AND column_name = 'bomb_pot' AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'assertion failed: hand_history.bomb_pot missing or wrong type';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tables
    WHERE bomb_pot_double_board = true AND bomb_pot_board_count < 2
  ) THEN
    RAISE EXCEPTION 'assertion failed: double-board table left with board_count < 2';
  END IF;
END $$;
