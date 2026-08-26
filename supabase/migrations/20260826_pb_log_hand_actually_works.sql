-- TIER 3. Drops one function overload and adds one nullable column.
-- Applied to production 2026-08-26.
--
-- REPAIRS A FEATURE THAT HAS NEVER ONCE WORKED.
--
-- public.pb_hands has ZERO rows and has never been written to -- while
-- pb_sessions has 34, so people have been using this and only the hand logging
-- was broken. Its only caller, Smarter-Poker-World-Hub/src/lib/poker-brain/
-- storage.js:243 and :390, has been failing and re-queueing offline for the
-- life of the feature. It was broken in two places at once:
--
--   1. TWO overloads differing only by a trailing DEFAULT argument. PostgREST
--      cannot choose between them:
--        POST /rest/v1/rpc/pb_log_hand -> HTTP 300, PGRST203
--        "Could not choose the best candidate function between: ..."
--      So NEITHER was callable, by anyone.
--
--   2. Even resolved, the caller sends p_engine_suggestion, which no overload
--      accepted and for which pb_hands had no column.
--
-- Because the feature is 100% broken today, there is nothing here to regress.
--
-- THE CONTRACT IS READ FROM THE CALLER, NOT GUESSED:
--   HUD.jsx:882    engineSuggestion: lastDecision ? lastDecision.action : null
--   storage.js:236 p_engine_suggestion: hand.engineSuggestion ?? null
-- lastDecision.action is an action label ('fold','call','raise','check'), so the
-- column is text and nullable, matching the sibling `decision` column.
--
-- Deliberately NOT added: `actionContext`, which HUD.jsx:884 passes to
-- storage.logHand() and which storage.js then drops -- it never reaches an RPC
-- argument. Wiring that through is a product decision about what opponent-action
-- summary to persist and in what shape. Left alone.
--
-- Dropping the 16-argument overload is safe: every parameter the surviving
-- signature adds has a DEFAULT, so a caller passing the original 16 positional
-- arguments still resolves unchanged.
--
-- VERIFIED AFTER APPLY
--   a) Resolution, over PostgREST with the publishable key, sending the exact
--      18-key payload storage.js builds:
--        HTTP 403  {"code":"28000","message":"pb_log_hand requires an
--                   authenticated caller"}
--      403/28000 rather than 300/PGRST203 or 404 proves PostgREST now resolves
--      the function AND accepts p_engine_suggestion, and that the anon guard
--      still bites.
--   b) Write path, in a transaction deliberately aborted so nothing committed:
--        PROBE_OK engine_suggestion=raise street={"flop": "raise"} hand=42
--                 decision=raise -- rolled back deliberately
--      pb_hands confirmed still at 0 rows afterwards.
--
-- ROLLBACK:
--   ALTER TABLE public.pb_hands DROP COLUMN engine_suggestion;
--   -- then recreate both overloads from
--   -- 20260826_pb_log_hand_refuses_anonymous_writes.sql

ALTER TABLE public.pb_hands ADD COLUMN IF NOT EXISTS engine_suggestion text;

COMMENT ON COLUMN public.pb_hands.engine_suggestion IS
  'The engine action the poker-brain suggested for this hand (lastDecision.action). Compared against the action actually taken to score agreement.';

DROP FUNCTION IF EXISTS public.pb_log_hand(
  uuid,integer,text,text[],text[],text,numeric,numeric,numeric,numeric,numeric,
  text,numeric,numeric,text,boolean);

DROP FUNCTION IF EXISTS public.pb_log_hand(
  uuid,integer,text,text[],text[],text,numeric,numeric,numeric,numeric,numeric,
  text,numeric,numeric,text,boolean,jsonb);

CREATE OR REPLACE FUNCTION public.pb_log_hand(
  p_session_id uuid, p_hand_number integer, p_position text, p_hole_cards text[],
  p_board text[], p_game_type text, p_pot_size numeric, p_bet_to_call numeric,
  p_stack_size numeric, p_equity numeric, p_pot_odds numeric, p_decision text,
  p_raise_amount numeric, p_confidence numeric, p_reasoning text,
  p_detected_auto boolean DEFAULT false,
  p_street_decisions jsonb DEFAULT NULL::jsonb,
  p_engine_suggestion text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare v_id uuid; v_uid uuid := auth.uid();
begin
  -- Established 2026-08-26: this is SECURITY DEFINER and reachable by anon, so
  -- without this an unauthenticated caller writes rows owned by nobody.
  -- Raising, not returning NULL: the function returns the new hand id, and a
  -- caller silently handed NULL cannot tell "not logged in" from "logged
  -- nothing".
  if v_uid is null then
    raise exception 'pb_log_hand requires an authenticated caller' using errcode = '28000';
  end if;

  insert into public.pb_hands (
    session_id, user_id, hand_number, position, hole_cards, board, game_type,
    pot_size, bet_to_call, stack_size, equity, pot_odds, decision, raise_amount,
    confidence, reasoning, detected_auto, street_decisions, engine_suggestion
  ) values (
    p_session_id, v_uid, p_hand_number, p_position, p_hole_cards, p_board,
    p_game_type, p_pot_size, p_bet_to_call, p_stack_size, p_equity, p_pot_odds,
    p_decision, p_raise_amount, p_confidence, p_reasoning, p_detected_auto,
    p_street_decisions, p_engine_suggestion
  ) returning id into v_id;

  return v_id;
end;
$function$;

DO $$
DECLARE v_n int; v_col int; v_guard int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='pb_log_hand';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'assertion failed: % pb_log_hand overloads remain -- PostgREST needs exactly 1', v_n;
  END IF;

  SELECT count(*) INTO v_col FROM information_schema.columns
   WHERE table_schema='public' AND table_name='pb_hands' AND column_name='engine_suggestion';
  IF v_col <> 1 THEN
    RAISE EXCEPTION 'assertion failed: pb_hands.engine_suggestion missing';
  END IF;

  SELECT count(*) INTO v_guard FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='pb_log_hand'
     AND pg_get_functiondef(p.oid) ~* 'requires an authenticated caller';
  IF v_guard <> 1 THEN
    RAISE EXCEPTION 'assertion failed: the anonymous-caller guard was lost in the rewrite';
  END IF;

  RAISE NOTICE 'pb_log_hand: exactly one overload, engine_suggestion present, anon guard intact';
END $$;
