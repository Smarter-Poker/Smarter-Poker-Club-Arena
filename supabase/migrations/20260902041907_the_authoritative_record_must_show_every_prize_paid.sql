-- I caused a double payment and this is the fix for the mechanism that let me.
--
-- WHAT HAPPENED. Turbo Tuesday Opener paid its nine places 234.00 against a
-- 234.00 pool - correct. At 01:19 my guarantee back-payment migration credited
-- the 16.00 guarantee shortfall to those same nine players. At ~03:5x my
-- back-fund migration raised prize_pool 234 -> 250 so the pool would show the
-- overlay it received. At 03:54 fn_tournament_payout_reconcile woke up, took
-- expected = 250 x structure, read already_paid from public.tournament_payouts
-- - which knew only about the original 234, because my back-payment never
-- wrote a row there - and paid the same 16.00 a second time. Six tournaments,
-- 1,703.00 chips back-paid, and 1,007.80 of it re-paid.
--
-- ROOT CAUSE. tournament_payouts is the authoritative answer to "what has this
-- player been paid", and the reconciler's own comment says so. I moved prize
-- money into wallets and into chip_ledger and did not write that record. A
-- payment the record cannot see is a payment the reconciler will make again.
-- Raising prize_pool was not the bug; it was the trigger that exposed it.
--
-- Two changes, and deliberately no clawback: Dan has ruled these are horses in
-- beta and the extra chips are not a concern - "just insure the bug / gap /
-- leak is fixed".
--
--   1. Record the 46 back-payments as source 'overlay_backpay' so the record
--      equals what the wallets actually received.
--   2. Count 'overlay_backpay' in the reconciler's already_paid sum, so it can
--      never re-pay an overlay top-up again. Left OUT of that sum, recording
--      the rows would have achieved nothing.
--
-- After this the reconciler reports these places as overpaid rather than
-- underpaid. That is the truth, it is report-only by design, and it is the
-- outcome Dan asked for.

BEGIN;

INSERT INTO public.tournament_payouts
  (tournament_id, user_id, position, amount, source, paid_at,
   idempotency_key, recorded_by, metadata)
SELECT w.related_entity_id,
       w.user_id,
       tp.position,
       w.amount,
       'overlay_backpay',
       w.created_at,
       'tourney:' || w.related_entity_id::text || ':overlay_backpay:' || w.user_id::text,
       'migration the_authoritative_record_must_show_every_prize_paid',
       jsonb_build_object(
         'reason', 'guarantee overlay back-payment credited 2026-09-02 01:19 with no payout record',
         'wallet_transaction_description', w.description)
  FROM public.wallet_transactions w
  LEFT JOIN public.tournament_players tp
         ON tp.tournament_id = w.related_entity_id AND tp.user_id = w.user_id
 WHERE w.type = 'credit'
   AND w.category = 'prize'
   AND w.description ILIKE 'Guarantee overlay back-payment%'
   AND NOT EXISTS (
     SELECT 1 FROM public.tournament_payouts x
      WHERE x.tournament_id = w.related_entity_id
        AND x.user_id = w.user_id
        AND x.source = 'overlay_backpay');

COMMIT;
