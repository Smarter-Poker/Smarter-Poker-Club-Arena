-- fn_union_pnl_inventory_as_of exactly as production serves it (md5 of pg_get_functiondef 6b7204a27c7b90412646af3145096c2f).
CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_as_of(p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE origin public.union_pnl_inventory_capture%ROWTYPE; book timestamptz; population jsonb; gaps jsonb;
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
 -- VOLATILE intentionally obtains a fresh snapshot after the old-book writers
 -- have committed. A stable/snapshot reader could omit those committed events.
 WITH history AS MATERIALIZED (
  SELECT e.*,row_number() OVER(PARTITION BY source_name,row_id ORDER BY event_id DESC) latest,
   first_value(operation) OVER(PARTITION BY source_name,row_id ORDER BY event_id) first_operation,
   row_number() OVER(PARTITION BY source_name,row_id ORDER BY event_id) ordinal,
   lag(after_row) OVER(PARTITION BY source_name,row_id ORDER BY event_id) prior_after
  FROM public.union_pnl_inventory_events e WHERE observed_at<p_at
 ), current_rows AS MATERIALIZED (
  SELECT source_name,row_id,event_id,after_row,first_operation FROM history WHERE latest=1 AND after_row IS NOT NULL
 ), active AS MATERIALIZED (
  SELECT * FROM current_rows r WHERE source_name='union_clubs'
   OR (source_name='tables' AND after_row->'tournament_id'='null'::jsonb)
   OR (source_name='table_seats' AND after_row->'left_at'='null'::jsonb)
   OR (source_name='tournaments' AND after_row->>'status' NOT IN ('COMPLETED','CANCELLED'))
   OR (source_name='tournament_players' AND EXISTS(SELECT 1 FROM current_rows t WHERE t.source_name='tournaments'
    AND t.row_id::text=r.after_row->>'tournament_id' AND t.after_row->>'status' NOT IN ('COMPLETED','CANCELLED')))
 ), grouped AS (
  SELECT source_name,jsonb_agg(jsonb_build_object('source_event_id',event_id,'row',after_row) ORDER BY row_id) rows FROM active GROUP BY source_name
 ) SELECT COALESCE((SELECT jsonb_object_agg(source_name,rows) FROM grouped),'{}'),
  COALESCE((SELECT jsonb_agg(jsonb_build_object('source_name',source_name,'row_id',row_id,'reason','active_row_original_population_missing') ORDER BY source_name,row_id)
   FROM active WHERE first_operation NOT IN ('baseline','INSERT')),'[]')
  ||COALESCE((SELECT jsonb_agg(jsonb_build_object('source_name',source_name,'row_id',row_id,'source_event_id',event_id,'reason','original_inventory_chain_disagrees') ORDER BY source_name,row_id,event_id)
   FROM history WHERE ordinal>1 AND prior_after IS DISTINCT FROM before_row),'[]') INTO population,gaps;
 RETURN jsonb_build_object('status',CASE WHEN gaps='[]'::jsonb THEN 'observed' ELSE 'blocked' END,
  'inventory_version',1,'capture_started_at',origin.captured_at,'boundary',p_at,'population',population,'issues',gaps,
  'current_state_used',false,'financial_basis_certified',false,
  'coverage','Original active population and later captured transitions; monetary funding and obligation receipts must independently certify equity.');
END $function$
;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_as_of(timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
