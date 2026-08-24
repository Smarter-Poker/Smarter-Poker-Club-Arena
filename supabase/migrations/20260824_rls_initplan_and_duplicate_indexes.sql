-- DB perf pass 2026-08-24, part of the global-slowness audit (Dan).
--
-- Supabase performance advisors reported (among 1,432 findings):
--   * 17 policies re-evaluating auth.uid() PER ROW ("auth_rls_initplan").
--     Wrapping the call as (select auth.uid()) makes the planner evaluate it
--     ONCE as an InitPlan instead of once per candidate row — on hot tables
--     like push_subscriptions, tournament_tickets and message_reactions this
--     is the standard Supabase row-scan multiplier fix.
--   * 5 exact-duplicate indexes. Every duplicate taxes each INSERT/UPDATE on
--     its table twice for zero read benefit. Only the copies NOT backing a
--     UNIQUE constraint are dropped (verified against pg_constraint before
--     writing this file).
--
-- Tier 2. Applied to production via Supabase MCP apply_migration on
-- 2026-08-24 before this branch merged (CHECK 17).
--
-- The policy rewrite is mechanical on purpose: for each named policy the
-- current qual/with_check is read from pg_policies and every literal
-- `auth.uid()` becomes `(select auth.uid())`. Policies already using the
-- InitPlan form are not in this list (the advisor only flags the unfixed
-- form, and pg_policies renders the fixed form as `( SELECT auth.uid() ...`,
-- which the replace() cannot match — the operation is idempotent).

DO $$
DECLARE
  p record;
  new_qual text;
  new_check text;
  stmt text;
BEGIN
  FOR p IN
    SELECT tablename, policyname, cmd, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (tablename, policyname) IN (
         ('message_reactions',                 'message_reactions_select'),
         ('message_reactions',                 'message_reactions_write'),
         ('arena_sessions',                    'arena_sessions_own'),
         ('user_bonus_progress',               'user_bonus_progress_own'),
         ('push_subscriptions',                'user reads own push subs'),
         ('push_subscriptions',                'user deletes own push subs'),
         ('challenge_streak_state',            'user reads own streak state'),
         ('chip_requests',                     'chip_requests_read'),
         ('tournament_tickets',                'tournament_tickets_read'),
         ('ca_hand_facts',                     'ca_hand_facts_own_read'),
         ('ca_hand_transfers',                 'ca_hand_transfers_involved_read'),
         ('club_leaderboard_settings',         'club_lb_settings_read'),
         ('club_leaderboard_settings',         'club_lb_settings_write'),
         ('leaderboard_payouts',               'lb_payouts_read'),
         ('tournament_registration_approvals', 'trapp_select_own'),
         ('tournament_registration_approvals', 'trapp_admin_write'),
         ('tournament_deal_votes',             'tdv_insert_own')
       )
  LOOP
    new_qual  := replace(p.qual,       'auth.uid()', '(select auth.uid())');
    new_check := replace(p.with_check, 'auth.uid()', '(select auth.uid())');

    stmt := format('ALTER POLICY %I ON public.%I', p.policyname, p.tablename);
    IF p.qual IS NOT NULL AND p.qual LIKE '%auth.uid()%' THEN
      stmt := stmt || format(' USING (%s)', new_qual);
    END IF;
    IF p.with_check IS NOT NULL AND p.with_check LIKE '%auth.uid()%' THEN
      stmt := stmt || format(' WITH CHECK (%s)', new_check);
    END IF;
    IF stmt LIKE '%USING%' OR stmt LIKE '%WITH CHECK%' THEN
      EXECUTE stmt;
    END IF;
  END LOOP;
END $$;

-- ── Duplicate indexes (non-constraint copies only) ───────────────────────────
DROP INDEX IF EXISTS public.uq_memory_leaderboards_user_mode_level;   -- dup of memory_leaderboards_user_id_game_mode_level_key
DROP INDEX IF EXISTS public.idx_message_reactions_message;            -- dup of message_reactions_message_id_idx
DROP INDEX IF EXISTS public.idx_message_reactions_user;               -- dup of message_reactions_user_id_idx
DROP INDEX IF EXISTS public.spin_bonus_pools_club_uniq;               -- dup of spin_bonus_pools_club_id_key
DROP INDEX IF EXISTS public.uq_vip_feature_usage_user_feature;        -- dup of vip_feature_usage_user_id_feature_key

-- ── Post-apply assertions ─────────────────────────────────────────────────────
DO $$
DECLARE
  v_unfixed bigint;
  v_dupes bigint;
BEGIN
  -- Every targeted policy must now carry the InitPlan form wherever it
  -- references auth.uid() at all.
  SELECT count(*) INTO v_unfixed
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (tablename, policyname) IN (
         ('message_reactions','message_reactions_select'),
         ('message_reactions','message_reactions_write'),
         ('arena_sessions','arena_sessions_own'),
         ('user_bonus_progress','user_bonus_progress_own'),
         ('push_subscriptions','user reads own push subs'),
         ('push_subscriptions','user deletes own push subs'),
         ('challenge_streak_state','user reads own streak state'),
         ('chip_requests','chip_requests_read'),
         ('tournament_tickets','tournament_tickets_read'),
         ('ca_hand_facts','ca_hand_facts_own_read'),
         ('ca_hand_transfers','ca_hand_transfers_involved_read'),
         ('club_leaderboard_settings','club_lb_settings_read'),
         ('club_leaderboard_settings','club_lb_settings_write'),
         ('leaderboard_payouts','lb_payouts_read'),
         ('tournament_registration_approvals','trapp_select_own'),
         ('tournament_registration_approvals','trapp_admin_write'),
         ('tournament_deal_votes','tdv_insert_own')
       )
     AND (
       (qual       IS NOT NULL AND qual       ~ 'auth\.uid\(\)' AND qual       !~ 'SELECT auth\.uid\(\)') OR
       (with_check IS NOT NULL AND with_check ~ 'auth\.uid\(\)' AND with_check !~ 'SELECT auth\.uid\(\)')
     );
  IF v_unfixed <> 0 THEN
    RAISE EXCEPTION '% policies still re-evaluate auth.uid() per row', v_unfixed;
  END IF;

  SELECT count(*) INTO v_dupes
    FROM pg_class
   WHERE relname IN (
     'uq_memory_leaderboards_user_mode_level',
     'idx_message_reactions_message',
     'idx_message_reactions_user',
     'spin_bonus_pools_club_uniq',
     'uq_vip_feature_usage_user_feature'
   );
  IF v_dupes <> 0 THEN
    RAISE EXCEPTION '% duplicate indexes survived the drop', v_dupes;
  END IF;
END $$;

-- ROLLBACK (Tier 2 courtesy):
--   Policies: re-run the DO block with replace('(select auth.uid())',
--   'auth.uid()') — semantics are identical either way; only the plan shape
--   differs. Indexes: recreate from the surviving twin's definition in
--   pg_indexes if ever needed (they were exact duplicates).
