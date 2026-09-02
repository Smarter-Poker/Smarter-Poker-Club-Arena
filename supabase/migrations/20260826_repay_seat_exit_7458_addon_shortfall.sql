-- 20260826_repay_seat_exit_7458_addon_shortfall.sql
--
-- TIER 3. MOVES REAL MONEY. Read the whole header.
--
-- WHAT HAPPENED
-- On table 06a161fe-caa0-4c22-999a-44c0cae13fc9, user a916c222, three events
-- inside two seconds:
--
--   12:55:23.452  wallet_transactions  DEBIT  25.90  'Table add-on (club wallet)'
--   12:55:24.529  wallet_transactions  CREDIT 19.10  'Cash-out from table'
--   12:55:25.419  ca_seat_stack_exits  stack  45.00  exit_kind 'left'
--
--   19.10 + 25.90 = 45.00, exactly.
--
-- The add-on reached the felt (the seat exit recorded a 45.00 stack, not 19.10)
-- but the cash-out one second later paid out the PRE-add-on stack. The seat row
-- was then closed. 25.90 chips left the member wallet, sat on the felt, and were
-- destroyed when the seat closed.
--
-- This is not a transfer that went to the wrong place. Total chip circulation
-- fell by 25.90. This migration restores it to the player it was taken from. It
-- does not debit the club treasury, because the treasury never received it.
--
-- WHY IT IS SAFE TO DO THIS BLIND
-- The arithmetic is exact and the guard below refuses to run twice. Verified
-- immediately before writing:
--   club_members.chip_balance ............ 50956.04
--   existing correction rows for 7458 .... 0
--   still seated at that table ........... 0 (seat is closed, nothing in flight)
--
-- PER CLAUDE.md 11.5: this is REMEDIATION of a verified shortfall, not a probe.
-- No money path was called to "test" anything. The precedent is
-- 20260825_return_agent_probe_chips_to_treasury_v2 and the hand-written
-- correction row for hand #1458859 ("lost to mid-hand cashout race ... refund of
-- 14.18 shortfall").
--
-- THIS DOES NOT FIX THE BUG. The add-on/cash-out race is engine-side and is
-- being addressed separately (see 20260826151027
-- an_addon_that_cannot_apply_must_not_debit). This pays back the one player the
-- race has demonstrably cost so far.
--
-- ROLLBACK
--   SELECT public.fn_add_chips(
--     'a916c222-1eb9-4e73-89ee-a92e289b80eb'::uuid,
--     'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, -25.90);
--   DELETE FROM public.wallet_transactions
--    WHERE description = 'Correction: seat exit 7458 add-on shortfall (25.90)';

DO $$
DECLARE
  v_user  uuid := 'a916c222-1eb9-4e73-89ee-a92e289b80eb';
  v_club  uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  v_table uuid := '06a161fe-caa0-4c22-999a-44c0cae13fc9';
  v_amt   numeric := 25.90;
  v_desc  text := 'Correction: seat exit 7458 add-on shortfall (25.90)';
  v_before numeric;
  v_after  numeric;
BEGIN
  -- Idempotency. Re-running this migration must never pay twice.
  IF EXISTS (SELECT 1 FROM public.wallet_transactions WHERE description = v_desc) THEN
    RAISE NOTICE 'seat exit 7458 already repaid; nothing to do';
    RETURN;
  END IF;

  SELECT chip_balance INTO v_before
    FROM public.club_members WHERE user_id = v_user AND club_id = v_club;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'no club_members row for user % in club % -- refusing to guess a destination', v_user, v_club;
  END IF;

  PERFORM public.fn_add_chips(v_user, v_club, v_amt);

  PERFORM public.log_wallet_transaction(
    v_user, 'PLAYER', v_amt, 'credit', 'refund', v_desc, v_table, NULL, NULL);

  SELECT chip_balance INTO v_after
    FROM public.club_members WHERE user_id = v_user AND club_id = v_club;

  IF v_after - v_before <> v_amt THEN
    RAISE EXCEPTION 'balance moved by %, expected % -- rolling back', v_after - v_before, v_amt;
  END IF;

  RAISE NOTICE 'repaid % to user % (% -> %)', v_amt, v_user, v_before, v_after;
END $$;

-- The alarm this repays should now be silent.
DO $$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left FROM public.fn_unaccounted_seat_exits('7 days','10 minutes');
  IF v_left <> 0 THEN
    RAISE WARNING 'fn_unaccounted_seat_exits still reports % unaccounted exit(s) -- investigate', v_left;
  ELSE
    RAISE NOTICE 'fn_unaccounted_seat_exits is clean';
  END IF;
END $$;
