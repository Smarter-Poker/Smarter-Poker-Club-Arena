-- ============================================================================
-- THE STAFF DIAMOND CANCELLATION IS A REVIEWED LANE AUTHORITY
-- ============================================================================
--
-- Phase 10 of the Diamond Arena programme, a follow-up to
-- 20260929213000_staff_run_a_diamond_game_on_the_record. That migration added
-- fn_poker_diamond_cancel_tournament, the platform-staff door onto the Diamond
-- cancellation authority. The door takes the global settlement lane
-- (fn_ca_lock_settlement_lane_global) before it locks the event row, because
-- the authority it calls, fn_poker_diamond_tournament_cancel, takes the lane
-- first and then the row, and the door reads the row it hands over under the
-- same locks in the same order.
--
-- The settlement lane doctrine (public.fn_ca_settlement_lane_doctrine, asked of
-- the live catalog by CI) requires every function that calls the global
-- helper to be a reviewed global authority, and the door was not on its list,
-- so the doctrine answered not ok.
--
-- Reviewed for what it writes: one event per call, rare, staff only. It writes
-- nothing itself before the authority does. The lane it takes is the lane the
-- authority takes, re-entrantly, in the same order: global lane, then the
-- event. It is the same kind of door as atomic_cancel_tournament,
-- fn_close_managed_game and fn_execute_managed_game_command, which are already
-- on the list. No rolling authority calls it. It joins the list, and nothing
-- else in the doctrine changes.
--
-- In place: live md5 pinned, the clause found exactly once, the reverse
-- substitution proved. The doctrine must answer ok at the end.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_ca_settlement_lane_doctrine   9508891e4815a9bdb13a51f231a75de5
-- ============================================================================

DO $m$
DECLARE
  v_oid oid := 'public.fn_ca_settlement_lane_doctrine()'::regprocedure;
  v_def text; v_old text; v_new text; v_n integer; v_answer jsonb;
BEGIN
  IF to_regprocedure('public.fn_poker_diamond_cancel_tournament(uuid)') IS NULL THEN
    RAISE EXCEPTION 'fn_poker_diamond_cancel_tournament is not installed; apply 20260929213000 first';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '9508891e4815a9bdb13a51f231a75de5' THEN
    RAISE EXCEPTION 'fn_ca_settlement_lane_doctrine is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := $x$'fn_get_tournament_deal_consensus','fn_mystery_bounty_settle','fn_poker_diamond_tournament_cancel',$x$;
  v_new := $x$'fn_get_tournament_deal_consensus','fn_mystery_bounty_settle','fn_poker_diamond_cancel_tournament',
    'fn_poker_diamond_tournament_cancel',$x$;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the doctrine: the reviewed list clause occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '9508891e4815a9bdb13a51f231a75de5' THEN
    RAISE EXCEPTION 'the doctrine: the reverse substitution does not reproduce the pinned text';
  END IF;

  -- The doctrine holds on the catalog as this migration leaves it.
  v_answer := public.fn_ca_settlement_lane_doctrine();
  IF (v_answer->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'the settlement lane doctrine does not hold: %', v_answer->'violations';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'the doctrine is reachable by a browser; it is read by the engine role';
  END IF;
  RAISE NOTICE 'the staff Diamond cancellation is a reviewed lane authority; the doctrine holds';
END $m$;
