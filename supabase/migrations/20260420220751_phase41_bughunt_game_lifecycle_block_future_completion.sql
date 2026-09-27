-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420220751 "phase41_bughunt_game_lifecycle_block_future_completion"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 da73f961ad2d05db0973538e1be95332 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Phase 41 bug-hunt pass 36a: block scheduled → completed when
-- scheduled_date + start_time is still in the future.
--
-- BUG (verified):
--   BI — host can UPDATE a scheduled game directly to status='completed'
--        even when the game is 7+ days in the future. This lets the host:
--        1. Unlock review-writing for a game that hasn't actually
--           happened yet (review INSERT checks game.status='completed').
--        2. Artificially inflate ratings / review counts on phantom games.
--        3. Skip the in_progress → completed signal that actual gameplay
--           occurred.
--
-- FIX:
--   Within fn_enforce_home_game_lifecycle_transitions:
--     scheduled → completed is allowed only if scheduled_date + start_time
--     is in the past (i.e., the game's scheduled start time has actually
--     elapsed). This permits the common flow of "host forgot to mark
--     in_progress but the game is over" while blocking "complete a
--     future game to game reviews."
--
--   Same rule for confirmed → completed.
--   in_progress → completed remains unconditional (in_progress is already
--   a signal the game started).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.fn_enforce_home_game_lifecycle_transitions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text := current_user;
  v_new_start timestamptz;
  v_scheduled_start timestamptz;
BEGIN
  IF v_role IN ('postgres', 'supabase_admin', 'service_role',
                'supabase_auth_admin', 'supabase_storage_admin') THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'GAME_STATUS_TERMINAL'
        USING HINT = 'cancelled games cannot be revived';
    END IF;
    IF OLD.status = 'completed' THEN
      RAISE EXCEPTION 'GAME_STATUS_TERMINAL'
        USING HINT = 'completed games cannot transition out of completed';
    END IF;
    IF OLD.status = 'draft' AND NEW.status NOT IN ('scheduled','cancelled') THEN
      RAISE EXCEPTION 'INVALID_GAME_TRANSITION'
        USING HINT = 'from draft, allowed next: scheduled or cancelled';
    END IF;
    IF OLD.status = 'scheduled' AND NEW.status NOT IN ('confirmed','in_progress','completed','cancelled','draft') THEN
      RAISE EXCEPTION 'INVALID_GAME_TRANSITION'
        USING HINT = 'from scheduled, allowed next: confirmed, in_progress, completed, cancelled, draft';
    END IF;
    IF OLD.status = 'confirmed' AND NEW.status NOT IN ('scheduled','in_progress','completed','cancelled') THEN
      RAISE EXCEPTION 'INVALID_GAME_TRANSITION'
        USING HINT = 'from confirmed, allowed next: scheduled, in_progress, completed, cancelled';
    END IF;
    IF OLD.status = 'in_progress' AND NEW.status NOT IN ('completed','cancelled') THEN
      RAISE EXCEPTION 'INVALID_GAME_TRANSITION'
        USING HINT = 'from in_progress, allowed next: completed or cancelled';
    END IF;

    -- Pass 36a: direct completion (scheduled/confirmed → completed) requires
    -- the game's scheduled start time to have elapsed. This prevents hosts
    -- from marking future games as completed to unlock fake reviews.
    IF OLD.status IN ('scheduled','confirmed') AND NEW.status = 'completed' THEN
      v_scheduled_start := (OLD.scheduled_date + OLD.start_time)::timestamptz;
      IF v_scheduled_start IS NULL OR v_scheduled_start > now() THEN
        RAISE EXCEPTION 'GAME_NOT_YET_STARTED'
          USING HINT = 'cannot complete a game whose scheduled start is in the future. '
                    || 'Transition through in_progress first, or wait until the scheduled start time.';
      END IF;
    END IF;
  END IF;

  IF NEW.scheduled_date IS DISTINCT FROM OLD.scheduled_date
     OR NEW.start_time  IS DISTINCT FROM OLD.start_time THEN
    IF OLD.status NOT IN ('draft','scheduled','confirmed') THEN
      RAISE EXCEPTION 'GAME_SCHEDULE_LOCKED'
        USING HINT = 'cannot change schedule on a ' || OLD.status || ' game';
    END IF;
    IF NEW.scheduled_date IS NOT NULL AND NEW.start_time IS NOT NULL THEN
      v_new_start := (NEW.scheduled_date + NEW.start_time)::timestamptz;
      IF v_new_start < now() THEN
        RAISE EXCEPTION 'GAME_SCHEDULE_PAST'
          USING HINT = 'cannot backdate schedule into the past on an active game; cancel instead';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
