-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419224330 "phase37_safety_net_and_grant_hygiene"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 17478246bd9b7ef16293ba505f64c8de of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- PHASE 37: Safety net + grant hygiene (M1 + H1 + L2)
-- ============================================================================

-- ───────────────────────────────────────────────────────────────────────
-- M1. Schema-level enforcement: NO 'home_games' source in diamond_transactions.
-- This is the belt-and-suspenders that prevents any future agent/migration
-- from re-introducing host rewards without a deliberate schema change.
-- ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.diamond_transactions
    DROP CONSTRAINT IF EXISTS no_home_games_source;

ALTER TABLE public.diamond_transactions
    ADD CONSTRAINT no_home_games_source
    CHECK (source IS NULL OR source <> 'home_games');

COMMENT ON CONSTRAINT no_home_games_source ON public.diamond_transactions IS
    'Regulatory: Smarter.Poker cannot pay value to home-game hosts. '
    'Enforced at schema level to survive code regressions. '
    'See Phase 36 removal migration.';

-- ───────────────────────────────────────────────────────────────────────
-- H1. Column-level REVOKE on host_private_note.
-- The RLS policy home_members_host_sees_group lets any approved member see
-- all approved member rows — including host_private_note. Postgres enforces
-- column grants BEFORE RLS policy evaluation, so revoking SELECT on just
-- that column blocks the leak. SECURITY DEFINER functions (owned by postgres
-- superuser) continue to work because they bypass the RBAC layer entirely.
-- ───────────────────────────────────────────────────────────────────────
REVOKE SELECT (host_private_note) ON public.commander_home_members
    FROM PUBLIC, anon, authenticated;

-- Ensure service_role retains the column (should already, but explicit is better)
GRANT SELECT (host_private_note) ON public.commander_home_members TO service_role;

COMMENT ON COLUMN public.commander_home_members.host_private_note IS
    'Owner/admin-only notes about members. Column-level SELECT revoked from '
    'anon/authenticated (Phase 37). Access only via SECURITY DEFINER fns like '
    'get_home_group_member_engagement which gate on owner/admin role.';

-- ───────────────────────────────────────────────────────────────────────
-- L2. Revoke EXECUTE from anon/public on 8 trigger-handler fns.
-- Triggers don't care about EXECUTE grants — they fire regardless — so this
-- is cosmetic, but it tightens the public grant surface and eliminates
-- confusing false-positives in future security audits. All 9 fns are
-- trigger handlers: they take () as args and RETURNS trigger.
-- ───────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_fn text;
    v_fns text[] := ARRAY[
        'fn_notify_home_game_created',
        'fn_notify_home_game_cancelled',
        'fn_notify_home_rsvp',
        'fn_notify_home_member_status',
        'fn_notify_home_post_created',
        'fn_notify_home_post_comment',
        'fn_notify_home_post_like',
        'fn_notify_friends_of_home_join',
        'trg_fn_autocreate_home_group_social_page'
    ];
BEGIN
    FOREACH v_fn IN ARRAY v_fns LOOP
        -- All trigger fns take () — no arg disambiguation needed
        EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated', v_fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I() TO service_role', v_fn);
    END LOOP;
END $$;
