-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420013223 "phase6_1_1_lockdown_internal_logs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5a83a5c885746b6ee58d88a782d39ef2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 6.1.1 — Step 4 of 4: lock down internal log/infra tables.
-- These had USING (true) policies exposing operational data to anon.
-- All restricted to platform admins (service_role bypasses RLS).
-- ============================================================================

-- ── abuse_logs ── self + admin (already had user_id)
DROP POLICY IF EXISTS al_sel ON public.abuse_logs;
CREATE POLICY abuse_logs_self_or_admin_select ON public.abuse_logs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());

-- ── signup_abuse_log ── admin only
DROP POLICY IF EXISTS signup_abuse_log_select ON public.signup_abuse_log;
CREATE POLICY signup_abuse_log_admin_only ON public.signup_abuse_log
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── commander_activity_log ── admin only (replace ALL public with admin-only)
DROP POLICY IF EXISTS svc_activity_log ON public.commander_activity_log;
CREATE POLICY commander_activity_log_admin_only ON public.commander_activity_log
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── commander_system_log ── admin only
DROP POLICY IF EXISTS commander_system_log_select ON public.commander_system_log;
CREATE POLICY commander_system_log_admin_only ON public.commander_system_log
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── system_logs ── admin only
DROP POLICY IF EXISTS system_logs_select ON public.system_logs;
CREATE POLICY system_logs_admin_only ON public.system_logs
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── commander_rate_limits ── admin only
DROP POLICY IF EXISTS commander_rate_limits_select ON public.commander_rate_limits;
CREATE POLICY commander_rate_limits_admin_only ON public.commander_rate_limits
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── cron_execution_log ── admin only
DROP POLICY IF EXISTS cron_execution_log_select ON public.cron_execution_log;
CREATE POLICY cron_execution_log_admin_only ON public.cron_execution_log
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── notification_prompt_log ── self + admin
DROP POLICY IF EXISTS notification_prompt_log_select ON public.notification_prompt_log;
CREATE POLICY notification_prompt_log_self_select ON public.notification_prompt_log
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());

-- ── live_help_analytics ── self + admin
DROP POLICY IF EXISTS live_help_analytics_select ON public.live_help_analytics;
CREATE POLICY live_help_analytics_self_select ON public.live_help_analytics
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());

-- ── live_help_reactions ── self + admin
DROP POLICY IF EXISTS live_help_reactions_select ON public.live_help_reactions;
CREATE POLICY live_help_reactions_self_select ON public.live_help_reactions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());

-- ── horse_error_log ── admin only
DROP POLICY IF EXISTS horse_error_log_select ON public.horse_error_log;
CREATE POLICY horse_error_log_admin_only ON public.horse_error_log
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── hendon_scrape_log ── admin only
DROP POLICY IF EXISTS hendon_scrape_log_select ON public.hendon_scrape_log;
CREATE POLICY hendon_scrape_log_admin_only ON public.hendon_scrape_log
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── horse_analytics ── admin only (operational metrics)
DROP POLICY IF EXISTS horse_analytics_select ON public.horse_analytics;
CREATE POLICY horse_analytics_admin_only ON public.horse_analytics
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── messenger_themes / messenger_labels ── self + admin (these were over-broad)
DROP POLICY IF EXISTS messenger_labels_select ON public.messenger_labels;
DROP POLICY IF EXISTS messenger_themes_select ON public.messenger_themes;
CREATE POLICY messenger_labels_authenticated ON public.messenger_labels
  FOR SELECT TO authenticated USING (true);
CREATE POLICY messenger_themes_authenticated ON public.messenger_themes
  FOR SELECT TO authenticated USING (true);

-- ── system_cache ── admin only
DROP POLICY IF EXISTS system_cache_select ON public.system_cache;
CREATE POLICY system_cache_admin_only ON public.system_cache
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());
