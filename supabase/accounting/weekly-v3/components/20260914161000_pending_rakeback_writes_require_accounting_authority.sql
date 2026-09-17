-- Source candidate only. Apply after 160000 inside the complete weekly-v3
-- transaction. This changes authority, never a period, payment or balance.
-- SELECT and RLS policies stay intact. The existing certified calculator and
-- routed payer keep their postgres-owned SECURITY DEFINER write authority.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

DO $preimage$
DECLARE expected record;actual_acl jsonb;
BEGIN
 IF current_setting('server_version_num')::integer<170000 THEN
  RAISE EXCEPTION 'rakeback_write_authority_requires_postgresql_17';END IF;
 FOR expected IN SELECT * FROM (VALUES
  ('public.fn_rakeback_periods_bulk_upsert(jsonb)','89712d79d8ec9e19e7dfe6c0f0fe2611',true),
  ('public.fn_create_settlement_period(uuid,uuid,date,date)','3ff2d628a4561939095d2c6c0181fba8',false),
  ('public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])','dbeadf42b4143e11c6e7b76343fecf0a',true)
 ) x(signature,definition_md5,security_definer) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature)
   AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=expected.security_definer
   AND md5(pg_get_functiondef(p.oid))=expected.definition_md5) THEN
   RAISE EXCEPTION 'rakeback_write_authority_function_preimage_changed: %',expected.signature;
  END IF;
 END LOOP;
 -- Read-only production capture 2026-09-17: retire only the exact legacy
 -- payload writer. Its scalar helper remains the canonical source writers'
 -- dependency, with its definition and access unchanged.
 FOR expected IN SELECT * FROM (VALUES
  ('public.fn_apply_rakeback_player_stats_batch(jsonb)','ac2b4515198a0fe4bd327dfc030f506a'),
  ('public.apply_rakeback_player_stats(uuid,uuid,uuid,integer,numeric)','7f2b71a539db1b9c5cf6dbf6a489d40e')
 ) x(signature,definition_md5) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature)
   AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
   AND p.proconfig=ARRAY['search_path=public']::text[]
   AND md5(pg_get_functiondef(p.oid))=expected.definition_md5) THEN
   RAISE EXCEPTION 'rakeback_write_authority_function_preimage_changed: %',expected.signature;END IF;
  SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),
    CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
    a.privilege_type,a.is_grantable) ORDER BY a.grantee::regrole::text,a.privilege_type)
   INTO actual_acl FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=to_regprocedure(expected.signature);
  IF actual_acl IS DISTINCT FROM '[ ["postgres","postgres","EXECUTE",false], ["postgres","service_role","EXECUTE",false] ]'::jsonb
   OR has_function_privilege('anon',expected.signature,'EXECUTE')
   OR has_function_privilege('authenticated',expected.signature,'EXECUTE')
   OR NOT has_function_privilege('service_role',expected.signature,'EXECUTE') THEN
   RAISE EXCEPTION 'rakeback_write_authority_function_access_changed: %',expected.signature;END IF;
 END LOOP;
 -- Exact source from the preceding 160000 component. Its post-definition hash
 -- has not been measured by protected execution; do not invent one.
 IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)'))
  IS DISTINCT FROM $prior_source$
