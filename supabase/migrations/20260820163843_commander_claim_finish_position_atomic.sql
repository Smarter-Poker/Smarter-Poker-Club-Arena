-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820163843 "commander_claim_finish_position_atomic"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 71a5c4457607c354ff449b12d6891dbf of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Atomic Finish Position Claim For Tournament Eliminations
--
-- WHY: eliminate.js counts the remaining field, then loops checking whether
-- that finish position is already taken. Both halves are separate statements,
-- so two players busting at the same instant on different tables can both read
-- "5 remaining", both find 5 unclaimed (neither has written yet), and both be
-- recorded as 5th. The finishing order is then wrong, and because payouts are
-- derived from finish position, the money is wrong too. The existing loop
-- narrows the window but cannot close it.
--
-- This claims the position AND performs the elimination inside one statement,
-- behind a lock on the tournament row, so concurrent busts serialize.
--
-- Payout math deliberately stays in JS (it needs the structure, the pool, the
-- guarantee and any recorded deal). This function owns only the part that must
-- be atomic: which place the player finished in.

CREATE OR REPLACE FUNCTION commander_claim_finish_position(
  p_entry_id uuid,
  p_tournament_id uuid,
  p_eliminated_by uuid DEFAULT NULL
)
RETURNS TABLE (finish_position integer, remaining_after integer, entry jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_remaining integer;
  v_pos integer;
  v_row commander_tournament_entries%ROWTYPE;
BEGIN
  -- Serialize eliminations for this tournament.
  PERFORM 1 FROM commander_tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament % not found', p_tournament_id;
  END IF;

  -- FIELD COUNT, not seat occupancy: a 'bagged' player (multi-day, chips in a
  -- bag overnight) is still alive and must count, otherwise the field is short
  -- and this bust takes a place that is already spoken for.
  SELECT count(*) INTO v_remaining
  FROM commander_tournament_entries
  WHERE tournament_id = p_tournament_id
    AND status IN ('seated', 'active', 'bagged');

  IF v_remaining IS NULL OR v_remaining < 1 THEN
    v_remaining := 1;
  END IF;

  -- Highest position at or below the field size that nobody else holds.
  v_pos := v_remaining;
  WHILE v_pos > 1 AND EXISTS (
    SELECT 1 FROM commander_tournament_entries
    WHERE tournament_id = p_tournament_id
      AND finish_position = v_pos
      AND id <> p_entry_id
  ) LOOP
    v_pos := v_pos - 1;
  END LOOP;

  -- Conditional update: only an entry still in the tournament can be busted,
  -- so of two racing callers exactly one wins and the other gets no row.
  UPDATE commander_tournament_entries
  SET status = 'eliminated',
      eliminated_at = now(),
      eliminated_by = COALESCE(p_eliminated_by, eliminated_by),
      finish_position = v_pos,
      table_number = NULL,
      seat_number = NULL
  WHERE id = p_entry_id
    AND tournament_id = p_tournament_id
    AND status IN ('registered', 'seated', 'active', 'bagged')
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RETURN;
  END IF;

  finish_position := v_pos;
  remaining_after := GREATEST(v_remaining - 1, 0);
  entry := to_jsonb(v_row);
  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION commander_claim_finish_position(uuid, uuid, uuid) FROM anon, authenticated;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'commander_claim_finish_position') <> 1 THEN
    RAISE EXCEPTION 'commander_claim_finish_position not created';
  END IF;
END $$;

-- ROLLBACK:
-- DROP FUNCTION IF EXISTS commander_claim_finish_position(uuid, uuid, uuid);
