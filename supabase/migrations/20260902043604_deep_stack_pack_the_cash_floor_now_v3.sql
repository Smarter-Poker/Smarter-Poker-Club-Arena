-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902043604; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- PACK THE DEEP STACK CASH FLOOR NOW (2026-09-02, Dan: "WHY ARE THERE STILL
-- NOT CASH GAMES RUNNING"). The running engine (93d167b5) has the club-scoped
-- picks but NOT the packing law (that is PR #2548, pending deploy) - its old
-- V14 occupancy spreads ~1 horse per table across the whole 1000-table
-- platform sample, and its session rotator drains packed tables toward 2-3,
-- so Deep Stack keeps collapsing to lonely singles. This bridge fills DS cash
-- tables to SIX-handed through atomic_table_buyin (canonical, ledgered,
-- band-matched, members only, 2x-bankroll) so they settle at real 4-6-handed
-- games even under the old rotator's floor. Targets FULL (not seats-1) to
-- leave headroom above the rotator's departure floor, and covers many tables
-- so a broad swath of the lobby shows live fields immediately.
DO $$
DECLARE
  v_club uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_t record; v_h record; v_seat int; v_buyin numeric;
  v_target int; v_seated int; v_total int := 0; v_before int; v_after int;
BEGIN
  SET LOCAL statement_timeout = '400s';

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
     ORDER BY (SELECT count(*) FROM table_seats ts WHERE ts.table_id=t.id AND ts.left_at IS NULL) DESC,
              t.big_blind ASC
     LIMIT 120
  LOOP
    v_target := LEAST(v_t.max_players, 6);   -- fill FULL; rotator floor keeps >=4
    v_seated := v_t.seated;
    IF v_seated >= v_target THEN CONTINUE; END IF;

    FOR v_h IN
      SELECT p.id, cm.chip_balance
        FROM profiles p
        JOIN club_members cm ON cm.user_id=p.id AND cm.club_id=v_club
       WHERE p.is_horse AND p.horse_status='available'
         AND COALESCE(p.horse_profile->>'lane','both') <> 'events'
         AND COALESCE(p.horse_profile->>'stakeBand','low') = v_t.band
         AND NOT EXISTS (SELECT 1 FROM table_seats ts JOIN tables tb ON tb.id=ts.table_id
                          WHERE ts.user_id=p.id AND ts.left_at IS NULL AND tb.status IN ('waiting','running'))
         AND NOT EXISTS (SELECT 1 FROM tournament_players tp JOIN tournaments t2 ON t2.id=tp.tournament_id
                          WHERE tp.user_id=p.id AND tp.status IN ('registered','playing')
                            AND t2.status IN ('ANNOUNCED','REGISTERING','RUNNING'))
       ORDER BY random()
       LIMIT (v_target - v_seated)
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
  RAISE NOTICE 'pack v3: seated % ; real fields % -> %', v_total, v_before, v_after;
END $$;
