-- Stats Phase 1 release repair: the shared maintenance route must not spend its
-- entire request budget probing 103k mostly-empty table records. The live
-- club_member_daily_stats ledger already identifies tables with activity, so
-- use that bounded ledger for both maintenance probes.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_cmds_stat_date_table_club
  ON public.club_member_daily_stats (stat_date, table_id, club_id);

CREATE OR REPLACE FUNCTION public.ca_clubs_with_rebuild_backlog(
  p_since timestamptz DEFAULT now() - interval '90 days',
  p_limit integer DEFAULT 10
)
RETURNS TABLE(club_id uuid, tables_pending bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT s.club_id, count(DISTINCT s.table_id)::bigint AS tables_pending
  FROM public.club_member_daily_stats s
  LEFT JOIN public.club_stats_rebuild_log l ON l.table_id = s.table_id
  WHERE s.stat_date >= p_since::date
    AND coalesce(l.complete, false) = false
  GROUP BY s.club_id
  ORDER BY tables_pending DESC
  LIMIT greatest(coalesce(p_limit, 10), 1);
$function$;

CREATE OR REPLACE FUNCTION public.ca_clubs_missing_hand_daily(p_date date)
RETURNS TABLE(club_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT DISTINCT s.club_id
  FROM public.club_member_daily_stats s
  WHERE s.stat_date = p_date
    AND NOT EXISTS (
      SELECT 1
      FROM public.club_hand_daily_shard d
      WHERE d.club_id = s.club_id
        AND d.stat_date = p_date
    );
$function$;

REVOKE ALL ON FUNCTION public.ca_clubs_with_rebuild_backlog(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ca_clubs_missing_hand_daily(date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_clubs_with_rebuild_backlog(timestamptz, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ca_clubs_missing_hand_daily(date)
  TO service_role;

DO $assertions$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'club_member_daily_stats'
      AND indexname = 'idx_cmds_stat_date_table_club'
  ) THEN
    RAISE EXCEPTION 'stats maintenance activity index missing';
  END IF;

  IF pg_get_functiondef('public.ca_clubs_with_rebuild_backlog(timestamptz,integer)'::regprocedure)
       NOT ILIKE '%club_member_daily_stats%' THEN
    RAISE EXCEPTION 'backlog probe still scans the raw hand/table estate';
  END IF;

  IF pg_get_functiondef('public.ca_clubs_missing_hand_daily(date)'::regprocedure)
       NOT ILIKE '%club_hand_daily_shard%' THEN
    RAISE EXCEPTION 'daily rollup probe still expands the aggregate view';
  END IF;
END;
$assertions$;

COMMIT;
