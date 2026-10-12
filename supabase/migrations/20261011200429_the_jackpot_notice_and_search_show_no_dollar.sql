-- the_jackpot_notice_and_search_show_no_dollar
--
-- THE JACKPOT NOTICE AND SEARCH SHOW NO DOLLAR SIGN (2026-10-11). Dan,
-- 2026-10-09 23:44 CT: "you are forbidden from using $ the dollar sign
-- anywhere in the club arena. it just needs to say 100 Chip Guarantee".
-- 20261010044850 rewrote the schedules and events. Three database functions
-- still wrote the sign into text a player reads:
--
-- 1. fn_bbj_notify_thresholds wrote the jackpot crossing notice (bell and
--    phone push): "The Bad Beat Jackpot Just Passed $1,000.00". It now says
--    "Passed 1,000.00 Chips" and "is now 1,234.00 Chips".
-- 2. fn_search_players labelled a cash table "$0.5/$1" and an event
--    "$25 Buy-In". They now read "0.5/1" and "25 Buy-In" ("Free Buy" at 0).
-- 3. fn_club_welcome_package_config named a new club's first schedule
--    "Daily $25 Freezeout", so every event it spawned and every push about it
--    carried the sign. It is now "Daily 25 Chip Freezeout", the name the
--    welcome screen already shows. No club holds that schedule today.
--
-- Nothing else changes in any of the three. No row is rewritten; no money
-- moves. scripts/ci/check-ui-dollar.mjs now reads migration SQL from this
-- version on, so a function that spells the sign in its copy fails the push.
--
-- @live-proof: (SELECT position('$' IN public.fn_club_welcome_package_config('welcome-v1')::text) = 0 AND position('Just Passed $' IN pg_get_functiondef('public.fn_bbj_notify_thresholds()'::regprocedure)) = 0 AND position('concat(''$''' IN pg_get_functiondef('public.fn_search_players(text,integer,integer,text,text,text)'::regprocedure)) = 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_n(p_src text, p_anchor text, p_new text, p_count integer, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> p_count THEN
    RAISE EXCEPTION 'NOTICE_NO_DOLLAR_ANCHOR_CHANGED: % found % times, expected %', p_what, v_n, p_count;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch$
DECLARE
  v_src text;
BEGIN
  -- 1. The jackpot crossing notice.
  v_src := pg_get_functiondef('public.fn_bbj_notify_thresholds()'::regprocedure);
  IF position('Just Passed $' IN v_src) = 0 THEN
    RAISE NOTICE 'NOTICE_NO_DOLLAR jackpot notice already applied';
  ELSE
    IF md5(v_src) IS DISTINCT FROM 'b8b543227292d7dede9b4368496380c7' THEN
      RAISE EXCEPTION 'NOTICE_NO_DOLLAR_PREIMAGE_CHANGED: fn_bbj_notify_thresholds';
    END IF;
    v_src := pg_temp.ca_swap_n(v_src,
      $a$'The Bad Beat Jackpot Just Passed $' || trim(to_char(v_t.amount, 'FM999,999,999.00')),$a$,
      $a$'The Bad Beat Jackpot Just Passed ' || trim(to_char(v_t.amount, 'FM999,999,999.00')) || ' Chips',$a$,
      1, 'jackpot title');
    v_src := pg_temp.ca_swap_n(v_src,
      $a$' is now $' ||
                 trim(to_char(v_balance, 'FM999,999,999.00')) ||
                 '. Every raked hand$a$,
      $a$' is now ' ||
                 trim(to_char(v_balance, 'FM999,999,999.00')) ||
                 ' Chips. Every raked hand$a$,
      1, 'jackpot message');
    EXECUTE v_src;
  END IF;

  -- 2. Player search labels.
  v_src := pg_get_functiondef('public.fn_search_players(text,integer,integer,text,text,text)'::regprocedure);
  IF position($a$concat('$'$a$ IN v_src) = 0 THEN
    RAISE NOTICE 'NOTICE_NO_DOLLAR search labels already applied';
  ELSE
    IF md5(v_src) IS DISTINCT FROM 'af8b6a81437395b65c97ef61ee056d53' THEN
      RAISE EXCEPTION 'NOTICE_NO_DOLLAR_PREIMAGE_CHANGED: fn_search_players';
    END IF;
    v_src := pg_temp.ca_swap_n(v_src,
      $a$concat('$', t.small_blind, '/$', t.big_blind)::text AS stakes,$a$,
      $a$concat(t.small_blind, '/', t.big_blind)::text AS stakes,$a$,
      1, 'cash stakes');
    v_src := pg_temp.ca_swap_n(v_src,
      $a$concat('$', coalesce(tr.buy_in_amount, 0), ' Buy-In')::text,$a$,
      $a$(CASE WHEN coalesce(tr.buy_in_amount, 0) = 0 THEN 'Free Buy'
                       ELSE concat(tr.buy_in_amount, ' Buy-In') END)::text,$a$,
      1, 'event buy-in');
    EXECUTE v_src;
  END IF;

  -- 3. The welcome package schedule name.
  v_src := pg_get_functiondef('public.fn_club_welcome_package_config(text)'::regprocedure);
  IF position('Daily $25 Freezeout' IN v_src) = 0 THEN
    RAISE NOTICE 'NOTICE_NO_DOLLAR welcome schedule already applied';
  ELSE
    IF md5(v_src) IS DISTINCT FROM 'a87922d2b5b9569519756fc9217236a6' THEN
      RAISE EXCEPTION 'NOTICE_NO_DOLLAR_PREIMAGE_CHANGED: fn_club_welcome_package_config';
    END IF;
    v_src := pg_temp.ca_swap_n(v_src,
      $a$'Daily $25 Freezeout'$a$, $a$'Daily 25 Chip Freezeout'$a$, 2, 'welcome schedule name');
    EXECUTE v_src;
  END IF;
END
$patch$;

DO $prove$
DECLARE
  v_bbj text := pg_get_functiondef('public.fn_bbj_notify_thresholds()'::regprocedure);
  v_search text := pg_get_functiondef('public.fn_search_players(text,integer,integer,text,text,text)'::regprocedure);
  v_welcome jsonb := public.fn_club_welcome_package_config('welcome-v1');
BEGIN
  IF position('Just Passed $' IN v_bbj) > 0 OR position(' is now $' IN v_bbj) > 0
     OR position($a$|| ' Chips',$a$ IN v_bbj) = 0 OR position(' Chips. Every raked hand' IN v_bbj) = 0 THEN
    RAISE EXCEPTION 'NOTICE_NO_DOLLAR_RESULT_CHANGED: jackpot notice';
  END IF;
  IF position($a$concat('$'$a$ IN v_search) > 0 OR position($a$'/$'$a$ IN v_search) > 0
     OR position($a$concat(t.small_blind, '/', t.big_blind)$a$ IN v_search) = 0
     OR position($a$'Free Buy'$a$ IN v_search) = 0 THEN
    RAISE EXCEPTION 'NOTICE_NO_DOLLAR_RESULT_CHANGED: search labels';
  END IF;
  IF position('$' IN v_welcome::text) > 0
     OR v_welcome #>> '{tournament_schedule,name}' IS DISTINCT FROM 'Daily 25 Chip Freezeout'
     OR v_welcome #>> '{tournament_schedule,config,name}' IS DISTINCT FROM 'Daily 25 Chip Freezeout'
     OR (v_welcome #>> '{tournament_schedule,config,buyIn}')::numeric IS DISTINCT FROM 25 THEN
    RAISE EXCEPTION 'NOTICE_NO_DOLLAR_RESULT_CHANGED: welcome schedule';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.fn_bbj_notify_thresholds()'::regprocedure)
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.fn_search_players(text,integer,integer,text,text,text)'::regprocedure) THEN
    RAISE EXCEPTION 'NOTICE_NO_DOLLAR_RESULT_CHANGED: definer attribute';
  END IF;
END
$prove$;

COMMIT;
