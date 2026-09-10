-- B-tournament-seats.sql  (workstream B, 2026-09-10 ~03:20 UTC)
-- One CREATE OR REPLACE. No trigger definitions change. No guard is removed,
-- weakened, reordered or narrowed. The only edit is the predicate form of the
-- proof-open EXISTS inside trg_lock_and_validate_tournament_live_seat:
--
--     t.id = ANY(v_ids)   -->   (t.id = v_old_tournament_id OR t.id = v_new_tournament_id)
--
-- Same rows on every input (v_ids is exactly {v_new} on INSERT, {v_old} on
-- DELETE, {v_old,v_new} on UPDATE; the unassigned side is NULL and
-- `t.id = NULL` contributes nothing to an OR, exactly as a NULL array element
-- contributes nothing to = ANY). v_ids itself is kept for the lock helper.
--
-- WHY IT MATTERS: with an array parameter PL/pgSQL never adopts the generic
-- plan (generic estimate 10 rows / cost 26 vs a ~8-cost custom plan), so the
-- statement is re-planned on EVERY execution: measured 0.83-0.99 ms per call
-- forever, versus 0.026 ms once the OR form switches to its generic plan on
-- the 6th execution. That replanning is 55-60% of all trigger time on a
-- tournament seat stack write in steady state (see B-tournament-seats.md).
--
-- Do NOT wrap in BEGIN/COMMIT here; the orchestrator batches.

