-- Root retirement for the timer-driven seat-first repair path.
--
-- Migration 20260908043250 makes tournament plus table creation one database
-- transaction. Once the engine is drained for this release, the historical
-- repair RPC has no legitimate future writer. This transaction runs it once
-- through its idempotent bounded path, proves that no unjoinable legacy board
-- remains, then removes both the public wrapper and its private predecessor.

BEGIN;

SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '45s';

DO $finish_and_retire_seat_first_repair$
DECLARE
  v_cleanup_result jsonb;
BEGIN
  IF to_regprocedure(
       'public.fn_create_seat_first_game_atomic(uuid,jsonb)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'seat-first repair retirement requires the atomic creator first';
  END IF;

  IF to_regprocedure('public.fn_repair_seat_first_games(integer)') IS NOT NULL THEN
    SELECT public.fn_repair_seat_first_games(1000)
      INTO v_cleanup_result;
    RAISE NOTICE 'Final bounded seat-first cleanup result: %', v_cleanup_result;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
     WHERE t.status = 'REGISTERING'
       AND (COALESCE(t.variant, '') = 'spin' OR COALESCE(t.max_players, 0) <= 2)
       AND NOT EXISTS (
         SELECT 1
           FROM public.tables tb
          WHERE tb.tournament_id = t.id
            AND COALESCE(tb.is_deleted, false) = false
            AND tb.status IN ('waiting', 'running')
       )
  ) THEN
    RAISE EXCEPTION
      'seat-first repair retirement refused: an unjoinable legacy listing remains';
  END IF;
END;
$finish_and_retire_seat_first_repair$;

DROP FUNCTION IF EXISTS public.fn_repair_seat_first_games(integer) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_repair_seat_first_games_before_maintenance_gate(integer)
  RESTRICT;

DO $assert_seat_first_repair_retired$
BEGIN
  IF to_regprocedure('public.fn_repair_seat_first_games(integer)') IS NOT NULL
     OR to_regprocedure(
          'public.fn_repair_seat_first_games_before_maintenance_gate(integer)'
        ) IS NOT NULL THEN
    RAISE EXCEPTION 'a legacy seat-first repair door survived retirement';
  END IF;
END;
$assert_seat_first_repair_retired$;

COMMIT;
