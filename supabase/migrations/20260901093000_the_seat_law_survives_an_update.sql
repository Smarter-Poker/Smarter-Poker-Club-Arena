-- ═══════════════════════════════════════════════════════════════════════════
-- THE SEAT LAW SURVIVES AN UPDATE — a guard that can only ever shrink a table
-- ═══════════════════════════════════════════════════════════════════════════
--
-- @unapplied: this REPLACES a trigger function on the live INSERT path for
-- public.tables and adds a second trigger to it. It is behaviour-preserving by
-- construction (see below) but it is not a comment, and CLAUDE.md's DDL policy
-- says batch DDL and apply it deliberately. Dan applies this, not an agent.
--
-- ── WHAT IS WRONG ─────────────────────────────────────────────────────────
--
-- fn_tables_creation_guard enforces Dan's cash seat law - plo6 6, plo5 7,
-- plo4 8, plo8 8, flo8 8, everything else 9 - and it is INSERT-ONLY BY DESIGN.
-- That design is right and this migration does not change it: a guard that can
-- refuse an UPDATE mid-hand is a guard that can stop the engine finishing a
-- hand, which is worse than the bug it stops.
--
-- But INSERT-only also means nothing stops max_players being RAISED past the
-- law after creation. One table is already outside it:
--
--     b0403832-bf2e-4af7-8cde-cdfeac893f21
--     "PLO 2.00/4.00 INSURANCE", game_variant plo4, max_players 9, cap 8
--     created 2026-08-21 18:14 UTC, ten days before the creation guard existed
--     7,199 hands dealt
--
-- Re-measured 2026-09-01 before writing this: that table's status is CLOSED
-- and it has ZERO occupied seats. It is not seating anybody today. This
-- migration still does not touch it - repairing a specific row is a decision
-- with a hand-history behind it, and it is raised in the pull request as
-- Dan's - but the "we cannot fix it, a hand might be in flight" objection does
-- not apply to a closed table with nobody in it.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────
--
-- A BEFORE UPDATE OF max_players trigger that permits every move EXCEPT the
-- one that makes things worse. Formally, an update is refused only when ALL of
--
--     the table is a cash table, AND
--     the new seat count exceeds the variant's cap, AND
--     the new seat count is GREATER THAN the old one
--
-- so:
--
--   9 -> 8 on the plo4 table above  ALLOWED (the repair)
--   9 -> 9                          not reached - WHEN clause requires a change
--   9 -> 10 on a plo4 table         REFUSED
--   8 -> 9 on a plo4 table          REFUSED
--   10 -> 9 on an illegal table     ALLOWED - still illegal, but strictly better
--
-- The third clause is what makes this safe to apply to a database that already
-- contains a violation. A guard that simply asserted `max_players <= cap` on
-- update would make the existing table UNREPAIRABLE and would refuse every
-- unrelated write to it, which is how a well-meant guard strands a live row.
--
-- IT CANNOT STOP A HAND. It fires only when max_players itself changes. No
-- engine path writes that column during a hand; seating, dealing, settlement
-- and cash-out touch table_seats and the tables status/pot columns, never the
-- seat count. An UPDATE that does not change max_players never reaches this
-- function at all (the WHEN clause), so the common path costs nothing.
--
-- ── AND IT ENDS A THIRD COPY OF THE LAW ───────────────────────────────────
--
-- The seat law is declared in src/config/tableSeating.ts and
-- server/src/config/tableSeating.ts, and scripts/ci/check-seat-law-parity.mjs
-- holds those two together plus HorseFleetManager.DEFAULT_TABLES. The CASE
-- expression inside fn_tables_creation_guard is a fourth copy that no gate has
-- ever compared to anything.
--
-- Writing the update guard by copy-pasting that CASE would have made a fifth.
-- So the numbers move ONCE, into public.fn_cash_seat_cap(text), and both
-- triggers call it. The creation guard's behaviour is unchanged to the digit -
-- same caps, same default of 9, same lower(coalesce(variant,'nlh')) - it just
-- stops carrying its own copy.
--
-- ── ROLLBACK (Tier 2 — restores the exact prior behaviour) ─────────────────
--   DROP TRIGGER IF EXISTS trg_tables_seat_law_update_guard ON public.tables;
--   DROP FUNCTION IF EXISTS public.fn_tables_seat_law_update_guard();
--   -- then restore fn_tables_creation_guard from the definition in
--   -- supabase/migrations (its CASE expression), and finally
--   DROP FUNCTION IF EXISTS public.fn_cash_seat_cap(text);

BEGIN;

SET LOCAL lock_timeout = '4s';

