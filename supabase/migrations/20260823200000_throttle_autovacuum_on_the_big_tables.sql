-- 20260823200000_throttle_autovacuum_on_the_big_tables.sql
--
-- Corrects a defect in 20260822230941 that caused a real, brief production
-- incident at 05:35 UTC on 2026-08-23. This one was mine.
--
-- WHAT I DID WRONG
-- That migration set autovacuum_vacuum_cost_delay = 0 and cost_limit = 10000 on
-- hand_history (10 GB), hand_state_snapshots (6.3 GB) and later
-- union_wallet_transactions. cost_delay = 0 means UNTHROTTLED: the worker reads
-- as fast as the disk allows and never sleeps.
--
-- That was the right setting for the FIRST vacuum. hand_history had never been
-- vacuumed in its life and the catch-up had to finish; throttled, it would have
-- taken hours and the outage would have continued. It was the wrong setting to
-- LEAVE IN PLACE, because it applies to every routine vacuum thereafter.
--
-- WHAT HAPPENED
--   autovacuum: VACUUM ANALYZE public.hand_history   9m46s   IO / DataFileRead
--
-- One unthrottled worker on a 10 GB table saturated disk I/O. Every DB-backed
-- request queued behind it: /api/health returned HTTP 000 after 20 s, the
-- Supabase connection pool timed out repeatedly, and hand throughput dropped.
-- Static assets kept serving 200, which is how it was isolated to the database
-- rather than the CDN. It cleared when the vacuum completed.
--
-- THE FIX
-- cost_delay = 2ms with cost_limit = 2000. For scale: the PostgreSQL defaults
-- are 20ms / 200, so this is still roughly 100x more aggressive than stock and
-- keeps up easily with these tables' churn - it simply yields the disk instead
-- of owning it. The eager thresholds from 20260822230941 are unchanged; only
-- the throttle changes.
--
-- THE GENERAL LESSON, worth more than the setting: "make autovacuum aggressive"
-- is two independent knobs. Thresholds decide HOW OFTEN it runs; cost_delay
-- decides HOW HARD it runs while it does. Emergency catch-up wants both maxed.
-- Steady state wants frequent and gentle. Leaving the emergency value in place
-- turns the fix into the next incident.

ALTER TABLE public.hand_history SET (
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_vacuum_cost_limit = 2000
);

ALTER TABLE public.hand_state_snapshots SET (
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_vacuum_cost_limit = 2000
);

ALTER TABLE public.union_wallet_transactions SET (
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_vacuum_cost_limit = 2000
);

-- The small, hot stats tables keep cost_delay = 0 deliberately: they are
-- 2 MB to 47 MB, a full vacuum of them is milliseconds, and they re-bloat within
-- minutes. Unthrottled is correct there and cannot monopolise anything.

DO $assert$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_bad
    FROM pg_class c
   WHERE c.oid IN ('public.hand_history'::regclass,
                   'public.hand_state_snapshots'::regclass,
                   'public.union_wallet_transactions'::regclass)
     AND NOT (array_to_string(c.reloptions, ',') LIKE '%autovacuum_vacuum_cost_delay=2%');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'still unthrottled on: %', v_bad;
  END IF;

  IF NOT (SELECT array_to_string(reloptions, ',') FROM pg_class
           WHERE oid = 'public.hand_history'::regclass) LIKE '%autovacuum_vacuum_threshold=2000%' THEN
    RAISE EXCEPTION 'hand_history lost its eager vacuum threshold';
  END IF;
END $assert$;

-- ROLLBACK (restores the unthrottled setting that caused the 05:35 incident)
--   ALTER TABLE public.hand_history            SET (autovacuum_vacuum_cost_delay = 0, autovacuum_vacuum_cost_limit = 10000);
--   ALTER TABLE public.hand_state_snapshots    SET (autovacuum_vacuum_cost_delay = 0, autovacuum_vacuum_cost_limit = 10000);
--   ALTER TABLE public.union_wallet_transactions SET (autovacuum_vacuum_cost_delay = 0, autovacuum_vacuum_cost_limit = 10000);
