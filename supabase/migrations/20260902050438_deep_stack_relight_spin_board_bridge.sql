-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902050438; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- RE-LIGHT DEEP STACK'S SPIN BOARD (2026-09-02). The running engine's spin
-- board is starved: one BURST budget shared house-first, and Midway's churn
-- consumes all 12 creations every tick, so Deep Stack's turn never comes and
-- its board sits at ZERO open queues (fixed in the engine - per-owner budget,
-- PR #2548 - pending deploy). Bridge: re-open one REGISTERING queue per spin
-- config Deep Stack has run before, cloned field-for-field from that config's
-- most recent engine-created row (so buy-in split, rake, blinds, payout,
-- variant, table_size all match what the engine itself writes). No table is
-- created here on purpose: fn_repair_seat_first_games (engine, every 30s)
-- treats a REGISTERING spin with no table as Class A and gives it its table
-- plus two DS opening horses with a fresh 45-90s human window - the exact
-- path the engine's own createSpin would have taken. Idempotent: a config
-- that already has an open queue is skipped.
DO $$
DECLARE v_src record; v_made int := 0;
BEGIN
  FOR v_src IN
    SELECT DISTINCT ON (t.name) t.*
      FROM tournaments t
     WHERE t.club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
       AND t.tournament_type='SPIN' AND t.variant='spin'
       AND t.status IN ('COMPLETED','FINISHED','RUNNING')
       AND NOT EXISTS (SELECT 1 FROM tournaments o WHERE o.club_id=t.club_id AND o.name=t.name AND o.status='REGISTERING')
     ORDER BY t.name, t.created_at DESC
  LOOP
    INSERT INTO tournaments (
      club_id, union_id, name, game_type, variant, tournament_type,
      buy_in_amount, buy_in_fee, guaranteed_prize, starting_chips, max_players, min_players,
      table_size, current_players, status, blind_structure, payout_structure, start_time,
      late_reg_levels, late_reg_mins, spin_multiplier, prize_pool)
    VALUES (
      v_src.club_id, NULL, v_src.name, v_src.game_type, 'spin', 'SPIN',
      v_src.buy_in_amount, v_src.buy_in_fee, 0, v_src.starting_chips, v_src.max_players, v_src.min_players,
      v_src.table_size, 0, 'REGISTERING', v_src.blind_structure, v_src.payout_structure,
      now() + interval '90 seconds', 0, 0, NULL, 0);
    v_made := v_made + 1;
  END LOOP;
  RAISE NOTICE 'relit % Deep Stack spin queue(s)', v_made;
  IF v_made = 0 THEN RAISE EXCEPTION 'no spin configs to relight - investigate'; END IF;
END $$;
