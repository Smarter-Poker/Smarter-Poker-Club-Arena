-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812221535 "phase52_revoke_truncate_trigger_references_from_client_roles"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9dd64a3d312f287103290d6e47321c02 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Phase 52 — Remove privileges that RLS cannot mediate from client roles
--
-- WHY: the audit found `anon` and `authenticated` holding TRUNCATE, TRIGGER
-- and REFERENCES on every commander_home_* table (50 TRUNCATE grants alone).
--
-- WHY IT MATTERS: Row Level Security filters SELECT/INSERT/UPDATE/DELETE.
-- It does NOT apply to TRUNCATE. A client holding TRUNCATE can empty an
-- entire table in one statement regardless of how correct the row policies
-- are. TRIGGER allows attaching arbitrary trigger functions to a table the
-- client does not own. Neither is ever needed by a PostgREST client.
--
-- SCOPE: revokes ONLY TRUNCATE, TRIGGER, REFERENCES (and MAINTAIN where
-- supported). SELECT/INSERT/UPDATE/DELETE are deliberately left untouched -
-- those are the privileges RLS is designed to mediate, and changing them
-- here would break the application.
--
-- Also fixes the inverted grants on mv_home_groups_trending, which had
-- INSERT/UPDATE/DELETE/TRUNCATE/MAINTAIN granted to anon+authenticated but
-- no SELECT. MAINTAIN permits REFRESH MATERIALIZED VIEW, i.e. an
-- unauthenticated client could force an expensive refresh on demand (CPU
-- denial of service). Materialized views also receive no RLS at all.
--
-- Idempotent. ROLLBACK at the bottom.
-- =====================================================================

DO $$
DECLARE
    r            record;
    v_revoked    int := 0;
    v_has_maintain boolean;
BEGIN
    -- MAINTAIN is PG17+; detect rather than assume.
    SELECT EXISTS (
        SELECT 1 FROM information_schema.table_privileges
        WHERE privilege_type = 'MAINTAIN' LIMIT 1
    ) INTO v_has_maintain;

    FOR r IN
        SELECT c.relname, c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r','p','m','v')
          AND (c.relname LIKE 'commander_home%' OR c.relname LIKE 'home\_%' OR c.relname = 'mv_home_groups_trending')
    LOOP
        EXECUTE format(
            'REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.%I FROM anon, authenticated',
            r.relname
        );
        v_revoked := v_revoked + 1;
    END LOOP;

    -- Materialized view: clients must never write to or refresh it.
    IF to_regclass('public.mv_home_groups_trending') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON TABLE public.mv_home_groups_trending FROM anon, authenticated';
        IF v_has_maintain THEN
            BEGIN
                EXECUTE 'REVOKE MAINTAIN ON TABLE public.mv_home_groups_trending FROM anon, authenticated';
            EXCEPTION WHEN OTHERS THEN
                RAISE NOTICE 'MAINTAIN revoke skipped: %', SQLERRM;
            END;
        END IF;
    END IF;

    RAISE NOTICE 'phase52: processed % home relations.', v_revoked;
END $$;

-- ---------- POST-APPLY ASSERTIONS ----------
DO $$
DECLARE
    v_bad int;
    v_mv  int;
BEGIN
    SELECT COUNT(*) INTO v_bad
    FROM information_schema.role_table_grants
    WHERE table_schema='public'
      AND grantee IN ('anon','authenticated')
      AND privilege_type IN ('TRUNCATE','TRIGGER','REFERENCES')
      AND (table_name LIKE 'commander_home%' OR table_name LIKE 'home\_%');

    IF v_bad > 0 THEN
        RAISE EXCEPTION 'POST-APPLY FAILED: % TRUNCATE/TRIGGER/REFERENCES grants remain on home tables', v_bad;
    END IF;

    SELECT COUNT(*) INTO v_mv
    FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='mv_home_groups_trending'
      AND grantee IN ('anon','authenticated');

    IF v_mv > 0 THEN
        RAISE EXCEPTION 'POST-APPLY FAILED: % client grants remain on mv_home_groups_trending', v_mv;
    END IF;

    RAISE NOTICE 'phase52 OK: client roles hold no RLS-bypassing privileges on home relations.';
END $$;

-- =====================================================================
-- ROLLBACK (restores the insecure state - emergency only):
--   DO $$ DECLARE r record; BEGIN
--     FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--              WHERE n.nspname='public' AND c.relkind IN ('r','p')
--                AND (c.relname LIKE 'commander_home%' OR c.relname LIKE 'home\_%')
--     LOOP EXECUTE format('GRANT TRUNCATE, TRIGGER, REFERENCES ON public.%I TO anon, authenticated', r.relname);
--     END LOOP; END $$;
-- =====================================================================
