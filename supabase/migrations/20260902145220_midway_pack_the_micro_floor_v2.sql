-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902145220; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- v1 seated NOTHING: p_idempotency_key is uuid, v1 passed a text key, and
-- every call died on the cast inside the per-horse EXCEPTION block. Same shape,
-- deterministic uuid key (md5 of table+horse), and the failure counters are now
-- raised at the end so a silent zero can never look like success again.
--
-- Pool is every horse whose membership resolves through union_clubs to
-- fade0000-...-0001 (Club JAQK + SHARK CLUB). Deep Stack is untouched.
-- Live tournament registrations are untouched. Band matching is dropped for
-- this floor: at bb <= 0.50 no band carries bankroll risk, and the strict
-- match would strand 39 of 45 tables.
DO $$
DECLARE
  v_club   uuid := 'fade0000-0000-0000-0000-000000000001';
  v_union  uuid := 'fade0000-0000-0000-0000-000000000001';
  v_pass   int; v_target int;
  v_t record; v_h record;
  v_seat int; v_buyin numeric; v_seated int; v_want int;
  v_ok int := 0; v_fail int := 0; v_err text;
  v_before int; v_after int;
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
       WHERE t.club_id = v_club AND t.tournament_id IS NULL
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
           WHERE p.is_horse
             AND p.horse_status = 'available'
             AND COALESCE(p.horse_profile->>'lane','both') <> 'events'
             AND EXISTS (SELECT 1 FROM club_members m
                           JOIN union_clubs uc ON uc.club_id = m.club_id
                          WHERE m.user_id = p.id
                            AND m.status IN ('active','approved')
                            AND uc.union_id = v_union
                            AND m.chip_balance >= v_buyin * 2)
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
            p_user_id         => v_h.id,
            p_table_id        => v_t.id,
            p_seat_number     => v_seat,
            p_amount          => v_buyin,
            p_auto_rebuy      => true,
            p_club_id         => NULL,
            p_idempotency_key => md5(v_t.id::text || v_h.id::text)::uuid
          );
          v_seated := v_seated + 1;
          v_ok := v_ok + 1;
        EXCEPTION WHEN OTHERS THEN
          v_fail := v_fail + 1;
          IF v_err IS NULL THEN v_err := SQLERRM; END IF;
        END;
      END LOOP;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_after
    FROM tables t JOIN table_seats ts ON ts.table_id = t.id AND ts.left_at IS NULL
   WHERE t.club_id = v_club AND t.tournament_id IS NULL AND t.big_blind <= 0.5;

  IF v_ok = 0 THEN
    RAISE EXCEPTION 'seated nothing: % failures, first error: %', v_fail, COALESCE(v_err,'(none)');
  END IF;
  RAISE NOTICE 'micro floor % -> % seats; % ok, % failed, first error: %',
    v_before, v_after, v_ok, v_fail, COALESCE(v_err,'(none)');
END $$;
