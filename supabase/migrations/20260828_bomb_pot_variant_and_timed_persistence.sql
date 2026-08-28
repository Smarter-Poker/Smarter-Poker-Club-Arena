-- ═══════════════════════════════════════════════════════════════════════════
-- BOMB POT VARIANT OVERRIDE + TIMED PERSISTENCE (2026-08-28, spec §10.1/§4.3)
--
-- 1. tables.bomb_pot_variant — the bomb HAND's variant when it differs from
--    the table's (spec §10.1: "a normal NLH table that runs a PLO4
--    double-board bomb pot once per orbit"). NULL = same as table. The engine
--    whitelists the value; the CHECK mirrors that whitelist so a bad write
--    fails loudly at the database too.
--
-- 2. tables.bomb_pot_next_due_at — the timed mode's next due timestamp,
--    written by the engine when the clock is (re)set. Until now the clock
--    lived only in engine memory, so every deploy restarted the cycle and a
--    30-minute table could silently drift to 30+N minutes. The engine seeds
--    its scheduler from this at boot.
--
-- 3. hand_history.bomb_pot jsonb gains a `variant` key (no DDL — additive
--    jsonb), recorded by the engine from this change on.
--
-- Tier 2: additive, nullable. No backfill, no RLS change.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS bomb_pot_variant text NULL,
  ADD COLUMN IF NOT EXISTS bomb_pot_next_due_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tables_bomb_pot_variant_check'
  ) THEN
    ALTER TABLE public.tables
      ADD CONSTRAINT tables_bomb_pot_variant_check
      CHECK (bomb_pot_variant IS NULL OR bomb_pot_variant IN ('nlh', 'plo4', 'plo5', 'plo6'));
  END IF;
END $$;

-- get_club_home ships the variant so the lobby can say "PLO4 bomb pots" on
-- an NLH table before anyone sits (spec §15.1). Same fail-closed in-place
-- splice as 20260827_club_home_returns_bomb_pot_config.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'get_club_home' AND n.nspname = 'public';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_club_home not found';
  END IF;

  IF v_def LIKE '%bomb_pot_variant%' THEN
    RETURN; -- idempotent
  END IF;

  v_def := replace(
    v_def,
    'bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds,',
    'bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds, bomb_pot_variant,'
  );

  IF v_def NOT LIKE '%bomb_pot_variant%' THEN
    RAISE EXCEPTION 'get_club_home tables SELECT has been reshaped — splice point not found; extend it by hand';
  END IF;

  EXECUTE v_def;
END $$;

-- Post-apply assertions.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tables'
      AND column_name = 'bomb_pot_variant' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'assertion failed: tables.bomb_pot_variant missing or wrong type';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tables'
      AND column_name = 'bomb_pot_next_due_at'
      AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'assertion failed: tables.bomb_pot_next_due_at missing or wrong type';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'get_club_home' AND n.nspname = 'public'
      AND pg_get_functiondef(p.oid) LIKE '%bomb_pot_variant%'
  ) THEN
    RAISE EXCEPTION 'assertion failed: get_club_home does not return bomb_pot_variant';
  END IF;
END $$;
