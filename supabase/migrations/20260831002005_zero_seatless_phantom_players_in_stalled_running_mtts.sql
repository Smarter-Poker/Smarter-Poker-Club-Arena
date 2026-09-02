-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831002005; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-08-31: REPAIR for the bust-vacate regression (see club-arena PR #2004).
-- A 'playing' player with stale chips > 0 and NO open seat in a RUNNING
-- tournament that has dealt no hand for 10+ minutes is a vacated bust the
-- elimination sweep cannot see. Zero their chips (data only) so the live
-- engine's ordinary elimination + payout path finishes the event and pays
-- the champion. No money moves in this migration.
DO $$
DECLARE v_count int;
BEGIN
  WITH stalled AS (
    SELECT t.id
    FROM tournaments t
    WHERE t.status = 'RUNNING'
      AND t.started_at < now() - interval '30 minutes'
      AND COALESCE((
        SELECT max(hh.created_at) FROM hand_history hh
        JOIN tables tb ON tb.id = hh.table_id
        WHERE tb.tournament_id = t.id), t.started_at) < now() - interval '10 minutes'
  ), phantoms AS (
    SELECT tp.tournament_id, tp.user_id
    FROM tournament_players tp
    JOIN stalled s ON s.id = tp.tournament_id
    WHERE tp.status = 'playing' AND tp.chips > 0
      AND NOT EXISTS (
        SELECT 1 FROM table_seats ts
        JOIN tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = tp.tournament_id
          AND ts.user_id = tp.user_id
          AND ts.left_at IS NULL)
  )
  UPDATE tournament_players tp
  SET chips = 0
  FROM phantoms p
  WHERE tp.tournament_id = p.tournament_id AND tp.user_id = p.user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'zeroed % seatless phantom players', v_count;
  IF v_count > 60 THEN
    RAISE EXCEPTION 'unexpectedly large repair (%) — aborting', v_count;
  END IF;
END $$;
