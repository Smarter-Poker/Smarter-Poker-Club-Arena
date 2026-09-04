-- ═══════════════════════════════════════════════════════════════════════════
-- THE RECORD IS PART OF THE FIX (CLAUDE.md 10.9): register the money doors
-- that landed on 2026-09-03/04 without a registry row, and resolve the drift
-- incidents that defect 0 (the felt erasure) raised, with the reason.
--
-- fn_ca_money_rpc_drift() named four functions that write balance columns
-- and are not in ca_money_rpc_registry. Each was audited:
--   fn_promo_disburse                 the owner's promo door (2026-09-03,
--                                     #2896): declared, op-keyed, refuses a
--                                     short float; probed with conservation 0.
--   fn_ca_retire_certification_club   retires a certification fixture's chips
--                                     to chip_retirement with a declared row
--                                     (2026-09-03, #2898); refuses the four
--                                     real estates by id.
--   fn_ca_restore_erased_seat_credit  the keyed restoration door (2026-09-04,
--                                     20260904104847): issuance_reserve ->
--                                     player_wallet, replay refused.
--   fn_club_owner_has_a_player_wallet a trigger that gives a new club's owner
--                                     a club_members row with chip_balance 0.
--                                     It inserts a wallet; it moves nothing.
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_promo_disburse', 'approved', 'chip std 2026-09-03 (#2896): the one owner door for promo disbursement; declared, op-keyed, refuses a short float'),
  ('fn_ca_retire_certification_club', 'approved', 'chip std 2026-09-03 (#2898): retires a certification fixture club, chips to chip_retirement with a declared journal row; refuses the four real estates'),
  ('fn_ca_restore_erased_seat_credit', 'approved', 'chip std 2026-09-04 (20260904104847): keyed restoration of a seat credit erased by an absolute stack write; issuance_reserve -> player_wallet, replay refused'),
  ('fn_club_owner_has_a_player_wallet', 'approved', 'trigger: a new club owner gets a club_members row with chip_balance 0 - creates a wallet, moves no chips')
ON CONFLICT (proname) DO NOTHING;

-- The incidents defect 0 raised, resolved with the reason. The supply meter's
-- "unexplained" rows from 2026-08-31 20:30 UTC (when the barrier defect
-- shipped) to the 11:05 snapshot on 2026-09-04 are the erasure (defect A,
-- -2,500/h) net of the mis-declared tournament rake (defect B, +1,179/h);
-- the trial-balance watch rows are the same figure seen per account. The
-- 23:05 warning on 09-03 (1,300,000) and the mint-velocity warning are the
-- certification retirement and are not touched here.
UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(),
       correction_ref = 'migration 20260904104847_felt_erasure_delta_settlement',
       root_cause = 'Defect 0 of the chip standard: seat credits erased by absolute hand-stack writes (settlement barrier overwritten; unchecked per-seat fallback) and standalone-club tournament rake journalled as leaving the felt. docs/changelog/2026-09-04-chip-std-felt-erasure.md',
       resolution = 'Fixed structurally in 20260904104847 (delta-mode hand writes, identity asserted on every write, declared rake counterparty honoured) and the engine half in #2958; 282 erased credits / 33,626.88 chips restored in 20260904112929; a self-retiring sweep covers the deploy gap.'
 WHERE status = 'open'
   AND detected_at BETWEEN '2026-08-31 20:30:00+00' AND '2026-09-04 11:06:00+00'
   AND ((source = 'fn_ca_supply_snapshot' AND COALESCE(discrepancy_amount, 0) < 0 AND COALESCE(discrepancy_amount, 0) > -100000)
     OR source = 'fn_ca_trial_balance_watch');

UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(),
       correction_ref = 'migration money_doors_registered_and_defect_0_incidents_resolved',
       root_cause = 'a money door landed without a ca_money_rpc_registry row',
       resolution = 'audited and registered as approved in this migration'
 WHERE status = 'open' AND source = 'fn_ca_money_rpc_drift'
   AND metadata->>'proname' IN ('fn_promo_disburse','fn_ca_retire_certification_club','fn_ca_restore_erased_seat_credit','fn_club_owner_has_a_player_wallet');

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.fn_ca_money_rpc_drift();
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'fn_ca_money_rpc_drift still returns % row(s)', v_n;
  END IF;
END $$;
