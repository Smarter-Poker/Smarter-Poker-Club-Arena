-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419030151 "phase22_audit_enrich_high_risk"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2b6dcba689a8e79a230dd0c3f0debe85 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Enrich audit table with structural analysis columns for HIGH-risk functions
ALTER TABLE public.phase22_secdef_grant_audit
  ADD COLUMN IF NOT EXISTS has_auth_uid_ref     boolean,
  ADD COLUMN IF NOT EXISTS has_admin_check      boolean,
  ADD COLUMN IF NOT EXISTS writes_profiles      boolean,
  ADD COLUMN IF NOT EXISTS writes_wallets       boolean,
  ADD COLUMN IF NOT EXISTS writes_diamond_col   boolean,
  ADD COLUMN IF NOT EXISTS suggested_pattern    text;

COMMENT ON COLUMN public.phase22_secdef_grant_audit.suggested_pattern IS
  'Suggested remediation pattern: REVOKE_ANON (safest, break-if-client-calls), ADD_AUTH_UID_GUARD (best for p_user_id funcs), SERVICE_ROLE_ONLY (for webhook-only funcs), LEAVE_ALONE (requires deeper review)';

-- Populate from body analysis
UPDATE public.phase22_secdef_grant_audit a
   SET has_auth_uid_ref   = (body ~* 'auth\.uid\s*\('),
       has_admin_check    = (body ~* 'is_god_mode|is_club_admin|is_union_admin|is_union_member'),
       writes_profiles    = (body ~* 'update\s+profiles\s+set'),
       writes_wallets     = (body ~* 'update\s+wallets|insert\s+into\s+wallets'),
       writes_diamond_col = (body ~* 'set\s+diamonds\s*=|set\s+diamond_balance\s*='),
       suggested_pattern  = CASE
           -- Already has auth.uid() — probably just needs stricter argument check
           WHEN (body ~* 'auth\.uid\s*\(') AND (body ~* 'raise exception')
             THEN 'ADD_AUTH_UID_GUARD (strengthen existing check)'
           -- Stripe/webhook pattern — service_role only
           WHEN (a.function_name ~* 'stripe|webhook|activate_vip|award_purchase')
             THEN 'SERVICE_ROLE_ONLY (webhook path — should never be anon-callable)'
           -- Admin-facing
           WHEN (a.function_name ~* 'atomic_cancel_tournament|mass_fund_horses|distribute_tournament_prizes|generate_period|execute_commission_payout')
             THEN 'SERVICE_ROLE_ONLY (admin-triggered only)'
           -- Classic p_user_id pattern — add guard
           WHEN (a.function_sig ~* 'p_user_id uuid' AND a.function_sig !~* 'p_from_user_id')
             THEN 'ADD_AUTH_UID_GUARD (auth.uid() must match p_user_id)'
           -- Tournament register — usually the current user
           WHEN (a.function_name ~* 'register_for_tournament|tournament_register|tournament_unregister')
             THEN 'ADD_AUTH_UID_GUARD (registrant must be caller)'
           -- Pay-out-to-someone-else
           WHEN (a.function_name ~* 'transfer_chips|atomic_pay_agent|fn_union_send')
             THEN 'REVIEW_CALL_SITES (admin-vs-user caller uncertain)'
           ELSE 'REVIEW_CALL_SITES (needs codebase grep to decide)'
       END
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL (SELECT pg_get_functiondef(p.oid) AS body) x
 WHERE n.nspname = 'public'
   AND p.proname = a.function_name
   AND pg_get_function_arguments(p.oid) = a.function_sig
   AND a.risk_level = 'HIGH';

-- Summary breakdown
SELECT suggested_pattern, COUNT(*) AS n
  FROM public.phase22_secdef_grant_audit
 WHERE risk_level = 'HIGH' AND resolved_at IS NULL
 GROUP BY suggested_pattern
 ORDER BY n DESC;
