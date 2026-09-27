-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820171024 "fix_cascade_all_platform_admin_signature"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8e189160b69a01bbf329d50fffe6cd43 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- fn_is_platform_admin takes NO arguments (it reads auth.uid() itself). Calling
-- it with a uuid raised "function does not exist" at runtime — which, because
-- this only runs from cron at 00:10 on Mondays, would have surfaced as a
-- silently skipped settlement rather than a visible error.

CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade_all(
  p_period_start timestamptz DEFAULT NULL,
  p_period_end   timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_union   record;
  v_one     jsonb;
  v_results jsonb := '[]'::jsonb;
  v_unions  int := 0;
  v_failed  int := 0;
  v_r1 numeric := 0; v_r2 numeric := 0; v_r3 numeric := 0;
BEGIN
  -- Service-role/cron only, or a platform admin. Per-union authorisation is
  -- re-checked inside fn_union_settlement_cascade for each union.
  IF auth.uid() IS NOT NULL AND NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR v_union IN SELECT u.id FROM unions u LOOP
    BEGIN
      v_one := public.fn_union_settlement_cascade(v_union.id, p_period_start, p_period_end);
      v_unions := v_unions + 1;
      v_r1 := v_r1 + COALESCE((v_one->'round1_union_to_clubs'->>'total_rakeback')::numeric, 0);
      v_r2 := v_r2 + COALESCE((v_one->'round2_club_to_agents'->>'amount')::numeric, 0);
      v_r3 := v_r3 + COALESCE((v_one->'round3_agents_to_players'->>'amount')::numeric, 0);
      v_results := v_results || jsonb_build_array(v_one);
    EXCEPTION WHEN OTHERS THEN
      -- One union's settlement must never abort the rest of the platform's.
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'union_id', v_union.id, 'success', false, 'error', SQLERRM));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'unions_settled', v_unions,
    'unions_failed', v_failed,
    'round1_union_to_clubs', v_r1,
    'round2_club_to_agents', v_r2,
    'round3_agents_to_players', v_r3,
    'ran_at', now(),
    'detail', v_results
  );
END $$;

REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade_all(timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade_all(timestamptz,timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_union_settlement_cascade_all(timestamptz,timestamptz) TO service_role;
