-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902161843; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- Dan 2026-09-02: "FREE THEM TO PLAY OPENLY INSIDE THE DEEP STACK SOCIETY
-- ONLY. THEY HAVE NO AFFILIATION OR ARE A PART OF THE MIDWAY UNION."
--
-- Deep Stack Society was not short of horses and not short of tables. It was
-- short of TABLES WITH MORE THAN ONE PLAYER AT THEM. The floor stood at 1,058
-- live cash tables holding 66 seats: 999 completely empty, 52 with exactly one
-- horse sitting alone, 7 with two or three, and NOT ONE table at four handed.
-- Meanwhile 186 horses with a Deep Stack membership were idle, none of them
-- benched (every horse_status is already 'available' - there was nothing to
-- un-bench, so "free them" is a seating problem, not a permissions one).
--
-- A lone horse at a table is the worst of both worlds: it cannot be dealt to,
-- it holds its buy-in off the felt where nothing can use it, and it makes the
-- lobby advertise a thousand tables that all read as dead. So this does not
-- open new tables. It CONCENTRATES the roster onto the tables that already
-- have somebody at them, filling each to five handed, which turns 59 stranded
-- seats into 59 games.
--
-- Deep Stack is standalone (clubs.union_id IS NULL), so wallet resolution is
-- unambiguous: fn_seat_club_for_user takes its first branch and returns the
-- table's own club. No union hashing, no Midway. Nothing here reads or writes
-- a Midway row, and the Midway floor is untouched by design.
--
-- Ordering is by seats DESC so the fullest tables are completed first: if the
-- roster runs out, it runs out having finished games rather than having left
-- every table one short.
DO $$
DECLARE
  v_club  uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_run   text := to_char(now(), 'YYYYMMDDHH24MI');
  v_t record; v_h record;
  v_seat int; v_buyin numeric; v_want int;
  v_ok int := 0; v_fail int := 0; v_wanted int := 0; v_err text;
  v_before int; v_after int;
BEGIN
  SET LOCAL statement_timeout = '540s';

  SELECT count(*) INTO v_before
    FROM tables t JOIN table_seats ts ON ts.table_id = t.id AND ts.left_at IS NULL
   WHERE t.club_id = v_club AND t.tournament_id IS NULL;

  FOR v_t IN
    SELECT t.id, t.max_players, t.big_blind, t.min_buy_in, t.max_buy_in,
           (SELECT count(*) FROM table_seats ts
             WHERE ts.table_id = t.id AND ts.left_at IS NULL) AS seated
      FROM tables t
     WHERE t.club_id = v_club AND t.tournament_id IS NULL
       AND COALESCE(t.is_deleted, false) = false
       AND t.status IN ('waiting','running')
       -- Only tables that already have a player. Empty tables stay empty:
       -- spreading into them is exactly the failure being undone here.
       AND (SELECT count(*) FROM table_seats ts
             WHERE ts.table_id = t.id AND ts.left_at IS NULL) BETWEEN 1 AND 4
     ORDER BY (SELECT count(*) FROM table_seats ts
                WHERE ts.table_id = t.id AND ts.left_at IS NULL) DESC,
              t.big_blind ASC
  LOOP
    v_want := LEAST(v_t.max_players, 5) - v_t.seated;
    CONTINUE WHEN v_want <= 0;
    v_wanted := v_wanted + v_want;

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
                        WHERE m.user_id = p.id
                          AND m.club_id = v_club
                          AND m.status IN ('active','approved')
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
          p_idempotency_key => md5(v_t.id::text || v_h.id::text || v_run)::uuid
        );
        v_ok := v_ok + 1;
      EXCEPTION WHEN OTHERS THEN
        v_fail := v_fail + 1;
        IF v_err IS NULL THEN v_err := SQLERRM; END IF;
      END;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_after
    FROM tables t JOIN table_seats ts ON ts.table_id = t.id AND ts.left_at IS NULL
   WHERE t.club_id = v_club AND t.tournament_id IS NULL;

  IF v_wanted > 0 AND v_ok = 0 THEN
    RAISE EXCEPTION 'wanted % seats and took none: % failures, first error: %',
      v_wanted, v_fail, COALESCE(v_err,'(none)');
  END IF;
  RAISE NOTICE 'deep stack %  -> % seats; wanted %, % ok, % failed, first error: %',
    v_before, v_after, v_wanted, v_ok, v_fail, COALESCE(v_err,'(none)');
END $$;
