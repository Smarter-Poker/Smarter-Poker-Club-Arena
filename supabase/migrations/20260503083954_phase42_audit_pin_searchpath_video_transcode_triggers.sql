-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503083954 "phase42_audit_pin_searchpath_video_transcode_triggers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1fcb2159587b41496dfaedb6fd04e6aa of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Pin search_path on 2 trigger functions added by parallel session's
-- video pipeline work that the Supabase advisor flagged as
-- function_search_path_mutable. Both are SECURITY INVOKER (not DEFINER),
-- so the practical risk is low, but pinning aligns with advisor's
-- recommended hardening posture.
ALTER FUNCTION public.fn_queue_video_transcode() SET search_path = '';
ALTER FUNCTION public.fn_video_transcode_jobs_touch_updated_at() SET search_path = '';

DO $$ DECLARE v_remaining integer;
BEGIN
    SELECT COUNT(*) INTO v_remaining
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public'
      AND p.proname IN ('fn_queue_video_transcode', 'fn_video_transcode_jobs_touch_updated_at')
      AND (p.proconfig IS NULL OR NOT (array_to_string(p.proconfig, ',') LIKE '%search_path=%'));
    IF v_remaining > 0 THEN
        RAISE EXCEPTION 'Post-apply: % functions still missing search_path', v_remaining;
    END IF;
    RAISE NOTICE 'Post-apply: 2 video-pipeline trigger funcs locked';
END $$;
