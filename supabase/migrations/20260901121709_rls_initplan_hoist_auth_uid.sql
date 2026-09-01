-- Applied to production 2026-09-01 as schema_migrations version 20260901121709
-- (registered name: 20260901_rls_initplan_hoist_auth_uid).
--
-- Phase 4 / 1: hoist auth.uid() out of per-row RLS evaluation.
--
-- WHAT: 15 policies across 13 tables called auth.uid() bare. Postgres treats a
-- bare STABLE function reference in an RLS qual as a per-row expression; wrapped
-- as (SELECT auth.uid()) it becomes an InitPlan, evaluated once per query.
-- Semantics are identical: auth.uid() reads a session GUC and cannot vary by row.
--
-- WHY IT IS NOT COSMETIC: two of these tables are hot.
--   tournament_payouts   4,189 rows, 1,441,841 lifetime index scans,
--                        and its SELECT policy called auth.uid() THREE times per row.
--   vip_points_carry       791 rows,    91,662 lifetime index scans.
-- The rest are small today; the fix is free and stops the cost being latent.
--
-- ALTER POLICY, not DROP+CREATE: ALTER changes only the expressions. It cannot
-- widen the role list or change the command through a transcription mistake,
-- and it leaves no window in which the table is unprotected.
--
-- ROLLBACK: re-run each ALTER with "(SELECT auth.uid())" replaced by "auth.uid()".
-- No data is touched by this migration.

ALTER POLICY cashier_operations_insert_own ON public.cashier_operations
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY club_creation_requests_read_own ON public.club_creation_requests
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY club_join_idempotency_read_own ON public.club_join_idempotency
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY club_opening_funding_owner_read ON public.club_opening_setup_funding
  USING (
    (EXISTS ( SELECT 1 FROM clubs c
               WHERE c.id = club_opening_setup_funding.club_id
                 AND c.owner_id = (SELECT auth.uid()) ))
    OR
    (EXISTS ( SELECT 1 FROM profiles p
               WHERE p.id = (SELECT auth.uid())
                 AND p.role = ANY (ARRAY['admin'::text, 'superadmin'::text, 'god'::text]) ))
  );

ALTER POLICY club_opening_setups_owner_read ON public.club_opening_setups
  USING (
    (EXISTS ( SELECT 1 FROM clubs c
               WHERE c.id = club_opening_setups.club_id
                 AND c.owner_id = (SELECT auth.uid()) ))
    OR
    (EXISTS ( SELECT 1 FROM profiles p
               WHERE p.id = (SELECT auth.uid())
                 AND p.role = ANY (ARRAY['admin'::text, 'superadmin'::text, 'god'::text]) ))
  );

ALTER POLICY leaderboard_batches_funding_owner_read ON public.leaderboard_payout_batches
  USING (
    (EXISTS ( SELECT 1 FROM clubs club
               WHERE club.id = leaderboard_payout_batches.club_id
                 AND club.owner_id = (SELECT auth.uid()) ))
    OR
    (EXISTS ( SELECT 1 FROM profiles profile
               WHERE profile.id = (SELECT auth.uid())
                 AND profile.role = ANY (ARRAY['admin'::text, 'superadmin'::text, 'god'::text]) ))
  );

ALTER POLICY leaderboard_failures_funding_owner_read ON public.leaderboard_payout_failures
  USING (
    (EXISTS ( SELECT 1 FROM clubs club
               WHERE club.id = leaderboard_payout_failures.club_id
                 AND club.owner_id = (SELECT auth.uid()) ))
    OR
    (EXISTS ( SELECT 1 FROM profiles profile
               WHERE profile.id = (SELECT auth.uid())
                 AND profile.role = ANY (ARRAY['admin'::text, 'superadmin'::text, 'god'::text]) ))
  );

ALTER POLICY player_search_preferences_own ON public.player_search_preferences
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY "Users can see own rate limits" ON public.rate_limits
  USING (user_id = (SELECT auth.uid()));

-- three bare auth.uid() calls per row on a table with 1.44M lifetime index scans
ALTER POLICY tpay_read_self_field_or_staff ON public.tournament_payouts
  USING (
    (user_id = (SELECT auth.uid()))
    OR (EXISTS ( SELECT 1 FROM tournament_players tp
                  WHERE tp.tournament_id = tournament_payouts.tournament_id
                    AND tp.user_id = (SELECT auth.uid()) ))
    OR (EXISTS ( SELECT 1 FROM tournaments t
                  WHERE t.id = tournament_payouts.tournament_id
                    AND t.club_id IS NOT NULL
                    AND fn_is_club_admin_uid(t.club_id) ))
  );

ALTER POLICY user_lobby_filters_delete_own ON public.user_lobby_filters
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY user_lobby_filters_insert_own ON public.user_lobby_filters
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY user_lobby_filters_select_own ON public.user_lobby_filters
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY user_lobby_filters_update_own ON public.user_lobby_filters
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY vip_points_carry_read_own ON public.vip_points_carry
  USING (user_id = (SELECT auth.uid()));

-- Post-apply assertion: the migration aborts on its own assumption violation.
DO $$
DECLARE
  v_remaining int;
BEGIN
  SELECT count(*) INTO v_remaining
  FROM pg_policies
  WHERE schemaname = 'public'
    AND regexp_count(lower(coalesce(qual,'') || ' || ' || coalesce(with_check,'')),
                     'auth\.(uid|role|jwt|email)\(\)')
      > regexp_count(lower(coalesce(qual,'') || ' || ' || coalesce(with_check,'')),
                     'select auth\.(uid|role|jwt|email)\(\)');

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION
      'auth_rls_initplan: expected 0 policies with an unhoisted auth.* call, found %',
      v_remaining;
  END IF;
END $$;
