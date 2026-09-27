-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820175822 "union_integrity_sweep_all_unions"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2a421b94012d745be8a1ed255e9723dd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The hourly integrity sweep ran as fn_union_integrity_sweep(), whose union_id
-- argument defaults to Midway. With one union that is correct by accident; the
-- moment a second union exists it is monitored by nothing, silently. Same shape
-- of bug as the weekly cron only paying Round 1.

CREATE OR REPLACE FUNCTION public.fn_union_integrity_sweep_all(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  u record; v_one jsonb; v_signals int := 0; v_unions int := 0; v_failed int := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR u IN SELECT id FROM unions LOOP
    BEGIN
      v_one := public.fn_union_integrity_sweep(u.id, p_hours);
      v_signals := v_signals + COALESCE((v_one->>'signals')::int, 0);
      v_unions := v_unions + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('unions_swept', v_unions, 'unions_failed', v_failed,
                            'signals', v_signals, 'window_hours', p_hours, 'ran_at', now());
END $$;

REVOKE ALL ON FUNCTION public.fn_union_integrity_sweep_all(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_union_integrity_sweep_all(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_union_integrity_sweep_all(integer) TO service_role;
