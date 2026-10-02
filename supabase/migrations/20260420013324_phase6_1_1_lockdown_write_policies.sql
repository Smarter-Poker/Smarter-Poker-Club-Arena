-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420013324 "phase6_1_1_lockdown_write_policies"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2597b209d360070e9b99f4fc8de6b6d7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 6.1.1 — Supplementary: drop wide-open UPDATE/DELETE policies that
-- remained after the initial SELECT-focused lockdown. These allowed anon/public
-- to modify critical financial, auth, and log data — a higher-severity leak
-- than the read-side leaks.
-- Writes to these tables should go through SECURITY DEFINER RPCs from trusted
-- server-side paths only; service_role (BYPASSRLS) handles legitimate writes.
-- ============================================================================

-- club_members
DROP POLICY IF EXISTS "Members can view club members" ON public.club_members;
DROP POLICY IF EXISTS anon_update_club_members_rake ON public.club_members;

-- commander_onboarding_leads
DROP POLICY IF EXISTS commander_onboarding_leads_delete ON public.commander_onboarding_leads;
DROP POLICY IF EXISTS commander_onboarding_leads_update ON public.commander_onboarding_leads;

-- commander_player_reputation
DROP POLICY IF EXISTS commander_player_reputation_delete ON public.commander_player_reputation;
DROP POLICY IF EXISTS commander_player_reputation_update ON public.commander_player_reputation;

-- commander_player_reputation_scores
DROP POLICY IF EXISTS commander_player_reputation_scores_delete ON public.commander_player_reputation_scores;
DROP POLICY IF EXISTS commander_player_reputation_scores_update ON public.commander_player_reputation_scores;

-- commander_rate_limits
DROP POLICY IF EXISTS commander_rate_limits_delete ON public.commander_rate_limits;
DROP POLICY IF EXISTS commander_rate_limits_update ON public.commander_rate_limits;

-- commander_system_log
DROP POLICY IF EXISTS commander_system_log_delete ON public.commander_system_log;
DROP POLICY IF EXISTS commander_system_log_update ON public.commander_system_log;

-- notification_prompt_log
DROP POLICY IF EXISTS notification_prompt_log_delete ON public.notification_prompt_log;
DROP POLICY IF EXISTS notification_prompt_log_update ON public.notification_prompt_log;

-- rake_history — financial writes must be service-role only
DROP POLICY IF EXISTS rake_history_delete ON public.rake_history;
DROP POLICY IF EXISTS rake_history_update ON public.rake_history;

-- rakeback_distributions — financial
DROP POLICY IF EXISTS rakeback_distributions_delete ON public.rakeback_distributions;
DROP POLICY IF EXISTS rakeback_distributions_update ON public.rakeback_distributions;

-- sandbox_bookmarks — user writes should be owner-scoped only
DROP POLICY IF EXISTS sandbox_bookmarks_delete ON public.sandbox_bookmarks;
DROP POLICY IF EXISTS sandbox_bookmarks_update ON public.sandbox_bookmarks;
CREATE POLICY sandbox_bookmarks_self_write ON public.sandbox_bookmarks
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY sandbox_bookmarks_self_delete ON public.sandbox_bookmarks
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- sandbox_saved_hands — user writes must be owner-scoped
DROP POLICY IF EXISTS sandbox_saved_hands_delete ON public.sandbox_saved_hands;
DROP POLICY IF EXISTS sandbox_saved_hands_update ON public.sandbox_saved_hands;
DROP POLICY IF EXISTS ssh_del ON public.sandbox_saved_hands;
DROP POLICY IF EXISTS ssh_upd ON public.sandbox_saved_hands;
CREATE POLICY sandbox_saved_hands_self_write ON public.sandbox_saved_hands
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY sandbox_saved_hands_self_delete ON public.sandbox_saved_hands
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- settlement_invoices — financial; writes service-role only
DROP POLICY IF EXISTS settlement_invoices_delete ON public.settlement_invoices;
DROP POLICY IF EXISTS settlement_invoices_update ON public.settlement_invoices;

-- settlement_locks — financial
DROP POLICY IF EXISTS settlement_locks_delete ON public.settlement_locks;
DROP POLICY IF EXISTS settlement_locks_update ON public.settlement_locks;

-- signup_abuse_log — operational
DROP POLICY IF EXISTS signup_abuse_log_delete ON public.signup_abuse_log;
DROP POLICY IF EXISTS signup_abuse_log_update ON public.signup_abuse_log;

-- sms_otp_codes — CRITICAL auth. No client-side writes.
DROP POLICY IF EXISTS sms_otp_codes_delete ON public.sms_otp_codes;
DROP POLICY IF EXISTS sms_otp_codes_update ON public.sms_otp_codes;

-- union_rakeback_log — financial
DROP POLICY IF EXISTS union_rakeback_log_delete ON public.union_rakeback_log;
DROP POLICY IF EXISTS union_rakeback_log_update ON public.union_rakeback_log;

-- user_devices — user-owned; self-writes only
DROP POLICY IF EXISTS ud_upd ON public.user_devices;
CREATE POLICY user_devices_self_update ON public.user_devices
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