DECLARE started timestamptz;clubs uuid[];
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_hand_id IS NULL OR p_table_id IS NULL OR p_player_id IS NULL OR p_source_club IS NULL THEN
  RAISE EXCEPTION 'cash_earning_identity_missing' USING ERRCODE='23514'; END IF;
 SELECT h.started_at INTO started FROM public.hand_history h WHERE h.id=p_hand_id AND h.table_id=p_table_id;
 IF p_union_id IS NULL THEN
  -- Private games may admit a seat funded by another club. Preserve the
  -- actual club at the hand's start; the host only identifies the bank route.
  -- This reader runs before banking an already accepted hand. Unknown seat
  -- evidence must therefore stay NULL, not abort its bank obligation or invent
  -- host ownership. The existing source worker durably refuses that NULL or
  -- an unsupported cross-club liability after the exact bank receipt exists.
  IF started IS NULL OR NOT isfinite(started) OR started>transaction_timestamp() THEN RETURN NULL; END IF;
  SELECT array_agg(DISTINCT s.club_id) INTO clubs FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.user_id=p_player_id
    AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started);
  -- An overlapping unknown-club seat also makes the evidence ambiguous.
  IF cardinality(clubs) IS DISTINCT FROM 1 OR clubs[1] IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1] AND c.is_union IS NOT TRUE)
  THEN RETURN NULL; END IF;
  RETURN clubs[1];
 END IF;
 -- Preserve the existing shared-union validation and failure contract.
 IF started IS NULL OR started>transaction_timestamp() THEN RAISE EXCEPTION 'cash_hand_start_not_recorded' USING ERRCODE='23514'; END IF;
 SELECT array_agg(DISTINCT s.club_id) INTO clubs FROM public.table_seats s
  WHERE s.table_id=p_table_id AND s.user_id=p_player_id AND s.club_id IS NOT NULL
   AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started);
 IF cardinality(clubs) IS DISTINCT FROM 1
  OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
   AND (c.is_union IS NOT TRUE OR c.id=p_union_id OR c.union_id=p_union_id))
 THEN RAISE EXCEPTION 'cash_earning_seat_provenance_missing_or_ambiguous' USING ERRCODE='23514'; END IF;
 RETURN clubs[1];
END $prior_source$ THEN
  RAISE EXCEPTION 'rakeback_write_authority_requires_exact_160000_predecessor';END IF;
 FOR expected IN SELECT signature FROM (VALUES
  ('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'),
  ('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)')
 ) x(signature) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature)
   AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef)
   OR has_function_privilege('anon',to_regprocedure(expected.signature),'EXECUTE')
   OR has_function_privilege('authenticated',to_regprocedure(expected.signature),'EXECUTE')
   OR has_function_privilege('service_role',to_regprocedure(expected.signature),'EXECUTE') THEN
   RAISE EXCEPTION 'rakeback_write_authority_requires_private_canonical_writer: %',expected.signature;
  END IF;
 END LOOP;
END $preimage$;

-- Serialize against a writer already holding a table lock. Permission changes
-- and legacy RPC retirement commit with the entire activation, or none do.
LOCK TABLE public.rakeback_periods,public.rakeback_period_payouts IN ACCESS EXCLUSIVE MODE;
DO $table_shape$
DECLARE expected record;actual_columns jsonb;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('public.rakeback_periods',
   '[ ["id","uuid",true], ["user_id","uuid",false], ["club_id","uuid",true], ["period_start","date",true], ["period_end","date",true], ["rake_generated","numeric(15,2)",false], ["rakeback_rate","numeric(5,4)",false], ["rakeback_amount","numeric(15,2)",false], ["status","text",false], ["paid_at","timestamp with time zone",false], ["created_at","timestamp with time zone",false], ["rakeback_earned","numeric(15,2)",false], ["total_rake_paid","numeric(15,2)",false], ["deferred_reason","text",false], ["deferred_at","timestamp with time zone",false], ["defer_count","integer",true] ]'::jsonb,
   ARRAY[2,3,4,5]::smallint[]),
  ('public.rakeback_period_payouts',
   '[ ["id","uuid",true], ["rakeback_period_id","uuid",true], ["club_id","uuid",true], ["user_id","uuid",true], ["user_rake_contribution","numeric(20,4)",true], ["rakeback_pct","numeric(5,2)",true], ["payout_amount","numeric(20,4)",true], ["currency","text",true], ["wallet_transaction_id","uuid",false], ["status","text",true], ["paid_at","timestamp with time zone",false], ["failure_reason","text",false], ["created_at","timestamp with time zone",true] ]'::jsonb,
   ARRAY[2,4]::smallint[])
 ) x(table_name,columns,unique_columns) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass(expected.table_name)
   AND c.relkind='r' AND pg_get_userbyid(c.relowner)='postgres' AND c.relrowsecurity AND NOT c.relforcerowsecurity
   AND NOT EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)) THEN
   RAISE EXCEPTION 'rakeback_write_authority_table_owner_or_shape_changed: %',expected.table_name;END IF;
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum)
   INTO actual_columns FROM pg_attribute a WHERE a.attrelid=to_regclass(expected.table_name) AND a.attnum>0 AND NOT a.attisdropped;
  IF actual_columns IS DISTINCT FROM expected.columns
   OR NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass(expected.table_name)
    AND c.contype='p' AND c.conkey=ARRAY[1]::smallint[] AND NOT c.condeferrable AND c.convalidated)
   OR NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass(expected.table_name)
    AND c.contype='u' AND c.conkey=expected.unique_columns AND NOT c.condeferrable AND c.convalidated) THEN
   RAISE EXCEPTION 'rakeback_write_authority_table_columns_or_keys_changed: %',expected.table_name;END IF;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES
  ('public.rakeback_periods',2,'public.profiles'),('public.rakeback_periods',3,'public.clubs'),
  ('public.rakeback_period_payouts',2,'public.rakeback_periods'),
  ('public.rakeback_period_payouts',3,'public.clubs'),('public.rakeback_period_payouts',4,'auth.users')
 ) x(table_name,column_number,parent_name) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass(expected.table_name)
   AND c.contype='f' AND c.conkey=ARRAY[expected.column_number]::smallint[]
   AND c.confrelid=to_regclass(expected.parent_name) AND c.confdeltype='c' AND c.convalidated
   AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,ord)
    JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.ord)=ARRAY['id']) THEN
   RAISE EXCEPTION 'rakeback_write_authority_foreign_key_changed: %.%',expected.table_name,expected.column_number;END IF;
 END LOOP;
