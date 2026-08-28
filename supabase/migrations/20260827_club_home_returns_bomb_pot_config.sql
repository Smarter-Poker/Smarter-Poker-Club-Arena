-- ═══════════════════════════════════════════════════════════════════════════
-- CLUB HOME RETURNS THE BOMB POT CONFIG (2026-08-27, spec §15.1)
--
-- The lobby must disclose a table's bomb schedule and board count BEFORE a
-- player sits. get_club_home's tables SELECT carried only the legacy trio
-- (enabled / frequency / double_board), so a timed, once-per-orbit or
-- bomb-pot-only table would have shown no bomb medallion at all, and a
-- triple-board table would have claimed two boards.
--
-- Rather than restating the whole function (it is rebuilt often and a stale
-- copy here would silently roll back someone else's column), this migration
-- rewrites the LIVE definition in place: fetch pg_get_functiondef, splice the
-- three new columns into the one SELECT line, and EXECUTE the result. Fails
-- closed if the line has been reshaped.
-- ═══════════════════════════════════════════════════════════════════════════

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

  -- Idempotent: a re-run (or a definition that already carries the columns)
  -- changes nothing.
  IF v_def LIKE '%bomb_pot_board_count%' THEN
    RETURN;
  END IF;

  v_def := replace(
    v_def,
    'bomb_pot_enabled, bomb_pot_frequency, bomb_pot_double_board,',
    'bomb_pot_enabled, bomb_pot_frequency, bomb_pot_double_board, bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds,'
  );

  IF v_def NOT LIKE '%bomb_pot_board_count%' THEN
    RAISE EXCEPTION 'get_club_home tables SELECT has been reshaped — splice point not found; extend it by hand';
  END IF;

  EXECUTE v_def;
END $$;

-- Post-apply assertion: the live definition now ships the new columns.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'get_club_home' AND n.nspname = 'public'
      AND pg_get_functiondef(p.oid) LIKE '%bomb_pot_trigger_mode%'
  ) THEN
    RAISE EXCEPTION 'assertion failed: get_club_home does not return bomb_pot_trigger_mode';
  END IF;
END $$;
