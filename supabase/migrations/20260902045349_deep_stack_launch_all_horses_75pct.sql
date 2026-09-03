-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902045349; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- LAUNCH ALL DEEP STACK HORSES ONTO DEEP STACK TABLES (Dan 2026-09-02:
-- "LAUNCH ALL OF OUR HORSES TO PLAY THESE TABLES ... TO START TESTING").
-- DS is standalone (union_id NULL), all 1,128 cash tables are DS-owned; this
-- seats DS member horses onto DS tables through atomic_table_buyin so the
-- floor is live for testing NOW, ahead of the engine's own packing law
-- (#2548). ~75% of tables packed full, the rest left sporadic; band-matched,
-- members only, 2x-bankroll, canonical ledgered buy-ins. Idempotent: a table
-- already at/over its target is skipped.
DO $$
DECLARE
  v_club uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_t record; v_h record; v_seat int; v_buyin numeric;
  v_target int; v_seated int; v_total int := 0; v_before int; v_after int;
  v_i int := 0;
BEGIN
  SET LOCAL statement_timeout = '540s';
  SELECT count(*) INTO v_before FROM (
    SELECT t.id FROM tables t JOIN table_seats ts ON ts.table_id=t.id AND ts.left_at IS NULL
     WHERE t.club_id=v_club AND t.tournament_id IS NULL GROUP BY t.id HAVING count(*)>=2) x;

  FOR v_t IN
    SELECT t.id, t.max_players, t.big_blind, t.min_buy_in, t.max_buy_in,
           (SELECT count(*) FROM table_seats ts WHERE ts.table_id=t.id AND ts.left_at IS NULL) seated,
           CASE WHEN t.big_blind<=0.5 THEN 'micro' WHEN t.big_blind<=2 THEN 'low'
                WHEN t.big_blind<=6 THEN 'mid' ELSE 'high' END band
      FROM tables t
     WHERE t.club_id=v_club AND t.tournament_id IS NULL
       AND COALESCE(t.is_deleted,false)=false AND t.status IN ('waiting','running')
     ORDER BY (SELECT count(*) FROM table_seats ts WHERE ts.table_id=t.id AND ts.left_at IS NULL) DESC, t.big_blind ASC
     LIMIT 200
  LOOP
    v_i := v_i + 1;
    -- 75% of tables packed full; every 4th left sporadic (1-3 seats).
    IF v_i % 4 = 0 THEN v_target := LEAST(v_t.max_players, 1 + (v_i % 3)); ELSE v_target := LEAST(v_t.max_players, 6); END IF;
    v_seated := v_t.seated;
    IF v_seated >= v_target THEN CONTINUE; END IF;

    FOR v_h IN
      SELECT p.id, cm.chip_balance
        FROM profiles p JOIN club_members cm ON cm.user_id=p.id AND cm.club_id=v_club
       WHERE p.is_horse AND p.horse_status='available'
         AND COALESCE(p.horse_profile->>'lane','both') <> 'events'
         AND COALESCE(p.horse_profile->>'stakeBand','low') = v_t.band
         AND NOT EXISTS (SELECT 1 FROM table_seats ts JOIN tables tb ON tb.id=ts.table_id
                          WHERE ts.user_id=p.id AND ts.left_at IS NULL AND tb.status IN ('waiting','running'))
         AND NOT EXISTS (SELECT 1 FROM tournament_players tp JOIN tournaments t2 ON t2.id=tp.tournament_id
                          WHERE tp.user_id=p.id AND tp.status IN ('registered','playing')
                            AND t2.status IN ('ANNOUNCED','REGISTERING','RUNNING'))
       ORDER BY random() LIMIT (v_target - v_seated)
    LOOP
      v_buyin := GREATEST(COALESCE(NULLIF(v_t.min_buy_in,0), v_t.big_blind*40), v_t.big_blind*100);
      IF COALESCE(NULLIF(v_t.max_buy_in,0),0) > 0 THEN v_buyin := LEAST(v_buyin, v_t.max_buy_in); END IF;
      IF v_h.chip_balance < v_buyin*2 THEN CONTINUE; END IF;
      SELECT s INTO v_seat FROM generate_series(1, v_t.max_players) s
       WHERE NOT EXISTS (SELECT 1 FROM table_seats ts WHERE ts.table_id=v_t.id AND ts.seat_number=s AND ts.left_at IS NULL)
       ORDER BY s LIMIT 1;
      IF v_seat IS NULL THEN EXIT; END IF;
      BEGIN
        PERFORM public.atomic_table_buyin(v_h.id, v_t.id, v_seat, v_buyin, false, v_club, gen_random_uuid());
        v_total := v_total + 1; v_seated := v_seated + 1;
      EXCEPTION WHEN OTHERS THEN NULL; END;
      IF v_seated >= v_target THEN EXIT; END IF;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_after FROM (
    SELECT t.id FROM tables t JOIN table_seats ts ON ts.table_id=t.id AND ts.left_at IS NULL
     WHERE t.club_id=v_club AND t.tournament_id IS NULL GROUP BY t.id HAVING count(*)>=2) x;
  RAISE NOTICE 'launch: seated %, real fields % -> %', v_total, v_before, v_after;
END $$;
