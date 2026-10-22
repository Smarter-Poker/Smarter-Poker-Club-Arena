CREATE OR REPLACE FUNCTION public.fn_unaccounted_seat_exits(p_since interval DEFAULT '7 days'::interval, p_grace interval DEFAULT '00:10:00'::interval)
 RETURNS TABLE(exit_id bigint, occurred_at timestamp with time zone, user_id uuid, table_id uuid, club_id uuid, stack numeric, exit_kind text, db_role text, app_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- MATERIALIZED on purpose. Inlined, the planner is free to re-run this once
  -- per candidate row, which is the sequential scan this migration exists to
  -- delete. There are ~1,040 rows in here; collecting them once is the point.
  with corrected as materialized (
    select distinct
           nullif(substring(wt.description from 'Correction: seat exit ([0-9]+)'), '')::bigint as exit_id
      from public.wallet_transactions wt
     where wt.type = 'credit'
       and wt.description like 'Correction: seat exit %'
  )
  SELECT e.id, e.occurred_at, e.user_id, e.table_id, e.club_id,
         e.stack, e.exit_kind, e.db_role, e.app_name
  FROM public.ca_seat_stack_exits e
  WHERE e.occurred_at >= now() - p_since
    AND e.occurred_at <= now() - p_grace
    AND NOT EXISTS (
      SELECT 1 FROM public.tables t
       WHERE t.id = e.table_id AND t.tournament_id IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.wallet_transactions wt
       WHERE wt.user_id = e.user_id
         AND wt.type = 'credit'
         AND wt.created_at BETWEEN e.occurred_at - GREATEST(p_grace, interval '15 minutes')
                               AND e.occurred_at + p_grace
         AND wt.amount >= e.stack - 0.01
    )
    -- Was an unindexable per-row ILIKE on a concatenated prefix. Same
    -- intention, asked once, and it cannot forgive exit 5 for a correction
    -- written to exit 51.
    AND NOT EXISTS (
      SELECT 1 FROM corrected c WHERE c.exit_id = e.id
    )
  ORDER BY e.occurred_at DESC;
$function$;
