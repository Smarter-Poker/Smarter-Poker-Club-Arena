CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_state(p_base timestamp with time zone, p_at timestamp with time zone)
 RETURNS TABLE(o_kind text, o_source_name text, o_row_id uuid, o_event_id bigint, o_first_operation text, o_after_row jsonb)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET work_mem TO '64MB'
 SET enable_indexscan TO 'off'
 SET max_parallel_workers_per_gather TO '0'
AS $function$
BEGIN
 -- Plain index scans are off: measured on production 2026-09-28, a cold week
 -- range read through the boundary index one heap page at a time costs
 -- ~235us an event (7.8M events: ~30 min); the same range as a bitmap heap
 -- scan, pages in physical order, ~45us (~6 min), less in parallel.
 IF p_at IS NULL OR NOT isfinite(p_at) OR (p_base IS NOT NULL AND (NOT isfinite(p_base) OR p_base>p_at)) THEN
  RAISE EXCEPTION 'invalid_inventory_state_window' USING ERRCODE='22023'; END IF;
 RETURN QUERY
 WITH d AS MATERIALIZED (
  SELECT e.source_name sn,e.row_id rid,e.event_id eid,e.operation op,
   jsonb_hash_extended(e.before_row,0) b0,jsonb_hash_extended(e.before_row,1) b1,
   jsonb_hash_extended(e.after_row,0) a0,jsonb_hash_extended(e.after_row,1) a1
  FROM public.union_pnl_inventory_events e
  WHERE e.observed_at>=COALESCE(p_base,'-infinity'::timestamptz) AND e.observed_at<p_at
 ), b AS MATERIALIZED (
  SELECT r.source_name sn,r.row_id rid,r.latest_event_id eid,r.first_operation fop,r.after_row,
   jsonb_hash_extended(r.after_row,0) a0,jsonb_hash_extended(r.after_row,1) a1
  FROM public.union_pnl_inventory_checkpoint_rows r WHERE r.boundary=p_base
 ), t AS MATERIALIZED (
  SELECT d.sn,d.rid,min(d.eid) min_id,max(d.eid) max_id FROM d GROUP BY d.sn,d.rid
 ), x AS MATERIALIZED (
  -- A delta event ordered (by event_id) before the row's last pre-base event:
  -- that row's whole chain is re-read below instead of continued.
  SELECT t.sn,t.rid FROM t JOIN b ON b.sn=t.sn AND b.rid=t.rid WHERE t.min_id<b.eid
 ), w AS MATERIALIZED (
  SELECT d.sn,d.rid,d.eid,d.b0,d.b1,
   row_number() OVER p k,lag(d.a0) OVER p pa0,lag(d.a1) OVER p pa1,first_value(d.op) OVER p fop
  FROM d WHERE NOT EXISTS(SELECT 1 FROM x WHERE x.sn=d.sn AND x.rid=d.rid)
  WINDOW p AS (PARTITION BY d.sn,d.rid ORDER BY d.eid)
 ), tl AS MATERIALIZED (
  -- The latest row image of each continued row, fetched in one pass in
  -- physical order rather than one random heap read per row.
  SELECT e.event_id eid,e.after_row FROM public.union_pnl_inventory_events e
  WHERE e.event_id=ANY(ARRAY(SELECT t.max_id FROM t WHERE NOT EXISTS(SELECT 1 FROM x WHERE x.sn=t.sn AND x.rid=t.rid)))
 ), xh AS MATERIALIZED (
  -- LATERAL: always one identity-index read per interleaved row, never a join
  -- plan that scans the history.
  SELECT e.sn,e.rid,e.eid,e.before_row,e.after_row,
   row_number() OVER p k,row_number() OVER (PARTITION BY e.sn,e.rid ORDER BY e.eid DESC) latest,
   lag(e.after_row) OVER p prior_after,first_value(e.op) OVER p fop
  FROM x CROSS JOIN LATERAL (
   SELECT h.source_name sn,h.row_id rid,h.event_id eid,h.operation op,h.before_row,h.after_row
   FROM public.union_pnl_inventory_events h WHERE h.source_name=x.sn AND h.row_id=x.rid AND h.observed_at<p_at) e
  WINDOW p AS (PARTITION BY e.sn,e.rid ORDER BY e.eid)
 )
 SELECT 'row'::text,b.sn,b.rid,b.eid,b.fop,b.after_row FROM b
  WHERE NOT EXISTS(SELECT 1 FROM t WHERE t.sn=b.sn AND t.rid=b.rid)
 UNION ALL
 SELECT 'row',t.sn,t.rid,t.max_id,COALESCE(b.fop,w.fop),tl.after_row
  FROM t JOIN w ON w.sn=t.sn AND w.rid=t.rid AND w.k=1
  JOIN tl ON tl.eid=t.max_id
  LEFT JOIN b ON b.sn=t.sn AND b.rid=t.rid
 UNION ALL
 SELECT 'row',xh.sn,xh.rid,xh.eid,xh.fop,xh.after_row FROM xh WHERE xh.latest=1
 UNION ALL
 SELECT 'issue',i.source_name,i.row_id,i.event_id,NULL::text,NULL::jsonb FROM public.union_pnl_inventory_checkpoint_issues i
  WHERE i.boundary=p_base AND NOT EXISTS(SELECT 1 FROM x WHERE x.sn=i.source_name AND x.rid=i.row_id)
 UNION ALL
 SELECT 'issue',w.sn,w.rid,w.eid,NULL,NULL FROM w WHERE w.k>1 AND (w.pa0,w.pa1) IS DISTINCT FROM (w.b0,w.b1)
 UNION ALL
 SELECT 'issue',w.sn,w.rid,w.eid,NULL,NULL FROM w JOIN b ON b.sn=w.sn AND b.rid=w.rid
  WHERE w.k=1 AND (b.a0,b.a1) IS DISTINCT FROM (w.b0,w.b1)
 UNION ALL
 SELECT 'issue',xh.sn,xh.rid,xh.eid,NULL,NULL FROM xh WHERE xh.k>1 AND xh.prior_after IS DISTINCT FROM xh.before_row;
END $function$
;

