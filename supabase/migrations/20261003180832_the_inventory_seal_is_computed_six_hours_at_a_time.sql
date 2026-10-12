-- 20261003180832_the_inventory_seal_is_computed_six_hours_at_a_time.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE INVENTORY SEAL IS COMPUTED SIX HOURS AT A TIME
--
-- fn_union_pnl_inventory_checkpoint_seal seals a closed week's original
-- inventory in one transaction: fn_union_pnl_inventory_state(base, boundary)
-- reads every inventory event of the week and checks each row's event chain.
-- The week of 2026-09-21 (~8.5M events) took 534 s; the week closing
-- 2026-10-05 had 13.2M events by 2026-10-03 07:00, ~19M projected - about
-- 20 minutes in one transaction, past the 5-minute cap on every close
-- transaction (transactions over ~9 minutes during play expire tournament
-- leases).
--
-- THIS MIGRATION ADDS THE SPLIT SEAL; it is not wired into the close yet
-- (a later migration does that, once this one is proved on a sealed week):
--  1. fn_union_pnl_inventory_layer_state(base, boundary, from, to) is
--     fn_union_pnl_inventory_state for the events of [from, to) only, over
--     the snapshot at `from`: the base checkpoint's rows, superseded by the
--     latest layer that already covered a row. It returns the rows the layer
--     touched, each with its complete issue set (the row's earlier issues
--     unless the row's whole history is re-read, plus the layer's chain
--     breaks), exactly as fn_union_pnl_inventory_state treats a base.
--  2. fn_union_pnl_inventory_seal_advance(boundary, verify) computes the
--     week's six-hour layers in order into unlogged staging tables (at least
--     one layer per call, none started 120 s after the call began), then
--     assembles the week - base rows a layer never touched plus each touched
--     row's latest layer - and seals it exactly as
--     fn_union_pnl_inventory_checkpoint_seal does (same counts, md5s, rows,
--     issues, read-back and header). With verify, for a week already sealed,
--     it seals nothing and compares the assembled rows and issues with the
--     sealed checkpoint's row_count, issue_count, rows_md5, issues_md5 and
--     max_event_id.
-- The staging tables are a cache: a crash empties all three together and the
-- next call starts the week again.
--
-- @live-proof: to_regprocedure('public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean)') IS NOT NULL
-- @live-proof: to_regclass('public.union_pnl_inventory_seal_layer_rows') IS NOT NULL
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

CREATE UNLOGGED TABLE public.union_pnl_inventory_seal_layers (
  boundary timestamptz NOT NULL,
  layer_end timestamptz NOT NULL,
  layer_start timestamptz NOT NULL,
  base_boundary timestamptz,
  row_count bigint NOT NULL,
  issue_count bigint NOT NULL,
  layer_ms bigint NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (boundary, layer_end),
  CHECK (layer_start < layer_end)
);
CREATE UNLOGGED TABLE public.union_pnl_inventory_seal_layer_rows (
  boundary timestamptz NOT NULL,
  source_name text NOT NULL,
  row_id uuid NOT NULL,
  layer_end timestamptz NOT NULL,
  latest_event_id bigint NOT NULL,
  first_operation text,
  after_row jsonb,
  PRIMARY KEY (boundary, source_name, row_id, layer_end)
);
CREATE UNLOGGED TABLE public.union_pnl_inventory_seal_layer_issues (
  boundary timestamptz NOT NULL,
  source_name text NOT NULL,
  row_id uuid NOT NULL,
  layer_end timestamptz NOT NULL,
  event_id bigint NOT NULL,
  PRIMARY KEY (boundary, source_name, row_id, layer_end, event_id)
);
ALTER TABLE public.union_pnl_inventory_seal_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.union_pnl_inventory_seal_layer_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.union_pnl_inventory_seal_layer_issues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.union_pnl_inventory_seal_layers, public.union_pnl_inventory_seal_layer_rows, public.union_pnl_inventory_seal_layer_issues
  FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.union_pnl_inventory_seal_layers IS
  'Split inventory seal (20261003): the six-hour layers of a closed week computed so far (unlogged staging; a crash empties it with its rows and issues and the week starts again).';
COMMENT ON TABLE public.union_pnl_inventory_seal_layer_rows IS
  'Split inventory seal (20261003): each row a layer touched, as of the layer''s end (latest event, first operation, after image).';
