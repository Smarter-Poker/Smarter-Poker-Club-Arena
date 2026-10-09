-- 20261008150323_a_settled_satellite_is_conserved_by_its_own_receipt.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- A SETTLED SATELLITE IS CONSERVED BY ITS OWN RECEIPT
-- ============================================================================
--
-- FeeReconciler.satellite_conservation (fn_satellite_conservation_audit) raised
-- 21 CRITICAL alerts between 2026-10-07 18:06Z and 2026-10-08 14:16Z naming
-- satellites that were paid in full:
--
--   ae199f83 "Sunday Deep Stack Satellite $5"  pool 200: one 200.00 cash
--     ticket (cap-blocked award). The audit counts cash only from
--     wallet_transactions(category 'prize'), which this settlement path does
--     not write, so it read "seats 0/1, unpaid winners 1".
--   7e56f752 "Sunday Deep Stack Satellite $10" pool 216: one 200.00 seat and a
--     16.00 bubble remainder. Same blind spot for the remainder: "cash 0",
--     16.00 undisbursed.
--   e2ea5f2a "Sunday Deep Stack Satellite $25" pool 600, three cohort seats:
--     cohort qualifiers carry no finishing position, and the audit caps
--     `awardable` at the count of POSITIONED players.
--
-- Every one carries an immutable settlement header (receipt v2/v3), payout
-- rows summing exactly to the header pool and a zero prize balance. A false
-- critical every hour is how a real one gets ignored.
--
-- THE CHANGE
--
-- A satellite with a settlement header is judged by the header it settled
-- under, which is the contract its receipt proves: it is conserved when its
-- payout rows sum to the header pool, number exactly ticket_award_count plus
-- one for a positive remainder, every award line is written, and its escrow
-- prize balance is zero. Such a satellite is not reported. A headed satellite
-- that fails any of those IS reported, and a satellite with no header keeps
-- the original heuristic exactly. The receipt's full replay, including the
-- wallet, ticket and seat evidence this audit approximates, runs daily in
-- fn_ca_replay_terminal_receipts (20261008140859).
--
-- PROVED before apply in a rolled-back transaction on production: the
-- patched audit returns zero rows over 72 h (two before), and a copy whose
-- header comparison is off by one chip reports both again.
--
-- @live-proof: (SELECT position('tournament_satellite_settlements h' in pg_get_functiondef('public.fn_satellite_conservation_audit(integer)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  v_src text; v_anchor text; v_ins text; v_n int; v_md5 text;
BEGIN
  v_src := pg_get_functiondef('public.fn_satellite_conservation_audit(integer)'::regprocedure);
  IF position('tournament_satellite_settlements h' in v_src) > 0 THEN
    RAISE NOTICE 'fn_satellite_conservation_audit already judges a headed satellite by its receipt; skipping';
    RETURN;
  END IF;
  v_md5 := md5(v_src);
  IF v_md5 <> '5d847143055fab40063ee1d968f2bb36' THEN
    RAISE EXCEPTION 'preimage: fn_satellite_conservation_audit is % - re-read this edit against the live body', v_md5;
  END IF;
  v_anchor := ' WHERE b.excess > 0.005 OR b.undisbursed > 0.005;';
  v_ins := $i$ WHERE (b.excess > 0.005 OR b.undisbursed > 0.005)
   AND NOT EXISTS (
     SELECT 1 FROM tournament_satellite_settlements h
      WHERE h.tournament_id = b.id
        AND h.pool = round((SELECT COALESCE(sum(p.amount), 0) FROM tournament_payouts p
                             WHERE p.tournament_id = b.id), 2)
        AND (SELECT count(*) FROM tournament_payouts p WHERE p.tournament_id = b.id)
            = h.ticket_award_count + CASE WHEN h.remainder > 0 THEN 1 ELSE 0 END
        AND (SELECT count(*) FROM tournament_satellite_awards a WHERE a.tournament_id = b.id)
            = h.ticket_award_count
        AND COALESCE((SELECT e.prize_balance FROM tournament_escrow e
                       WHERE e.tournament_id = b.id), 0) = 0);$i$;
  v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the audit carries its final filter % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_src, v_anchor, v_ins);
END
$mig$;

DO $prove$
BEGIN
  IF position('tournament_satellite_settlements h' in pg_get_functiondef('public.fn_satellite_conservation_audit(integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the conservation audit still ignores the settlement header';
  END IF;
END
$prove$;

COMMIT;
