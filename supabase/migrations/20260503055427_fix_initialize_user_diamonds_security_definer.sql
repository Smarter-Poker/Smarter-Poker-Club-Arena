-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503055427 "fix_initialize_user_diamonds_security_definer"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0831e4aaae0ae851862423ee659f90a8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- FIX: signups have been failing with "Database error saving new user"
-- since at least 2026-04-29 (most recent real-or-test profile creation).
--
-- ROOT CAUSE
-- ──────────
-- The trigger `on_auth_user_created_diamonds` on auth.users calls
-- public.initialize_user_diamonds(), which was created with SECURITY INVOKER.
-- When GoTrue inserts a new row into auth.users it runs as the
-- `supabase_auth_admin` role. With SECURITY INVOKER, the trigger function
-- also runs as `supabase_auth_admin` — and that role has NO grants on
-- public.user_diamonds or public.user_daily_streaks. The INSERT fails with
-- `permission denied for table user_diamonds`, the transaction aborts, and
-- the entire auth.users INSERT rolls back.
--
-- The other two triggers on auth.users (handle_new_user → profiles,
-- handle_new_user_v2_create_wallet → wallets) are both SECURITY DEFINER
-- owned by `postgres`, so they bypass the grant gap. Only this one was
-- INVOKER — almost certainly an oversight from when it was first added.
--
-- FIX
-- ───
-- Convert to SECURITY DEFINER (so it runs as `postgres`, which has all
-- grants), pin search_path (Supabase best practice for SECURITY DEFINER),
-- schema-qualify the table refs, and add a defensive EXCEPTION handler that
-- matches the pattern of the other two trigger functions: a downstream
-- write failure should never block auth.users INSERT.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.initialize_user_diamonds()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.user_diamonds (user_id, balance, lifetime_earned)
    VALUES (NEW.id, 100, 100)
    ON CONFLICT (user_id) DO NOTHING;

    INSERT INTO public.user_daily_streaks (user_id)
    VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Defensive: never block auth.users INSERT. Matches the pattern in
    -- public.handle_new_user and public.handle_new_user_v2_create_wallet.
    RAISE WARNING '[initialize_user_diamonds] failed for %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

