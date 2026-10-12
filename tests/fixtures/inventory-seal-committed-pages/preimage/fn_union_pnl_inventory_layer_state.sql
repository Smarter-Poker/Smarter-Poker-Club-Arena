CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_layer_state(p_week_base timestamp with time zone, p_boundary timestamp with time zone, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(o_kind text, o_source_name text, o_row_id uuid, o_event_id bigint, o_first_operation text, o_after_row jsonb)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET work_mem TO '64MB'
 SET enable_indexscan TO 'off'
 SET max_parallel_workers_per_gather TO '0'
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
END $function$
;