COMMENT ON TABLE public.union_pnl_inventory_seal_layer_issues IS
  'Split inventory seal (20261003): the complete issue set of each row a layer touched, as of the layer''s end.';

CREATE FUNCTION public.fn_union_pnl_inventory_layer_state(p_week_base timestamptz, p_boundary timestamptz, p_from timestamptz, p_to timestamptz)
 RETURNS TABLE(o_kind text, o_source_name text, o_row_id uuid, o_event_id bigint, o_first_operation text, o_after_row jsonb)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET work_mem TO '256MB'
 SET enable_indexscan TO 'off'
AS $function$
BEGIN
 -- fn_union_pnl_inventory_state over the events of [p_from, p_to), its base
 -- being the snapshot at p_from: the latest staged layer (of this boundary,
 -- ending by p_from) that touched a row, else the week's base checkpoint row.
 -- Only the rows this layer touches are returned, each with its complete
 -- issue set as fn_union_pnl_inventory_state would return it.
 IF p_to IS NULL OR p_from IS NULL OR NOT isfinite(p_to) OR NOT isfinite(p_from) OR p_from>=p_to OR p_boundary IS NULL OR p_to>p_boundary
  OR (p_week_base IS NOT NULL AND p_week_base>p_from) THEN
  RAISE EXCEPTION 'invalid_inventory_layer_window' USING ERRCODE='22023'; END IF;
 RETURN QUERY
 WITH d AS MATERIALIZED (
  SELECT e.source_name sn,e.row_id rid,e.event_id eid,e.operation op,
   jsonb_hash_extended(e.before_row,0) b0,jsonb_hash_extended(e.before_row,1) b1,
   jsonb_hash_extended(e.after_row,0) a0,jsonb_hash_extended(e.after_row,1) a1
  FROM public.union_pnl_inventory_events e
  WHERE e.observed_at>=p_from AND e.observed_at<p_to
 ), t AS MATERIALIZED (
  SELECT d.sn,d.rid,min(d.eid) min_id,max(d.eid) max_id FROM d GROUP BY d.sn,d.rid
 ), b AS MATERIALIZED (
  SELECT DISTINCT ON (t.sn,t.rid) t.sn,t.rid,s.src,s.layer,s.eid,s.fop,s.after_row,
   jsonb_hash_extended(s.after_row,0) a0,jsonb_hash_extended(s.after_row,1) a1
  FROM t CROSS JOIN LATERAL (
   SELECT 'layer'::text src,l.layer_end layer,l.latest_event_id eid,l.first_operation fop,l.after_row
    FROM public.union_pnl_inventory_seal_layer_rows l
    WHERE l.boundary=p_boundary AND l.source_name=t.sn AND l.row_id=t.rid AND l.layer_end<=p_from
   UNION ALL
   SELECT 'base',NULL::timestamptz,r.latest_event_id,r.first_operation,r.after_row
    FROM public.union_pnl_inventory_checkpoint_rows r
    WHERE r.boundary=p_week_base AND r.source_name=t.sn AND r.row_id=t.rid) s
  ORDER BY t.sn,t.rid,s.layer DESC NULLS LAST
 ), x AS MATERIALIZED (
  -- A delta event ordered (by event_id) before the row's last earlier event:
  -- that row's whole chain is re-read below instead of continued.
  SELECT t.sn,t.rid FROM t JOIN b ON b.sn=t.sn AND b.rid=t.rid WHERE t.min_id<b.eid
 ), w AS MATERIALIZED (
  SELECT d.sn,d.rid,d.eid,d.b0,d.b1,
   row_number() OVER p k,lag(d.a0) OVER p pa0,lag(d.a1) OVER p pa1,first_value(d.op) OVER p fop
  FROM d WHERE NOT EXISTS(SELECT 1 FROM x WHERE x.sn=d.sn AND x.rid=d.rid)
  WINDOW p AS (PARTITION BY d.sn,d.rid ORDER BY d.eid)
 ), tl AS MATERIALIZED (
  SELECT e.event_id eid,e.after_row FROM public.union_pnl_inventory_events e
  WHERE e.event_id=ANY(ARRAY(SELECT t.max_id FROM t WHERE NOT EXISTS(SELECT 1 FROM x WHERE x.sn=t.sn AND x.rid=t.rid)))
 ), xh AS MATERIALIZED (
  SELECT e.sn,e.rid,e.eid,e.before_row,e.after_row,
   row_number() OVER p k,row_number() OVER (PARTITION BY e.sn,e.rid ORDER BY e.eid DESC) latest,
   lag(e.after_row) OVER p prior_after,first_value(e.op) OVER p fop
  FROM x CROSS JOIN LATERAL (
   SELECT h.source_name sn,h.row_id rid,h.event_id eid,h.operation op,h.before_row,h.after_row
   FROM public.union_pnl_inventory_events h WHERE h.source_name=x.sn AND h.row_id=x.rid AND h.observed_at<p_to) e
  WINDOW p AS (PARTITION BY e.sn,e.rid ORDER BY e.eid)
 ), pi AS MATERIALIZED (
  -- The issue set each touched row had at p_from: its latest layer's, else
  -- the base checkpoint's.
  SELECT li.source_name sn,li.row_id rid,li.event_id eid FROM b JOIN public.union_pnl_inventory_seal_layer_issues li
   ON b.src='layer' AND li.boundary=p_boundary AND li.layer_end=b.layer AND li.source_name=b.sn AND li.row_id=b.rid
  UNION ALL
  SELECT ci.source_name,ci.row_id,ci.event_id FROM t JOIN public.union_pnl_inventory_checkpoint_issues ci
   ON ci.boundary=p_week_base AND ci.source_name=t.sn AND ci.row_id=t.rid
  WHERE NOT EXISTS(SELECT 1 FROM b WHERE b.sn=t.sn AND b.rid=t.rid AND b.src='layer')
 )
 SELECT 'row'::text,t.sn,t.rid,t.max_id,COALESCE(b.fop,w.fop),tl.after_row
  FROM t JOIN w ON w.sn=t.sn AND w.rid=t.rid AND w.k=1
  JOIN tl ON tl.eid=t.max_id
  LEFT JOIN b ON b.sn=t.sn AND b.rid=t.rid
 UNION ALL
 SELECT 'row',xh.sn,xh.rid,xh.eid,xh.fop,xh.after_row FROM xh WHERE xh.latest=1
 UNION ALL
 SELECT 'issue',pi.sn,pi.rid,pi.eid,NULL::text,NULL::jsonb FROM pi WHERE NOT EXISTS(SELECT 1 FROM x WHERE x.sn=pi.sn AND x.rid=pi.rid)
 UNION ALL
 SELECT 'issue',w.sn,w.rid,w.eid,NULL,NULL FROM w WHERE w.k>1 AND (w.pa0,w.pa1) IS DISTINCT FROM (w.b0,w.b1)
 UNION ALL
 SELECT 'issue',w.sn,w.rid,w.eid,NULL,NULL FROM w JOIN b ON b.sn=w.sn AND b.rid=w.rid
  WHERE w.k=1 AND (b.a0,b.a1) IS DISTINCT FROM (w.b0,w.b1)
 UNION ALL
 SELECT 'issue',xh.sn,xh.rid,xh.eid,NULL,NULL FROM xh WHERE xh.k>1 AND xh.prior_after IS DISTINCT FROM xh.before_row;
