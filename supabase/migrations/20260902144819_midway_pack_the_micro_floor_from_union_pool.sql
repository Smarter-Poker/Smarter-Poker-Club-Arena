-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902144819; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- PACK THE MIDWAY UNION MICRO FLOOR (Dan 2026-09-02: "free all the horses...
-- not just 30"). The 30 was Midway-club members only. The eligible pool is the
-- whole union - Midway + Club JAQK + SHARK CLUB all carry union_id
-- fade0000-...-0001, so any of their horse members can seat at a Midway table
-- through fn_seat_club_for_user. That pool is 584 horses, 225 already free.
-- Nothing needs to be torn down to reach them.
--
-- Deep Stack Society is deliberately NOT touched: union_id IS NULL, so its
-- horses cannot seat at Midway tables anyway, and its 91 running cash tables
-- are the only cash on the platform currently dealing hands. Live tournament
-- registrations are left alone.
--
-- Band rule relaxed one step for this floor only: 'low' horses may sit at
-- micro tables (bb <= 0.50). Playing below band carries no bankroll risk, and
-- a strict micro-only match would leave 39 of the 45 new tables empty.
-- Pass 1 seats 4-handed across every variant/tier so the whole lobby shows
-- action; pass 2 tops up to 6 while horses remain. Idempotent.
DO $$
DECLARE
  v_club   uuid := 'fade0000-0000-0000-0000-000000000001';
  v_pass   int;
  v_target int;
  v_t record; v_h record;
  v_seat int; v_buyin numeric; v_seated int; v_want int;
  v_total int := 0; v_before int; v_after int;
BEGIN
  SET LOCAL statement_timeout = '540s';

  SELECT count(*) INTO v_before
    FROM tables t JOIN table_seats ts ON ts.table_id = t.id AND ts.left_at IS NULL
   WHERE t.club_id = v_club AND t.tournament_id IS NULL AND t.big_blind <= 0.5;

  FOR v_pass IN 1..2 LOOP
    v_target := CASE v_pass WHEN 1 THEN 4 ELSE 6 END;

    FOR v_t IN
      SELECT t.id, t.max_players, t.big_blind, t.min_buy_in, t.max_buy_in,
             (SELECT count(*) FROM table_seats ts
               WHERE ts.table_id = t.id AND ts.left_at IS NULL) AS seated
        FROM tables t
       WHERE t.club_id = v_club
         AND t.tournament_id IS NULL
         AND COALESCE(t.is_deleted, false) = false
         AND t.status IN ('waiting','running')
         AND t.big_blind <= 0.5
       ORDER BY t.big_blind ASC, t.game_variant ASC
    LOOP
      v_seated := v_t.seated;
      v_want   := LEAST(v_t.max_players, v_target) - v_seated;
      CONTINUE WHEN v_want <= 0;

      v_buyin := GREATEST(COALESCE(NULLIF(v_t.min_buy_in,0), v_t.big_blind*40),
                          v_t.big_blind*100);
      IF COALESCE(NULLIF(v_t.max_buy_in,0), 0) > 0 AND v_buyin > v_t.max_buy_in THEN
        v_buyin := v_t.max_buy_in;
      END IF;
      v_buyin := round(v_buyin, 2);

      FOR v_h IN
        SELECT cand.id FROM (
          SELECT p.id
            FROM profiles p
            JOIN club_members cm ON cm.user_id = p.id
           WHERE p.is_horse
             AND p.horse_status = 'available'
             AND cm.club_id IN ('fade0000-0000-0000-0000-000000000001',
                                'a0000000-0000-0000-0000-000000000001',
                                'a41434bb-8d0c-400a-8f0d-e8b3d65afed4')
             AND cm.chip_balance >= v_buyin * 2
             AND COALESCE(p.horse_profile->>'lane','both') <> 'events'
             AND COALESCE(p.horse_profile->>'stakeBand','low') IN ('micro','low')
             AND NOT EXISTS (SELECT 1 FROM table_seats ts JOIN tables tb ON tb.id = ts.table_id
                              WHERE ts.user_id = p.id AND ts.left_at IS NULL
                                AND tb.status IN ('waiting','running'))
             AND NOT EXISTS (SELECT 1 FROM tournament_players tp
                               JOIN tournaments t2 ON t2.id = tp.tournament_id
                              WHERE tp.user_id = p.id
                                AND tp.status IN ('registered','playing')
                                AND t2.status IN ('ANNOUNCED','REGISTERING','RUNNING'))
           GROUP BY p.id
        ) cand
        ORDER BY random()
        LIMIT v_want
      LOOP
        SELECT s.n INTO v_seat
          FROM generate_series(1, v_t.max_players) AS s(n)
         WHERE NOT EXISTS (SELECT 1 FROM table_seats ts
                            WHERE ts.table_id = v_t.id AND ts.seat_number = s.n
                              AND ts.left_at IS NULL)
         ORDER BY s.n LIMIT 1;
        EXIT WHEN v_seat IS NULL;

        BEGIN
          PERFORM public.atomic_table_buyin(
            p_table_id        => v_t.id,
            p_user_id         => v_h.id,
            p_seat_number     => v_seat,
            p_amount          => v_buyin,
            p_auto_rebuy      => true,
            p_club_id         => v_club,
            p_idempotency_key => 'midway_micro_pack_' || v_t.id::text || '_' || v_h.id::text
          );
          v_seated := v_seated + 1;
          v_total  := v_total + 1;
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'skip horse % at table %: %', v_h.id, v_t.id, SQLERRM;
        END;
      END LOOP;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_after
    FROM tables t JOIN table_seats ts ON ts.table_id = t.id AND ts.left_at IS NULL
   WHERE t.club_id = v_club AND t.tournament_id IS NULL AND t.big_blind <= 0.5;

  RAISE NOTICE 'micro floor seats: % -> % (% buy-ins)', v_before, v_after, v_total;
END $$;
