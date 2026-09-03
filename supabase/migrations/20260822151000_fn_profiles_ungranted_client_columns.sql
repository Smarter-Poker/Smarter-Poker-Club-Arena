-- ═══════════════════════════════════════════════════════════════════════════
-- The detector for the class of bug that cost 2026-08-22
-- ═══════════════════════════════════════════════════════════════════════════
--
-- APPLIED TO PRODUCTION 2026-08-22 via Supabase apply_migration
-- (migration name: fn_profiles_ungranted_client_columns).
--
-- public.profiles is granted per column, and column grants do not extend to
-- columns added later. So `ALTER TABLE public.profiles ADD COLUMN ...` silently
-- produces a column the browser gets 42501 on — and because supabase-js resolves
-- a 403 as { data: null, error }, every caller that reads .data and falls back
-- to a default keeps working, wrongly, in silence. That is how ten columns
-- accumulated before anyone noticed, and the one that finally got noticed was
-- noticed as "profile pics are broken", not as a permissions fault.
--
-- WHY THIS IS A FUNCTION AND NOT AN EVENT TRIGGER
--
-- The right guard is a DDL event trigger that refuses an ADD COLUMN on this
-- table until the migration states whether the column is client-readable.
-- CREATE EVENT TRIGGER requires superuser and is not permitted for the postgres
-- role on Supabase — verified on this project, the CREATE is refused and no
-- trigger is registered. So this is the detector instead of the gate:
--
--     select * from public.fn_profiles_ungranted_client_columns();
--
-- Empty result = every profiles column is either readable by `authenticated` or
-- on the deliberate deny-list below. Anything returned is a column some client
-- feature is silently reading as null right now.
--
-- RUN IT AFTER ANY MIGRATION THAT TOUCHES profiles. It costs one query.
--
-- ROLLBACK: DROP FUNCTION public.fn_profiles_ungranted_client_columns();

CREATE OR REPLACE FUNCTION public.fn_profiles_ungranted_client_columns()
RETURNS TABLE (column_name text, data_type text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, information_schema
AS $$
    SELECT c.column_name::text, c.data_type::text
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name  = 'profiles'
      -- Deliberately withheld from the browser. Keep this list short and
      -- justified; everything on it is PII, a payment identifier, or an
      -- anti-fraud signal the player must not be able to read about themselves.
      AND c.column_name NOT IN ('email', 'phone', 'stripe_customer_id', 'is_farming_flagged')
      AND NOT has_column_privilege('authenticated', 'public.profiles', c.column_name, 'SELECT')
    ORDER BY 1
$$;

COMMENT ON FUNCTION public.fn_profiles_ungranted_client_columns() IS
    'Columns on public.profiles that the authenticated role cannot SELECT and that are not on the deliberate deny-list. Non-empty means a client feature is silently reading null. See supabase/migrations/20260822143000_arena_avatar_url_grants.sql.';

-- Nothing in the browser needs this; it is an operator tool.
REVOKE ALL ON FUNCTION public.fn_profiles_ungranted_client_columns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_profiles_ungranted_client_columns() TO service_role;

-- And assert, here and now, that the answer is empty.
DO $$
DECLARE v_gaps text;
BEGIN
    SELECT string_agg(column_name, ', ') INTO v_gaps
    FROM public.fn_profiles_ungranted_client_columns();

    IF v_gaps IS NOT NULL THEN
        RAISE EXCEPTION 'profiles still has ungranted client columns: %', v_gaps;
    END IF;
END $$;
