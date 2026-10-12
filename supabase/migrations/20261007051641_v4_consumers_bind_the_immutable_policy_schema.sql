-- 20261007051641_v4_consumers_bind_the_immutable_policy_schema.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
-- TIER 3: append nullable policy metadata to two service-only RPC result types.
-- WHY: V4 dataset identity must survive transport, evaluation configuration and
-- actual decision receipts. This does NOT qualify a complete-state policy model.
-- Legacy NULL is omitted by consumers; explicit NULL/unknown JSON is rejected.
-- EXECUTABLE FUNCTION-ONLY ROLLBACK (from the owning repository, configured psql):
-- Stop V4 admission/promotion first. No schema/row rewrite or historical DDL replay.
-- node <<'ROLLBACK_JS' | psql -X -v ON_ERROR_STOP=1
-- const fs=require('fs');
-- const source=fs.readFileSync('supabase/migrations/20261007030040_the_solver_binds_immutable_feature_contracts.sql','utf8');
-- const names=['fn_gto_v31_active_cells','fn_gto_v31_evaluation_cells','fn_gto_v31_record_evaluation','fn_gto_v31_candidate_evaluations_valid','fn_horse_solver_agreement_v31_decision'];
-- const blocks=names.map(n=>{const match=new RegExp('^CREATE OR REPLACE FUNCTION public\\.'+n+'\\(','m').exec(source);if(!match)throw Error('missing immutable function '+n);const start=match.index;const end=source.indexOf('$fn$;',start)+5;if(end<5)throw Error('unterminated immutable function '+n);return source.slice(start,end);});
-- const old='^[0-9a-f]{8}-[0-9a-f]{4}-[1-'+'5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
-- const shape='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
-- if(blocks[4].split(old).length!==2)throw Error('UUID correction source differs');
-- blocks[4]=blocks[4].replace(old,shape);
-- console.log("BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='60s'; LOCK TABLE public.gto_v31_datasets IN SHARE ROW EXCLUSIVE MODE; DO $guard$ BEGIN IF EXISTS(SELECT 1 FROM public.gto_v31_datasets WHERE state='active' AND policy_export_schema IS NOT NULL) THEN RAISE EXCEPTION 'active V4 dataset cannot rollback'; END IF; END; $guard$;");
-- console.log("CREATE TEMP TABLE v4_rollback_rpc_owners ON COMMIT DROP AS SELECT oid::regprocedure::text signature,proowner FROM pg_proc WHERE oid IN ('public.fn_gto_v31_active_cells(integer,integer)'::regprocedure,'public.fn_gto_v31_evaluation_cells(uuid,integer,integer)'::regprocedure);");
-- console.log('DROP FUNCTION public.fn_gto_v31_active_cells(integer,integer); DROP FUNCTION public.fn_gto_v31_evaluation_cells(uuid,integer,integer);');
-- console.log(blocks.join('\n'));
-- console.log("DO $owners$ DECLARE r record; BEGIN FOR r IN SELECT * FROM v4_rollback_rpc_owners LOOP EXECUTE format('ALTER FUNCTION public.%s OWNER TO %I',r.signature,pg_get_userbyid(r.proowner)); END LOOP; END; $owners$;");
-- for(const sig of ['fn_gto_v31_active_cells(integer,integer)','fn_gto_v31_evaluation_cells(uuid,integer,integer)'])console.log('REVOKE ALL ON FUNCTION public.'+sig+' FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.'+sig+' TO service_role;');
-- console.log('COMMIT;');
-- ROLLBACK_JS
CREATE TEMP TABLE v31_v4_consumer_preimages ON COMMIT DROP AS
 SELECT oid,oid::regprocedure::text signature,pg_get_functiondef(oid) definition,
 proowner,proacl,proconfig,prosecdef FROM pg_proc WHERE oid IN
 ('public.fn_gto_v31_active_cells(integer,integer)'::regprocedure,
 'public.fn_gto_v31_evaluation_cells(uuid,integer,integer)'::regprocedure,
 'public.fn_gto_v31_record_evaluation(uuid,text,text,bigint)'::regprocedure,
 'public.fn_gto_v31_candidate_evaluations_valid(uuid,text)'::regprocedure,
 'public.fn_horse_solver_agreement_v31_decision(jsonb)'::regprocedure);
CREATE FUNCTION pg_temp.v31_v4_consumer_replace(p_definition text,p_anchor text,p_replacement text)
RETURNS text LANGUAGE plpgsql AS $fn$
BEGIN
 IF (length(p_definition)-length(replace(p_definition,p_anchor,'')))/length(p_anchor)<>1 THEN
  RAISE EXCEPTION 'V4 consumer source anchor differs: %',p_anchor; END IF;
 RETURN replace(p_definition,p_anchor,p_replacement);
