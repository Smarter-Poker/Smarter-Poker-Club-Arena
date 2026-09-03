-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826175347; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_unaccounted_seat_exits(
  p_since interval DEFAULT '7 days'::interval,
  p_grace interval DEFAULT '00:10:00'::interval
)
RETURNS TABLE(
  exit_id bigint, occurred_at timestamp with time zone, user_id uuid,
  table_id uuid, club_id uuid, stack numeric, exit_kind text,
  db_role text, app_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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
    AND NOT EXISTS (
      SELECT 1 FROM public.wallet_transactions wt
       WHERE wt.user_id = e.user_id
         AND wt.type = 'credit'
         AND wt.description ILIKE 'Correction: seat exit ' || e.id || '%'
    )
  ORDER BY e.occurred_at DESC;
$function$;

DO $$
DECLARE v_left int; v_ids text;
BEGIN
  SELECT count(*), coalesce(string_agg(exit_id::text, ','), 'none')
    INTO v_left, v_ids
    FROM public.fn_unaccounted_seat_exits('7 days','10 minutes');

  IF EXISTS (SELECT 1 FROM public.fn_unaccounted_seat_exits('7 days','10 minutes') WHERE exit_id = 7458) THEN
    RAISE EXCEPTION 'assertion failed: exit 7458 was repaid but is still flagged';
  END IF;

  RAISE NOTICE 'fn_unaccounted_seat_exits: % unaccounted exit(s) remain (%)', v_left, v_ids;
END $$;
