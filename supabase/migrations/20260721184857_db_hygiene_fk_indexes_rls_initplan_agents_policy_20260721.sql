-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721184857 "db_hygiene_fk_indexes_rls_initplan_agents_policy_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a71db0d6e034e3405cef43c5de9327eb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Task #57 (batch 2): covering indexes for unindexed FKs, auth.uid() init-plan
-- wrapping, and agents SELECT-policy consolidation.

-- 1. Covering indexes for the 4 unindexed foreign keys (perf advisor).
CREATE INDEX IF NOT EXISTS idx_agg_team_team_id ON public.agg_team (team_id);
CREATE INDEX IF NOT EXISTS idx_commander_home_join_attempts_group_id ON public.commander_home_join_attempts (group_id);
CREATE INDEX IF NOT EXISTS idx_live_ban_audit_banned_by ON public.live_ban_audit (banned_by);
CREATE INDEX IF NOT EXISTS idx_trivia_question_reports_user_id ON public.trivia_question_reports (user_id);

-- 2. mlb_hr_bets: wrap auth.uid() in (SELECT ...) so it is evaluated once per query
--    instead of once per row (auth_rls_initplan advisor). Semantics unchanged.
DROP POLICY IF EXISTS mlb_hr_bets_select_own ON public.mlb_hr_bets;
CREATE POLICY mlb_hr_bets_select_own ON public.mlb_hr_bets FOR SELECT
  USING ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS mlb_hr_bets_insert_own ON public.mlb_hr_bets;
CREATE POLICY mlb_hr_bets_insert_own ON public.mlb_hr_bets FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS mlb_hr_bets_update_own ON public.mlb_hr_bets;
CREATE POLICY mlb_hr_bets_update_own ON public.mlb_hr_bets FOR UPDATE
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS mlb_hr_bets_delete_own ON public.mlb_hr_bets;
CREATE POLICY mlb_hr_bets_delete_own ON public.mlb_hr_bets FOR DELETE
  USING ((SELECT auth.uid()) = user_id);

-- 3. agents: merge the two permissive PUBLIC SELECT policies ("Agents can read own
--    agent row" + agents_club_owner_read) into one. Permissive policies are OR'd, so
--    a single policy with the OR of both USING clauses is semantically identical and
--    removes the multiple_permissive_policies findings. The service_role policy
--    (agents_svc, USING true) is intentionally left as-is.
DROP POLICY IF EXISTS "Agents can read own agent row" ON public.agents;
DROP POLICY IF EXISTS agents_club_owner_read ON public.agents;
CREATE POLICY agents_read_own_or_club_manager ON public.agents FOR SELECT
  USING (
    (SELECT auth.uid()) = user_id
    OR EXISTS (
      SELECT 1 FROM clubs c
      WHERE c.id = agents.club_id
        AND (
          c.owner_id = (SELECT auth.uid())
          OR EXISTS (
            SELECT 1 FROM club_members cm
            WHERE cm.club_id = agents.club_id
              AND cm.user_id = (SELECT auth.uid())
              AND cm.role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text])
          )
        )
    )
  );
