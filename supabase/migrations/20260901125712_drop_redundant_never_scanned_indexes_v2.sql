-- Applied to production 2026-09-01 as schema_migrations version 20260901125712.
-- Authorised by Dan: "IF WE DON'T NEED THEM REMOVE THEM".
--
-- Drops indexes that are BOTH never-scanned AND structurally redundant.
--
-- v2. The first attempt deadlocked and rolled back whole, dropping nothing:
--   40P01 deadlock detected ... waits for AccessExclusiveLock on relation 124761;
--   blocked by process 1329705 which waits for AccessShareLock on relation 124689
-- That is not a fluke to retry past. DROP INDEX takes ACCESS EXCLUSIVE on the
-- parent table, and a single transaction dropping 130 of them holds every one of
-- those locks until commit, against a platform dealing ~221k hands a day. The
-- first version was one all-or-nothing lock storm.
--
-- This version takes the locks one at a time and refuses to wait:
--   * lock_timeout 3s - if a table is busy, give up on THAT index immediately
--     rather than queueing behind traffic (a queued ACCESS EXCLUSIVE also blocks
--     every reader behind it, which is how a drop turns into an outage);
--   * each index is dropped inside its own PL/pgSQL subtransaction, so a timeout
--     or deadlock on one index is caught, that index is skipped and reported, and
--     the others still land;
--   * the ledger row and the drop share the subtransaction, so a failed drop
--     cannot leave a ledger row claiming an index was removed.
--
-- WHY THESE ARE SAFE TO DROP. Each qualifies on BOTH counts: idx_scan = 0 for the
-- lifetime of the database, AND its key columns are a leading PREFIX of another
-- btree index on the same table (neither partial nor expression-based). So every
-- query that could use the narrow index can use the wider one, and the planner has
-- never once chosen the narrow one. Full reasoning:
-- docs/proposals/2026-09-01-drop-redundant-dead-indexes.md
--
-- idx_scan is trustworthy: stats_reset IS NULL (lifetime counters), and there is
-- no read replica (2 replication slots, both logical/Realtime, 0 physical).
--
-- RESULT: 129 dropped here, 1 skipped as busy (idx_union_clubs_union), 106 MB.
--
-- REVERSIBLE BY CONSTRUCTION:
--   SELECT ddl FROM ca_dropped_index_ledger WHERE index_name = '<name>';

CREATE TABLE IF NOT EXISTS public.ca_dropped_index_ledger (
  id             bigserial PRIMARY KEY,
  index_name     text        NOT NULL,
  table_name     text        NOT NULL,
  ddl            text        NOT NULL,
  size_bytes     bigint      NOT NULL,
  covered_by     text        NOT NULL,
  coverer_scans  bigint      NOT NULL,
  dropped_at     timestamptz NOT NULL DEFAULT now(),
  dropped_by     text        NOT NULL DEFAULT current_user,
  reason         text        NOT NULL
);

COMMENT ON TABLE public.ca_dropped_index_ledger IS
  'Every index dropped by the redundancy census, with the exact DDL to recreate it. '
  'A drop is only safe if it is reversible; this table is what makes it reversible.';

ALTER TABLE public.ca_dropped_index_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_dropped_index_ledger FROM PUBLIC;
GRANT SELECT ON public.ca_dropped_index_ledger TO service_role;

DO $$
DECLARE
  r          record;
  v_dropped  int := 0;
  v_skipped  int := 0;
  v_bytes    bigint := 0;
  v_skips    text := '';
BEGIN
  SET LOCAL lock_timeout = '3s';

  FOR r IN
    WITH idx AS (
      SELECT s.relid, s.relname, s.indexrelname, s.indexrelid, s.idx_scan,
             i.indisunique, i.indisprimary, i.indisexclusion,
             i.indkey::int2[] AS keys, i.indnkeyatts,
             pg_get_expr(i.indpred, i.indrelid) AS pred, am.amname,
             i.indexprs IS NOT NULL AS has_expr,
             pg_relation_size(s.indexrelid) AS sz
      FROM pg_stat_user_indexes s
      JOIN pg_index i  ON i.indexrelid = s.indexrelid
      JOIN pg_class ic ON ic.oid = s.indexrelid
      JOIN pg_am am    ON am.oid = ic.relam
      WHERE s.schemaname = 'public'
    )
    SELECT DISTINCT ON (a.indexrelid)
           a.indexrelname, a.relname, a.sz,
           b.indexrelname AS covered_by, b.idx_scan AS coverer_scans,
           pg_get_indexdef(a.indexrelid) AS ddl
    FROM idx a
    JOIN idx b
      ON a.relid = b.relid
     AND a.indexrelid <> b.indexrelid
     AND a.amname = 'btree' AND b.amname = 'btree'
     AND a.pred IS NULL AND b.pred IS NULL
     AND NOT a.has_expr AND NOT b.has_expr
     AND a.indnkeyatts < b.indnkeyatts
     AND b.keys[0:a.indnkeyatts-1] = a.keys[0:a.indnkeyatts-1]
    WHERE a.idx_scan = 0
      AND NOT a.indisunique AND NOT a.indisprimary AND NOT a.indisexclusion
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = a.indexrelid)
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                       WHERE d.objid = a.indexrelid AND d.deptype = 'i')
    ORDER BY a.indexrelid, b.idx_scan DESC
  LOOP
    BEGIN
      INSERT INTO public.ca_dropped_index_ledger
        (index_name, table_name, ddl, size_bytes, covered_by, coverer_scans, reason)
      VALUES
        (r.indexrelname, r.relname, r.ddl, r.sz, r.covered_by, r.coverer_scans,
         'never scanned in the lifetime of the database, and its key columns are a '
         'leading prefix of ' || r.covered_by || ' which has been scanned '
         || r.coverer_scans || ' times');

      EXECUTE format('DROP INDEX IF EXISTS public.%I', r.indexrelname);

      v_dropped := v_dropped + 1;
      v_bytes   := v_bytes + r.sz;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      v_skipped := v_skipped + 1;
      v_skips   := v_skips || r.indexrelname || ' (' || r.relname || '), ';
    END;
  END LOOP;

  RAISE NOTICE 'redundant index census: dropped %, skipped % (busy), % bytes reclaimed',
    v_dropped, v_skipped, v_bytes;
  IF v_skipped > 0 THEN
    RAISE NOTICE 'skipped because the table was busy, safe to re-run later: %', v_skips;
  END IF;

  IF v_dropped = 0 THEN
    RAISE EXCEPTION 'nothing was dropped - either the census found nothing, or every '
                    'table was locked. Neither is a state to commit silently.';
  END IF;
END $$;

DO $$
DECLARE v_left int; v_ledger int; v_noddl int;
BEGIN
  SELECT count(*) INTO v_left   FROM public.fn_redundant_dead_indexes();
  SELECT count(*) INTO v_ledger FROM public.ca_dropped_index_ledger;
  SELECT count(*) INTO v_noddl  FROM public.ca_dropped_index_ledger
   WHERE ddl IS NULL OR ddl !~ '^CREATE INDEX';

  IF v_ledger = 0 THEN
    RAISE EXCEPTION 'the ledger is empty - drops happened with no way back';
  END IF;
  IF v_noddl <> 0 THEN
    RAISE EXCEPTION '% ledger rows carry no usable CREATE INDEX statement', v_noddl;
  END IF;

  RAISE NOTICE 'verified: ledger holds % recoverable entries, guard still reports % '
               '(any remainder is a busy table to re-run, not a failure)',
               v_ledger, v_left;
END $$;
