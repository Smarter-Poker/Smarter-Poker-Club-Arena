-- BUBBLE PROTECTION IS FUNDED BY THE HOUSE, NOT BY THE WINNER (2026-09-09)
--
-- DECISION UNDER CLAUDE.md 10.9, delegated by Dan on 2026-09-09. The changelog
-- 2026-09-07-three-winners-were-owed-21419.md left exactly this question open
-- with three costed options; option 2 is chosen and applied here.
--
-- THE DEFECT. A bubble-protected event promises its pool twice. The payout
-- structure percentages sum to exactly 100.0000% of prize_pool, AND bubble
-- protection promises the bubble finisher their buy-in back out of that same
-- pool. Both were advertised. The pool can pay only one, and because the winner
-- is always the LAST place paid, the winner silently absorbs the whole cost -
-- a tax on first place that appears in no published structure.
--
-- READ, NOT ASSUMED, for a449e853 (28,640.00 pool): places 2..12 were each paid
-- their exact structure percentage of the FULL pool, verified row by row; the
-- bubble finisher was paid their full 180.00; place 1 was paid 8,102.69 where
-- the structure promises 28.92% = 8,282.69; and the sum of every payout row is
-- 28,640.00 = prize_pool to the cent. Place 1 is the ONLY player on the sheet
-- who received less than advertised. Same shape on f7412940.
--
-- THE DECISION. The house honours both promises and funds the difference from
-- the rake the same event collected. Nothing is taken from any other player and
-- no other advertised prize changes. Cost 360.00 against 8,400.00 of rake on
-- these two events. Rejected: taking bubble protection off the top (silently
-- reduces every other advertised prize) and retiring bubble protection (removes
-- a player-facing promise).
--
-- NOTE ON THE ADJUSTMENT AMOUNT: fn_settle_tournament_obligation is called with
-- the FULL entitlement and pays only the difference, and its guard requires the
-- approved adjustment to be at least the amount claimed. So each adjustment is
-- written for the full entitlement it authorises while the chips that actually
-- move are 180.00 - stated in the paragraph on each row.
--
-- SAFETY. lock_timeout is deliberate: an earlier interactive attempt at this
-- settlement held a row lock on the host club while its client timed out, every
-- rake write behind it queued, and the database stopped accepting new
-- connections platform-wide for several minutes. This runs server-side in one
-- transaction and ABORTS rather than waits if the rows are busy.
--
-- ROLLBACK: the credits are real payments to players and are not reversed
-- (10.9: nothing is taken back from a player). To undo the funding side only,
-- reverse the two `correction` legs and re-credit the two banks.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $mig$
DECLARE
  v_club_a  CONSTANT uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_t_a     CONSTANT uuid := 'a449e853-4ee1-4e36-bd38-8fe904664d7c';
  v_u_a     CONSTANT uuid := '05835920-da9b-4739-8fa2-2901b844d11d';
  v_t_b     CONSTANT uuid := 'f7412940-5644-4194-8d57-4a97c182bf04';
  v_u_b     CONSTANT uuid := 'a2bd256e-014c-4504-97c7-6bc43242fef1';
  v_union   CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';
  v_uw_id   uuid; v_adj uuid; v_res jsonb; v_bal numeric;
  v_paid_a  numeric; v_paid_b numeric;
