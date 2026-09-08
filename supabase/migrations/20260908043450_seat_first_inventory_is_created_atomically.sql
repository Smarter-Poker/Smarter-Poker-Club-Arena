-- Root retirement for the timer-driven seat-first repair path.
--
-- Migration 20260908043250 makes tournament plus table creation one database
-- transaction. Do not apply this contract step with the rolling Stage-A
-- expand: the protocol-1 engine still invokes the historical repair RPC. Once
-- the exact protocol-2 engine is the sole live build, this transaction runs
-- the repair once through its idempotent bounded path, proves that no
-- unjoinable legacy board remains, then removes both the public wrapper and
-- its private predecessor.

BEGIN;

SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '45s';

DO $finish_and_retire_seat_first_repair$
DECLARE
  v_cleanup_result jsonb;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.engine_tournament_leases l
     WHERE l.protocol_version = 1
       AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
  ) THEN
    RAISE EXCEPTION
      'seat-first repair retirement refused: a fresh protocol-1 tournament manager still owns a lease';
  END IF;

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
