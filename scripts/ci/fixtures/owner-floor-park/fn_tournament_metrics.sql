CREATE OR REPLACE FUNCTION public.fn_tournament_metrics(p_overdue_minutes integer DEFAULT 10, p_completing_minutes integer DEFAULT 10, p_unpaid_hours integer DEFAULT 6)
 RETURNS TABLE(running integer, registering integer, overdue_start integer, stuck_completing integer, seatless_phantoms integer, unpaid_completed integer, seat_first_waiting integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    -- UNPAID means nothing of value reached anybody on ANY rail: no chip
    -- prize, no Diamond prize, and no satellite award delivered. A new rail
    -- that delivers prize-pool value must be added here, or every event it
    -- pays will read as unpaid and page the owner (2026-10-09: the Diamond
    -- rail was missing). The Diamond probe rides
    -- poker_diamond_tournament_ledger_tournament_idx (tournament_id, kind);
    -- the awards probe rides the primary key (tournament_id, place).
    (SELECT count(*) FROM tournaments t
      WHERE t.status = 'COMPLETED'
        AND t.ended_at > now() - make_interval(hours => GREATEST(p_unpaid_hours, 0))
        AND COALESCE(t.prize_pool, 0) > 0
        AND NOT EXISTS (
          SELECT 1 FROM wallet_transactions w
           WHERE w.related_entity_id = t.id AND w.category = 'prize')
        AND NOT EXISTS (
          SELECT 1 FROM poker_diamond_tournament_ledger d
           WHERE d.tournament_id = t.id
             AND d.kind = 'prize'
             AND d.wallet_journal_id IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM tournament_satellite_awards a
           WHERE a.tournament_id = t.id))::int,
    (SELECT count(*) FROM tournaments
      WHERE status IN ('REGISTERING','ANNOUNCED')
        AND tournament_type <> 'MTT'
        AND start_time < now() - make_interval(mins => GREATEST(p_overdue_minutes, 0)))::int;
$function$
