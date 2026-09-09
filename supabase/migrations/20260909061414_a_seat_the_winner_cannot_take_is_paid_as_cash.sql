-- A SEAT THE WINNER CANNOT TAKE IS PAID AS CASH (2026-09-09)
--
-- `fn_deliver_satellite_ticket_exact` already knows that a seat is sometimes
-- undeliverable, and already has the answer: pay the frozen ticket value in
-- cash. It returns delivery='cash' for four such cases -
--   target_missing, target_not_open, target_economics_changed,
--   seat_already_held_elsewhere
-- and its caller settles those through fn_settle_satellite_cash_entitlement_exact.
--
-- There is a fifth case it does not handle: the winner is already in four
-- games. `fn_enforce_booking_game_cap` raises FOUR TABLE LIMIT (23514) inside
-- fn_award_satellite_seat, which propagates and aborts the whole atomic
-- settlement instead of falling through to cash.
--
-- MEASURED 2026-09-09: 11 finished satellites holding 1,349.00 chips could not
-- settle for this reason, some for more than a day, and nothing retries them.
-- Every one has a clean winner. The cap is not a temporary condition for these
-- winners - they are horses that stay in four games continuously - so waiting
-- does not clear it. The chips simply never leave.
--
-- The cap itself is correct and stays: CLAUDE.md 10.5 requires it to apply to
-- horses exactly as to humans, and it protects deck capacity and engine load.
-- What is wrong is treating "this player cannot take another game right now" as
-- a settlement failure rather than as what it plainly is - an undeliverable
-- seat, which this function already knows how to pay.
--
-- NARROWNESS IS THE POINT. Only a check_violation whose message is the cap is
-- converted. Every other check_violation in this path means the money did not
-- add up (an unbacked pool transfer, an inexact payout event, an ambiguous
-- existing seat) and MUST still abort the settlement. The catch is a
-- subtransaction, so a refused award leaves nothing behind.
--
-- ROLLBACK: restore fn_deliver_satellite_ticket_exact from ca_guard_def_history
-- (the seats and cash already delivered are real and are not reversed).

BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '120s';

DO $mig$
DECLARE
  v_def    text;
  v_anchor CONSTANT text := '  v_result:=public.fn_award_satellite_seat(
    p_satellite_id,p_target_id,p_user_id,p_username,p_position);';
  v_new    CONSTANT text := $n$  /* A SEAT THE WINNER CANNOT TAKE IS PAID AS CASH (2026-09-09). The
     concurrent-game cap refuses the booking for a winner already in four
     games. That is an undeliverable seat, not a broken settlement, and this
     function already pays undeliverable seats in cash. Only the cap is
     converted; every other check_violation here means the money did not add
     up and must still abort. */
  BEGIN
    v_result:=public.fn_award_satellite_seat(
      p_satellite_id,p_target_id,p_user_id,p_username,p_position);
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM LIKE '%FOUR TABLE LIMIT%' THEN
      RETURN jsonb_build_object('delivery','cash',
                                'reason','winner_at_concurrent_game_cap');
    END IF;
    RAISE;
  END;$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_deliver_satellite_ticket_exact';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_deliver_satellite_ticket_exact is missing'; END IF;
  IF position('winner_at_concurrent_game_cap' in v_def) > 0 THEN
    RAISE NOTICE 'already present';
  ELSE
    IF position(v_anchor in v_def) = 0 THEN
      RAISE EXCEPTION 'the seat-award call this migration guards has moved; re-read the function';
    END IF;
    -- The four existing cash reasons must all survive the edit.
    IF position('target_missing' in v_def) = 0
       OR position('target_not_open' in v_def) = 0
       OR position('target_economics_changed' in v_def) = 0
       OR position('seat_already_held_elsewhere' in v_def) = 0 THEN
      RAISE EXCEPTION 'the existing cash fallbacks are not all present; refusing to edit';
    END IF;
    EXECUTE replace(v_def, v_anchor, v_new);
  END IF;
END $mig$;

DO $post$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_deliver_satellite_ticket_exact';
  IF position('winner_at_concurrent_game_cap' in v_def) = 0 THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;
  -- every prior behaviour still there
  IF position('target_missing' in v_def) = 0
     OR position('target_not_open' in v_def) = 0
     OR position('target_economics_changed' in v_def) = 0
     OR position('seat_already_held_elsewhere' in v_def) = 0
     OR position('exact target-seat award refused or wrote incomplete money' in v_def) = 0
     OR position('target seat, payout and pool transfer are not one exact event' in v_def) = 0 THEN
    RAISE EXCEPTION 'a landmark of the seat-delivery contract went missing during replacement';
  END IF;
END $post$;

COMMIT;
