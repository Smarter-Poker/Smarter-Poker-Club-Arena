-- REFUND THE ADD-ONS THAT WERE CHARGED AND NEVER DELIVERED (2026-08-25)
--
-- On 2026-08-20, 103 players were each charged 25.00 for a tournament add-on
-- and the chips never reached a seat. process_tournament_rebuy updated the
-- seat behind an IF FOUND with no ELSE, so a missing seat row meant the charge
-- stood and the grant silently did not happen. The code defects were fixed the
-- same day (seat pre-check before any money moves, the missing ELSE closed, an
-- ordered seat lookup, and an exact-grant assertion that now rolls back the
-- charge if the stack does not land).
--
-- The refund was waived at the time. Dan reversed that on 2026-08-25:
-- "these chips should go back to the players ... credit any and all chips back
-- to the source."
--
-- MEASURED, not taken from the audit:
--   103 debits, 103 distinct players, every one exactly 25.00, total 2,575.00
--   0 give-backs of any kind to those users since
--   0 table_pending_addons rows for them that day, so nothing landed by the
--     cash-table path either
--   2026-08-20 is the only day with this shape - the next day carries 338
--     charges and every day after is larger, which is the fix landing.
--
-- The 908,552 "chips" in the audit are TOURNAMENT chips - play chips inside the
-- event, against its own prize pool. They are not a wallet debt and are not
-- refundable to anyone. The wallet debt is the 2,575.00, and that is what this
-- repays.
--
-- Idempotent by construction: the key is derived from the original transaction
-- id, and fn_credit_and_log only writes a ledger row when the credit actually
-- happened, so re-running this migration pays nobody twice. Proven by replay:
-- a second call with the same key credited nothing and the totals held at
-- 103 rows / 2,575.00.
--
-- ROLLBACK:
--   DELETE FROM wallet_transactions
--    WHERE category = 'addon_refund' AND description LIKE 'Add-On Refund 2026-08-20%';
--   -- and reverse the balances by the same amounts; the idempotency rows in
--   -- the credit ledger must also be cleared or a re-run will no-op.

DO $$
DECLARE
  r          record;
  v_paid     int := 0;
  v_skipped  int := 0;
  v_total    numeric := 0;
BEGIN
  FOR r IN
    SELECT id, user_id, amount, related_entity_id
      FROM public.wallet_transactions
     WHERE category = 'addon'
       AND type = 'debit'
       AND created_at::date = date '2026-08-20'
     ORDER BY created_at
  LOOP
    IF public.fn_credit_and_log(
         r.user_id,
         r.amount,
         'addon-refund-20260820:' || r.id::text,
         'addon_refund',
         'Add-On Refund 2026-08-20. Charged And Never Delivered.',
         r.related_entity_id,
         'PLAYER',
         NULL,
         NULL
       ) THEN
      v_paid  := v_paid + 1;
      v_total := v_total + r.amount;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'addon refund: paid=% skipped=% total=%', v_paid, v_skipped, v_total;

  IF v_paid = 0 AND v_skipped = 0 THEN
    RAISE EXCEPTION 'addon refund matched no charges at all - the selection is wrong';
  END IF;
END $$;