END;
$fn$;
CREATE FUNCTION pg_temp.v31_v4_consumer_patch(p_signature text,p_definition text)
RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE result text:=p_definition; anchor text;
BEGIN
 IF p_signature IN ('fn_gto_v31_active_cells(integer,integer)','fn_gto_v31_evaluation_cells(uuid,integer,integer)') THEN
  result:=pg_temp.v31_v4_consumer_replace(result,'feature_contract_version text)',
    'feature_contract_version text, policy_export_schema text)');
  result:=pg_temp.v31_v4_consumer_replace(result,'c.action_ev_matrix,d.feature_contract_version',
    'c.action_ev_matrix,d.feature_contract_version,d.policy_export_schema');
  result:=pg_temp.v31_v4_consumer_replace(result,
   'b.feature_contract_version IS NOT DISTINCT FROM d.feature_contract_version',
   'b.feature_contract_version IS NOT DISTINCT FROM d.feature_contract_version AND b.policy_export_schema IS NOT DISTINCT FROM d.policy_export_schema');
  result:=pg_temp.v31_v4_consumer_replace(result,
   'c.feature_contract_version IS NOT DISTINCT FROM d.feature_contract_version',
   'c.feature_contract_version IS NOT DISTINCT FROM d.feature_contract_version AND c.policy_export_schema IS NOT DISTINCT FROM d.policy_export_schema');
 ELSIF p_signature='fn_gto_v31_record_evaluation(uuid,text,text,bigint)' THEN
  anchor:='(8 + CASE WHEN v_dataset.feature_contract_version IS NULL THEN 0 ELSE 1 END)';
  result:=pg_temp.v31_v4_consumer_replace(result,anchor,
   '(8 + CASE WHEN v_dataset.feature_contract_version IS NULL THEN 0 ELSE 1 END + CASE WHEN v_dataset.policy_export_schema IS NULL THEN 0 ELSE 1 END)');
  anchor:='OR NOT public.fn_gto_v31_feature_request_valid(v_result.config_a)';
  result:=pg_temp.v31_v4_consumer_replace(result,anchor,anchor||'
     OR NOT public.fn_gto_v31_policy_request_valid(v_result.config_a)
     OR v_result.config_a->>''policy_export_schema'' IS DISTINCT FROM v_dataset.policy_export_schema');
 ELSIF p_signature='fn_gto_v31_candidate_evaluations_valid(uuid,text)' THEN
  result:=pg_temp.v31_v4_consumer_replace(result,'v_feature_version text;',
   'v_feature_version text; v_policy_schema text;');
  result:=pg_temp.v31_v4_consumer_replace(result,
   'SELECT feature_contract_version INTO v_feature_version FROM public.gto_v31_datasets',
   'SELECT feature_contract_version,policy_export_schema INTO v_feature_version,v_policy_schema FROM public.gto_v31_datasets');
  anchor:='(8 + CASE WHEN v_feature_version IS NULL THEN 0 ELSE 1 END)';
  result:=pg_temp.v31_v4_consumer_replace(result,anchor,
   '(8 + CASE WHEN v_feature_version IS NULL THEN 0 ELSE 1 END + CASE WHEN v_policy_schema IS NULL THEN 0 ELSE 1 END)');
  anchor:='OR NOT public.fn_gto_v31_feature_request_valid(r.config_a)';
  result:=pg_temp.v31_v4_consumer_replace(result,anchor,anchor||'
        OR NOT public.fn_gto_v31_policy_request_valid(r.config_a)
        OR r.config_a->>''policy_export_schema'' IS DISTINCT FROM v_policy_schema');
 ELSIF p_signature='fn_horse_solver_agreement_v31_decision(jsonb)' THEN
  anchor:='(25 + CASE WHEN v_seal ? ''feature_contract_version'' THEN 1 ELSE 0 END)';
  result:=pg_temp.v31_v4_consumer_replace(result,anchor,
   '(25 + CASE WHEN v_seal ? ''feature_contract_version'' THEN 1 ELSE 0 END + CASE WHEN v_seal ? ''policy_export_schema'' THEN 1 ELSE 0 END)');
  anchor:='OR NOT public.fn_gto_v31_feature_request_valid(v_seal)';
  result:=pg_temp.v31_v4_consumer_replace(result,anchor,anchor||'
     OR NOT public.fn_gto_v31_policy_request_valid(v_seal)');
  anchor:='OR v_seal->>''feature_contract_version'' IS DISTINCT FROM v_dataset.feature_contract_version';
  result:=pg_temp.v31_v4_consumer_replace(result,anchor,anchor||'
     OR v_seal->>''policy_export_schema'' IS DISTINCT FROM v_dataset.policy_export_schema');
 ELSE RAISE EXCEPTION 'unknown V4 consumer signature'; END IF;
 RETURN result;
END;
$fn$;
DO $install$
DECLARE r record; new_oid oid; expected text;
BEGIN
 IF (SELECT count(*) FROM v31_v4_consumer_preimages)<>5 THEN RAISE EXCEPTION 'V4 consumer signatures missing'; END IF;
 FOR r IN SELECT * FROM v31_v4_consumer_preimages LOOP
  RAISE NOTICE 'V31_V4_CONSUMER_PREIMAGE % %',r.signature,md5(r.definition);
  expected:=CASE r.signature
   WHEN 'fn_gto_v31_active_cells(integer,integer)' THEN '1e27111cd6fb2a09b7aacae4ee70ca19'
   WHEN 'fn_gto_v31_evaluation_cells(uuid,integer,integer)' THEN '670a56035ca08585227316a3f1762457'
   WHEN 'fn_gto_v31_record_evaluation(uuid,text,text,bigint)' THEN '2b3e08f2e3c9bb556f428448d0691a6c'
   WHEN 'fn_gto_v31_candidate_evaluations_valid(uuid,text)' THEN '3480ba5540f5cbf61d6865b8c078a6f6'
   WHEN 'fn_horse_solver_agreement_v31_decision(jsonb)' THEN '684f176044ec6ebfee63798e504cfc47' END;
  IF md5(r.definition) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'V4 consumer exact preimage differs: %',r.signature; END IF;
  IF r.signature IN ('fn_gto_v31_active_cells(integer,integer)','fn_gto_v31_evaluation_cells(uuid,integer,integer)') THEN
   IF EXISTS(SELECT 1 FROM pg_depend WHERE refclassid='pg_proc'::regclass AND refobjid=r.oid AND deptype<>'i') THEN
    RAISE EXCEPTION 'V4 RPC has dependent objects'; END IF;
   EXECUTE 'DROP FUNCTION public.'||r.signature;
  END IF;
  EXECUTE pg_temp.v31_v4_consumer_patch(r.signature,r.definition);
  new_oid:=('public.'||r.signature)::regprocedure;
  EXECUTE format('ALTER FUNCTION public.%s OWNER TO %I',r.signature,pg_get_userbyid(r.proowner));
  IF r.signature IN ('fn_gto_v31_active_cells(integer,integer)','fn_gto_v31_evaluation_cells(uuid,integer,integer)') THEN
   EXECUTE 'REVOKE ALL ON FUNCTION public.'||r.signature||' FROM PUBLIC,anon,authenticated';
   EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||r.signature||' TO service_role';
  END IF;
  RAISE NOTICE 'V31_V4_CONSUMER_POSTIMAGE % %',r.signature,md5(pg_get_functiondef(new_oid));
 END LOOP;
END;
$install$;
DO $post$
DECLARE r record; p record;
BEGIN
 FOR r IN SELECT * FROM v31_v4_consumer_preimages LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=('public.'||r.signature)::regprocedure;
  IF pg_get_functiondef(p.oid) IS DISTINCT FROM pg_temp.v31_v4_consumer_patch(r.signature,r.definition)
   OR p.proowner<>r.proowner OR p.proacl IS DISTINCT FROM r.proacl
   OR p.proconfig IS DISTINCT FROM r.proconfig OR p.prosecdef<>r.prosecdef THEN
   RAISE EXCEPTION 'V4 consumer metadata or function differs: %',r.signature; END IF;
 END LOOP;
 IF public.fn_gto_v31_policy_request_valid('{"policy_export_schema":null}'::jsonb)
 OR public.fn_gto_v31_policy_request_valid('{"policy_export_schema":"unknown"}'::jsonb)
 OR NOT public.fn_gto_v31_policy_request_valid('{}'::jsonb) THEN
  RAISE EXCEPTION 'legacy omission/V4 identity boundary differs'; END IF;
END;
$post$;
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_active_cells(integer,integer)'::regprocedure)) = '26f9768fb47a7125b9f8a1d3bdab3105'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_evaluation_cells(uuid,integer,integer)'::regprocedure)) = 'f4254b139f66180c6342fe6c6f120434'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_record_evaluation(uuid,text,text,bigint)'::regprocedure)) = '3b101b069b9f378353790788cccd4828'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_candidate_evaluations_valid(uuid,text)'::regprocedure)) = '2c0ebbdfdeeec75b84c7287d96a97d56'
-- @live-proof: md5(pg_get_functiondef('public.fn_horse_solver_agreement_v31_decision(jsonb)'::regprocedure)) = '5c8aef1618429598d7fbcee54c5baa9e'

COMMIT;
