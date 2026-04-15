-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase F-2 #2 — Race-Condition Double-Spend Test (Atomic Buy-In Lock)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Validates that 100 concurrent lock_for_buyin calls with same user produce
-- exactly 1 success and 99 failures, no chip duplication.
--
-- Usage (psql):
--   psql "$DATABASE_URL" -v test_user_id="'<uuid>'" -v test_table_id="'<uuid>'" \
--                         -v test_amount=1000 \
--                         -f scripts/verification-harness/03-double-spend-buyin.sql
-- ═══════════════════════════════════════════════════════════════════════════════

-- Setup: capture starting balance
DO $$
DECLARE
  v_start NUMERIC;
  v_user UUID := :test_user_id;
  v_table UUID := :test_table_id;
  v_amount NUMERIC := :test_amount;
  v_success_count INT := 0;
  v_fail_count INT := 0;
  v_end NUMERIC;
  i INT;
  v_result BOOLEAN;
BEGIN
  -- Get starting wallet balance
  SELECT balance INTO v_start
  FROM wallets
  WHERE user_id = v_user AND wallet_type = 'PLAYER';

  RAISE NOTICE 'STARTING BALANCE: %', v_start;

  -- Attempt 100 concurrent buy-in locks (sequential here for simplicity;
  -- in production use pgbench --client=100 for true concurrency)
  FOR i IN 1..100 LOOP
    BEGIN
      SELECT public.lock_for_buyin(v_user, v_table, v_amount) INTO v_result;
      IF v_result THEN
        v_success_count := v_success_count + 1;
      ELSE
        v_fail_count := v_fail_count + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fail_count := v_fail_count + 1;
    END;
  END LOOP;

  -- Get ending balance
  SELECT balance INTO v_end
  FROM wallets
  WHERE user_id = v_user AND wallet_type = 'PLAYER';

  RAISE NOTICE '────────────────────────────────────────';
  RAISE NOTICE 'SUCCESS COUNT: %', v_success_count;
  RAISE NOTICE 'FAIL COUNT: %', v_fail_count;
  RAISE NOTICE 'STARTING BALANCE: %', v_start;
  RAISE NOTICE 'ENDING BALANCE: %', v_end;
  RAISE NOTICE 'EXPECTED ENDING: % (start - amount)', v_start - v_amount;
  RAISE NOTICE 'ACTUAL DELTA: %', v_start - v_end;
  RAISE NOTICE '────────────────────────────────────────';

  IF v_success_count = 1 AND v_fail_count = 99 AND (v_start - v_end) = v_amount THEN
    RAISE NOTICE 'PASS — exactly 1 lock succeeded, exactly amount debited';
  ELSE
    RAISE EXCEPTION 'FAIL — race condition allowed % concurrent locks; balance delta=%, expected=%',
      v_success_count, v_start - v_end, v_amount;
  END IF;

  -- Cleanup: release the lock
  PERFORM public.unlock_from_table(v_user, v_table, v_amount);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- For TRUE concurrency, run via pgbench:
--   pgbench -c 100 -t 1 -f /tmp/buyin_lock.sql "$DATABASE_URL"
-- where /tmp/buyin_lock.sql contains:
--   SELECT lock_for_buyin('<user-id>', '<table-id>', 1000);
-- Expect: exactly 1 success, 99 failures, exactly 1000 debited from wallet.
-- ═══════════════════════════════════════════════════════════════════════════════
