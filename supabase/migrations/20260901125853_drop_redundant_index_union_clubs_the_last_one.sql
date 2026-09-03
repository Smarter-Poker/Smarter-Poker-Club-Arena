-- Applied to production 2026-09-01 as schema_migrations version 20260901125853.
--
-- The one index the census skipped, because union_clubs was busy at the time.
--
-- idx_union_clubs_union (union_id) has never been scanned. union_clubs_union_id_club_id_key
-- (union_id, club_id) has been scanned 13,131 times and has union_id as its leading
-- column, so it serves every lookup the dropped index could have served. The table
-- being busy is exactly why the first pass skipped it rather than queueing an
-- ACCESS EXCLUSIVE lock behind live traffic.
--
-- Same protections as the main census: 3s lock_timeout, ledgered before the drop,
-- and a skip rather than an abort if the table is busy again. It was busy again on
-- this run too; the drop finally landed in 20260901130030.
--
-- ROLLBACK: SELECT ddl FROM ca_dropped_index_ledger WHERE index_name = 'idx_union_clubs_union';

DO $$
DECLARE r record; v_done int := 0;
BEGIN
  SET LOCAL lock_timeout = '3s';

  FOR r IN
    SELECT s.indexrelname, s.relname, pg_relation_size(s.indexrelid) AS sz,
           pg_get_indexdef(s.indexrelid) AS ddl
    FROM pg_stat_user_indexes s
    WHERE s.schemaname = 'public' AND s.indexrelname = 'idx_union_clubs_union'
      AND s.idx_scan = 0
  LOOP
    BEGIN
      INSERT INTO public.ca_dropped_index_ledger
        (index_name, table_name, ddl, size_bytes, covered_by, coverer_scans, reason)
      VALUES (r.indexrelname, r.relname, r.ddl, r.sz,
              'union_clubs_union_id_club_id_key', 13131,
              'never scanned; union_id is the leading column of '
              'union_clubs_union_id_club_id_key, which has 13,131 scans. Skipped by '
              'the main census because the table was busy.');
      EXECUTE format('DROP INDEX IF EXISTS public.%I', r.indexrelname);
      v_done := v_done + 1;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      RAISE NOTICE 'union_clubs still busy; % left in place, safe to re-run', r.indexrelname;
    END;
  END LOOP;

  RAISE NOTICE 'dropped % index(es)', v_done;
END $$;

DO $$
DECLARE v_left int; v_ledger int;
BEGIN
  SELECT count(*) INTO v_left   FROM public.fn_redundant_dead_indexes();
  SELECT count(*) INTO v_ledger FROM public.ca_dropped_index_ledger;
  RAISE NOTICE 'guard reports % remaining; ledger holds % recoverable entries',
    v_left, v_ledger;
END $$;
