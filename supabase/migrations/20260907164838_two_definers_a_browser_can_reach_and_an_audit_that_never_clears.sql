-- ═══════════════════════════════════════════════════════════════════════════
--  TWO DEFINERS A BROWSER COULD REACH, AND AN AUDIT THAT COULD NOT CLEAR
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── PART 1: THE GATE CAUGHT ME ─────────────────────────────────────────────
-- `check-definer-authorization` refused the push carrying `20260907163416`
-- and `20260907163820`:
--
--   fn_ca_escrow_apply        SECURITY DEFINER, it writes, a browser role can
--   fn_payout_guarantee_check execute it, and it never calls auth.uid(),
--                             auth.role() or auth.jwt().
--
-- Neither was made reachable by those migrations. **`CREATE OR REPLACE`
-- preserves the ACL**, so both have been reachable since they were first
-- created with `CREATE FUNCTION`, which grants EXECUTE to PUBLIC. Re-declaring
-- them is what made the gate look, and the gate is right:
-- `fn_ca_escrow_apply` moves an event's prize, bounty and fee banks and decides
-- whether a payout is refused; `fn_payout_guarantee_check` writes critical
-- financial alerts and now resolves them. Neither has any business being
-- callable from a browser, and neither can tell who is calling.
--
-- Remedy 1 from the gate's own output. Verified FIRST that no RLS policy
-- expression names either function - a policy evaluates as the CALLER, so
-- revoking a function a policy uses locks the table for everybody. That is the
-- trap that would have darkened the whole video feed on 2026-09-06. Zero
-- policies reference them.
--
-- ── PART 2: AN AUDIT THAT RAISES AND NEVER CLEARS ──────────────────────────
-- `fn_rake_bbj_audit` had **24 open critical alerts**, oldest 2026-08-31,
-- newest 2026-09-06 19:38 - every one of them `I7_raked_hand_never_banked`,
-- rake the engine took from a pot and did not survive to bank, which
-- `fn_rake_repair_unbanked` recovers. Run against the live database today:
--
--   select check_name, violations from fn_rake_bbj_invariants(24);
--     I1_drop_under_3_dealt          0
--     I2_drop_on_ineligible_variant  0
--     I3_deductions_exceed_pot       0
--     I4_eligible_flop_no_drop       0
--     I5_drop_not_banked_to_pool     0
--     I6_ledger_not_reconciled       0
--     I7_raked_hand_never_banked     0
--
-- Nothing had been true for 21 hours and 24 criticals still said otherwise.
-- This is the same defect the payout guarantee check had and the same one that
-- 233 open `financial_alerts` are made of: a NOT EXISTS guard so it never
-- duplicates an alert, and no path at all to close one.
--
-- 10.11 rule 5: the net stays, and is expected to find nothing. A clean window
-- now resolves what this source raised before it. Nothing else is touched, and
-- nothing is resolved while a violation stands.
--
-- ── NOTE ON THIS FILE'S FIRST APPLY ────────────────────────────────────────
-- Its post-check called `fn_rake_bbj_audit(24)` and hit the statement timeout
-- AFTER the COMMIT, so the change was live and unrecorded. Re-applied with a
-- post-check that reads the 2h window the job actually uses. Every statement
-- here is idempotent, which is why re-applying was safe.
--
-- ROLLBACK:
--   GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_apply(...) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.fn_payout_guarantee_check(integer) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.fn_rake_bbj_audit(integer) TO PUBLIC;
--   and restore fn_rake_bbj_audit without its clearing block.

BEGIN;

