-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820190916 "downline_summary_single_pass"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d2df202cc0f4057b011ee134044b2efc of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The summary called fn_agent_downline_rake twice: once with limit 100000 for
-- the aggregates, and again with limit 1 for the top earner. Two full passes
-- for one header. The page loads rows and summary together, so that was three
-- executions per refresh — on a view that refreshes as hands are played.
-- One pass now, with the top earner derived from the same result.

CREATE OR REPLACE FUNCTION public.fn_agent_downline_rake_summary(
  p_agent_user_id uuid DEFAULT NULL,
  p_club_id       uuid DEFAULT NULL,
  p_since         timestamptz DEFAULT NULL,
  p_until         timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_root uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from timestamptz := COALESCE(p_since, date_trunc('week', now()));
  v_to   timestamptz := COALESCE(p_until, now());
  v_rate numeric;
  v_out  jsonb;
BEGIN
  SELECT a.commission_rate INTO v_rate
    FROM agents a
   WHERE a.user_id = v_root AND a.status='active'
     AND (p_club_id IS NULL OR a.club_id = p_club_id)
   ORDER BY a.commission_rate DESC NULLS LAST
   LIMIT 1;

  WITH d AS MATERIALIZED (
    SELECT * FROM public.fn_agent_downline_rake(v_root, p_club_id, v_from, v_to, NULL, 100000)
  ),
  top AS (
    SELECT username, rake_generated FROM d ORDER BY rake_generated DESC LIMIT 1
  )
  SELECT jsonb_build_object(
           'period_start', v_from,
           'period_end',   v_to,
           'members',      (SELECT count(*) FROM d),
           'active',       (SELECT count(*) FROM d WHERE hands > 0),
           'direct',       (SELECT count(*) FROM d WHERE depth = 1),
           'sub_agents',   (SELECT count(*) FROM d
                             WHERE role IN ('agent','sub_agent','super_agent')),
           'hands',        (SELECT COALESCE(SUM(hands),0) FROM d),
           'rake_generated', (SELECT COALESCE(ROUND(SUM(rake_generated),2),0) FROM d),
           'commission_rate', COALESCE(v_rate, 0),
           'estimated_commission',
             (SELECT COALESCE(ROUND(SUM(rake_generated) * COALESCE(v_rate,0), 2), 0) FROM d),
           'last_hand_at', (SELECT MAX(last_hand_at) FROM d),
           'top_earner', (SELECT jsonb_build_object('username', username, 'rake', rake_generated)
                            FROM top)
         )
    INTO v_out;

  RETURN COALESCE(v_out, jsonb_build_object('members', 0, 'rake_generated', 0));
END $$;
