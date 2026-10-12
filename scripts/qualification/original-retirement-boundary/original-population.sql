CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_population(p_base timestamp with time zone, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE population jsonb; gaps jsonb;
BEGIN
 WITH s AS MATERIALIZED (
  SELECT * FROM public.fn_union_pnl_inventory_state(p_base,p_at)
 ), current_rows AS MATERIALIZED (
  SELECT s.o_source_name source_name,s.o_row_id row_id,s.o_event_id event_id,s.o_after_row after_row,s.o_first_operation first_operation
  FROM s WHERE s.o_kind='row' AND s.o_after_row IS NOT NULL
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
   FROM active WHERE first_operation NOT IN ('baseline','INSERT')
    -- A seat vacated before capture began and re-opened afterwards: its first
    -- captured event is the UPDATE that opened this occupancy (see 20260928153000).
    AND NOT (source_name='table_seats' AND first_operation='UPDATE' AND EXISTS(
     SELECT 1 FROM (SELECT e.before_row FROM public.union_pnl_inventory_events e
       WHERE e.source_name='table_seats' AND e.row_id=active.row_id ORDER BY e.event_id LIMIT 1) f
     WHERE f.before_row->>'left_at' IS NOT NULL
      AND (f.before_row->>'left_at')::timestamptz<=(SELECT c.captured_at FROM public.union_pnl_inventory_capture c WHERE c.singleton)))),'[]')
  ||COALESCE((SELECT jsonb_agg(jsonb_build_object('source_name',s.o_source_name,'row_id',s.o_row_id,'source_event_id',s.o_event_id,'reason','original_inventory_chain_disagrees') ORDER BY s.o_source_name,s.o_row_id,s.o_event_id)
   FROM s WHERE s.o_kind='issue'),'[]') INTO population,gaps;
 RETURN jsonb_build_object('population',population,'issues',gaps);
END $function$

