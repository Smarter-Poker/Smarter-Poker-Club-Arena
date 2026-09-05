-- ═══════════════════════════════════════════════════════════════════════════
--  THE THIRD SEAT WAITS 90 TO 350 SECONDS FOR A HUMAN (Dan, 2026-09-05)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, verbatim: "fleet should hold the seat for 90-350 seconds max before
-- filling the 3rd seat."
--
-- Widened from 60-150 (Dan 2026-09-03, migration 20260903171736). The reason
-- is a measurement taken today, and it is the whole argument:
--
--   In the seven days to 2026-09-05 this platform ran 31,153 Spins.
--   FOUR of them had a human in them.
--
-- 4,450 games a day, the fleet playing against itself. A minute-to-two-and-a
-- -half-minute door was too narrow, and a separate defect fixed the same day
-- (the `playHasBegun` stack latch in TablePage, which hid the SIT button on
-- any board a horse had already sat at) meant the door was not merely narrow
-- but painted on. Both halves are being fixed together: the button comes back,
-- and the seat stays open long enough to be found.
--
-- 90 at the floor because a human who opens the lobby, reads the stakes and
-- taps a seat needs longer than a minute. 350 at the ceiling because a board
-- sitting open past six minutes stops reading as a room that is about to deal.
-- Randomised per game, unchanged and deliberate: a constant delay makes every
-- table on the lobby tick over in lockstep and the room reads as a machine.
--
-- ── THIS NUMBER LIVES IN THREE PLACES AND THEY MOVE TOGETHER ────────────────
--
--   server/src/services/TournamentRecurringService.ts
--       SEAT_FIRST_HUMAN_WINDOW_MIN_MS / _MAX_MS      90_000 / 350_000
--   server/src/services/liveTournamentTableRecovery.ts
--       FRESH_HUMAN_WINDOW_MIN_S / _MAX_S             90 / 350
--   public.fn_repair_seat_first_games                 this file
--
-- `theClubProgrammeMirrorsTheHouse.test.ts` asserts all three agree and reads
-- THIS migration's text for the SQL third. Changing one alone turns it red,
-- which is the point: the engine seating a horse at 90s while the repair sweep
-- hands the same board a 60s window is a race nobody would find by reading.
--
-- Only the window changes. Everything else in this function - the owner-fair
-- ordering, the 5s budget, the membership-scoped pool, the Class A/B repair
-- split - is carried over from 20260903171736 unaltered.
--
-- ROLLBACK: re-apply 20260903171736 and restore 60 / 150 in the two TS files.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_repair_seat_first_games(p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_budget     interval := interval '5 seconds';
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
  v_club_union uuid;
  v_is_union   boolean;
  v_pool_owner uuid := NULL;
  v_pool_set   boolean := false;
  v_pool       uuid[] := '{}';
  v_pool_i     int := 1;
  v_out_of_time boolean := false;
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
         NOT EXISTS (SELECT 1 FROM public.tables tb2 WHERE tb2.tournament_id = t.id)
         OR (jt.table_id IS NOT NULL
             AND COALESCE(jt.seated, 0)
                 < GREATEST(COALESCE(NULLIF(t.max_players, 0), 3) - 1, 0))
       )
     -- OWNER-FAIR: the first husk of every owner before the second of any.
     ORDER BY row_number() OVER (PARTITION BY t.club_id ORDER BY t.created_at),
              t.club_id, t.created_at
     LIMIT GREATEST(p_limit, 0)
  LOOP
    IF clock_timestamp() - v_started > v_budget THEN
      v_out_of_time := true;
      EXIT;
    END IF;

    v_seats := COALESCE(NULLIF(v_t.max_players, 0), 3);

    IF v_t.joinable_table_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.tables tb3 WHERE tb3.tournament_id = v_t.id) THEN
      -- Class A: no table at all. Mirrors createOpenSeatTable exactly.
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
      -- Class B: joinable table short of openers. Seat the SHORTFALL only.
      v_opening := GREATEST(GREATEST(v_seats - 1, 0) - v_t.seated_now, 0);
      IF v_opening = 0 THEN
        CONTINUE;
      END IF;
    END IF;

    -- The eligible pool for this owner, computed once per owner per call.
    -- Same membership rule the entry gate enforces (CLAUDE.md 10.5: horses
    -- are members, the boundary is membership).
    IF NOT v_pool_set OR v_pool_owner IS DISTINCT FROM v_t.club_id THEN
      v_is_union := false;
      v_club_union := NULL;
      IF v_t.club_id IS NOT NULL THEN
        SELECT EXISTS (SELECT 1 FROM public.unions u WHERE u.id = v_t.club_id) INTO v_is_union;
        IF NOT v_is_union THEN
          SELECT c.union_id INTO v_club_union FROM public.clubs c WHERE c.id = v_t.club_id;
        END IF;
      END IF;

      SELECT COALESCE(array_agg(p.id ORDER BY random()), '{}')
        INTO v_pool
        FROM public.profiles p
       WHERE p.is_horse = true
         AND p.horse_status = 'available'
         AND (v_t.club_id IS NULL OR EXISTS (
           SELECT 1
             FROM public.club_members cm
             JOIN public.clubs c2 ON c2.id = cm.club_id
            WHERE cm.user_id = p.id
              AND (
                cm.club_id = v_t.club_id
                OR (v_is_union AND (
                     c2.union_id = v_t.club_id
                     OR EXISTS (SELECT 1 FROM public.union_clubs uc
                                 WHERE uc.club_id = c2.id AND uc.union_id = v_t.club_id)))
                OR (v_club_union IS NOT NULL AND (
                     c2.union_id = v_club_union
                     OR EXISTS (SELECT 1 FROM public.union_clubs uc2
                                 WHERE uc2.club_id = c2.id AND uc2.union_id = v_club_union)))
              )))
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
              AND t2.status IN ('ANNOUNCED', 'REGISTERING', 'RUNNING'));
      v_pool_owner := v_t.club_id;
      v_pool_set := true;
      v_pool_i := 1;
    END IF;

    v_seated := 0;
    WHILE v_seated < v_opening AND v_pool_i <= COALESCE(array_length(v_pool, 1), 0) LOOP
      IF clock_timestamp() - v_started > v_budget THEN
        v_out_of_time := true;
        EXIT;
      END IF;
      v_horse := v_pool[v_pool_i];
      v_pool_i := v_pool_i + 1;
      v_res := public.fn_seat_horse_in_seat_first_game(v_t.id, v_horse);
      IF COALESCE((v_res->>'ok')::boolean, false) THEN
        v_seated := v_seated + 1;
        v_horses_sat := v_horses_sat + 1;
      END IF;
    END LOOP;

    -- A FRESH HUMAN WINDOW: 90-350 seconds (Dan 2026-09-05: "fleet should
    -- hold the seat for 90-350 seconds max before filling the 3rd seat"),
    -- randomised per game and identical to seatFirstHumanWindowMs in the
    -- engine and freshHumanWindowMs in the recovery planner. Was 60-150
    -- (Dan 2026-09-03), and 45-90 before that. Only when the repair changed
    -- something.
    IF v_seated > 0 OR v_t.joinable_table_id IS NULL THEN
      v_window := 90 + floor(random() * 261)::int;
      UPDATE public.tournaments
         SET start_time = now() + make_interval(secs => v_window)
       WHERE id = v_t.id;
      v_repaired := v_repaired + 1;
    END IF;

    IF v_out_of_time THEN EXIT; END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'repaired', v_repaired,
    'horses_seated', v_horses_sat,
    'out_of_time', v_out_of_time,
    'elapsed_ms', floor(extract(epoch from clock_timestamp() - v_started) * 1000)::int
  );
END;
$function$;

-- ── THE DOOR STAYS SHUT (restored 2026-09-05) ──────────────────────────────
-- 20260903171736 carried this pair and this file dropped it, and
-- scripts/ci/check-definer-authorization.mjs refused the push - correctly.
--
-- `CREATE OR REPLACE` preserves existing grants, so the live database was
-- never actually exposed (verified: anon and authenticated cannot execute it,
-- only service_role). But the checker reads the MIGRATION, not the database,
-- and it is right to: a migration replayed onto a fresh database creates the
-- function with Postgres's default PUBLIC EXECUTE, and this one is SECURITY
-- DEFINER, it writes, and it never asks auth.uid() who is calling. A browser
-- role reaching it could seat the fleet and rewrite start times at will.
--
-- So the grant is restated rather than inherited. A migration that only works
-- because of what a previous migration happened to leave behind is a migration
-- that stops working the first time somebody rebuilds from scratch.
REVOKE ALL ON FUNCTION public.fn_repair_seat_first_games(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_repair_seat_first_games(integer) TO service_role;

COMMIT;
