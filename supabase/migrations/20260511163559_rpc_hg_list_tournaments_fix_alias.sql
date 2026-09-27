-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260511163559 "rpc_hg_list_tournaments_fix_alias"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ebbae406ca808bfbfcbd5ac62dd90676 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.rpc_hg_list_tournaments(
  p_group_id     uuid,
  p_include_past boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.fn_home_is_group_staff(v_caller, p_group_id) THEN
    RAISE EXCEPTION 'NOT_GROUP_STAFF';
  END IF;

  SELECT COALESCE(jsonb_agg(sub.j ORDER BY sub.scheduled_date, sub.start_time), '[]'::jsonb) INTO v_result
  FROM (
    SELECT
      jsonb_build_object(
        'id', g.id,
        'group_id', g.group_id,
        'name', g.title,
        'description', g.description,
        'buy_in', g.buyin_min,
        'starting_stack', g.starting_stack,
        'structure', g.structure,
        'scheduled_date', g.scheduled_date,
        'start_time', g.start_time,
        'entries_cap', g.max_players,
        'status', g.status,
        'rsvp_yes', g.rsvp_yes,
        'rsvp_maybe', g.rsvp_maybe,
        'created_at', g.created_at,
        'cancelled_at', g.cancelled_at,
        'cancellation_reason', g.cancellation_reason,
        'scheduled_at_iso',
          (g.scheduled_date::text || 'T' || to_char(g.start_time, 'HH24:MI:SS') || 'Z')
      ) AS j,
      g.scheduled_date,
      g.start_time
    FROM commander_home_games g
    WHERE g.group_id = p_group_id
      AND g.format = 'tournament'
      AND (p_include_past OR g.scheduled_date >= CURRENT_DATE)
  ) sub;

  RETURN v_result;
END;
$$;
