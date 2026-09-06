-- 20260906232223_the_seat_guard_says_what_it_actually_does.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- THE SEAT GUARD SAYS WHAT IT ACTUALLY DOES.
--
-- `fn_ca_guard_seat_creation` is the money guard armed on 2026-09-06: chips
-- reach a seat through the engine or a declared money path, or not at all.
-- Its header carried one wrong sentence:
--
--     It LOGS the refusal before raising it, so a refused seat names its own
--     caller and the allowlist can be corrected in minutes.
--
-- It does not log, and it cannot: a RAISE in a BEFORE trigger aborts the
-- statement and takes the trigger's own INSERT with it. The function says so
-- itself, correctly, forty lines further down at the RAISE:
--
--     No table write here: a RAISE in a BEFORE trigger aborts the statement
--     and would take the row with it (measured). The evidence travels in the
--     error.
--
-- So the guard contained two statements that contradict each other, one of
-- them wrong, inside a function that refuses money movements. An agent
-- debugging a SEAT_NOT_FUNDED refusal follows the wrong one to
-- `ca_seat_guard_dryrun`, finds it empty, and concludes the guard never
-- fired. The Table Stakes handoff has carried this as an open item since it
-- was armed, deferred because correcting a comment costs a ~28-second
-- PostgREST schema reload.
--
-- ONLY THE COMMENT CHANGES. The body is re-emitted verbatim from the LIVE
-- definition (pg_get_functiondef, read 2026-09-06 18:22 CDT) with that one
-- paragraph replaced, and the migration asserts afterwards that the wrong
-- sentence is gone, the right one is still there, and every allowlisted money
-- path survived - so a re-emission cannot quietly widen the guard.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_guard_seat_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_creating boolean;
BEGIN
  /* A seat that appears (INSERT) or comes back to life (left_at NOT NULL ->
     NULL) carrying chips is money arriving on the felt. Only two things may
     put it there: the engine (service_role, or a session with no JWT at all -
     psql, pg_cron, a migration; see fn_caller_is_engine), or a money RPC that
     has debited a wallet or a treasury for it and says so through
     app.money_path. Anything else is a mint.

     ARMED 2026-09-06, after the dry run stayed empty across 170,942 seat
     creations. A refused seat NAMES ITS OWN CALLER IN THE ERROR - the money
     path, the JWT role, the application_name, the table, the seat and the
     stack - so the allowlist can be corrected in minutes.

     IT DOES NOT LOG. This sentence used to say it did, and that was wrong in
     a way that costs somebody an afternoon: a RAISE in a BEFORE trigger
     aborts the statement and takes the trigger's own INSERT with it, so a
     guard cannot write its own refusal anywhere. An agent reading the old
     sentence goes looking in `ca_seat_guard_dryrun`, finds it empty, and
     concludes the guard never fired. The evidence is in the error message and
     only in the error message - see the RAISE below, which has said so
     correctly all along. */
  v_creating := (TG_OP = 'INSERT' AND NEW.left_at IS NULL)
             OR (TG_OP = 'UPDATE' AND OLD.left_at IS NOT NULL AND NEW.left_at IS NULL);
  IF NOT v_creating OR COALESCE(NEW.stack, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_caller_is_engine() THEN
    RETURN NEW;
  END IF;

  v_path := current_setting('app.money_path', true);
  IF v_path IN ('atomic_table_buyin', 'fn_take_seat_and_buy_in',
                'fn_seat_horse_in_seat_first_game', 'fn_seat_late_registrant',
                'fn_horse_seat_from_treasury') THEN
    RETURN NEW;
  END IF;

  /* No table write here: a RAISE in a BEFORE trigger aborts the statement and
     would take the row with it (measured). The evidence travels in the error. */
  RAISE EXCEPTION 'SEAT_NOT_FUNDED: chips may only reach a seat through the engine or a declared money path (path=%, jwt_role=%, app=%, table=%, seat=%, stack=%)',
    COALESCE(NULLIF(v_path, ''), 'none'),
    COALESCE(auth.role(), 'none'),
    COALESCE(NULLIF(current_setting('application_name', true), ''), 'none'),
    NEW.table_id, NEW.seat_number, NEW.stack
    USING ERRCODE = 'check_violation',
          HINT = 'The caller must debit a wallet or a treasury and declare itself with app.money_path, or be the engine. Add the path to fn_ca_guard_seat_creation only after confirming it moved money.';
END;
$function$;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_ca_guard_seat_creation' AND pronamespace = 'public'::regnamespace;

  IF position('LOGS the refusal' in v_src) > 0 THEN
    RAISE EXCEPTION 'VERIFY: the guard still claims it logs its refusal';
  END IF;
  IF position('The evidence travels in the error.' in v_src) = 0 THEN
    RAISE EXCEPTION 'VERIFY: the guard lost the sentence that is true';
  END IF;
  IF position('NAMES ITS OWN CALLER IN THE ERROR' in v_src) = 0 THEN
    RAISE EXCEPTION 'VERIFY: the corrected sentence is not present';
  END IF;

  -- THE GUARD IS NOT WIDENED. Every allowlisted path, and no others.
  FOR v_src IN SELECT unnest(ARRAY[
        'atomic_table_buyin', 'fn_take_seat_and_buy_in',
        'fn_seat_horse_in_seat_first_game', 'fn_seat_late_registrant',
        'fn_horse_seat_from_treasury'])
  LOOP
    IF position(v_src in (SELECT prosrc FROM pg_proc
                           WHERE proname = 'fn_ca_guard_seat_creation'
                             AND pronamespace = 'public'::regnamespace)) = 0 THEN
      RAISE EXCEPTION 'VERIFY: the money path % is missing from the guard', v_src;
    END IF;
  END LOOP;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_ca_guard_seat_creation' AND pronamespace = 'public'::regnamespace;
  IF (length(v_src) - length(replace(v_src, 'RETURN NEW;', ''))) / length('RETURN NEW;') <> 3 THEN
    RAISE EXCEPTION 'VERIFY: the guard has a different number of early returns than the body it replaced';
  END IF;
  IF position('SEAT_NOT_FUNDED' in v_src) = 0 THEN
    RAISE EXCEPTION 'VERIFY: the guard no longer raises SEAT_NOT_FUNDED';
  END IF;
END $$;

COMMIT;
