-- A LEADERBOARD WIN IS A WORD THE WALLET KNOWS.
--
-- 2026-09-03, Dan: "LEADER BOARDS IS THE ONLY PROMO THAT GETS PAID OUT BY THE
-- PROMO WALLET. MAKE SURE THATS BUILT IN AND FULLY WIRED UP AND WORKING."
--
-- It was not working. A rolled-back probe on the real August monthly round -
-- a published programme, real qualified players, real prizes - got as far as
-- paying the first winner and died on:
--
--     new row for relation "wallet_transactions" violates check constraint
--     "wallet_transactions_category_check"
--
-- fn_payout_leaderboard credits winners through fn_credit_and_log with the
-- category 'leaderboard_payout'. chip_ledger has known that word since the
-- leaderboard work landed; wallet_transactions never learned it. So the batch
-- row was written, the funding wallets were debited, and then the first
-- winner's credit aborted the whole transaction. Every leaderboard round with
-- a winner would have failed this way, club-funded or union-funded, and the
-- daily settler would have filed it in leaderboard_payout_failures and moved
-- on. Zero leaderboard batches have ever been paid, which is consistent.
--
-- The fix is the missing word. The old constraint is replaced by the same list
-- plus 'leaderboard_payout', added NOT VALID so the swap is a catalogue change
-- and not a scan of every wallet transaction ever written; the rule binds every
-- new row exactly as before. lock_timeout keeps the brief exclusive lock from
-- queueing behind live play.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.wallet_transactions DROP CONSTRAINT wallet_transactions_category_check;

ALTER TABLE public.wallet_transactions
  ADD CONSTRAINT wallet_transactions_category_check CHECK (
    category = ANY (ARRAY[
      'buyin', 'cashout', 'promo', 'rake', 'transfer', 'tournament_buyin',
      'tournament_winnings', 'tournament_cashout', 'horse_refill', 'deposit',
      'withdrawal', 'refund', 'bbj', 'bonus', 'mint', 'settlement', 'commission',
      'INSURANCE', 'prize', 'rebuy', 'addon', 'funding', 'promotion', 'rakeback',
      'bounty', 'addon_refund', 'bounty_own', 'prize_reversal',
      'leaderboard_payout'
    ])) NOT VALID;

-- Self-check: the word is accepted now and the wallet's own guard still refuses
-- one it does not know. Both probes roll back.
DO $selfcheck$
DECLARE
  v_user uuid;
  v_ok   boolean := false;
  v_bad  boolean := false;
BEGIN
  SELECT user_id INTO v_user FROM public.wallet_transactions
   WHERE created_at > now() - interval '2 hours' AND user_id IS NOT NULL LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE 'LEADERBOARD_WORD_SELFCHECK: no recent wallet row to borrow a user from; skipping';
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.wallet_transactions (user_id, wallet_type, type, category, amount, description)
    VALUES (v_user, 'PLAYER', 'credit', 'leaderboard_payout', 0.01, 'leaderboard word self-check, rolled back');
    v_ok := true;
    RAISE EXCEPTION 'LEADERBOARD_WORD_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'LEADERBOARD_WORD_ROLLBACK' THEN
      RAISE EXCEPTION 'LEADERBOARD_WORD_SELFCHECK: leaderboard_payout is still refused: %', SQLERRM;
    END IF;
  END;

  BEGIN
    INSERT INTO public.wallet_transactions (user_id, wallet_type, type, category, amount, description)
    VALUES (v_user, 'PLAYER', 'credit', 'not_a_real_category', 0.01, 'must be refused, rolled back');
    RAISE EXCEPTION 'LEADERBOARD_WORD_SELFCHECK: the wallet accepted a category it should not know';
  EXCEPTION WHEN check_violation THEN
    v_bad := true;
  END;

  IF NOT (v_ok AND v_bad) THEN
    RAISE EXCEPTION 'LEADERBOARD_WORD_SELFCHECK: accepted=% refused_unknown=%', v_ok, v_bad;
  END IF;

  RAISE NOTICE 'LEADERBOARD_WORD_SELFCHECK_OK: leaderboard_payout accepted, unknown category still refused';
END
$selfcheck$;