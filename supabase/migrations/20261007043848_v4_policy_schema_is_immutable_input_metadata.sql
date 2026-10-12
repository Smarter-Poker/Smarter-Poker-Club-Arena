-- 20261007043848_v4_policy_schema_is_immutable_input_metadata.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- TIER 2. Explicit V4 input identity only. NULL storage means the historic
-- omitted V3 field; JSON null, explicit V3 and unknown values are refused.
-- No approved bundle, dataset, node or installed migration is rewritten.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
ALTER TABLE public.gto_v31_input_bundles ADD COLUMN policy_export_schema text CHECK(policy_export_schema='smarter-poker.pio-policy.v4');
ALTER TABLE public.gto_v31_datasets ADD COLUMN policy_export_schema text CHECK(policy_export_schema='smarter-poker.pio-policy.v4');
ALTER TABLE public.gto_v31_runtime_cells ADD COLUMN policy_export_schema text CHECK(policy_export_schema='smarter-poker.pio-policy.v4');

CREATE FUNCTION public.fn_gto_v31_policy_request_valid(p_request jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $fn$
 SELECT COALESCE(jsonb_typeof(p_request)='object' AND
   (NOT p_request ? 'policy_export_schema' OR
    (jsonb_typeof(p_request->'policy_export_schema')='string' AND
     p_request->>'policy_export_schema'='smarter-poker.pio-policy.v4')),false);
$fn$;
CREATE FUNCTION public.fn_gto_v31_policy_identity(p_schema text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE CALLED ON NULL INPUT SET search_path=public AS $fn$
BEGIN
 IF p_schema IS NULL THEN RETURN '{}'::jsonb; END IF;
 IF p_schema<>'smarter-poker.pio-policy.v4' THEN RAISE EXCEPTION 'unknown policy export schema'; END IF;
 RETURN jsonb_build_object('policy_export_schema',p_schema);
END; $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_policy_request_valid(jsonb),public.fn_gto_v31_policy_identity(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_policy_request_valid(jsonb),public.fn_gto_v31_policy_identity(text) TO authenticated,service_role;

CREATE TEMP TABLE v31_policy_metadata_preimages ON COMMIT DROP AS
 SELECT oid,oid::regprocedure::text signature,pg_get_functiondef(oid) definition,
 proowner,proacl,proconfig,prosecdef FROM pg_proc WHERE oid IN
 ('public.fn_gto_v31_input_bundle_checksum(jsonb)'::regprocedure,
 'public.ca_gto_v31_approve_input_bundle(jsonb)'::regprocedure,
 'public.fn_gto_v31_register_dataset(jsonb)'::regprocedure,
 'public.fn_gto_v31_worker_contract(text)'::regprocedure,
 'public.fn_gto_v31_feature_binding_immutable()'::regprocedure);

CREATE FUNCTION pg_temp.v31_policy_metadata_replace(body text,anchor text,replacement text)
RETURNS text LANGUAGE plpgsql AS $fn$
BEGIN
 IF anchor='' OR (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'policy metadata preimage anchor missing or duplicated: %',anchor;
 END IF;
 RETURN replace(body,anchor,replacement);
END; $fn$;
CREATE FUNCTION pg_temp.v31_policy_metadata_patch(signature text,body text)
RETURNS text LANGUAGE plpgsql AS $patch$
DECLARE result text:=body; request text; anchor text;
BEGIN
 IF signature IN ('fn_gto_v31_input_bundle_checksum(jsonb)','ca_gto_v31_approve_input_bundle(jsonb)','fn_gto_v31_register_dataset(jsonb)') THEN
  request:=CASE WHEN signature='fn_gto_v31_register_dataset(jsonb)' THEN 'p_dataset' ELSE 'p_bundle' END;
  anchor:='CASE WHEN '||request||' ? ''feature_contract_version'' THEN 1 ELSE 0 END';
  result:=pg_temp.v31_policy_metadata_replace(result,anchor,anchor||' + CASE WHEN '||request||' ? ''policy_export_schema'' THEN 1 ELSE 0 END');
  anchor:='OR NOT public.fn_gto_v31_feature_request_valid('||request||')';
  result:=pg_temp.v31_policy_metadata_replace(result,anchor,anchor||E'\n     OR NOT public.fn_gto_v31_policy_request_valid('||request||')');
 END IF;
 CASE signature
 WHEN 'fn_gto_v31_input_bundle_checksum(jsonb)' THEN
  anchor:='v_identity := v_identity || public.fn_gto_v31_feature_identity(p_bundle->>''feature_contract_version'');';
  result:=pg_temp.v31_policy_metadata_replace(result,anchor,anchor||E'\n  v_identity := v_identity || public.fn_gto_v31_policy_identity(p_bundle->>''policy_export_schema'');');
 WHEN 'ca_gto_v31_approve_input_bundle(jsonb)' THEN
  result:=pg_temp.v31_policy_metadata_replace(result,'bundle_manifest,approved_by,feature_contract_version','bundle_manifest,approved_by,feature_contract_version,policy_export_schema');
  result:=pg_temp.v31_policy_metadata_replace(result,'p_bundle,v_actor,p_bundle->>''feature_contract_version''','p_bundle,v_actor,p_bundle->>''feature_contract_version'',p_bundle->>''policy_export_schema''');
  anchor:='AND b.bundle_manifest=p_bundle';
  result:=pg_temp.v31_policy_metadata_replace(result,anchor,anchor||E'\n       AND b.policy_export_schema IS NOT DISTINCT FROM p_bundle->>''policy_export_schema''');
 WHEN 'fn_gto_v31_register_dataset(jsonb)' THEN
  anchor:='OR v_bundle.feature_contract_version IS DISTINCT FROM p_dataset->>''feature_contract_version''';
  result:=pg_temp.v31_policy_metadata_replace(result,anchor,anchor||E'\n     OR v_bundle.policy_export_schema IS DISTINCT FROM p_dataset->>''policy_export_schema''');
  result:=pg_temp.v31_policy_metadata_replace(result,'quality_gates, feature_contract_version','quality_gates, feature_contract_version, policy_export_schema');
  result:=pg_temp.v31_policy_metadata_replace(result,'v_gates,p_dataset->>''feature_contract_version''','v_gates,p_dataset->>''feature_contract_version'',p_dataset->>''policy_export_schema''');
 WHEN 'fn_gto_v31_worker_contract(text)' THEN
  anchor:='|| public.fn_gto_v31_feature_identity(d.feature_contract_version) INTO v_result';
  result:=pg_temp.v31_policy_metadata_replace(result,anchor,'|| public.fn_gto_v31_feature_identity(d.feature_contract_version) || public.fn_gto_v31_policy_identity(d.policy_export_schema) INTO v_result');
 WHEN 'fn_gto_v31_feature_binding_immutable()' THEN
  anchor:='IF NEW.feature_contract_version IS DISTINCT FROM OLD.feature_contract_version THEN';
  result:=pg_temp.v31_policy_metadata_replace(result,anchor,'IF NEW.feature_contract_version IS DISTINCT FROM OLD.feature_contract_version OR NEW.policy_export_schema IS DISTINCT FROM OLD.policy_export_schema THEN');
 ELSE RAISE EXCEPTION 'unexpected policy metadata function: %',signature;
 END CASE;
 RETURN result;
END; $patch$;
DO $apply$
DECLARE r record;
BEGIN
 IF (SELECT count(*) FROM v31_policy_metadata_preimages)<>5 THEN RAISE EXCEPTION 'five metadata preimages required'; END IF;
 FOR r IN SELECT * FROM v31_policy_metadata_preimages LOOP
  EXECUTE pg_temp.v31_policy_metadata_patch(r.signature,r.definition);
 END LOOP;
END; $apply$;
DO $post$
DECLARE r record; actual text;
BEGIN
 FOR r IN SELECT * FROM v31_policy_metadata_preimages LOOP
  SELECT pg_get_functiondef(oid) INTO actual FROM pg_proc WHERE oid=r.oid;
  IF actual IS DISTINCT FROM pg_temp.v31_policy_metadata_patch(r.signature,r.definition)
   OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=r.oid AND p.proowner=r.proowner
    AND p.proacl IS NOT DISTINCT FROM r.proacl AND p.proconfig IS NOT DISTINCT FROM r.proconfig AND p.prosecdef=r.prosecdef)
   THEN RAISE EXCEPTION 'policy metadata postimage or permissions changed: %',r.signature; END IF;
 END LOOP;
 IF NOT public.fn_gto_v31_policy_request_valid('{}'::jsonb)
  OR public.fn_gto_v31_policy_identity(NULL) <> '{}'::jsonb
  OR NOT public.fn_gto_v31_policy_request_valid('{"policy_export_schema":"smarter-poker.pio-policy.v4"}'::jsonb)
  OR public.fn_gto_v31_policy_request_valid('{"policy_export_schema":null}'::jsonb)
  OR public.fn_gto_v31_policy_request_valid('{"policy_export_schema":"smarter-poker.pio-policy.v3"}'::jsonb)
  OR public.fn_gto_v31_policy_request_valid('{"policy_export_schema":"unknown"}'::jsonb)
 THEN RAISE EXCEPTION 'policy schema opt-in contract failed'; END IF;
END; $post$;
COMMIT;
