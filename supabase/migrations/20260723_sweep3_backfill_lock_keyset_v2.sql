-- ═════════════════════════════════════════════════════════════════════════════
-- CA sweep #3 — position-stats backfill hardening (applied to production
-- 2026-07-23 as ca_sweep3_backfill_lock_and_clean_rerun + ca_sweep3_backfill_keyset_v2).
--
-- Post-deploy verification found two defects in the first backfill runner:
--   1. No concurrency guard — pg_cron could overlap slow batches.
--   2. Pagination on created_at alone — not tie-safe with bulk-imported rows
--      sharing timestamps.
-- Also discovered: hand_history holds 5M+ rows (planner estimate of ~73k was
-- stale), and hands before 2026-03-14 use an old action format with no preflop
-- userIds (cannot yield position stats). Parseability afterwards is
-- era-dependent (e.g. Mar 27 parseable, Apr 5 not), so the crawl processes
-- everything from 2026-03-14; unparseable hands early-return cheaply.
--
-- Remedy applied in production:
--   * TRUNCATE player_position_stats + clean re-run (trigger/backfill boundary
--     moved to the reset time, stored in _pps_backfill_state.cutoff, so every
--     hand is counted exactly once)
--   * advisory lock (single writer)
--   * keyset pagination on (created_at, id)
--   * 10k-hand batches, every minute, self-unschedules on completion
CREATE TABLE IF NOT EXISTS public._pps_backfill_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_created timestamptz NOT NULL DEFAULT '-infinity',
  processed integer NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  cutoff timestamptz,
  last_id uuid
);

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
