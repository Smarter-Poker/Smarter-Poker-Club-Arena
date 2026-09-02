-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901181246; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- SEAT-FIRST OPENERS CAN BE RESEATED (2026-09-01). New husk class found on
-- Deep Stack Society: 32 Spin queues created while the club's horses were
-- benched got joinable tables but ZERO opening horses; nothing retries opener
-- seating, and a joinable husk covers its price point in ensureBoardOpen
-- forever. Extends fn_repair_seat_first_games (called by the engine every
-- 30s) with the short-of-openers class, club-scopes the horse pick via
-- fn_ca_entry_scope_ok (a horse plays only in its club - Dan's law), and
-- honors the bench latch (horse_status='available').

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
         NOT EXISTS (SELECT 1 FROM public.tables tb2 WHERE tb2.tournament_id = t.id)
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
      -- Class B: joinable table short of openers. Seat the SHORTFALL only:
      -- a human already seated counts toward the field.
      v_opening := GREATEST(GREATEST(v_seats - 1, 0) - v_t.seated_now, 0);
      IF v_opening = 0 THEN
        CONTINUE;
      END IF;
    END IF;

    v_seated := 0;

    FOR v_horse IN
      SELECT p.id
        FROM public.profiles p
       WHERE p.is_horse = true
         AND p.horse_status = 'available'
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

    -- Fresh 60-180s human window, only when the repair changed something.
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

REVOKE ALL ON FUNCTION public.fn_repair_seat_first_games(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_repair_seat_first_games(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_repair_seat_first_games(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_repair_seat_first_games(integer) TO service_role;

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