CREATE OR REPLACE FUNCTION public.trg_lock_and_validate_tournament_live_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_ids uuid[];
  v_is_live_acquisition boolean := false;
  v_proof_open boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.seat_number IS NOT DISTINCT FROM OLD.seat_number
     AND NEW.stack IS NOT DISTINCT FROM OLD.stack
     AND NEW.left_at IS NOT DISTINCT FROM OLD.left_at THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT t.tournament_id INTO v_old_tournament_id
      FROM public.tables t
     WHERE t.id = OLD.table_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id THEN
    -- Same table on both sides: one lookup answers for both (2026-09-10).
    v_new_tournament_id := v_old_tournament_id;
  ELSIF TG_OP <> 'DELETE' THEN
    SELECT t.tournament_id INTO v_new_tournament_id
      FROM public.tables t
     WHERE t.id = NEW.table_id;
  END IF;

  -- A CASH SEAT HAS NO LAUNCH PROOF TO LOCK (2026-09-10). With both ids NULL
  -- the body below cannot lock, refuse or require anything: v_ids would be
  -- {NULL,NULL}, the proof-open test is false, the lock helper returns on an
  -- empty set, and the roster check needs a tournament. Measured 6.4 ms per
  -- seat write on a cash table for that no-op; see the migration header.
  IF v_old_tournament_id IS NULL AND v_new_tournament_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[v_new_tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[v_old_tournament_id]
    ELSE ARRAY[v_old_tournament_id, v_new_tournament_id]
  END;

  IF TG_OP = 'INSERT' THEN
    v_is_live_acquisition := NEW.left_at IS NULL AND NEW.user_id IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_is_live_acquisition := NEW.left_at IS NULL
      AND NEW.user_id IS NOT NULL
      AND (
        OLD.left_at IS NOT NULL
        OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.table_id IS DISTINCT FROM NEW.table_id
      );
  END IF;

  IF NOT v_is_live_acquisition THEN
    -- THE SAME ROWS AS `t.id = ANY(v_ids)`, WITHOUT A RE-PLAN PER CALL
    -- (2026-09-10). v_ids is {new} / {old} / {old,new} for INSERT / DELETE /
    -- UPDATE, and the side that is not assigned is NULL, which matches nothing
    -- in either form. With an array parameter PL/pgSQL keeps a custom plan and
    -- re-plans this statement on every seat write (0.83-0.99 ms measured);
    -- with two scalar parameters it adopts the generic plan (0.026 ms).
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE (t.id = v_old_tournament_id OR t.id = v_new_tournament_id)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  PERFORM *
    FROM public.fn_lock_tournament_launch_proof_parents(v_ids);

  IF TG_OP <> 'DELETE'
     AND NEW.left_at IS NULL
     AND NEW.user_id IS NOT NULL
     AND v_new_tournament_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_new_tournament_id
          AND p.user_id = NEW.user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament %',
      NEW.user_id, v_new_tournament_id
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

-- ============================================================================
-- ROLLBACK: the body currently on production (pg_get_functiondef, 2026-09-10
-- 03:18 UTC, i.e. the 20260910020459 version). Identical to the above except
-- the proof-open predicate reads `t.id = ANY(v_ids)`.
-- ============================================================================
-- CREATE OR REPLACE FUNCTION public.trg_lock_and_validate_tournament_live_seat()
--  RETURNS trigger
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- DECLARE
--   v_old_tournament_id uuid;
--   v_new_tournament_id uuid;
--   v_ids uuid[];
--   v_is_live_acquisition boolean := false;
--   v_proof_open boolean := false;
-- BEGIN
--   IF TG_OP = 'UPDATE'
--      AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
--      AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
--      AND NEW.seat_number IS NOT DISTINCT FROM OLD.seat_number
--      AND NEW.stack IS NOT DISTINCT FROM OLD.stack
--      AND NEW.left_at IS NOT DISTINCT FROM OLD.left_at THEN
--     RETURN NEW;
--   END IF;
--
--   IF TG_OP <> 'INSERT' THEN
--     SELECT t.tournament_id INTO v_old_tournament_id
--       FROM public.tables t
--      WHERE t.id = OLD.table_id;
--   END IF;
--   IF TG_OP = 'UPDATE' AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id THEN
--     -- Same table on both sides: one lookup answers for both (2026-09-10).
--     v_new_tournament_id := v_old_tournament_id;
--   ELSIF TG_OP <> 'DELETE' THEN
--     SELECT t.tournament_id INTO v_new_tournament_id
--       FROM public.tables t
--      WHERE t.id = NEW.table_id;
--   END IF;
--
--   -- A CASH SEAT HAS NO LAUNCH PROOF TO LOCK (2026-09-10). With both ids NULL
--   -- the body below cannot lock, refuse or require anything: v_ids would be
--   -- {NULL,NULL}, the proof-open test is false, the lock helper returns on an
--   -- empty set, and the roster check needs a tournament. Measured 6.4 ms per
--   -- seat write on a cash table for that no-op; see the migration header.
--   IF v_old_tournament_id IS NULL AND v_new_tournament_id IS NULL THEN
--     RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
--   END IF;
--
--   v_ids := CASE
--     WHEN TG_OP = 'INSERT' THEN ARRAY[v_new_tournament_id]
--     WHEN TG_OP = 'DELETE' THEN ARRAY[v_old_tournament_id]
--     ELSE ARRAY[v_old_tournament_id, v_new_tournament_id]
--   END;
--
--   IF TG_OP = 'INSERT' THEN
--     v_is_live_acquisition := NEW.left_at IS NULL AND NEW.user_id IS NOT NULL;
--   ELSIF TG_OP = 'UPDATE' THEN
--     v_is_live_acquisition := NEW.left_at IS NULL
--       AND NEW.user_id IS NOT NULL
--       AND (
--         OLD.left_at IS NOT NULL
--         OR OLD.user_id IS DISTINCT FROM NEW.user_id
--         OR OLD.table_id IS DISTINCT FROM NEW.table_id
--       );
--   END IF;
--
--   IF NOT v_is_live_acquisition THEN
--     SELECT EXISTS (
--       SELECT 1
--         FROM public.tournaments t
--         LEFT JOIN public.tournament_launch_receipts r
--           ON r.tournament_id = t.id
--        WHERE t.id = ANY(v_ids)
--          AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
--          AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
--     ) INTO v_proof_open;
--     IF NOT v_proof_open THEN
--       RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
--     END IF;
--   END IF;
--
--   PERFORM *
--     FROM public.fn_lock_tournament_launch_proof_parents(v_ids);
--
--   IF TG_OP <> 'DELETE'
--      AND NEW.left_at IS NULL
--      AND NEW.user_id IS NOT NULL
--      AND v_new_tournament_id IS NOT NULL
--      AND NOT EXISTS (
--        SELECT 1
--          FROM public.tournament_players p
--         WHERE p.tournament_id = v_new_tournament_id
--           AND p.user_id = NEW.user_id
--           AND p.status IN ('registered', 'playing')
--      ) THEN
--     RAISE EXCEPTION
--       'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament %',
--       NEW.user_id, v_new_tournament_id
--       USING ERRCODE = '23514';
--   END IF;
--
--   RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
-- END;
-- $function$;
