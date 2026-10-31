-- WHY: PostgREST PG57014 at fresh Linux OFFSET 79 stopped qualification before native execution.
-- The actual non-ANALYZE plan placed wide program/protocol projections below Sort/Limit.
-- Materialize only approved keys first; retain the original admission, receipts and runtime settings.
-- @live-proof: (SELECT md5(prosrc)='0920656ff63f628f1fcac048a4eb4b9f' AND prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=public'] AND has_function_privilege('service_role',oid,'EXECUTE') AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') FROM pg_proc WHERE oid='public.fn_gto_v31_model_preparations(uuid,integer,integer)'::regprocedure)
BEGIN;
CREATE TEMP TABLE public215_preparation_function_before ON COMMIT DROP AS
 SELECT oid, to_jsonb(p)-'prosrc' AS metadata FROM pg_proc p
 WHERE oid='public.fn_gto_v31_model_preparations(uuid,integer,integer)'::regprocedure;
DO $guard$
BEGIN
 IF (SELECT count(*) FROM pg_temp.public215_preparation_function_before)<>1
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_model_preparations(uuid,integer,integer)'::regprocedure)<>'17a92ab649ad85569fc1ba8a30e0eccb'
 THEN RAISE EXCEPTION 'model preparations source precondition changed'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_model_preparations(p_dataset_id uuid,p_offset integer DEFAULT 0,p_limit integer DEFAULT 1)
RETURNS TABLE(dataset_id uuid,cell_key_checksum text,context jsonb,policy_representation text,public_model jsonb,public_template jsonb,public_training_provenance jsonb,model_checksum text,template_checksum text,feature_schema_checksum text,training_provenance_checksum text,public_model_build_receipt jsonb,model_build_receipt_checksum text,preparation_checksum text,status text,runtime_parity_protocol jsonb,encoder_descriptor jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $fn$
BEGIN
 IF COALESCE(auth.role(),'')<>'service_role'AND current_user NOT IN('postgres','supabase_admin')THEN RAISE EXCEPTION 'service_role required';END IF;
 -- Materialize only keys and canonical ordering before detoasting program/protocol JSON.
 RETURN QUERY WITH selected_preparation AS MATERIALIZED (
  SELECT p.dataset_id,p.cell_key_checksum,
   public.fn_gto_v31_public215_canonical(p.context) COLLATE "C" AS canonical_context
  FROM public.gto_v31_model_preparations p
  JOIN public.gto_v31_datasets d ON d.dataset_id=p.dataset_id AND d.state='building'
  JOIN public.gto_v31_input_bundles b ON b.input_bundle_id=d.input_bundle_id
   AND b.approval_status='approved' AND b.bundle_checksum=d.input_bundle_checksum
  WHERE p.dataset_id=p_dataset_id
  ORDER BY public.fn_gto_v31_public215_canonical(p.context) COLLATE "C"
  OFFSET greatest(COALESCE(p_offset,0),0) LIMIT 1
 ) SELECT p.dataset_id,p.cell_key_checksum,p.context,'public_hist215_v1'::text,p.program->'public_model',p.program->'public_template',p.program->'public_training_provenance',p.program->>'model_checksum',p.program->>'template_checksum',p.program->>'feature_schema_checksum',p.program->>'training_provenance_checksum',f.public_model_build_receipt,f.model_build_receipt_checksum,p.preparation_checksum,CASE WHEN f.cell_key_checksum IS NULL THEN 'prepared'ELSE 'frozen'END,b.bundle_manifest#>'{public215_protocols,runtime_parity_protocol}',b.bundle_manifest#>'{public215_protocols,training_recipe,encoder_descriptor}' FROM selected_preparation selected JOIN public.gto_v31_model_preparations p ON p.dataset_id=selected.dataset_id AND p.cell_key_checksum=selected.cell_key_checksum JOIN public.gto_v31_datasets d ON d.dataset_id=p.dataset_id AND d.state='building'JOIN public.gto_v31_input_bundles b ON b.input_bundle_id=d.input_bundle_id AND b.approval_status='approved'AND b.bundle_checksum=d.input_bundle_checksum LEFT JOIN public.gto_v31_model_freezes f ON f.dataset_id=p.dataset_id AND f.cell_key_checksum=p.cell_key_checksum ORDER BY selected.canonical_context COLLATE "C";
END $fn$;
DO $guard$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_temp.public215_preparation_function_before b
 JOIN pg_proc p ON p.oid=b.oid WHERE to_jsonb(p)-'prosrc'=b.metadata)
 THEN RAISE EXCEPTION 'model preparations identity, signature, owner, ACL or settings changed'; END IF;
END $guard$;
COMMIT;
