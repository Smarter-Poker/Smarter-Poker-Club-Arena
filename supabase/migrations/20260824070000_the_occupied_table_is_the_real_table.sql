-- ============================================================================
-- THE OCCUPIED TABLE IS THE REAL TABLE (2026-08-24)
-- TIER: 2  |  AFFECTS: fn_tournament_primary_table (new),
--   fn_sync_seat_first_player_count, fn_seat_horse_in_seat_first_game,
--   fn_reconcile_tournament_denormals, fn_sweep_seatless_late_registrants (new)
--
-- Dan registered for a tournament during late registration. He was charged,
-- landed on the tournament page, and then: no seat, no chips, and the
-- tournament never started. All three symptoms are one defect.
--
-- WHAT WAS MEASURED IN PRODUCTION (2026-08-24 ~06:55 UTC)
--
--   126 live tournaments; 39 carried a tournaments.current_players BELOW
--   their real field. All 39 were under-counted and all 39 were startable.
--   One had been past its start time for 471 minutes.
--
--   Of 31 past-start REGISTERING games, 28 were blocked by that counter, and
--   in 12 a table holding ZERO seats had won the tiebreak over a sibling
--   table holding every player in the game.
--
--   Grouped by hour, the count of games with more than one live table equals
--   the count of stuck games, hour after hour: 2/2, 2/2, 9/9, 1/1, 1/1, 0/0.
--   A duplicate live table is not correlated with the stall, it IS the stall.
--
-- THE DEFECT
--
--   A seat-first game's field size is derived from one chosen table. That
--   choice has been made two different ways and both pick a corpse:
--
--     20260823330000  ORDER BY created_at        -- oldest, closed ones too
--     20260824050000  ORDER BY created_at DESC   -- newest non-closed
--
--   These games are created with two `waiting` tables about 0.6s apart. The
--   players sit on the FIRST. The empty one is NEWER. So the newest-table
--   rule counts an empty table and the loop closes:
--
--     fn_sync_seat_first_player_count -> current_players = 0
--     engine start gate               -> 0 of 3 seats sold, do not start
--     topUpWithHorses                 -> field already full, nothing to add,
--                                        returns BEFORE it can fix the count
--
--   Nothing breaks the loop, because no reconciler maintained
--   current_players. The game can never start; nobody in it can ever be
--   seated or given chips; and a player registering into that window pays a
--   buy-in for a game that will not begin.
--
--   fn_seat_late_registrant already ordered by occupancy, then oldest. It is
--   the one place that got this right. This migration makes the others agree
--   with it instead of inventing a third rule.
--
-- WHAT THIS CHANGES
--
--   1. fn_tournament_primary_table - ONE definition of "the table this game
--      is actually on": most live seats first, oldest breaks the tie. A
--      duplicate table becomes harmless rather than fatal.
--   2. fn_sync_seat_first_player_count - counts that table.
--   3. fn_seat_horse_in_seat_first_game - seats on that table, so a horse and
--      the counter can never disagree about which table is the game.
--   4. fn_reconcile_tournament_denormals - additionally repairs
--      current_players every minute (seats for seat-first, roster for MTT)
--      and closes an EMPTY duplicate table when a sibling holds the players.
--      This is what heals the games already stuck.
--   5. fn_sweep_seatless_late_registrants - the net that two client comments
--      already promise ("the engine's 5s sweep seats him") and which was
--      never built: fn_seat_late_registrant had NO caller anywhere in the
--      codebase outside fn_register_for_tournament itself.
--
-- DELIBERATELY NOT CHANGED
--
--   fn_register_for_tournament reads current_players for its `tournament_full`
--   gate. That read becomes correct once the counter is maintained, so the
--   wallet-debiting path is left untouched rather than transcribed wholesale
--   for a one-line effect.
--
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.fn_sweep_seatless_late_registrants();
--   DROP FUNCTION IF EXISTS public.fn_tournament_primary_table(uuid);
--   then re-apply 20260824020200_reconcile_tournament_denormals.sql and
--   20260824050000_horse_seating_uses_the_live_table.sql, and restore
--   fn_sync_seat_first_player_count to ORDER BY created_at DESC.
--   (Not recommended: that is the state that produced the 39.)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. One definition of the table a game is actually on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_tournament_primary_table(p_tournament_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  /* Occupancy first: a table with players on it IS the game, however old it
     is. created_at ASC breaks the tie, so the ORIGINAL table wins over a
     duplicate created moments later and the answer is stable between calls.
     This is the ordering fn_seat_late_registrant already used. */
  SELECT tb.id
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
     AND lower(COALESCE(tb.status, '')) <> 'closed'
   ORDER BY (
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id = tb.id AND s.left_at IS NULL
     ) DESC,
     tb.created_at ASC
   LIMIT 1;
$function$;

-- ---------------------------------------------------------------------------
-- 2. The seat-first player count follows the occupied table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_sync_seat_first_player_count(p_tournament_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_table uuid;
  v_seats integer := 0;
BEGIN
  v_table := public.fn_tournament_primary_table(p_tournament_id);

  IF v_table IS NULL THEN
    RETURN NULL;  -- no live table: there is no seat truth, leave the counter
  END IF;

  SELECT count(*) INTO v_seats
    FROM public.table_seats
   WHERE table_id = v_table AND left_at IS NULL;

  UPDATE public.tables      SET current_players = v_seats WHERE id = v_table;
  UPDATE public.tournaments SET current_players = v_seats WHERE id = p_tournament_id;

  RETURN v_seats;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Horses sit at the same table the counter is reading.
--    20260824050000 moved this from oldest-ever to newest-non-closed to match
--    the counter. Both lose to a duplicate. Share the definition instead.
-- ---------------------------------------------------------------------------
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

  -- THE TABLE THE GAME IS ON. Same definition as the counter and the sweep.
  SELECT id, max_players INTO v_table
    FROM public.tables
   WHERE id = public.fn_tournament_primary_table(p_tournament_id);
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

  v_taken := COALESCE(public.fn_sync_seat_first_player_count(p_tournament_id), 0);

  RETURN jsonb_build_object('ok', true, 'table_id', v_table.id, 'seat_number', v_seat,
    'seats_taken', v_taken, 'reused_registration', v_already,
    'seats', COALESCE(NULLIF(v_table.max_players,0), v_t.max_players, 3));
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. The every-minute reconciler now also repairs the counter that gates
--    every tournament start, and clears empty duplicate tables.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_reconcile_tournament_denormals()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_roster int := 0;
  v_stakes int := 0;
  v_dupes  int := 0;
  v_counts int := 0;
BEGIN
  -- (unchanged) roster rows follow the live seat
  WITH live_seat AS (
    SELECT s.user_id, tb.tournament_id, s.table_id, s.seat_number,
           ROW_NUMBER() OVER (
             PARTITION BY tb.tournament_id, s.user_id ORDER BY s.joined_at DESC NULLS LAST
           ) AS rn
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id = s.table_id
     WHERE s.left_at IS NULL AND tb.tournament_id IS NOT NULL
  ), upd AS (
    UPDATE public.tournament_players tp
       SET table_id = ls.table_id, seat_number = ls.seat_number
      FROM live_seat ls
     WHERE ls.rn = 1
       AND tp.tournament_id = ls.tournament_id
       AND tp.user_id = ls.user_id
       AND tp.status IN ('registered', 'playing')
       AND (tp.table_id IS DISTINCT FROM ls.table_id
         OR tp.seat_number IS DISTINCT FROM ls.seat_number)
    RETURNING 1
  ) SELECT count(*) INTO v_roster FROM upd;

  -- (unchanged) table stakes follow the blinds
  WITH upd2 AS (
    UPDATE public.tables tb
       SET stakes = trim_scale(tb.small_blind)::text || '/' || trim_scale(tb.big_blind)::text
      FROM public.tournaments t
     WHERE t.id = tb.tournament_id
       AND t.status IN ('RUNNING', 'REGISTERING', 'ANNOUNCED')
       AND tb.small_blind IS NOT NULL
       AND tb.big_blind IS NOT NULL
       AND tb.stakes IS DISTINCT FROM
           (trim_scale(tb.small_blind)::text || '/' || trim_scale(tb.big_blind)::text)
    RETURNING 1
  ) SELECT count(*) INTO v_stakes FROM upd2;

  /* NEW: close an EMPTY duplicate table when a sibling holds the players.
     Restricted to seat-first games, which have exactly one table by
     definition. An empty table in an MTT is legitimate - it is where the next
     late entrant sits - so MTTs are deliberately left alone. */
  WITH seat_first AS (
    SELECT t.id
      FROM public.tournaments t
     WHERE t.status IN ('REGISTERING', 'ANNOUNCED', 'RUNNING')
       AND (lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
            OR COALESCE(t.max_players, 0) <= 2)
  ), ranked AS (
    SELECT tb.id,
           (SELECT count(*) FROM public.table_seats s
             WHERE s.table_id = tb.id AND s.left_at IS NULL) AS seats,
           public.fn_tournament_primary_table(tb.tournament_id) AS keep_id
      FROM public.tables tb
      JOIN seat_first sf ON sf.id = tb.tournament_id
     WHERE lower(COALESCE(tb.status, '')) <> 'closed'
  ), upd3 AS (
    UPDATE public.tables tb
       SET status = 'closed', current_players = 0
      FROM ranked r
     WHERE tb.id = r.id
       AND r.seats = 0          -- never close a table with a player on it
       AND r.keep_id IS NOT NULL
       AND r.keep_id <> r.id    -- never close the one we are keeping
    RETURNING 1
  ) SELECT count(*) INTO v_dupes FROM upd3;

  /* NEW: tournaments.current_players - the number the engine's start gate
     reads. Nothing maintained it. fn_register_for_tournament increments it
     for humans; the horse top-up returns early once the field is full; no
     reconciler covered it. 39 live tournaments sat below their real field,
     every one of them startable, one for nearly eight hours.

     Seat-first counts SEATS (Dan 2026-08-23: a spin starts when seats are
     bought, and writing the registration count back here is exactly what
     produced the 3/3-with-two-sold drift). MTTs count the ROSTER, where a
     registration IS the entry. */
  WITH truth AS (
    SELECT t.id,
           (lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
            OR COALESCE(t.max_players, 0) <= 2) AS is_seat_first,
           public.fn_tournament_primary_table(t.id) AS primary_table,
           CASE
             WHEN lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
                  OR COALESCE(t.max_players, 0) <= 2
             THEN (
               SELECT count(*) FROM public.table_seats s
                WHERE s.table_id = public.fn_tournament_primary_table(t.id)
                  AND s.left_at IS NULL
             )
             ELSE (
               SELECT count(*) FROM public.tournament_players tp
                WHERE tp.tournament_id = t.id
                  AND tp.status IN ('registered', 'playing')
             )
           END AS real_count
      FROM public.tournaments t
     WHERE t.status IN ('REGISTERING', 'ANNOUNCED', 'RUNNING')
  ), upd4 AS (
    UPDATE public.tournaments t
       SET current_players = truth.real_count
      FROM truth
     WHERE t.id = truth.id
       /* A seat-first game with no live table at all keeps its counter:
          there is no seat truth to read and zeroing it would be a guess. */
       AND NOT (truth.is_seat_first AND truth.primary_table IS NULL)
       AND COALESCE(t.current_players, -1) IS DISTINCT FROM truth.real_count
    RETURNING 1
  ) SELECT count(*) INTO v_counts FROM upd4;

  RETURN jsonb_build_object(
    'roster_rows_fixed',   v_roster,
    'stakes_rows_fixed',   v_stakes,
    'empty_dupes_closed',  v_dupes,
    'player_counts_fixed', v_counts
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. The late-registration sweep that was promised and never written.
--
--    src/hooks/useTournamentRegistration.ts and src/pages/TablePage.tsx both
--    tell the reader that when seating fails at registration "the engine's 5s
--    sweep seats him". There was no sweep. fn_seat_late_registrant had zero
--    callers outside fn_register_for_tournament, so a player whose seating
--    lost a race, or who registered while every table was momentarily full,
--    stayed paid and seatless indefinitely.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_sweep_seatless_late_registrants()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_row    record;
  v_res    jsonb;
  v_seated int := 0;
  v_failed int := 0;
BEGIN
  FOR v_row IN
    SELECT tp.tournament_id, tp.user_id
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id = tp.tournament_id
     WHERE t.status = 'RUNNING'
       AND tp.status = 'registered'
       AND tp.table_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.table_seats s
           JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = tp.tournament_id
            AND s.user_id = tp.user_id
            AND s.left_at IS NULL
       )
     ORDER BY tp.registered_at ASC NULLS LAST
     LIMIT 200
  LOOP
    /* One player per block. A refusal ('no_open_seat' while the balancer is
       mid-move, or a lost seat race) is an expected outcome and must not
       abandon the rest of the queue. */
    BEGIN
      v_res := public.fn_seat_late_registrant(v_row.tournament_id, v_row.user_id);
      IF COALESCE((v_res ->> 'ok')::boolean, false) THEN
        v_seated := v_seated + 1;
      ELSE
        v_failed := v_failed + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('seated', v_seated, 'still_waiting', v_failed);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_sweep_seatless_late_registrants() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_tournament_primary_table(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- POST-APPLY ASSERTIONS. A migration that cannot prove its own claim is a
-- migration that quietly did nothing.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  v_bad int;
BEGIN
  IF public.fn_tournament_primary_table('00000000-0000-0000-0000-000000000000') IS NOT NULL THEN
    RAISE EXCEPTION 'fn_tournament_primary_table invented a table for a nonexistent tournament';
  END IF;

  -- Wherever an occupied live table exists, it must be the one chosen.
  SELECT count(*) INTO v_bad
    FROM public.tournaments t
   WHERE t.status IN ('REGISTERING', 'RUNNING')
     AND EXISTS (
       SELECT 1 FROM public.tables a
        WHERE a.tournament_id = t.id
          AND lower(COALESCE(a.status,'')) <> 'closed'
          AND (SELECT count(*) FROM public.table_seats s
                WHERE s.table_id = a.id AND s.left_at IS NULL) > 0
     )
     AND (SELECT count(*) FROM public.table_seats s
           WHERE s.table_id = public.fn_tournament_primary_table(t.id)
             AND s.left_at IS NULL) = 0;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'primary table is still an empty one for % tournament(s)', v_bad;
  END IF;

  IF (SELECT count(*) FROM pg_proc WHERE proname = 'fn_seat_horse_in_seat_first_game') <> 1 THEN
    RAISE EXCEPTION 'fn_seat_horse_in_seat_first_game must have exactly one overload';
  END IF;

  -- The sweep must actually reach the seating function, or it is decoration.
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_sweep_seatless_late_registrants')
     NOT LIKE '%fn_seat_late_registrant%' THEN
    RAISE EXCEPTION 'the sweep does not call fn_seat_late_registrant';
  END IF;
END
$assert$;
