-- TIER: 2. Function bodies only; no live-table/schema/financial writes.
-- WHY: R7 completed 107 builds/856 independent audits, but the original seal
-- hit SQLSTATE57014 at240s after a125s proxy timeout. One cell took3.549098s.
-- HOW: identical closed-model JSON bytes from linear nested aggregates;
-- unchanged generic fallback, numerical/tree rules and payload identity.
-- Existing dataset FOR UPDATE plus validated FK and child FOR SHARE locks
-- preserve the fully validated public cell set through the same seal.
-- Its duplicate public validation is reused; legacy/NULL paths are unchanged.
-- No thresholds, f64/physics/encoding, timeout, capture, training, holdout or
-- audit-generation changes. No seal request or production data is invoked.
-- Root evidence: v31-certification-01a17e88/seal-performance-diagnostics-r1.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE TEMP TABLE v31_seal_validation_preimage ON COMMIT DROP AS
 SELECT oid,to_jsonb(p)-'prosrc' metadata FROM pg_proc p WHERE oid IN (
'public.fn_gto_v31_public215_canonical(jsonb)'::regprocedure,'public.fn_gto_v31_public215_model_valid(jsonb)'::regprocedure,'public.fn_gto_v31_cell_payload_checksum(jsonb)'::regprocedure,'public.fn_gto_v31_seal_build(uuid)'::regprocedure);
DO $preflight$
DECLARE fk oid;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_public215_canonical(jsonb)'::regprocedure) NOT IN ('5ee370b7046fd44c33dbe3ea429c3a91','1860f48794d139dcf174c4294bf5dce7') THEN RAISE EXCEPTION 'V31 preimage differs: fn_gto_v31_public215_canonical'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_public215_model_valid(jsonb)'::regprocedure) NOT IN ('1c8da8eb890a2a3ab5f24e7f9eeedc48','762098f8d28855034cacd38ae2918fcb') THEN RAISE EXCEPTION 'V31 preimage differs: fn_gto_v31_public215_model_valid'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_cell_payload_checksum(jsonb)'::regprocedure) NOT IN ('70e1d9afb1762f1f9d1a368bd2883c93','1c6ca7903c209964f2c4cb442036e7de') THEN RAISE EXCEPTION 'V31 preimage differs: fn_gto_v31_cell_payload_checksum'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_seal_build(uuid)'::regprocedure) NOT IN ('ce2b0015cbde0ebca67af173968a368e','e74b379a151846969ec4b1071288c80b') THEN RAISE EXCEPTION 'V31 preimage differs: fn_gto_v31_seal_build'; END IF;
 IF to_regprocedure('public.fn_gto_v31_public215_model_canonical_fast(jsonb)') IS NOT NULL AND (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.fn_gto_v31_public215_model_canonical_fast(jsonb)'))<>'19dc4b1342d33ff48c70a1715f3fe7d0' THEN RAISE EXCEPTION 'V31 serialization helper differs'; END IF;
 SELECT oid INTO STRICT fk FROM pg_constraint WHERE conrelid='public.gto_v31_runtime_cells'::regclass AND confrelid='public.gto_v31_datasets'::regclass
 AND conname='gto_v31_runtime_cells_dataset_id_fkey' AND contype='f' AND convalidated AND NOT condeferrable AND NOT condeferred;
 IF (SELECT count(*)=4 AND bool_and(tgenabled IN ('O','A')) FROM pg_trigger WHERE tgconstraint=fk) IS NOT TRUE THEN RAISE EXCEPTION 'V31 dataset FK enforcement is absent'; END IF;
 IF (public.fn_gto_v31_public215_physics_implementation()='66f413bc9179d5b10df7c5a73547931c47a3e90fd7895c4de596c7287e98e733' AND public.fn_gto_v31_public215_encoding_implementation()='1121d3ff6873757d8560e55f397e29df8978cc8b845259bbaa2c529f40950f6d') IS NOT TRUE THEN RAISE EXCEPTION 'V31 frozen numerical implementations differ'; END IF;
END $preflight$;
-- DRAFT corrected linear nested aggregates; NULL delegates to unchanged generic canonical.
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_model_canonical_fast(p jsonb)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
WITH root AS MATERIALIZED(
 SELECT p WHERE CASE WHEN jsonb_typeof(p)='object' THEN
 p-ARRAY['format','variant','feature_count','action_ids','heads','template_sha256','feature_schema_sha256','provenance_sha256']='{}'::jsonb
 AND p?&ARRAY['format','variant','feature_count','action_ids','heads','template_sha256','feature_schema_sha256','provenance_sha256']
 AND p->>'format'='public_hist215_v1' AND jsonb_typeof(p->'format')='string'
 AND jsonb_typeof(p->'heads')='array' AND jsonb_typeof(p->'action_ids')='array'
 AND CASE WHEN jsonb_typeof(p->'feature_count')='number' THEN
  (p->'feature_count')::text~'^-?(0|[1-9][0-9]*)$' AND abs((p->>'feature_count')::numeric)<=9007199254740991 ELSE false END
 AND (SELECT bool_and(jsonb_typeof(p->k)='string' AND p->>k~'^[ -~]*$')
 FROM unnest(ARRAY['variant','template_sha256','feature_schema_sha256','provenance_sha256'])k)
 ELSE false END
)
SELECT CASE WHEN actions.valid AND heads.valid
 THEN '{"action_ids":['||actions.body||'],"feature_count":'||(r.p->'feature_count')::text||',"feature_schema_sha256":'||(r.p->'feature_schema_sha256')::text||',"format":'||(r.p->'format')::text||',"heads":['||heads.body||'],"provenance_sha256":'||(r.p->'provenance_sha256')::text||',"template_sha256":'||(r.p->'template_sha256')::text||',"variant":'||(r.p->'variant')::text||'}' END
FROM root r
CROSS JOIN LATERAL(
 SELECT COALESCE(string_agg(a.value::text,',' ORDER BY a.ordinality),'') body,
 COALESCE(bool_and(jsonb_typeof(a.value)='string' AND (a.value#>>'{}')~'^[ -~]*$'),true) valid
 FROM jsonb_array_elements(r.p->'action_ids')WITH ORDINALITY a
)actions
CROSS JOIN LATERAL(
 SELECT COALESCE(string_agg('{"baseline_f64":'||(h.value->'baseline_f64')::text||',"trees":['||trees.body||']}',',' ORDER BY h.ordinality),'') body,
 COALESCE(bool_and(CASE WHEN jsonb_typeof(h.value)='object' THEN
 h.value-ARRAY['baseline_f64','trees']='{}'::jsonb AND h.value?&ARRAY['baseline_f64','trees']
 AND jsonb_typeof(h.value->'baseline_f64')='string' AND h.value->>'baseline_f64'~'^[ -~]*$'
 AND jsonb_typeof(h.value->'trees')='array' AND trees.valid ELSE false END),true) valid
 FROM jsonb_array_elements(r.p->'heads')WITH ORDINALITY h
 CROSS JOIN LATERAL(
  SELECT COALESCE(string_agg('['||nodes.body||']',',' ORDER BY t.ordinality),'') body,
  COALESCE(bool_and(jsonb_typeof(t.value)='array' AND nodes.valid),true) valid
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(h.value->'trees')='array' THEN h.value->'trees' ELSE '[]'::jsonb END)WITH ORDINALITY t
  CROSS JOIN LATERAL(
   SELECT COALESCE(string_agg(render.token,',' ORDER BY n.ordinality),'') body,
   COALESCE(bool_and(render.token IS NOT NULL),true) valid
   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.value)='array' THEN t.value ELSE '[]'::jsonb END)WITH ORDINALITY n
   CROSS JOIN LATERAL(SELECT
 CASE WHEN jsonb_typeof(n.value)='object' THEN CASE WHEN n.value?'value_f64' THEN
  CASE WHEN n.value-'value_f64'='{}'::jsonb AND jsonb_typeof(n.value->'value_f64')='string' AND n.value->>'value_f64'~'^[ -~]*$'
   THEN '{"value_f64":'||(n.value->'value_f64')::text||'}' END
 ELSE
  CASE WHEN n.value-ARRAY['feature','threshold_f64','left','right','missing_left']='{}'::jsonb
  AND n.value?&ARRAY['feature','threshold_f64','left','right','missing_left']
  AND jsonb_typeof(n.value->'missing_left')='boolean'
  AND jsonb_typeof(n.value->'threshold_f64')='string' AND n.value->>'threshold_f64'~'^[ -~]*$'
  AND (SELECT bool_and(CASE WHEN jsonb_typeof(n.value->k)='number' THEN
    (n.value->k)::text~'^-?(0|[1-9][0-9]*)$' AND abs((n.value->>k)::numeric)<=9007199254740991 ELSE false END)
    FROM unnest(ARRAY['feature','left','right'])k)
  THEN '{"feature":'||(n.value->'feature')::text||',"left":'||(n.value->'left')::text||',"missing_left":'||(n.value->'missing_left')::text||',"right":'||(n.value->'right')::text||',"threshold_f64":'||(n.value->'threshold_f64')::text||'}' END
 END END token OFFSET 0)render
  )nodes
 )trees
)heads
$fn$;
-- DRAFT: unchanged original generic body after NULL fastpath; Root owns maintained installation.
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_canonical(p jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE fast text;t text;v record;parts text[]:=ARRAY[]::text[];
BEGIN
 fast:=public.fn_gto_v31_public215_model_canonical_fast(p);IF fast IS NOT NULL THEN RETURN fast;END IF;
 CASE jsonb_typeof(p)
 WHEN 'object' THEN
  FOR v IN SELECT key,value FROM jsonb_each(p) ORDER BY key COLLATE "C" LOOP
   IF v.key!~'^[ -~]*$' THEN RAISE EXCEPTION 'public215 canonical ASCII key';END IF;
   parts:=array_append(parts,to_jsonb(v.key)::text||':'||public.fn_gto_v31_public215_canonical(v.value));
  END LOOP;RETURN '{'||array_to_string(parts,',')||'}';
 WHEN 'array' THEN
  FOR v IN SELECT value FROM jsonb_array_elements(p) LOOP parts:=array_append(parts,public.fn_gto_v31_public215_canonical(v.value));END LOOP;RETURN '['||array_to_string(parts,',')||']';
 WHEN 'string' THEN IF (p#>>'{}')!~'^[ -~]*$' THEN RAISE EXCEPTION 'public215 canonical ASCII';END IF;RETURN p::text;
 WHEN 'number' THEN t:=p::text;IF t!~'^-?(0|[1-9][0-9]*)$' OR abs(t::numeric)>9007199254740991 OR t='-0' THEN RAISE EXCEPTION 'public215 canonical safeinteger';END IF;RETURN t;
 ELSE RETURN p::text;
 END CASE;
END $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_model_valid(p jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE acts jsonb;head jsonb;trees jsonb;tree jsonb;node jsonb;ni integer;n integer;leaves integer;visited boolean[];stack integer[];child integer;which text;f double precision;
BEGIN
 IF jsonb_typeof(p)<>'object' OR p-ARRAY['format','variant','feature_count','action_ids','heads','template_sha256','feature_schema_sha256','provenance_sha256']<>'{}'::jsonb OR NOT p?&ARRAY['format','variant','feature_count','action_ids','heads','template_sha256','feature_schema_sha256','provenance_sha256'] OR jsonb_typeof(p->'format')<>'string' OR jsonb_typeof(p->'variant')<>'string' OR p->>'format'<>'public_hist215_v1' OR p->>'variant' NOT IN('direct','coherent') OR p->'feature_count'<>'215'::jsonb THEN RETURN false;END IF;
 IF octet_length(public.fn_gto_v31_public215_canonical(p))>8388608 THEN RETURN false;END IF;
 FOREACH which IN ARRAY ARRAY['template_sha256','feature_schema_sha256','provenance_sha256'] LOOP IF jsonb_typeof(p->which)<>'string' OR p->>which!~'^[0-9a-f]{64}$' THEN RETURN false;END IF;END LOOP;
 acts:=p->'action_ids';IF jsonb_typeof(acts)<>'array' OR jsonb_array_length(acts) NOT BETWEEN 1 AND 16 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(acts))<>jsonb_array_length(acts) OR EXISTS(SELECT 1 FROM jsonb_array_elements(acts)a WHERE jsonb_typeof(a)<>'string' OR a#>>'{}'!~'^[A-Za-z0-9_.:-]{1,96}$' OR a#>>'{}' IN('__proto__','prototype','constructor')) THEN RETURN false;END IF;
 IF jsonb_typeof(p->'heads')<>'array' OR jsonb_array_length(p->'heads')<>1+2*jsonb_array_length(acts) THEN RETURN false;END IF;
 FOR head IN SELECT value FROM jsonb_array_elements(p->'heads') LOOP
  IF jsonb_typeof(head)<>'object' OR head-ARRAY['baseline_f64','trees']<>'{}'::jsonb OR NOT head?&ARRAY['baseline_f64','trees'] THEN RETURN false;END IF;
  IF jsonb_typeof(head->'baseline_f64')<>'string' THEN RETURN false;END IF;f:=public.fn_gto_v31_public215_f64(head->>'baseline_f64');trees:=head->'trees';IF jsonb_typeof(trees)<>'array' OR jsonb_array_length(trees)<>100 THEN RETURN false;END IF;
  FOR tree IN SELECT value FROM jsonb_array_elements(trees) LOOP
   IF jsonb_typeof(tree)<>'array' OR jsonb_array_length(tree) NOT BETWEEN 1 AND 29 THEN RETURN false;END IF;
   n:=jsonb_array_length(tree);leaves:=0;
   FOR ni IN 0..n-1 LOOP
    node:=tree->ni;IF jsonb_typeof(node)<>'object' THEN RETURN false;END IF;
    IF node?'value_f64' THEN
     IF node-'value_f64'<>'{}'::jsonb OR jsonb_typeof(node->'value_f64')<>'string' THEN RETURN false;END IF;f:=public.fn_gto_v31_public215_f64(node->>'value_f64');leaves:=leaves+1;
    ELSE
     IF node-ARRAY['feature','threshold_f64','left','right','missing_left']<>'{}'::jsonb OR NOT node?&ARRAY['feature','threshold_f64','left','right','missing_left'] OR jsonb_typeof(node->'missing_left')<>'boolean' THEN RETURN false;END IF;
     FOREACH which IN ARRAY ARRAY['feature','left','right'] LOOP IF jsonb_typeof(node->which)<>'number' OR node->>which!~'^(0|[1-9][0-9]*)$' THEN RETURN false;END IF;END LOOP;
     IF (node->>'feature')::numeric>214 OR (node->>'left')::numeric>=n OR (node->>'right')::numeric>=n OR node->'left'=node->'right' THEN RETURN false;END IF;IF jsonb_typeof(node->'threshold_f64')<>'string' THEN RETURN false;END IF;f:=public.fn_gto_v31_public215_f64(node->>'threshold_f64');
    END IF;
   END LOOP;
   IF leaves>15 OR n<>2*leaves-1 THEN RETURN false;END IF;
   visited:=array_fill(false,ARRAY[n]);stack:=ARRAY[0];
   WHILE cardinality(stack)>0 LOOP
    ni:=stack[cardinality(stack)];stack:=stack[1:cardinality(stack)-1];IF visited[ni+1] THEN RETURN false;END IF;visited[ni+1]:=true;node:=tree->ni;
    IF NOT node?'value_f64' THEN stack:=stack||ARRAY[(node->>'left')::integer,(node->>'right')::integer];END IF;
   END LOOP;
   IF array_position(visited,false) IS NOT NULL THEN RETURN false;END IF;
  END LOOP;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_cell_payload_checksum(p_cell jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public AS $fn$
DECLARE identity jsonb;
BEGIN
 IF COALESCE(p_cell->>'policy_representation','matrix_v2')='matrix_v2' THEN RETURN public.fn_gto_v31_cell_payload_checksum_matrix_v2(p_cell);END IF;
 IF p_cell->>'policy_representation'<>'public_hist215_v1' THEN RAISE EXCEPTION 'unknown policy representation';END IF;
 identity:=jsonb_build_object('contract','public_hist215_cell_payload_v1',
 'cell_key_checksum',p_cell->'cell_key_checksum',
 'street',p_cell->'street',
 'game_family',p_cell->'game_family',
 'objective',p_cell->'objective',
 'utility_context',p_cell->'utility_context',
 'table_size',p_cell->'table_size',
 'pot_type',p_cell->'pot_type',
 'hero_position',p_cell->'hero_position',
 'opponent_position',p_cell->'opponent_position',
 'depth_bucket',p_cell->'depth_bucket',
 'texture_class',p_cell->'texture_class',
 'node_role',p_cell->'node_role',
 'facing_kind',p_cell->'facing_kind',
 'facing_size_bucket',p_cell->'facing_size_bucket',
 'feature_contract_version',p_cell->'feature_contract_version',
 'policy_export_schema',p_cell->'policy_export_schema',
 'policy_representation',p_cell->'policy_representation',
 'action_specs',p_cell->'action_specs',
 'public_model',p_cell->'public_model',
 'public_template',p_cell->'public_template',
 'public_training_provenance',p_cell->'public_training_provenance',
 'public_model_build_receipt',p_cell->'public_model_build_receipt',
 'model_checksum',p_cell->'model_checksum',
 'template_checksum',p_cell->'template_checksum',
 'feature_schema_checksum',p_cell->'feature_schema_checksum',
 'training_provenance_checksum',p_cell->'training_provenance_checksum',
 'model_build_receipt_checksum',p_cell->'model_build_receipt_checksum',
 'sql_physics_checksum',p_cell->'sql_physics_checksum',
 'source_rows',p_cell->'source_rows',
 'train_source_rows',p_cell->'train_source_rows',
 'holdout_source_rows',p_cell->'holdout_source_rows',
 'lineage_checksum',p_cell->'lineage_checksum');
 RETURN public.fn_gto_v31_json_checksum(identity);
END $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_seal_build(p_dataset_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
 SET statement_timeout TO '240s'
 SET lock_timeout TO '1s'
AS $function$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_cells bigint;
  v_source bigint;
  v_train bigint;
  v_holdout bigint;
  v_source_nodes bigint;
  v_receipts bigint;
  v_checksum text;
  v_source_checksum text;
  v_coverage jsonb;
  v_metrics jsonb;
  v_metric_checksum text;
  v_frequency_mae numeric;
  v_sizing_mae numeric;
  v_policy_mae numeric;
  v_regret numeric;
  v_regret_coverage numeric;
  v_frequency_observations bigint;
  v_sizing_observations bigint;
  v_policy_observations bigint;
  v_regret_observations bigint;
  v_live_observations bigint;
  v_missing bigint;
  v_pass boolean;
  v_family text;
  v_family_metrics jsonb;
  v_by_family jsonb := '{}'::jsonb;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='building' FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND (c.feature_contract_version IS DISTINCT FROM v_dataset.feature_contract_version OR c.policy_export_schema IS DISTINCT FROM v_dataset.policy_export_schema)) THEN RAISE EXCEPTION 'cell feature version differs from dataset'; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not building'; END IF;
  IF v_dataset.policy_representation='public_hist215_v1' THEN
    PERFORM c.cell_id FROM public.gto_v31_runtime_cells c
      WHERE c.dataset_id=p_dataset_id ORDER BY c.cell_key_checksum FOR SHARE;
  END IF;
  IF public.fn_gto_v31_public215_dataset_models_valid(v_dataset) IS NOT TRUE THEN RAISE EXCEPTION 'numeric model set/source authority/SQL implementation differs from immutable dataset';END IF;
  PERFORM public.fn_gto_v31_assert_source_contract(n.value,v_dataset.policy_export_schema,v_dataset.icm_model_checksum)
    FROM public.gto_v31_source_artifacts a
    JOIN public.solved_spots_gold s ON s.id=a.source_row_id
    CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
   WHERE a.dataset_id=p_dataset_id;
  IF NOT EXISTS (
    SELECT 1 FROM public.gto_v31_input_bundles b
     WHERE b.input_bundle_id=v_dataset.input_bundle_id
       AND b.approval_status='approved' AND b.bundle_checksum=v_dataset.input_bundle_checksum
       AND b.feature_contract_version IS NOT DISTINCT FROM v_dataset.feature_contract_version
       AND b.range_bundle_checksum=v_dataset.range_bundle_checksum
       AND b.source_combo_order_checksum=v_dataset.source_combo_order_checksum
       AND b.icm_model_checksum=v_dataset.icm_model_checksum
  ) THEN RAISE EXCEPTION 'dataset input approval is absent or revoked'; END IF;

  SELECT count(*),COALESCE(sum(source_rows),0),COALESCE(sum(train_source_rows),0),
         COALESCE(sum(holdout_source_rows),0)
    INTO v_cells,v_source,v_train,v_holdout
    FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;
  IF v_cells=0 OR jsonb_array_length(v_dataset.declared_coverage)<>v_cells
     OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(v_dataset.declared_coverage))<>v_cells
     OR EXISTS (
       SELECT 1 FROM public.gto_v31_runtime_cells c
        WHERE c.dataset_id=p_dataset_id AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(v_dataset.declared_coverage) d(value)
           WHERE d.value=jsonb_build_object(
             'street',c.street,'game_family',c.game_family,'objective',c.objective,
             'utility_context',c.utility_context,'table_size',c.table_size,
             'pot_type',c.pot_type,'hero_position',c.hero_position,
             'opponent_position',c.opponent_position,'depth_bucket',c.depth_bucket,
             'texture_class',c.texture_class,'node_role',c.node_role,
             'facing_kind',c.facing_kind,'facing_size_bucket',c.facing_size_bucket)))
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_dataset.declared_coverage) d(value)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id
           AND d.value=jsonb_build_object(
             'street',c.street,'game_family',c.game_family,'objective',c.objective,
             'utility_context',c.utility_context,'table_size',c.table_size,
             'pot_type',c.pot_type,'hero_position',c.hero_position,
             'opponent_position',c.opponent_position,'depth_bucket',c.depth_bucket,
             'texture_class',c.texture_class,'node_role',c.node_role,
             'facing_kind',c.facing_kind,'facing_size_bucket',c.facing_size_bucket))) THEN
    RAISE EXCEPTION 'runtime cells do not exactly equal declared coverage';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND street='flop')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND street='turn')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND street='river')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='cash' AND objective='cash_ev')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='spin' AND objective='chip_ev')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='spin' AND objective='icm')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='tourney_ev' AND objective='chip_ev')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='tourney_icm' AND objective='icm')
     OR EXISTS (
       SELECT 1
         FROM (VALUES ('cash','cash_ev'),('spin','chip_ev'),('spin','icm'),
                      ('tourney_ev','chip_ev'),('tourney_icm','icm'))
              required_family(game_family,objective)
         CROSS JOIN unnest(ARRAY['flop','turn','river']) required_street(street)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.gto_v31_runtime_cells c
           WHERE c.dataset_id=p_dataset_id
             AND c.game_family=required_family.game_family
             AND c.objective=required_family.objective
             AND c.street=required_street.street))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['limped','srp','3bet','4bet_plus']) required(value)
       WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.pot_type=required.value))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder']) required(value)
       WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.utility_context=required.value))
     OR EXISTS (SELECT 1 FROM generate_series(2,10) required(value)
       WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.table_size=required.value))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in']) required(value)
       WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.node_role=required.value)) THEN
    RAISE EXCEPTION 'required Phase 4 street, family, utility, table, pot, or response coverage is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.gto_v31_runtime_cells c
     WHERE c.dataset_id=p_dataset_id
       AND (c.cell_key_checksum<>public.fn_gto_v31_cell_key_checksum(to_jsonb(c))
         OR c.cell_payload_checksum<>public.fn_gto_v31_cell_payload_checksum(to_jsonb(c))
         OR c.source_rows<>c.train_source_rows+c.holdout_source_rows
         OR CASE WHEN v_dataset.policy_representation='public_hist215_v1' THEN false
                 ELSE NOT public.fn_gto_v31_cell_payload_valid(to_jsonb(c)) END)
  ) THEN RAISE EXCEPTION 'a compact cell seal or payload no longer validates'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.gto_v31_runtime_cells c
    LEFT JOIN LATERAL (
      SELECT count(*) n,count(*) FILTER (WHERE r.split='train') train_n,
             count(*) FILTER (WHERE r.split='holdout') holdout_n,
             encode(digest(string_agg(r.source_row_id::text||':'||r.source_node||':'||
               r.source_node_checksum,'' ORDER BY r.source_row_id::text,r.source_node),'sha256'),'hex') lineage
        FROM public.gto_v31_cell_source_receipts r WHERE r.cell_id=c.cell_id
    ) x ON true
     WHERE c.dataset_id=p_dataset_id AND
       (x.n<>c.source_rows OR x.train_n<>c.train_source_rows OR x.holdout_n<>c.holdout_source_rows
        OR x.lineage IS DISTINCT FROM c.lineage_checksum)
  ) THEN RAISE EXCEPTION 'cell source receipts do not reconcile'; END IF;
  SELECT COALESCE(sum(node_count),0) INTO v_source_nodes
    FROM public.gto_v31_source_artifacts WHERE dataset_id=p_dataset_id;
  SELECT count(*) INTO v_receipts FROM public.gto_v31_cell_source_receipts WHERE dataset_id=p_dataset_id;
  IF v_source_nodes<>v_receipts OR v_source<>v_receipts
     OR EXISTS (
       SELECT 1 FROM public.gto_v31_source_artifacts a
       LEFT JOIN public.solved_spots_gold s ON s.id=a.source_row_id
        WHERE a.dataset_id=p_dataset_id AND (s.id IS NULL OR s.quality_status<>'validated'
          OR s.audited_at IS NULL OR s.source_artifact_checksum<>a.source_artifact_checksum
          OR s.source_artifact_checksum<>public.fn_gto_v31_source_artifact_checksum(s.scenario_hash,s.strategy_matrix_v2)
          OR s.solver_version<>v_dataset.solver_version
          OR s.solver_binary_checksum<>v_dataset.solver_binary_checksum
          OR s.machine_id<>a.machine_id OR s.pipeline_commit<>v_dataset.pipeline_commit
          OR s.pipeline_bundle_checksum<>v_dataset.pipeline_bundle_checksum
          OR s.manifest_version::text<>v_dataset.manifest_version
          OR s.manifest_checksum<>v_dataset.manifest_checksum)) THEN
    RAISE EXCEPTION 'source artifacts are missing, omitted, quarantined, or changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gto_v31_cell_source_receipts WHERE dataset_id=p_dataset_id AND machine_id='M1')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_cell_source_receipts WHERE dataset_id=p_dataset_id AND machine_id='M2') THEN
    RAISE EXCEPTION 'dataset provenance does not include both solver hosts';
  END IF;

  v_metrics:=public.fn_gto_v31_heldout_metrics(p_dataset_id,NULL);
  v_frequency_mae:=(v_metrics->>'frequency_mae')::numeric;
  v_sizing_mae:=(v_metrics->>'sizing_mae')::numeric;
  v_policy_mae:=(v_metrics->>'policy_ev_mae_bb')::numeric;
  v_regret:=(v_metrics->>'mean_action_regret_bb')::numeric;
  v_regret_coverage:=(v_metrics->>'regret_coverage')::numeric;
  v_frequency_observations:=COALESCE((v_metrics->>'frequency_observations')::bigint,0);
  v_sizing_observations:=COALESCE((v_metrics->>'sizing_observations')::bigint,0);
  v_policy_observations:=COALESCE((v_metrics->>'policy_ev_observations')::bigint,0);
  v_regret_observations:=COALESCE((v_metrics->>'regret_observations')::bigint,0);
  v_live_observations:=COALESCE((v_metrics->>'live_combo_observations')::bigint,0);
  v_missing:=COALESCE((v_metrics->>'missing_observations')::bigint,0);
  IF v_missing<>0 OR v_frequency_observations=0 OR v_sizing_observations=0
     OR v_policy_observations=0
     OR v_regret_observations=0 OR v_live_observations=0
     OR v_frequency_mae IS NULL OR v_sizing_mae IS NULL OR v_policy_mae IS NULL
     OR v_regret IS NULL OR v_regret_coverage IS NULL THEN
    RAISE EXCEPTION 'heldout observations are incomplete or absent';
  END IF;
  v_pass:=v_frequency_mae<=(v_dataset.quality_gates->>'max_frequency_mae')::numeric
    AND v_sizing_mae<=(v_dataset.quality_gates->>'max_sizing_mae')::numeric
    AND v_policy_mae<=(v_dataset.quality_gates->>'max_policy_ev_mae_bb')::numeric
    AND v_regret<=(v_dataset.quality_gates->>'max_action_regret_bb')::numeric
    AND v_regret_coverage>=(v_dataset.quality_gates->>'min_regret_coverage')::numeric;

  FOREACH v_family IN ARRAY ARRAY['cash','spin','tourney_ev','tourney_icm'] LOOP
    v_family_metrics:=public.fn_gto_v31_heldout_metrics(p_dataset_id,v_family);
    IF COALESCE((v_family_metrics->>'frequency_observations')::bigint,0)=0
       OR COALESCE((v_family_metrics->>'sizing_observations')::bigint,0)=0
       OR COALESCE((v_family_metrics->>'policy_ev_observations')::bigint,0)=0
       OR COALESCE((v_family_metrics->>'regret_observations')::bigint,0)=0
       OR COALESCE((v_family_metrics->>'missing_observations')::bigint,0)<>0 THEN
      RAISE EXCEPTION 'heldout observations are incomplete for family %',v_family;
    END IF;
    v_family_metrics:=v_family_metrics||jsonb_build_object('validated',
      (v_family_metrics->>'frequency_mae')::numeric<=(v_dataset.quality_gates->>'max_frequency_mae')::numeric
      AND (v_family_metrics->>'sizing_mae')::numeric<=(v_dataset.quality_gates->>'max_sizing_mae')::numeric
      AND (v_family_metrics->>'policy_ev_mae_bb')::numeric<=(v_dataset.quality_gates->>'max_policy_ev_mae_bb')::numeric
      AND (v_family_metrics->>'mean_action_regret_bb')::numeric<=(v_dataset.quality_gates->>'max_action_regret_bb')::numeric
      AND (v_family_metrics->>'regret_coverage')::numeric>=(v_dataset.quality_gates->>'min_regret_coverage')::numeric);
    v_pass:=v_pass AND (v_family_metrics->>'validated')::boolean;
    v_by_family:=v_by_family||jsonb_build_object(v_family,v_family_metrics);
  END LOOP;

  v_metrics:=v_metrics||jsonb_build_object('validated',v_pass,'by_family',v_by_family);
  v_metric_checksum:=public.fn_gto_v31_json_checksum(v_metrics);
  v_metrics:=v_metrics||jsonb_build_object('metrics_checksum',v_metric_checksum);

  SELECT jsonb_build_object('cells',count(*),'streets',jsonb_agg(DISTINCT street),
    'families',jsonb_agg(DISTINCT game_family||':'||objective),
    'utility_contexts',jsonb_agg(DISTINCT utility_context),
    'table_sizes',jsonb_agg(DISTINCT table_size),'pot_types',jsonb_agg(DISTINCT pot_type),
    'node_roles',jsonb_agg(DISTINCT node_role),'complete',true)
    INTO v_coverage FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;
  SELECT encode(digest(string_agg(DISTINCT source_artifact_checksum,'' ORDER BY source_artifact_checksum),'sha256'),'hex')
    INTO v_source_checksum FROM public.gto_v31_source_artifacts WHERE dataset_id=p_dataset_id;
  SELECT encode(digest(v_dataset.dataset_key||':'||v_dataset.pipeline_bundle_checksum||':'||
    v_dataset.manifest_checksum||':'||
    v_dataset.input_bundle_checksum||':'||CASE WHEN v_dataset.feature_contract_version IS NULL THEN '' ELSE v_dataset.feature_contract_version||':' END||CASE WHEN v_dataset.policy_export_schema IS NULL THEN '' ELSE v_dataset.policy_export_schema||':' END||string_agg(cell_key_checksum||':'||
      cell_payload_checksum||':'||lineage_checksum,'' ORDER BY cell_key_checksum),'sha256'),'hex')
    INTO v_checksum FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;

  UPDATE public.gto_v31_datasets SET
    state=CASE WHEN v_pass THEN 'evaluating' ELSE 'rejected' END,
    quality_status=CASE WHEN v_pass THEN 'validated' ELSE 'rejected' END,
    source_rows=v_source,train_source_rows=v_train,holdout_source_rows=v_holdout,
    invalid_rows=0,source_artifact_checksum=v_source_checksum,dataset_checksum=v_checksum,
    coverage=v_coverage,heldout_metrics=v_metrics,sealed_at=now(),audited_at=now()
   WHERE dataset_id=p_dataset_id;
  INSERT INTO public.gto_v31_release_evaluations (
    dataset_id,dataset_checksum,evaluation_kind,game_family,verdict,metrics,result_checksum
  ) VALUES (
    p_dataset_id,v_checksum,'heldout','all',CASE WHEN v_pass THEN 'pass' ELSE 'fail' END,
    v_metrics,public.fn_gto_v31_json_checksum(jsonb_build_object(
      'dataset_checksum',v_checksum,'kind','heldout','family','all','metrics',v_metrics))
  );
  RETURN v_checksum;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_model_canonical_fast(jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $verify$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_temp.v31_seal_validation_preimage b JOIN pg_proc p ON p.oid=b.oid WHERE (to_jsonb(p)-'prosrc') IS DISTINCT FROM b.metadata)
 OR (SELECT count(*) FROM pg_temp.v31_seal_validation_preimage)<>4 THEN RAISE EXCEPTION 'V31 OID/signature/owner/ACL/settings changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid='public.fn_gto_v31_public215_model_canonical_fast(jsonb)'::regprocedure AND a.grantee<>p.proowner) THEN RAISE EXCEPTION 'V31 serialization helper must remain internal'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_public215_model_canonical_fast(jsonb)'::regprocedure)<>'19dc4b1342d33ff48c70a1715f3fe7d0' THEN RAISE EXCEPTION 'V31 postimage differs: fn_gto_v31_public215_model_canonical_fast'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_public215_canonical(jsonb)'::regprocedure)<>'1860f48794d139dcf174c4294bf5dce7' THEN RAISE EXCEPTION 'V31 postimage differs: fn_gto_v31_public215_canonical'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_public215_model_valid(jsonb)'::regprocedure)<>'762098f8d28855034cacd38ae2918fcb' THEN RAISE EXCEPTION 'V31 postimage differs: fn_gto_v31_public215_model_valid'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_cell_payload_checksum(jsonb)'::regprocedure)<>'1c6ca7903c209964f2c4cb442036e7de' THEN RAISE EXCEPTION 'V31 postimage differs: fn_gto_v31_cell_payload_checksum'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_seal_build(uuid)'::regprocedure)<>'e74b379a151846969ec4b1071288c80b' THEN RAISE EXCEPTION 'V31 postimage differs: fn_gto_v31_seal_build'; END IF;
 IF (public.fn_gto_v31_public215_physics_implementation()='66f413bc9179d5b10df7c5a73547931c47a3e90fd7895c4de596c7287e98e733' AND public.fn_gto_v31_public215_encoding_implementation()='1121d3ff6873757d8560e55f397e29df8978cc8b845259bbaa2c529f40950f6d') IS NOT TRUE THEN RAISE EXCEPTION 'V31 numerical implementations changed'; END IF;
END $verify$;
COMMIT;
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_public215_model_canonical_fast(jsonb)'::regprocedure)='19dc4b1342d33ff48c70a1715f3fe7d0' AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_public215_canonical(jsonb)'::regprocedure)='1860f48794d139dcf174c4294bf5dce7' AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_public215_model_valid(jsonb)'::regprocedure)='762098f8d28855034cacd38ae2918fcb' AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_cell_payload_checksum(jsonb)'::regprocedure)='1c6ca7903c209964f2c4cb442036e7de' AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_gto_v31_seal_build(uuid)'::regprocedure)='e74b379a151846969ec4b1071288c80b' AND public.fn_gto_v31_public215_physics_implementation()='66f413bc9179d5b10df7c5a73547931c47a3e90fd7895c4de596c7287e98e733' AND public.fn_gto_v31_public215_encoding_implementation()='1121d3ff6873757d8560e55f397e29df8978cc8b845259bbaa2c529f40950f6d'
