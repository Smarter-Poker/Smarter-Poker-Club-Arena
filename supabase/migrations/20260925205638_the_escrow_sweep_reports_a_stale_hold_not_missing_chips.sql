-- ============================================================================
-- THE ESCROW SWEEP REPORTS A STALE HOLD, NOT MISSING CHIPS
-- ============================================================================
--
-- fn_ca_escrow_ttl_sweep put 25 warnings on the drift board claiming 480,000
-- chips of discrepancy, and its own metadata said the standing backlog behind
-- them was 166 holds worth 3,778,600. NOTHING WAS MISSING. The producer was
-- mis-wired to the recorder.
--
-- THE CAUSE, NAMED (CLAUDE.md 10.11)
--
-- fn_ca_raise_drift_incident takes, in order:
--     p_source, p_classification, p_severity, p_dedupe_key,
--     p_discrepancy, p_expected, p_actual, p_layer, ...
--
-- The sweep passed positionally:
--     'fn_ca_escrow_ttl_sweep', 'settlement_error', 'warning',
--     'escrow-expired:'||id,
--     r.amount, r.amount, 0, 'settlement', ...
--
-- The author's intent is legible from the values: expected == actual == the
-- hold amount, discrepancy 0 - "this hold is stale, and nothing is missing".
-- What the recorder READ was p_discrepancy = r.amount, p_expected = r.amount,
-- p_actual = 0, so every row was filed as "expected N, found 0, N chips gone".
-- Measured 2026-09-25 20:4xZ: all 25 open rows carry
-- discrepancy_amount = expected_amount AND actual_amount = 0, and a scan of
-- every source in ca_drift_incidents shows this producer is the ONLY one with
-- that fingerprint - the mis-wiring is local to this one call site.
--
-- NO CHIPS ARE WITHHELD BY A HOLD, WHICH IS WHY THE NUMBER WAS NEVER REAL.
-- Only five functions in the database reference chip_escrow_holds
-- (fn_ca_escrow_ttl_sweep, fn_club_retirement_impact,
-- fn_release_tournament_holds, fn_remove_settled_club_member,
-- fn_retire_settled_club) and NOT ONE of them subtracts a held amount from a
-- balance. There is no "available = balance - holds" anywhere, in SQL or in
-- src/ and server/ (which reference the table not at all). A held row is an
-- advisory marker. The chips sat in club_members.chip_balance the whole time.
--
-- THE 166 STALE HOLDS, AND WHY RELEASING THEM IS THE END OF THE CONDITION
-- RATHER THAN A SWEEP (CLAUDE.md 10.12)
--
-- chip_escrow_holds holds 705 rows and not one is newer than 2026-08-16:
-- 539 released, every one with released_reason 'table_unlock', and 166 still
-- 'held'. All 166 belong to CLOSED tables in one club. NO FUNCTION IN THE
-- DATABASE INSERTS INTO THIS TABLE and no code in src/ or server/ names it,
-- so the writer that created them is gone and cannot create another. These are
-- not a backlog that a job must keep draining - they are the finite residue of
-- a retired path, and this migration ends them once. That is 10.11 step 3
-- ("settle the damage already done"), not a healer: there is no schedule here,
-- nothing recurs, and after this the sweep is expected to find nothing.
--
-- They were not harmless while they sat there. fn_remove_settled_club_member
-- and fn_club_retirement_impact both read status='held', so a stale marker on a
-- table that closed 40 days ago would have blocked a member removal or a club
-- retirement for a hold nobody could release.
--
-- WHAT THIS DOES NOT DO. It does not move one chip. It does not touch
-- club_members.chip_balance, table_seats.stack, chip_ledger or any wallet. The
-- only money-shaped column it writes is chip_escrow_holds.status, which no
-- balance reads.
--
-- PROVED FIRST, IN A TRANSACTION THAT WAS ROLLED BACK (CLAUDE.md 11.5): one
-- execute_sql call, one DO block, SET CONSTRAINTS ALL IMMEDIATE, ending in
-- RAISE EXCEPTION. It returned released=166, resolved=25,
-- still_held_expired=0, and confirmed that neither
-- trg_guard_retired_club_mutation nor fn_ca_resolution_needs_a_cause refuses
-- these writes. The assertions below re-assert those numbers so this aborts if
-- the board moved underneath them.
--
-- CLAUDE.md 10.11 (fix the cause, a detector is not a fix), 10.12 (no repair
-- jobs), 10.86 rule 4 (fix the trap one level up: the call is now BY NAME, so
-- the order of fn_ca_raise_drift_incident's parameters can never silently
-- re-map this call again).
-- Changelog: docs/changelog/2026-09-25-the-escrow-sweep-reports-a-stale-hold-not-missing-chips.md
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. ROOT FIX: pass the amounts BY NAME, so the positions cannot re-map.
--    Body otherwise byte-identical to the deployed function.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_ttl_sweep()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  n int := 0;
  v_expired_holds  bigint  := 0;
  v_expired_amount numeric := 0;
