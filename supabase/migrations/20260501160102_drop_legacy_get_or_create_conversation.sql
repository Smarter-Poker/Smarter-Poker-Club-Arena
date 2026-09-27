-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260501160102 "drop_legacy_get_or_create_conversation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2829915c0f28ea9a45b37bf94cb00069 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

DO $$
DECLARE
    v_legacy_count integer;
    v_canonical_count integer;
BEGIN
    SELECT COUNT(*) INTO v_legacy_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'fn_get_or_create_conversation'
      AND pg_get_function_arguments(p.oid) = 'user1_id uuid, user2_id uuid';

    SELECT COUNT(*) INTO v_canonical_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'fn_get_or_create_conversation'
      AND pg_get_function_result(p.oid) = 'jsonb';

    IF v_legacy_count = 0 THEN
        RAISE EXCEPTION 'pre-flight failed: legacy overload not found';
    END IF;
    IF v_canonical_count = 0 THEN
        RAISE EXCEPTION 'pre-flight failed: canonical jsonb overload not found';
    END IF;
END $$;

DROP FUNCTION IF EXISTS public.fn_get_or_create_conversation(uuid, uuid);

DO $$
DECLARE
    v_total integer;
    v_canonical_still_there boolean;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_get_or_create_conversation';

    SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'fn_get_or_create_conversation'
          AND pg_get_function_result(p.oid) = 'jsonb'
    ) INTO v_canonical_still_there;

    IF v_total <> 1 THEN
        RAISE EXCEPTION 'post-apply assertion failed: expected exactly 1 overload, found %', v_total;
    END IF;
    IF NOT v_canonical_still_there THEN
        RAISE EXCEPTION 'post-apply assertion failed: canonical jsonb overload was dropped by mistake';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
