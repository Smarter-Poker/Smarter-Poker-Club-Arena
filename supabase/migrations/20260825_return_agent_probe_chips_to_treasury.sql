-- ═══════════════════════════════════════════════════════════════════════════
-- RETURN 48 CHIPS AN AGENT'S PROBE TOOK OUT OF CIRCULATION
-- ───────────────────────────────────────────────────────────────────────────
-- NOT a product defect. On 2026-08-25 an agent verifying the new no-rathole
-- rule called atomic_table_buyin against PRODUCTION instead of inside a
-- transaction it rolled back. Two buy-ins succeeded (8.00 and 40.00) at
-- NLH 6-Max 0.10/0.20, and the probe's cleanup then DELETED the seat rows
-- directly rather than leaving through fn_leave_seat_and_refund. Deleting a
-- seat skips the refund, so 48.00 left a member wallet and landed nowhere.
--
-- Dan: "the 48 chips can go to the main bank." Returned to the club treasury
-- rather than to the member: the chips left circulation and the treasury is
-- where unattributed chips belong. Recorded as a 'correction', which is what
-- the type check calls this.
--
-- The rule that stops it recurring is CLAUDE.md section 11.5, with the
-- transaction-rollback pattern in scripts/dev/probe-rpc.sql.
--
-- APPLIED to production 2026-08-25. Treasury 1,476,596.87 -> 1,476,644.87.
-- ═══════════════════════════════════════════════════════════════════════════

DO $migration$
DECLARE
  v_table   uuid := '4bbc2576-4737-4343-bee4-cb22982f79ef';
  v_user    uuid := '3d85f161-27ce-45f4-b94b-1d42c62252af';
  v_club    uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  v_amount  numeric := 48.00;
  v_orphans int;
  v_seats   int;
  v_after   numeric;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.club_wallet_transactions
     WHERE club_id = v_club AND reason = 'agent probe reversal 2026-08-25'
  ) THEN
    RAISE NOTICE 'already returned; nothing to do';
    RETURN;
  END IF;

  SELECT count(*) INTO v_orphans
    FROM public.wallet_transactions
   WHERE user_id = v_user AND table_id = v_table AND category = 'buyin'
     AND created_at BETWEEN '2026-08-25 21:42:00+00' AND '2026-08-25 21:43:00+00';

  SELECT count(*) INTO v_seats
    FROM public.table_seats
   WHERE table_id = v_table AND user_id = v_user;

  IF v_orphans <> 2 THEN
    RAISE EXCEPTION 'expected the two probe debits, found % - refusing to guess', v_orphans;
  END IF;
  IF v_seats <> 0 THEN
    RAISE EXCEPTION 'a seat exists for this player at that table - not the orphaned state';
  END IF;

  UPDATE public.clubs
     SET chip_treasury = COALESCE(chip_treasury, 0) + v_amount
   WHERE id = v_club
   RETURNING chip_treasury INTO v_after;

  INSERT INTO public.club_wallet_transactions (club_id, type, amount, balance_after, reason)
  VALUES (v_club, 'correction', v_amount, v_after, 'agent probe reversal 2026-08-25');

  RAISE NOTICE 'treasury now %', v_after;
END
$migration$;

DO $verify$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.club_wallet_transactions
   WHERE reason = 'agent probe reversal 2026-08-25';
  IF n <> 1 THEN
    RAISE EXCEPTION 'the reversal is not recorded exactly once (found %)', n;
  END IF;
END
$verify$;

-- ROLLBACK: subtract 48.00 from clubs.chip_treasury for that club and delete
-- the marker row. Only meaningful if the reversal was itself a mistake.
