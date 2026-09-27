-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420013129 "phase6_1_1_lockdown_pii_and_auth_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e2f8b0e6ff6f052620f2828dafae320b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 6.1.1 — Step 2 of 4: lock down PII / auth-bypass / DM tables.
-- These had USING (true) policies that allowed anonymous reads — critical leaks.
-- ============================================================================

-- ── sms_otp_codes ── HARD LOCK. Only service_role (BYPASSRLS) can read.
DROP POLICY IF EXISTS sms_otp_codes_select ON public.sms_otp_codes;
-- (no replacement — tokens are accessed only via SECURITY DEFINER RPCs)

-- ── direct_messages ── only sender or recipient (or admin)
DROP POLICY IF EXISTS patch_maintain_access ON public.direct_messages;
CREATE POLICY direct_messages_self_select ON public.direct_messages
  FOR SELECT TO authenticated
  USING (sender_id = auth.uid() OR recipient_id = auth.uid() OR public.fn_is_platform_admin());
CREATE POLICY direct_messages_self_insert ON public.direct_messages
  FOR INSERT TO authenticated
  WITH CHECK (sender_id = auth.uid());

-- ── friend_requests ── only sender or recipient (or admin)
DROP POLICY IF EXISTS patch_maintain_access ON public.friend_requests;
CREATE POLICY friend_requests_self_select ON public.friend_requests
  FOR SELECT TO authenticated
  USING (sender_id = auth.uid() OR recipient_id = auth.uid() OR public.fn_is_platform_admin());
CREATE POLICY friend_requests_self_write ON public.friend_requests
  FOR INSERT TO authenticated
  WITH CHECK (sender_id = auth.uid());
CREATE POLICY friend_requests_self_update ON public.friend_requests
  FOR UPDATE TO authenticated
  USING (sender_id = auth.uid() OR recipient_id = auth.uid())
  WITH CHECK (sender_id = auth.uid() OR recipient_id = auth.uid());

-- ── pending_calls ── service-role only
DROP POLICY IF EXISTS patch_maintain_access ON public.pending_calls;
CREATE POLICY pending_calls_admin_only ON public.pending_calls
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── purchase_history ── self-only (or admin)
DROP POLICY IF EXISTS ph_sel ON public.purchase_history;
CREATE POLICY purchase_history_self_select ON public.purchase_history
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());

-- ── user_devices ── self-only
DROP POLICY IF EXISTS ud_sel ON public.user_devices;
CREATE POLICY user_devices_self_select ON public.user_devices
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());

-- ── notification_preferences ── self-only
DROP POLICY IF EXISTS np_sel ON public.notification_preferences;
CREATE POLICY notification_preferences_self_select ON public.notification_preferences
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());

-- ── user_bookmarks ── self-only
DROP POLICY IF EXISTS ub_sel ON public.user_bookmarks;
CREATE POLICY user_bookmarks_self_select ON public.user_bookmarks
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());

-- ── user_notifications ── self-only
DROP POLICY IF EXISTS un_sel ON public.user_notifications;
CREATE POLICY user_notifications_self_select ON public.user_notifications
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());

-- ── qr_code_scans ── admin only
DROP POLICY IF EXISTS "Venue staff can view scans" ON public.qr_code_scans;
CREATE POLICY qr_code_scans_admin_only ON public.qr_code_scans
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── commander_leads ── admin only (sales PII)
DROP POLICY IF EXISTS "Service role can manage leads" ON public.commander_leads;
CREATE POLICY commander_leads_admin_only ON public.commander_leads
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── commander_onboarding_leads ── admin only (sales PII)
DROP POLICY IF EXISTS commander_onboarding_leads_select ON public.commander_onboarding_leads;
CREATE POLICY commander_onboarding_leads_admin_only ON public.commander_onboarding_leads
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── live_game_confirmations ── self / admin
DROP POLICY IF EXISTS patch_maintain_access ON public.live_game_confirmations;
CREATE POLICY live_game_confirmations_self_select ON public.live_game_confirmations
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());

-- ── pwa_prompt_log ── service / admin only
DROP POLICY IF EXISTS "Service role full access" ON public.pwa_prompt_log;
CREATE POLICY pwa_prompt_log_admin_only ON public.pwa_prompt_log
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── promo_codes_used ── self / admin
DROP POLICY IF EXISTS pcu_sel ON public.promo_codes_used;
CREATE POLICY promo_codes_used_self_select ON public.promo_codes_used
  FOR SELECT TO authenticated
  USING (
    public.fn_is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name='promo_codes_used' AND c.column_name='user_id'
    ) AND user_id = auth.uid()
  );