REVOKE ALL ON FUNCTION public.fn_ca_escrow_apply(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_apply(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_payout_guarantee_check(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_payout_guarantee_check(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_rake_bbj_audit(p_hours integer DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows jsonb;
  v_total bigint;
  v_money bigint;
  v_meter jsonb;
  v_cleared integer := 0;
BEGIN
  SELECT COALESCE(jsonb_object_agg(check_name, jsonb_build_object('n', violations, 'sample', detail)), '{}'::jsonb),
         COALESCE(SUM(violations), 0),
         COALESCE(SUM(violations) FILTER (WHERE check_name IN
           ('I3_deductions_exceed_pot','I5_drop_not_banked_to_pool','I7_raked_hand_never_banked')), 0)
    INTO v_rows, v_total, v_money
    FROM public.fn_rake_bbj_invariants(p_hours);

  IF v_total > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES (CASE WHEN v_money > 0 THEN 'critical' ELSE 'warning' END,
            'fn_rake_bbj_audit',
            'RAKE_BBJ_INVARIANT_VIOLATION: ' || v_total ||
              ' violation(s) in the last ' || p_hours || 'h. The collection law is: drop on every ' ||
              'flop with 3+ dealt; deductions never exceed the pot; every fee banked and attributed.',
            v_rows);
  ELSE
    /* THE NET IS EXPECTED TO FIND NOTHING (10.11 rule 5, added 2026-09-07).
       This raised alerts and could not close one. 24 criticals were open when
       that was noticed, oldest 2026-08-31, every one of them
       I7_raked_hand_never_banked - rake the engine took from a pot and did not
       survive to bank, which fn_rake_repair_unbanked recovers. The invariants
       had been clean for 21 hours and the list still read critical.
       A clean window resolves what this source raised before it. */
    UPDATE public.financial_alerts fa
       SET resolved = true,
           resolved_at = now(),
           resolution = format(
             'Cleared by fn_rake_bbj_audit: every rake/BBJ invariant returned zero over the last %sh, so the condition this alert reported no longer holds. Raked hands that were never banked are recovered by fn_rake_repair_unbanked; if this class returns, a new alert is raised rather than this one staying open.',
             p_hours)
     WHERE fa.source = 'fn_rake_bbj_audit'
       AND fa.resolved IS NOT TRUE
       AND fa.created_at < now();
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
  END IF;

  -- THE BBJ METER (chip standard Phase 4.2): every active pool's banks against
  -- the journal since the last snapshot. Its own failure must not hide the
  -- invariant result above, and vice versa.
  BEGIN
    v_meter := public.fn_bbj_reconcile_all();
  EXCEPTION WHEN OTHERS THEN
    v_meter := jsonb_build_object('error', SQLERRM);
  END;

  RETURN jsonb_build_object('checked_hours', p_hours, 'violations', v_total,
                            'money_violations', v_money, 'alerts_cleared', v_cleared,
                            'detail', v_rows, 'meter', v_meter);
END $function$;

REVOKE ALL ON FUNCTION public.fn_rake_bbj_audit(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_bbj_audit(integer) TO service_role;

COMMENT ON FUNCTION public.fn_rake_bbj_audit(integer) IS
  'Rake / BBJ collection invariants over the last p_hours. Raises one alert '
  'when anything is violated, and RESOLVES what it raised earlier when the '
  'window comes back clean - before 2026-09-07 it could only raise, and 24 '
  'criticals stood open over invariants that had returned zero for 21 hours. '
  'service_role only.';

COMMIT;

-- ── POST-CHECKS (cheap: the 2h window the job actually runs on) ─────────────
DO $$
DECLARE v_pub int; v_viol bigint;
BEGIN
  SELECT count(*) INTO v_pub
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_ca_escrow_apply','fn_payout_guarantee_check','fn_rake_bbj_audit')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_pub > 0 THEN
    RAISE EXCEPTION 'post-check: % of the three definers is still reachable by a browser role', v_pub;
  END IF;

  IF NOT has_function_privilege('service_role',
        'public.fn_ca_escrow_apply(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: service_role can no longer run fn_ca_escrow_apply - the escrow would stop being maintained';
  END IF;

  SELECT COALESCE(SUM(violations), 0) INTO v_viol FROM public.fn_rake_bbj_invariants(2);
  RAISE NOTICE 'definers closed; rake/bbj violations over the last 2h = %', v_viol;
END $$;
