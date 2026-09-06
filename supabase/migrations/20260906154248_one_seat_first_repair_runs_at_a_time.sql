-- ONE SEAT-FIRST REPAIR RUNS AT A TIME.
--
-- FOUND BY WATCHING THE FIX. 20260906152850 gave
-- fn_seat_horse_in_seat_first_game the player's Daily Missions lock before the
-- game row, which closed the seat-vs-hand inversion it was written for. Three
-- of the four deadlocks in the twelve minutes after it applied were then a
-- DIFFERENT cycle it had exposed, and one this function has had all along:
--
--   15:35:22  repair A holds player P's missions lock, wants game X's row
--             repair B holds game X's row, wants player P's missions lock
--   15:37:49  the same, on tournaments tuple (18598,8)
--   15:38:50  the same, on tuple (18648,11)
--
-- fn_repair_seat_first_games loops over up to 25 games and seats several
-- horses in each, and PostgREST runs the whole function in one transaction -
-- so the locks from game 1 are still held while game 12 is being seated. Two
-- concurrent passes visit games and horses in different orders, and any two
-- orders that differ can cycle. Before 20260906152850 the same function was
-- deadlocking on the same shape against atomic_deduct_wallet_and_log and the
-- old global reporting lock; the lock it cycles on changed, the loop did not.
--
-- ORDERING THE LOOP WOULD NOT FIX IT. The pass takes locks on two different
-- axes - the game row and the per-player advisory lock - and the horse pool is
-- rebuilt per club from live registrations, so two passes seconds apart do not
-- see the same pool in the same order. Any total order over one axis still
-- leaves the other free to cycle.
--
-- SO THE SECOND PASS DOES NOT RUN. A repair sweep is idempotent by
-- construction and its own header says "on a healthy board it does nothing";
-- two of them at once is not throughput, it is two transactions doing the same
-- work and fighting for the same rows. The second caller takes
-- pg_try_advisory_xact_lock and, when it cannot have it, returns
-- skipped immediately - no wait, because a pass that waits is a pass that can
-- deadlock on the wait. TournamentRecurringService calls this on a tick and
-- reads only `repaired` / `horses_seated`, so a skipped pass is invisible to it
-- and the next tick does the work.
--
-- Everything else in the function - the 5-second budget, the per-club
-- round-robin, the fresh 90-350s human window - is unchanged.

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
  /* ONE REPAIR AT A TIME (20260906154248).
     This function loops over up to p_limit games and seats several horses in
     each, all inside ONE transaction, so every per-player advisory lock and
     every tournaments row lock it takes is held until the whole pass commits.
     Two passes running at once iterate different games in different orders and
     cycle: measured on production, three deadlocks in the four minutes after
     20260906152850 landed, and the same pair (this function against
     fn_seat_horse_in_seat_first_game, and against atomic_deduct_wallet_and_log)
     five times a day before it.
     A repair sweep has no reason to run twice at once - it is idempotent and
     "on a healthy board it does nothing" - so the second caller returns
     immediately instead of fighting the first. try_, not the blocking form: a
     pass that waits is a pass that can deadlock on the wait. */
  IF NOT pg_try_advisory_xact_lock(hashtextextended('ca:seat-first-repair', 0)) THEN
    RETURN jsonb_build_object(
      'repaired', 0, 'horses_seated', 0, 'out_of_time', false,
      'skipped', 'another seat-first repair is already running',
      'elapsed_ms', 0);
  END IF;

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
      v_opening := GREATEST(GREATEST(v_seats - 1, 0) - v_t.seated_now, 0);
      IF v_opening = 0 THEN
        CONTINUE;
      END IF;
    END IF;

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

DO $verify$
DECLARE v_src text; v_guard int; v_loop int; v_skip int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_repair_seat_first_games' AND pronamespace = 'public'::regnamespace;

  v_guard := position('pg_try_advisory_xact_lock' in v_src);
  v_loop  := position('FOR v_t IN' in v_src);
  v_skip  := position('another seat-first repair is already running' in v_src);

  IF v_guard = 0 OR v_guard > v_loop THEN
    RAISE EXCEPTION 'VERIFY FAILED: the singleton guard is not the first thing the pass does (guard %, loop %)', v_guard, v_loop;
  END IF;
  IF v_skip = 0 OR v_skip > v_loop THEN
    RAISE EXCEPTION 'VERIFY FAILED: the declining pass does not return before the loop';
  END IF;
  /* The blocking form would queue, and a pass that waits is a pass that can
     deadlock on the wait - which is the whole defect. */
  IF v_src ~ 'PERFORM\s+pg_advisory_xact_lock\(hashtextextended\(''ca:seat-first-repair' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the guard blocks instead of skipping';
  END IF;
  /* A skip must report no work, or the caller logs a repair that never ran. */
  IF v_src !~ '''repaired'', 0, ''horses_seated'', 0' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the skip branch does not report zero work';
  END IF;

  /* WHAT THIS BLOCK CANNOT PROVE, said out loud rather than faked. The first
     draft of this migration called the function here while holding the lock
     and required a skip. It did not skip, and the migration aborted - because
     a POSTGRES ADVISORY LOCK IS RE-ENTRANT WITHIN ITS OWN SESSION:
     pg_try_advisory_xact_lock returns true to the holder. So a single
     transaction can never observe its own guard declining, and a probe that
     appeared to would be testing nothing. The guard is a between-sessions
     rule and is verified between sessions - by the deadlock rate for this
     pair, which is the measurement the changelog carries. */
  RAISE NOTICE 'SEAT_FIRST_REPAIR_SINGLETON guard is first, non-blocking, and returns zero work; cross-session skip is not observable in one transaction';
END $verify$;

COMMIT;
