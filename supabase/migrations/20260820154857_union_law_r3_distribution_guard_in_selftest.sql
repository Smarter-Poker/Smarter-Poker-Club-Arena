-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820154857 "union_law_r3_distribution_guard_in_selftest"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3a3279a4a6028115c5516055f41cb9cf of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Surface over-distribution in the hierarchy warning set. It is a warning
-- rather than a breach because a legitimate timing skew (commissions accruing
-- from a different point in the period than rakeback) can produce a transient
-- imbalance; a sustained one is a real economic fault worth investigating.
CREATE OR REPLACE FUNCTION public.fn_union_hierarchy_warnings()
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_c jsonb; v_d jsonb; v_out jsonb := '[]'::jsonb;
BEGIN
  v_c := public.fn_union_agent_coverage();

  IF (v_c->>'players_without_agent')::bigint > 0 THEN
    v_out := v_out || jsonb_build_object('check','players_without_agent',
      'count', (v_c->>'players_without_agent')::bigint);
  END IF;
  IF (v_c->>'agents_orphaned')::bigint > 0 THEN
    v_out := v_out || jsonb_build_object('check','agents_without_super_agent',
      'count', (v_c->>'agents_orphaned')::bigint);
  END IF;
  IF (v_c->>'sub_agents_orphaned')::bigint > 0 THEN
    v_out := v_out || jsonb_build_object('check','sub_agents_without_agent',
      'count', (v_c->>'sub_agents_orphaned')::bigint);
  END IF;
  IF (v_c->>'player_rakeback_gap_breaches')::bigint > 0 THEN
    v_out := v_out || jsonb_build_object('check','player_rakeback_exceeds_upline',
      'count', (v_c->>'player_rakeback_gap_breaches')::bigint);
  END IF;
  IF (v_c->>'commission_rates_out_of_policy')::bigint > 0 THEN
    v_out := v_out || jsonb_build_object('check','commission_rate_out_of_policy',
      'count', (v_c->>'commission_rates_out_of_policy')::bigint);
  END IF;

  v_d := public.fn_union_distribution_check();
  IF NOT (v_d->>'healthy')::boolean THEN
    v_out := v_out || jsonb_build_object('check','distribution_exceeds_rake',
      'over_distributed_by', (v_d->>'over_distributed_by')::numeric,
      'rake_collected', (v_d->>'rake_collected')::numeric,
      'total_distributed', (v_d->>'total_distributed')::numeric);
  END IF;

  RETURN v_out;
END $function$;

