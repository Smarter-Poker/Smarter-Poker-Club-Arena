-- =============================================================================
-- deep_stack_everyone_starts_with_ten_thousand
-- Applied to production via Supabase MCP 2026-09-01 13:28 UTC.
--
-- Dan, 2026-09-01, verbatim: "THEY ARE ALL SUPPOSED TO START WITH 10,000
-- CHIPS... AFTER PLAY THAT WILL CHANGE OBVIOUSLY, BUT I WANT TO SEE ALL
-- AGENTS AND PLAYERS WITH CHIP BALANCES BEFORE I GREEN LIGHT PLAY."
--
-- Two steps, one transaction:
--
-- 1. The 7 seats still open on Deep Stack tables leave through
--    player_leave_table -- the canonical tab-close exit (CLAUDE.md 11.5
--    refund table: cash tab-close -> club_members.chip_balance). Benching
--    stopped NEW seating but not the horses already dealt in; hands were
--    still appearing at 13:26 UTC. With every horse disabled and the felt
--    cleared, the engine has nobody to re-seat.
--
-- 2. Every one of the 416 horse balances is set to exactly 10,000. The
--    autoledger on club_members books each delta, so the drift (play
--    winnings/losses, range 9,725-10,400) leaves through the same ledgered
--    door it came in by. Batched 30 rows per statement -- the ledger-writer
--    trigger times out on large single updates.
--
-- Verified after commit: 416/416 at exactly 10,000 (sum 4,160,000), zero
-- open seats.
-- =============================================================================
DO $$
DECLARE
  v_club uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_seat record; v_open int; v_not10k int; v_total numeric; v_batch int;
BEGIN
  -- Step 1: clear the felt through the canonical exit
  FOR v_seat IN
    SELECT ts.table_id, ts.user_id
      FROM table_seats ts JOIN tables t ON t.id=ts.table_id
     WHERE t.club_id=v_club AND ts.left_at IS NULL
  LOOP
    PERFORM player_leave_table(v_seat.table_id, v_seat.user_id);
  END LOOP;

  SELECT count(*) INTO v_open
    FROM table_seats ts JOIN tables t ON t.id=ts.table_id
   WHERE t.club_id=v_club AND ts.left_at IS NULL;
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'felt not clear: % seats still open', v_open;
  END IF;

  -- Step 2: reset every horse to exactly 10,000, in trigger-safe batches
  LOOP
    WITH pick AS (
      SELECT ctid FROM club_members
       WHERE club_id=v_club AND is_bot AND chip_balance <> 10000
       LIMIT 30)
    UPDATE club_members cm SET chip_balance = 10000
      FROM pick WHERE cm.ctid = pick.ctid;
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    EXIT WHEN v_batch = 0;
  END LOOP;

  SELECT count(*) FILTER (WHERE chip_balance <> 10000), sum(chip_balance)
    INTO v_not10k, v_total
    FROM club_members WHERE club_id=v_club AND is_bot;

  IF v_not10k <> 0 OR v_total <> 4160000 THEN
    RAISE EXCEPTION 'reset wrong: %_rows_not_10k, total=%', v_not10k, v_total;
  END IF;
END $$;
