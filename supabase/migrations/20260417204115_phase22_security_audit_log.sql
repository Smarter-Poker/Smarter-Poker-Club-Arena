-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417204115 "phase22_security_audit_log"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1747c4218eed2451168d0c735060853a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — Security audit log
--  -----------------------------------------------------------------------
--  Persistent record of the SECURITY DEFINER function grant audit
--  (2026-04-17). Intentionally creating a table instead of just a report
--  so Dan has this in his own database across tool-environment resets
--  and can track remediation progress.
--
--  Does NOT auto-remediate — each function needs a judgement call about
--  whether auth.uid() enforcement would break a legitimate webhook/cron
--  caller. This is a triage list, not a fix.
--
--  DDL-only. No actual function grants changed by this migration.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.phase22_secdef_grant_audit (
    id              serial PRIMARY KEY,
    audit_date      timestamptz NOT NULL DEFAULT NOW(),
    function_name   text NOT NULL,
    function_sig    text NOT NULL,
    risk_level      text NOT NULL,  -- HIGH | LOW_read | LOW_trigger_or_counter | REVIEW
    notes           text,
    resolved_at     timestamptz,
    resolution      text,
    UNIQUE (audit_date, function_name, function_sig)
);
COMMENT ON TABLE public.phase22_secdef_grant_audit IS
  'Phase 22 — triage list of SECURITY DEFINER functions in public that anon can invoke. Populated once from the 2026-04-17 audit. Use to track remediation (REVOKE grants, add auth.uid() checks, etc).';

-- Lock it down — this is an engineering artifact, not a user-facing table
ALTER TABLE public.phase22_secdef_grant_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY phase22_audit_nobody ON public.phase22_secdef_grant_audit FOR ALL USING (false);

REVOKE ALL ON public.phase22_secdef_grant_audit FROM anon, authenticated;
GRANT  SELECT, INSERT, UPDATE ON public.phase22_secdef_grant_audit TO service_role;
GRANT  USAGE, SELECT ON SEQUENCE public.phase22_secdef_grant_audit_id_seq TO service_role;

-- Populate
INSERT INTO public.phase22_secdef_grant_audit (function_name, function_sig, risk_level, notes)
SELECT
    p.proname,
    pg_get_function_arguments(p.oid),
    CASE
      WHEN p.proname ~* '(add|credit|mint|award|grant|distribute|claim|activate|unlock|transfer|pay|atomic_|redeem|deduct|lock|unlock_chip|wallet|buyin|cashout|commission|rakeback|bonus|diamond|chip|xp|vip|settle|ship|holdout|treasury|promo)'
           AND pg_get_function_arguments(p.oid) ~* 'p_user_id|p_to_user_id|p_player_user_id|p_agent_user_id|p_from_user_id|p_player_id|p_club_id|p_union_id|p_target_user_id|p_recipient|p_tournament_id'
      THEN 'HIGH'
      WHEN p.proname ~* '^(get|is_|has_|fn_get|fn_discover|fn_check|find_|can_view|check_username_available|analyze_|refresh_player_stats)'
      THEN 'LOW_read'
      WHEN p.proname ~* '^(increment_|decrement_|_bump_activity|_count|record_arena|notify|link_|sync_|fn_notify_|fn_prevent_|fn_update_|update_|initialize_|create_user|handle_new_user)$|_trigger$'
      THEN 'LOW_trigger_or_counter'
      ELSE 'REVIEW'
    END,
    'Anon-callable via PUBLIC grant. Accepts privileged params (user_id, club_id, etc). Needs auth.uid() enforcement OR REVOKE FROM anon.'
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.prosecdef = true
   AND has_function_privilege('anon', p.oid, 'execute')
   AND p.proname NOT IN (
       -- Known-safe Phase 22 functions
       'get_home_game_tournaments_for_date'
   )
ON CONFLICT DO NOTHING;
