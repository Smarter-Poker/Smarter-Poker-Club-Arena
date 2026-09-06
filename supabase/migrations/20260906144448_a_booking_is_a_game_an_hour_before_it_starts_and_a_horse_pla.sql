-- 20260906144448_a_booking_is_a_game_an_hour_before_it_starts_and_a_horse_pla.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Dan 2026-09-06, "PROCEED"):
--
-- Two of the four ceilings that were holding half the fleet off the cash floor
-- live in this database. Measured on production at 09:45 CDT on 2026-09-06:
--
--   1,000 horses. 510 at the four-game cap. 175 seated at cash, averaging
--   1.66 tables. 2,111 tournament bookings across 897 players, 1,377 of them
--   for events more than SIX HOURS away, 466 more than a DAY away, the
--   furthest 68 hours. 217 horses were capped by bookings ALONE. Sunday Funday
--   Main Event (11 hours out), the High Roller PKO (12 hours), Monday Rebuy
--   Rush (29 hours), the 6 AM freeroll three days from now.
--
-- 1. A BOOKING IS A GAME AN HOUR BEFORE IT STARTS, NOT WHEN IT IS MADE.
--
--    `fn_concurrent_game_load` clause (2) counted every registered/playing row
--    for an ANNOUNCED or REGISTERING tournament from the moment the row
--    existed. Registering for Tuesday cost a seat until Tuesday. The seat side
--    of the limit (`fn_enforce_four_table_limit`) and the booking side
--    (`fn_enforce_booking_game_cap`) both read this one function, and the
--    fleet mirrors it in `server/src/services/HorseGameLoad.ts`, so the rule
--    changes in one place and everything that asks it agrees.
--
--    The window is SIXTY MINUTES. A booking whose tournament starts inside the
--    next hour is a game: the player is about to be seated in it, and a fourth
--    cash seat taken now would be a fifth game in minutes. A booking further
--    out is a plan. A booking with NO start time is a seat-first game (a Spin,
--    a sit-and-go) that starts the moment it fills, so it always counts.
--
--    THE HARD INVARIANT IS UNCHANGED: never more than four LIVE SEATS. The
--    client shows four tabs and `fn_enforce_four_table_limit` still refuses the
--    fifth seat, tournament or cash, exactly as before. A player who takes a
--    fourth cash seat two hours before their tournament and is still in it at
--    the start is seated by `ensureLateRegSeated` the moment a chair frees, as
--    today. For horses the rotator now ends a cash session for an imminent
--    booking (`HorseSessionRotator`, same PR), which is what a person does.
--
--    This is not a horse rule (CLAUDE.md 10.5): the function counts a human's
--    bookings identically and its HINT says so.
--
-- 2. A HORSE PLAYS FOUR TABLES. Dan 2026-09-02, verbatim: "THEY SHOULD BE
--    PLAYING 4 TABLES AT ONCE." `MAX_TABLES_BY_PERSONA` in StableHand.ts gave
--    grinders 4, regulars and weekend players 3, mixers and night owls 2, so
--    837 of the 1,000 horses were tagged BELOW the number Dan asked for and the
--    sit verdict refused them a third or fourth chair (`sit_cap`). Nobody asked
--    for 2 or 3; the persona table invented it. The tagger now writes 4 for
--    every cash-mode tag and this migration brings the 1,107 live cash-mode
--    tags to the same value, so the fleet reads it on its next cycle without
--    waiting for a re-tag. Tourney-only tags stay at 1 (`sh_tourney_only_one_
--    table` CHECK).
--
-- The third and fourth ceilings (`AGGREGATE_EXPOSURE_MULTIPLE` and the
-- tourney-only lane share) are engine constants; see the changelog.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_concurrent_game_load(
  p_user_id uuid,
  p_exclude_seat_id uuid DEFAULT NULL::uuid,
  p_exclude_table_id uuid DEFAULT NULL::uuid,
  p_exclude_tournament_id uuid DEFAULT NULL::uuid
)
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT (
    -- (1) A LIVE SEAT IS A GAME. A seat at a closed table is history.
    (
      SELECT count(*)
        FROM public.table_seats ts
        JOIN public.tables t ON t.id = ts.table_id
       WHERE ts.user_id = p_user_id
         AND ts.left_at IS NULL
         AND t.status <> 'closed'
         AND (p_exclude_seat_id IS NULL OR ts.id IS DISTINCT FROM p_exclude_seat_id)
         AND (p_exclude_table_id IS NULL OR ts.table_id IS DISTINCT FROM p_exclude_table_id)
    )
    +
    -- (2) A BOOKING IS A GAME FROM ONE HOUR BEFORE ITS TOURNAMENT STARTS
    -- UNTIL THE TOURNAMENT STARTS (2026-09-06). RUNNING is absent
    -- deliberately: its entrants hold seats, counted by clause (1). A booking
    -- for an event further out than an hour is a plan, not a game - counting
    -- it from registration held 217 horses off the cash floor for events up
    -- to 68 hours away. A NULL start_time is a seat-first game that starts
    -- when it fills, so it always counts.
    (
      SELECT count(*)
        FROM public.tournament_players tp
        JOIN public.tournaments tr ON tr.id = tp.tournament_id
       WHERE tp.user_id = p_user_id
         AND tp.status IN ('registered', 'playing')
         AND tr.status IN ('ANNOUNCED', 'REGISTERING')
         AND (tr.start_time IS NULL OR tr.start_time <= now() + interval '60 minutes')
         AND (p_exclude_tournament_id IS NULL
              OR tp.tournament_id IS DISTINCT FROM p_exclude_tournament_id)
         -- NEVER BOTH. A seat-first game sells the chair before it starts, so
         -- a booking and a seat can describe the same game for a few minutes.
         AND NOT EXISTS (
           SELECT 1
             FROM public.table_seats ts2
             JOIN public.tables t2 ON t2.id = ts2.table_id
            WHERE ts2.user_id = p_user_id
              AND ts2.left_at IS NULL
              AND t2.status <> 'closed'
              AND t2.tournament_id = tp.tournament_id
         )
    )
  )::int;
