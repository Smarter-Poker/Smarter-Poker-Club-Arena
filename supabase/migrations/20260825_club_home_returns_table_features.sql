-- ═══════════════════════════════════════════════════════════════════════════
-- get_club_home must return the table FEATURE columns
-- ───────────────────────────────────────────────────────────────────────────
-- Dan 2026-08-25: "you need to add any table specifics and attributes tags
-- next to the buy in, like Insurance, Mandatory Run It Twice ... Not one NLH
-- table has this currently." Not one PLO table either.
--
-- The lobby medallions were reading `tables.settings`, which is `{}` on all 46
-- live cash tables — TableConfigPage writes the host's choices to top-level
-- COLUMNS. The client now reads those columns instead, and the direct query in
-- ClubHomePage was widened to fetch them.
--
-- This function is the OTHER reader. get_club_home is the one-round-trip fast
-- path that paints the lobby five trips before the authoritative chain lands,
-- and it carries its own hard-coded projection. Left alone, every card would
-- open with no medallions and grow them a second later when the chain
-- answered — a flicker that looks exactly like the bug being fixed.
--
-- Rewritten in place from pg_get_functiondef so nothing else in the body can
-- drift: the function is fetched, the one projection line is substituted, and
-- the result is executed. It asserts on its own assumptions and is idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

DO $migration$
DECLARE
  v_def  text;
  v_old  text := 'small_blind, big_blind, min_buy_in, max_buy_in, settings, created_at';
  v_new  text := 'small_blind, big_blind, min_buy_in, max_buy_in, settings, created_at, '
                 || 'run_it_twice, run_it_twice_enabled, allow_run_it_twice, insurance_enabled, '
                 || 'straddle_enabled, straddle_type, auto_utg_straddle, bomb_pot_enabled, '
                 || 'bomb_pot_frequency, bomb_pot_double_board, ante_enabled, ante, '
                 || 'seven_deuce_enabled, seven_deuce_amount, time_bank_enabled, all_in_or_fold';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_club_home';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_club_home does not exist - refusing to guess';
  END IF;

  -- Already widened by an earlier run of this migration.
  IF position('insurance_enabled' IN v_def) > 0 THEN
    RAISE NOTICE 'get_club_home already returns the feature columns; nothing to do';
    RETURN;
  END IF;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION
      'get_club_home no longer contains the tables projection this migration edits. '
      'Widen it by hand rather than letting this rewrite guess.';
  END IF;

  v_def := replace(v_def, v_old, v_new);
  EXECUTE v_def;
END
$migration$;

-- POST-APPLY ASSERTION: the function must now name the feature columns.
DO $verify$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_club_home';
  IF position('insurance_enabled' IN v_def) = 0
     OR position('run_it_twice' IN v_def) = 0
     OR position('bomb_pot_enabled' IN v_def) = 0 THEN
    RAISE EXCEPTION 'get_club_home did not pick up the feature columns';
  END IF;
END
$verify$;

-- ROLLBACK
-- Re-run the same rewrite in reverse: fetch pg_get_functiondef, replace the
-- widened projection with the original 13-column list, EXECUTE. Nothing else
-- in the function changed, and no data was touched.
