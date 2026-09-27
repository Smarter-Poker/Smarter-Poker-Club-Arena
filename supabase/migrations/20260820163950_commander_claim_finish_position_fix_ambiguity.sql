-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820163950 "commander_claim_finish_position_fix_ambiguity"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8cfa52dd0c46978dc338c8aa2a1729e7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: the OUT parameter finish_position collided with the column of the same
-- name inside the EXISTS probe, so the function raised
-- "42702: column reference finish_position is ambiguous" on every call.
-- Caught by the pre-wire test before any route used it. The subquery is now
-- aliased so the column reference is unambiguous.

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
  PERFORM 1 FROM commander_tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament % not found', p_tournament_id;
  END IF;

  -- FIELD COUNT, not seat occupancy: a 'bagged' player is still alive.
  SELECT count(*) INTO v_remaining
  FROM commander_tournament_entries e
  WHERE e.tournament_id = p_tournament_id
    AND e.status IN ('seated', 'active', 'bagged');

  IF v_remaining IS NULL OR v_remaining < 1 THEN
    v_remaining := 1;
  END IF;

  v_pos := v_remaining;
  WHILE v_pos > 1 AND EXISTS (
    SELECT 1 FROM commander_tournament_entries e
    WHERE e.tournament_id = p_tournament_id
      AND e.finish_position = v_pos
      AND e.id <> p_entry_id
  ) LOOP
    v_pos := v_pos - 1;
  END LOOP;

  UPDATE commander_tournament_entries e
  SET status = 'eliminated',
      eliminated_at = now(),
      eliminated_by = COALESCE(p_eliminated_by, e.eliminated_by),
      finish_position = v_pos,
      table_number = NULL,
      seat_number = NULL
  WHERE e.id = p_entry_id
    AND e.tournament_id = p_tournament_id
    AND e.status IN ('registered', 'seated', 'active', 'bagged')
  RETURNING e.* INTO v_row;

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