END $function$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_layer_state(timestamptz,timestamptz,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_union_pnl_inventory_layer_state(timestamptz,timestamptz,timestamptz,timestamptz) IS
  'Split inventory seal (20261003): fn_union_pnl_inventory_state for one layer of a closed week over the snapshot at the layer''s start; returns the rows the layer touched and their complete issue sets.';

CREATE FUNCTION public.fn_union_pnl_inventory_seal_advance(p_at timestamptz, p_verify boolean DEFAULT false)
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
  IF done_any AND clock_timestamp()>began+interval '120 seconds' THEN
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
   md5(COALESCE(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id,o_first_operation,COALESCE(o_after_row::text,'~')),E'\n'
    ORDER BY o_source_name,o_row_id) FILTER(WHERE o_kind='row'),'')),
   md5(COALESCE(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id),E'\n'
    ORDER BY o_source_name,o_row_id,o_event_id) FILTER(WHERE o_kind='issue'),'')),
   max(o_event_id) FILTER(WHERE o_kind='row')
  FROM pg_temp.union_pnl_inventory_seal$q$ INTO v_rows,v_issues,v_rows_md5,v_issues_md5,v_max;
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
END $function$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean) IS
  'Split inventory seal (20261003): computes a closed week''s six-hour inventory layers (at least one per call, none started 120 s after the call began), then seals the week exactly as fn_union_pnl_inventory_checkpoint_seal; with verify, compares the assembled week with an already sealed checkpoint instead.';

COMMIT;
