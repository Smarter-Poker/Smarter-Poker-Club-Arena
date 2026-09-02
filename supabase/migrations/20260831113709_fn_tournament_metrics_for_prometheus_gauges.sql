-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831113709; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- MTT Phase 2 (observability). One grouped read behind the engine's /metrics
-- tournament gauges. Before this the exposition carried 895 poker_* series and
-- none of them mentioned a tournament, so no tournament alert rule could be
-- written at all — every tournament defect in the 2026-08-30/31 audit was found
-- by a human running SQL by hand.
--
-- STABLE, not VOLATILE: it only reads. SECURITY DEFINER so the engine's role
-- needs no direct grants on the four tables, and search_path is pinned so the
-- definer cannot be tricked by a caller-supplied path.
CREATE OR REPLACE FUNCTION public.fn_tournament_metrics(
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
  unpaid_completed   integer
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
           WHERE w.related_entity_id = t.id AND w.category = 'prize'))::int;
$$;

REVOKE ALL ON FUNCTION public.fn_tournament_metrics(integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_tournament_metrics(integer, integer, integer)
  TO service_role, authenticated;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fn_tournament_metrics(10, 10, 6);
  IF r.running IS NULL OR r.registering IS NULL OR r.unpaid_completed IS NULL THEN
    RAISE EXCEPTION 'fn_tournament_metrics returned NULLs — the gauges would read as zero';
  END IF;
  RAISE NOTICE 'fn_tournament_metrics OK: running=% registering=% overdue=% completing=% phantoms=% unpaid=%',
    r.running, r.registering, r.overdue_start, r.stuck_completing, r.seatless_phantoms, r.unpaid_completed;
END $$;
