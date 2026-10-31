CREATE OR REPLACE FUNCTION public.signup_audit_check(check_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    result boolean;
BEGIN
    CASE check_name
        -- 2026-10-31: asserted by name, enabled, not by count. The count was
        -- written when there were three; the two referral triggers made it five
        -- and the daily audit reported a dropped trigger that was never dropped.
        -- The old check name is kept because /api/cron/trigger-audit calls it.
        WHEN 'three_triggers_on_auth_users', 'auth_users_triggers_present' THEN
            SELECT count(*) = 5 INTO result
            FROM pg_trigger
            WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal AND tgenabled <> 'D'
              AND tgname IN ('on_auth_user_created', 'on_auth_user_created_diamonds',
                             'on_auth_user_created_wallet', 'on_auth_user_email_confirmed_referral',
                             'on_auth_user_inserted_confirmed_referral');

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
            RETURN FALSE;
    END CASE;

    RETURN COALESCE(result, FALSE);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.signup_audit_check(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_audit_check(text) TO service_role;