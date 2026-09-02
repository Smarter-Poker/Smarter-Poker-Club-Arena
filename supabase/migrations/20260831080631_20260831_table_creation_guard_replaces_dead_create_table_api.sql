-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831080631; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-08-31 — TABLE CREATION GUARD
--
-- The World Hub route pages/api/club-arena/create-table.js was DEAD CODE with
-- zero callers: every table a club owner actually creates comes from the
-- client insert in club-arena TableConfigPage. So none of that route's
-- validation ever ran. The route is deleted (World Hub PR #1051); the
-- validation that actually matters moves HERE, where it applies to every
-- writer regardless of which client is used.
--
-- What is enforced, and why each one is a real bug and not a preference:
--
--  * SEAT LAW (cash only). Hole cards and up to three Run-It-Twice boards come
--    out of one deck. Over-seat a PLO6/PLO5/PLO4/PLO8/FLO8 table and
--    PokerEngine.deal() THROWS 'Not enough cards in deck' — the engine refuses
--    every hand forever and the table is unplayable. Mirrors
--    src/config/tableSeating.ts (plo6 6, plo5 7, plo4/plo8/flo8 8, else 9).
--    TOURNAMENTS ARE EXEMPT by that same file's law: they cannot run it twice
--    and size their tables from their own structure (a Spin is 3-max because
--    it is a Spin).
--  * BLINDS SANITY (cash only, INSERT only). A table with bb <= sb prices
--    every bet wrong. INSERT-only on purpose: 1,193 CLOSED rows carry
--    sb = bb = 10,000,000 from tournament level escalation, and a guard that
--    refuses to let the engine finish a hand is worse than the bug it stops.
--  * BUY-IN ORDER (cash). min > max makes the buy-in dialog unopenable.
--  * ACTION TIME. The client slider allowed 5s while the engine's floor is 10.
--  * NAME. Trimmed, length-bounded, angle brackets stripped — the
--    sanitizeTableName the dead route did and nothing else has done since.
--
-- Deliberately NOT enforced here: the official stakes schedule, rake/BBJ tier
-- auto-fill and the settings JSONB payload the dead route also carried. Those
-- are business policy with live tables already outside them; they need Dan's
-- ruling before a guard can refuse a table for them. Recorded in the audit
-- changelog rather than silently invented.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_tables_creation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_variant text := lower(coalesce(NEW.game_variant, 'nlh'));
  v_cap integer;
  v_name text;
BEGIN
  -- ── name hygiene ──
  v_name := btrim(coalesce(NEW.name, ''));
  v_name := replace(replace(v_name, '<', ''), '>', '');
  IF length(v_name) = 0 THEN
    RAISE EXCEPTION 'table name is required';
  END IF;
  IF length(v_name) > 60 THEN
    v_name := left(v_name, 60);
  END IF;
  NEW.name := v_name;

  -- ── action time ──
  IF NEW.action_time_seconds IS NOT NULL
     AND (NEW.action_time_seconds < 10 OR NEW.action_time_seconds > 120) THEN
    RAISE EXCEPTION 'action_time_seconds must be between 10 and 120 (got %)', NEW.action_time_seconds;
  END IF;

  IF coalesce(NEW.game_type, '') = 'cash' THEN
    -- ── seat law ──
    v_cap := CASE v_variant
               WHEN 'plo6' THEN 6
               WHEN 'plo5' THEN 7
               WHEN 'plo4' THEN 8
               WHEN 'plo8' THEN 8
               WHEN 'flo8' THEN 8
               ELSE 9
             END;
    IF coalesce(NEW.max_players, 0) < 2 THEN
      RAISE EXCEPTION 'a cash table needs at least 2 seats (got %)', NEW.max_players;
    END IF;
    IF NEW.max_players > v_cap THEN
      RAISE EXCEPTION 'seat law: % allows at most % seats (got %) - the deck cannot fund three run-it boards above that',
        v_variant, v_cap, NEW.max_players;
    END IF;

    -- ── blinds ──
    IF coalesce(NEW.small_blind, 0) <= 0 OR coalesce(NEW.big_blind, 0) <= 0 THEN
      RAISE EXCEPTION 'blinds must be positive (sb=%, bb=%)', NEW.small_blind, NEW.big_blind;
    END IF;
    IF NEW.big_blind <= NEW.small_blind THEN
      RAISE EXCEPTION 'big blind must exceed small blind (sb=%, bb=%)', NEW.small_blind, NEW.big_blind;
    END IF;

    -- ── buy-in order ──
    IF NEW.min_buy_in IS NOT NULL AND NEW.max_buy_in IS NOT NULL
       AND NEW.min_buy_in > NEW.max_buy_in THEN
      RAISE EXCEPTION 'min_buy_in (%) cannot exceed max_buy_in (%)', NEW.min_buy_in, NEW.max_buy_in;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tables_creation_guard ON public.tables;
CREATE TRIGGER trg_tables_creation_guard
  BEFORE INSERT ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_tables_creation_guard();

-- ─ assertions: the guard refuses what it must, and permits what it must ─
DO $$
DECLARE v_club uuid; v_err text;
BEGIN
  SELECT id INTO v_club FROM public.clubs LIMIT 1;

  -- over-seated PLO6 must be refused
  BEGIN
    INSERT INTO public.tables (club_id, name, game_type, game_variant, max_players,
                               small_blind, big_blind, status)
    VALUES (v_club, 'zz guard probe', 'cash', 'plo6', 10, 1, 2, 'waiting');
    RAISE EXCEPTION 'guard did NOT refuse a 10-max PLO6';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err = 'guard did NOT refuse a 10-max PLO6' THEN RAISE; END IF;
  END;

  -- inverted blinds must be refused
  BEGIN
    INSERT INTO public.tables (club_id, name, game_type, game_variant, max_players,
                               small_blind, big_blind, status)
    VALUES (v_club, 'zz guard probe', 'cash', 'nlh', 6, 5, 2, 'waiting');
    RAISE EXCEPTION 'guard did NOT refuse inverted blinds';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err = 'guard did NOT refuse inverted blinds' THEN RAISE; END IF;
  END;
END $$;

-- A legal table must still insert. Probed inside a block that ALWAYS rolls the
-- row back by deleting it, because a probe must never leave a live table
-- behind (house rule: never spend real chips to test a rule).
DO $$
DECLARE v_club uuid; v_id uuid;
BEGIN
  SELECT id INTO v_club FROM public.clubs LIMIT 1;
  INSERT INTO public.tables (club_id, name, game_type, game_variant, max_players,
                             small_blind, big_blind, status)
  VALUES (v_club, 'zz guard probe legal', 'cash', 'plo6', 6, 1, 2, 'waiting')
  RETURNING id INTO v_id;
  DELETE FROM public.tables WHERE id = v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'guard refused a legal 6-max PLO6'; END IF;
END $$;

-- ROLLBACK:
--   DROP TRIGGER trg_tables_creation_guard ON public.tables;
--   DROP FUNCTION public.fn_tables_creation_guard();

