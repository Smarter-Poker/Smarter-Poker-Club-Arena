-- Behaviour of the sealed reader on one history: cost, cache, callers,
-- authority and immutability.
\set ON_ERROR_STOP 1
SELECT public.fixture_generate(0.42, 400)->>'events' AS events;
CREATE TABLE fixture_legacy AS SELECT b, public.fn_union_pnl_inventory_as_of_legacy(b) r FROM public.fixture_boundaries() b;
CREATE FUNCTION public.fixture_stable_reader(p_at timestamptz) RETURNS jsonb LANGUAGE sql STABLE
 AS $$ SELECT public.fn_union_pnl_inventory_as_of(p_at) $$;

-- 1. Before any seal, a boundary is computed once per transaction.
BEGIN;
DO $$ DECLARE n0 bigint; n1 bigint; n2 bigint; v1 jsonb; v2 jsonb; BEGIN
 SELECT COALESCE(seq_tup_read,0)+COALESCE(idx_tup_fetch,0) INTO n0 FROM pg_stat_xact_user_tables WHERE relname='union_pnl_inventory_events';
 v1:=public.fn_union_pnl_inventory_as_of('2026-08-24 07:00+00');
 SELECT COALESCE(seq_tup_read,0)+COALESCE(idx_tup_fetch,0)-n0 INTO n1 FROM pg_stat_xact_user_tables WHERE relname='union_pnl_inventory_events';
 v2:=public.fn_union_pnl_inventory_as_of('2026-08-24 07:00+00');
 SELECT COALESCE(seq_tup_read,0)+COALESCE(idx_tup_fetch,0)-n0 INTO n2 FROM pg_stat_xact_user_tables WHERE relname='union_pnl_inventory_events';
 IF n1=0 OR n2<>n1 OR v1 IS DISTINCT FROM v2 THEN RAISE EXCEPTION 'FAIL the second read in one transaction re-read history (% then %)',n1,n2; END IF;
 RAISE NOTICE 'PASS an unsealed boundary is read once per transaction (% event rows, then 0)',n1;
END $$;
COMMIT;

-- 2. A STABLE caller (fn_union_pnl_close_quality is STABLE) and a read-only
--    transaction still get the exact result.
BEGIN READ ONLY;
DO $$ BEGIN
 IF public.fn_union_pnl_inventory_as_of('2026-08-17 07:00+00') IS DISTINCT FROM (SELECT r FROM fixture_legacy WHERE b='2026-08-17 07:00+00') THEN
  RAISE EXCEPTION 'FAIL read-only transaction'; END IF;
 RAISE NOTICE 'PASS a read-only transaction reads the exact result (no cache)';
END $$;
COMMIT;
DO $$ BEGIN
 IF public.fixture_stable_reader('2026-08-31 07:00+00') IS DISTINCT FROM (SELECT r FROM fixture_legacy WHERE b='2026-08-31 07:00+00') THEN
  RAISE EXCEPTION 'FAIL stable caller'; END IF;
 RAISE NOTICE 'PASS a STABLE caller reads the exact result';
END $$;

-- 3. Only the engine seals.
SET fixture.caller='authenticated';
DO $$ BEGIN
 BEGIN PERFORM public.fn_union_pnl_inventory_checkpoint_seal('2026-08-17 07:00+00');
 EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS a browser caller cannot seal'; RETURN; END;
 RAISE EXCEPTION 'FAIL a browser caller sealed';
END $$;
RESET fixture.caller;
DO $$ BEGIN
 IF has_function_privilege('anon','public.fn_union_pnl_inventory_checkpoint_seal(timestamptz,boolean)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_union_pnl_inventory_checkpoint_due()','EXECUTE')
  OR has_function_privilege('service_role','public.fn_union_pnl_inventory_as_of(timestamptz)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.fn_union_pnl_inventory_checkpoint_due()','EXECUTE')
  OR has_table_privilege('service_role','public.union_pnl_inventory_checkpoint_rows','SELECT') THEN
  RAISE EXCEPTION 'FAIL privileges'; END IF;
 RAISE NOTICE 'PASS privileges: service_role seals, nobody else; the reader stays private';
END $$;

