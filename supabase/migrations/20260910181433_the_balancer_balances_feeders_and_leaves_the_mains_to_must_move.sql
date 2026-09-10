-- 20260910181433_the_balancer_balances_feeders_and_leaves_the_mains_to_must_move
--
-- Version reserved by scripts/reserve-migration-version.sh (CLAUDE.md 4.5).
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE BALANCER AND THE MUST-MOVE STEP WERE MOVING THE SAME PLAYERS BACK AND
--  FORTH, EVERY HAND
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Found by lane J of the 2026-09-09 must-move audit (lane-J.md section 6).
-- This is the largest thing on the floor and it was in no handoff.
--
-- TWO RULES, ONE SEAT.
--
--   fn_cash_cluster_tick step 2 (MUST-MOVE, OPORD 1.3 s9.5): for EVERY main
--   with an unreserved open seat, plan the longest-seated feeder player onto
--   it. Every main is held FULL from the feeder, Main 2..N included.
--
--   fn_cash_cluster_balance (20260906011318): pool every live table except
--   Main 1 - so Main 2..N PLUS the feeder - and when the fullest table holds
--   two more than the emptiest table with room, move the NEWEST arrival from
--   the fullest to the emptiest.
--
-- fn_cash_clusters_tick_all runs the tick and then the balancer on every pass,
-- about every five seconds. With Main N full at six and the feeder at four the
-- balancer moves a player Main N -> feeder; that opens a seat on Main N; the
-- next tick's step 2 plans the longest-seated feeder player back onto it; the
-- board is exactly as it was and the balancer fires again.
--
-- MEASURED on production, 2026-09-09 17:00-18:00 UTC (lane J):
--
--   balance   main -> feeder    381 done moves
--   must_move feeder -> main    394 done moves
--   exact round trips (a balance main->feeder followed by a must_move of the
--   SAME player from that feeder back to that SAME main): 355 of 383
--   median gap between the two legs: 37.7 s
--   47 players moved 787 times in the hour; two of them 55 times each
--   one player: 18 consecutive done moves, strictly alternating
--     balance / must_move / balance / must_move, 17:33 to 18:04
--
-- Present every hour of the preceding thirty, 168-227 an hour at peak, worst
-- when the floor is fullest - because it scales with how many mains are held
-- full. It is also the load behind the 55P03 lock-timeout tick errors and the
-- SEAT_MOVE_GAME_SCOPE_MISMATCH burst. Not a money defect: every move
-- conserved its stack.
--
-- WHAT THE BALANCER WAS WRITTEN FOR. Its own header (20260906011318): "the
-- must-move tables are balanced among themselves ... Main 1 is held FULL on
-- purpose and is not part of the balancing pool." The intent was the FEEDER
-- tables - a room with several feeders keeping them within one player of each
-- other. But the pool it built was "everything except Main 1", and Main 2..N
-- are held full by must-move exactly as Main 1 is. With allow_second_feeder =
-- false on every one of the 109 enabled games there is never more than one
-- feeder, so the only thing the balancer could ever do on this floor was fight
-- step 2.
--
-- THE RULE, decided here and written down:
--
--   The balancing pool is the LIVE FEEDERS of the game, and nothing else.
--   Mains are never in it - neither as the table a player leaves nor as the
--   table a player is sent to. With one feeder the pool has one entry and the
--   balancer does nothing, which is the correct answer for every game on the
--   floor today. With two feeders (allow_second_feeder) it keeps them within
--   one player of each other, which is what it was written for.
--
-- SHOULD A MAIN WITH AN OPEN SEAT EVER RECEIVE A BALANCE MOVE? No.
--
--   1. Step 2 is the ONE writer of main seats, and its order is Dan's rule:
--      "YOU ALSO NEED TO RECORD AND POST THE ORDER OF WHEN A PLAYER 'JOINED
--      THE GAME' THATS THE MUST MOVE ORDER." Step 2 fills a main from the
--      longest-seated; the balancer moves the NEWEST arrival. Two writers with
--      opposite orders on the same seats is precisely the round trip.
--   2. A main's open seat is filled by step 2 from the feeder inside one
--      tick. There is nothing left for a balancer to add there, and a main
--      that step 2 could not fill (an empty feeder) is a main the balancer
--      could not fill either.
--   3. Moving a player OFF a main is never balancing; it is un-doing step 2.
--
-- And an EMPTY feeder never receives one either: `lo.n >= 1` stays. A table
-- with nobody on it is not a table to balance into; it is a table step 5 is
-- about to close.
--
-- WHAT THIS DOES NOT CHANGE. The thresholds (`hi.n - lo.n >= 2`, `hi.n >= 3`,
-- `lo.n >= 1`), the newest-arrival choice, the busted / leave_pending /
-- pending-move / back-off exclusions, and the `move_planned` event are all as
-- they were. The back-off predicate is kept byte-for-byte on purpose:
-- 20260910181447 re-keys it by anchored replacement and depends on this text.
--
-- EXPECTED EFFECT. Every `balance main -> feeder` move and its returning
-- `must_move feeder -> main` leg disappear: in the measured hour that is
-- ~355 x 2 = ~710 of ~787 moves, and the "Moving After This Hand" notice
-- stops being the normal state of a full game. Re-measure after apply with
-- the query in lane-A.md section 10.
--
-- The whole body is re-emitted (it is 3.4 KB) and is guarded on the md5 of the
-- live definition it was written against, so a change underneath it is
-- refused rather than overwritten.
--
-- ROLLBACK
--   Restore the pool predicate to
--     WHERE c.lifecycle = 'live' AND NOT c.breaking
--       AND NOT (c.role = 'main' AND c.main_index = 1)
--   (the 20260906011318 body).
--
-- ONE transaction (production DDL policy).

