-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902050631; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  WHY THE WHEEL DOES NOT PLAY WHEN THE LAST BUY-IN IS PAID
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan's rule is that the animation plays one second after the last buy-in, up
-- to three. It has been taking eleven to twenty-four. This is the reason, and
-- it is not the draw, the settle, or the animation.
--
-- `GameServer.discoverSeatFirstStarts` is the loop that notices a full board.
-- It calls itself a one-second poll (SEAT_FIRST_START_INTERVAL = 1000). Each
-- pass makes THREE sequential PostgREST round trips, measured on production
-- through the same path the engine uses:
--
--   1. REGISTERING seat-first tournaments ............  0.475 s   (85 boards)
--   2. their live tables, .in(tournament_id, 85 uuids)   4.029 s   <-- the hog
--   3. their live seats, .in(table_id, ...) ..........  0.944 s
--                                                      -------
--                                            per pass   5.448 s
--
-- So the real cadence is about six and a half seconds, not one, and a board
-- that fills the instant after a pass waits a whole cycle before anything
-- notices. Four Spins observed filling within seconds of each other at
-- 05:02:2x-05:02:5x drew at 05:03:16 through 05:03:24 - a queue, not a
-- coincidence.
--
-- The three round trips are one question: WHICH SEAT-FIRST BOARDS HAVE ALL
-- THEIR SEATS PAID FOR? Asked once, in the database, against indexes that
-- already exist, the same answer costs:
--
--   Execution Time: 76.013 ms
--
-- Seventy-six milliseconds against five and a half seconds, for identical
-- output. The middle query was never slow because the database was slow - it
-- was slow because eighty-five UUIDs were shipped out and matched back in the
-- client.
--
-- This function is the whole pass. The engine change that calls it is a
-- separate commit; until it deploys, nothing here is on the hot path, and
-- applying it now costs nothing and breaks nothing.
--
-- NOT SECURITY DEFINER on purpose: the engine reads as service_role, which is
-- already past RLS, so this needs no elevation and answers no browser.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_seat_first_boards_ready();

CREATE OR REPLACE FUNCTION public.fn_seat_first_boards_ready()
RETURNS TABLE(
  id uuid,
  name text,
  max_players integer,
  variant text,
  start_time timestamptz,
  paid_seats integer
)
LANGUAGE sql
STABLE
AS $function$
  SELECT t.id, t.name, t.max_players, t.variant, t.start_time,
         COALESCE(s.paid, 0)::int AS paid_seats
  FROM public.tournaments t
  LEFT JOIN LATERAL (
    SELECT count(*) AS paid
    FROM public.tables tb
    JOIN public.table_seats ts
      ON ts.table_id = tb.id AND ts.left_at IS NULL
    WHERE tb.tournament_id = t.id
      AND tb.status <> 'closed'
  ) s ON true
  WHERE t.status = 'REGISTERING'
    AND (t.variant = 'spin' OR (t.variant = 'sng' AND t.max_players <= 2));
$function$;

REVOKE ALL ON FUNCTION public.fn_seat_first_boards_ready() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_seat_first_boards_ready() TO service_role;

COMMENT ON FUNCTION public.fn_seat_first_boards_ready() IS
  'Which seat-first boards have all their seats paid for, in ONE call. Replaces '
  'three sequential PostgREST round trips in GameServer.discoverSeatFirstStarts '
  'that measured 5.448 s per pass against 76 ms here, which is why a Spin that '
  'filled took eleven to twenty-four seconds to reach its wheel.';

DO $$
DECLARE v_rows int; v_t0 timestamptz; v_ms numeric; v_bad int;
BEGIN
  v_t0 := clock_timestamp();
  SELECT count(*) INTO v_rows FROM public.fn_seat_first_boards_ready();
  v_ms := round(extract(epoch FROM clock_timestamp() - v_t0)::numeric * 1000, 1);

  -- It must answer the same question the loop asked: never more paid seats
  -- than the board sells, and never a board that is not seat-first.
  SELECT count(*) INTO v_bad FROM public.fn_seat_first_boards_ready() r
   WHERE r.paid_seats > r.max_players
      OR NOT (r.variant = 'spin' OR (r.variant = 'sng' AND r.max_players <= 2));
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% row(s) contradict the seat-first definition', v_bad;
  END IF;

  IF has_function_privilege('anon', 'public.fn_seat_first_boards_ready()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_seat_first_boards_ready()', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_seat_first_boards_ready is reachable from a browser role';
  END IF;

  RAISE NOTICE 'seat-first board sweep: % boards in % ms', v_rows, v_ms;
END $$;
