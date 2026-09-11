-- Approved release bookkeeping only. No function, trigger, balance or payment mutation.
-- Preserve exact stored SQL; align the tool-generated version to the already reserved file.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
DO $alignment$
DECLARE
 v_receipt record;
 v_runtime boolean;
 v_count integer;
BEGIN
 SELECT version,name,statements INTO v_receipt
 FROM supabase_migrations.schema_migrations
 WHERE version='20260911082105'
 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Verified generated migration row is absent'; END IF;
 IF v_receipt.name IS DISTINCT FROM 'legacy_round3_preserve_server_only_acl'
 OR cardinality(v_receipt.statements) IS DISTINCT FROM 1
 OR encode(sha256(convert_to(v_receipt.statements[1],'UTF8')),'hex') IS DISTINCT FROM 'da06b3acca81a28a54e1354932aab87d515bc3202b4922e9cccc8e1971e867d5'
 OR encode(sha256(convert_to(array_to_json(v_receipt.statements)::text,'UTF8')),'hex') IS DISTINCT FROM '6873cb7a3f80c2f4a913ff876480c3045d0ed985c31301ba8a94c3084fa616c2'
 THEN RAISE EXCEPTION 'Verified migration source or statement representation changed'; END IF;
 IF EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260911081721')
 OR (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name='legacy_round3_preserve_server_only_acl') <> 1
 THEN RAISE EXCEPTION 'Reserved migration destination or semantic identity conflict'; END IF;
 WITH expected(signature,body_md5,secdef,acl,config,argnames,defaults,result_type) AS (VALUES
 ('public.fn_claim_rakeback(uuid)','b254af98fbc6dd155ac0012438f8edea',true,ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres'],ARRAY['search_path=public, extensions'],ARRAY['p_club_id'],1,'jsonb'),
 ('public.fn_close_settlement_period(uuid)','c41f1ff29aee99e71ceecdc3fddc4e1a',true,ARRAY['postgres=X/postgres','service_role=X/postgres'],ARRAY['search_path=public'],ARRAY['p_period_id'],0,'jsonb'),
 ('public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)','18c6571f37401e14116e59310235b7b2',true,ARRAY['postgres=X/postgres','service_role=X/postgres'],ARRAY['search_path=public'],ARRAY['p_union_id','p_period_start','p_period_end'],0,'jsonb'),
 ('public.fn_ca_legacy_period_maturity()','8ae80ac89843cc1f19f8dfdf03812a0b',false,ARRAY['postgres=X/postgres'],ARRAY['search_path=public, pg_temp'],NULL::text[],0,'trigger'),
 ('public.fn_ca_legacy_round3_wallet_receipt()','db707f33692fd511fde2352a98780ebc',true,ARRAY['postgres=X/postgres'],ARRAY['search_path=public, pg_temp'],NULL::text[],0,'trigger'),
 ('public.fn_lock_rakeback_payer_clubs(uuid[])','23afec197fccc0433fd3cfc6276ac3ba',false,ARRAY['postgres=X/postgres'],ARRAY['search_path=public, pg_temp'],ARRAY['p_club_ids'],0,'void')
), function_checks AS (
 SELECT e.signature,e.body_md5 expected_md5,md5(p.prosrc) actual_md5,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proacl::text acl,
 (SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type,a.is_grantable) FROM aclexplode(p.proacl) a) decoded_acl,
 p.proconfig,p.proargnames,p.pronargdefaults,
 COALESCE(md5(p.prosrc)=e.body_md5 AND pg_get_userbyid(p.proowner)='postgres'
 AND p.prosecdef=e.secdef AND ARRAY(SELECT a FROM unnest(p.proacl::text[]) a ORDER BY a)=e.acl
 AND p.proconfig=e.config AND p.proargnames IS NOT DISTINCT FROM e.argnames
 AND p.pronargdefaults=e.defaults AND p.prorettype=e.result_type::regtype,false) pass
 FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
), expected_triggers(table_name,trigger_name,function_name,trigger_type,column_name) AS (VALUES
 ('public.rakeback_periods','ca_legacy_period_maturity','public.fn_ca_legacy_period_maturity()',19,'status'),
 ('public.wallet_transactions','ca_legacy_round3_wallet_receipt','public.fn_ca_legacy_round3_wallet_receipt()',7,NULL::text)
), trigger_checks AS (
 SELECT e.table_name,e.trigger_name,t.tgenabled,pg_get_triggerdef(t.oid) definition,
 COALESCE(t.tgfoid=to_regprocedure(e.function_name) AND t.tgenabled='O' AND NOT t.tgisinternal
 AND t.tgtype=e.trigger_type AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint=0 AND t.tgnargs=0 AND t.tgqual IS NULL
 AND ((e.column_name IS NULL AND t.tgattr::text='') OR t.tgattr::text=(SELECT attnum::text FROM pg_attribute WHERE attrelid=to_regclass(e.table_name) AND attname=e.column_name AND NOT attisdropped)),false) pass
 FROM expected_triggers e LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass(e.table_name) AND t.tgname=e.trigger_name
)

 SELECT (SELECT bool_and(pass) FROM function_checks) AND (SELECT bool_and(pass) FROM trigger_checks) INTO v_runtime;
 IF v_runtime IS DISTINCT FROM true THEN RAISE EXCEPTION 'Reviewed runtime identity changed before bookkeeping'; END IF;
 UPDATE supabase_migrations.schema_migrations
 SET version='20260911081721'
 WHERE version='20260911082105'
 AND name='legacy_round3_preserve_server_only_acl'
 AND statements IS NOT DISTINCT FROM v_receipt.statements;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count<>1 THEN RAISE EXCEPTION 'Migration bookkeeping did not update exactly one row'; END IF;
 IF NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260911081721'
 AND name=v_receipt.name AND statements IS NOT DISTINCT FROM v_receipt.statements)
 OR EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260911082105')
 THEN RAISE EXCEPTION 'Migration bookkeeping postcondition failed'; END IF;
END
$alignment$;
COMMIT;