-- ── the law, once ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_cash_seat_cap(p_variant text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE lower(coalesce(p_variant, 'nlh'))
           WHEN 'plo6' THEN 6
           WHEN 'plo5' THEN 7
           WHEN 'plo4' THEN 8
           WHEN 'plo8' THEN 8
           WHEN 'flo8' THEN 8
           ELSE 9
         END;
$function$;

COMMENT ON FUNCTION public.fn_cash_seat_cap(text) IS
  'Dan''s cash seat law, the database copy: plo6 6, plo5 7, plo4 8, plo8 8, flo8 8, else 9. Deck arithmetic - PokerEngine.deal() throws rather than dealing short, so an over-seated PLO table fails mid-hand when Run It Twice asks for boards the deck cannot supply. Mirrors src/config/tableSeating.ts and server/src/config/tableSeating.ts, which scripts/ci/check-seat-law-parity.mjs holds together. Both fn_tables_creation_guard and fn_tables_seat_law_update_guard call this so the database has ONE copy, not two.';

-- ── the creation guard, unchanged except that it stops carrying a copy ────
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
    -- ── seat law ── (the numbers now live in fn_cash_seat_cap)
    v_cap := public.fn_cash_seat_cap(v_variant);
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

-- ── the update guard: it can only ever refuse an INCREASE past the cap ────
CREATE OR REPLACE FUNCTION public.fn_tables_seat_law_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_variant text := lower(coalesce(NEW.game_variant, 'nlh'));
  v_cap integer;
BEGIN
  IF coalesce(NEW.game_type, '') <> 'cash' THEN
    RETURN NEW;
  END IF;

  v_cap := public.fn_cash_seat_cap(v_variant);

  -- Refuse ONLY a move that is both illegal and worse than where it started.
  -- Shrinking is always allowed, including a shrink that lands on a still
  -- illegal number, because a table that is already outside the law must stay
  -- repairable. This is deliberately NOT `NEW.max_players > v_cap`.
  IF NEW.max_players > v_cap AND NEW.max_players > coalesce(OLD.max_players, 0) THEN
    RAISE EXCEPTION
      'seat law: % allows at most % seats and this table cannot grow past it (% -> %). Shrinking is always allowed.',
      v_variant, v_cap, OLD.max_players, NEW.max_players;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_tables_seat_law_update_guard() IS
  'BEFORE UPDATE OF max_players on public.tables. Refuses an increase past the cash seat law and NOTHING else - a shrink is always allowed, so a table already outside the law (b0403832-bf2e-4af7-8cde-cdfeac893f21, plo4 at 9) stays repairable rather than being frozen by its own guard. It cannot stop a hand: no engine path writes max_players mid-hand, and an update that does not change the column never fires it.';

DROP TRIGGER IF EXISTS trg_tables_seat_law_update_guard ON public.tables;
CREATE TRIGGER trg_tables_seat_law_update_guard
  BEFORE UPDATE OF max_players ON public.tables
  FOR EACH ROW
  WHEN (NEW.max_players IS DISTINCT FROM OLD.max_players)
  EXECUTE FUNCTION public.fn_tables_seat_law_update_guard();

-- ── Post-apply assertions ─────────────────────────────────────────────────
DO $$
DECLARE
  v_id uuid;
BEGIN
  -- the law itself
  IF public.fn_cash_seat_cap('plo6') <> 6 THEN RAISE EXCEPTION 'plo6 cap is not 6'; END IF;
  IF public.fn_cash_seat_cap('plo5') <> 7 THEN RAISE EXCEPTION 'plo5 cap is not 7'; END IF;
  IF public.fn_cash_seat_cap('PLO4') <> 8 THEN RAISE EXCEPTION 'plo4 cap is not 8 (case)'; END IF;
  IF public.fn_cash_seat_cap('plo8') <> 8 THEN RAISE EXCEPTION 'plo8 cap is not 8'; END IF;
  IF public.fn_cash_seat_cap('flo8') <> 8 THEN RAISE EXCEPTION 'flo8 cap is not 8'; END IF;
  IF public.fn_cash_seat_cap('nlh')  <> 9 THEN RAISE EXCEPTION 'nlh cap is not 9'; END IF;
  IF public.fn_cash_seat_cap(NULL)   <> 9 THEN RAISE EXCEPTION 'the NULL variant must default to 9'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tables'::regclass
       AND tgname  = 'trg_tables_seat_law_update_guard'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'the update guard trigger is not attached to public.tables';
  END IF;

  -- BEHAVIOURAL PROOF, rolled back. CLAUDE.md 11.5: a function that guards a
  -- live table is probed inside a transaction that is undone, and what we want
  -- is the error, not the side effect. This runs inside the migration's own
  -- transaction and is reverted by the SAVEPOINT, so no row survives it.
  SELECT id INTO v_id FROM public.tables
   WHERE game_type = 'cash' AND lower(coalesce(game_variant,'nlh')) = 'plo4'
   ORDER BY created_at LIMIT 1;

  IF v_id IS NOT NULL THEN
    BEGIN
      UPDATE public.tables SET max_players = 12 WHERE id = v_id;
      RAISE EXCEPTION 'GUARD DID NOT FIRE: a plo4 cash table was raised to 12 seats';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE 'GUARD DID NOT FIRE%' THEN
        RAISE;
      END IF;
      -- the guard spoke, which is the whole point
    END;
    -- Undo anything the probe touched. The UPDATE above either raised (nothing
    -- written) or was caught; this makes "nothing written" unconditional.
    RAISE NOTICE 'seat-law update guard verified against table %', v_id;
  END IF;
END $$;

COMMIT;
