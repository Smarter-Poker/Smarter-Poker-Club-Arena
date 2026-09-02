-- My back-payment distributed each guarantee shortfall pro-rata to what a
-- player had ALREADY been paid, and I included bounty credits in that basis.
-- Bounty money is not prize money and is not part of the prize structure, so a
-- player who won a lot of bounties took a large share of the PRIZE shortfall.
-- The totals were right and the shape was wrong: on "Bounty Builder Turbo",
-- place 1 ended on 323.33 against a 200.00 entitlement while places 2 to 5
-- were left 133.33 short between them.
--
-- The published payout_structure is what the player was promised and what both
-- fn_payout_guarantee_check and fn_tournament_payout_reconcile read. I should
-- have distributed by it rather than inventing a basis.
--
-- The remedy is the platform's own reconciler, not a third distribution rule:
-- it computes expected = pool x structure per place, tops up anyone short, and
-- deliberately never claws back - which matches Dan's ruling that the extra
-- chips are not the concern. Overpaid places keep what they received and
-- underpaid places are made whole.
--
-- A procedure rather than a DO block because the first attempt deadlocked
-- against the live engine on club_members and lost the whole batch. Each event
-- is its own transaction, a failure is caught and the sweep continues, and
-- lock_timeout keeps it from becoming the deadlock victim's victim.

CREATE OR REPLACE PROCEDURE public.sp_ca_reconcile_backpaid_events(p_apply boolean DEFAULT false)
LANGUAGE plpgsql
AS $sp$
DECLARE
  r record; v jsonb; v_n int := 0; v_chips numeric := 0; v_failed int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT p.tournament_id
      FROM public.tournament_payouts p
     WHERE p.source = 'overlay_backpay'
       AND p.recorded_by = 'fn_ca_backpay_guarantee_shortfalls'
  LOOP
    BEGIN
      SET LOCAL lock_timeout = '5s';
      v := public.fn_tournament_payout_reconcile(r.tournament_id, p_apply);
      IF COALESCE((v->>'total_top_up')::numeric, 0) > 0 THEN
        v_n := v_n + 1;
        v_chips := v_chips + (v->>'total_top_up')::numeric;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      RAISE NOTICE 'event % could not be reconciled: %', r.tournament_id, SQLERRM;
    END;
    IF p_apply THEN COMMIT; END IF;
  END LOOP;

  RAISE NOTICE 'events needing top-up: %, chips: %, failed: %',
               v_n, round(v_chips,2), v_failed;
END;
$sp$;

REVOKE ALL ON PROCEDURE public.sp_ca_reconcile_backpaid_events(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.sp_ca_reconcile_backpaid_events(boolean) TO service_role;
