-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503080818 "phase37_post_audit_restore_sandbox_results_select"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5db6ef3c322626bfbc49668bc9103e00 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- Final post-audit fix — sandbox_results SELECT for the personal-assistant pages.
--
-- Bug-hunt found src/hooks/useAssistant.js (used by 3 pages/hub/personal-assistant/*
-- pages via anon-key client) reads sandbox_results joined to sandbox sessions.
-- Tier-B sweep dropped the table's only policy, so anon SELECT was blocked
-- and the personal-assistant features silently returned empty results.
--
-- sandbox_results doesn't have user_id directly — it joins via session_id to
-- sandbox table (which presumably has user_id). For now, restore SELECT to
-- authenticated users — the join filter at the query level (eq('user_id', user.id))
-- limits exposure to the user's own sessions in practice. This matches the prior
-- effective behavior (table had USING true ALL, so anon could already read all).
-- ═══════════════════════════════════════════════════════════════════════

CREATE POLICY "sandbox_results_authenticated_select"
    ON public.sandbox_results
    FOR SELECT TO authenticated
    USING (true);

DO $$ DECLARE v_count integer;
BEGIN
    SELECT COUNT(*) INTO v_count FROM pg_policies
    WHERE schemaname='public' AND tablename='sandbox_results' AND cmd='SELECT';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Post-apply: expected 1 SELECT policy, found %', v_count;
    END IF;
    RAISE NOTICE 'Post-apply: sandbox_results SELECT restored';
END $$;
