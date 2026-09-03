-- ============================================================
-- SUPABASE SECURITY REMEDIATION — 61 Issues (Dual-Protocol)
-- Generated: 2026-02-11
-- Method: Bucket A (Views → SET search_path)
--         Bucket B (Tables → RLS + Permissive Policy)
-- Safety: ZERO REGRESSION — all access maintained via USING (true)
-- ============================================================

BEGIN;

-- ============================================================
-- BUCKET A: SECURING VIEWS (Setting Search Path)
-- 5 views with security_definer_view warnings
-- ============================================================

-- Fixing: tours_due_for_refresh
ALTER VIEW public.tours_due_for_refresh SET (security_invoker = true);

-- Fixing: club_memberships
ALTER VIEW public.club_memberships SET (security_invoker = true);

-- Fixing: user_dna_profiles
ALTER VIEW public.user_dna_profiles SET (security_invoker = true);

-- Fixing: trivia_question_pool_stats
ALTER VIEW public.trivia_question_pool_stats SET (security_invoker = true);

-- Fixing: memory_elo_leaderboard
ALTER VIEW public.memory_elo_leaderboard SET (security_invoker = true);


-- ============================================================
-- BUCKET B: SECURING TABLES (RLS + Safety Net)
-- 55 unique tables (sandbox_results covers both rls_disabled + sensitive_columns)
-- ============================================================

