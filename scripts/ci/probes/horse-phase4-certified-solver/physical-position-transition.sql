\set ON_ERROR_STOP on
BEGIN;
DO $probe$
DECLARE bad jsonb; good jsonb; d uuid; c jsonb; failed boolean; n integer;
BEGIN
 SELECT s.strategy_matrix_v2#>'{nodes,0}' INTO bad
 FROM public.gto_v31_source_artifacts a JOIN public.solved_spots_gold s ON s.id=a.source_row_id
 WHERE s.strategy_matrix_v2#>>'{nodes,0,node_context,table_size}'='2'
 AND s.strategy_matrix_v2#>>'{nodes,0,line_proof,hero_solver_player}'='0' LIMIT 1;
 IF bad IS NULL OR public.fn_gto_v31_source_node_valid(bad) THEN
  RAISE EXCEPTION 'previously admitted reversed HU artifact remains valid'; END IF;
 FOR n IN SELECT unnest(ARRAY[2,3,6,9,10]) LOOP
  good:=jsonb_set(bad-'node_checksum','{node_context,table_size}',to_jsonb(n));
  good:=jsonb_set(good,'{node_context,hero_position}',to_jsonb(CASE WHEN n=2 THEN 'BB' ELSE 'SB' END));
  good:=jsonb_set(good,'{node_context,opponent_position}',to_jsonb(CASE WHEN n=2 THEN 'SB' ELSE 'BB' END));
  good:=good||jsonb_build_object('node_checksum',public.fn_gto_v31_node_checksum(good));
  IF NOT public.fn_gto_v31_source_node_valid(good) THEN
   RAISE EXCEPTION 'chronologically unchanged valid physical % seat node rejected',n; END IF;
 END LOOP;
 SELECT dataset_id,declared_coverage->0 INTO d,c FROM public.gto_v31_datasets WHERE state='building' LIMIT 1;
 IF NOT EXISTS(SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=d) THEN
  RAISE EXCEPTION 'prior accepted artifact has no prior built cells'; END IF;
 failed:=false;
 BEGIN PERFORM public.fn_gto_v31_build_cell(d,c); EXCEPTION WHEN SQLSTATE '55000' THEN failed:=true; END;
 IF NOT failed THEN RAISE EXCEPTION 'cached wrong-role cell bypassed new source authority'; END IF;
 failed:=false;
 BEGIN PERFORM public.fn_gto_v31_heldout_metrics(d,NULL); EXCEPTION WHEN SQLSTATE '55000' THEN failed:=true; END;
 IF NOT failed THEN RAISE EXCEPTION 'heldout scored prior wrong-role sources'; END IF;
 failed:=false;
 BEGIN PERFORM public.fn_gto_v31_seal_build(d); EXCEPTION WHEN SQLSTATE '55000' THEN failed:=true; END;
 IF NOT failed THEN RAISE EXCEPTION 'seal admitted prior wrong-role dataset'; END IF;
END;
$probe$;
ROLLBACK;
-- Only the disposable local fixture owns these tables. Preserve every source
-- artifact through the rejection proof, then reset this isolated test database.
TRUNCATE public.gto_v31_input_bundles CASCADE;
DELETE FROM public.solved_spots_gold WHERE game_type LIKE 'gto_v31_%';
SELECT 'V31_PHYSICAL_POSITION_TRANSITION_OK' AS result;
