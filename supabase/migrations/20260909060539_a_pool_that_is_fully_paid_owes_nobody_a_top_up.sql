-- A POOL THAT IS FULLY PAID OWES NOBODY A TOP-UP (2026-09-09)
--
-- `fn_tournament_payout_reconcile` distributes the ENTIRE prize_pool across the
-- ranked places in payout_structure and compares each place against
-- tournament_payouts rows for THAT place. It never looks at payouts made
-- outside the ranked structure - `position IS NULL` rows: bubble protection and
-- final-table deals. So on any event that has one, it believes the pool still
-- owes money it has already paid out.
--
-- MEASURED, all five open shortfall obligations on 2026-09-09, every one of
-- them a false positive (sum of payout rows = prize_pool to the cent in ALL
-- six affected events):
--
--   PLO4 Heads-Up 25       71.25  the whole 71.25 pool was paid by a FINAL
--                                 TABLE DEAL, 47.50 to the very player this
--                                 obligation says was "paid 0.00" and 23.75 to
--                                 the other. Its dry run wanted to top the
--                                 winner up by another 23.75 - the loser's
--                                 share - out of a pool with nothing left.
--   Breakfast Turbo        19.07  paid SIX places summing to exactly 180.00,
--                                 while tournaments.payout_structure stores a
--                                 stale FOUR-place structure; 43.12% of 180.00
--                                 is the 77.62 this obligation claims.
--   Daily Big Mini p1       0.11  pool 250.00, paid 250.00
--   Daily Big Mini p4       0.12  pool 250.00, paid 250.00
--   Deep Stack Daily p2     0.09  pool 1500.00, paid 1500.00
--
-- Nothing could actually be paid because fn_settle_tournament_obligation caps
-- every payment at the escrow bank, which is empty - so the escrow guard was
-- the only thing standing between this and paying pools twice. It held. But
-- each refusal filed a fresh critical `escrow_short` alert, forever, and left a
-- record saying a player was owed money that no pool owes them.
--
-- TWO GUARDS, placed before any expectation is computed:
--   1. A final-table deal IS the settlement. The players agreed the split; the
--      ranked structure does not apply and must not be reconciled against.
--   2. A pool that has paid out its whole self owes nothing more. Any remaining
--      per-place gap is an OVER-PROMISE (the structure and a side-promise both
--      committing the same chips) - a funding question for the house, not an
--      unpaid pool, and topping it up here would pay the pool twice.
--
-- The five obligations are then written down to what was actually paid. Their
-- amount_owed was arithmetically impossible: it exceeded what the pool had left
-- to give. No chips move; nobody is paid and nobody is charged.
--
-- ROLLBACK: restore fn_tournament_payout_reconcile from ca_guard_def_history,
-- and restore the five amount_owed values named in the assertions below.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $mig$
DECLARE
  v_def    text;
  v_decl   CONSTANT text := '  v_has_record     boolean;';
  v_anchor CONSTANT text := '  SELECT EXISTS (SELECT 1 FROM public.tournament_payouts tpo
                  WHERE tpo.tournament_id = p_tournament_id)
    INTO v_has_record;';
  v_guard  CONSTANT text := $g$

  /* PAYMENTS OUTSIDE THE RANKED STRUCTURE ARE STILL PAYMENTS (2026-09-09). */
  SELECT COALESCE(sum(tpo.amount), 0),
         COALESCE(sum(tpo.amount) FILTER (WHERE tpo."position" IS NULL), 0),
         COALESCE(bool_or(tpo.source = 'final_table_deal'), false)
    INTO v_all_paid, v_unranked_paid, v_deal_settled
    FROM public.tournament_payouts tpo
   WHERE tpo.tournament_id = p_tournament_id;

  IF v_deal_settled THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
      'name', t.name, 'skipped', 'settled_by_final_table_deal',
      'prize_pool', v_pool, 'paid', round(v_all_paid, 2),
      'detail', 'the finalists agreed the split and it was paid; the ranked '
             || 'structure does not describe this event and must not be '
             || 'reconciled against it');
  END IF;

  IF round(v_all_paid, 2) >= round(v_pool, 2) - 0.005 THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
      'name', t.name, 'skipped', 'pool_fully_discharged',
      'prize_pool', v_pool, 'paid', round(v_all_paid, 2),
      'unranked_paid', round(v_unranked_paid, 2),
      'over_promised', round(GREATEST(v_all_paid - v_pool, 0), 2),
      'detail', 'every chip of this pool has been paid out. A remaining '
             || 'per-place gap is an over-promise to be funded by the house, '
             || 'not an unpaid pool; topping it up from here would pay the '
             || 'same pool twice');
  END IF;
$g$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_tournament_payout_reconcile';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_tournament_payout_reconcile is missing'; END IF;
  IF position('pool_fully_discharged' in v_def) > 0 THEN
    RAISE NOTICE 'guards already present';
  ELSE
    IF position(v_decl in v_def) = 0 THEN
      RAISE EXCEPTION 'the DECLARE block is not the shape this migration expects';
    END IF;
    IF position(v_anchor in v_def) = 0 THEN
      RAISE EXCEPTION 'the payout-record probe this migration guards has moved; re-read the function';
    END IF;
    v_def := replace(v_def, v_decl,
      v_decl || '
  v_all_paid       numeric := 0;
  v_unranked_paid  numeric := 0;
  v_deal_settled   boolean := false;');
    v_def := replace(v_def, v_anchor, v_anchor || v_guard);
    EXECUTE v_def;
  END IF;
END $mig$;

-- Post-apply: the guards are live and behave.
DO $post$
DECLARE v_def text; v_r jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_tournament_payout_reconcile';
  IF position('pool_fully_discharged' in v_def) = 0
     OR position('settled_by_final_table_deal' in v_def) = 0 THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;

  v_r := public.fn_tournament_payout_reconcile('3e281f5c-2479-42dc-bf6e-afb007d9988f', false);
  IF v_r->>'skipped' <> 'settled_by_final_table_deal' THEN
    RAISE EXCEPTION 'the deal guard did not fire on PLO4 Heads-Up 25: %', v_r;
  END IF;

  v_r := public.fn_tournament_payout_reconcile('a449e853-4ee1-4e36-bd38-8fe904664d7c', false);
  IF v_r->>'skipped' <> 'pool_fully_discharged' THEN
    RAISE EXCEPTION 'the discharged-pool guard did not fire on a449e853: %', v_r;
  END IF;
END $post$;

-- Write down the five impossible entitlements.
DO $wd$
DECLARE v_n int;
BEGIN
  UPDATE public.tournament_obligations o
     SET amount_owed = o.amount_paid,
         settled_at  = now(),
         updated_at  = now()
   WHERE o.settled_at IS NULL
     AND (o.amount_owed - COALESCE(o.amount_paid,0)) > 0
     AND EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = o.tournament_id
          AND round(COALESCE(t.prize_pool,0),2) <= round((
                SELECT COALESCE(sum(p.amount),0) FROM public.tournament_payouts p
                 WHERE p.tournament_id = o.tournament_id),2) + 0.005);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'expected to write down exactly 5 phantom obligations, wrote %', v_n;
  END IF;

  IF EXISTS (SELECT 1 FROM public.tournament_obligations
              WHERE settled_at IS NULL AND (amount_owed - COALESCE(amount_paid,0)) > 0) THEN
    RAISE EXCEPTION 'a shortfall obligation still stands after the write-down';
  END IF;
END $wd$;

COMMIT;
