CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_as_of(p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE origin public.union_pnl_inventory_capture%ROWTYPE; book timestamptz; v_base timestamptz; v_projection jsonb; v_result jsonb;
BEGIN
 SELECT * INTO origin FROM public.union_pnl_inventory_capture WHERE singleton;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','inventory_capture_missing'); END IF;
 IF p_at IS NULL OR NOT isfinite(p_at) OR p_at<>public.fn_union_week_start(p_at) OR p_at>clock_timestamp() THEN
  RETURN jsonb_build_object('status','blocked','reason','closed_original_week_boundary_required'); END IF;
 IF p_at<=origin.captured_at THEN RETURN jsonb_build_object('status','blocked','reason','boundary_precedes_original_inventory_capture','capture_started_at',origin.captured_at); END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RETURN jsonb_build_object('status','blocked','reason','inventory_requires_fresh_read_committed_snapshot'); END IF;
 book:=public.fn_union_week_start(origin.captured_at);
 WHILE book<p_at LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  book:=public.fn_union_week_start(book+interval '8 days');
 END LOOP;
 -- Every writer that could precede p_at has committed (the locks above), so
 -- the result is final: one transaction computes it once.
 IF to_regclass('pg_temp.union_pnl_inventory_as_of_cache') IS NOT NULL THEN
  EXECUTE 'SELECT result FROM pg_temp.union_pnl_inventory_as_of_cache WHERE boundary=$1' INTO v_result USING p_at;
  IF v_result IS NOT NULL THEN RETURN v_result; END IF;
 END IF;
 -- VOLATILE intentionally obtains a fresh snapshot after the old-book writers
 -- have committed. A stable/snapshot reader could omit those committed events.
 SELECT c.boundary INTO v_base FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary<=p_at ORDER BY c.boundary DESC LIMIT 1;
 v_projection:=public.fn_union_pnl_inventory_population(v_base,p_at);
 v_result:=jsonb_build_object('status',CASE WHEN v_projection->'issues'='[]'::jsonb THEN 'observed' ELSE 'blocked' END,
  'inventory_version',1,'capture_started_at',origin.captured_at,'boundary',p_at,'population',v_projection->'population','issues',v_projection->'issues',
  'current_state_used',false,'financial_basis_certified',false,
  'coverage','Original active population and later captured transitions; monetary funding and obligation receipts must independently certify equity.');
 BEGIN
  IF to_regclass('pg_temp.union_pnl_inventory_as_of_cache') IS NULL THEN
   EXECUTE 'CREATE TEMP TABLE union_pnl_inventory_as_of_cache(boundary timestamptz PRIMARY KEY, result jsonb NOT NULL) ON COMMIT DROP';
  END IF;
  EXECUTE 'INSERT INTO pg_temp.union_pnl_inventory_as_of_cache(boundary,result) VALUES($1,$2) ON CONFLICT (boundary) DO NOTHING' USING p_at,v_result;
 EXCEPTION WHEN read_only_sql_transaction THEN NULL;
 END;
 RETURN v_result;
END $function$

