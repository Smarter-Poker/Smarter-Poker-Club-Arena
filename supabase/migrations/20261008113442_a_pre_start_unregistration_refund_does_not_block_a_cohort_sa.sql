-- 20261008113442_a_pre_start_unregistration_refund_does_not_block_a_cohort_sa.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- A PRE-START UNREGISTRATION REFUND DOES NOT BLOCK A COHORT SATELLITE EITHER
-- ============================================================================
--
-- Measured on production (kuklfnapbkmacvwxktbh) 2026-10-07 17:38 to
-- 2026-10-08 11:05 UTC.
--
-- WHAT HAPPENED
--
-- Satellite 32190e8c "Sunday Deep Stack Satellite $25" (target 6561f9f4,
-- 3 seats) reached its qualifier boundary at 17:38Z on 2026-10-07 with
-- exactly three players left: every one of them a qualifier, so the finish
-- is the COHORT settlement (fn_ca_settle_satellite_cohort), not the single-
-- winner one. Every attempt was refused with
--
--     satellite 32190e8c-... has missing or extra obligation evidence (P0404)
--
-- about 500 times across the night (one per elimination sweep), and the
-- event sat with its only table parked for the qualifier boundary for 17
-- hours: "Parked between hands - waiting for the pause to lift...", killed
-- and rebuilt as a tournament_table_zombie every ten minutes, 0 hands dealt,
-- status 'RUNNING', three qualifiers unpaid.
--
-- The "evidence" is one tournament_obligations row: kind 'refund', source
-- 'fn_unregister_from_tournament', settled in full before the event started.
--
-- Migration 20261003023500 admitted exactly that row in the fresh-settlement
-- guards of BOTH settlement entries and in the obligation count of the
-- single-winner receipt (fn_ca_satellite_settlement_receipt). It did not
-- touch fn_ca_satellite_cohort_receipt, which the cohort settlement replays
-- inside its own transaction as its proof of what it just wrote. So a cohort
-- satellite in which anyone had unregistered could never finish: the
-- settlement wrote everything correctly and then refused its own receipt,
-- rolling the whole finish back.
--
-- THE CHANGE
--
-- The same substitution, in the cohort receipt's obligation count: a row is
-- ignored only when ALL hold
--     kind = 'refund' AND source = 'fn_unregister_from_tournament'
--     AND settled_at IS NOT NULL AND amount_paid = amount_owed.
-- Every other obligation still refuses exactly as before. No pool, ticket,
-- seat, fee or escrow arithmetic changes.
--
-- PROVED BEFORE APPLY in a rolled-back transaction on production 11:07Z:
-- with this one substitution fn_ca_settle_satellite_cohort(32190e8c,
-- {083db75b, 592d5976, 929f7224}) returned ok, pool 600.00, 3 x 200.00
-- tickets (2 seats into the target, 1 direct entry ticket), fee bank 60.00
-- recognized, receipt_version 3, fully_settled, status COMPLETED.
--
-- @live-proof: (SELECT position('fn_unregister_from_tournament' in pg_get_functiondef('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  v_src text; v_anchor text; v_ins text; v_n int; v_md5 text;
BEGIN
  IF NOT (current_user IN ('postgres','service_role','supabase_admin')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;
  v_src := pg_get_functiondef('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])'::regprocedure);
  IF position('fn_unregister_from_tournament' in v_src) > 0 THEN
    RAISE NOTICE 'fn_ca_satellite_cohort_receipt already admits a settled pre-start refund; skipping';
    RETURN;
  END IF;
  v_md5 := md5(v_src);
  IF v_md5 <> '08e2b78fead0943c8106f72deb5d8788' THEN
    RAISE EXCEPTION 'preimage: fn_ca_satellite_cohort_receipt is % - re-read this edit against the live body', v_md5;
  END IF;
  v_anchor := $a$  SELECT count(*) INTO v_rows
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id;$a$;
  v_ins := $i$  SELECT count(*) INTO v_rows
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND NOT (o.kind = 'refund' AND o.source = 'fn_unregister_from_tournament'
              AND o.settled_at IS NOT NULL AND o.amount_paid = o.amount_owed);$i$;
  v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the cohort receipt carries the obligation count % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_src, v_anchor, v_ins);
END
$mig$;

DO $prove$
BEGIN
  IF position('fn_unregister_from_tournament' in pg_get_functiondef('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the cohort receipt still refuses a settled pre-start refund';
  END IF;
END
$prove$;

COMMIT;
