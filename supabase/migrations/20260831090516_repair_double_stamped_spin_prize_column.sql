-- Tier 2 data repair. Spin 029e92db "3 Chip Spin PLO4" settled twice against the
-- prize COLUMN: the primary settle stamped tournament_players.prize and the
-- "Spin winner back-pay" sweep stamped it again, leaving prize=18.00 on a 9.00 pool.
-- The WALLET is correct: exactly one 9.00 prize credit exists for this event, and
-- across 1,241 completed spins in 24h credited total == pool total exactly. So this
-- is a stats/leaderboard corruption, not chip creation. Realign the column with the
-- money actually paid.
DO $$
DECLARE v_pool numeric; v_paid numeric; v_credited numeric; v_rows int;
BEGIN
  SELECT prize_pool INTO v_pool FROM tournaments WHERE id='029e92db-23dc-42cb-bd79-ad0dac499591';
  SELECT coalesce(sum(prize),0) INTO v_paid FROM tournament_players
   WHERE tournament_id='029e92db-23dc-42cb-bd79-ad0dac499591';
  SELECT coalesce(sum(amount),0) INTO v_credited FROM wallet_transactions
   WHERE related_entity_id='029e92db-23dc-42cb-bd79-ad0dac499591' AND type='credit' AND category='prize';

  IF v_pool IS NULL THEN RAISE EXCEPTION 'pre-flight: target spin not found'; END IF;
  IF v_credited <> v_pool THEN
    RAISE EXCEPTION 'pre-flight: wallet credited % but pool is % - this is a MONEY bug, do not repair the column alone', v_credited, v_pool;
  END IF;
  IF v_paid = v_pool THEN
    RAISE NOTICE 'already consistent, nothing to do'; RETURN;
  END IF;

  UPDATE tournament_players SET prize = v_pool
   WHERE tournament_id='029e92db-23dc-42cb-bd79-ad0dac499591' AND position=1;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'expected exactly 1 winner row, updated %', v_rows; END IF;

  SELECT coalesce(sum(prize),0) INTO v_paid FROM tournament_players
   WHERE tournament_id='029e92db-23dc-42cb-bd79-ad0dac499591';
  IF v_paid <> v_pool THEN RAISE EXCEPTION 'post-apply: prize column still % vs pool %', v_paid, v_pool; END IF;
  RAISE NOTICE 'repaired: prize column realigned to % (wallet credited %)', v_pool, v_credited;
END $$;
