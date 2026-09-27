-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260723182257 "ca_sweep3_position_stats_backfill_cron"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 513bca90f1161b962c0ec90bccd359fb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Batched, self-terminating backfill for player_position_stats via pg_cron.
CREATE TABLE IF NOT EXISTS public._pps_backfill_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_created timestamptz NOT NULL DEFAULT '-infinity',
  processed integer NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public._pps_backfill_state (id) VALUES (true) ON CONFLICT DO NOTHING;
ALTER TABLE public._pps_backfill_state ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_pps_backfill_batch(p_batch integer DEFAULT 3000)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_state record;
  v_id uuid; v_ts timestamptz;
  v_n integer := 0;
  v_cutoff timestamptz;
BEGIN
  SELECT * INTO v_state FROM _pps_backfill_state WHERE id;
  IF v_state.done THEN
    PERFORM cron.unschedule('pps-backfill') ;
    RETURN 0;
  END IF;

  -- only backfill hands created BEFORE the trigger went live (trigger handles the rest)
  v_cutoff := '2026-07-23 19:00:00+00';

  FOR v_id, v_ts IN
    SELECT id, created_at FROM hand_history
     WHERE created_at > v_state.last_created AND created_at < v_cutoff
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
  RETURN v_n;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_pps_backfill_batch(integer) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('pps-backfill', '* * * * *', $$SELECT public.fn_pps_backfill_batch(3000)$$);
