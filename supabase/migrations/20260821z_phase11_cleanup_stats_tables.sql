-- ============================================================================
-- 20260821z_phase11_cleanup_stats_tables.sql
-- Phase 11: Cleanup abandoned legacy stats tables
-- ============================================================================

DROP TABLE IF EXISTS public.user_poker_stats CASCADE;
DROP TABLE IF EXISTS public.poker_session_stats CASCADE;
DROP TABLE IF EXISTS public.user_stats CASCADE;
DROP TABLE IF EXISTS public.hand_players CASCADE;
