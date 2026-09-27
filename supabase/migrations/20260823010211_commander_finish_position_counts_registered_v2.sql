-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823010211 "commander_finish_position_counts_registered_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0de4e0609b7a8027afb5668ae3febaa4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- commander_claim_finish_position counted a different field than it eliminated.
--
-- THE ASYMMETRY
--   COUNT : status IN ('seated','active','bagged')                -- no 'registered'
--   UPDATE: status IN ('registered','seated','active','bagged')   -- 'registered' allowed
--
-- A 'registered' entry could therefore be busted while never having been
-- counted as part of the field. The place handed out is derived from that
-- count, and payouts are derived from the place.
--
-- WHY THIS IS NOT THEORETICAL
-- Rooms seat and start their events while entries are still 'registered':
-- production holds 53 such rows, 52 of them sitting on a table and seat, and
-- SIX RUNNING TOURNAMENTS have a counted field of ZERO because every one of
-- their players is 'registered'. In that state v_remaining is 0, the clamp
-- lifts it to 1, and THE FIRST PLAYER ELIMINATED IS RECORDED IN 1ST PLACE.
-- The second bust then collides on uq_commander_entries_finish_position and
-- raises 23505, which eliminate.js surfaces as a failed elimination.
--
-- Even with a partly-seated field the numbering walks: busting one no-show in
-- a field of 5 seated players issues place 5 to the no-show, leaving 5 live
-- players to share places 4..1, so the last one out takes 1st - which the
-- winner branch then cannot write.
--
-- THE FIX
-- Count the same set the UPDATE is willing to eliminate. That is also the
-- definition of field size used everywhere else: register.js counts
-- ('registered','seated','active','bagged') against max_entries.
--
-- 'bagged' stays counted (alive, chips in a bag); 'alternate' stays out (not
-- in the field yet); eliminated/cancelled/winner stay out.
--
-- Parameter order is (p_entry_id, p_tournament_id, p_eliminated_by) and is
-- preserved exactly - CREATE OR REPLACE cannot rename or reorder them.
--
-- ROLLBACK: restore the count to
--   AND e.status IN ('seated','active','bagged')
-- Signature and return shape are unchanged either way.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.commander_claim_finish_position(
  p_entry_id uuid,
  p_tournament_id uuid,
  p_eliminated_by uuid DEFAULT NULL::uuid
)
RETURNS TABLE(finish_position integer, remaining_after integer, entry jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_remaining integer;
  v_pos integer;
  v_row commander_tournament_entries%ROWTYPE;
BEGIN
  PERFORM 1 FROM commander_tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament % not found', p_tournament_id;
  END IF;

  -- FIELD COUNT, not seat occupancy. Must match the status set the UPDATE
  -- below is willing to eliminate, or a player is busted out of a field they
  -- were never counted in.
  --   'registered' - paid and in the event; rooms start with players still in
  --                  this state, so excluding it broke the numbering outright.
  --   'bagged'     - multi-day, chips in a bag, still alive.
  --   'alternate'  - NOT in the field yet. Correctly excluded.
  SELECT count(*) INTO v_remaining
  FROM commander_tournament_entries e
  WHERE e.tournament_id = p_tournament_id
    AND e.status IN ('registered', 'seated', 'active', 'bagged');

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
$function$;

DO $$
DECLARE
  src text;
  n_zero int;
BEGIN
  SELECT prosrc INTO src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'commander_claim_finish_position';

  IF src IS NULL THEN
    RAISE EXCEPTION 'commander_claim_finish_position missing after replace';
  END IF;

  -- The count must no longer omit 'registered'.
  IF position('IN (''seated'', ''active'', ''bagged'')' in src) > 0 THEN
    RAISE EXCEPTION 'the old field count is still present';
  END IF;

  -- No live tournament that holds players may now count a field of zero.
  SELECT count(*) INTO n_zero
    FROM commander_tournaments t
   WHERE t.status IN ('registration','running','paused','final_table')
     AND EXISTS (SELECT 1 FROM commander_tournament_entries e
                  WHERE e.tournament_id = t.id
                    AND e.status IN ('registered','seated','active','bagged'))
     AND (SELECT count(*) FROM commander_tournament_entries e2
           WHERE e2.tournament_id = t.id
             AND e2.status IN ('registered','seated','active','bagged')) = 0;
  IF n_zero > 0 THEN
    RAISE EXCEPTION 'still % tournament(s) with an uncountable field', n_zero;
  END IF;

  RAISE NOTICE 'commander_claim_finish_position now counts registered players';
END $$;
