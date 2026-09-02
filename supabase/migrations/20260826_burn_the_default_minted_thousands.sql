-- ═══════════════════════════════════════════════════════════════════════════════
-- BURN THE FIVE DEFAULT-MINTED THOUSANDS
--
-- Dan, 2026-08-26: "REMOVE ALL THE FIX EXISTING ROWS CONTAINING THE 1000 CHIPS."
--
-- These are the balances `club_members.chip_balance`'s old `DEFAULT 1000`
-- created out of nothing. Nobody transferred them, nobody bought them, and no
-- ledger row explains them -- which is exactly why they had to go:
-- `chip_balance` is one of the two pools `fn_club_chip_circulation()` counts,
-- and `reconcile_ledger_nightly` compares stored balances against ledger
-- movement, so each one read as drift that nothing could account for.
--
-- The five, none of which had ever played a hand:
--
--   runbabyrun / runthetable45@gmail.com   SHARK CLUB
--   dan@smarter.poker                      SHARK CLUB
--   minhloc73gr                            SHARK CLUB, Club JAQK, Midway Union
--
-- This is a BURN, not a transfer. Chips that were never funded have no source
-- to return to; paying them into a club treasury would move the same unbacked
-- thousand somewhere else and call the books settled.
--
-- DELIBERATELY NARROW. Only rows that are ALL of:
--   * exactly 1000.00 -- the old default, to the cent
--   * zero hands played -- untouched since the row was created
--   * nothing held, nothing locked, nothing owed on credit
-- Anything a player has actually used is left alone. A balance that reached
-- 1000 through real play is not this bug and is not ours to take.
--
-- Every burn is written to `chip_transactions` as 'default_mint_correction' so
-- reconciliation sees the money leave rather than finding a gap where it was.
--
-- ROLLBACK -- read the rows back out of the ledger and re-credit them:
--
--   UPDATE club_members cm SET chip_balance = t.amount
--     FROM chip_transactions t
--    WHERE t.transaction_type = 'default_mint_correction'
--      AND cm.club_id = t.club_id AND cm.user_id = t.from_user_id;
--
--   (only meaningful before those members transact again)
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_expected int;
BEGIN
  SELECT count(*) INTO v_expected
    FROM club_members
   WHERE chip_balance = 1000
     AND COALESCE(hands_played, 0) = 0
     AND COALESCE(held_chips, 0) = 0
     AND COALESCE(locked_chips, 0) = 0
     AND COALESCE(credit_used, 0) = 0;

  IF v_expected = 0 THEN
    RAISE NOTICE 'nothing to burn - the default-minted rows are already gone';
  ELSIF v_expected > 25 THEN
    -- Five were found when this was written. An order-of-magnitude jump means
    -- the mint came back and this migration is the wrong tool for it.
    RAISE EXCEPTION 'expected a handful of default-minted rows, found % - stop and look', v_expected;
  END IF;
END $$;

WITH burned AS (
  UPDATE club_members cm
     SET chip_balance = 0,
         updated_at = now()
   WHERE cm.chip_balance = 1000
     AND COALESCE(cm.hands_played, 0) = 0
     AND COALESCE(cm.held_chips, 0) = 0
     AND COALESCE(cm.locked_chips, 0) = 0
     AND COALESCE(cm.credit_used, 0) = 0
  RETURNING cm.club_id, cm.user_id
)
INSERT INTO chip_transactions
  (id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, metadata)
SELECT gen_random_uuid(), b.club_id, b.user_id, NULL, 1000, 'default_mint_correction',
       'Removed a 1,000 chip balance created by the old club_members.chip_balance DEFAULT 1000. Never funded, never played, burned on Dan''s instruction 2026-08-26.',
       0,
       jsonb_build_object('reason', 'default_mint_burn', 'previous_balance', 1000)
FROM burned b;

DO $$
DECLARE
  v_left int;
  v_burned int;
BEGIN
  SELECT count(*) INTO v_left
    FROM club_members
   WHERE chip_balance = 1000
     AND COALESCE(hands_played, 0) = 0
     AND COALESCE(held_chips, 0) = 0
     AND COALESCE(locked_chips, 0) = 0
     AND COALESCE(credit_used, 0) = 0;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'still % default-minted rows holding 1000', v_left;
  END IF;

  SELECT count(*) INTO v_burned FROM chip_transactions
   WHERE transaction_type = 'default_mint_correction';
  RAISE NOTICE 'default_mint_correction rows on file: %', v_burned;
END $$;
