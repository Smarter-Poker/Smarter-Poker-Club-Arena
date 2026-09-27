-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820182952 "agent_downline_rake_summary"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 944b2c3688146990eb844158670569f9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Header totals for the live rake view. Reuses fn_agent_downline_rake so the
-- summary can never disagree with the rows underneath it, and inherits the
-- same role gate and ancestry check.

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
  -- The agent's own commission rate, so the view can show what the rake is
  -- actually worth to them rather than just the gross figure.
  SELECT a.commission_rate INTO v_rate
    FROM agents a
   WHERE a.user_id = v_root AND a.status='active'
     AND (p_club_id IS NULL OR a.club_id = p_club_id)
   ORDER BY a.commission_rate DESC NULLS LAST
   LIMIT 1;

  SELECT jsonb_build_object(
           'period_start', v_from,
           'period_end',   v_to,
           'members',      count(*),
           'active',       count(*) FILTER (WHERE d.hands > 0),
           'direct',       count(*) FILTER (WHERE d.depth = 1),
           'sub_agents',   count(*) FILTER (WHERE d.role IN ('agent','sub_agent','super_agent')),
           'hands',        COALESCE(SUM(d.hands), 0),
           'rake_generated', COALESCE(ROUND(SUM(d.rake_generated), 2), 0),
           'commission_rate', COALESCE(v_rate, 0),
           'estimated_commission',
             COALESCE(ROUND(SUM(d.rake_generated) * COALESCE(v_rate, 0), 2), 0),
           'last_hand_at', MAX(d.last_hand_at),
           'top_earner', (
             SELECT jsonb_build_object('username', t.username, 'rake', t.rake_generated)
               FROM public.fn_agent_downline_rake(v_root, p_club_id, v_from, v_to, NULL, 1) t
              LIMIT 1)
         )
    INTO v_out
    FROM public.fn_agent_downline_rake(v_root, p_club_id, v_from, v_to, NULL, 100000) d;

  RETURN COALESCE(v_out, jsonb_build_object('members', 0, 'rake_generated', 0));
END $$;

REVOKE ALL ON FUNCTION public.fn_agent_downline_rake_summary(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_agent_downline_rake_summary(uuid,uuid,timestamptz,timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_downline_rake_summary(uuid,uuid,timestamptz,timestamptz) TO authenticated, service_role;
