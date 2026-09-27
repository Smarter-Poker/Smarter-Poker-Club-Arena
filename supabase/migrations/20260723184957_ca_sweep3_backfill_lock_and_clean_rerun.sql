-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260723184957 "ca_sweep3_backfill_lock_and_clean_rerun"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cb1caefaaea0650c127f8b5366e9d885 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: pg_cron fired overlapping backfill batches (no lock) — processed counter
-- exceeded table size, meaning some hands were processed more than once and
-- position stats could be double-counted. Remedy:
--   1. advisory lock so only one batch runs at a time
--   2. TRUNCATE player_position_stats and re-run the whole backfill cleanly
--   3. move the trigger/backfill boundary (cutoff) into the state row and set
--      it to now() — everything before cutoff comes from the (re)backfill,
--      everything after comes from the live trigger; truncating removed the
--      old trigger contributions so there is no double-count at the boundary.

SELECT cron.unschedule('pps-backfill');

ALTER TABLE public._pps_backfill_state ADD COLUMN IF NOT EXISTS cutoff timestamptz;

TRUNCATE public.player_position_stats;
UPDATE public._pps_backfill_state
   SET last_created = '-infinity', processed = 0, done = false,
       cutoff = now(), updated_at = now()
 WHERE id;

CREATE OR REPLACE FUNCTION public.fn_pps_backfill_batch(p_batch integer DEFAULT 3000)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_state record;
  v_id uuid; v_ts timestamptz;
  v_n integer := 0;
BEGIN
  -- single-writer guard: overlapping cron fires exit immediately
  IF NOT pg_try_advisory_lock(hashtext('pps-backfill')) THEN
    RETURN -1;
  END IF;

  BEGIN
    SELECT * INTO v_state FROM _pps_backfill_state WHERE id;
    IF v_state.done THEN
      BEGIN
        PERFORM cron.unschedule('pps-backfill');
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
      PERFORM pg_advisory_unlock(hashtext('pps-backfill'));
      RETURN 0;
    END IF;

    FOR v_id, v_ts IN
      SELECT id, created_at FROM hand_history
       WHERE created_at > v_state.last_created AND created_at < v_state.cutoff
       ORDER BY created_at
       LIMIT p_batch
    LOOP
      BEGIN
        PERFORM fn_process_hand_position_stats(v_id);
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
      v_n := v_n + 1;
    END LOOP;

    IF v_n = 0 THEN
      UPDATE _pps_backfill_state SET done = true, updated_at = now() WHERE id;
      BEGIN
        PERFORM cron.unschedule('pps-backfill');
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    ELSE
      UPDATE _pps_backfill_state
         SET last_created = v_ts, processed = processed + v_n, updated_at = now()
       WHERE id;
    END IF;

    PERFORM pg_advisory_unlock(hashtext('pps-backfill'));
    RETURN v_n;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_advisory_unlock(hashtext('pps-backfill'));
    RAISE;
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_pps_backfill_batch(integer) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('pps-backfill', '* * * * *', $$SELECT public.fn_pps_backfill_batch(3000)$$);
