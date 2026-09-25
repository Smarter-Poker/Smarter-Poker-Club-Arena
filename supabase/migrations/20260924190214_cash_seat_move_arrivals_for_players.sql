-- 20260924190214_cash_seat_move_arrivals_for_players.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- ONE QUESTION FOR EVERY CASH SEAT MOVE ARRIVAL (2026-09-24).
--
-- The legacy engine checkpoint proves, before it writes anything, that a time
-- bank the predecessor holds for a player it no longer seats is residue and
-- not custody. Part of that proof asks whether a CASH SEAT MOVE landed in any
-- open seat that player now holds elsewhere, and it asked through
-- fn_cash_seat_move_arrivals(p_table_id, p_occupancy_ids): one call per
-- destination table. Measured at the 18:55 UTC break (release run
-- 36042895085, Supabase edge logs): 767 such calls between 18:55:11.975 and
-- 18:55:24.755, eight at a time, 13 seconds of the publisher's 20-second work
-- budget, and the checkpoint ended as "inspector operation outcome unknown"
-- with its progress record stopped inside that proof. The database side of
-- each call is under 10 ms; the cost is 767 round trips.
--
-- This is the same question asked once, set-based: every receipt whose player
-- is one of the residue players and whose destination seat is still open. The
-- caller filters to the exact (table, occupancy) pairs it holds no bank for,
-- so the answer set is identical to the union of the per-table answers. Same
-- join, same ENGINE_ONLY gate, same SECURITY DEFINER shape as the per-table
-- function it stands beside; the per-table function is left as it is for
-- every other caller.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_arrivals_for_players(p_player_ids uuid[])
RETURNS TABLE(
  move_id uuid,
  player_id uuid,
  from_table_id uuid,
  to_table_id uuid,
  source_occupancy_id uuid,
  destination_occupancy_id uuid
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT coalesce(public.fn_caller_is_engine(), false) THEN
    RAISE EXCEPTION 'ENGINE_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_player_ids IS NULL
     OR cardinality(p_player_ids) = 0
     OR cardinality(p_player_ids) > 500
     OR array_position(p_player_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_SEAT_MOVE_ARRIVAL_SCOPE' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT r.move_id, r.player_id, r.from_table_id, r.to_table_id,
           r.source_occupancy_id, r.destination_occupancy_id
      FROM public.cash_seat_move_receipts r
      JOIN public.table_seats s
        ON s.occupancy_id = r.destination_occupancy_id
       AND s.user_id = r.player_id AND s.table_id = r.to_table_id
       AND s.left_at IS NULL
     WHERE r.player_id = ANY(p_player_ids);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_cash_seat_move_arrivals_for_players(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_move_arrivals_for_players(uuid[]) TO service_role;

COMMENT ON FUNCTION public.fn_cash_seat_move_arrivals_for_players(uuid[]) IS
  'Legacy engine checkpoint: every cash seat move receipt for these players whose destination seat is still open, in one call. ENGINE_ONLY. The per-table fn_cash_seat_move_arrivals is unchanged.';

COMMIT;
