-- A bounded caller for the existing independent all-legal/all-head SQL audit.
-- No seed, labels, caller-authored board, source mutation or qualification state.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION public.fn_gto_v31_prepare_heldout_public_physics(
 p_dataset_id uuid,p_cell_key_checksum text,p_model_checksum text,
 p_model_build_receipt_checksum text,p_board_offset integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
SET statement_timeout='240s' SET lock_timeout='1s' AS $fn$
DECLARE d public.gto_v31_datasets;c public.gto_v31_runtime_cells;
 s public.gto_v31_public_selections;j public.gto_v31_public_source_journal;
 n integer;boards integer;board_cards text[];audit text;result jsonb;key text;
BEGIN
 IF COALESCE(auth.role(),'')<>'service_role' THEN RAISE EXCEPTION 'service_role required';END IF;
 IF p_board_offset IS NULL OR p_board_offset NOT BETWEEN 0 AND 7
  OR COALESCE(p_cell_key_checksum,'')!~'^[0-9a-f]{64}$' OR p_cell_key_checksum=repeat('0',64)
  OR COALESCE(p_model_checksum,'')!~'^[0-9a-f]{64}$' OR p_model_checksum=repeat('0',64)
  OR COALESCE(p_model_build_receipt_checksum,'')!~'^[0-9a-f]{64}$' OR p_model_build_receipt_checksum=repeat('0',64)
 THEN RAISE EXCEPTION 'exact frozen model and bounded heldout board ordinal required';END IF;
 -- Only this offline dataset row is shared-locked, never a live game table.
 SELECT * INTO STRICT d FROM public.gto_v31_datasets WHERE dataset_id=p_dataset_id
  AND state='building' AND policy_representation='public_hist215_v1' FOR SHARE;
 IF jsonb_typeof(d.declared_coverage) IS DISTINCT FROM 'array'
  OR jsonb_array_length(d.declared_coverage) IS DISTINCT FROM 107 OR NOT EXISTS(
  SELECT 1 FROM public.gto_v31_input_bundles b WHERE b.input_bundle_id=d.input_bundle_id
  AND b.approval_status='approved' AND b.bundle_checksum=d.input_bundle_checksum)
 THEN RAISE EXCEPTION 'approved complete public215 input required';END IF;
 SELECT * INTO STRICT c FROM public.gto_v31_runtime_cells WHERE dataset_id=d.dataset_id
  AND cell_key_checksum=p_cell_key_checksum AND policy_representation='public_hist215_v1';
 IF c.model_checksum IS DISTINCT FROM p_model_checksum
  OR c.model_build_receipt_checksum IS DISTINCT FROM p_model_build_receipt_checksum
  OR NOT EXISTS(SELECT 1 FROM public.gto_v31_model_preparations p
   JOIN public.gto_v31_model_freezes f ON f.dataset_id=p.dataset_id AND f.cell_key_checksum=p.cell_key_checksum
   WHERE p.dataset_id=d.dataset_id AND p.cell_key_checksum=c.cell_key_checksum
   AND p.context=c.public_template->'context'
   AND p.identity->>'model_checksum'=c.model_checksum
   AND p.identity->>'template_checksum'=c.template_checksum
   AND p.identity->>'training_provenance_checksum'=c.training_provenance_checksum
   AND f.model_build_receipt_checksum=c.model_build_receipt_checksum
   AND f.public_model_build_receipt=c.public_model_build_receipt)
 THEN RAISE EXCEPTION 'runtime cell differs from immutable pre-opening model freeze';END IF;
 PERFORM public.fn_gto_v31_public215_frozen_map(d);
 IF public.fn_gto_v31_public215_selected_complete(d) IS NOT TRUE
  OR public.fn_gto_v31_public215_source_headers_valid(d) IS NOT TRUE
  OR public.fn_gto_v31_public215_frozen_model_valid(c,d) IS NOT TRUE
 THEN RAISE EXCEPTION 'complete genuine M2 selection, current sources and frozen model required';END IF;
 SELECT * INTO STRICT s FROM public.gto_v31_public_selections
  WHERE dataset_id=d.dataset_id AND input_bundle_checksum=d.input_bundle_checksum;
 IF jsonb_typeof(s.selected) IS DISTINCT FROM 'array'
  OR jsonb_array_length(s.selected) IS DISTINCT FROM 856 OR s.capture_checksum IS DISTINCT FROM s.receipt->>'capture_receipt_checksum'
  OR s.capture_checksum IS DISTINCT FROM c.public_training_provenance->>'capture_receipt_checksum'
 THEN RAISE EXCEPTION 'complete selected M2 and original M1 capture authority required';END IF;
 SELECT count(*),count(DISTINCT board) INTO n,boards FROM public.gto_v31_public_source_journal
  WHERE dataset_id=d.dataset_id AND machine_id='M2' AND context=c.public_template->'context';
 IF n<>8 OR boards<>8 THEN RAISE EXCEPTION 'exact eight admitted M2 boards required';END IF;
 SELECT * INTO STRICT j FROM public.gto_v31_public_source_journal
  WHERE dataset_id=d.dataset_id AND machine_id='M2' AND context=c.public_template->'context'
  ORDER BY board COLLATE "C" OFFSET p_board_offset LIMIT 1;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.selected) x
  WHERE x->>'context_id'=public.fn_gto_v31_public215_digest(j.context)
  AND x->>'board'=j.board AND x->>'rank_signature'=public.fn_gto_v31_public215_rank_signature(j.board))
 THEN RAISE EXCEPTION 'actual M2 source board differs from committed selection';END IF;
 IF public.fn_gto_v31_public215_cards(j.board) IS NOT TRUE
  OR length(j.board)<>(CASE c.public_template#>>'{context,street}' WHEN 'flop' THEN 6 WHEN 'turn' THEN 8 WHEN 'river' THEN 10 ELSE 0 END)
 THEN RAISE EXCEPTION 'admitted chronological board shape differs';END IF;
 SELECT array_agg(substring(j.board FROM i FOR 2) ORDER BY i) INTO board_cards
  FROM generate_series(1,length(j.board),2)i;
 result:=jsonb_build_object('format','public215_heldout_physics_v1','dataset_id',d.dataset_id,
  'context',j.context,'cell_key_checksum',c.cell_key_checksum,'model_checksum',c.model_checksum,
  'template_checksum',c.template_checksum,'model_build_receipt_checksum',c.model_build_receipt_checksum,
  'board',j.board,'board_offset',p_board_offset,'selection_receipt_checksum',s.receipt_checksum,
  'capture_receipt_checksum',s.capture_checksum,'node_checksum',j.node_checksum,
  'artifact_checksum',j.artifact_checksum);
 FOREACH key IN ARRAY ARRAY['cell_key_checksum','model_checksum','template_checksum',
  'model_build_receipt_checksum','selection_receipt_checksum','capture_receipt_checksum',
  'node_checksum','artifact_checksum'] LOOP
  IF COALESCE(result->>key,'')!~'^[0-9a-f]{64}$' OR result->>key=repeat('0',64)
  THEN RAISE EXCEPTION 'nonzero bound heldout audit checksum required';END IF;
 END LOOP;
 audit:=public.fn_gto_v31_prepare_public_physics(d.dataset_id,c.cell_key_checksum,board_cards);
 IF COALESCE(audit,'')!~'^[0-9a-f]{64}$' OR audit=repeat('0',64)
 THEN RAISE EXCEPTION 'nonzero bound heldout audit checksum required';END IF;
 -- Reject a quarantine or authority change during the bounded audit as well.
 IF public.fn_gto_v31_public215_selected_complete(d) IS NOT TRUE
  OR public.fn_gto_v31_public215_source_headers_valid(d) IS NOT TRUE
  OR public.fn_gto_v31_public215_frozen_model_valid(c,d) IS NOT TRUE
 THEN RAISE EXCEPTION 'heldout audit source authority changed during derivation';END IF;
 RETURN result||jsonb_build_object('audit_key',audit);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_prepare_heldout_public_physics(uuid,text,text,text,integer)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_prepare_heldout_public_physics(uuid,text,text,text,integer) TO service_role;
COMMIT;