END $table_shape$;

-- Existing money function: register the explicit retirement before replacement.
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_rakeback_periods_bulk_upsert','approved','Retired arbitrary rakeback-period JSON writer. Always refuses; no financial reads or writes. The existing certified weekly request wrapper is the sole public period calculator.')
ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
CREATE OR REPLACE FUNCTION public.fn_rakeback_periods_bulk_upsert(p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='300s' AS $function$
BEGIN
 RAISE EXCEPTION 'rakeback_period_bulk_upsert_retired' USING ERRCODE='55000';
END $function$;
REVOKE ALL ON FUNCTION public.fn_rakeback_periods_bulk_upsert(jsonb),public.fn_create_settlement_period(uuid,uuid,date,date)
 FROM PUBLIC,anon,authenticated,service_role;
-- Registration is required before DDL, but the resulting body is not another
-- approved writer. Existing second-writer audits recognize this closed status.
UPDATE public.ca_money_rpc_registry SET status='closed',
 notes='Closed by weekly-v3 161000: arbitrary JSON period upserts always refuse, including owner calls; all client EXECUTE revoked. Use the existing source-certified fn_rakeback_recompute_periods request authority.'
 WHERE proname='fn_rakeback_periods_bulk_upsert';

-- A previously returned v1 commission count must never authorize this second
-- statistics writer after activation. Revoke clients as for the period bulk
-- writer; an accidental owner invocation also refuses before reading payload.
-- This does NOT prove an already executing old function body has drained.
-- Deployment first requires the canonical-only engine precursor and verified
-- retirement of old engine work; a table lock cannot prove unstarted writes.
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_apply_rakeback_player_stats_batch','approved','Retire legacy caller-supplied player statistics batch; canonical source writers retain the unchanged scalar helper.')
ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
CREATE OR REPLACE FUNCTION public.fn_apply_rakeback_player_stats_batch(p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 RAISE EXCEPTION 'rakeback_player_stats_batch_retired' USING ERRCODE='55000';
END $function$;
REVOKE ALL ON FUNCTION public.fn_apply_rakeback_player_stats_batch(jsonb) FROM PUBLIC,anon,authenticated,service_role;
UPDATE public.ca_money_rpc_registry SET status='closed',
 notes='Closed by weekly-v3 161000: legacy payload statistics batch always refuses, including owner calls; all client EXECUTE revoked. Canonical cash and tournament source transactions use the unchanged scalar apply_rakeback_player_stats helper.'
 WHERE proname='fn_apply_rakeback_player_stats_batch';

DO $close_writes$
DECLARE target regclass;columns_sql text;client text;privilege_name text;before_reads jsonb;after_reads jsonb;
BEGIN
 FOREACH target IN ARRAY ARRAY['public.rakeback_periods'::regclass,'public.rakeback_period_payouts'::regclass] LOOP
  -- Preserve every explicit table/column SELECT grant, including grantor and
  -- grant option. The policy catalog is never modified by this component.
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.column_number,r.grantor,r.grantee),'[]'::jsonb) INTO before_reads FROM (
   SELECT 0 AS column_number,a.grantor,a.grantee,a.is_grantable FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid=target AND a.privilege_type='SELECT'
   UNION ALL SELECT att.attnum,a.grantor,a.grantee,a.is_grantable FROM pg_attribute att
    CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=target AND att.attnum>0 AND NOT att.attisdropped AND a.privilege_type='SELECT'
  ) r;
  EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLE %s FROM PUBLIC,anon,authenticated,service_role',target);
  SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO columns_sql FROM pg_attribute
   WHERE attrelid=target AND attnum>0 AND NOT attisdropped;
  EXECUTE format('REVOKE INSERT (%1$s),UPDATE (%1$s),REFERENCES (%1$s) ON TABLE %2$s FROM PUBLIC,anon,authenticated,service_role',columns_sql,target);
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.column_number,r.grantor,r.grantee),'[]'::jsonb) INTO after_reads FROM (
   SELECT 0 AS column_number,a.grantor,a.grantee,a.is_grantable FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid=target AND a.privilege_type='SELECT'
   UNION ALL SELECT att.attnum,a.grantor,a.grantee,a.is_grantable FROM pg_attribute att
    CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=target AND att.attnum>0 AND NOT att.attisdropped AND a.privilege_type='SELECT'
  ) r;
  IF after_reads IS DISTINCT FROM before_reads THEN
   RAISE EXCEPTION 'rakeback_write_authority_read_access_changed: %',target;END IF;
  -- has_* includes inherited privileges and predefined broad-access roles.
  -- Do not quietly rewrite role membership: an unresolved grant aborts the
  -- complete activation after the attempted table and RPC authority changes.
  FOREACH client IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   FOREACH privilege_name IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
    IF has_table_privilege(client,target,privilege_name) THEN
     RAISE EXCEPTION 'rakeback_write_authority_effective_privilege_remains: %.%:%',target,client,privilege_name;END IF;
   END LOOP;
   FOREACH privilege_name IN ARRAY ARRAY['INSERT','UPDATE','REFERENCES'] LOOP
    IF has_any_column_privilege(client,target,privilege_name) THEN
     RAISE EXCEPTION 'rakeback_write_authority_effective_column_privilege_remains: %.%:%',target,client,privilege_name;END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 FOREACH client IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(client,'public.fn_rakeback_periods_bulk_upsert(jsonb)','EXECUTE')
   OR has_function_privilege(client,'public.fn_apply_rakeback_player_stats_batch(jsonb)','EXECUTE')
   OR has_function_privilege(client,'public.fn_create_settlement_period(uuid,uuid,date,date)','EXECUTE') THEN
   RAISE EXCEPTION 'rakeback_write_authority_legacy_execute_remains: %',client;END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])','EXECUTE') THEN
  RAISE EXCEPTION 'rakeback_write_authority_canonical_request_access_missing';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ca_money_rpc_registry WHERE proname='fn_rakeback_periods_bulk_upsert' AND status='closed') THEN
  RAISE EXCEPTION 'rakeback_write_authority_bulk_registry_not_closed';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ca_money_rpc_registry WHERE proname='fn_apply_rakeback_player_stats_batch' AND status='closed')
  OR (SELECT p.prosrc FROM pg_proc p WHERE p.oid='public.fn_apply_rakeback_player_stats_batch(jsonb)'::regprocedure)
   IS DISTINCT FROM $retired_source$
BEGIN
 RAISE EXCEPTION 'rakeback_player_stats_batch_retired' USING ERRCODE='55000';
END $retired_source$ THEN
  RAISE EXCEPTION 'rakeback_write_authority_stats_batch_not_retired';END IF;
 IF md5(pg_get_functiondef('public.apply_rakeback_player_stats(uuid,uuid,uuid,integer,numeric)'::regprocedure))<>'7f2b71a539db1b9c5cf6dbf6a489d40e'
  OR NOT has_function_privilege('service_role','public.apply_rakeback_player_stats(uuid,uuid,uuid,integer,numeric)','EXECUTE') THEN
  RAISE EXCEPTION 'rakeback_write_authority_scalar_stats_changed';END IF;
END $close_writes$;
COMMIT;
