-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503075240 "phase37_post_audit_restore_jarvis_cache_and_training_events"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 58e2a7160570e682fd9962f30ffb2e3b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- post-Phase-37 audit fix — restore policies on tables where Tier-B
-- lockdown was too aggressive. Bug-hunt found 2 regressions:
--
-- 1. jarvis_response_cache: had a single ALL policy with USING true /
--    WITH CHECK true. Tier-B dropped it. Result: 0 policies, anon CAN'T
--    read or write. Five pages/api/gto/* routes import jarvisCache.js
--    which uses the anon-key supabase client → cache is dead, every
--    request falls through to live Grok API call. Performance/cost
--    regression, not a correctness bug, but real.
--    Fix: re-add a SELECT policy on the cache (it's a public-read
--    cache by design — hash-keyed, no PII), keep writes locked to
--    service_role only.
--
-- 2. training_events: had `training_events_insert` (USING true) which
--    Tier-B dropped. Result: only training_events_select survives.
--    CentralBus.js's _persistEvent uses the anon supabase client and
--    its INSERTs now silent-fail. TrainingArena.jsx, FeaturedHero.jsx
--    log via this. Fix: add INSERT policy scoped to auth.uid() = user_id
--    so authenticated users can log their own training events.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── jarvis_response_cache: restore anon SELECT (cache is public-by-design) ──
CREATE POLICY "jarvis_response_cache_anon_select"
    ON public.jarvis_response_cache
    FOR SELECT TO anon, authenticated
    USING (true);

-- service_role bypasses RLS, so writes from API routes still work.

-- ─── training_events: scoped INSERT for authenticated users ──────────
CREATE POLICY "training_events_insert_self"
    ON public.training_events
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = user_id OR user_id IS NULL);
-- (user_id IS NULL allows pre-login session events with anonymous tracking)

-- Verify
DO $$
DECLARE
    v_jcache_select integer;
    v_train_insert integer;
BEGIN
    SELECT COUNT(*) INTO v_jcache_select
    FROM pg_policies
    WHERE schemaname='public' AND tablename='jarvis_response_cache' AND cmd = 'SELECT';
    IF v_jcache_select <> 1 THEN
        RAISE EXCEPTION 'Post-apply: expected 1 SELECT policy on jarvis_response_cache, found %', v_jcache_select;
    END IF;

    SELECT COUNT(*) INTO v_train_insert
    FROM pg_policies
    WHERE schemaname='public' AND tablename='training_events' AND cmd = 'INSERT';
    IF v_train_insert <> 1 THEN
        RAISE EXCEPTION 'Post-apply: expected 1 INSERT policy on training_events, found %', v_train_insert;
    END IF;

    RAISE NOTICE 'Post-apply: jarvis_response_cache SELECT restored, training_events INSERT scoped';
END $$;

-- Live canary: anon SELECT on jarvis_response_cache
DO $$
DECLARE v_anon_blocked boolean := false; v_count integer;
BEGIN
    SET LOCAL ROLE anon;
    BEGIN
        EXECUTE 'SELECT COUNT(*) FROM jarvis_response_cache' INTO v_count;
        -- Got here = SELECT works
    EXCEPTION WHEN insufficient_privilege THEN
        v_anon_blocked := true;
    END;
    RESET ROLE;
    IF v_anon_blocked THEN
        RAISE EXCEPTION 'Canary: anon SELECT on jarvis_response_cache still blocked';
    END IF;
    RAISE NOTICE 'Canary OK: anon SELECT on jarvis_response_cache works';
END $$;
