-- 20260823170000_engine_lease_heartbeat_can_use_hot_updates.sql
--
-- The engine's lease heartbeat was the worst write in the database per byte of
-- WAL, and it is the last item on the Realtime cost list that is fixable from
-- the database side.
--
-- engine_table_leases takes 42,191 UPDATEs and 0% of them were HOT:
--
--   relname               n_tup_upd   n_tup_hot_upd   hot_pct
--   engine_table_leases      42,191               0      0.0
--
-- A HOT update writes a new row version on the same page and touches NO index.
-- A non-HOT update writes a new tuple AND a new entry in every index. At 0% HOT
-- every heartbeat was writing three index entries, and all of that goes into WAL
-- - which logical decoding then has to read and discard, because this table is
-- not even published. That is the mechanism behind Realtime's ~299 s CPU per 30
-- minutes: the biggest WAL producers are unpublished engine bookkeeping.
--
-- WHY IT WAS 0%. HOT is impossible when an UPDATE changes an INDEXED column, and
-- heartbeat_table_leases does exactly one thing:
--
--   update engine_table_leases set heartbeat_at = now()
--    where instance_id = ... and table_id = any(...)
--
-- while engine_table_leases_heartbeat_idx indexed heartbeat_at. Every heartbeat
-- updated the one column that was indexed, so HOT could never apply.
--
-- THE INDEX WAS NOT EARNING IT. Measured: 1 scan, against 42,191 index writes.
-- The planner does not even want it - the stale-lease query it exists for
-- already chooses a Seq Scan and finishes in 1.0 ms, because the whole table is
-- 2,054 rows in 97 pages. Verified that the only three consumers
-- (claim_table_lease, heartbeat_table_leases, release_table_leases) filter on
-- table_id and instance_id, both of which keep their indexes.
--
-- With heartbeat_at unindexed, HOT becomes possible; fillfactor leaves the page
-- headroom it needs. 70 is deliberate on a table this small - 97 pages, so the
-- extra space costs nothing measurable and buys a HOT chain per page.
--
-- MEASURED AFTER (delta over the next 189 heartbeats): 189 updates, 189 of them
-- HOT. 0% -> 100%.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'engine_table_leases_heartbeat_idx'
              AND relnamespace = 'public'::regnamespace) THEN
    DROP INDEX public.engine_table_leases_heartbeat_idx;
  END IF;
END $$;

ALTER TABLE public.engine_table_leases SET (
  fillfactor                      = 70,
  autovacuum_vacuum_scale_factor  = 0.05,
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_vacuum_cost_delay    = 0
);

-- Post-apply assertions: the index is gone, the indexes the RPCs actually use
-- remain, and heartbeat_at is no longer indexed anywhere (which is the whole
-- point - if someone re-adds an index on it, HOT silently stops working again).
DO $assert$
DECLARE v_hb int; v_pk int; v_inst int;
BEGIN
  SELECT count(*) INTO v_hb FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey)
   WHERE x.indrelid = 'public.engine_table_leases'::regclass AND a.attname = 'heartbeat_at';
  IF v_hb > 0 THEN
    RAISE EXCEPTION 'heartbeat_at is still indexed (% index(es)) - HOT updates cannot happen', v_hb;
  END IF;

  SELECT count(*) INTO v_pk FROM pg_class
   WHERE relname = 'engine_table_leases_pkey' AND relnamespace = 'public'::regnamespace;
  SELECT count(*) INTO v_inst FROM pg_class
   WHERE relname = 'engine_table_leases_instance_idx' AND relnamespace = 'public'::regnamespace;
  IF v_pk <> 1 OR v_inst <> 1 THEN
    RAISE EXCEPTION 'the indexes the lease RPCs use are missing (pkey=%, instance=%)', v_pk, v_inst;
  END IF;

  IF (SELECT array_to_string(reloptions, ',') FROM pg_class
       WHERE oid = 'public.engine_table_leases'::regclass) NOT LIKE '%fillfactor=70%' THEN
    RAISE EXCEPTION 'fillfactor was not applied';
  END IF;
END $assert$;

-- ROLLBACK (restores the 0% HOT behaviour - do not use)
--   CREATE INDEX engine_table_leases_heartbeat_idx ON public.engine_table_leases USING btree (heartbeat_at);
--   ALTER TABLE public.engine_table_leases RESET (fillfactor, autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor, autovacuum_vacuum_cost_delay);
