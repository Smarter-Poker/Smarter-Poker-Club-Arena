\set ON_ERROR_STOP on
BEGIN;
DO $probe$
DECLARE d public.gto_v31_datasets%ROWTYPE; c public.gto_v31_runtime_cells%ROWTYPE;
 new_dataset uuid:='fac00000-0000-4000-8000-000000000001'; payload jsonb; failed boolean; message text;
BEGIN
 SELECT * INTO STRICT d FROM public.gto_v31_datasets LIMIT 1;
 SELECT * INTO STRICT c FROM public.gto_v31_runtime_cells WHERE dataset_id=d.dataset_id LIMIT 1;
 INSERT INTO public.gto_v31_datasets SELECT (jsonb_populate_record(NULL::public.gto_v31_datasets,
   to_jsonb(d)||jsonb_build_object('dataset_id',new_dataset,'dataset_key','v4.version-boundary.fixture'))).*;
 payload:=to_jsonb(c)||jsonb_build_object('policy_export_schema','smarter-poker.pio-policy.v4');
 payload:=payload||jsonb_build_object('cell_key_checksum',public.fn_gto_v31_cell_key_checksum(payload));
 payload:=payload||jsonb_build_object('cell_payload_checksum',public.fn_gto_v31_cell_payload_checksum(payload));
 IF payload->>'cell_key_checksum'=c.cell_key_checksum THEN RAISE EXCEPTION 'policy schema is not key-bound'; END IF;
 INSERT INTO public.gto_v31_runtime_cells SELECT (jsonb_populate_record(NULL::public.gto_v31_runtime_cells,
  payload||jsonb_build_object('dataset_id',new_dataset,'cell_id','fac00000-0000-4000-8000-000000000002'))).*;
 failed:=false;
 BEGIN PERFORM public.fn_gto_v31_seal_build(new_dataset);
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
  failed:=message='cell feature version differs from dataset'; END;
 IF NOT failed THEN RAISE EXCEPTION 'wrong-policy runtime cell was not refused at seal: %',message; END IF;
 IF public.fn_gto_v31_cell_key_checksum(to_jsonb(c)-'policy_export_schema')<>c.cell_key_checksum
 OR public.fn_gto_v31_cell_payload_checksum(to_jsonb(c)-'policy_export_schema')<>c.cell_payload_checksum THEN
  RAISE EXCEPTION 'legacy omitted policy checksum changed'; END IF;
END;
$probe$;
ROLLBACK;
SELECT 'V31_V4_VERSION_BOUNDARY_OK';
