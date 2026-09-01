
-- SUPERSEDED SAME HOUR: the engine calls this via PostgREST as service_role,
-- whose statement_timeout is pinned to 8s, and this version timed out on
-- every tick. See 20260901181911_seat_first_healer_inside_eight_seconds.sql
-- for the version that runs in production.
-- ═══════════════════════════════════════════════════════════════════════════
-- SEAT-FIRST OPENERS CAN BE RESEATED (2026-09-01)
-- ───────────────────────────────────────────────────────────────────────────
-- A NEW HUSK CLASS, found on Deep Stack Society: 32 Spin queues created at
-- 12:55 UTC while every one of the club's 416 horses was still benched. Each
-- got its table (joinable, status 'waiting') but ZERO opening horses — and
-- nothing on the platform ever retries opener seating. A joinable husk COVERS
-- its price point in ensureBoardOpen, so the board never reopens the config,
-- and a seat-first game with no openers can never fill, so it never leaves
-- REGISTERING. One wedged row per price point, forever. The existing healer,
-- fn_repair_seat_first_games, only repaired the 2026-08-23 class (game with
-- NO table); this one had a healthy-looking table and sailed past it.
--
-- THE FIX, in the healer the engine already calls every 30 seconds:
--   Class A (unchanged): REGISTERING seat-first game with no table row at all
--     → create the table, seat openers, fresh human window.
--   Class B (new):       REGISTERING seat-first game whose joinable table is
--     short of opening horses (seated < seats-1)
--     → seat the shortfall, fresh human window.
--
-- CLUB SCOPE (Dan's law: a horse plays only in the club it belongs to). The
-- old pick was fleet-wide `is_horse = true`. For a club-owned game that pick
-- can select a horse from another club, whose registration the tournament
-- entry gate then REFUSES with an exception — aborting the entire repair
-- pass. The pick now:
--   - requires horse_status = 'available' (the bench latch is honored:
--     a benched horse is never seated by a repair);
--   - for a club-owned game, requires fn_ca_entry_scope_ok(horse, club),
--     the same membership test the entry gate itself applies, so a pick can
--     never select a horse the gate would refuse.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_repair_seat_first_games(p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
    SELECT t.id, t.name, t.club_id, t.game_type, t.max_players, t.blind_structure,
           jt.table_id AS joinable_table_id,
           COALESCE(jt.seated, 0) AS seated_now
      FROM public.tournaments t
      LEFT JOIN LATERAL (
        SELECT tb.id AS table_id,
               (SELECT count(*) FROM public.table_seats ts
                 WHERE ts.table_id = tb.id AND ts.left_at IS NULL) AS seated
          FROM public.tables tb
         WHERE tb.tournament_id = t.id
           AND COALESCE(tb.is_deleted, false) = false
           AND tb.status IN ('waiting', 'running', 'active')
         ORDER BY tb.created_at
         LIMIT 1
      ) jt ON true
     WHERE t.status = 'REGISTERING'
       AND (COALESCE(t.variant, '') = 'spin' OR COALESCE(t.max_players, 0) <= 2)
       AND (
         -- Class A: no table row at all (the 2026-08-23 husk).
         NOT EXISTS (SELECT 1 FROM public.tables tb2 WHERE tb2.tournament_id = t.id)
         -- Class B: joinable table short of its opening horses (this husk).
         OR (jt.table_id IS NOT NULL
             AND COALESCE(jt.seated, 0)
                 < GREATEST(COALESCE(NULLIF(t.max_players, 0), 3) - 1, 0))
       )
     ORDER BY t.created_at
     LIMIT GREATEST(p_limit, 0)
  LOOP
    v_seats := COALESCE(NULLIF(v_t.max_players, 0), 3);

    IF v_t.joinable_table_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.tables tb3 WHERE tb3.tournament_id = v_t.id) THEN
      -- Class A: give the husk the table it never got. Mirrors
      -- createOpenSeatTable exactly: status 'waiting' so the engine has
      -- nothing to deal yet, and tournament_id set so cash discovery
      -- (tournament_id IS NULL) can never pick it up.
      v_level := COALESCE((v_t.blind_structure::jsonb)->0, '{}'::jsonb);
      v_sb := COALESCE((v_level->>'smallBlind')::numeric, 10);
      v_bb := COALESCE((v_level->>'bigBlind')::numeric, 20);

      INSERT INTO public.tables (
        club_id, tournament_id, name, game_type, game_variant, stakes,
        small_blind, big_blind, min_buy_in, max_buy_in,
        max_players, current_players, status
      ) VALUES (
        v_t.club_id, v_t.id, v_t.name, 'tournament', lower(COALESCE(v_t.game_type, 'nlh')),
        v_sb::text || '/' || v_bb::text, v_sb, v_bb, 0, 0,
        v_seats, 0, 'waiting'
      )
      RETURNING id INTO v_table_id;

      v_opening := GREATEST(v_seats - 1, 0);
    ELSE
      -- Class B: the table exists and can be joined; only the openers are
      -- missing. Seat the SHORTFALL, never more: a human already seated
      -- counts toward the field and their seat is never taken.
      v_opening := GREATEST(GREATEST(v_seats - 1, 0) - v_t.seated_now, 0);
      IF v_opening = 0 THEN
        CONTINUE;
      END IF;
    END IF;

    v_seated := 0;

    -- Every seat but one: two horses on a Spin, one on a heads-up. The last
    -- seat belongs to a human.
    FOR v_horse IN
      SELECT p.id
        FROM public.profiles p
       WHERE p.is_horse = true
         -- The bench latch is honored: a benched horse is never repaired
         -- into a seat.
         AND p.horse_status = 'available'
         -- A horse plays only in the scope of the game's club: the exact
         -- membership test the tournament entry gate applies, so this pick
         -- can never select a horse the gate would refuse.
         AND (v_t.club_id IS NULL OR public.fn_ca_entry_scope_ok(p.id, v_t.club_id))
         AND NOT EXISTS (
           SELECT 1 FROM public.table_seats ts
             JOIN public.tables tb4 ON tb4.id = ts.table_id
            WHERE ts.user_id = p.id AND ts.left_at IS NULL
              AND tb4.status IN ('waiting', 'running'))
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
    -- last seat the instant it saw them -- turning a repaired table into a
    -- game that was never open. 60 to 180 seconds, randomised per game so the
    -- board does not tick over in lockstep. Only when the repair actually
    -- changed something: rewinding the clock on a game this pass did not
    -- touch would keep a full table from ever starting.
    IF v_seated > 0 OR v_t.joinable_table_id IS NULL THEN
      v_window := 60 + floor(random() * 121)::int;
      UPDATE public.tournaments
         SET start_time = now() + make_interval(secs => v_window)
       WHERE id = v_t.id;
      v_repaired := v_repaired + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'repaired', v_repaired,
    'horses_seated', v_horses_sat
  );
