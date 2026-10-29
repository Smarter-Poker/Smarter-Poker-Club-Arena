\set ON_ERROR_STOP on
-- Called inside the real certification fixture after its cells are built.
-- Deliberately inconsistent foreign metadata tests refusal, never serving data.
CREATE FUNCTION public.v31_dataset_scope_probe(p_dataset uuid)
RETURNS void LANGUAGE plpgsql AS $probe$
DECLARE foreign_dataset uuid:=gen_random_uuid(); cell jsonb; failed boolean; msg text;
BEGIN
 INSERT INTO public.gto_v31_datasets
 SELECT (jsonb_populate_record(NULL::public.gto_v31_datasets,
   to_jsonb(d)||jsonb_build_object('dataset_id',foreign_dataset,
   'dataset_key','foreign-schema-scope-'||foreign_dataset::text))).*
 FROM public.gto_v31_datasets d WHERE dataset_id=p_dataset;
 SELECT to_jsonb(c)||jsonb_build_object('cell_id',gen_random_uuid(),
   'dataset_id',foreign_dataset,'policy_export_schema','smarter-poker.pio-policy.v4')
 INTO STRICT cell FROM public.gto_v31_runtime_cells c WHERE dataset_id=p_dataset LIMIT 1;
 cell:=cell||jsonb_build_object('cell_key_checksum',public.fn_gto_v31_cell_key_checksum(cell),
   'cell_payload_checksum',public.fn_gto_v31_cell_payload_checksum(cell));
 INSERT INTO public.gto_v31_runtime_cells
 SELECT (jsonb_populate_record(NULL::public.gto_v31_runtime_cells,cell)).*;
 -- The foreign dataset must still refuse its own mismatched cell.
 failed:=false;
 BEGIN PERFORM public.fn_gto_v31_seal_build(foreign_dataset);
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg<>'cell feature version differs from dataset' THEN RAISE; END IF;
  failed:=true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'own dataset schema mismatch was accepted'; END IF;
 -- The real target must seal despite that unrelated foreign cell.
 PERFORM public.fn_gto_v31_seal_build(p_dataset);
 IF (SELECT state FROM public.gto_v31_datasets WHERE dataset_id=p_dataset)<>'evaluating' THEN
  RAISE EXCEPTION 'unrelated dataset blocked certification'; END IF;
 -- Leave the foreign cell for the fixture's real promotion call too.
END;
$probe$;