$function$;

-- The grants are restated so the function says who may call it (the cash
-- definers convention): the two seat triggers and the engine, never a browser.
REVOKE ALL ON FUNCTION public.fn_concurrent_game_load(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_concurrent_game_load(uuid, uuid, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.fn_concurrent_game_load(uuid, uuid, uuid, uuid) IS
  'Games a player is committed to: live seats at open tables, plus bookings for tournaments that start within 60 minutes (or have no start time). Read by fn_enforce_four_table_limit, fn_enforce_booking_game_cap and the fleet (HorseGameLoad.ts). 2026-09-06: a booking counts from one hour before the start, not from registration.';

-- 2. Every cash-mode tag plays four tables.
UPDATE public.stable_hand_membership_tags
   SET max_tables = 4
 WHERE mode <> 'tourney'
   AND max_tables < 4;

DO $$
DECLARE
  v_below int;
  v_src   text;
BEGIN
  SELECT count(*) INTO v_below
    FROM public.stable_hand_membership_tags
   WHERE mode <> 'tourney' AND max_tables <> 4;
  IF v_below <> 0 THEN
    RAISE EXCEPTION 'VERIFY: % cash-mode tag(s) still below four tables', v_below;
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_concurrent_game_load'
     AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%interval ''60 minutes''%' THEN
    RAISE EXCEPTION 'VERIFY: fn_concurrent_game_load does not carry the sixty-minute window';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_concurrent_game_load(uuid,uuid,uuid,uuid)', 'execute') THEN
    RAISE EXCEPTION 'VERIFY: a browser role can execute fn_concurrent_game_load';
  END IF;
END $$;

COMMIT;
