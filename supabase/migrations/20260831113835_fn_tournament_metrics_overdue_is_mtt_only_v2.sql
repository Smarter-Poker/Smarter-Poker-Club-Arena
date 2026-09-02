-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831113835; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- OVERDUE MEANS MTT (2026-08-31). The first cut of this counted every
-- REGISTERING/ANNOUNCED row past its start time and read 31 on production —
-- all of them SNG or SPIN with ZERO entrants.
--
-- That is not a fault, it is how a seat-first format works: a Spin or an SNG
-- sits open with a nominal start time and begins when the seats fill, so
-- "past its start time with nobody in it" is its ordinary resting state. An
-- alert wired to that count would have fired on the day it shipped and been
-- muted by the end of the week, which is worse than no alert.
--
-- An MTT is the format where the start time is a promise to the player. It
-- starts on a clock whether or not the field filled, so an MTT still sitting in
-- REGISTERING ten minutes after its start time genuinely means nobody started
-- it — the exact failure that left 19 DEEPSTACK schedules producing nothing for
-- six days with no alarm.
--
-- `seat_first_waiting` keeps the SNG/Spin number visible as information. It is
-- deliberately NOT the thing to alert on.
DROP FUNCTION IF EXISTS public.fn_tournament_metrics(integer, integer, integer);

CREATE FUNCTION public.fn_tournament_metrics(
  p_overdue_minutes    integer DEFAULT 10,
  p_completing_minutes integer DEFAULT 10,
  p_unpaid_hours       integer DEFAULT 6
)
RETURNS TABLE (
  running            integer,
  registering        integer,
  overdue_start      integer,
  stuck_completing   integer,
  seatless_phantoms  integer,
  unpaid_completed   integer,
  seat_first_waiting integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    (SELECT count(*) FROM tournaments WHERE status = 'RUNNING')::int,
    (SELECT count(*) FROM tournaments WHERE status = 'REGISTERING')::int,
    (SELECT count(*) FROM tournaments
      WHERE status IN ('REGISTERING','ANNOUNCED')
        AND tournament_type = 'MTT'
        AND start_time < now() - make_interval(mins => GREATEST(p_overdue_minutes, 0)))::int,
    (SELECT count(*) FROM tournaments
      WHERE status = 'COMPLETING'
        AND updated_at < now() - make_interval(mins => GREATEST(p_completing_minutes, 0)))::int,
    (SELECT count(*) FROM tournament_players tp
       JOIN tournaments t ON t.id = tp.tournament_id AND t.status = 'RUNNING'
      WHERE tp.status = 'playing'
        AND tp.chips > 0
        AND NOT EXISTS (
          SELECT 1 FROM table_seats s
            JOIN tables tb ON tb.id = s.table_id
           WHERE tb.tournament_id = tp.tournament_id
             AND s.user_id = tp.user_id
             AND s.left_at IS NULL))::int,
    (SELECT count(*) FROM tournaments t
      WHERE t.status = 'COMPLETED'
        AND t.ended_at > now() - make_interval(hours => GREATEST(p_unpaid_hours, 0))
        AND COALESCE(t.prize_pool, 0) > 0
        AND NOT EXISTS (
          SELECT 1 FROM wallet_transactions w
           WHERE w.related_entity_id = t.id AND w.category = 'prize'))::int,
    (SELECT count(*) FROM tournaments
      WHERE status IN ('REGISTERING','ANNOUNCED')
        AND tournament_type <> 'MTT'
        AND start_time < now() - make_interval(mins => GREATEST(p_overdue_minutes, 0)))::int;
$$;

REVOKE ALL ON FUNCTION public.fn_tournament_metrics(integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_tournament_metrics(integer, integer, integer)
  TO service_role, authenticated;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fn_tournament_metrics(10, 10, 6);
  IF r.running IS NULL OR r.overdue_start IS NULL OR r.seat_first_waiting IS NULL THEN
    RAISE EXCEPTION 'fn_tournament_metrics returned NULLs — the gauges would read as zero';
  END IF;
  RAISE NOTICE 'fn_tournament_metrics OK: running=% overdue_mtt=% seat_first_waiting=%',
    r.running, r.overdue_start, r.seat_first_waiting;
END $$;
