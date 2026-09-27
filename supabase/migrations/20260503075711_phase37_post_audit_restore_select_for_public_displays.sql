-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503075711 "phase37_post_audit_restore_select_for_public_displays"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b1bbe94e1b5bb173a10299a624f3eaba of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- post-Phase-37 audit fix #2 — restore SELECT policies on tables that
-- the Tier-B drop sweep silently broke for anon/authenticated readers.
--
-- Bug-hunt confirmed regressions:
--   - pages/hub/trivia/tournaments.js: 5 anon-context SELECTs on
--     trivia_tournaments + trivia_tournament_entries — page is dead
--     after Tier-B (can't list tournaments, can't show registration
--     status, can't show past results, score updates fail)
--   - pages/hub/trivia/mixed.js: SELECT on trivia_category_mastery
--   - pages/hub/commander/tournament/[id]/my-status.js: SELECTs on
--     commander_tournaments + commander_tournament_entries
--
-- Fix: add SELECT policies for the public-display tables, plus
-- user-scoped INSERT/UPDATE policies for trivia_tournament_entries
-- (so authenticated users can read their own entry + record their
-- own score). Direct INSERT to trivia_tournament_entries remains
-- blocked — that's what /api/trivia/tournament-enter is for.
--
-- Server-only tables (commander_dealer_rotations, horse_*,
-- tour_schedule_*, sandbox_results, scraper_runs, etc.) are NOT
-- given anon-readable policies because no anon-context code
-- reads from them.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── Public-display content feeds + game lobbies ──────────────────────
-- These are read by anon/authenticated browsers from page-level code.
CREATE POLICY "trivia_tournaments_public_select" ON public.trivia_tournaments
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "trivia_category_mastery_public_select" ON public.trivia_category_mastery
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "video_clips_public_select" ON public.video_clips
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "posted_sports_clips_public_select" ON public.posted_sports_clips
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "poker_videos_public_select" ON public.poker_videos
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "poker_reels_public_select" ON public.poker_reels
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "vip_pricing_public_select" ON public.vip_pricing
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "feature_pricing_public_select" ON public.feature_pricing
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "spin_tournaments_public_select" ON public.spin_tournaments
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "daily_spins_public_select" ON public.daily_spins
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "training_achievements_public_select" ON public.training_achievements
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "villain_archetypes_public_select" ON public.villain_archetypes
    FOR SELECT TO anon, authenticated USING (true);

-- ─── trivia_tournament_entries — user-self-scoped ─────────────────────
-- User must be able to read their own entry to know if they're registered,
-- and update their own entry's score after a round. Direct INSERT is
-- blocked — only /api/trivia/tournament-enter (service_role) creates rows.
CREATE POLICY "trivia_tournament_entries_select_self" ON public.trivia_tournament_entries
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "trivia_tournament_entries_update_self" ON public.trivia_tournament_entries
    FOR UPDATE TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ─── Verification ─────────────────────────────────────────────────────
DO $$
DECLARE v_tt_select integer; v_tte_select integer; v_tte_update integer;
BEGIN
    SELECT COUNT(*) INTO v_tt_select FROM pg_policies
    WHERE schemaname='public' AND tablename='trivia_tournaments' AND cmd='SELECT';
    IF v_tt_select <> 1 THEN RAISE EXCEPTION 'trivia_tournaments select policy missing'; END IF;

    SELECT COUNT(*) INTO v_tte_select FROM pg_policies
    WHERE schemaname='public' AND tablename='trivia_tournament_entries' AND cmd='SELECT';
    IF v_tte_select <> 1 THEN RAISE EXCEPTION 'trivia_tournament_entries select policy missing'; END IF;

    SELECT COUNT(*) INTO v_tte_update FROM pg_policies
    WHERE schemaname='public' AND tablename='trivia_tournament_entries' AND cmd='UPDATE';
    IF v_tte_update <> 1 THEN RAISE EXCEPTION 'trivia_tournament_entries update policy missing'; END IF;

    RAISE NOTICE 'Post-apply: SELECT/UPDATE policies restored';
END $$;

-- ─── Live canary: anon SELECT on trivia_tournaments ───────────────────
DO $$
DECLARE v_blocked boolean := false;
BEGIN
    SET LOCAL ROLE anon;
    BEGIN
        PERFORM 1 FROM trivia_tournaments LIMIT 1;
    EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
    END;
    RESET ROLE;
    IF v_blocked THEN RAISE EXCEPTION 'Canary: anon SELECT on trivia_tournaments still blocked'; END IF;
    RAISE NOTICE 'Canary OK: anon SELECT on trivia_tournaments works';
END $$;
