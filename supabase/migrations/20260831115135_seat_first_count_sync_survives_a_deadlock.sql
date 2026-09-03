-- PHASE 1 FOLLOW-UP: fn_sync_seat_first_player_count loses a deadlock and gives up.
--
-- The function UPDATEs public.tables and then public.tournaments. Concurrent
-- writers on the seating path touch those two relations in the opposite order,
-- so under real load the pair deadlocks and Postgres kills whichever
-- transaction it picks. The engine logs "seat-first count sync failed for
-- tournament <id>: deadlock detected" and the counter is simply not written.
--
-- Measured 2026-08-31: deadlocks ran at a 1-4/hour baseline for days, then rose
-- to 13/hr at 08:00 and 27/hr at 10:00 - the hours in which the horse fleet and
-- the SNG board came back to life (spins went from 3-10/hr to 150/hr, and 28
-- SNGs were created in an hour after 16 hours of zero). The deadlock is not new;
-- the traffic that exposes it is. It was already visible at low volume in the
-- 03:30-08:53 window before any of today's changes.
--
-- NOT a correctness bug today: reconcile-tournament-denormals runs every minute
-- and the function recomputes from scratch, so a lost run is repaired by the
-- next one. Verified at the time of writing: zero live SNG/SPIN tournaments had
-- current_players disagreeing with their live seat count. This is wasted work
-- and log noise that hides real failures, and it becomes a correctness bug the
-- moment something reads the counter between a failure and the next sweep.
--
-- FIX: the function is idempotent - it derives both counters from a COUNT(*) -
-- so losing a deadlock is safe to simply retry. A PL/pgSQL EXCEPTION block opens
-- a subtransaction, so 40P01 can be caught and the work re-attempted without
-- poisoning the caller's transaction. Three attempts, then give up exactly as
-- before and let the every-minute sweep have it.
--
-- Lock ORDER is deliberately left alone: reordering the two UPDATEs here would
-- only move the inversion to whichever writer currently agrees with this one.
--
-- TIER 3 (function change). ROLLBACK pasted at the bottom.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_sync_seat_first_player_count'
       AND pg_get_function_identity_arguments(p.oid) = 'p_tournament_id uuid'
  ) THEN
    RAISE EXCEPTION 'pre-flight: fn_sync_seat_first_player_count(uuid) not found';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_sync_seat_first_player_count(p_tournament_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_table      uuid;
  v_seats      integer := 0;
  v_seat_first boolean := false;
  v_attempt    integer := 0;
BEGIN
  SELECT (COALESCE(t.variant, '') IN ('spin', 'sng') OR COALESCE(t.max_players, 0) <= 2)
    INTO v_seat_first
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  <<retry>>
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      v_table := public.fn_tournament_primary_table(p_tournament_id);

      IF v_table IS NULL THEN
        -- Every table is closed (or none exists). A seat-first tournament's
        -- counter still derives from its live seats across all its tables, and
        -- with them all closed that number is the honest zero.
        IF COALESCE(v_seat_first, false) THEN
          SELECT count(*) INTO v_seats
            FROM public.table_seats s
            JOIN public.tables tb ON tb.id = s.table_id
           WHERE tb.tournament_id = p_tournament_id
             AND s.left_at IS NULL;
          UPDATE public.tournaments SET current_players = v_seats WHERE id = p_tournament_id;
          RETURN v_seats;
        END IF;
        RETURN NULL;
      END IF;

      SELECT count(*) INTO v_seats
        FROM public.table_seats
       WHERE table_id = v_table AND left_at IS NULL;

      UPDATE public.tables SET current_players = v_seats WHERE id = v_table;

      IF COALESCE(v_seat_first, false) THEN
        UPDATE public.tournaments SET current_players = v_seats WHERE id = p_tournament_id;
      END IF;

      RETURN v_seats;

    EXCEPTION
      WHEN deadlock_detected OR lock_not_available THEN
        -- Idempotent by construction: every value above is recomputed from a
        -- COUNT(*), so a re-attempt cannot double-count. Give up after three
        -- tries and leave it to the every-minute denormal sweep, which is
        -- exactly the behaviour that existed before this retry was added.
        IF v_attempt >= 3 THEN
          RAISE;
        END IF;
        PERFORM pg_sleep(0.05 * v_attempt);
    END;
  END LOOP;
END;
$fn$;

DO $$
DECLARE v_src text; v_res integer; v_t uuid;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_sync_seat_first_player_count';

  IF v_src NOT ILIKE '%deadlock_detected%' THEN
    RAISE EXCEPTION 'post-apply: retry handler is not present';
  END IF;
  IF v_src NOT ILIKE '%v_attempt >= 3%' THEN
    RAISE EXCEPTION 'post-apply: attempt cap is not present';
  END IF;

  -- Behavioural check against a real live seat-first tournament, if one exists.
  SELECT id INTO v_t FROM public.tournaments
   WHERE tournament_type IN ('SNG','SPIN') AND status IN ('REGISTERING','RUNNING')
   LIMIT 1;

  IF v_t IS NOT NULL THEN
    v_res := public.fn_sync_seat_first_player_count(v_t);
    IF v_res IS NULL THEN
      RAISE NOTICE 'post-apply: sync returned NULL for % (no primary table, non seat-first)', v_t;
    ELSE
      RAISE NOTICE 'post-apply: sync returned % seats for %', v_res, v_t;
    END IF;
  ELSE
    RAISE NOTICE 'post-apply: no live seat-first tournament to probe';
  END IF;
END $$;

-- ROLLBACK: re-install the pre-retry body (identical logic, no retry loop).
--   CREATE OR REPLACE FUNCTION public.fn_sync_seat_first_player_count(p_tournament_id uuid)
--   RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
--   SET search_path TO 'public','pg_temp' AS $rb$
--   DECLARE v_table uuid; v_seats integer := 0; v_seat_first boolean := false;
--   BEGIN
--     SELECT (COALESCE(t.variant,'') IN ('spin','sng') OR COALESCE(t.max_players,0) <= 2)
--       INTO v_seat_first FROM public.tournaments t WHERE t.id = p_tournament_id;
--     v_table := public.fn_tournament_primary_table(p_tournament_id);
--     IF v_table IS NULL THEN
--       IF COALESCE(v_seat_first,false) THEN
--         SELECT count(*) INTO v_seats FROM public.table_seats s
--           JOIN public.tables tb ON tb.id = s.table_id
--          WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL;
--         UPDATE public.tournaments SET current_players = v_seats WHERE id = p_tournament_id;
--         RETURN v_seats;
--       END IF;
--       RETURN NULL;
--     END IF;
--     SELECT count(*) INTO v_seats FROM public.table_seats
--      WHERE table_id = v_table AND left_at IS NULL;
--     UPDATE public.tables SET current_players = v_seats WHERE id = v_table;
--     IF COALESCE(v_seat_first,false) THEN
--       UPDATE public.tournaments SET current_players = v_seats WHERE id = p_tournament_id;
--     END IF;
--     RETURN v_seats;
--   END; $rb$;

-- Definer Authorization: NOT a change. Restated here only because
-- scripts/ci/check-definer-authorization.mjs models grants from the migration
-- file alone, starting at the Postgres default where PUBLIC holds EXECUTE.
-- CREATE OR REPLACE does not reset an ACL, so the applied migration above did
-- not need these two lines and production already reads
-- {postgres=X/postgres,service_role=X/postgres}: no browser role can call it.
-- Both statements are therefore no-ops against the live schema. They are the
-- gate's own remedy 1, copied verbatim from 20260830110000, the previous
-- migration for this same function.
REVOKE ALL ON FUNCTION public.fn_sync_seat_first_player_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_seat_first_player_count(uuid) TO service_role;
