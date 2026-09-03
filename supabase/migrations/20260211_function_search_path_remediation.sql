-- Supabase Security Warnings Remediation
-- Date: 2026-02-11
-- Fixes 36 "Function Search Path Mutable" warnings
-- Pattern: ALTER FUNCTION ... SET search_path = 'public'
-- This prevents schema injection attacks without changing function logic or permissions

BEGIN;

ALTER FUNCTION public.auto_add_group_owner() SET search_path = 'public';
ALTER FUNCTION public.calculate_entry_investment() SET search_path = 'public';
ALTER FUNCTION public.calculate_pilot_metrics(p_venue_id integer) SET search_path = 'public';
ALTER FUNCTION public.calculate_session_comps(p_session_id uuid) SET search_path = 'public';
ALTER FUNCTION public.check_bankroll_achievements(p_user_id uuid) SET search_path = 'public';
ALTER FUNCTION public.check_rate_limit(p_identifier text, p_identifier_type text, p_endpoint text, p_window_minutes integer, p_max_requests integer) SET search_path = 'public';
ALTER FUNCTION public.find_nearby_venues(p_lat double precision, p_lng double precision, p_radius_miles double precision) SET search_path = 'public';
ALTER FUNCTION public.fn_auto_create_story_from_post() SET search_path = 'public';
ALTER FUNCTION public.generate_club_codes() SET search_path = 'public';
ALTER FUNCTION public.get_next_waitlist_position(p_venue_id integer, p_game_type text, p_stakes text) SET search_path = 'public';
ALTER FUNCTION public.get_user_achievements(p_user_id uuid) SET search_path = 'public';
ALTER FUNCTION public.increment_diamonds(p_user_id uuid, p_amount integer) SET search_path = 'public';
ALTER FUNCTION public.is_venue_manager(p_user_id uuid, p_venue_id integer) SET search_path = 'public';
ALTER FUNCTION public.issue_manual_comp(p_venue_id integer, p_player_id uuid, p_amount numeric, p_staff_id uuid, p_description text) SET search_path = 'public';
ALTER FUNCTION public.log_audit_event(p_venue_id integer, p_user_id uuid, p_staff_id uuid, p_actor_type text, p_action text, p_action_category text, p_target_type text, p_target_id text, p_changes jsonb, p_metadata jsonb) SET search_path = 'public';
ALTER FUNCTION public.recalculate_waitlist_positions() SET search_path = 'public';
ALTER FUNCTION public.record_health_metric(p_venue_id integer, p_metric_type text, p_metric_value numeric, p_metric_unit text, p_endpoint text, p_details jsonb) SET search_path = 'public';
ALTER FUNCTION public.redeem_comps(p_venue_id integer, p_player_id uuid, p_amount numeric, p_redemption_type text, p_staff_id uuid, p_description text) SET search_path = 'public';
ALTER FUNCTION public.set_subscription_tier_features() SET search_path = 'public';
ALTER FUNCTION public.start_arcade_game(p_user_id uuid, p_game_id text) SET search_path = 'public';
ALTER FUNCTION public.track_doc_access(p_user_id uuid, p_venue_id integer, p_document_type text) SET search_path = 'public';
ALTER FUNCTION public.unlock_achievement(p_user_id uuid, p_achievement_key text, p_metadata jsonb) SET search_path = 'public';
ALTER FUNCTION public.unlock_free_avatars(p_user_id uuid) SET search_path = 'public';
ALTER FUNCTION public.update_agent_player_count() SET search_path = 'public';
ALTER FUNCTION public.update_bankroll_streak(p_user_id uuid, p_net_amount numeric) SET search_path = 'public';
ALTER FUNCTION public.update_game_player_count() SET search_path = 'public';
ALTER FUNCTION public.update_home_game_rsvp_counts() SET search_path = 'public';
ALTER FUNCTION public.update_home_group_member_count() SET search_path = 'public';
ALTER FUNCTION public.update_leaderboard_rankings(lb_id uuid) SET search_path = 'public';
ALTER FUNCTION public.update_player_stats_from_session() SET search_path = 'public';
ALTER FUNCTION public.update_post_comments_count() SET search_path = 'public';
ALTER FUNCTION public.update_post_likes_count() SET search_path = 'public';
ALTER FUNCTION public.update_promotion_totals() SET search_path = 'public';
ALTER FUNCTION public.update_question_usage() SET search_path = 'public';
ALTER FUNCTION public.update_tournament_stats() SET search_path = 'public';
ALTER FUNCTION public.update_union_venue_count() SET search_path = 'public';

COMMIT;