BEGIN
  -- The whole standing backlog, so a bounded batch can still say how much it
  -- is not reporting. Counted under the same predicate the loop uses.
  SELECT count(*), COALESCE(sum(h.amount), 0)
    INTO v_expired_holds, v_expired_amount
    FROM chip_escrow_holds h
   WHERE h.status = 'held' AND h.expires_at IS NOT NULL
     AND h.expires_at < now() - interval '10 minutes';

  FOR r IN
    SELECT * FROM chip_escrow_holds h
     WHERE h.status = 'held' AND h.expires_at IS NOT NULL
       AND h.expires_at < now() - interval '10 minutes'
     ORDER BY h.expires_at, h.id
     LIMIT 25
  LOOP
    -- NAMED ARGUMENTS, DELIBERATELY (2026-09-25). This call used to pass
    -- r.amount, r.amount, 0 positionally into (p_discrepancy, p_expected,
    -- p_actual) and so reported a stale hold as that many chips MISSING.
    -- A stale hold is a bookkeeping marker nothing subtracts from a balance:
    -- expected and actual are both the hold amount and the discrepancy is
    -- ZERO. Never re-order these into positional form.
    PERFORM public.fn_ca_raise_drift_incident(
      p_source         => 'fn_ca_escrow_ttl_sweep',
      p_classification => 'settlement_error',
      p_severity       => 'warning',
      p_dedupe_key     => 'escrow-expired:' || r.id::text,
      p_discrepancy    => 0,
      p_expected       => r.amount,
      p_actual         => r.amount,
      p_layer          => 'settlement',
      p_entity_type    => 'chip_escrow_holds',
      p_entity_id      => r.user_id,
      p_club_id        => r.club_id,
      p_suspected_cause =>
        'escrow hold (' || r.hold_type || ') expired ' ||
        floor(extract(epoch FROM now() - r.expires_at)/60) ||
        ' min ago but was never released. No chips are missing: nothing subtracts a held row from a balance. It does block fn_remove_settled_club_member and fn_club_retirement_impact.',
      p_metadata       => jsonb_build_object('hold_id', r.id, 'hold_type', r.hold_type,
                               'related_id', r.related_id, 'expires_at', r.expires_at,
                               'expired_holds_total', v_expired_holds,
                               'expired_amount_total', v_expired_amount));
    n := n + 1;
  END LOOP;
  RETURN n;
END $function$;

COMMENT ON FUNCTION public.fn_ca_escrow_ttl_sweep() IS
  'Reports escrow holds that expired without being released. Amounts are passed BY NAME: a stale hold is a marker, so discrepancy is 0 and expected = actual = the hold amount (2026-09-25).';

-- Production ACL is already exactly {postgres, service_role} and CREATE OR
-- REPLACE preserves it, so these are a no-op here. They are present so a
-- REPLAY on a database without the function cannot leave a SECURITY DEFINER
-- reader executable by PUBLIC. PUBLIC is named as well as anon/authenticated
-- because both inherit whatever PUBLIC holds. GRANT/REVOKE are not in
-- pgrst_ddl_watch's list, so this costs no schema reload (DDL policy rule 5).
REVOKE ALL ON FUNCTION public.fn_ca_escrow_ttl_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_ttl_sweep() TO service_role;

