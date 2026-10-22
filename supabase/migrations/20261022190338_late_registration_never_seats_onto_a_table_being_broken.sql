-- 20261022190338_late_registration_never_seats_onto_a_table_being_broken.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A real player (iPhone, 2026-10-22 16:37-16:40 UTC) tried to late-register
-- for "Coffee Break Freeroll (PLO4)" 16 times inside its open 40-minute
-- window and was refused every time with HTTP 500. The refusal was
-- F06_SOURCE_EXCLUDED, raised by smarter_private.f06_source_guard on:
--
--   fn_register_for_tournament_request
--    -> fn_register_for_tournament ... -> fn_seat_late_registrant
--    -> fn_seat_late_registrant_before_maintenance_gate
--       UPDATE public.table_seats SET user_id = p_user_id ... (line 93)
--
-- The seat chooser picks the FULLEST running table with a free chair. A table
-- the balancer is breaking (a non-terminal F06 operation names it as
-- source_table_id) always has free chairs, because its players are being
-- moved off, so it is exactly the table the chooser prefers - and the F06
-- guard correctly refuses any ordinary writer on it. The registration's whole
-- transaction rolled back. Measured in the logs: 85 F06_SOURCE_EXCLUDED
-- refusals today (06:00, 14:00-16:00 UTC).
--
-- fn_ensure_late_registration_capacity has the same blind spot: it counts the
-- free chairs on a table being broken as open capacity, so it can answer
-- "capacity_sufficient" and open no new table while every real open chair is
-- on a table nobody may sit at.
--
-- THE FIX, at the line that chose the table:
--   * the late-registrant seat chooser skips any table that is the source of a
--     non-terminal F06 operation - the same predicate f06_source_guard uses to
--     decide a table is bound (state NOT IN acknowledged,
--     withdrawn_before_manifest), served by the partial unique index
--     f06_one_source;
--   * the capacity check leaves those tables out of live capacity, so when the
--     only open chairs are on a table being broken it opens a new table.
-- Nothing else in either function changes. No money, no seats, no existing
-- rows are touched; the guard itself is unchanged.
--
-- ROLLBACK: re-apply both functions without the added NOT EXISTS clause
-- (each edit below is a single inserted predicate).

BEGIN;

DO $m$
DECLARE
  v_bound text := E'AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_operations o\n'
               || E'                      WHERE o.source_table_id = tb.id\n'
               || E'                        AND o.state NOT IN (\'acknowledged\', \'withdrawn_before_manifest\'))';
  v_def text;
  v_old text;
  v_new text;
BEGIN
  -- 1. The seat chooser.
  v_def := pg_get_functiondef('public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure);
  v_old := E'     AND COALESCE(tb.is_deleted,false)=false\n     AND (\n';
  v_new := E'     AND COALESCE(tb.is_deleted,false)=false\n     ' || v_bound || E'\n     AND (\n';
  IF position('smarter_private.f06_operations' IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'seat chooser: expected exactly one table filter to extend';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;

  -- 2. The capacity check.
  v_def := pg_get_functiondef('public.fn_ensure_late_registration_capacity(uuid,integer)'::regprocedure);
  v_old := E'       AND COALESCE(tb.is_deleted,false)=false\n  ), occupancy AS (';
  v_new := E'       AND COALESCE(tb.is_deleted,false)=false\n       ' || v_bound || E'\n  ), occupancy AS (';
  IF position('smarter_private.f06_operations' IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'capacity check: expected exactly one live_tables filter to extend';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;
END
$m$;

DO $assert$
BEGIN
  IF position('smarter_private.f06_operations' IN
       pg_get_functiondef('public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'seat chooser was not updated';
  END IF;
  IF position('smarter_private.f06_operations' IN
       pg_get_functiondef('public.fn_ensure_late_registration_capacity(uuid,integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'capacity check was not updated';
  END IF;
END
$assert$;

COMMIT;
