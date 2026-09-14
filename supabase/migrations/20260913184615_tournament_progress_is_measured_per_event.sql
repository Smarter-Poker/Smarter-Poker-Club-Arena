-- MTT managers can renew leases while every table in their event is silent.
-- September 13: 84 RUNNING MTTs had no hand for 30 minutes while cash games
-- continued and 509 manager leases renewed. Existing whole-fleet metrics missed
-- that state. This read-only aggregate measures each event independently.
--
-- The 15-minute hand window is above the measured seven-day maximum completed
-- tournament hand (214.389s; p99 80.146s, 2,101,203 hands), and ordinary five-
-- minute breaks. The alert also suppresses active/recent maintenance. Breaks
-- have a separate ten-minute overdue allowance, including an add-on's deadline.
-- The equivalent live query scanned 84 MTTs in 66.167ms using the existing
-- idx_tournaments_status_start_time and idx_hand_history_tournament_created.
-- No scan of all historical hands, event identifiers, names or balances escape.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_tournament_progress_metrics(
  p_stalled_minutes integer DEFAULT 15,
  p_break_grace_minutes integer DEFAULT 10
)
RETURNS TABLE(stalled_running integer, overdue_breaks integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO public, pg_temp
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
        -- A recently completed add-on is a legitimate interval without hands.
        AND COALESCE(t.addon_period_ends_at,'-infinity'::timestamptz) < b.hand_cutoff
        AND NOT EXISTS (
          SELECT 1 FROM public.hand_history h
           WHERE h.tournament_id=t.id AND h.created_at>b.hand_cutoff
        )
    )::integer,
    count(*) FILTER (
      WHERE COALESCE(t.on_break,false)
        -- A missing end timestamp is the pre-countdown state, not an unlimited
        -- exemption. Give it the normal five-minute break plus the grace.
        AND GREATEST(
          COALESCE(t.break_ends_at,
                   t.break_started_at + interval '5 minutes',
                   COALESCE(t.started_at,t.start_time,t.created_at) + interval '5 minutes'),
          COALESCE(t.addon_period_ends_at,'-infinity'::timestamptz)
        ) < b.break_cutoff
    )::integer
  FROM public.tournaments t CROSS JOIN bounds b
  WHERE t.status='RUNNING'
    AND upper(COALESCE(t.tournament_type,'')) IN ('MTT','SATELLITE')
    -- Heads-up satellites use the seat-first product, not the scheduled MTT.
    AND COALESCE(t.max_players,0)>2
    AND COALESCE(t.started_at,t.start_time,t.created_at)<b.hand_cutoff;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_progress_metrics(integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_progress_metrics(integer,integer)
  TO service_role;

COMMIT;
