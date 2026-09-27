-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503082757 "add_signup_audit_check_rpc_2026_05_03e"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 90046a9006258bef60ca5396c106ca9b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- RPC: signup_audit_check(check_name text)
-- ─────────────────────────────────────────────────────────────────────────
-- Backs /api/cron/trigger-audit. The endpoint passes a check_name from a
-- hardcoded allowlist; this function maps to the actual SQL assertion.
--
-- Centralizing the assertions in SQL (instead of letting the handler ship
-- arbitrary SQL) means: (a) we can't have an assertion-injection bug,
-- (b) the assertions are reviewable as data, (c) adding a new assertion
-- requires a migration which leaves an audit trail.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.signup_audit_check(check_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    result boolean;
BEGIN
    CASE check_name
        WHEN 'three_triggers_on_auth_users' THEN
            SELECT count(*) = 3 INTO result
            FROM pg_trigger
            WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal;

        WHEN 'handle_new_user_function_exists_nonempty' THEN
            SELECT length(prosrc) > 1000 INTO result
            FROM pg_proc WHERE proname = 'handle_new_user';

        WHEN 'handle_new_user_logs_to_signup_errors' THEN
            SELECT prosrc ~ 'INSERT INTO public.signup_errors' INTO result
            FROM pg_proc WHERE proname = 'handle_new_user';

        WHEN 'wallet_trigger_function_exists' THEN
            SELECT length(prosrc) > 100 INTO result
            FROM pg_proc WHERE proname = 'handle_new_user_v2_create_wallet';

        WHEN 'diamonds_trigger_function_exists' THEN
            SELECT length(prosrc) > 100 INTO result
            FROM pg_proc WHERE proname = 'initialize_user_diamonds';

        WHEN 'profiles_table_exists' THEN
            SELECT to_regclass('public.profiles') IS NOT NULL INTO result;
        WHEN 'wallets_table_exists' THEN
            SELECT to_regclass('public.wallets') IS NOT NULL INTO result;
        WHEN 'user_diamonds_table_exists' THEN
            SELECT to_regclass('public.user_diamonds') IS NOT NULL INTO result;
        WHEN 'signup_errors_table_exists' THEN
            SELECT to_regclass('public.signup_errors') IS NOT NULL INTO result;
        WHEN 'probe_heartbeats_table_exists' THEN
            SELECT to_regclass('public.probe_heartbeats') IS NOT NULL INTO result;
        WHEN 'signup_health_view_exists' THEN
            SELECT to_regclass('public.signup_health_view') IS NOT NULL INTO result;
        WHEN 'player_number_sequence_exists' THEN
            SELECT to_regclass('public.profiles_player_number_seq') IS NOT NULL INTO result;

        WHEN 'wallets_unique_index_exists' THEN
            SELECT EXISTS (
                SELECT 1 FROM pg_indexes
                WHERE tablename = 'wallets'
                  AND schemaname = 'public'
                  AND indexname = 'wallets_user_id_wallet_type_key'
            ) INTO result;

        ELSE
            -- Unknown check name — treat as failure (do not silently pass)
            RETURN FALSE;
    END CASE;

    RETURN COALESCE(result, FALSE);
END;
$function$;

-- service_role only — this is internal observability
REVOKE ALL ON FUNCTION public.signup_audit_check(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_audit_check(text) TO service_role;

COMMENT ON FUNCTION public.signup_audit_check(text) IS
  'Backs /api/cron/trigger-audit. Pass a check_name from the hardcoded list; returns boolean. Centralizes audit SQL so the handler can not ship arbitrary queries. Adding a new check requires a new migration (audit trail).';
