-- THE HIERARCHY'S DEBTS ARE ON THE BALANCE SHEET, AND A COMMISSION CALCULATOR
-- IS NOT AN ANONYMOUS DOOR
-- Chip Accounting Standard Phase 2.3 / F8 (Medium) and the F9 remainder.
-- 2026-09-03.
--
-- WHAT WAS WRONG (F8). Commission a club owes its agents and rakeback it owes
-- its players are obligations, not chips: they sit in agent_commissions
-- (settled_at IS NULL) and rakeback_periods (status = 'pending') and in no
-- balance-sheet view. fn_ca_trial_balance and the club solvency checks do not
-- know they exist, so a club bank can be sent below what it owes.
--
-- Measured 2026-09-03 20:45 UTC (open rows, live tables):
--   SHARK CLUB          treasury 1,376,610.47  commission 640,052.38 (1,514,035 rows)  rakeback 27,946.06 (603)
--   Club JAQK           treasury 1,051,788.71  commission 129,141.28 (273,541)         rakeback 47,856.68 (670)
--   Deep Stack Society  treasury 2,021,855.55  commission  63,377.17 (249,199)         rakeback 44,743.25 (333)
--   Midway Union (house club) treasury 0.66    commission     956.22 (1,667)           rakeback 232,206.26 (1,768)
-- Rakeback pending across the platform: 3,374 rows, 352,752.25 at the rate
-- stamped on the row (the ladder fn_close_settlement_period used) and
-- 420,427.87 at fn_player_rakeback_rate (the contract rate); 1,200 rows carry
-- different rates; the gap is 67,675.62. Which rate pays is Dan's ruling
-- (roadmap decision 5); this report shows both so the ruling is priced.
-- Last rakeback paid 08-20 (JAQK, SHARK), 08-17 (house club), never (DSS).
--
-- THE RULE (lane-2 P5): a liability is reported where the treasury is
-- reported. This migration adds the READ side only:
--   fn_ca_hierarchy_payables(p_club_id default NULL) - one row per club:
--     treasury, commission_payable (+ row count, + accrued since the 2.2 fix
--     at 16:34 UTC), rakeback_payable at the row rate and at the contract
--     rate (+ row count, last paid), treasury_after_payables, and covered
--     (treasury >= payables at the contract rate).
-- No balance moves. No threshold. No refusal. The trial balance is not
-- changed: its rows compare balance deltas to ledger nets, and an accrual has
-- no ledger row by design (it is owed, not moved), so a payables row there
-- would alarm every hour for the wrong reason. fn_club_bank_send keeps its
-- behaviour; the warning the audit suggested belongs with the four-eyes
-- threshold (decision 6).
--
-- THE F9 REMAINDER. calculate_cascading_commission was EXECUTE-granted to
-- PUBLIC and anon (found by lane 2.5 on 2026-09-03). It is SECURITY INVOKER,
-- so an anonymous call could not have written past RLS, but a commission
-- calculator is not something a caller with no account should be able to
-- run at all. PUBLIC and anon are revoked; authenticated (CommissionService)
-- and service_role (settle_hand_atomically, the World Hub record-rake and
-- LobbyManager) keep it. Zero callers change.
--
-- Two statements of substance, one transaction, plus a self-check.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_hierarchy_payables(p_club_id uuid DEFAULT NULL)
 RETURNS TABLE(
   club_id uuid,
   club_name text,
   treasury numeric,
   commission_payable numeric,
   commission_rows bigint,
   commission_accrued_since_2_2 numeric,
   rakeback_payable_row_rate numeric,
   rakeback_payable_contract_rate numeric,
   rakeback_rows bigint,
   rakeback_last_paid timestamptz,
   treasury_after_payables numeric,
   covered boolean)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_mgmt boolean := false;
BEGIN
  -- management or the service role, exactly the gate fn_ca_post_correction uses
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.ca_incident_recipients r WHERE r.user_id = v_uid AND r.active
      UNION ALL
      SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.role IN ('admin','god')
    ) INTO v_mgmt;
    IF NOT v_mgmt THEN
      RAISE EXCEPTION 'management_only' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  WITH c AS (
    SELECT cl.id, cl.name, round(COALESCE(cl.chip_treasury, 0), 2) AS treasury
      FROM public.clubs cl
     WHERE p_club_id IS NULL OR cl.id = p_club_id
  ), com AS (
    SELECT a.club_id,
           round(COALESCE(sum(a.amount), 0), 2)                                              AS payable,
           count(*)                                                                          AS n,
           round(COALESCE(sum(a.amount) FILTER (WHERE a.created_at >= '2026-09-03 16:34+00'), 0), 2) AS since_fix
      FROM public.agent_commissions a
     WHERE a.settled_at IS NULL
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
     GROUP BY a.club_id
  ), rb AS (
    SELECT r.club_id,
           round(COALESCE(sum(r.rakeback_amount), 0), 2)                                           AS at_row_rate,
           round(COALESCE(sum(r.rake_generated * public.fn_player_rakeback_rate(r.user_id, r.club_id, r.rake_generated)), 0), 2) AS at_contract_rate,
           count(*)                                                                                AS n
      FROM public.rakeback_periods r
     WHERE r.status = 'pending'
       AND (p_club_id IS NULL OR r.club_id = p_club_id)
     GROUP BY r.club_id
  ), lp AS (
    SELECT r.club_id, max(r.paid_at) AS last_paid
      FROM public.rakeback_periods r
     WHERE r.paid_at IS NOT NULL
       AND (p_club_id IS NULL OR r.club_id = p_club_id)
     GROUP BY r.club_id
  )
  SELECT c.id, c.name, c.treasury,
         COALESCE(com.payable, 0), COALESCE(com.n, 0), COALESCE(com.since_fix, 0),
         COALESCE(rb.at_row_rate, 0), COALESCE(rb.at_contract_rate, 0), COALESCE(rb.n, 0),
         lp.last_paid,
         round(c.treasury - COALESCE(com.payable, 0) - COALESCE(rb.at_contract_rate, 0), 2),
         (c.treasury >= COALESCE(com.payable, 0) + COALESCE(rb.at_contract_rate, 0))
    FROM c
    LEFT JOIN com ON com.club_id = c.id
    LEFT JOIN rb  ON rb.club_id  = c.id
    LEFT JOIN lp  ON lp.club_id  = c.id
   WHERE COALESCE(com.payable, 0) > 0 OR COALESCE(rb.at_row_rate, 0) > 0 OR p_club_id IS NOT NULL
   ORDER BY COALESCE(com.payable, 0) + COALESCE(rb.at_contract_rate, 0) DESC;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_hierarchy_payables(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_hierarchy_payables(uuid) TO service_role;

-- a commission calculator is not an anonymous door
REVOKE ALL ON FUNCTION public.calculate_cascading_commission(uuid, uuid, uuid, numeric, uuid, uuid) FROM PUBLIC, anon;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.calculate_cascading_commission(uuid, uuid, uuid, numeric, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still run calculate_cascading_commission';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.calculate_cascading_commission(uuid, uuid, uuid, numeric, uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.calculate_cascading_commission(uuid, uuid, uuid, numeric, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a real caller of calculate_cascading_commission lost its grant';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_ca_hierarchy_payables(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_hierarchy_payables(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_hierarchy_payables is reachable from a browser role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_ca_hierarchy_payables'
                    AND pronamespace = 'public'::regnamespace AND prosrc LIKE '%fn_player_rakeback_rate%') THEN
    RAISE EXCEPTION 'the payables report does not price rakeback at the contract rate';
  END IF;
END $$;

COMMIT;