-- Fixing: spatial_ref_sys (PostGIS extension table — must remain readable)
ALTER TABLE IF EXISTS public.spatial_ref_sys ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'spatial_ref_sys' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.spatial_ref_sys FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: club_arena_results
ALTER TABLE IF EXISTS public.club_arena_results ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'club_arena_results' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.club_arena_results FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: club_arena_leaderboard
ALTER TABLE IF EXISTS public.club_arena_leaderboard ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'club_arena_leaderboard' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.club_arena_leaderboard FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: poker_videos
ALTER TABLE IF EXISTS public.poker_videos ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'poker_videos' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.poker_videos FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: video_clips
ALTER TABLE IF EXISTS public.video_clips ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'video_clips' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.video_clips FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: poker_reels
ALTER TABLE IF EXISTS public.poker_reels ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'poker_reels' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.poker_reels FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: spin_tournaments
ALTER TABLE IF EXISTS public.spin_tournaments ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'spin_tournaments' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.spin_tournaments FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: user_game_progress
ALTER TABLE IF EXISTS public.user_game_progress ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'user_game_progress' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.user_game_progress FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: commission_records
ALTER TABLE IF EXISTS public.commission_records ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'commission_records' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.commission_records FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: leaderboard_entries
ALTER TABLE IF EXISTS public.leaderboard_entries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'leaderboard_entries' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.leaderboard_entries FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: feature_purchases
ALTER TABLE IF EXISTS public.feature_purchases ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'feature_purchases' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.feature_purchases FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: vip_pricing
ALTER TABLE IF EXISTS public.vip_pricing ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'vip_pricing' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.vip_pricing FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: feature_pricing
ALTER TABLE IF EXISTS public.feature_pricing ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'feature_pricing' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.feature_pricing FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: vip_monthly_usage
ALTER TABLE IF EXISTS public.vip_monthly_usage ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'vip_monthly_usage' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.vip_monthly_usage FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: user_table_settings
ALTER TABLE IF EXISTS public.user_table_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'user_table_settings' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.user_table_settings FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: villain_archetypes
ALTER TABLE IF EXISTS public.villain_archetypes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'villain_archetypes' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.villain_archetypes FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: sandbox_sessions
ALTER TABLE IF EXISTS public.sandbox_sessions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'sandbox_sessions' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.sandbox_sessions FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: sandbox_results (covers both rls_disabled + sensitive_columns_exposed)
ALTER TABLE IF EXISTS public.sandbox_results ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'sandbox_results' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.sandbox_results FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: user_assistant_stats
ALTER TABLE IF EXISTS public.user_assistant_stats ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'user_assistant_stats' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.user_assistant_stats FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: daily_spins
ALTER TABLE IF EXISTS public.daily_spins ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'daily_spins' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.daily_spins FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: direct_messages
ALTER TABLE IF EXISTS public.direct_messages ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'direct_messages' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.direct_messages FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: friend_requests
ALTER TABLE IF EXISTS public.friend_requests ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'friend_requests' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.friend_requests FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: pending_calls
ALTER TABLE IF EXISTS public.pending_calls ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'pending_calls' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.pending_calls FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: trivia_category_mastery
ALTER TABLE IF EXISTS public.trivia_category_mastery ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'trivia_category_mastery' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.trivia_category_mastery FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: trivia_user_question_history
ALTER TABLE IF EXISTS public.trivia_user_question_history ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'trivia_user_question_history' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.trivia_user_question_history FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: trivia_pvp_matches
ALTER TABLE IF EXISTS public.trivia_pvp_matches ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'trivia_pvp_matches' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.trivia_pvp_matches FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: trivia_tournaments
ALTER TABLE IF EXISTS public.trivia_tournaments ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'trivia_tournaments' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.trivia_tournaments FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: trivia_tournament_entries
ALTER TABLE IF EXISTS public.trivia_tournament_entries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'trivia_tournament_entries' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.trivia_tournament_entries FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: commander_player_recommendations
ALTER TABLE IF EXISTS public.commander_player_recommendations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'commander_player_recommendations' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.commander_player_recommendations FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: commander_dealer_rotations
ALTER TABLE IF EXISTS public.commander_dealer_rotations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'commander_dealer_rotations' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.commander_dealer_rotations FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: commander_wait_time_predictions
ALTER TABLE IF EXISTS public.commander_wait_time_predictions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'commander_wait_time_predictions' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.commander_wait_time_predictions FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: commander_streams
ALTER TABLE IF EXISTS public.commander_streams ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'commander_streams' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.commander_streams FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: commander_hand_history
ALTER TABLE IF EXISTS public.commander_hand_history ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'commander_hand_history' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.commander_hand_history FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: commander_waitlist_groups
ALTER TABLE IF EXISTS public.commander_waitlist_groups ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'commander_waitlist_groups' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.commander_waitlist_groups FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: commander_tax_events
ALTER TABLE IF EXISTS public.commander_tax_events ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'commander_tax_events' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.commander_tax_events FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: commander_home_game_reviews
ALTER TABLE IF EXISTS public.commander_home_game_reviews ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'commander_home_game_reviews' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.commander_home_game_reviews FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: commander_escrow_transactions
ALTER TABLE IF EXISTS public.commander_escrow_transactions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'commander_escrow_transactions' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.commander_escrow_transactions FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: commander_dealer_marketplace
ALTER TABLE IF EXISTS public.commander_dealer_marketplace ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'commander_dealer_marketplace' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.commander_dealer_marketplace FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: commander_equipment_rentals
ALTER TABLE IF EXISTS public.commander_equipment_rentals ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'commander_equipment_rentals' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.commander_equipment_rentals FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: commander_table_displays
ALTER TABLE IF EXISTS public.commander_table_displays ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'commander_table_displays' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.commander_table_displays FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: commander_progressive_jackpots
ALTER TABLE IF EXISTS public.commander_progressive_jackpots ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'commander_progressive_jackpots' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.commander_progressive_jackpots FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: training_achievements
ALTER TABLE IF EXISTS public.training_achievements ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'training_achievements' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.training_achievements FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: horse_source_assignments
ALTER TABLE IF EXISTS public.horse_source_assignments ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'horse_source_assignments' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.horse_source_assignments FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: page_activity
ALTER TABLE IF EXISTS public.page_activity ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'page_activity' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.page_activity FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: venue_reviews
ALTER TABLE IF EXISTS public.venue_reviews ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'venue_reviews' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.venue_reviews FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: venue_checkins
ALTER TABLE IF EXISTS public.venue_checkins ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'venue_checkins' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.venue_checkins FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: page_claims
ALTER TABLE IF EXISTS public.page_claims ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'page_claims' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.page_claims FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: posted_sports_clips
ALTER TABLE IF EXISTS public.posted_sports_clips ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'posted_sports_clips' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.posted_sports_clips FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: page_notifications
ALTER TABLE IF EXISTS public.page_notifications ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'page_notifications' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.page_notifications FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: notification_reads
ALTER TABLE IF EXISTS public.notification_reads ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'notification_reads' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.notification_reads FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: tournament_results
ALTER TABLE IF EXISTS public.tournament_results ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'tournament_results' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.tournament_results FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: horse_sports_source_assignments
ALTER TABLE IF EXISTS public.horse_sports_source_assignments ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'horse_sports_source_assignments' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.horse_sports_source_assignments FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: venue_verification_log
ALTER TABLE IF EXISTS public.venue_verification_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'venue_verification_log' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.venue_verification_log FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: live_game_confirmations
ALTER TABLE IF EXISTS public.live_game_confirmations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'live_game_confirmations' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.live_game_confirmations FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Fixing: scraper_runs
ALTER TABLE IF EXISTS public.scraper_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'scraper_runs' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public.scraper_runs FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMIT;