BEGIN;

DO $guard$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.fn_cash_cluster_balance'::regproc);
  IF position('THE POOL IS THE FEEDERS' in v_def) > 0 THEN
    RAISE NOTICE 'already applied; nothing to do';
    RETURN;
  END IF;
  IF md5(v_def) <> '2becc9f54f99a12641c1fa4aa888dfcf' THEN
    RAISE EXCEPTION 'fn_cash_cluster_balance is not the body this migration reviewed (md5 %); re-read it before applying', md5(v_def);
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_balance(p_game_id uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_census public.cash_cluster_census_row[];
  v_planned integer := 0;
  v_from uuid;
  v_to uuid;
  v_player uuid;
BEGIN
  v_census := public.fn_cash_cluster_census(p_game_id, p_now);

  -- THE POOL IS THE FEEDERS (2026-09-10). It used to be every live table
  -- except Main 1, so Main 2..N were in it - and step 2 of the tick holds
  -- every main FULL from the feeder. The balancer moved the newest arrival
  -- off a full main onto the feeder, step 2 moved the longest-seated feeder
  -- player straight back, and the same players went round every hand: 355
  -- exact round trips in one hour, two players moved 55 times each. Mains are
  -- step 2's, as source and as destination; this balances feeders among
  -- themselves and, with one feeder, does nothing.
  WITH pool AS (
    SELECT c.id,
           c.main_index,
           c.created_at,
           c.seated
             - (SELECT count(*) FROM public.cash_seat_moves m
                 WHERE m.from_table_id = c.id AND m.state = 'pending')
             + (SELECT count(*) FROM public.cash_seat_moves m
                 WHERE m.to_table_id = c.id AND m.state = 'pending') AS n,
           c.open_unreserved
             - (SELECT count(*) FROM public.cash_seat_moves m
                 WHERE m.to_table_id = c.id AND m.state = 'pending' AND m.swap_move_id IS NULL) AS room
      FROM unnest(v_census) c
     WHERE c.role = 'feeder'
       AND c.lifecycle = 'live'
       AND NOT c.breaking
  ),
  hi AS (
    SELECT * FROM pool ORDER BY n DESC, main_index DESC NULLS FIRST, created_at DESC LIMIT 1
  ),
  lo AS (
    SELECT * FROM pool WHERE room > 0
     ORDER BY n ASC, main_index ASC NULLS LAST, created_at ASC LIMIT 1
  ),
  pair AS (
    SELECT hi.id AS from_id, lo.id AS to_id
      FROM hi, lo
     WHERE hi.id <> lo.id
       AND hi.n - lo.n >= 2
       AND hi.n >= 3
       AND lo.n >= 1
  ),
  mover AS (
    SELECT p.from_id, p.to_id, ts.user_id
      FROM pair p
      JOIN public.table_seats ts ON ts.table_id = p.from_id AND ts.left_at IS NULL
     WHERE ts.user_id IS NOT NULL
       AND coalesce(ts.stack, 0) > 0
       AND coalesce(ts.leave_pending, false) = false
       AND NOT EXISTS (SELECT 1 FROM public.table_seats d
                        WHERE d.table_id = p.to_id AND d.user_id = ts.user_id AND d.left_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m
                        WHERE m.player_id = ts.user_id AND m.state = 'pending')
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m
                        WHERE m.player_id = ts.user_id AND m.state = 'cancelled'
                          AND m.created_at > p_now - interval '60 seconds')
     ORDER BY coalesce((SELECT r.joined_at FROM public.cash_game_roster r
                         WHERE r.game_id = p_game_id AND r.user_id = ts.user_id AND r.left_at IS NULL),
                       ts.joined_at) DESC,
              ts.joined_at DESC
     LIMIT 1
  ),
  ins AS (
    INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
    SELECT p_game_id, m.user_id, m.from_id, m.to_id, 'balance' FROM mover m
    RETURNING player_id, from_table_id, to_table_id
  )
  SELECT count(*)::integer,
         (array_agg(i.from_table_id))[1],
         (array_agg(i.to_table_id))[1],
         (array_agg(i.player_id))[1]
    INTO v_planned, v_from, v_to, v_player
    FROM ins i;

  IF coalesce(v_planned, 0) > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
    VALUES (p_game_id, v_to, 'move_planned',
            jsonb_build_object('player_id', v_player, 'from_table_id', v_from, 'reason', 'balance'));
  END IF;

  RETURN coalesce(v_planned, 0);
END;
$function$;

DO $assert$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.fn_cash_cluster_balance'::regproc);
  IF position('THE POOL IS THE FEEDERS' in v_def) = 0
     OR position($q$WHERE c.role = 'feeder'$q$ in v_def) = 0 THEN
    RAISE EXCEPTION 'the balancer did not take the feeder-only pool';
  END IF;
  IF position($q$NOT (c.role = 'main' AND c.main_index = 1)$q$ in v_def) > 0 THEN
    RAISE EXCEPTION 'the old everything-but-Main-1 pool survives';
  END IF;
  -- The back-off text 20260910181447 anchors on must be here, unchanged.
  IF position($q$AND m.created_at > p_now - interval '60 seconds')$q$ in v_def) = 0 THEN
    RAISE EXCEPTION 'the back-off predicate the next migration anchors on is missing';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_cash_cluster_balance(uuid, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the replace dropped the service_role grant';
  END IF;
END;
$assert$;

COMMIT;