-- 4. Every closed boundary after the capture is sealed once, each from its
--    predecessor; a second pass does nothing.
SELECT jsonb_array_length(public.fn_union_pnl_inventory_checkpoint_due()->'sealed') AS sealed_now;
DO $$ DECLARE v jsonb; BEGIN
 IF (SELECT array_agg(boundary ORDER BY boundary) FROM public.union_pnl_inventory_checkpoints)
    IS DISTINCT FROM (SELECT array_agg(g ORDER BY g) FROM generate_series('2026-08-10 07:00+00'::timestamptz,public.fn_union_week_start(clock_timestamp()),interval '7 days') g
      WHERE g=public.fn_union_week_start(g)) THEN
  RAISE EXCEPTION 'FAIL due() did not seal every closed boundary'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE boundary>'2026-08-10 07:00+00' AND base_boundary IS DISTINCT FROM
   (SELECT max(p.boundary) FROM public.union_pnl_inventory_checkpoints p WHERE p.boundary<c.boundary))
  OR EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints WHERE boundary='2026-08-10 07:00+00' AND base_boundary IS NOT NULL) THEN
  RAISE EXCEPTION 'FAIL a seal did not continue from its predecessor'; END IF;
 v:=public.fn_union_pnl_inventory_checkpoint_seal('2026-08-24 07:00+00');
 IF v->>'status'<>'already_sealed' THEN RAISE EXCEPTION 'FAIL a second seal was not idempotent: %',v; END IF;
 IF (public.fn_union_pnl_inventory_checkpoint_due()->'sealed')<>'[]'::jsonb THEN RAISE EXCEPTION 'FAIL due() resealed'; END IF;
 RAISE NOTICE 'PASS due() seals every closed boundary once, each from its predecessor';
END $$;
SELECT public.fixture_check('after due()');

-- 5. A sealed boundary is read without touching the event history at all.
--    Sequential scans are disabled so the count is plan-independent on this
--    small fixture: any read of history would have to come through an index.
BEGIN;
SET LOCAL enable_seqscan = off;
DO $$ DECLARE n0 bigint; n bigint; BEGIN
 -- Counters are read before and after: unflushed counts of earlier
 -- transactions of this session are not this read's.
 SELECT COALESCE(seq_tup_read,0)+COALESCE(idx_tup_fetch,0) INTO n0 FROM pg_stat_xact_user_tables WHERE relname='union_pnl_inventory_events';
 PERFORM public.fn_union_pnl_inventory_as_of('2026-08-24 07:00+00');
 SELECT COALESCE(seq_tup_read,0)+COALESCE(idx_tup_fetch,0)-n0 INTO n FROM pg_stat_xact_user_tables WHERE relname='union_pnl_inventory_events';
 IF n<>0 THEN RAISE EXCEPTION 'FAIL a sealed boundary read % event rows',n; END IF;
 RAISE NOTICE 'PASS a sealed boundary reads 0 event rows';
END $$;
COMMIT;

-- 6. Checkpoints are immutable.
DO $$ BEGIN
 BEGIN UPDATE public.union_pnl_inventory_checkpoint_rows SET first_operation='INSERT';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
  BEGIN DELETE FROM public.union_pnl_inventory_checkpoints;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN RAISE NOTICE 'PASS checkpoints are immutable'; RETURN; END;
 END;
 RAISE EXCEPTION 'FAIL a checkpoint was changed';
END $$;

-- 7. The stored md5s are the md5s of what is stored.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.rows_md5<>(
   SELECT md5(COALESCE(string_agg(concat_ws('|',r.source_name,r.row_id,r.latest_event_id,r.first_operation,COALESCE(r.after_row::text,'~')),E'\n' ORDER BY r.source_name,r.row_id),''))
   FROM public.union_pnl_inventory_checkpoint_rows r WHERE r.boundary=c.boundary)
  OR c.result_md5<>md5(public.fn_union_pnl_inventory_population(c.boundary,c.boundary)::text)) THEN
  RAISE EXCEPTION 'FAIL a stored checksum does not match its rows'; END IF;
 RAISE NOTICE 'PASS every stored checksum matches its rows and its result';
END $$;
