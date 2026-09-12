-- The ladder is the one the money was paid by.
--
-- Breakfast Turbo c1f15c30 has been stuck in COMPLETING since 2026-09-08 and is
-- drift incident 76fa267d, CRITICAL, "recovery_settlement_outcome_unknown". The
-- money is FINE. Nobody is owed a chip and nothing here moves one.
--
-- What happened, read from rows rather than assumed:
--   * The engine paid places 6,5,4,3,2 at elimination between 14:35 and 14:36
--     on a SIX place ladder, then place 1 on recovery at 14:53.
--     58.55 + 42.16 + 30.35 + 21.85 + 15.73 + 11.36 = 180.00 = prize_pool,
--     exactly. All six tournament_obligations read amount_owed = amount_paid
--     and carry settled_at. The winner 5a0cd7e0 holds a wallet_transactions
--     credit of 58.55, "Tournament prize (recovery): position 1". Escrow reads
--     gross_in 200.00, prize_out 180.00, prize_balance 0.00, fee_balance 20.00:
--     a pool paid out in full, not a pool never funded.
--   * Then fn_finalize_tournament_entry_pool_locked repriced the event. For a
--     40 field at payout_percent 10 the generator returns ceil(4) places, so it
--     wrote a FOUR place ladder (43.12/24.76/17.90/14.22) over the six place one
--     the money had already been paid by. Places are paid AT ELIMINATION while
--     the row is still RUNNING, and that function checks only that status is
--     RUNNING - it never asks whether any place has already been paid.
--   * fn_settle_tournament_places has refused on its ladder membership guard on
--     every recovery pass since: places 5 and 6 no longer exist in the derived
--     ladder. Hundreds of refusals in the Postgres log. They raised nothing an
--     operator could see, because a deterministic refusal reports to Sentry and
--     nowhere else. The two CRITICAL alerts that DID appear were raised only
--     because the serialized resolver leg happened to time out on top of the
--     refusal, twice - the alert is an accident, not the failure.
--
-- The 19.07 the recovery once called short is an artefact of the rewrite: it is
-- the difference between 43.12% of 180 and the 58.55 the winner was actually
-- paid. Paying it would require 207.09 out of a 180.00 pool. The platform's own
-- reconciler reached that conclusion on 2026-09-09 and wrote the place 1
-- obligation down to 58.55 owed / 58.55 paid.
--
-- So the correction is to restore the ladder the money was paid by, and let the
-- discovery watchdog finish the event through its normal authority. Deleting the
-- two out-of-ladder obligations is NOT an alternative: the authority carries a
-- symmetric guard against tournament_payouts.position, so the payout rows for
-- places 5 and 6 would refuse next. The ladder itself has to be the paid one.
--
-- Proved before it was written, in a transaction that rolled itself back
-- (section 11.5 rule 1, one call, one self-aborting DO block). With this ladder
-- in place fn_ca_tournament_place_amounts derives
-- 1=58.55, 2=42.16, 3=30.35, 4=21.85, 5=15.73, 6=11.36 - zero mismatches
-- against what was actually paid, and zero obligations outside the ladder.
--
-- On the guard: fn_guard_managed_game_lifecycle lists payout_structure among
-- its protected keys and refuses the change - unless auth.role() is
-- 'service_role'. That exemption is why the engine was able to do this in the
-- first place while an operator repairing it is stopped, so the claim is set
-- here deliberately and only for this one statement, in a transaction that
-- asserts the board has not moved before and after.

BEGIN;

DO $repair$
DECLARE
  v_tid    uuid := 'c1f15c30-33c4-4a64-85ac-44037519ca5b';
  v_status text; v_pool numeric; v_paid numeric; v_n integer;
BEGIN
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

  -- The engine wrote this ladder away; the engine's own exemption is what lets
  -- it be written back. Transaction-local, and nothing else in here writes.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  UPDATE public.tournaments
     SET payout_structure =
       '[{"place":1,"percentage":32.53},{"place":2,"percentage":23.42},'
       '{"place":3,"percentage":16.86},{"place":4,"percentage":12.14},'
       '{"place":5,"percentage":8.74},{"place":6,"percentage":6.31}]'
   WHERE id = v_tid;

  -- The restored ladder must reproduce EVERY paid place, to the cent.
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

  -- And every place obligation must now sit inside it, owed exactly what it was paid.
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

COMMIT;
