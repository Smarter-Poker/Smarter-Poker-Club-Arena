-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419030347 "phase22_remediation_playbook"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 330e87ad63931cbcdc457ecac27ca47f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — Security remediation playbook
--  -----------------------------------------------------------------------
--  Single source of truth for the remaining security work. Dan can query
--  this table to see all pending remediations with ready-to-run SQL.
--
--  This migration ONLY creates documentation — no production functions
--  or tables are changed.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.phase22_remediation_playbook (
    priority int PRIMARY KEY,
    category text NOT NULL,
    batch_size int,
    description text NOT NULL,
    suggested_pattern text NOT NULL,
    example_sql text,
    estimated_risk text,
    estimated_effort text
);

ALTER TABLE public.phase22_remediation_playbook ENABLE ROW LEVEL SECURITY;
CREATE POLICY phase22_playbook_nobody ON public.phase22_remediation_playbook FOR ALL USING (false);
REVOKE ALL ON public.phase22_remediation_playbook FROM anon, authenticated;
GRANT  SELECT, INSERT, UPDATE ON public.phase22_remediation_playbook TO service_role;

INSERT INTO public.phase22_remediation_playbook VALUES
  (1, 'Stripe webhook functions', 2,
   'activate_vip and award_purchase_diamonds take Stripe-specific params (stripe_subscription_id, stripe_session_id, amount_paid). These are UNAMBIGUOUSLY webhook-only — no client-side code path can call them with real Stripe data, so any anon call is guaranteed malicious.',
   'REVOKE FROM PUBLIC, anon, authenticated',
   E'REVOKE EXECUTE ON FUNCTION public.activate_vip(uuid, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;\nREVOKE EXECUTE ON FUNCTION public.award_purchase_diamonds(uuid, integer, text, numeric) FROM PUBLIC, anon, authenticated;',
   'LOW — webhook path uses service_role key, unaffected by revoke',
   '5 minutes — 2 REVOKE statements + test Stripe test-mode webhook'),

  (2, 'Admin-only tournament/settlement functions', 3,
   'atomic_cancel_tournament, distribute_tournament_prizes, generate_period_settlement are all admin actions triggered from a server-side admin UI. Should never be client-callable.',
   'REVOKE FROM PUBLIC, anon, authenticated',
   E'REVOKE EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid, uuid) FROM PUBLIC, anon, authenticated;\nREVOKE EXECUTE ON FUNCTION public.distribute_tournament_prizes(uuid) FROM PUBLIC, anon, authenticated;\nREVOKE EXECUTE ON FUNCTION public.generate_period_settlement(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;',
   'LOW — admin UI uses server routes + service_role',
   '10 minutes — 3 REVOKE statements + smoke-test admin flows'),

  (3, 'Economy functions with p_user_id (auth.uid() guard)', 63,
   'Functions that take p_user_id as first arg and mutate that users balance/state. Current behavior: blindly trusts the arg. Fix: wrap body with `IF auth.uid() IS NULL OR (auth.uid() <> p_user_id AND NOT is_god_mode()) THEN RAISE EXCEPTION using hint = ''UNAUTHORIZED_FOR_USER''; END IF;`. This preserves current call sites (where the authenticated users own ID is passed) while blocking exploitation.',
   'ADD_AUTH_UID_GUARD at top of function body',
   E'-- Template to wrap around existing body:\nCREATE OR REPLACE FUNCTION public.<fname>(<args>)\nRETURNS <type> LANGUAGE plpgsql SECURITY DEFINER\nSET search_path TO ''public'', ''extensions'' AS $$\nBEGIN\n  -- Phase 22 guard: caller must match p_user_id or be god-mode admin\n  IF auth.uid() IS NULL OR (auth.uid() <> p_user_id AND NOT is_god_mode()) THEN\n    RAISE EXCEPTION ''UNAUTHORIZED_FOR_USER'' USING HINT = ''Function requires auth.uid() = p_user_id'';\n  END IF;\n  -- ... original body ...\nEND; $$;\n\n-- Get full list of affected functions:\nSELECT function_name, function_sig FROM phase22_secdef_grant_audit\n WHERE suggested_pattern LIKE ''ADD_AUTH_UID_GUARD%'' AND resolved_at IS NULL;',
   'MEDIUM — if any API route passes a user_id other than the caller, it will break. Verify before each function.',
   '2-4 hours — systematic pass, one migration per ~10 functions, smoke test between batches'),

  (4, 'Functions needing call-site review (admin-vs-user uncertain)', 3,
   'transfer_chips, atomic_pay_agent_settlement, fn_union_send_chips_to_club. Could be called by admins transferring on behalf of users OR by users themselves. Needs codebase grep.',
   'REVIEW_CALL_SITES',
   E'-- Grep for call sites:\n--   grep -rE "rpc\\(.?transfer_chips.?|rpc\\(.?atomic_pay_agent.?|rpc\\(.?fn_union_send" pages/ src/\n-- Decide:\n--   A. Always caller = transferring user? → ADD_AUTH_UID_GUARD (p_from_user_id = auth.uid())\n--   B. Always admin? → REVOKE FROM anon/authenticated, service_role only\n--   C. Mix? → Add role check: auth.uid() = from_user OR is_club_admin(p_club_id)',
   'MEDIUM',
   '1 hour — grep + decision + one migration per function'),

  (5, 'REVIEW_CALL_SITES functions', 41,
   'HIGH-risk functions not fitting the other patterns cleanly. Each needs individual review.',
   'REVIEW_CALL_SITES',
   E'SELECT function_name, function_sig FROM phase22_secdef_grant_audit\n WHERE suggested_pattern LIKE ''REVIEW_CALL_SITES%'' AND resolved_at IS NULL\n ORDER BY function_name;',
   'UNKNOWN',
   '4-8 hours — per-function analysis'),

  (6, 'Table RLS gaps', 3,
   'game_live_history (979K rows), hand_state_snapshots (35K rows), user_notification_preferences (empty). See phase22_rls_table_audit for full details and per-table recommendations.',
   'ENABLE RLS + add policies per table',
   E'SELECT table_name, risk_level, recommendation FROM phase22_rls_table_audit\n WHERE resolved_at IS NULL AND risk_level IN (''CRITICAL'',''HIGH'');',
   'HIGH — can break live reads',
   '3-6 hours — one migration per table, test in staging'),

  (7, 'View bypassing RLS', 1,
   'mv_hand_histories exposes hole cards via hand_data JSONB. Currently 4 rows (sandbox data). See phase22_view_security_audit for details.',
   'ALTER MV SET (security_invoker = true) or DROP',
   E'-- Option 1: Add security_invoker (but MV refresh runs as postgres so this may not help)\n-- Option 2: REVOKE anon/authenticated SELECT on the MV\nREVOKE SELECT ON public.mv_hand_histories FROM PUBLIC, anon, authenticated;\n-- Option 3: Drop if unused\nDROP MATERIALIZED VIEW IF EXISTS public.mv_hand_histories;',
   'LOW — only 4 sandbox rows, no production impact yet',
   '15 minutes — decide + 1 migration'),

  (8, 'Email enumeration oracle', 1,
   'get_auth_users_by_email(text) lets anon check if any email exists in auth.users. Probably used by Club Commander signup for cross-platform account linking.',
   'RATE_LIMIT or move to service_role',
   E'-- Option A: Move to service_role only (breaks Commander signup UI)\nREVOKE EXECUTE ON FUNCTION public.get_auth_users_by_email(text) FROM PUBLIC, anon, authenticated;\n-- Option B: Accept and add server-side rate limit in /api/commander/auth/*\n-- Option C: Change API to accept signup intent and resolve email server-side',
   'MEDIUM — breaks signup if Option A chosen without API change',
   '30 min to 2 hours depending on option chosen');

COMMENT ON TABLE public.phase22_remediation_playbook IS
  'Phase 22 — ordered remediation playbook for security findings. Priority 1 is lowest-effort/highest-safety; higher priorities require more care. All items have ready-to-apply SQL in the example_sql column.';