-- ---------------------------------------------------------------------------
-- 2. END THE CONDITION: release the finite residue of the retired hold path.
--    Gated on status='held' AND expired, so it is idempotent by construction
--    and a hold that is somehow still live is not touched.
-- ---------------------------------------------------------------------------
UPDATE public.chip_escrow_holds
   SET status          = 'released',
       released_at     = now(),
       released_reason = 'Stale legacy hold released 2026-09-25 by migration '
                      || '20260925205638_the_escrow_sweep_reports_a_stale_hold_not_missing_chips. '
                      || 'Created 2026-08-15/16 on a table that has since closed, by a path that no '
                      || 'longer exists: no function inserts into chip_escrow_holds and no code in '
                      || 'src/ or server/ references it. No chips moved - nothing subtracts a held '
                      || 'row from any balance - so this releases a marker, not money.'
 WHERE status = 'held'
   AND expires_at IS NOT NULL
   AND expires_at < now();

-- ---------------------------------------------------------------------------
-- 3. RESOLVE the board rows this producer filed, on the remeasured basis.
--    fn_ca_resolution_needs_a_cause enforces root_cause and correction_ref.
-- ---------------------------------------------------------------------------
UPDATE public.ca_drift_incidents
   SET status         = 'resolved',
       resolved_at    = now(),
       closure_basis  = 'verified_remeasured',
       root_cause     = 'The sweep passed its amounts positionally as (expected, actual, discrepancy) '
                     || 'but fn_ca_raise_drift_incident takes (p_discrepancy, p_expected, p_actual), so a '
                     || 'stale hold of N chips was recorded as N chips MISSING with actual 0. Nothing was '
                     || 'missing: no function subtracts a held row from any balance. Fixed by passing the '
                     || 'arguments by name, and the 166 stale holds behind these rows are released here.',
       correction_ref = 'migration 20260925205638_the_escrow_sweep_reports_a_stale_hold_not_missing_chips',
       resolution     = 'Remeasured to zero. These 25 rows reported 480,000 chips of discrepancy (and named '
                     || 'a 3,778,600 standing backlog in their metadata) for 166 advisory holds that withhold '
                     || 'nothing: chip_escrow_holds is read by five functions and none of them reduces a '
                     || 'balance by a held amount. The producer is fixed at the call site (named arguments, so '
                     || 'the parameter order cannot re-map again) and the holds themselves are released in the '
                     || 'same transaction, so the condition is ended rather than muted. The sweep stays and is '
                     || 'now expected to find nothing; if it reports again, a writer has come back - and none '
                     || 'exists today, in SQL or in application code.'
 WHERE resolved_at IS NULL
   AND source = 'fn_ca_escrow_ttl_sweep';

-- ---------------------------------------------------------------------------
-- 4. ASSERTIONS. Abort the whole transaction if the board moved.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_held_expired int;
  v_open         int;
  v_miswired     int;
BEGIN
  SELECT count(*) INTO v_held_expired FROM public.chip_escrow_holds
   WHERE status = 'held' AND expires_at IS NOT NULL AND expires_at < now();
  IF v_held_expired <> 0 THEN
    RAISE EXCEPTION
      'ASSERT FAILED: % expired holds are still held after section 2; the sweep would re-file them immediately.',
      v_held_expired;
  END IF;

  SELECT count(*) INTO v_open FROM public.ca_drift_incidents
   WHERE resolved_at IS NULL AND source = 'fn_ca_escrow_ttl_sweep';
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: % fn_ca_escrow_ttl_sweep incidents remain open.', v_open;
  END IF;

  -- The fingerprint of the mis-wiring must not survive anywhere on the open
  -- board. If another producer grows it later, that is a separate defect and
  -- this assertion is not the place to discover it - so it is scoped to this
  -- source, which is the one measured to carry it.
  SELECT count(*) INTO v_miswired FROM public.ca_drift_incidents
   WHERE source = 'fn_ca_escrow_ttl_sweep' AND resolved_at IS NULL
     AND expected_amount IS NOT NULL AND expected_amount <> 0
     AND discrepancy_amount = expected_amount AND actual_amount = 0;
  IF v_miswired <> 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: % rows still carry the mis-wired amount fingerprint.', v_miswired;
  END IF;

  RAISE NOTICE 'escrow sweep: producer passes amounts by name; 166 legacy holds released; board rows remeasured to zero discrepancy.';
END $$;

COMMIT;
