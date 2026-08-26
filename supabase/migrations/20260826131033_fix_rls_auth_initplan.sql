-- ══════════════════════════════════════════════════════════════════════════════
-- Migration: 20260826131033_fix_rls_auth_initplan.sql
--
-- Purpose: Fix two RLS policies flagged by the Supabase performance advisor
-- as auth_rls_initplan anti-patterns. Both policies evaluate auth.uid() as a
-- volatile function call, which Postgres re-evaluates for EVERY ROW scanned,
-- making the policy O(n) in table cardinality.
--
-- The fix: wrap auth.uid() in (SELECT auth.uid()). This forces Postgres to
-- evaluate it once per query plan as a stable InitPlan sub-expression, making
-- the policy O(1) regardless of how many rows are scanned.
--
-- Impact on table_chat: this table is appended to on every player message and
-- read on every table page load. At a busy table with hundreds of chat rows,
-- the unfixed policy re-evaluates auth.uid() hundreds of times per SELECT.
--
-- Tables affected:
--   public.table_chat        — policy: table_chat_insert
--   public.vip_reward_claims — policy: vip_reward_claims_select_own
--
-- Safe to run: DROP POLICY + CREATE POLICY is instantaneous on both tables.
-- No data is modified. RLS behavior is semantically identical — only the
-- evaluation strategy changes.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── table_chat ────────────────────────────────────────────────────────────────
-- Before: WITH CHECK ((user_id = auth.uid()) AND ...)
--         auth.uid() evaluated per row
-- After:  WITH CHECK ((user_id = (SELECT auth.uid())) AND ...)
--         auth.uid() evaluated once per query

DROP POLICY IF EXISTS "table_chat_insert" ON public.table_chat;

CREATE POLICY "table_chat_insert"
  ON public.table_chat
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (user_id = (SELECT auth.uid()))
    AND (message_type = 'player')
    AND (NOT fn_table_chat_is_silenced(table_id))
  );

-- ── vip_reward_claims ────────────────────────────────────────────────────────
-- Before: USING (user_id = auth.uid())
--         auth.uid() evaluated per row
-- After:  USING (user_id = (SELECT auth.uid()))
--         auth.uid() evaluated once per query

DROP POLICY IF EXISTS "vip_reward_claims_select_own" ON public.vip_reward_claims;

CREATE POLICY "vip_reward_claims_select_own"
  ON public.vip_reward_claims
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

COMMENT ON POLICY "table_chat_insert" ON public.table_chat IS
  'auth_rls_initplan fix 2026-08-26: auth.uid() wrapped in (SELECT ...) so '
  'Postgres evaluates it once per query, not once per row.';

COMMENT ON POLICY "vip_reward_claims_select_own" ON public.vip_reward_claims IS
  'auth_rls_initplan fix 2026-08-26: auth.uid() wrapped in (SELECT ...) so '
  'Postgres evaluates it once per query, not once per row.';
