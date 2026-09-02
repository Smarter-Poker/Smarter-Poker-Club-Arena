-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826151310; the .sql file was never committed at the
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
  ORDER BY e.occurred_at DESC;
$function$;

DO $$
DECLARE
  v_false_positive_cleared boolean;
  v_real_still_flagged     boolean;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM public.fn_unaccounted_seat_exits('7 days','10 minutes') WHERE exit_id = 6522)
    INTO v_false_positive_cleared;
  SELECT EXISTS (SELECT 1 FROM public.fn_unaccounted_seat_exits('7 days','10 minutes') WHERE exit_id = 7458)
    INTO v_real_still_flagged;

  IF NOT v_false_positive_cleared THEN
    RAISE EXCEPTION 'assertion failed: exit 6522 (refunded 85.85 at 09:33:33) is still flagged';
  END IF;

  IF NOT v_real_still_flagged
     AND NOT EXISTS (
       SELECT 1 FROM public.wallet_transactions wt
        WHERE wt.user_id = 'a916c222-1eb9-4e73-89ee-a92e289b80eb'
          AND wt.type = 'credit' AND wt.amount >= 44.99
          AND wt.created_at BETWEEN '2026-08-26 12:40:00+00' AND '2026-08-26 13:11:00+00')
  THEN
    RAISE EXCEPTION 'assertion failed: exit 7458 (real 25.90 shortfall) was masked by this change';
  END IF;

  RAISE NOTICE 'fn_unaccounted_seat_exits: false positive cleared, real shortfall retained';
END $$;
