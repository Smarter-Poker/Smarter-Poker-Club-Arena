-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260723185921 "ca_sweep3_backfill_keyset_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 13010b12281826e4ee6670c9a77e0859 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Backfill v2: hand_history turned out to hold 5M+ rows (planner estimate of
-- 73k was stale). Hands before 2026-03-14 use the old action format with no
-- preflop userIds (verified by sampling) and cannot yield position stats, so
-- the backfill starts at 2026-03-14. Pagination is now keyset on
-- (created_at, id) — tie-safe — and batches are 10k/min under an advisory
-- lock. At observed parse speed this completes in roughly 8-12 hours and
-- unschedules itself.

SELECT cron.unschedule('pps-backfill');

ALTER TABLE public._pps_backfill_state ADD COLUMN IF NOT EXISTS last_id uuid;

UPDATE public._pps_backfill_state
   SET last_created = '2026-03-14 00:00:00+00',
       last_id = '00000000-0000-0000-0000-000000000000',
       processed = 0, done = false, updated_at = now()
 WHERE id;

CREATE OR REPLACE FUNCTION public.fn_pps_backfill_batch(p_batch integer DEFAULT 10000)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_state record;
  v_id uuid; v_ts timestamptz;
  v_n integer := 0;
BEGIN
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
       WHERE (created_at, id) > (v_state.last_created, v_state.last_id)
         AND created_at < v_state.cutoff
       ORDER BY created_at, id
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
         SET last_created = v_ts, last_id = v_id, processed = processed + v_n, updated_at = now()
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

SELECT cron.schedule('pps-backfill', '* * * * *', $$SELECT public.fn_pps_backfill_batch(10000)$$);
