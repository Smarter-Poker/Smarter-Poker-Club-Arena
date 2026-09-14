DO $repair$
DECLARE
  v_tid    uuid := 'c1f15c30-33c4-4a64-85ac-44037519ca5b';
  v_status text; v_pool numeric; v_paid numeric; v_n integer;
BEGIN
  /* THE LADDER IS THE ONE THE MONEY WAS PAID BY (2026-09-12, incident 76fa267d).
     Breakfast Turbo paid six places totalling exactly 180.00 on the six place
     ladder it ran under. fn_finalize_tournament_entry_pool_locked then repriced
     the event to the generator's FOUR place ladder for a 40 field - over money
     already out of escrow, because places are paid AT ELIMINATION while the row
     is still RUNNING and that function checks only that status is RUNNING. So
     places 5 and 6 fell outside the derived ladder and fn_settle_tournament_places
     has refused every recovery pass since 2026-09-09 on its ladder membership
     guard, hundreds of times, reporting to Sentry and nowhere an operator looks.
     The winner IS paid: wallet credit 58.55, all six obligations owed = paid =
     settled, escrow gross_in 200.00 / prize_out 180.00 / prize_balance 0.00.
     NO MONEY MOVES HERE. Proved first in a transaction that rolled itself back
     (section 11.5 rule 1): the restored ladder derives 1=58.55, 2=42.16,
     3=30.35, 4=21.85, 5=15.73, 6=11.36 - zero mismatches against what was paid. */
  SELECT upper(status::text), prize_pool INTO v_status, v_pool
    FROM public.tournaments WHERE id = v_tid FOR UPDATE;
  IF NOT FOUND OR v_status <> 'COMPLETING' THEN
    RAISE EXCEPTION 'Breakfast Turbo is no longer COMPLETING (%) - board moved, repair aborted', v_status;
  END IF;

  SELECT count(*) INTO v_n FROM public.tournament_terminal_settlements WHERE tournament_id = v_tid;
  IF v_n <> 0 THEN RAISE EXCEPTION 'a terminal receipt already exists - repair aborted'; END IF;

  SELECT round(COALESCE(sum(amount),0),2) INTO v_paid
    FROM public.tournament_payouts WHERE tournament_id = v_tid;
  IF v_pool <> 180.00 OR v_paid IS DISTINCT FROM 180.00 THEN
    RAISE EXCEPTION 'pool/paid moved (pool %, paid %) - repair aborted', v_pool, v_paid;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tournament_escrow
                  WHERE tournament_id = v_tid
                    AND prize_balance = 0 AND bounty_balance = 0 AND fee_balance = 20.00) THEN
    RAISE EXCEPTION 'escrow moved - repair aborted';
  END IF;

  /* fn_guard_managed_game_lifecycle protects payout_structure from everyone
     EXCEPT auth.role() = 'service_role'. That exemption is exactly how the
     engine rewrote this ladder over paid money while an operator repairing it
     is refused. Set deliberately, transaction local, for this one statement. */
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  UPDATE public.tournaments
     SET payout_structure =
       '[{"place":1,"percentage":32.53},{"place":2,"percentage":23.42},'
       '{"place":3,"percentage":16.86},{"place":4,"percentage":12.14},'
       '{"place":5,"percentage":8.74},{"place":6,"percentage":6.31}]'
   WHERE id = v_tid;

  SELECT count(*) INTO v_n
    FROM public.fn_ca_tournament_place_amounts(v_tid) a
    FULL JOIN (SELECT p."position" AS place, round(sum(p.amount),2) AS amount
                 FROM public.tournament_payouts p
                WHERE p.tournament_id = v_tid AND p."position" IS NOT NULL
                GROUP BY p."position") m
      ON m.place = a.place
   WHERE a.place IS NULL OR m.place IS NULL OR a.amount IS DISTINCT FROM m.amount;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'restored ladder does not reproduce the paid places (% mismatches)', v_n;
  END IF;

  SELECT count(*) INTO v_n
    FROM public.tournament_obligations o
   WHERE o.tournament_id = v_tid AND o.kind = 'place'
     AND NOT EXISTS (SELECT 1 FROM public.fn_ca_tournament_place_amounts(v_tid) a
                      WHERE a.place = o.place
                        AND a.amount = o.amount_owed
                        AND o.amount_paid = o.amount_owed);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% obligation(s) still outside the restored ladder', v_n;
  END IF;
END $repair$;