END;
$fn$;

-- The engine's service role is the only caller.
REVOKE ALL ON FUNCTION public.fn_repair_seat_first_games(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_repair_seat_first_games(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_repair_seat_first_games(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_repair_seat_first_games(integer) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- ASSERTIONS (abort the transaction if the fix is not what it claims)
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_def  text;
  v_husk int;
BEGIN
  v_def := pg_get_functiondef('public.fn_repair_seat_first_games(integer)'::regprocedure);

  IF v_def NOT LIKE '%fn_ca_entry_scope_ok%' THEN
    RAISE EXCEPTION 'repair fn is not club-scoped';
  END IF;
  IF v_def NOT LIKE '%horse_status = ''available''%' THEN
    RAISE EXCEPTION 'repair fn does not honor the bench latch';
  END IF;
  IF v_def NOT LIKE '%Class B%' THEN
    RAISE EXCEPTION 'repair fn is missing the short-of-openers husk class';
  END IF;

  -- The husk class this migration exists for must be visible to the new
  -- cursor: REGISTERING seat-first games with a joinable table short of
  -- openers. At write time Deep Stack Society held 32 of them.
  SELECT count(*) INTO v_husk
    FROM public.tournaments t
   WHERE t.status = 'REGISTERING'
     AND (COALESCE(t.variant, '') = 'spin' OR COALESCE(t.max_players, 0) <= 2)
     AND EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = t.id
          AND COALESCE(tb.is_deleted, false) = false
          AND tb.status IN ('waiting', 'running', 'active')
          AND (SELECT count(*) FROM public.table_seats ts
                WHERE ts.table_id = tb.id AND ts.left_at IS NULL)
              < GREATEST(COALESCE(NULLIF(t.max_players, 0), 3) - 1, 0));
  RAISE NOTICE 'short-of-openers husks visible to the healer right now: %', v_husk;
END $$;

COMMIT;
