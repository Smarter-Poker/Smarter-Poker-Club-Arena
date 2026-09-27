-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812230433 "phase54_home_games_invariants_check"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e58961ab868ae1c594592e688fbbcf4d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Phase 54 — verify_home_games_invariants()
--
-- WHY: the 2026-08-12 audit found THREE hardening changes that were recorded
-- as applied in supabase_migrations.schema_migrations but were absent from
-- the live database, reverted out-of-band with no migration explaining it:
--
--   * SECURITY DEFINER on fn_home_is_group_staff / fn_home_is_approved_member
--   * policy home_members_host_sees_group (replaced by a dashboard default)
--   * unique index uq_commander_home_games_one_active_per_group_per_date
--
-- None of them announced itself. They were only found by reading live
-- catalogs and comparing against migration history by hand. The repo holds
-- 703 migration files against 1,263 applied rows, so `supabase db reset`
-- cannot reproduce production and diffing is not an option.
--
-- This function turns that silent class of failure into a single query.
-- Run it from a health check, a cron, or by hand:
--
--     SELECT * FROM public.verify_home_games_invariants() WHERE NOT ok;
--
-- Zero rows means the security posture is intact. Any row is a regression
-- with a human-readable detail string.
--
-- It asserts POSTURE, not schema shape, so it stays valid as the feature
-- evolves. Add an invariant whenever you fix something that could silently
-- revert.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.verify_home_games_invariants()
RETURNS TABLE (invariant text, ok boolean, detail text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    -- 1/2. The two RLS helpers must stay SECURITY DEFINER with RLS off.
    --      SECURITY INVOKER + row_security=off is illegal without BYPASSRLS
    --      and raises 42501 for every authenticated caller.
    RETURN QUERY
    SELECT
        'helper_' || p.proname,
        (p.prosecdef AND COALESCE(p.proconfig, ARRAY[]::text[]) && ARRAY['row_security=off']),
        format('prosecdef=%s config=%s', p.prosecdef, COALESCE(p.proconfig, ARRAY[]::text[])::text)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('fn_home_is_group_staff', 'fn_home_is_approved_member');

    -- 3. Roster SELECT must be staff-aware, not the dashboard's self-only default.
    RETURN QUERY
    SELECT
        'policy_home_members_host_sees_group',
        EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname='public' AND tablename='commander_home_members'
              AND cmd='SELECT' AND qual LIKE '%fn_home_is_group_staff%'
        ),
        COALESCE((
            SELECT string_agg(policyname, ', ')
            FROM pg_policies
            WHERE schemaname='public' AND tablename='commander_home_members' AND cmd='SELECT'
        ), '(no SELECT policy at all)');

    -- 4. Double-booking guard.
    RETURN QUERY
    SELECT
        'index_one_active_game_per_group_per_date',
        EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE schemaname='public'
              AND indexname='uq_commander_home_games_one_active_per_group_per_date'
        ),
        'partial unique index on (group_id, scheduled_date) WHERE status <> cancelled';

    -- 5. No blanket USING(true) SELECT policies on the social/home surface.
    RETURN QUERY
    SELECT
        'no_blanket_select_policies',
        NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname='public' AND cmd='SELECT' AND qual='true'
              AND tablename IN ('social_pages','social_page_posts','social_page_reviews',
                                'home_game_vouches','commander_post_comments',
                                'commander_venue_followers','commander_home_posts')
        ),
        COALESCE((
            SELECT string_agg(tablename || '.' || policyname, ', ')
            FROM pg_policies
            WHERE schemaname='public' AND cmd='SELECT' AND qual='true'
              AND tablename IN ('social_pages','social_page_posts','social_page_reviews',
                                'home_game_vouches','commander_post_comments',
                                'commander_venue_followers','commander_home_posts')
        ), 'none');

    -- 6. Client roles must not hold privileges RLS cannot mediate.
    --    TRUNCATE in particular is NOT filtered by row security.
    RETURN QUERY
    SELECT
        'no_rls_bypassing_grants_to_client_roles',
        NOT EXISTS (
            SELECT 1 FROM information_schema.role_table_grants
            WHERE table_schema='public'
              AND grantee IN ('anon','authenticated')
              AND privilege_type IN ('TRUNCATE','TRIGGER','REFERENCES')
              AND (table_name LIKE 'commander_home%' OR table_name LIKE 'home\_%')
        ),
        COALESCE((
            SELECT count(*)::text || ' offending grants'
            FROM information_schema.role_table_grants
            WHERE table_schema='public'
              AND grantee IN ('anon','authenticated')
              AND privilege_type IN ('TRUNCATE','TRIGGER','REFERENCES')
              AND (table_name LIKE 'commander_home%' OR table_name LIKE 'home\_%')
        ), '0');

    -- 7. Seat claiming must refuse cancelled games and waitlist self-promotion.
    RETURN QUERY
    SELECT
        'rpc_hg_claim_seat_guards',
        (SELECT p.prosrc LIKE '%GAME_NOT_ACTIVE%'
                AND p.prosrc LIKE '%WAITLISTED_CANNOT_SELF_SEAT%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname='rpc_hg_claim_seat' LIMIT 1),
        'claim_seat must check parent game status and refuse to overwrite a host-set waitlist';

    -- 8. Every SECURITY DEFINER home function must pin search_path.
    --    An unpinned SECDEF function is a privilege-escalation vector.
    RETURN QUERY
    SELECT
        'secdef_home_functions_pin_search_path',
        NOT EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.prosecdef
              AND (p.proname LIKE 'rpc_hg\_%' OR p.proname LIKE 'fn_home\_%' OR p.proname LIKE 'fn_hg\_%')
              AND NOT EXISTS (
                  SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) c
                  WHERE c LIKE 'search_path=%'
              )
        ),
        COALESCE((
            SELECT string_agg(p.proname, ', ')
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.prosecdef
              AND (p.proname LIKE 'rpc_hg\_%' OR p.proname LIKE 'fn_home\_%' OR p.proname LIKE 'fn_hg\_%')
              AND NOT EXISTS (
                  SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) c
                  WHERE c LIKE 'search_path=%'
              )
        ), 'all pinned');
END;
$function$;

COMMENT ON FUNCTION public.verify_home_games_invariants() IS
  'Security-posture assertions for Home Games. Returns one row per invariant; any row with ok=false is a regression. Exists because three hardening migrations were reverted out-of-band in production without detection (audit 2026-08-12). Run: SELECT * FROM verify_home_games_invariants() WHERE NOT ok;';

REVOKE EXECUTE ON FUNCTION public.verify_home_games_invariants() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.verify_home_games_invariants() TO service_role;

-- ---------- POST-APPLY: the invariants must all pass RIGHT NOW ----------
DO $$
DECLARE v_bad text;
BEGIN
    SELECT string_agg(invariant || ' (' || COALESCE(detail,'') || ')', '; ')
      INTO v_bad
    FROM public.verify_home_games_invariants()
    WHERE NOT ok OR ok IS NULL;

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'POST-APPLY FAILED: invariants already violated: %', v_bad;
    END IF;
    RAISE NOTICE 'phase54 OK: all Home Games invariants hold.';
END $$;
