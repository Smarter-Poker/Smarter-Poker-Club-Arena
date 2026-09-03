-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902051422; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_repair_seat_first_games v4 (2026-09-02)
--
-- WHY: v3 healed "6 oldest husks per call". Measured tonight: one seat call
-- costs 0.4s idle and 2.1s under load, so 6 husks x 2 openers ran 5-25s
-- against the engine's pinned 8s statement_timeout. Every call that reached
-- Deep Stack Society's 31 husks (all Class A, two openers each) timed out and
-- rolled back; every call that only reached Midway's Class-B shortfalls
-- succeeded. ORDER BY created_at then handed the same 6 Midway rows to every
-- pass, so Deep Stack's Spin board sat at zero tables for an hour while the
-- log said "repaired 6". Three changes:
--   1. TIME budget (5s wall clock), not a row count. Progress every call,
--      never a timeout, however slow the DB is that minute.
--   2. OWNER-FAIR ordering: round-robin across club_id, so one owner's
--      backlog cannot starve another's first husk.
--   3. The eligible-horse pool is computed ONCE per owner per call and
--      popped, instead of one 400ms query per opener.
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

    -- A FRESH HUMAN WINDOW: 45-90 seconds (Dan 2026-09-01), randomised per
    -- game. Only when the repair changed something.
    IF v_seated > 0 OR v_t.joinable_table_id IS NULL THEN
      v_window := 45 + floor(random() * 46)::int;
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

COMMENT ON FUNCTION public.fn_repair_seat_first_games(integer) IS
  'v4 2026-09-02: 5s wall-clock budget (engine calls it with an 8s pinned timeout), owner-fair round-robin ordering, one horse pool per owner per call. See migration healer_time_budgeted_and_owner_fair.';

COMMIT;
