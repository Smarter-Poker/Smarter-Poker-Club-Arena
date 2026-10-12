CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_checkpoint_seal(p_at timestamp with time zone, p_verify_legacy boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE origin public.union_pnl_inventory_capture%ROWTYPE; book timestamptz; v_base timestamptz;
 v_prior public.union_pnl_inventory_checkpoints%ROWTYPE; v_rows bigint; v_issues bigint; v_rows_md5 text; v_issues_md5 text;
 v_max bigint; v_projection jsonb; v_legacy jsonb; v_started timestamptz:=clock_timestamp(); v_ms bigint;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO origin FROM public.union_pnl_inventory_capture WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'inventory_capture_missing' USING ERRCODE='55000'; END IF;
 IF p_at IS NULL OR NOT isfinite(p_at) OR p_at<>public.fn_union_week_start(p_at) OR p_at>clock_timestamp() OR p_at<=origin.captured_at THEN
  RAISE EXCEPTION 'closed_original_week_boundary_required' USING ERRCODE='22023'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'inventory_requires_fresh_read_committed_snapshot' USING ERRCODE='25000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory-checkpoint',0));
 SELECT * INTO v_prior FROM public.union_pnl_inventory_checkpoints WHERE boundary=p_at;
 IF FOUND THEN
  RETURN jsonb_build_object('status','already_sealed','boundary',p_at,'base_boundary',v_prior.base_boundary,'row_count',v_prior.row_count,
   'issue_count',v_prior.issue_count,'rows_md5',v_prior.rows_md5,'result_md5',v_prior.result_md5,'legacy_verified',v_prior.legacy_verified);
 END IF;
 book:=public.fn_union_week_start(origin.captured_at);
 WHILE book<p_at LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  book:=public.fn_union_week_start(book+interval '8 days');
 END LOOP;
 SELECT c.boundary INTO v_base FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary<p_at ORDER BY c.boundary DESC LIMIT 1;
 IF to_regclass('pg_temp.union_pnl_inventory_seal') IS NOT NULL THEN EXECUTE 'DROP TABLE pg_temp.union_pnl_inventory_seal'; END IF;
 EXECUTE 'CREATE TEMP TABLE union_pnl_inventory_seal ON COMMIT DROP AS SELECT * FROM public.fn_union_pnl_inventory_state($1,$2)' USING v_base,p_at;
 EXECUTE $q$SELECT count(*) FILTER(WHERE o_kind='row'),count(*) FILTER(WHERE o_kind='issue'),
   NULL::text,
   md5(COALESCE(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id),E'\n'
    ORDER BY o_source_name,o_row_id,o_event_id) FILTER(WHERE o_kind='issue'),'')),
   max(o_event_id) FILTER(WHERE o_kind='row')
  FROM pg_temp.union_pnl_inventory_seal$q$ INTO v_rows,v_issues,v_rows_md5,v_issues_md5,v_max;
 -- THE ROWS HASH IS TAKEN BUCKET BY BUCKET (2026-10-12): one string of every
 -- row passed the 1 GB limit of a value at ~3M rows (54000). Each bucket (one
 -- source, the first two hex digits of row_id) is hashed in row order, and the
 -- bucket hashes are hashed in the same order.
  EXECUTE $q$SELECT md5(COALESCE(string_agg(x.h,E'\n' ORDER BY x.sn,x.b),'')) FROM (SELECT o_source_name sn,left(o_row_id::text,2) b,
    md5(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id,o_first_operation,COALESCE(o_after_row::text,'~')),E'\n'
     ORDER BY o_source_name,o_row_id)) h
    FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='row' GROUP BY 1,2) x$q$ INTO v_rows_md5;
 EXECUTE $q$INSERT INTO public.union_pnl_inventory_checkpoint_rows(boundary,source_name,row_id,latest_event_id,first_operation,after_row)
  SELECT $1,o_source_name,o_row_id,o_event_id,o_first_operation,o_after_row FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='row'$q$ USING p_at;
 EXECUTE $q$INSERT INTO public.union_pnl_inventory_checkpoint_issues(boundary,source_name,row_id,event_id)
  SELECT $1,o_source_name,o_row_id,o_event_id FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='issue'$q$ USING p_at;
 EXECUTE 'DROP TABLE pg_temp.union_pnl_inventory_seal';
 -- Read the result back from the rows just written, exactly as a later reader will.
 v_projection:=public.fn_union_pnl_inventory_population(p_at,p_at);
 IF p_verify_legacy THEN
  v_legacy:=public.fn_union_pnl_inventory_as_of_legacy(p_at);
  IF v_legacy->'population' IS DISTINCT FROM v_projection->'population' OR v_legacy->'issues' IS DISTINCT FROM v_projection->'issues' THEN
   RAISE EXCEPTION 'inventory_checkpoint_disagrees_with_legacy_reader' USING ERRCODE='55000',
    DETAIL=jsonb_build_object('boundary',p_at,'legacy_md5',md5(jsonb_build_object('population',v_legacy->'population','issues',v_legacy->'issues')::text),
     'checkpoint_md5',md5(v_projection::text))::text;
  END IF;
 END IF;
 v_ms:=(extract(epoch FROM clock_timestamp()-v_started)*1000)::bigint;
 INSERT INTO public.union_pnl_inventory_checkpoints(boundary,base_boundary,max_event_id,row_count,issue_count,rows_md5,issues_md5,result_md5,legacy_verified,seal_ms)
 VALUES(p_at,v_base,v_max,v_rows,v_issues,v_rows_md5,v_issues_md5,md5(v_projection::text),p_verify_legacy IS TRUE,v_ms);
 RETURN jsonb_build_object('status','sealed','boundary',p_at,'base_boundary',v_base,'max_event_id',v_max,'row_count',v_rows,'issue_count',v_issues,
  'rows_md5',v_rows_md5,'result_md5',md5(v_projection::text),'legacy_verified',p_verify_legacy IS TRUE,
  'result_issues',jsonb_array_length(v_projection->'issues'),'seal_ms',v_ms);
END $function$
;

