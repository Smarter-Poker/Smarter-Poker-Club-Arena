-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815070837 "reseat_stranded_tournament_players_via_seat_row_reuse"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6853958b578cfc020269c6f76339c7fb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- LIVE E2E TOURNAMENT REPAIR 2026-08-15 (attempt 2)
-- table_seats holds ONE row per (table_id, seat_number) — seats are reused by
-- UPDATE, never re-INSERT. (This is also the root cause of the stranding:
-- executePlayerMoves blind-INSERTs the destination seat and dies on 23505
-- whenever that seat number was ever used before.)
-- Re-activate a left seat row for each stranded 'playing' player.
DO $$
DECLARE
  r RECORD;
  v_seatrow RECORD;
  v_chips integer;
  v_reseated integer := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('d51d6ea4-11cb-456c-8d4e-5272f530d62c'::uuid,'e5a834e5-bae7-4acd-8be9-a3c995a52395'::uuid,'ddc9c401-30cc-4b75-a2e2-978489d19e7c'::uuid),
      ('d51d6ea4-11cb-456c-8d4e-5272f530d62c'::uuid,'8703e327-5739-475e-b256-8eca013b9b7b'::uuid,'ddc9c401-30cc-4b75-a2e2-978489d19e7c'::uuid),
      ('3912abc3-44e1-4110-a5ad-1c6ea6258191'::uuid,'5cb613e1-c76a-4b1f-98d4-5546c1a5c4e8'::uuid,'7a439335-8a62-499a-a28c-8e95d5a08dc1'::uuid),
      ('3912abc3-44e1-4110-a5ad-1c6ea6258191'::uuid,'f1478ac2-b524-4b56-8ce8-5f8eaef65916'::uuid,'7a439335-8a62-499a-a28c-8e95d5a08dc1'::uuid),
      ('3912abc3-44e1-4110-a5ad-1c6ea6258191'::uuid,'8ef81aac-30ee-4ad5-bc83-20f15046f37d'::uuid,'7a439335-8a62-499a-a28c-8e95d5a08dc1'::uuid),
      ('3912abc3-44e1-4110-a5ad-1c6ea6258191'::uuid,'88e2d7d9-2c5a-41b0-a25d-c5643ba4ae67'::uuid,'7a439335-8a62-499a-a28c-8e95d5a08dc1'::uuid),
      ('3fe9486c-5fac-40f7-9ec6-cbb2baa8f81f'::uuid,'f7c6e68a-744d-4fe4-bc9e-06996d8341eb'::uuid,'75259246-f27f-4a1a-aeb0-5bd39a473df9'::uuid),
      ('3fe9486c-5fac-40f7-9ec6-cbb2baa8f81f'::uuid,'396ebb6d-2fcb-4a0f-ae7e-6a5856b6651f'::uuid,'75259246-f27f-4a1a-aeb0-5bd39a473df9'::uuid),
      ('3fe9486c-5fac-40f7-9ec6-cbb2baa8f81f'::uuid,'50702991-15a1-46a0-8607-7ae6e343a6b7'::uuid,'75259246-f27f-4a1a-aeb0-5bd39a473df9'::uuid)
    ) AS m(tournament_id, user_id, target_table)
  LOOP
    -- Guard: still 'playing', chips > 0, and no active seat anywhere in this tournament
    SELECT tp.chips INTO v_chips FROM tournament_players tp
      WHERE tp.tournament_id = r.tournament_id AND tp.user_id = r.user_id
        AND tp.status = 'playing' AND tp.chips > 0
        AND NOT EXISTS (
          SELECT 1 FROM table_seats s JOIN tables tb ON tb.id = s.table_id
          WHERE s.user_id = r.user_id AND s.left_at IS NULL
            AND tb.tournament_id = r.tournament_id
        );
    IF NOT FOUND THEN
      RAISE NOTICE 'skip % — state changed since audit', r.user_id;
      CONTINUE;
    END IF;

    -- Lowest-numbered LEFT seat row at the target table, re-selected each
    -- iteration so two players never grab the same row.
    SELECT s.id, s.seat_number INTO v_seatrow FROM table_seats s
      WHERE s.table_id = r.target_table AND s.left_at IS NOT NULL
      ORDER BY s.seat_number LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no reusable seat row at table % for player %', r.target_table, r.user_id;
    END IF;

    UPDATE table_seats
      SET user_id = r.user_id, stack = v_chips, left_at = NULL,
          joined_at = now()
      WHERE id = v_seatrow.id;

    UPDATE tournament_players SET table_id = r.target_table
      WHERE tournament_id = r.tournament_id AND user_id = r.user_id;

    v_reseated := v_reseated + 1;
  END LOOP;

  -- mickeydimes: active seat already exists at 75259246; only table_id was NULL
  UPDATE tournament_players
    SET table_id = '75259246-f27f-4a1a-aeb0-5bd39a473df9'
    WHERE tournament_id = '3fe9486c-5fac-40f7-9ec6-cbb2baa8f81f'
      AND user_id = 'face0000-0000-0000-0000-000000000004'
      AND table_id IS NULL;

  UPDATE tables t SET current_players = sub.n
  FROM (
    SELECT table_id, count(*) AS n FROM table_seats
    WHERE table_id IN ('ddc9c401-30cc-4b75-a2e2-978489d19e7c','7a439335-8a62-499a-a28c-8e95d5a08dc1','75259246-f27f-4a1a-aeb0-5bd39a473df9')
      AND left_at IS NULL
    GROUP BY table_id
  ) sub WHERE t.id = sub.table_id;

  -- Assertion: every 'playing' player of the 3 tournaments now has an active
  -- seat at a non-closed table of their own tournament.
  IF EXISTS (
    SELECT 1 FROM tournament_players tp
    WHERE tp.status='playing'
      AND tp.tournament_id IN ('d51d6ea4-11cb-456c-8d4e-5272f530d62c','3912abc3-44e1-4110-a5ad-1c6ea6258191','3fe9486c-5fac-40f7-9ec6-cbb2baa8f81f')
      AND NOT EXISTS (
        SELECT 1 FROM table_seats s JOIN tables tb ON tb.id=s.table_id
        WHERE s.user_id=tp.user_id AND s.left_at IS NULL
          AND tb.tournament_id=tp.tournament_id AND tb.status <> 'closed'
      )
  ) THEN
    RAISE EXCEPTION 'REPAIR FAILED: some playing players still lack an active seat';
  END IF;

  RAISE NOTICE 'reseated % stranded players', v_reseated;
END $$;
