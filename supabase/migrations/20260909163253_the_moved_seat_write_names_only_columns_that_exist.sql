DO $mig$
DECLARE v_src text; v_new text;
BEGIN
  /* CAUGHT BY THE PROBE, WHICH IS WHY THE PROBE EXISTS. The branch added in
     20260909115007 wrote `SET stack = ..., updated_at = now()` on table_seats.
     table_seats has no updated_at column, so the statement raised
     42703 the moment the branch was actually reached - turning "the hand is
     kept" back into "the hand is refused", with a worse message.

     The first probe missed it: it revived the mover's chair on the SAME table
     with left_at NULL, so the ordinary seated lookup found the seat and the new
     branch never ran. A probe that does not reach the code it is testing
     proves nothing, and it read as a pass. The second probe put the player on
     no chair at all, reached the branch, and the column error came straight
     back.

     Nothing else in this function stamps updated_at on a seat; the seated path
     writes `stack` alone. */
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_settle_hand_stacks_absolute';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_settle_hand_stacks_absolute is gone'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='table_seats' AND column_name='updated_at') THEN
    RAISE EXCEPTION 'table_seats now HAS updated_at; re-read this before removing the write';
  END IF;
  IF position($chk$             SET stack = round(ts.stack + (v_new - v_before), 2), updated_at = now()$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the moved-seat write moved; re-read it before editing';
  END IF;

  v_new := replace(v_src,
$old$             SET stack = round(ts.stack + (v_new - v_before), 2), updated_at = now()$old$,
$new$             SET stack = round(ts.stack + (v_new - v_before), 2)$new$);

  IF v_new = v_src THEN RAISE EXCEPTION 'the moved-seat write was not corrected'; END IF;
  EXECUTE v_new;

  IF (SELECT position($chk$updated_at = now()
           WHERE ts.id = v_moved_seat_id$chk$ IN pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_settle_hand_stacks_absolute') <> 0 THEN
    RAISE EXCEPTION 'the column that does not exist is still being written';
  END IF;
  IF (SELECT position($chk$A TOURNAMENT SEAT THAT MOVED MID-HAND KEEPS ITS RESULT$chk$ IN pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_settle_hand_stacks_absolute') = 0 THEN
    RAISE EXCEPTION 'the moved-seat branch went missing';
  END IF;
END
$mig$;;