BEGIN
  SELECT amount_paid INTO v_paid_a FROM public.tournament_obligations
   WHERE tournament_id = v_t_a AND place = 1;
  SELECT amount_paid INTO v_paid_b FROM public.tournament_obligations
   WHERE tournament_id = v_t_b AND place = 1;
  IF v_paid_a IS DISTINCT FROM 8102.69 OR v_paid_b IS DISTINCT FROM 13261.68 THEN
    RAISE EXCEPTION 'the two obligations are no longer at the amounts this migration was written against (a=%, b=%)', v_paid_a, v_paid_b;
  END IF;

  SELECT id INTO v_uw_id FROM public.union_wallets WHERE union_id = v_union;
  IF v_uw_id IS NULL THEN RAISE EXCEPTION 'union wallet not found'; END IF;

  -- EVENT A: funded by its host club's treasury (which took 2,520.00 of rake).
  UPDATE public.clubs SET chip_treasury = chip_treasury - 180.00
   WHERE id = v_club_a AND chip_treasury >= 180.00 RETURNING chip_treasury INTO v_bal;
  IF v_bal IS NULL THEN RAISE EXCEPTION 'host club treasury could not fund 180.00'; END IF;

  INSERT INTO public.chip_ledger (performed_by, from_type, from_entity_id, to_type, to_entity_id,
      amount, category, club_id, tournament_id, idempotency_key, description)
  VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','club_treasury', v_club_a,
      'prize_liability', v_t_a, 180.00, 'correction', v_club_a, v_t_a,
      'tourney:' || v_t_a::text || ':bubble_protection_backpay',
      'Bubble Protection Funded By The House Not The Winner');

  v_adj := public.fn_ca_adjustment_under_10_9(v_t_a, v_u_a, 8282.69,
    'Zoe77 (05835920-da9b-4739-8fa2-2901b844d11d) finished first in Sunday $200 Deep Stack (a449e853-4ee1-4e36-bd38-8fe904664d7c). The published payout structure promised place 1 exactly 28.92 percent of the 28640.00 prize pool, which is 8282.69, and they were paid 8102.69. THE CHIPS THAT MOVE UNDER THIS ADJUSTMENT ARE 180.00; the 8282.69 named above is the full entitlement the settlement door is called with, because it pays only the difference and its guard requires the approved amount to be at least the amount claimed. The 180.00 difference is the bubble protection refund: the structure percentages sum to exactly 100.0000 percent of the pool AND bubble protection separately promises the bubble finisher their 180.00 buy-in back out of that same pool, so the pool was committed twice and the winner absorbed the whole difference because the winner is always the last place paid. Places 2 through 12 each received their full advertised percentage and the bubble finisher received their full 180.00, so place 1 is the only player on this sheet who received less than advertised. Nothing is taken from any other player. The house funds the promise it made, from the 2520.00 of rake this event paid into the Deep Stack Society treasury. Migration 20260909061500_bubble_protection_is_funded_by_the_house_not_the_winner carries this.',
    '20260909061500_bubble_protection_is_funded_by_the_house_not_the_winner',
    'claude-opus-5 under CLAUDE.md 10.9');

  v_res := public.fn_settle_tournament_obligation(v_t_a, 'place', 1, v_u_a, 8282.69,
    'bubble_protection_backpay',
    'Bubble protection funded by the house, not deducted from the winner', v_adj);
  IF NOT COALESCE((v_res->>'ok')::boolean, false)
     OR round(COALESCE((v_res->>'paid')::numeric,0),2) <> 180.00 THEN
    RAISE EXCEPTION 'event A settlement did not pay exactly 180.00: %', v_res;
  END IF;

  -- EVENT B: funded by the union rake wallet (its host club treasury holds 0.50;
  -- the 5,880.00 of rake from this event went to the union).
  UPDATE public.union_wallets SET rake_wallet = rake_wallet - 180.00
   WHERE union_id = v_union AND rake_wallet >= 180.00 RETURNING rake_wallet INTO v_bal;
  IF v_bal IS NULL THEN RAISE EXCEPTION 'union rake wallet could not fund 180.00'; END IF;

  INSERT INTO public.chip_ledger (performed_by, from_type, from_entity_id, to_type, to_entity_id,
      amount, category, union_id, tournament_id, idempotency_key, description)
  VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','union_bank', v_uw_id,
      'prize_liability', v_t_b, 180.00, 'correction', v_union, v_t_b,
      'tourney:' || v_t_b::text || ':bubble_protection_backpay',
      'Bubble Protection Funded By The House Not The Winner');

  v_adj := public.fn_ca_adjustment_under_10_9(v_t_b, v_u_b, 13441.68,
    'MamaGia (a2bd256e-014c-4504-97c7-6bc43242fef1) finished first in Sunday $200 Deep Stack (f7412940-5644-4194-8d57-4a97c182bf04). The published payout structure promised place 1 exactly 25.4 percent of the 52920.00 prize pool, which is 13441.68, and they were paid 13261.68. THE CHIPS THAT MOVE UNDER THIS ADJUSTMENT ARE 180.00; the 13441.68 named above is the full entitlement the settlement door is called with, because it pays only the difference and its guard requires the approved amount to be at least the amount claimed. The 180.00 difference is the bubble protection refund, the identical defect as the sister event: the structure percentages sum to exactly 100.0000 percent of the pool AND bubble protection separately promises the bubble finisher their 180.00 buy-in back out of the same pool, so the pool was committed twice and the winner absorbed the whole difference because the winner is always the last place paid. Every other paid place received its full advertised percentage and the bubble finisher received their full 180.00, so place 1 is the only player on this sheet who received less than advertised. Nothing is taken from any other player. The house funds the promise it made, from the 5880.00 of rake this event paid into the Midway Union rake wallet. Migration 20260909061500_bubble_protection_is_funded_by_the_house_not_the_winner carries this.',
    '20260909061500_bubble_protection_is_funded_by_the_house_not_the_winner',
    'claude-opus-5 under CLAUDE.md 10.9');

  v_res := public.fn_settle_tournament_obligation(v_t_b, 'place', 1, v_u_b, 13441.68,
    'bubble_protection_backpay',
    'Bubble protection funded by the house, not deducted from the winner', v_adj);
  IF NOT COALESCE((v_res->>'ok')::boolean, false)
     OR round(COALESCE((v_res->>'paid')::numeric,0),2) <> 180.00 THEN
    RAISE EXCEPTION 'event B settlement did not pay exactly 180.00: %', v_res;
  END IF;

  IF (SELECT amount_owed - amount_paid FROM public.tournament_obligations
       WHERE tournament_id = v_t_a AND place = 1) <> 0
   OR (SELECT amount_owed - amount_paid FROM public.tournament_obligations
       WHERE tournament_id = v_t_b AND place = 1) <> 0 THEN
    RAISE EXCEPTION 'an obligation still reports a shortfall after settlement';
  END IF;
END $mig$;

COMMIT;
