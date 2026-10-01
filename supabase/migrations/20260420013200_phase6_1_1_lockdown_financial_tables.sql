-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420013200 "phase6_1_1_lockdown_financial_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5a799280343ecabd8c792729e564c403 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 6.1.1 — Step 3 of 4: lock down financial / club-scoped tables.
-- Restrict club-financial reads to club members + platform admins only.
-- ============================================================================

-- ── club_members ── drop the anon-readable rake leak; keep authenticated read
DROP POLICY IF EXISTS anon_select_club_members_rake ON public.club_members;
DROP POLICY IF EXISTS auth_select_club_members ON public.club_members;
DROP POLICY IF EXISTS "Public read access" ON public.club_members;
-- Replace with same-club-only visibility for authenticated users
CREATE POLICY club_members_same_club_select ON public.club_members
  FOR SELECT TO authenticated
  USING (
    public.fn_is_platform_admin()
    OR user_id = auth.uid()
    OR public.fn_is_club_member_uid(club_id)
  );

-- ── rake_records ── club-members + admins only
DROP POLICY IF EXISTS anon_select_rake_records ON public.rake_records;
DROP POLICY IF EXISTS auth_select_rake_records ON public.rake_records;
DROP POLICY IF EXISTS rake_select_auth ON public.rake_records;
CREATE POLICY rake_records_club_member_select ON public.rake_records
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin() OR public.fn_is_club_member_uid(club_id));

-- ── rake_history ── club-members + admins only
DROP POLICY IF EXISTS rake_history_select ON public.rake_history;
CREATE POLICY rake_history_club_member_select ON public.rake_history
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin() OR public.fn_is_club_member_uid(club_id));

-- ── rakeback_distributions ── club-members + admins only
DROP POLICY IF EXISTS rakeback_distributions_select ON public.rakeback_distributions;
CREATE POLICY rakeback_distributions_club_member_select ON public.rakeback_distributions
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin() OR public.fn_is_club_member_uid(club_id));

-- ── union_rakeback_log ── union-member-club-admin + platform admin only
DROP POLICY IF EXISTS union_rakeback_log_select ON public.union_rakeback_log;
CREATE POLICY union_rakeback_log_union_select ON public.union_rakeback_log
  FOR SELECT TO authenticated
  USING (
    public.fn_is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM public.union_clubs uc
      JOIN public.club_members cm ON cm.club_id = uc.club_id
      WHERE uc.union_id = union_rakeback_log.union_id
        AND cm.user_id = auth.uid()
        AND cm.role IN ('owner','admin','manager')
    )
  );

-- ── settlement_invoices ── club-admins + platform admin only
DROP POLICY IF EXISTS settlement_invoices_select ON public.settlement_invoices;
CREATE POLICY settlement_invoices_club_admin_select ON public.settlement_invoices
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin() OR public.fn_is_club_admin_uid(club_id));

-- ── settlement_locks ── club-admins + platform admin only
DROP POLICY IF EXISTS settlement_locks_select ON public.settlement_locks;
CREATE POLICY settlement_locks_club_admin_select ON public.settlement_locks
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin() OR public.fn_is_club_admin_uid(club_id));

-- ── bbj_payouts ── club-members only (their own club's BBJ payouts)
DROP POLICY IF EXISTS bbj_payouts_public_read ON public.bbj_payouts;
-- bbj_payouts has no club_id column directly; check via bbj_pools join if it exists.
-- Conservative: admin-only until a proper scoping column is added.
CREATE POLICY bbj_payouts_admin_only ON public.bbj_payouts
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());

-- ── bbj_payout_recipients ── self + admin only
DROP POLICY IF EXISTS bbj_payout_recipients_public_read ON public.bbj_payout_recipients;
CREATE POLICY bbj_payout_recipients_self_select ON public.bbj_payout_recipients
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());

-- ── disputes ── parties + club-admins + platform admin only
DROP POLICY IF EXISTS disputes_select ON public.disputes;
CREATE POLICY disputes_party_or_admin_select ON public.disputes
  FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin() OR public.fn_is_club_admin_uid(club_id));

-- ── commander_player_reputation ── self + club-admin + platform admin
DROP POLICY IF EXISTS commander_player_reputation_select ON public.commander_player_reputation;
CREATE POLICY commander_player_reputation_self_select ON public.commander_player_reputation
  FOR SELECT TO authenticated
  USING (player_id = auth.uid() OR public.fn_is_platform_admin());

-- ── commander_player_reputation_scores ── self + admin
DROP POLICY IF EXISTS commander_player_reputation_scores_select ON public.commander_player_reputation_scores;
CREATE POLICY commander_player_reputation_scores_self_select ON public.commander_player_reputation_scores
  FOR SELECT TO authenticated
  USING (player_id = auth.uid() OR public.fn_is_platform_admin());

-- ── sandbox_saved_hands ── self + admin
DROP POLICY IF EXISTS sandbox_saved_hands_select ON public.sandbox_saved_hands;
DROP POLICY IF EXISTS ssh_sel ON public.sandbox_saved_hands;
CREATE POLICY sandbox_saved_hands_self_select ON public.sandbox_saved_hands
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());

-- ── sandbox_bookmarks ── self + admin
DROP POLICY IF EXISTS sandbox_bookmarks_select ON public.sandbox_bookmarks;
CREATE POLICY sandbox_bookmarks_self_select ON public.sandbox_bookmarks
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());

-- ── hand_players ── self + admin (other players reveal at hand-end via game RPC)
DROP POLICY IF EXISTS hand_players_all ON public.hand_players;
CREATE POLICY hand_players_self_select ON public.hand_players
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());
