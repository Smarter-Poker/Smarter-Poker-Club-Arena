-- Append inside the verified creation fixture's outer transaction, before its
-- final SET CONSTRAINTS ALL IMMEDIATE. These enabled flags are explicit test
-- overrides on the accepted captured MTT config, not newly captured UI payloads.
CREATE TEMP TABLE phase3_creation_options_evidence(value jsonb) ON COMMIT DROP;
CREATE TEMP TABLE phase3_creation_options_receipt(value jsonb) ON COMMIT DROP;
GRANT INSERT, SELECT ON phase3_creation_options_receipt TO authenticated;
GRANT INSERT, SELECT ON phase3_creation_options_evidence TO authenticated;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub','f8100000-0000-4000-8000-000000000001','role','authenticated','session_id','f8300000-0000-4000-8000-000000000001')::text,true);
SELECT set_config('request.jwt.claim.sub','f8100000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;
DO $enabled_options$
DECLARE v_config jsonb; v_receipt jsonb; v_row jsonb; v_id uuid;
BEGIN
 SELECT value INTO STRICT v_config FROM phase3_creation_configs WHERE name='mtt';
 v_config:=v_config || jsonb_build_object(
  'name','CA-03-12 enabled Free Buy options',
  'type','rebuy','freeBuy',true,'buyIn',0,
  'guaranteedPrize',0,'isRebuy',true,'rebuyCost',1,'rebuyChips',1000,
  'addOnAvailable',true,'addOnCost',1,'addOnChips',2000,'addOnFromStart',true
 );
 v_receipt:=public.fn_create_tournament('f8200000-0000-4000-8000-000000000001'::uuid,v_config);
 v_id:=(v_receipt->>'tournament_id')::uuid;
 PERFORM pg_temp.creation_assert(v_id IS NOT NULL,'OPTIONS: authorized owner creates the enabled Free Buy fixture through the real RPC');
 INSERT INTO phase3_creation_options_receipt(value) VALUES(v_receipt);
END;
$enabled_options$;
RESET ROLE;
DO $enabled_options_readback$
DECLARE v_receipt jsonb; v_row jsonb; v_id uuid;
BEGIN
 SELECT value INTO STRICT v_receipt FROM phase3_creation_options_receipt;
 v_id:=(v_receipt->>'tournament_id')::uuid;
 SELECT to_jsonb(t) INTO STRICT v_row FROM public.tournaments t WHERE t.id=v_id;
 RAISE NOTICE 'TOURNAMENT_CREATE_OPTIONS_DIAGNOSTIC=%',jsonb_build_object(
  'requested_free_buy',true,'persisted_free_buy',v_row->'free_buy',
  'requested_addon_from_start',true,'persisted_addon_from_start',v_row->'addon_from_start',
  'zero_upfront_entry_and_fee',COALESCE((v_row->>'buy_in_amount')::numeric=0 AND (v_row->>'buy_in_fee')::numeric=0,false),
  'paid_rebuy_price_preserved',COALESCE((v_row->>'rebuy_cost')::numeric=1,false),
  'paid_addon_price_preserved',COALESCE((v_row->>'addon_cost')::numeric=1,false)
 );
 PERFORM pg_temp.creation_assert((v_row->>'buy_in_amount')::numeric=0 AND (v_row->>'buy_in_fee')::numeric=0,'OPTIONS: Free Buy requests zero initial entry and fee');
 PERFORM pg_temp.creation_assert((v_row->>'rebuy_cost')::numeric=1 AND (v_row->>'addon_cost')::numeric=1,'OPTIONS: enabling Free Buy preserves explicitly paid rebuy and add-on prices');
 PERFORM pg_temp.creation_assert((v_row->>'free_buy')::boolean IS TRUE,'OPTIONS: the enabled Free Buy choice persists on the created event');
 PERFORM pg_temp.creation_assert((v_row->>'addon_from_start')::boolean IS TRUE,'OPTIONS: the enabled add-ons-from-start choice persists on the created event');
 INSERT INTO phase3_creation_options_evidence(value) VALUES(jsonb_build_object(
  'enabled_settings_persist',true,'zero_initial_entry_and_fee',true,
  'paid_rebuy_and_addon_terms_preserved',true,'option_assertions',5,
  'fixture_kind','accepted_captured_mtt_config_with_explicit_enabled_option_overrides',
  'new_ui_capture_claimed',false,'real_authenticated_creator_executed',true
 ));
END;
$enabled_options_readback$;
-- The existing predicate, rather than caller flags or zero amount alone,
-- remains authoritative for financial eligibility.
DO $option_format_exclusions$
DECLARE v_row public.tournaments%ROWTYPE; v_kind text;
BEGIN
 FOREACH v_kind IN ARRAY ARRAY['sng','spin'] LOOP
  SELECT t.* INTO STRICT v_row FROM public.tournaments t JOIN phase3_creation_results r ON t.id=(r.value->>'tournament_id')::uuid WHERE r.name=v_kind;
  PERFORM pg_temp.creation_assert(public.fn_is_free_buy_event(0,0,v_row.tournament_type,v_row.variant) IS FALSE,'OPTIONS: zero entry does not turn '||v_kind||' into Free Buy');
 END LOOP;
END $option_format_exclusions$;
CREATE TEMP TABLE phase3_creation_options_policy_before(value jsonb) ON COMMIT DROP;
CREATE TEMP TABLE phase3_creation_options_policy_cases(name text PRIMARY KEY,config jsonb,expected_state text) ON COMMIT DROP;
INSERT INTO phase3_creation_options_policy_cases(name,config,expected_state)
 SELECT 'paid_free_buy',value||jsonb_build_object('name','Synthetic refused paid Free Buy','buyIn',10,'freeBuy',true,'addOnFromStart',false),'22023' FROM phase3_creation_configs WHERE name='mtt'
 UNION ALL SELECT 'paid_addon_start',value||jsonb_build_object('name','Synthetic refused paid early addon','buyIn',10,'freeBuy',false,'addOnFromStart',true),'22023' FROM phase3_creation_configs WHERE name='mtt'
 UNION ALL SELECT 'spin_flags',value||jsonb_build_object('name','Synthetic refused Spin flags','freeBuy',true,'addOnFromStart',true),'22023' FROM phase3_creation_configs WHERE name='spin'
 UNION ALL SELECT 'sng_flags',value||jsonb_build_object('name','Synthetic refused SNG flags','freeBuy',true,'addOnFromStart',true),'22023' FROM phase3_creation_configs WHERE name='sng'
 UNION ALL SELECT 'malformed_free_buy',value||jsonb_build_object('name','Synthetic refused malformed Free Buy','freeBuy','not-a-boolean','addOnFromStart',false),'22P02' FROM phase3_creation_configs WHERE name='mtt'
 UNION ALL SELECT 'malformed_addon_start',value||jsonb_build_object('name','Synthetic refused malformed early addon','freeBuy',false,'addOnFromStart','not-a-boolean'),'22P02' FROM phase3_creation_configs WHERE name='mtt';
GRANT SELECT ON phase3_creation_options_policy_cases TO authenticated;
INSERT INTO phase3_creation_options_policy_before(value) VALUES(to_jsonb(pg_temp.creation_state()));
SET LOCAL ROLE authenticated;
DO $option_policy_refusals$
DECLARE v_case record; v_state text; v_refused boolean;
BEGIN
 FOR v_case IN SELECT * FROM phase3_creation_options_policy_cases ORDER BY name LOOP
  v_refused:=false;v_state:=NULL;
  BEGIN
   PERFORM public.fn_create_tournament('f8200000-0000-4000-8000-000000000001'::uuid,v_case.config);
  EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE '22P02' THEN
   GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE;
   v_refused:=true;
  END;
  PERFORM pg_temp.creation_assert(v_refused AND v_state=v_case.expected_state,'OPTIONS: real creator refuses '||v_case.name||' without granting eligibility');
 END LOOP;
END $option_policy_refusals$;
RESET ROLE;
SELECT pg_temp.creation_assert(to_jsonb(pg_temp.creation_state())=(SELECT value FROM phase3_creation_options_policy_before),'OPTIONS: every refused option request leaves all business state unchanged');
UPDATE phase3_creation_options_evidence SET value=value||jsonb_build_object('option_assertions',14,'policy_refusal_cases',6,'zero_price_format_exclusions',2,'refusal_business_rollback',true,'canonical_eligibility_preserved',true);

SELECT set_config('request.jwt.claims','{}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','',true);
SELECT 'TOURNAMENT_CREATE_OPTIONS_EVIDENCE='||value::text FROM phase3_creation_options_evidence;
