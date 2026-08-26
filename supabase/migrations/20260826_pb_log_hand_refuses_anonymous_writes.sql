-- TIER 2. Adds a guard to two overloads. Applied to production 2026-08-26.
--
-- pb_log_hand is SECURITY DEFINER and executable by anon. It inserts into
-- pb_hands with user_id = auth.uid(); for an unauthenticated caller that is
-- NULL, so anon could insert orphan rows belonging to nobody that no RLS policy
-- will ever return and nothing cleans up.
--
-- It was the only WRITING function among the 93 anon-callable SECURITY DEFINER
-- functions that did not establish identity. (Of those 93: 30 guard on a null
-- uid; 52 never touch identity but are strictly read-only; of the remaining 11
-- the only other writer is a trigger function, which PostgREST cannot invoke.)
--
-- The guard RAISES rather than returning NULL: the function returns the new hand
-- id, and a caller that silently receives NULL cannot tell "not logged in" from
-- "logged nothing".
--
-- READ THIS BEFORE ASSUMING THE FEATURE NOW WORKS. It does not, and this
-- migration does not claim to fix it. Verified after applying, calling over
-- PostgREST as anon:
--
--   HTTP 300  PGRST203
--   "Could not choose the best candidate function between:
--    public.pb_log_hand(...16 args...), public.pb_log_hand(...17 args...)"
--
-- The two overloads differ only by a trailing DEFAULT argument, so PostgREST
-- cannot resolve either of them -- for anon or for anyone. pb_hands has ZERO
-- rows and has never been written to. Its only caller,
-- Smarter-Poker-World-Hub/src/lib/poker-brain/storage.js (lines 243 and 390),
-- has been retrying and queueing failures offline this whole time.
--
-- And resolving the overloads alone would still not fix it: that caller sends
-- p_engine_suggestion, which neither overload accepts and for which pb_hands has
-- no column. The feature is broken at three layers and finishing it needs
-- product intent, not a guess from the database side. Left for its owner.
--
-- ROLLBACK: drop the two IF blocks; the INSERTs are untouched.

CREATE OR REPLACE FUNCTION public.pb_log_hand(
  p_session_id uuid, p_hand_number integer, p_position text, p_hole_cards text[],
  p_board text[], p_game_type text, p_pot_size numeric, p_bet_to_call numeric,
  p_stack_size numeric, p_equity numeric, p_pot_odds numeric, p_decision text,
  p_raise_amount numeric, p_confidence numeric, p_reasoning text,
  p_detected_auto boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_id uuid; v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'pb_log_hand requires an authenticated caller' using errcode = '28000';
  end if;
  insert into public.pb_hands (
    session_id, user_id, hand_number, position, hole_cards, board, game_type,
    pot_size, bet_to_call, stack_size, equity, pot_odds, decision, raise_amount,
    confidence, reasoning, detected_auto
  ) values (
    p_session_id, v_uid, p_hand_number, p_position, p_hole_cards, p_board,
    p_game_type, p_pot_size, p_bet_to_call, p_stack_size, p_equity, p_pot_odds,
    p_decision, p_raise_amount, p_confidence, p_reasoning, p_detected_auto
  ) returning id into v_id;
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.pb_log_hand(
  p_session_id uuid, p_hand_number integer, p_position text, p_hole_cards text[],
  p_board text[], p_game_type text, p_pot_size numeric, p_bet_to_call numeric,
  p_stack_size numeric, p_equity numeric, p_pot_odds numeric, p_decision text,
  p_raise_amount numeric, p_confidence numeric, p_reasoning text,
  p_detected_auto boolean DEFAULT false, p_street_decisions jsonb DEFAULT NULL::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_id uuid; v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'pb_log_hand requires an authenticated caller' using errcode = '28000';
  end if;
  insert into public.pb_hands (
    session_id, user_id, hand_number, position, hole_cards, board, game_type,
    pot_size, bet_to_call, stack_size, equity, pot_odds, decision, raise_amount,
    confidence, reasoning, detected_auto, street_decisions
  ) values (
    p_session_id, v_uid, p_hand_number, p_position, p_hole_cards, p_board,
    p_game_type, p_pot_size, p_bet_to_call, p_stack_size, p_equity, p_pot_odds,
    p_decision, p_raise_amount, p_confidence, p_reasoning, p_detected_auto,
    p_street_decisions
  ) returning id into v_id;
  return v_id;
end;
$function$;

DO $$
DECLARE v_guarded int; v_total int;
BEGIN
  SELECT count(*) INTO v_total FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='pb_log_hand';
  SELECT count(*) INTO v_guarded FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='pb_log_hand'
     AND pg_get_functiondef(p.oid) ~* 'requires an authenticated caller';
  IF v_total <> 2 THEN
    RAISE EXCEPTION 'assertion failed: expected 2 pb_log_hand overloads, found %', v_total;
  END IF;
  IF v_guarded <> 2 THEN
    RAISE EXCEPTION 'assertion failed: only %/2 pb_log_hand overloads carry the guard', v_guarded;
  END IF;
  RAISE NOTICE 'pb_log_hand: both overloads refuse anonymous callers';
END $$;
