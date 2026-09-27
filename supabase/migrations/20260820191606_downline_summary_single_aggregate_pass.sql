-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820191606 "downline_summary_single_aggregate_pass"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e85dc5a1d6afaca170ba2c9effbb975b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Even with `WITH d AS MATERIALIZED (SELECT * FROM fn(...))`, the eight
-- separate scalar subqueries over `d` were re-executing the set-returning
-- function: the rows call measured 71ms while the summary built on top of it
-- measured 4,070ms. Read it once into a temp result and aggregate in a single
-- pass, so the header costs the same as the table it sits above.

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
  v_members int := 0; v_active int := 0; v_direct int := 0; v_subs int := 0;
  v_hands bigint := 0; v_rake numeric := 0; v_last timestamptz;
  v_top_name text; v_top_rake numeric;
BEGIN
  SELECT a.commission_rate INTO v_rate
    FROM agents a
   WHERE a.user_id = v_root AND a.status='active'
     AND (p_club_id IS NULL OR a.club_id = p_club_id)
   ORDER BY a.commission_rate DESC NULLS LAST
   LIMIT 1;

  -- One execution, one pass.
  SELECT count(*),
         count(*) FILTER (WHERE d.hands > 0),
         count(*) FILTER (WHERE d.depth = 1),
         count(*) FILTER (WHERE d.role IN ('agent','sub_agent','super_agent')),
         COALESCE(SUM(d.hands), 0),
         COALESCE(ROUND(SUM(d.rake_generated), 2), 0),
         MAX(d.last_hand_at),
         (array_agg(d.username     ORDER BY d.rake_generated DESC))[1],
         (array_agg(d.rake_generated ORDER BY d.rake_generated DESC))[1]
    INTO v_members, v_active, v_direct, v_subs, v_hands, v_rake, v_last,
         v_top_name, v_top_rake
    FROM public.fn_agent_downline_rake(v_root, p_club_id, v_from, v_to, NULL, 100000) d;

  RETURN jsonb_build_object(
    'period_start', v_from,
    'period_end',   v_to,
    'members',      v_members,
    'active',       v_active,
    'direct',       v_direct,
    'sub_agents',   v_subs,
    'hands',        v_hands,
    'rake_generated', v_rake,
    'commission_rate', COALESCE(v_rate, 0),
    'estimated_commission', ROUND(v_rake * COALESCE(v_rate, 0), 2),
    'last_hand_at', v_last,
    'top_earner', CASE WHEN v_top_name IS NULL THEN NULL
                       ELSE jsonb_build_object('username', v_top_name, 'rake', v_top_rake) END
  );
END $$;
