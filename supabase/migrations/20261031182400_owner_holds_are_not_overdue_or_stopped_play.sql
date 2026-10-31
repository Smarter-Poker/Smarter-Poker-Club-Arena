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
        AND start_time < now() - make_interval(mins => GREATEST(p_overdue_minutes, 0))
        AND NOT public.fn_ca_operator_floor_park_holds(club_id, union_id)
        AND NOT public.fn_ca_new_tournament_starts_blocked()
        AND NOT EXISTS (SELECT 1 FROM public.ca_diamond_arena_owner_closure c
                         WHERE c.closed AND c.club_id = tournaments.club_id)
        AND (EXISTS (SELECT 1 FROM tournament_players tp
                      WHERE tp.tournament_id = tournaments.id
                        AND tp.status IN ('registered','playing'))
             OR COALESCE(current_players, 0) <> 0
             OR start_time < now() - make_interval(mins => 30 + GREATEST(p_overdue_minutes, 0))))::int,
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_progress_metrics(p_stalled_minutes integer DEFAULT 15, p_break_grace_minutes integer DEFAULT 10)
 RETURNS TABLE(stalled_running integer, overdue_breaks integer, progressing_running integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH bounds AS (
    SELECT statement_timestamp() - make_interval(mins =>
             LEAST(1440, GREATEST(1, COALESCE(p_stalled_minutes,15)))) AS hand_cutoff,
           statement_timestamp() - make_interval(mins =>
             LEAST(1440, GREATEST(1, COALESCE(p_break_grace_minutes,10)))) AS break_cutoff
  )
  SELECT
    count(*) FILTER (
      WHERE NOT COALESCE(t.on_break,false)
        AND COALESCE(t.addon_period_ends_at,'-infinity'::timestamptz) < b.hand_cutoff
        AND NOT EXISTS (
          SELECT 1 FROM public.hand_history h
           WHERE h.tournament_id=t.id AND h.created_at>b.hand_cutoff
        )
    )::integer,
    count(*) FILTER (
      WHERE COALESCE(t.on_break,false)
        AND GREATEST(
          COALESCE(t.break_ends_at,
                   t.break_started_at + interval '5 minutes',
                   COALESCE(t.started_at,t.start_time,t.created_at) + interval '5 minutes'),
          COALESCE(t.addon_period_ends_at,'-infinity'::timestamptz)
        ) < b.break_cutoff
    )::integer,
    count(*) FILTER (
      WHERE NOT COALESCE(t.on_break,false)
        AND COALESCE(t.addon_period_ends_at,'-infinity'::timestamptz) < b.hand_cutoff
        AND EXISTS (
          SELECT 1 FROM public.hand_history h
           WHERE h.tournament_id=t.id AND h.created_at>b.hand_cutoff
        )
    )::integer
  FROM public.tournaments t CROSS JOIN bounds b
  WHERE t.status='RUNNING'
    AND t.format_contract IN ('mtt-v1','mtt-v2')
    AND COALESCE(t.started_at,t.start_time,t.created_at)<b.hand_cutoff
    AND NOT EXISTS (SELECT 1 FROM public.ca_diamond_arena_owner_closure c
                     WHERE c.closed AND c.club_id = t.club_id)
    AND NOT EXISTS (SELECT 1 FROM smarter_private.tournament_abort_targets a
                     WHERE a.tournament_id = t.id AND a.settled_at IS NULL);
$function$;