-- Applied to production 2026-09-01 as schema_migrations version 20260901130030.
--
-- Correcting my own migration, and finishing the census.
--
-- 1. THE GRANT I GOT WRONG. 20260901125712 wrote
--    REVOKE ALL ON public.ca_dropped_index_ledger FROM PUBLIC and then granted
--    SELECT to service_role, and I asserted nothing about the result. Checked
--    afterwards: has_table_privilege('anon', ..., 'SELECT') was still TRUE.
--
--    REVOKE ... FROM PUBLIC removes the grant held by the PUBLIC pseudo-role. It
--    does not touch grants held DIRECTLY by anon and authenticated, and Supabase's
--    ALTER DEFAULT PRIVILEGES hands those out on every new table in public. This is
--    the table-shaped twin of the Phase 3 function finding, and I walked straight
--    into it while writing the migration that cites that law.
--
--    No rows were exposed - RLS is enabled on the table and it has no policies, so
--    anon reads zero rows regardless. But the grant is wrong, and "RLS happened to
--    save it" is not the standard. Closed explicitly below, and this time asserted.
--
-- 2. THE LAST INDEX. idx_union_clubs_union was skipped twice because union_clubs is
--    busy (it is consulted on union attribution). It is 16 kB and never scanned,
--    and union_id is the leading column of union_clubs_union_id_club_id_key which
--    has 13,131 scans. It landed on this run: census complete at 130 of 130.

REVOKE ALL ON public.ca_dropped_index_ledger FROM PUBLIC;
REVOKE ALL ON public.ca_dropped_index_ledger FROM anon;
REVOKE ALL ON public.ca_dropped_index_ledger FROM authenticated;
GRANT SELECT ON public.ca_dropped_index_ledger TO service_role;

-- the sequence behind bigserial is grantable too, and gets the same default
REVOKE ALL ON SEQUENCE public.ca_dropped_index_ledger_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.ca_dropped_index_ledger_id_seq FROM anon;
REVOKE ALL ON SEQUENCE public.ca_dropped_index_ledger_id_seq FROM authenticated;

DO $$
DECLARE r record; v_done int := 0;
BEGIN
  SET LOCAL lock_timeout = '3s';
  FOR r IN
    SELECT s.indexrelname, s.relname, pg_relation_size(s.indexrelid) AS sz,
           pg_get_indexdef(s.indexrelid) AS ddl
    FROM pg_stat_user_indexes s
    WHERE s.schemaname='public' AND s.indexrelname='idx_union_clubs_union' AND s.idx_scan=0
  LOOP
    BEGIN
      INSERT INTO public.ca_dropped_index_ledger
        (index_name, table_name, ddl, size_bytes, covered_by, coverer_scans, reason)
      VALUES (r.indexrelname, r.relname, r.ddl, r.sz,
              'union_clubs_union_id_club_id_key', 13131,
              'never scanned; union_id leads union_clubs_union_id_club_id_key '
              '(13,131 scans). Skipped twice by the census because union_clubs was busy.');
      EXECUTE format('DROP INDEX IF EXISTS public.%I', r.indexrelname);
      v_done := v_done + 1;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      RAISE NOTICE 'union_clubs busy again; % left in place. Harmless, re-runnable.',
        r.indexrelname;
    END;
  END LOOP;
  RAISE NOTICE 'dropped % remaining index(es)', v_done;
END $$;

-- Assert the thing I failed to assert last time.
DO $$
DECLARE v_anon boolean; v_auth boolean; v_svc boolean; v_ledger int; v_left int;
BEGIN
  SELECT has_table_privilege('anon',          'public.ca_dropped_index_ledger', 'SELECT'),
         has_table_privilege('authenticated', 'public.ca_dropped_index_ledger', 'SELECT'),
         has_table_privilege('service_role',  'public.ca_dropped_index_ledger', 'SELECT')
    INTO v_anon, v_auth, v_svc;

  IF v_anon OR v_auth THEN
    RAISE EXCEPTION 'ca_dropped_index_ledger is still browser-readable (anon=%, authenticated=%)',
      v_anon, v_auth;
  END IF;
  IF NOT v_svc THEN
    RAISE EXCEPTION 'service_role cannot read ca_dropped_index_ledger; the rollback path is gone';
  END IF;

  SELECT count(*) INTO v_ledger FROM public.ca_dropped_index_ledger;
  SELECT count(*) INTO v_left   FROM public.fn_redundant_dead_indexes();
  RAISE NOTICE 'ledger % recoverable entries; guard reports % remaining', v_ledger, v_left;
END $$;
