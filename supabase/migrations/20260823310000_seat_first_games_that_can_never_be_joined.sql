-- ═══════════════════════════════════════════════════════════════════════════
--  44 OF THE 50 SPINS AND HEADS-UPS ON THE BOARD COULD NEVER BE JOINED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-08-23: "make sure the horses are sitting and playing the spins.
-- two horses should fill the first two seats... wait 60-180 seconds before a
-- 3rd horse sits."
--
-- That design is already written, correctly, in TournamentRecurringService.
-- What was actually on the board: of 33 REGISTERING Spins, THIRTY had no
-- table row, and of 17 heads-ups, FOURTEEN. Oldest husk 05:24 UTC -- fifteen
-- hours listed, unjoinable, seats that do not exist.
--
-- WHY THAT STATE IS PERMANENT, which is the part that matters. The board
-- keeper decides what to open by NAME:
--
--     open    = names of REGISTERING instances
--     missing = configs whose name is not in `open`
--
-- A husk is REGISTERING. So its name is "covered", so its price point is
-- never reopened -- and it can never leave REGISTERING, because a seat-first
-- game starts when every SEAT is sold and it has no seats. One dead row wedges
-- one price point forever. Exactly two of thirty-two Spin configs still
-- cycled: 1 Chip NLH and 3 Chip NLH, the only two whose live instance could
-- still fill and free its name.
--
-- SECOND DEFECT, visible on the two that do work. fn_seat_horse_in_seat_first_game
-- seats a horse, writes tournament_players, and updates tables.current_players
-- -- but never tournaments.current_players, which is the number the lobby card
-- reads. So a Spin with two horses genuinely sitting in seats 1 and 2 was
-- advertised to every player as 0/3. The horses WERE sitting; the board lied.
--
-- APPLIED TO PRODUCTION 2026-08-23 via the Supabase MCP; the repair healed all
-- 44 husks on its first run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The seat count the lobby reads comes from the seats themselves ──────
CREATE OR REPLACE FUNCTION public.fn_seat_horse_in_seat_first_game(p_tournament_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_t       record;
  v_table   record;
  v_seat    int;
  v_reg     jsonb;
  v_taken   int;
  v_already boolean;
BEGIN
  SELECT id, status, variant, max_players, name
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF NOT (COALESCE(v_t.variant,'') = 'spin' OR COALESCE(v_t.max_players,0) <= 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_seat_first_game');
  END IF;

  SELECT id, max_players INTO v_table
    FROM public.tables WHERE tournament_id = p_tournament_id
    ORDER BY created_at LIMIT 1;
  IF v_table.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_table');
  END IF;

  IF EXISTS (SELECT 1 FROM public.table_seats
              WHERE table_id = v_table.id AND user_id = p_user_id AND left_at IS NULL) THEN
    RETURN jsonb_build_object('ok', true, 'already_seated', true);
  END IF;

  SELECT s INTO v_seat
    FROM generate_series(1, COALESCE(NULLIF(v_table.max_players,0), v_t.max_players, 3)) s
   WHERE NOT EXISTS (
     SELECT 1 FROM public.table_seats ts
      WHERE ts.table_id = v_table.id AND ts.seat_number = s AND ts.left_at IS NULL
   )
   ORDER BY s LIMIT 1;

  IF v_seat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_full');
  END IF;

  -- Register ONLY if not already on the list. Asking the registration RPC about
  -- someone it has already accepted gets 'tournament_full', because its
  -- capacity check runs before its duplicate check.
  SELECT EXISTS (SELECT 1 FROM public.tournament_players
                  WHERE tournament_id = p_tournament_id AND user_id = p_user_id)
    INTO v_already;

  IF NOT v_already THEN
    v_reg := public.fn_register_horse_for_tournament(p_tournament_id, p_user_id);
    IF COALESCE((v_reg->>'ok')::boolean, false) IS NOT TRUE
       AND COALESCE(v_reg->>'reason','') <> 'already_registered' THEN
      RETURN jsonb_build_object('ok', false, 'reason', COALESCE(v_reg->>'reason','register_failed'));
    END IF;
  END IF;

  UPDATE public.tournament_players
     SET status = 'playing', table_id = v_table.id, seat_number = v_seat
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id;

  BEGIN
    INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
    VALUES (v_table.id, p_user_id, v_seat, 0);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
  END;

  SELECT count(*) INTO v_taken FROM public.table_seats
   WHERE table_id = v_table.id AND left_at IS NULL;
  UPDATE public.tables SET current_players = v_taken WHERE id = v_table.id;

  -- THE NUMBER THE LOBBY CARD SHOWS. Without this a Spin with two horses in
  -- seats 1 and 2 advertised itself as 0/3 -- the horses were sitting and the
  -- board said the table was empty. Counted from tournament_players rather
  -- than from v_taken because a human who has bought in but not yet been
  -- placed is still an entrant.
  UPDATE public.tournaments t
     SET current_players = (
           SELECT count(*) FROM public.tournament_players tp
            WHERE tp.tournament_id = p_tournament_id
              AND tp.status IN ('registered', 'playing'))
   WHERE t.id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'table_id', v_table.id, 'seat_number', v_seat,
    'seats_taken', v_taken, 'reused_registration', v_already,
    'seats', COALESCE(NULLIF(v_table.max_players,0), v_t.max_players, 3));
END;
$function$;

-- ── 2. Give a husk the table it never got, and open it properly ────────────
CREATE OR REPLACE FUNCTION public.fn_repair_seat_first_games(p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_t          record;
  v_table_id   uuid;
  v_level      jsonb;
  v_sb         numeric;
  v_bb         numeric;
  v_seats      int;
  v_opening    int;
  v_horse      uuid;
  v_res        jsonb;
  v_seated     int;
  v_repaired   int := 0;
  v_horses_sat int := 0;
  v_window     int;
BEGIN
  FOR v_t IN
    SELECT t.id, t.name, t.club_id, t.game_type, t.max_players, t.blind_structure
      FROM public.tournaments t
     WHERE t.status = 'REGISTERING'
       AND (COALESCE(t.variant,'') = 'spin' OR COALESCE(t.max_players,0) <= 2)
       AND NOT EXISTS (SELECT 1 FROM public.tables tb WHERE tb.tournament_id = t.id)
     ORDER BY t.created_at
     LIMIT GREATEST(p_limit, 0)
  LOOP
    v_seats := COALESCE(NULLIF(v_t.max_players, 0), 3);
    v_level := COALESCE((v_t.blind_structure::jsonb)->0, '{}'::jsonb);
    v_sb := COALESCE((v_level->>'smallBlind')::numeric, 10);
    v_bb := COALESCE((v_level->>'bigBlind')::numeric, 20);

    -- Mirrors createOpenSeatTable exactly: status 'waiting' so the engine has
    -- nothing to deal yet, and tournament_id set so cash discovery
    -- (tournament_id IS NULL) can never pick it up.
    INSERT INTO public.tables (
      club_id, tournament_id, name, game_type, game_variant, stakes,
      small_blind, big_blind, min_buy_in, max_buy_in,
      max_players, current_players, status
    ) VALUES (
      v_t.club_id, v_t.id, v_t.name, 'tournament', lower(COALESCE(v_t.game_type,'nlh')),
      v_sb::text || '/' || v_bb::text, v_sb, v_bb, 0, 0,
      v_seats, 0, 'waiting'
    )
    RETURNING id INTO v_table_id;

    -- Every seat but one: two horses on a Spin, one on a heads-up. The last
    -- seat belongs to a human.
    v_opening := GREATEST(v_seats - 1, 0);
    v_seated := 0;

    FOR v_horse IN
      SELECT p.id
        FROM public.profiles p
       WHERE p.is_horse = true
         AND NOT EXISTS (
           SELECT 1 FROM public.table_seats ts
             JOIN public.tables tb2 ON tb2.id = ts.table_id
            WHERE ts.user_id = p.id AND ts.left_at IS NULL
              AND tb2.status IN ('waiting', 'running'))
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_players tp
             JOIN public.tournaments t2 ON t2.id = tp.tournament_id
            WHERE tp.user_id = p.id
              AND tp.status IN ('registered', 'playing')
              AND t2.status IN ('ANNOUNCED', 'REGISTERING', 'RUNNING'))
       ORDER BY random()
       LIMIT v_opening
    LOOP
      v_res := public.fn_seat_horse_in_seat_first_game(v_t.id, v_horse);
      IF COALESCE((v_res->>'ok')::boolean, false) THEN
        v_seated := v_seated + 1;
        v_horses_sat := v_horses_sat + 1;
      END IF;
    END LOOP;

    -- A FRESH HUMAN WINDOW, not the one that expired hours ago. These rows
    -- have start_time in the past, and the past-start top-up would fill the
    -- third seat the instant it saw them -- turning a repaired table into a
    -- game that was never open. 60 to 180 seconds, randomised per game so the
    -- board does not tick over in lockstep.
    v_window := 60 + floor(random() * 121)::int;
    UPDATE public.tournaments
       SET start_time = now() + make_interval(secs => v_window)
     WHERE id = v_t.id;

    v_repaired := v_repaired + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'repaired', v_repaired,
    'horses_seated', v_horses_sat
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_repair_seat_first_games(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_repair_seat_first_games(integer) TO service_role;

DO $check$
DECLARE def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO def FROM pg_proc WHERE proname = 'fn_seat_horse_in_seat_first_game';
  IF def NOT LIKE '%UPDATE public.tournaments t%' THEN
    RAISE EXCEPTION 'fn_seat_horse_in_seat_first_game no longer maintains tournaments.current_players - the lobby will read 0/3 with horses in the seats';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_repair_seat_first_games') THEN
    RAISE EXCEPTION 'fn_repair_seat_first_games is missing';
  END IF;
END $check$;
