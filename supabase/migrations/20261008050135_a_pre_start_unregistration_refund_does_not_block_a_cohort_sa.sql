-- 20261008050135_a_pre_start_unregistration_refund_does_not_block_a_cohort_sa.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A PRE-START UNREGISTRATION REFUND DOES NOT BLOCK A COHORT SATELLITE RECEIPT
-- (2026-10-08)
--
-- Measured read-only on production (kuklfnapbkmacvwxktbh) 2026-10-07 17:34 to
-- 2026-10-08 05:00 UTC.
--
-- WHAT HAPPENED
--
-- Cohort satellite 32190e8c (mtt-v2, three full seat_or_cash tickets into
-- target 6561f9f4, REGISTERING) reached its qualifier boundary at 17:34 UTC
-- on 2026-10-07: three players left, all playing with chips, three tickets,
-- no pending knockout, no open hand commit. fn_get_satellite_qualifier_state
-- answers 'qualifying' and the engine calls fn_settle_satellite_qualifiers ->
-- fn_ca_settle_satellite_cohort. The settlement runs to the end and its
-- closing receipt, fn_ca_satellite_cohort_receipt, raises
--
--     satellite 32190e8c-... has missing or extra obligation evidence
--
-- so the whole transaction rolls back. The engine treats the refusal as
-- 'pending' and asks again about every six seconds: the Postgres log holds
-- that refusal continuously for eleven hours, the event deals no hand
-- (MttPlayStopped fired every hour from 18:11, muted only by the break
-- guard), and the three qualifiers hold no seat.
--
-- The "extra evidence" is three rows in tournament_obligations, each
--     kind 'refund', source 'fn_unregister_from_tournament', 25.00 owed,
--     25.00 paid, settled 2026-10-06 15:23 UTC
-- (players who unregistered before the start and were refunded in full).
-- The receipt requires the obligation count to equal exactly the cash
-- tickets plus one remainder row, and counts these refunds too.
--
-- 20261003023500 already fixed exactly this for the single-winner path: it
-- taught the fresh-settlement guard of BOTH settlement entries
-- (fn_settle_satellite_tournament_pre_money_path_gate and
-- fn_ca_settle_satellite_cohort) and the obligation count of
-- fn_ca_satellite_settlement_receipt to ignore a settled pre-start
-- unregistration refund. It did not touch the cohort receipt, so a cohort
-- satellite (two or more full tickets) with any pre-start unregistration
-- passes the guard, does all its work, and is refused at its own receipt.
--
-- The retry loop is also the dominant source of DatabaseDeadlocksElevated:
-- each attempt takes the satellite's money path (fn_settle_tournament_rake ->
-- union_wallets, fn_award_vip_credit -> vip_points_carry) and deadlocks with
-- hand post-commit work. Postgres log 2026-10-07 05:10 to 2026-10-08 05:10:
-- 385 deadlocks, 309 of them with fn_settle_satellite_qualifiers in the
-- cycle, all but one from 17:00 on; the other 76 run at 1 to 10 an hour.
--
-- THE CHANGE
--
-- The cohort receipt's obligation count gets the very predicate the
-- single-winner receipt already carries live. A row is ignored only when ALL
-- hold:
--     kind = 'refund' AND source = 'fn_unregister_from_tournament'
--     AND settled_at IS NOT NULL AND amount_paid = amount_owed.
-- Every other obligation (seat cash ticket, satellite remainder, bounty,
-- cancel refund, an unsettled or partly paid unregistration refund) still
-- counts and still refuses exactly as before. No pool, ticket, seat, fee or
-- escrow arithmetic changes: the refunded entry already left the pool when it
-- was refunded, and the settlement's own guard already admits these rows.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (08e2b78f...), the anchor must
-- occur exactly once (measured read-only on production 2026-10-08: 1), and
-- the result must hash to the postimage derived read-only on production with
-- replace() (b77ddbf6...); owner, SECURITY DEFINER, proconfig and grants must
-- not move.
--
-- Regression: scripts/ci/test-satellite-cohort-receipt-refund.py (native
-- PostgreSQL), run by .github/workflows/satellite-cohort-receipt-refund.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])'::regprocedure)) = 'b77ddbf69afdb53bd342e6e0c0f3a5a2')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_receipt_subst(p_sig text, p_before text, p_after text,
                                         p_old text, p_new text)
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '%: anchor occurs % times, expected exactly 1', p_sig, v_n;
  END IF;
  v_new := replace(v_def, p_old, p_new);
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_receipt_subst(
  'public.fn_ca_satellite_cohort_receipt(uuid,uuid[])',
  '08e2b78fead0943c8106f72deb5d8788', 'b77ddbf69afdb53bd342e6e0c0f3a5a2',
  $o$  SELECT count(*) INTO v_rows
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id;$o$,
  $n$  SELECT count(*) INTO v_rows
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND NOT (o.kind = 'refund' AND o.source = 'fn_unregister_from_tournament'
              AND o.settled_at IS NOT NULL AND o.amount_paid = o.amount_owed);$n$
);

-- One rule on both receipts: the single-winner receipt (20261003023500) and
-- the cohort receipt now carry the identical predicate.
DO $prove$
DECLARE v_pred constant text := $p$     AND NOT (o.kind = 'refund' AND o.source = 'fn_unregister_from_tournament'
              AND o.settled_at IS NOT NULL AND o.amount_paid = o.amount_owed);$p$;
BEGIN
  IF position(v_pred in pg_get_functiondef('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])'::regprocedure)) = 0
     OR position(v_pred in pg_get_functiondef('public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the two satellite receipts do not carry the same settled pre-start refund rule';
  END IF;
END
$prove$;

COMMIT;
