CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_seal_advance(p_at timestamp with time zone, p_verify boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- Seals a closed week's original inventory six hours at a time (see the
-- migration header); returns status 'sealing' while layers remain.
DECLARE origin public.union_pnl_inventory_capture%ROWTYPE; book timestamptz; v_base timestamptz; v_prior public.union_pnl_inventory_checkpoints%ROWTYPE;
 g record; began timestamptz:=clock_timestamp(); t0 timestamptz; done_any boolean:=false; n_layers int; n_done int;
 v_rows bigint; v_issues bigint; v_rows_md5 text; v_issues_md5 text; v_max bigint; v_projection jsonb; v_ms bigint; v_lr bigint; v_li bigint;
BEGIN
 SELECT * INTO origin FROM public.union_pnl_inventory_capture WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'inventory_capture_missing' USING ERRCODE='55000'; END IF;
 IF p_at IS NULL OR NOT isfinite(p_at) OR p_at<>public.fn_union_week_start(p_at) OR p_at>clock_timestamp() OR p_at<=origin.captured_at THEN
  RAISE EXCEPTION 'closed_original_week_boundary_required' USING ERRCODE='22023'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'inventory_requires_fresh_read_committed_snapshot' USING ERRCODE='25000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory-checkpoint',0));
 SELECT * INTO v_prior FROM public.union_pnl_inventory_checkpoints WHERE boundary=p_at;
 IF FOUND AND NOT p_verify THEN
  RETURN jsonb_build_object('status','already_sealed','boundary',p_at,'base_boundary',v_prior.base_boundary,'row_count',v_prior.row_count,
   'issue_count',v_prior.issue_count,'rows_md5',v_prior.rows_md5,'result_md5',v_prior.result_md5,'legacy_verified',v_prior.legacy_verified);
 END IF;
 IF p_verify AND NOT FOUND THEN RAISE EXCEPTION 'inventory_verify_needs_a_sealed_week' USING ERRCODE='22023'; END IF;
 book:=public.fn_union_week_start(origin.captured_at);
 WHILE book<p_at LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  book:=public.fn_union_week_start(book+interval '8 days');
 END LOOP;
 SELECT c.boundary INTO v_base FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary<p_at ORDER BY c.boundary DESC LIMIT 1;
 -- A week with no base seals in one go, as before.
 IF v_base IS NULL THEN
  IF p_verify THEN RAISE EXCEPTION 'inventory_verify_needs_a_base' USING ERRCODE='22023'; END IF;
  RETURN public.fn_union_pnl_inventory_checkpoint_seal(p_at,false);
 END IF;
 -- Staging holds one week at a time; layers made for another base are stale.
 IF NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at)
  OR EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at AND l.base_boundary IS DISTINCT FROM v_base) THEN
  TRUNCATE public.union_pnl_inventory_seal_layers, public.union_pnl_inventory_seal_layer_rows, public.union_pnl_inventory_seal_layer_issues;
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _inv_layer(o_kind text,o_source_name text,o_row_id uuid,o_event_id bigint,o_first_operation text,o_after_row jsonb) ON COMMIT DROP;
 SELECT count(*) INTO n_layers FROM generate_series(v_base,p_at-interval '1 microsecond',interval '6 hours') s;
 FOR g IN SELECT s AS layer_start,LEAST(s+interval '6 hours',p_at) AS layer_end
   FROM generate_series(v_base,p_at-interval '1 microsecond',interval '6 hours') s ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at AND l.layer_end=g.layer_end);
  IF done_any AND clock_timestamp()>began+interval '90 seconds' THEN
   SELECT count(*) INTO n_done FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at;
   RETURN jsonb_build_object('status','sealing','boundary',p_at,'base_boundary',v_base,'layers',n_layers,'layers_done',n_done);
  END IF;
  t0:=clock_timestamp();
  TRUNCATE pg_temp._inv_layer;
  INSERT INTO pg_temp._inv_layer SELECT * FROM public.fn_union_pnl_inventory_layer_state(v_base,p_at,g.layer_start,g.layer_end);
  INSERT INTO public.union_pnl_inventory_seal_layer_rows(boundary,source_name,row_id,layer_end,latest_event_id,first_operation,after_row)
   SELECT p_at,o_source_name,o_row_id,g.layer_end,o_event_id,o_first_operation,o_after_row FROM pg_temp._inv_layer WHERE o_kind='row';
  GET DIAGNOSTICS v_lr=ROW_COUNT;
  INSERT INTO public.union_pnl_inventory_seal_layer_issues(boundary,source_name,row_id,layer_end,event_id)
   SELECT p_at,o_source_name,o_row_id,g.layer_end,o_event_id FROM pg_temp._inv_layer WHERE o_kind='issue';
  GET DIAGNOSTICS v_li=ROW_COUNT;
  INSERT INTO public.union_pnl_inventory_seal_layers(boundary,layer_end,layer_start,base_boundary,row_count,issue_count,layer_ms)
  VALUES(p_at,g.layer_end,g.layer_start,v_base,v_lr,v_li,(extract(epoch FROM clock_timestamp()-t0)*1000)::bigint);
  done_any:=true;
 END LOOP;
 IF done_any AND clock_timestamp()>began+interval '60 seconds' THEN
  RETURN jsonb_build_object('status','sealing','boundary',p_at,'base_boundary',v_base,'layers',n_layers,'layers_done',n_layers);
 END IF;
 -- The week: base rows no layer touched, and each touched row as of its
 -- latest layer; issues likewise.
 IF to_regclass('pg_temp.union_pnl_inventory_seal') IS NOT NULL THEN EXECUTE 'DROP TABLE pg_temp.union_pnl_inventory_seal'; END IF;
 CREATE TEMP TABLE union_pnl_inventory_seal ON COMMIT DROP AS
  WITH lt AS MATERIALIZED (SELECT DISTINCT ON (l.source_name,l.row_id) l.source_name sn,l.row_id rid,l.layer_end,l.latest_event_id eid,l.first_operation fop,l.after_row
    FROM public.union_pnl_inventory_seal_layer_rows l WHERE l.boundary=p_at ORDER BY l.source_name,l.row_id,l.layer_end DESC)
  SELECT 'row'::text o_kind,lt.sn o_source_name,lt.rid o_row_id,lt.eid o_event_id,lt.fop o_first_operation,lt.after_row o_after_row FROM lt
  UNION ALL
  SELECT 'row',r.source_name,r.row_id,r.latest_event_id,r.first_operation,r.after_row FROM public.union_pnl_inventory_checkpoint_rows r
   WHERE r.boundary=v_base AND NOT EXISTS(SELECT 1 FROM lt WHERE lt.sn=r.source_name AND lt.rid=r.row_id)
  UNION ALL
  SELECT 'issue',li.source_name,li.row_id,li.event_id,NULL::text,NULL::jsonb FROM lt JOIN public.union_pnl_inventory_seal_layer_issues li
   ON li.boundary=p_at AND li.layer_end=lt.layer_end AND li.source_name=lt.sn AND li.row_id=lt.rid
  UNION ALL
  SELECT 'issue',ci.source_name,ci.row_id,ci.event_id,NULL,NULL FROM public.union_pnl_inventory_checkpoint_issues ci
   WHERE ci.boundary=v_base AND NOT EXISTS(SELECT 1 FROM lt WHERE lt.sn=ci.source_name AND lt.rid=ci.row_id);
 -- From here on, exactly fn_union_pnl_inventory_checkpoint_seal.
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
 -- Weeks up to 2026-10-05 were sealed whole; a verify of one recomputes that hash.
 IF p_verify AND p_at<='2026-10-05 07:00:00+00'::timestamptz THEN
  EXECUTE $q$SELECT md5(COALESCE(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id,o_first_operation,COALESCE(o_after_row::text,'~')),E'\n'
    ORDER BY o_source_name,o_row_id),'')) FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='row'$q$ INTO v_rows_md5;
 ELSE
  EXECUTE $q$SELECT md5(COALESCE(string_agg(x.h,E'\n' ORDER BY x.sn,x.b),'')) FROM (SELECT o_source_name sn,left(o_row_id::text,2) b,
    md5(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id,o_first_operation,COALESCE(o_after_row::text,'~')),E'\n'
     ORDER BY o_source_name,o_row_id)) h
    FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='row' GROUP BY 1,2) x$q$ INTO v_rows_md5;
 END IF;
 IF p_verify THEN
  EXECUTE 'DROP TABLE pg_temp.union_pnl_inventory_seal';
  RETURN jsonb_build_object('status',CASE WHEN v_rows=v_prior.row_count AND v_issues=v_prior.issue_count AND v_rows_md5=v_prior.rows_md5
     AND v_issues_md5=v_prior.issues_md5 AND v_max IS NOT DISTINCT FROM v_prior.max_event_id THEN 'verified' ELSE 'differs' END,
   'boundary',p_at,'base_boundary',v_base,'layers',n_layers,'row_count',v_rows,'issue_count',v_issues,'rows_md5',v_rows_md5,'issues_md5',v_issues_md5,'max_event_id',v_max,
   'sealed',jsonb_build_object('row_count',v_prior.row_count,'issue_count',v_prior.issue_count,'rows_md5',v_prior.rows_md5,'issues_md5',v_prior.issues_md5,'max_event_id',v_prior.max_event_id));
 END IF;
 EXECUTE $q$INSERT INTO public.union_pnl_inventory_checkpoint_rows(boundary,source_name,row_id,latest_event_id,first_operation,after_row)
  SELECT $1,o_source_name,o_row_id,o_event_id,o_first_operation,o_after_row FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='row'$q$ USING p_at;
 EXECUTE $q$INSERT INTO public.union_pnl_inventory_checkpoint_issues(boundary,source_name,row_id,event_id)
  SELECT $1,o_source_name,o_row_id,o_event_id FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='issue'$q$ USING p_at;
 EXECUTE 'DROP TABLE pg_temp.union_pnl_inventory_seal';
 v_projection:=public.fn_union_pnl_inventory_population(p_at,p_at);
 SELECT COALESCE(sum(l.layer_ms),0)+(extract(epoch FROM clock_timestamp()-began)*1000)::bigint INTO v_ms FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at;
 INSERT INTO public.union_pnl_inventory_checkpoints(boundary,base_boundary,max_event_id,row_count,issue_count,rows_md5,issues_md5,result_md5,legacy_verified,seal_ms)
 VALUES(p_at,v_base,v_max,v_rows,v_issues,v_rows_md5,v_issues_md5,md5(v_projection::text),false,v_ms);
 RETURN jsonb_build_object('status','sealed','boundary',p_at,'base_boundary',v_base,'max_event_id',v_max,'row_count',v_rows,'issue_count',v_issues,
  'rows_md5',v_rows_md5,'result_md5',md5(v_projection::text),'legacy_verified',false,'layers',n_layers,
  'result_issues',jsonb_array_length(v_projection->'issues'),'seal_ms',v_ms);
END $function$
;

