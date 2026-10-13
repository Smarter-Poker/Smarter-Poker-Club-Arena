-- 20261013202353_scoped_launch_preserves_retired_wallets_and_starts_current_w.sql
-- Reserved through scripts/new-migration.mjs.
-- Preserve retired wallet lifecycle; waive verified unpaid pre-launch current-week records
-- and let original accounting earn after the cutoff. No live reset occurs on installation.
-- @live-proof: (SELECT md5(pg_get_functiondef(q.oid))='a7b64f40053a275b392655589f12699f' AND md5(q.prosrc)='0a0290ffe8c43b21952d89af2e4d051c' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef IS TRUE AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public", "statement_timeout=300s"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])')) IS TRUE
-- @live-proof: (SELECT md5(pg_get_functiondef(q.oid))='c2a380396a8d74304e07c817c4424ea1' AND md5(q.prosrc)='41637a44f6d62daf0a4a710d566714b8' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef IS TRUE AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=pg_catalog, public", "TimeZone=UTC"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_accounting_activate(uuid)')) IS TRUE
-- @live-proof: (SELECT md5(pg_get_functiondef(q.oid))='fbd19ea9e600c43effef72dae3cd2283' AND md5(q.prosrc)='9d54b5d52359a49ead5efc2ac4ae1c9a' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef IS TRUE AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=pg_catalog, public"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_rakeback_period_waived(uuid)')) IS TRUE
BEGIN;
SET LOCAL lock_timeout='4s';
-- @live-proof: (SELECT md5(pg_get_functiondef(q.oid))='813c1fa09b96c64ae2e3f97dfc66b868' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp", "lock_timeout=4s"]'::jsonb FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_reset_undo(uuid,text)')) IS TRUE
-- @live-proof: (SELECT md5(pg_get_functiondef(q.oid))='527fb4932cfc31c8b3da6e423036baab' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_reset_wallet_move(uuid,text,jsonb,text,numeric,text)')) IS TRUE
-- @live-proof: (SELECT md5(pg_get_functiondef(q.oid))='beb8048f726aa9e334e8cb14f6b75b4f' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp", "lock_timeout=4s"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_reset_execute(uuid,text,integer)')) IS TRUE
-- @live-proof: (SELECT md5(pg_get_functiondef(q.oid))='222df1e2c01eb66bf0ddf4a71387ea6c' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_opening_authorized(text,text,text,uuid,numeric)')) IS TRUE
-- @live-proof: (SELECT md5(pg_get_functiondef(q.oid))='73da8a517ea5cb0c4c1673da8b014b70' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_is_internal_transfer(uuid)')) IS TRUE
DO $guard$ BEGIN IF NOT EXISTS(SELECT FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_is_internal_transfer(uuid)') AND md5(pg_get_functiondef(q.oid))='f340566e4c5a4a439a8a784b199ea2c3' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'DELETED_COHORT_ORIGINAL_SOURCE_OR_AUTHORITY_CHANGED'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_launch_is_internal_transfer(p_leg uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l public.chip_ledger%ROWTYPE; m public.ca_launch_reset_wallet_movements%ROWTYPE;
 o public.ca_launch_reset_operations%ROWTYPE; p public.ca_launch_reset_positions%ROWTYPE;
BEGIN
 -- Each exact private proof is resolved by its own original unique key. This
 -- preserves all proof predicates without a cached multi-table join choosing
 -- a wallet-sized outer relation for every transfer.
 SELECT * INTO l FROM public.chip_ledger WHERE id=p_leg;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO m FROM public.ca_launch_reset_wallet_movements WHERE operation_key=l.idempotency_key;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO o FROM public.ca_launch_reset_operations WHERE operation_id=m.operation_id;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO p FROM public.ca_launch_reset_positions
 WHERE operation_id=m.operation_id AND relation_name=m.relation_name
 AND row_key=m.row_key AND column_name=m.column_name;
 IF NOT FOUND THEN RETURN false; END IF;
 RETURN coalesce(l.id=p_leg AND o.state IN('captured','executed','undone')
 AND m.performed_by=o.performed_by AND l.performed_by=m.performed_by
 AND l.status='posted' AND l.correlation_id=m.operation_id AND l.club_id=m.club_id
 AND m.club_id=p.club_id AND m.club_id=ANY(o.scoped_club_ids) AND m.entity_id=p.entity_id AND m.account_type=p.account_type
 AND m.after_value>=0 AND m.before_value>=0 AND m.bank_after=m.bank_before+m.before_value-m.after_value
 AND m.bank_before>=0 AND m.bank_after>=0
 AND l.amount=abs(m.after_value-m.before_value) AND l.amount>0
 AND l.category=CASE WHEN m.after_value>m.before_value THEN 'club_bank_send' ELSE 'club_bank_claim' END
 AND l.from_type=CASE WHEN m.after_value>m.before_value THEN 'club_treasury' ELSE m.account_type END
 AND l.from_entity_id=CASE WHEN m.after_value>m.before_value THEN m.club_id ELSE m.entity_id END
 AND l.to_type=CASE WHEN m.after_value>m.before_value THEN m.account_type ELSE 'club_treasury' END
 AND l.to_entity_id=CASE WHEN m.after_value>m.before_value THEN m.entity_id ELSE m.club_id END
 AND m.operation_key='launch-wallet:'||m.operation_id::text||':'||m.direction||':'||m.relation_name||':'||m.row_key::text||':'||m.column_name
 AND ((m.direction IN('retire','undo-opening') AND m.after_value=0)
 OR (m.direction='opening' AND m.relation_name='club_members' AND m.column_name='chip_balance' AND m.after_value=10000 AND EXISTS(SELECT 1 FROM public.ca_launch_reset_rows r WHERE r.operation_id=m.operation_id AND r.relation_name=m.relation_name AND r.row_key=m.row_key AND r.raw_row->>'launch_is_horse'='true' AND r.raw_row->>'launch_profile_status' IS DISTINCT FROM 'deleted'))
 OR (m.direction='undo-retirement' AND m.after_value=p.balance)),false);
END $function$
;
DO $post$ BEGIN IF (SELECT md5(pg_get_functiondef(q.oid))='73da8a517ea5cb0c4c1673da8b014b70' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_is_internal_transfer(uuid)')) IS TRUE IS DISTINCT FROM true THEN RAISE EXCEPTION 'DELETED_COHORT_POSTIMAGE_OR_AUTHORITY_CHANGED'; END IF; END $post$;
DO $guard$ BEGIN IF NOT EXISTS(SELECT FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_opening_authorized(text,text,text,uuid,numeric)') AND md5(pg_get_functiondef(q.oid))='36ee307e58cfa16de6efba64656daed3' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'DELETED_COHORT_ORIGINAL_SOURCE_OR_AUTHORITY_CHANGED'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_launch_opening_authorized(p_key text, p_asset text, p_destination text, p_target uuid, p_amount numeric)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT EXISTS(SELECT 1 FROM public.ca_launch_reset_opening_authorizations a
 JOIN public.ca_launch_reset_operations o ON o.operation_id=a.operation_id
 WHERE a.operation_key=p_key AND p_amount <= (SELECT per_operation_cap_chips FROM public.ca_mint_policy WHERE id=1) AND p_asset='chips' AND p_destination='club' AND p_target=a.club_id AND p_amount=a.amount
 AND a.operation_key='launch-open:'||a.operation_id::text||':'||a.club_id::text
 AND a.performed_by=o.performed_by AND a.closing_sha256=o.closing_sha256
 AND o.state IN('captured','executed','undone') AND a.club_id=ANY(o.scoped_club_ids)
 AND a.horse_wallets=(SELECT count(*) FROM public.ca_launch_reset_rows r WHERE r.operation_id=a.operation_id AND r.relation_name='club_members' AND r.raw_row->>'club_id'=a.club_id::text AND r.raw_row->>'launch_is_horse'='true' AND r.raw_row->>'launch_profile_status' IS DISTINCT FROM 'deleted')
 AND ((SELECT count(*) FROM public.ca_launch_accounting_boundaries b WHERE b.operation_id=o.operation_id AND b.cutoff_at=o.captured_at AND ((b.scope_kind='club' AND b.scope_id=ANY(o.scoped_club_ids)) OR (b.scope_kind='union' AND b.scope_id='fade0000-0000-0000-0000-000000000001'))) = 5
 OR (o.state='undone' AND EXISTS(SELECT 1 FROM public.ca_mint_ledger m JOIN public.chip_ledger l ON l.id=m.chip_ledger_id WHERE m.op_id=a.operation_key AND m.asset='chips' AND m.action='mint' AND m.holder_id=a.club_id AND m.holder_type='club' AND m.amount=a.amount AND l.idempotency_key='mint:'||a.operation_key AND l.from_type='issuance_reserve' AND l.to_type='club_treasury' AND l.to_entity_id=a.club_id AND l.amount=a.amount))));
$function$
;
DO $post$ BEGIN IF (SELECT md5(pg_get_functiondef(q.oid))='222df1e2c01eb66bf0ddf4a71387ea6c' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_opening_authorized(text,text,text,uuid,numeric)')) IS TRUE IS DISTINCT FROM true THEN RAISE EXCEPTION 'DELETED_COHORT_POSTIMAGE_OR_AUTHORITY_CHANGED'; END IF; END $post$;
DO $guard$ BEGIN IF NOT EXISTS(SELECT FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_reset_execute(uuid,text,integer)') AND md5(pg_get_functiondef(q.oid))='3a4879af86a87982244da95ed43040a3' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp", "lock_timeout=4s"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'DELETED_COHORT_ORIGINAL_SOURCE_OR_AUTHORITY_CHANGED'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_launch_reset_execute(p_operation uuid, p_expected_closing_sha256 text, p_expected_horse_wallets integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '4s'
AS $function$
DECLARE op public.ca_launch_reset_operations%ROWTYPE; pos public.ca_launch_reset_positions%ROWTYPE; c uuid; retired numeric; opening numeric; answer jsonb; got numeric; predicate text; selected_rows bigint; roster integer; pool public.bbj_pools%ROWTYPE; difference numeric;
BEGIN
 PERFORM public.fn_ca_launch_reset_assert_drained();
 IF NOT pg_try_advisory_xact_lock(530090,1) OR NOT pg_try_advisory_xact_lock(hashtext('ca_launch_reset')) THEN RAISE EXCEPTION 'LAUNCH_RESET_ENTRY_GATE_BUSY' USING ERRCODE='55P03'; END IF;
 SELECT * INTO op FROM public.ca_launch_reset_operations WHERE operation_id=p_operation FOR UPDATE;
 IF NOT FOUND OR op.state<>'captured' OR op.closing_sha256 IS DISTINCT FROM p_expected_closing_sha256 THEN RAISE EXCEPTION 'LAUNCH_RESET_NOT_EXACT_CAPTURE'; END IF;
 IF p_expected_horse_wallets IS NULL OR p_expected_horse_wallets<=0 THEN RAISE EXCEPTION 'LAUNCH_RESET_EXPECTED_ROSTER_REQUIRED'; END IF;
 PERFORM 1 FROM public.clubs WHERE id=ANY(op.scoped_club_ids) ORDER BY id FOR UPDATE;
 -- Preserve the captured roster. A late departure/join/status change is not
 -- silently given a different bankroll by a changed cutover enumeration.
 SELECT count(*) INTO roster FROM public.ca_launch_reset_rows WHERE operation_id=p_operation AND relation_name='club_members' AND raw_row->>'launch_is_horse'='true' AND raw_row->>'launch_profile_status' IS DISTINCT FROM 'deleted';
 IF roster<>p_expected_horse_wallets OR roster=0 OR (SELECT count(*) FROM public.club_members WHERE club_id=ANY(op.scoped_club_ids))<>(SELECT count(*) FROM public.ca_launch_reset_rows WHERE operation_id=p_operation AND relation_name='club_members') THEN RAISE EXCEPTION 'LAUNCH_RESET_ROSTER_CHANGED'; END IF;
 FOR pos IN SELECT * FROM public.ca_launch_reset_positions WHERE operation_id=p_operation AND relation_name IN('club_members','agents','clubs','club_wallets','union_wallets','bbj_pools') ORDER BY relation_name,row_key::text,column_name LOOP
  predicate:=CASE WHEN pos.relation_name='club_members' THEN format('club_id=%L::uuid AND user_id=%L::uuid',pos.row_key->>'club_id',pos.row_key->>'user_id') ELSE format('id=%L::uuid',pos.row_key->>'id') END;
  EXECUTE format('SELECT %I FROM public.%I WHERE %s FOR UPDATE',pos.column_name,pos.relation_name,predicate) INTO got;
  GET DIAGNOSTICS selected_rows=ROW_COUNT;
  IF selected_rows<>1 OR got IS DISTINCT FROM pos.balance THEN RAISE EXCEPTION 'LAUNCH_RESET_POSITION_CHANGED: % %',pos.relation_name,pos.column_name; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.agents WHERE club_id=ANY(op.scoped_club_ids)
 AND (player_wallet_balance IS DISTINCT FROM round(player_wallet_balance,2) OR player_wallet_balance IS DISTINCT FROM player_balance)) THEN RAISE EXCEPTION 'LAUNCH_RESET_AGENT_ALIAS_IS_NOT_EXACTLY_RESTORABLE'; END IF;
 IF EXISTS(SELECT 1 FROM public.ca_launch_reset_rows r LEFT JOIN public.club_members m ON m.club_id=(r.row_key->>'club_id')::uuid AND m.user_id=(r.row_key->>'user_id')::uuid LEFT JOIN public.profiles p ON p.id=m.user_id
 WHERE r.operation_id=p_operation AND r.relation_name='club_members'
 AND (m.user_id IS NULL OR p.id IS NULL OR to_jsonb(p.is_horse) IS DISTINCT FROM r.raw_row->'launch_is_horse'
 OR to_jsonb(p.status) IS DISTINCT FROM r.raw_row->'launch_profile_status' OR to_jsonb(m.status) IS DISTINCT FROM r.raw_row->'status' OR to_jsonb(m.membership_lifecycle_status) IS DISTINCT FROM r.raw_row->'membership_lifecycle_status')) THEN RAISE EXCEPTION 'LAUNCH_RESET_ROSTER_IDENTITY_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM public.ca_launch_reset_positions positionrow JOIN public.profiles p ON p.id=positionrow.entity_id WHERE positionrow.operation_id=p_operation AND positionrow.relation_name IN('club_members','agents') AND positionrow.counted_in_supply AND p.status='deleted' AND coalesce(positionrow.balance,0)<>0) THEN RAISE EXCEPTION 'LAUNCH_RESET_DELETED_CUSTODY_PREIMAGE_IS_NOT_ZERO'; END IF;
 PERFORM public.fn_ca_launch_cashier_activate(p_operation);
 PERFORM public.fn_ca_launch_accounting_activate(p_operation);
 PERFORM public.fn_ca_launch_incident_prepare(p_operation);
 answer:=public.fn_ca_epoch3_preflight();
 IF (answer->>'pass')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'LAUNCH_RESET_PREFLIGHT_FAILED: %',answer; END IF;
 FOREACH c IN ARRAY op.scoped_club_ids LOOP
  retired:=0;
  FOR pos IN SELECT * FROM public.ca_launch_reset_positions WHERE operation_id=p_operation AND club_id=c AND ((relation_name='club_members' AND column_name IN('chip_balance','promo_balance')) OR (relation_name='agents' AND column_name IN('agent_wallet_balance','promo_wallet_balance'))) ORDER BY relation_name,row_key::text,column_name LOOP
   retired:=retired+public.fn_ca_launch_reset_wallet_move(p_operation,pos.relation_name,pos.row_key,pos.column_name,0,'retire');
  END LOOP;
  IF retired>0 THEN
   answer:=public.fn_ca_burn('chips','club',c,retired,'Owner Authorized Launch Retirement Of Prior Player And Agent Balances','launch-retire:'||p_operation::text||':'||c::text);
   IF answer->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'LAUNCH_RETIREMENT_REFUSED: %',answer; END IF;
  END IF;
  SELECT count(*)*10000 INTO opening FROM public.ca_launch_reset_rows WHERE operation_id=p_operation AND relation_name='club_members' AND raw_row->>'club_id'=c::text AND raw_row->>'launch_is_horse'='true' AND raw_row->>'launch_profile_status' IS DISTINCT FROM 'deleted';
  IF opening>0 THEN
   INSERT INTO public.ca_launch_reset_opening_authorizations VALUES(c,p_operation,'launch-open:'||p_operation::text||':'||c::text,op.closing_sha256,(opening/10000)::integer,opening,op.performed_by);
   PERFORM set_config('app.ledger_autoskip_clubs','',true);
   answer:=public.fn_ca_mint('chips','club',c,opening,'Owner Authorized Launch Bankroll 10000 Chips In Each Horse Club Wallet','launch-open:'||p_operation::text||':'||c::text);
   IF answer->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'LAUNCH_OPENING_MINT_REFUSED: %',answer; END IF;
   FOR pos IN SELECT p.* FROM public.ca_launch_reset_positions p JOIN public.ca_launch_reset_rows r USING(operation_id,relation_name,row_key) WHERE p.operation_id=p_operation AND p.relation_name='club_members' AND p.column_name='chip_balance' AND p.club_id=c AND r.raw_row->>'launch_is_horse'='true' AND r.raw_row->>'launch_profile_status' IS DISTINCT FROM 'deleted' ORDER BY p.row_key::text LOOP
    PERFORM public.fn_ca_launch_reset_wallet_move(p_operation,pos.relation_name,pos.row_key,pos.column_name,10000,'opening');
   END LOOP;
  END IF;
 END LOOP;
 -- Displayed legacy player aliases are not counted as additional chip supply.
 -- They are cleared explicitly and restored exactly in undo after validation.
 UPDATE public.agents SET player_wallet_balance=0 WHERE club_id=ANY(op.scoped_club_ids);
 SELECT * INTO pool FROM public.bbj_pools WHERE id='f9806a7f-e7a2-47d2-a676-36336e3a5337' AND union_id='fade0000-0000-0000-0000-000000000001' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'LAUNCH_BBJ_POOL_CHANGED'; END IF;
 difference:=pool.main_balance-12350;
 IF difference<>0 THEN
  PERFORM public.fn_ca_declare_ledger('treasury_transfer','union_bank',pool.union_id,NULL,'launch-bbj:'||p_operation::text,ARRAY['union_wallets']);
  PERFORM set_config('app.ledger_correlation',p_operation::text,true);
  UPDATE public.bbj_pools SET main_balance=12350 WHERE id=pool.id;
  UPDATE public.union_wallets SET chip_balance=chip_balance+difference WHERE union_id=pool.union_id;
  PERFORM set_config('app.ledger_autoskip_union_wallets','',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.club_members m JOIN public.ca_launch_reset_rows r ON r.operation_id=p_operation AND r.relation_name='club_members' AND m.club_id=(r.row_key->>'club_id')::uuid AND m.user_id=(r.row_key->>'user_id')::uuid
 WHERE m.chip_balance IS DISTINCT FROM CASE WHEN r.raw_row->>'launch_is_horse'='true' AND r.raw_row->>'launch_profile_status' IS DISTINCT FROM 'deleted' THEN 10000::numeric ELSE 0::numeric END OR coalesce(m.promo_balance,0)<>0) THEN RAISE EXCEPTION 'LAUNCH_OPENING_WALLET_POSTCONDITION_FAILED'; END IF;
 IF EXISTS(SELECT 1 FROM public.agents WHERE club_id=ANY(op.scoped_club_ids) AND (coalesce(agent_wallet_balance,0)<>0 OR coalesce(promo_wallet_balance,0)<>0 OR coalesce(player_wallet_balance,0)<>0 OR coalesce(player_balance,0)<>0)) THEN RAISE EXCEPTION 'LAUNCH_AGENT_ZERO_POSTCONDITION_FAILED'; END IF;
 IF EXISTS(SELECT 1 FROM public.ca_launch_reset_positions p JOIN public.clubs c ON c.id=p.entity_id WHERE p.operation_id=p_operation AND p.relation_name='clubs' AND p.column_name='chip_treasury' AND c.chip_treasury IS DISTINCT FROM p.balance) THEN RAISE EXCEPTION 'LAUNCH_BANK_PRESERVATION_FAILED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.bbj_pools WHERE id=pool.id AND main_balance=12350 AND backup_balance=pool.backup_balance AND promo_balance=pool.promo_balance) THEN RAISE EXCEPTION 'LAUNCH_BBJ_POSTCONDITION_FAILED'; END IF;
 -- Exact mutations manifest from immutable preimage, including preserved banks.
 FOR pos IN SELECT * FROM public.ca_launch_reset_positions WHERE operation_id=p_operation AND relation_name IN('club_members','agents','clubs','club_wallets','union_wallets','bbj_pools') ORDER BY relation_name,row_key::text,column_name LOOP
  predicate:=CASE WHEN pos.relation_name='club_members' THEN format('club_id=%L::uuid AND user_id=%L::uuid',pos.row_key->>'club_id',pos.row_key->>'user_id') ELSE format('id=%L::uuid',pos.row_key->>'id') END;
  EXECUTE format('SELECT %I FROM public.%I WHERE %s',pos.column_name,pos.relation_name,predicate) INTO got;
  INSERT INTO public.ca_launch_reset_mutations VALUES(p_operation,pos.relation_name,pos.row_key,pos.column_name,pos.balance,got);
 END LOOP;
 UPDATE public.ca_launch_reset_operations SET state='executed',executed_at=clock_timestamp(),result=jsonb_build_object('horse_wallets',roster,'horse_opening',roster*10000,'bbj_main',12350) WHERE operation_id=p_operation RETURNING result INTO answer;
 RETURN answer;
END $function$
;
DO $post$ BEGIN IF (SELECT md5(pg_get_functiondef(q.oid))='beb8048f726aa9e334e8cb14f6b75b4f' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp", "lock_timeout=4s"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_reset_execute(uuid,text,integer)')) IS TRUE IS DISTINCT FROM true THEN RAISE EXCEPTION 'DELETED_COHORT_POSTIMAGE_OR_AUTHORITY_CHANGED'; END IF; END $post$;
DO $guard$ BEGIN IF NOT EXISTS(SELECT FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_reset_wallet_move(uuid,text,jsonb,text,numeric,text)') AND md5(pg_get_functiondef(q.oid))='21f686a926d99487c2bd79ee778b83f2' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'DELETED_COHORT_ORIGINAL_SOURCE_OR_AUTHORITY_CHANGED'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_launch_reset_wallet_move(p_operation uuid, p_relation text, p_key jsonb, p_column text, p_target numeric, p_direction text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE pos public.ca_launch_reset_positions%ROWTYPE; op public.ca_launch_reset_operations%ROWTYPE; bank numeric; value numeric; delta numeric; predicate text; key text; leg uuid;
BEGIN
 SELECT * INTO pos FROM public.ca_launch_reset_positions WHERE operation_id=p_operation AND relation_name=p_relation AND row_key=p_key AND column_name=p_column;
 IF NOT FOUND OR p_relation NOT IN('club_members','agents') OR p_column NOT IN('chip_balance','promo_balance','agent_wallet_balance','promo_wallet_balance') OR p_target IS NULL OR p_target<0 OR p_target<>round(p_target,2) THEN RAISE EXCEPTION 'LAUNCH_WALLET_MOVE_NOT_IN_CAPTURE'; END IF;
 SELECT * INTO op FROM public.ca_launch_reset_operations WHERE operation_id=p_operation;
 IF NOT FOUND OR auth.uid() IS DISTINCT FROM op.performed_by
 OR NOT ((p_direction IN('retire','opening') AND op.state='captured') OR (p_direction IN('undo-opening','undo-retirement') AND op.state='executed')) THEN RAISE EXCEPTION 'LAUNCH_WALLET_MOVE_WRONG_OWNER_PHASE'; END IF;
 IF (p_direction IN('retire','undo-opening') AND p_target<>0) OR (p_direction='undo-retirement' AND p_target IS DISTINCT FROM pos.balance) OR (p_direction IN('opening','undo-opening') AND NOT (p_relation='club_members' AND p_column='chip_balance' AND EXISTS(SELECT 1 FROM public.ca_launch_reset_rows r WHERE r.operation_id=p_operation AND r.relation_name=p_relation AND r.row_key=p_key AND r.raw_row->>'launch_is_horse'='true' AND r.raw_row->>'launch_profile_status' IS DISTINCT FROM 'deleted'))) OR (p_direction='opening' AND p_target<>10000) THEN RAISE EXCEPTION 'LAUNCH_WALLET_TARGET_IS_NOT_AUTHORIZED'; END IF;
 SELECT chip_treasury INTO bank FROM public.clubs WHERE id=pos.club_id FOR UPDATE;
 predicate:=CASE WHEN p_relation='club_members'  THEN format('club_id=%L::uuid AND user_id=%L::uuid',p_key->>'club_id',p_key->>'user_id') ELSE format('id=%L::uuid',p_key->>'id') END;
 EXECUTE format('SELECT %I FROM public.%I WHERE %s FOR UPDATE',p_column,p_relation,predicate) INTO value;
 IF value IS NULL THEN RAISE EXCEPTION 'LAUNCH_WALLET_VALUE_IS_NULL'; END IF;
 delta:=p_target-value;
 IF delta=0 THEN RETURN 0; END IF;
 key:='launch-wallet:'||p_operation::text||':'||p_direction||':'||p_relation||':'||p_key::text||':'||p_column;
 INSERT INTO public.ca_launch_reset_wallet_movements VALUES(p_operation,key,p_relation,p_key,p_column,pos.account_type,pos.entity_id,pos.club_id,value,p_target,bank,bank-delta,op.performed_by,p_direction);
 -- Original bank transfer contract: wallet journal writes the single leg;
 -- bank autoledger is stood down only for its matching other balance side.
 PERFORM public.fn_ca_declare_ledger(CASE WHEN delta>0 THEN 'club_bank_send' ELSE 'club_bank_claim' END,'club_treasury',pos.club_id,NULL,key,ARRAY['clubs']);
 PERFORM set_config('app.ledger_correlation',p_operation::text,true);
 PERFORM set_config('app.ledger_autoskip_'||p_relation,'',true);
 EXECUTE format('UPDATE public.%I SET %I=$1 WHERE %s',p_relation,p_column,predicate) USING p_target;
 UPDATE public.clubs SET chip_treasury=chip_treasury-delta WHERE id=pos.club_id;
 SELECT id INTO leg FROM public.chip_ledger WHERE idempotency_key=key;
 IF leg IS NULL OR NOT public.fn_ca_launch_is_internal_transfer(leg) THEN RAISE EXCEPTION 'LAUNCH_WALLET_TRANSFER_HAS_NO_EXACT_LEG'; END IF;
 PERFORM set_config('app.ledger_autoskip_clubs','',true);
 PERFORM public.fn_ca_launch_reset_check_prefix(p_operation,p_direction,key);
 RETURN -delta;
END $function$
;
DO $post$ BEGIN IF (SELECT md5(pg_get_functiondef(q.oid))='527fb4932cfc31c8b3da6e423036baab' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_reset_wallet_move(uuid,text,jsonb,text,numeric,text)')) IS TRUE IS DISTINCT FROM true THEN RAISE EXCEPTION 'DELETED_COHORT_POSTIMAGE_OR_AUTHORITY_CHANGED'; END IF; END $post$;
DO $undo_guard$ BEGIN IF NOT EXISTS(SELECT FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_reset_undo(uuid,text)') AND md5(pg_get_functiondef(q.oid))='e763bd00b557c4bc800a2523e60a1d25' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp", "lock_timeout=4s"]'::jsonb) THEN RAISE EXCEPTION 'DELETED_COHORT_UNDO_ORIGINAL_CHANGED'; END IF; END $undo_guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_launch_reset_undo(p_operation uuid, p_expected_closing_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '4s'
AS $function$
DECLARE op public.ca_launch_reset_operations%ROWTYPE; pos public.ca_launch_reset_positions%ROWTYPE;
 mutation public.ca_launch_reset_mutations%ROWTYPE; c uuid; minted numeric; answer jsonb; original public.ca_mint_ledger%ROWTYPE;
 v_leg uuid; v_before numeric; v_after numeric; got numeric; predicate text; selected_rows bigint; pool public.bbj_pools%ROWTYPE; old_main numeric; difference numeric;
BEGIN
 PERFORM public.fn_ca_launch_reset_assert_drained();
 IF NOT pg_try_advisory_xact_lock(530090,1) OR NOT pg_try_advisory_xact_lock(hashtext('ca_launch_reset')) THEN RAISE EXCEPTION 'LAUNCH_RESET_ENTRY_GATE_BUSY' USING ERRCODE='55P03'; END IF;
 SELECT * INTO op FROM public.ca_launch_reset_operations WHERE operation_id=p_operation FOR UPDATE;
 IF NOT FOUND OR op.state<>'executed' OR op.closing_sha256 IS DISTINCT FROM p_expected_closing_sha256 THEN RAISE EXCEPTION 'LAUNCH_UNDO_NOT_EXACT_EXECUTION'; END IF;
 PERFORM 1 FROM public.clubs WHERE id=ANY(op.scoped_club_ids) ORDER BY id FOR UPDATE;
 IF (SELECT count(*) FROM public.club_members WHERE club_id=ANY(op.scoped_club_ids))<>(SELECT count(*) FROM public.ca_launch_reset_rows WHERE operation_id=p_operation AND relation_name='club_members') THEN RAISE EXCEPTION 'LAUNCH_UNDO_ROSTER_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM public.ca_launch_reset_rows r LEFT JOIN public.club_members m ON m.club_id=(r.row_key->>'club_id')::uuid AND m.user_id=(r.row_key->>'user_id')::uuid LEFT JOIN public.profiles p ON p.id=m.user_id WHERE r.operation_id=p_operation AND r.relation_name='club_members' AND (p.id IS NULL OR to_jsonb(p.status) IS DISTINCT FROM r.raw_row->'launch_profile_status' OR to_jsonb(p.is_horse) IS DISTINCT FROM r.raw_row->'launch_is_horse')) THEN RAISE EXCEPTION 'LAUNCH_UNDO_IDENTITY_CHANGED'; END IF;
 -- A stale undo may never overwrite resumed play or a later deposit. Refuse
 -- before restoring any value when any captured post-position has moved.
 FOR mutation IN SELECT * FROM public.ca_launch_reset_mutations WHERE operation_id=p_operation ORDER BY relation_name,row_key::text,column_name LOOP
  predicate:=CASE WHEN mutation.relation_name='club_members' THEN format('club_id=%L::uuid AND user_id=%L::uuid',mutation.row_key->>'club_id',mutation.row_key->>'user_id') ELSE format('id=%L::uuid',mutation.row_key->>'id') END;
  EXECUTE format('SELECT %I FROM public.%I WHERE %s FOR UPDATE',mutation.column_name,mutation.relation_name,predicate) INTO got;
  GET DIAGNOSTICS selected_rows=ROW_COUNT;
  IF selected_rows<>1 OR got IS DISTINCT FROM mutation.after_value THEN RAISE EXCEPTION 'LAUNCH_UNDO_POST_POSITION_CHANGED: % %',mutation.relation_name,mutation.column_name; END IF;
 END LOOP;
 FOREACH c IN ARRAY op.scoped_club_ids LOOP
  SELECT coalesce(sum(amount),0) INTO minted FROM public.ca_mint_ledger WHERE op_id='launch-open:'||p_operation::text||':'||c::text AND asset='chips' AND action='mint';
  IF minted>0 THEN
   FOR pos IN SELECT p.* FROM public.ca_launch_reset_positions p JOIN public.ca_launch_reset_rows r USING(operation_id,relation_name,row_key) WHERE p.operation_id=p_operation AND p.relation_name='club_members' AND p.column_name='chip_balance' AND p.club_id=c AND r.raw_row->>'launch_is_horse'='true' AND r.raw_row->>'launch_profile_status' IS DISTINCT FROM 'deleted' ORDER BY p.row_key::text LOOP
    PERFORM public.fn_ca_launch_reset_wallet_move(p_operation,pos.relation_name,pos.row_key,pos.column_name,0,'undo-opening');
   END LOOP;
   answer:=public.fn_ca_burn('chips','club',c,minted,'Exact Undo Of This Launch Opening Mint','launch-undo-opening:'||p_operation::text||':'||c::text);
   IF answer->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'LAUNCH_UNDO_OPENING_BURN_REFUSED: %',answer; END IF;
  END IF;
  SELECT * INTO original FROM public.ca_mint_ledger WHERE op_id='launch-retire:'||p_operation::text||':'||c::text AND asset='chips' AND action='burn';
  IF FOUND THEN
   v_leg:=gen_random_uuid();
   INSERT INTO public.ca_launch_reset_retirement_reversals VALUES(p_operation,original.id,to_jsonb(original),v_leg,original.amount,c);
   SELECT chip_treasury INTO v_before FROM public.clubs WHERE id=c FOR UPDATE;
   PERFORM set_config('app.ledger_autoskip_clubs','1',true);
   UPDATE public.clubs SET chip_treasury=chip_treasury+original.amount WHERE id=c RETURNING chip_treasury INTO v_after;
   INSERT INTO public.chip_ledger(id,performed_by,from_type,to_type,to_entity_id,amount,category,club_id,description,idempotency_key,correlation_id,pre_to_balance,post_to_balance,metadata)
   VALUES(v_leg,op.performed_by,'chip_retirement','club_treasury',c,original.amount,'reversal',c,'Exact Restoration Of This Launch Retirement Receipt','launch-retirement-reversal:'||p_operation::text||':'||c::text,p_operation,v_before,v_after,jsonb_build_object('original_register_id',original.id));
   PERFORM set_config('app.ledger_autoskip_clubs','',true);
   -- Materialize the existing authoritative register now, so postconditions
   -- read it before deferred commit checks. Those checks still run normally.
   PERFORM public.fn_ca_register_issuance_leg(v_leg);
   IF NOT public.fn_ca_launch_is_retirement_reversal(v_leg) THEN RAISE EXCEPTION 'LAUNCH_UNDO_RETIREMENT_RECEIPT_UNPROVEN'; END IF;
  END IF;
  FOR pos IN SELECT * FROM public.ca_launch_reset_positions WHERE operation_id=p_operation AND club_id=c AND ((relation_name='club_members' AND column_name IN('chip_balance','promo_balance')) OR (relation_name='agents' AND column_name IN('agent_wallet_balance','promo_wallet_balance'))) ORDER BY relation_name,row_key::text,column_name LOOP
   IF pos.balance IS NOT NULL THEN PERFORM public.fn_ca_launch_reset_wallet_move(p_operation,pos.relation_name,pos.row_key,pos.column_name,pos.balance,'undo-retirement'); END IF;
  END LOOP;
 END LOOP;
 SELECT * INTO pool FROM public.bbj_pools WHERE id='f9806a7f-e7a2-47d2-a676-36336e3a5337' FOR UPDATE;
 SELECT balance INTO old_main FROM public.ca_launch_reset_positions WHERE operation_id=p_operation AND relation_name='bbj_pools' AND row_key=jsonb_build_object('id',pool.id) AND column_name='main_balance';
 IF old_main IS NULL THEN RAISE EXCEPTION 'LAUNCH_UNDO_BBJ_PREIMAGE_MISSING'; END IF;
 difference:=pool.main_balance-old_main;
 IF difference<>0 THEN
  PERFORM public.fn_ca_declare_ledger('treasury_transfer','union_bank',pool.union_id,NULL,'launch-bbj-undo:'||p_operation::text,ARRAY['union_wallets']);
  PERFORM set_config('app.ledger_correlation',p_operation::text,true);
  UPDATE public.bbj_pools SET main_balance=old_main WHERE id=pool.id;
  UPDATE public.union_wallets SET chip_balance=chip_balance+difference WHERE union_id=pool.union_id;
  PERFORM set_config('app.ledger_autoskip_union_wallets','',true);
 END IF;
 UPDATE public.agents a SET player_wallet_balance=(r.raw_row->>'player_wallet_balance')::numeric
 FROM public.ca_launch_reset_rows r WHERE r.operation_id=p_operation AND r.relation_name='agents' AND a.id=(r.row_key->>'id')::uuid;
 PERFORM public.fn_ca_launch_cashier_undo(p_operation);
 PERFORM public.fn_ca_launch_incident_undo(p_operation);
 PERFORM public.fn_ca_launch_accounting_undo(p_operation);
 -- Compare every financial pre-position after both owners restored their data.
 FOR pos IN SELECT * FROM public.ca_launch_reset_positions WHERE operation_id=p_operation AND relation_name IN('club_members','agents','clubs','club_wallets','union_wallets','bbj_pools') ORDER BY relation_name,row_key::text,column_name LOOP
  predicate:=CASE WHEN pos.relation_name='club_members' THEN format('club_id=%L::uuid AND user_id=%L::uuid',pos.row_key->>'club_id',pos.row_key->>'user_id') ELSE format('id=%L::uuid',pos.row_key->>'id') END;
  EXECUTE format('SELECT %I FROM public.%I WHERE %s',pos.column_name,pos.relation_name,predicate) INTO got;
  GET DIAGNOSTICS selected_rows=ROW_COUNT;
  IF selected_rows<>1 OR got IS DISTINCT FROM pos.balance THEN RAISE EXCEPTION 'LAUNCH_UNDO_DID_NOT_RESTORE_EXACT_POSITION: % %',pos.relation_name,pos.column_name; END IF;
 END LOOP;
 UPDATE public.ca_launch_reset_operations SET state='undone',undone_at=clock_timestamp() WHERE operation_id=p_operation;
 RETURN jsonb_build_object('operation_id',p_operation,'state','undone','closing_sha256',op.closing_sha256,'journals_retained',true);
END $function$
;
DO $undo_post$ BEGIN IF ((SELECT md5(pg_get_functiondef(q.oid))='813c1fa09b96c64ae2e3f97dfc66b868' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef=true AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public, pg_temp", "lock_timeout=4s"]'::jsonb FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_reset_undo(uuid,text)')) IS TRUE) IS DISTINCT FROM true THEN RAISE EXCEPTION 'DELETED_COHORT_UNDO_POSTIMAGE_CHANGED'; END IF; END $undo_post$;

SET LOCAL lock_timeout='4s';
DO $g$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_launch_accounting_activate(uuid)'::regprocedure) IS DISTINCT FROM 'c558b93e2d40072e417e6302e919c5d1' THEN RAISE EXCEPTION 'LAUNCH_CURRENT_WEEK_SOURCE_CHANGED';END IF;END $g$;
DO $g$ BEGIN IF md5(pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure)) IS DISTINCT FROM '39de1456bce14bd2b431197050e3d51e' THEN RAISE EXCEPTION 'LAUNCH_CURRENT_WEEK_SOURCE_CHANGED';END IF;END $g$;
DO $authority$ BEGIN IF NOT EXISTS(SELECT FROM pg_proc WHERE oid='public.fn_ca_launch_accounting_activate(uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='f7f6441f8812fd3d4180bd8fa107dee3' AND pg_get_userbyid(proowner)='postgres' AND prosecdef IS TRUE AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public','TimeZone=UTC']) THEN RAISE EXCEPTION 'LAUNCH_CURRENT_WEEK_AUTHORITY_CHANGED';END IF;END $authority$;
DO $authority$ BEGIN IF NOT EXISTS(SELECT FROM pg_proc WHERE oid='public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure AND md5(pg_get_functiondef(oid))='39de1456bce14bd2b431197050e3d51e' AND pg_get_userbyid(proowner)='postgres' AND prosecdef IS TRUE AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=public','statement_timeout=300s']) THEN RAISE EXCEPTION 'LAUNCH_CURRENT_WEEK_AUTHORITY_CHANGED';END IF;END $authority$;
CREATE FUNCTION public.fn_ca_launch_rakeback_period_waived(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $h$
 SELECT EXISTS(SELECT FROM public.rakeback_periods p JOIN public.ca_launch_accounting_boundaries b ON b.scope_kind='club' AND b.scope_id=p.club_id AND b.undone_at IS NULL
 JOIN public.ca_launch_reset_operations o ON o.operation_id=b.operation_id AND o.state='executed'
 JOIN public.ca_launch_accounting_archives a ON a.operation_id=b.operation_id AND a.relation_name='rakeback_periods' AND a.row_key=jsonb_build_array(p.id)::text
 WHERE p.id=p_id AND p.status='expired' AND p.paid_at IS NULL AND p.deferred_reason='Owner Directed Launch Waiver '||b.operation_id::text
 AND p.created_at<b.cutoff_at AND p.period_start=(public.fn_union_week_start(b.cutoff_at) AT TIME ZONE 'America/Los_Angeles')::date
 AND a.before_image->>'status'='pending' AND a.before_image->'paid_at'='null'::jsonb
 AND a.before_image->>'id'=p.id::text AND a.before_image->>'club_id'=p.club_id::text
 AND (to_jsonb(p)-ARRAY['status','deferred_reason','deferred_at']) IS NOT DISTINCT FROM (a.before_image-ARRAY['status','deferred_reason','deferred_at'])
 AND encode(sha256(convert_to(a.before_image::text,'UTF8')),'hex')=a.row_sha256
 AND NOT EXISTS(SELECT FROM public.rakeback_period_payouts x WHERE x.rakeback_period_id=p.id));
$h$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_rakeback_period_waived(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_launch_accounting_activate(p_operation uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE o record;r record;v_rows jsonb;v_after jsonb;v_saved text;v_columns text[];v_set text;v_predicate text;
 v_relations text[]:=ARRAY['club_members','agents','clubs','unions','settlement_invoices','credit_invoices','rakeback_periods','club_settlement_floor','union_settlement_floor','player_stats','player_stats_snapshots','club_member_daily_stats','club_member_play_totals','ca_club_commission_daily','ca_club_rake_daily','ca_club_rake_daily_user','club_rake_daily_user','club_rake_rollup_complete','club_table_rake_totals','club_hand_daily_shard','club_member_table_state','accounting_rakeback_period_evidence_checkpoints','accounting_recompute_split_parts','accounting_period_recompute_requests','ca_club_player_daily','ca_club_tournament_daily','ca_club_tournament_player_daily','club_table_daily','union_rake_weekly'];
 v_relation text;
BEGIN
 IF public.fn_caller_is_engine() IS NOT TRUE OR public.fn_platform_frozen() IS NOT TRUE THEN RAISE EXCEPTION 'launch_accounting_requires_engine_and_freeze' USING ERRCODE='42501'; END IF;
 SELECT x.* INTO o FROM public.ca_launch_reset_operations x WHERE x.operation_id=p_operation FOR UPDATE;
 IF NOT FOUND OR o.state<>'captured' OR NOT isfinite(o.captured_at) OR
  (SELECT array_agg(x ORDER BY x) FROM unnest(o.scoped_club_ids)x) IS DISTINCT FROM ARRAY['2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,'a0000000-0000-0000-0000-000000000001'::uuid,'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,'fade0000-0000-0000-0000-000000000001'::uuid]
 THEN RAISE EXCEPTION 'launch_accounting_operation_scope_or_state_invalid'; END IF;
 IF EXISTS(SELECT 1 FROM public.ca_launch_accounting_boundaries WHERE operation_id=p_operation) THEN RAISE EXCEPTION 'launch_accounting_already_activated'; END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE s.left_at IS NULL AND s.user_id IS NOT NULL AND (t.club_id=ANY(o.scoped_club_ids) OR t.union_id=ANY(o.scoped_club_ids))) THEN RAISE EXCEPTION 'launch_accounting_live_scope_seats'; END IF;
 -- Today's week has not been certified yet. Do not overwrite a paid or cached current-week certificate.
 IF EXISTS(SELECT 1 FROM public.rakeback_periods p WHERE p.club_id=ANY(o.scoped_club_ids) AND p.period_start=(public.fn_union_week_start(o.captured_at) AT TIME ZONE 'America/Los_Angeles')::date AND (p.status IS DISTINCT FROM 'pending' OR p.paid_at IS NOT NULL OR p.created_at IS NULL OR p.created_at>=o.captured_at OR EXISTS(SELECT FROM public.rakeback_period_payouts x WHERE x.rakeback_period_id=p.id))) THEN RAISE EXCEPTION 'launch_accounting_current_week_period_requires_qualification'; END IF;
 v_saved:=current_setting('app.launch_reset_operation',true);PERFORM set_config('app.launch_reset_operation',p_operation::text,true);
 FOREACH v_relation IN ARRAY v_relations LOOP
  EXECUTE 'INSERT INTO public.ca_launch_accounting_archives(operation_id,relation_name,row_key,before_image,row_sha256,captured_at) SELECT $3,$4,e.row_key,e.row_image,encode(sha256(convert_to(e.row_image::text,''UTF8'')),''hex''),$5 FROM ('||public.fn_ca_launch_accounting_store_query(v_relation,NULL)||')e' USING o.scoped_club_ids,NULL::text[],p_operation,v_relation,o.captured_at;
 END LOOP;
 INSERT INTO public.ca_launch_profile_hand_baselines(operation_id,user_id,hand_offset,captured_total_hands,remaining_club_hands,restored_scope_hands,captured_at)
 SELECT p_operation,p.id,COALESCE(p.total_hands_played,0)-COALESCE((SELECT sum(s.hands_played) FROM public.player_stats s WHERE s.user_id=p.id AND (s.club_id=ANY(o.scoped_club_ids)) IS NOT TRUE),0),COALESCE(p.total_hands_played,0),COALESCE((SELECT sum(s.hands_played) FROM public.player_stats s WHERE s.user_id=p.id AND (s.club_id=ANY(o.scoped_club_ids)) IS NOT TRUE),0),COALESCE((SELECT sum(s.hands_played) FROM public.player_stats s WHERE s.user_id=p.id AND s.club_id=ANY(o.scoped_club_ids)),0),o.captured_at
 FROM public.profiles p WHERE EXISTS(SELECT 1 FROM public.club_members m WHERE m.user_id=p.id AND m.club_id=ANY(o.scoped_club_ids)) OR EXISTS(SELECT 1 FROM public.player_stats s WHERE s.user_id=p.id AND s.club_id=ANY(o.scoped_club_ids));
 INSERT INTO public.ca_launch_accounting_boundaries(scope_kind,scope_id,operation_id,cutoff_at) SELECT 'club',x,p_operation,o.captured_at FROM unnest(o.scoped_club_ids)x;
 INSERT INTO public.ca_launch_accounting_boundaries(scope_kind,scope_id,operation_id,cutoff_at) VALUES('union','fade0000-0000-0000-0000-000000000001',p_operation,o.captured_at);
 UPDATE public.club_members SET credit_used=0,sessions_played=0,chips_won=0,chips_lost=0,hands_played=0,total_rake_paid=0,biggest_pot=0,promo_received_total=0,promo_wagered=0,promo_playthrough_required=0,missions_completed=0 WHERE club_id=ANY(o.scoped_club_ids);
 UPDATE public.agents SET credit_used=0,weekly_rake_generated=0,lifetime_earnings=0,lifetime_rake_generated=0 WHERE club_id=ANY(o.scoped_club_ids);
 UPDATE public.clubs SET total_rake=0,hands_played=0 WHERE id=ANY(o.scoped_club_ids);
 UPDATE public.unions SET total_rake=0 WHERE id=ANY(o.scoped_club_ids);
 UPDATE public.settlement_invoices SET status='cancelled',updated_at=o.captured_at WHERE club_id=ANY(o.scoped_club_ids) AND status IN('pending','generated','overdue','disputed');
 UPDATE public.credit_invoices c SET status='void',amount_remaining=0,void_reason='Owner Directed Launch Waiver '||p_operation::text WHERE status IN('pending','partial','overdue','disputed') AND EXISTS(SELECT 1 FROM public.agents a WHERE a.id=c.agent_id AND a.club_id=ANY(o.scoped_club_ids));
 UPDATE public.rakeback_periods SET status='expired',deferred_reason='Owner Directed Launch Waiver '||p_operation::text,deferred_at=o.captured_at WHERE club_id=ANY(o.scoped_club_ids) AND status IN('pending','open','closed','claiming');
 INSERT INTO public.club_settlement_floor(club_id,earliest_period_start,reason) SELECT x,public.fn_union_week_start(o.captured_at),'Owner Directed Launch Waiver '||p_operation::text FROM unnest(o.scoped_club_ids)x ON CONFLICT(club_id) DO UPDATE SET earliest_period_start=EXCLUDED.earliest_period_start,reason=EXCLUDED.reason;
 INSERT INTO public.union_settlement_floor(union_id,earliest_period_start,reason) VALUES('fade0000-0000-0000-0000-000000000001',public.fn_union_week_start(o.captured_at),'Owner Directed Launch Waiver '||p_operation::text) ON CONFLICT(union_id) DO UPDATE SET earliest_period_start=EXCLUDED.earliest_period_start,reason=EXCLUDED.reason;
 FOREACH v_relation IN ARRAY v_relations[10:29] LOOP
  IF v_relation='club_member_table_state' THEN EXECUTE 'DELETE FROM public.club_member_table_state t WHERE EXISTS(SELECT 1 FROM public.tables x WHERE x.id=t.table_id AND x.club_id=ANY($1))' USING o.scoped_club_ids;
  ELSE EXECUTE format('DELETE FROM public.%I t WHERE t.club_id=ANY($1)',v_relation) USING o.scoped_club_ids;END IF;
 END LOOP;
 FOREACH v_relation IN ARRAY v_relations LOOP
  v_columns:=CASE v_relation
   WHEN 'club_members' THEN ARRAY['credit_used','sessions_played','chips_won','chips_lost','hands_played','total_rake_paid','biggest_pot','promo_received_total','promo_wagered','promo_playthrough_required','missions_completed']
   WHEN 'agents' THEN ARRAY['credit_used','weekly_rake_generated','lifetime_earnings','lifetime_rake_generated']
   WHEN 'clubs' THEN ARRAY['total_rake','hands_played'] WHEN 'unions' THEN ARRAY['total_rake']
   WHEN 'settlement_invoices' THEN ARRAY['status','updated_at'] WHEN 'credit_invoices' THEN ARRAY['status','amount_remaining','void_reason']
   WHEN 'rakeback_periods' THEN ARRAY['status','deferred_reason','deferred_at']
   WHEN 'club_settlement_floor' THEN ARRAY['earliest_period_start','reason'] WHEN 'union_settlement_floor' THEN ARRAY['earliest_period_start','reason'] ELSE NULL END;
  EXECUTE 'INSERT INTO public.ca_launch_accounting_postimages(operation_id,relation_name,row_key,row_image,row_sha256) SELECT $3,$4,e.row_key,e.row_image,encode(sha256(convert_to(e.row_image::text,''UTF8'')),''hex'') FROM ('||public.fn_ca_launch_accounting_store_query(v_relation,v_columns)||')e' USING o.scoped_club_ids,v_columns,p_operation,v_relation;
  INSERT INTO public.ca_launch_accounting_store_receipts(operation_id,relation_name,mutated_columns,after_row_count,receipt_sha256)
  SELECT p_operation,v_relation,v_columns,count(*),encode(sha256(convert_to(p_operation::text||':'||v_relation||':'||count(*)::text,'UTF8')),'hex') FROM public.ca_launch_accounting_postimages WHERE operation_id=p_operation AND relation_name=v_relation;
 END LOOP;
 PERFORM public.fn_ca_launch_accounting_analyze(p_operation);
 PERFORM set_config('app.launch_reset_operation',COALESCE(v_saved,''),true);
 RETURN jsonb_build_object('activated',true,'operation_id',p_operation,'cutoff_at',o.captured_at,'relations',cardinality(v_relations),'waiver_is_payment',false);
END $$;
CREATE OR REPLACE FUNCTION public.fn_calculate_cash_rakeback_periods(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
 tournament_quality jsonb;v_from timestamptz; v_to timestamptz; cutover timestamptz; receipt jsonb;
 scope_union uuid; issue_count bigint; existing public.rakeback_periods%ROWTYPE;
 evidence_issues bigint; incomplete_issues bigint; drifted_issues bigint;
 certificate public.accounting_rakeback_period_calculations%ROWTYPE;
 player record; total_unrounded numeric; amount numeric; display_rate numeric;
 payer_kind text; payer_user uuid; coordinator_union uuid; allocations jsonb; plan jsonb;
 fingerprint text; period_id uuid; written integer:=0; confirmed integer:=0;
 digest_now text; evidence_cp public.accounting_rakeback_period_evidence_checkpoints%ROWTYPE; counts record;
 base_horizon timestamptz; next_horizon timestamptz; base_records bigint; base_evidence bigint; base_incomplete bigint; base_drifted bigint;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6
    OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids)>2000 OR array_position(p_user_ids,NULL) IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid_accounting_period_request' USING ERRCODE='22023'; END IF;
 receipt:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'written',0,'status','blocked');
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_from:=public.fn_ca_launch_accounting_start('club',p_club_id,v_from);
 SELECT starts_at INTO cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
 IF cutover IS NULL OR v_from<cutover THEN RETURN receipt||jsonb_build_object('reason','historical_week_before_observed_source_cutover'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||p_club_id::text||':'||p_period_start::text,0));
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
 IF p_user_ids IS NULL THEN
 -- Tournament fees are earned at terminal recognition. Open captured fees
 -- are excluded; deferred or missing terminal authority blocks its actual week.
 tournament_quality:=public.fn_accounting_tournament_week_quality(p_club_id,v_from,v_to);
 IF tournament_quality->>'status' IS DISTINCT FROM 'ready' THEN
  RETURN receipt||tournament_quality||jsonb_build_object('written',0);END IF;
 -- One pass over the week feeds all three source-evidence counts. They are
 -- TESTED below in the original order, so the reason a bad week reports is
 -- unchanged; only the number of times the week is read has.
 WITH week_records AS MATERIALIZED (
  SELECT r.id,r.hand_id,r.club_id,r.rake_amount,r.created_at
   FROM public.rake_records r
   WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
     AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
     -- fn_rake_record_is_ghost_twin returns false the moment hand_id is not
     -- null, so `hand_id IS NOT NULL OR NOT ghost_twin(...)` is the same
     -- predicate - but OR short-circuits, so a linked row never detoasts its
     -- metadata and never runs the function's EXISTS over
     -- idx_rake_records_table_id. 2,652 ms -> 348 ms for the week slice.
     AND (r.hand_id IS NOT NULL OR NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata))
 ), club_attributions AS MATERIALIZED (
  -- Only this week's records reach the two counts that read this slice, so
  -- joining it to week_records is exact. Reading the club's whole history
  -- grew without bound (20260926042810).
  SELECT a.id,a.rake_record_id,a.hand_id,a.player_id,a.club_id,a.weighted_rake_credit
   FROM week_records w JOIN public.rake_attributions a ON a.rake_record_id=w.id
   WHERE a.club_id=p_club_id
 ), week_batches AS MATERIALIZED (
  SELECT b.rake_record_id,b.status FROM public.accounting_cash_accrual_batches b
   JOIN week_records w ON w.id=b.rake_record_id
 ), week_sources AS MATERIALIZED (
  -- A source can only be the PERFECT match the count below looks for if its
  -- club_id is this club and its earned_at is the record's created_at, which
  -- is inside the week by construction. Narrowing to the club-week slice
  -- therefore preserves every perfect match and every miss, and the existing
  -- accounting_cash_rake_sources_period index serves it directly instead of
  -- detoasting `contract` for the whole table.
  SELECT s.id,s.rake_record_id,s.player_id,s.club_id,s.earned_at,s.rake_credit,
   s.contract->>'attribution_id' AS c_attribution,s.contract->>'player_id' AS c_player,s.contract->>'club_id' AS c_club
   FROM public.accounting_cash_rake_sources s
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
 ), scoped_records AS (
  SELECT w.* FROM week_records w
   WHERE w.club_id=p_club_id
     OR EXISTS(SELECT 1 FROM club_attributions a WHERE a.rake_record_id=w.id)
     OR EXISTS(SELECT 1 FROM public.clubs house WHERE house.id=w.club_id AND house.is_union IS TRUE
        AND scope_union IS NOT NULL AND (house.union_id=scope_union OR house.id=scope_union))
 ), checks AS (
  SELECT r.id,r.hand_id,r.rake_amount,count(a.id) AS attribution_count,
    COALESCE(sum(a.weighted_rake_credit),0) AS attributed,
    count(a.id) FILTER(WHERE a.hand_id IS DISTINCT FROM r.hand_id OR a.club_id IS NULL
      OR a.player_id IS NULL OR a.weighted_rake_credit IS NULL OR a.weighted_rake_credit<0
      OR a.weighted_rake_credit<>round(a.weighted_rake_credit,2)
      -- NOT EXISTS(c WHERE id=a.club_id AND (P OR Q))
      --   = NOT EXISTS(c WHERE id=a.club_id AND P) AND NOT EXISTS(c WHERE id=a.club_id AND Q)
      OR (a.club_id NOT IN(SELECT c.id FROM public.clubs c WHERE c.is_union IS NOT TRUE)
       AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND c.is_union IS TRUE
        AND EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources hs
          JOIN public.accounting_cash_accrual_batches hb ON hb.rake_record_id=hs.rake_record_id
          WHERE hs.rake_record_id=r.id AND hs.player_id=a.player_id AND hs.club_id=a.club_id
           AND hs.union_id=scope_union AND (c.id=hs.union_id OR c.union_id=hs.union_id)
           AND hs.earned_at=r.created_at AND hs.rake_credit=a.weighted_rake_credit AND hb.status='accrued'
           AND hs.contract->>'is_union_house'='true' AND hs.contract->>'attribution_id'=a.id::text
           AND hs.contract->>'club_id'=a.club_id::text AND hs.contract->>'player_id'=a.player_id::text
           AND hs.contract->>'union_id'=hs.union_id::text)))) AS invalid_count
   FROM scoped_records r LEFT JOIN public.rake_attributions a ON a.rake_record_id=r.id
   GROUP BY r.id,r.hand_id,r.rake_amount
 ), evidence AS (
  SELECT count(*) AS n FROM checks WHERE hand_id IS NULL OR attribution_count=0
   OR invalid_count>0 OR attributed<>rake_amount OR rake_amount<>round(rake_amount,2)
 ), incomplete AS (
  SELECT count(*) AS n FROM club_attributions a JOIN week_records r ON r.id=a.rake_record_id
   LEFT JOIN week_sources s ON s.rake_record_id=r.id AND s.player_id=a.player_id
   LEFT JOIN week_batches b ON b.rake_record_id=r.id
   WHERE s.id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR s.club_id IS DISTINCT FROM a.club_id
     OR s.earned_at IS DISTINCT FROM r.created_at OR s.rake_credit IS DISTINCT FROM a.weighted_rake_credit
     OR s.c_attribution IS DISTINCT FROM a.id::text
     OR s.c_player IS DISTINCT FROM a.player_id::text OR s.c_club IS DISTINCT FROM a.club_id::text
 ), drifted AS (
  -- Bidirectional comparison also rejects an extra recorded source that no
  -- longer has an attribution. A matching subset is not a complete source set.
  SELECT count(*) AS n FROM public.accounting_cash_rake_sources s
   LEFT JOIN public.rake_records r ON r.id=s.rake_record_id
   LEFT JOIN public.rake_attributions a ON a.id=(s.contract->>'attribution_id')::uuid
   LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=s.rake_record_id
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
    AND (r.id IS NULL OR a.id IS NULL OR b.status IS DISTINCT FROM 'accrued'
     OR a.rake_record_id IS DISTINCT FROM s.rake_record_id OR a.hand_id IS DISTINCT FROM r.hand_id
     OR a.player_id IS DISTINCT FROM s.player_id OR a.club_id IS DISTINCT FROM s.club_id
     OR a.weighted_rake_credit IS DISTINCT FROM s.rake_credit OR s.earned_at IS DISTINCT FROM r.created_at
     OR r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL
     OR NULLIF(s.contract->'union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.union_id)
     OR NULLIF(s.contract->'coordinator_union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.coordinator_union_id))
 )
 SELECT evidence.n,incomplete.n,drifted.n INTO evidence_issues,incomplete_issues,drifted_issues
   FROM evidence,incomplete,drifted;
 IF evidence_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_earning_evidence_incomplete','source_count',evidence_issues); END IF;
 -- An old UTC or current-membership period remains an explicit conflict even
 -- when its numbers happen to match. Certificates establish the new writer.
 SELECT count(*) INTO issue_count FROM public.rakeback_periods rp
  WHERE rp.club_id=p_club_id AND rp.period_start<=p_period_end AND rp.period_end>=p_period_start AND public.fn_ca_launch_rakeback_period_waived(rp.id) IS NOT TRUE
    AND (rp.status<>'pending' OR rp.period_start<>p_period_start OR rp.period_end<>p_period_end
      OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=rp.id));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','legacy_or_paid_period_requires_reconciliation','period_count',issue_count); END IF;
 IF incomplete_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_incomplete','source_count',incomplete_issues); END IF;
 IF drifted_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',drifted_issues); END IF;
 ELSE
 -- A PAGE READS ONLY THE EVIDENCE THAT CHANGED (20260930232349, re-derived from 20260927160709).
 -- The three week-level counts below are sums over the week's cash records.
 -- A record whose accrual batch exists is frozen: rake_records and
 -- rake_attributions refuse every change once it has one, and the batch and
 -- its sources are insert-only and written together. So its share of each
 -- count never changes while the clubs' union shape stays as it was. The
 -- checkpoint keeps those shares for every batch recorded before its horizon
 -- (a time no transaction still running had started by), and this page adds
 -- the batches recorded since and the records that have no batch yet, read in
 -- one snapshot. The totals are exactly the whole-week counts. The whole
 -- period call above keeps its own full verification.
 digest_now:=public.fn_accounting_clubs_scope_digest();
 SELECT * INTO evidence_cp FROM public.accounting_rakeback_period_evidence_checkpoints cp
  WHERE cp.club_id=p_club_id AND cp.period_start=p_period_start FOR UPDATE;
 IF FOUND AND evidence_cp.period_end=p_period_end AND evidence_cp.clubs_digest=digest_now THEN
  base_horizon:=evidence_cp.horizon;base_records:=evidence_cp.settled_records;
  base_evidence:=evidence_cp.settled_evidence;base_incomplete:=evidence_cp.settled_incomplete;base_drifted:=evidence_cp.settled_drifted;
 ELSE
  -- No checkpoint yet, or the union shape it was taken under has changed:
  -- start again from the week's first batch.
  base_horizon:='-infinity';base_records:=0;base_evidence:=0;base_incomplete:=0;base_drifted:=0;
 END IF;
 next_horizon:=public.fn_accounting_commit_horizon();
 IF next_horizon IS NULL OR next_horizon<base_horizon THEN next_horizon:=base_horizon; END IF;
 SELECT * INTO counts FROM public.fn_cash_period_evidence_since(p_club_id,v_from,v_to,scope_union,base_horizon,next_horizon);
 evidence_issues:=base_evidence+counts.o_evidence;
 incomplete_issues:=base_incomplete+counts.o_incomplete;
 drifted_issues:=base_drifted+counts.o_drifted;
 INSERT INTO public.accounting_rakeback_period_evidence_checkpoints AS cp(club_id,period_start,period_end,horizon,clubs_digest,
   settled_records,settled_evidence,settled_incomplete,settled_drifted)
  VALUES(p_club_id,p_period_start,p_period_end,next_horizon,digest_now,base_records+counts.o_settled_records,
   base_evidence+counts.o_settled_evidence,base_incomplete+counts.o_settled_incomplete,base_drifted+counts.o_settled_drifted)
  ON CONFLICT(club_id,period_start) DO UPDATE SET period_end=EXCLUDED.period_end,horizon=EXCLUDED.horizon,
   clubs_digest=EXCLUDED.clubs_digest,settled_records=EXCLUDED.settled_records,settled_evidence=EXCLUDED.settled_evidence,
   settled_incomplete=EXCLUDED.settled_incomplete,settled_drifted=EXCLUDED.settled_drifted,
   built_at=CASE WHEN base_horizon='-infinity'::timestamptz THEN clock_timestamp() ELSE cp.built_at END,
   advanced_at=clock_timestamp(),advances=cp.advances+1;
 -- Any of these refuses the page whatever the tournament gate says, so the
 -- gate is asked only when none does. Same reasons, counts and order as below.
 IF evidence_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_earning_evidence_incomplete','source_count',evidence_issues); END IF;
 SELECT count(*) INTO issue_count FROM public.rakeback_periods rp
  WHERE rp.club_id=p_club_id AND rp.period_start<=p_period_end AND rp.period_end>=p_period_start AND public.fn_ca_launch_rakeback_period_waived(rp.id) IS NOT TRUE
    AND (rp.status<>'pending' OR rp.period_start<>p_period_start OR rp.period_end<>p_period_end
      OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=rp.id));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','legacy_or_paid_period_requires_reconciliation','period_count',issue_count); END IF;
 IF incomplete_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_incomplete','source_count',incomplete_issues); END IF;
 IF drifted_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',drifted_issues); END IF;
 tournament_quality:=public.fn_accounting_tournament_week_quality(p_club_id,v_from,v_to);
 IF tournament_quality->>'status' IS DISTINCT FROM 'ready' THEN
  RETURN receipt||tournament_quality||jsonb_build_object('written',0);END IF;
 END IF;

 FOR player IN
  WITH receipts AS (
   SELECT s.source_type,s.source_id,s.rake_record_id,s.player_id,s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,
    CASE WHEN s.source_type='tournament_fee_accrual' THEN public.fn_accounting_tournament_source_terms_at(fee.tournament_id,fee.charged_at,fee.contract) ELSE s.earned_at END AS agreement_at,
    s.contract->'membership'->'terms' AS member,s.contract->'tiers'->0 AS direct,
    (s.contract->'membership'->>'history_id')::bigint AS member_history_ref,
    sum(s.rake_credit) OVER(PARTITION BY s.player_id) AS total_rake
   FROM public.accounting_payable_earning_sources s
   -- A cash row has no fee row, and a NULL join key never enters the index.
   LEFT JOIN public.accounting_tournament_fee_sources fee
     ON fee.id=CASE WHEN s.source_type='tournament_fee_accrual' THEN s.source_id END
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
     AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))
  ), parsed AS (
   SELECT r.*,NULLIF(r.member->>'agent_id','')::uuid AS member_agent,
    COALESCE((r.member->>'player_rakeback_pct')::numeric,0) AS deal,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL
      THEN COALESCE((r.direct->'agreement'->'terms'->>'player_rakeback_rate')::numeric,0) ELSE 0 END AS offer,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL THEN (r.direct->>'rate')::numeric END AS cap_rate,
    mh.id AS member_history_id,ah.id AS agent_history_id,
    mh.after_terms AS recorded_member,ah.after_terms AS recorded_agent
   FROM receipts r
   LEFT JOIN public.accounting_agreement_history mh ON mh.id=r.member_history_ref
    AND mh.entity_type='club_members' AND mh.entity_key=p_club_id::text||':'||r.player_id::text AND mh.observed_at<=r.agreement_at
   LEFT JOIN public.accounting_agreement_history ah ON ah.id=(r.direct->'agreement'->>'history_id')::bigint
    AND ah.entity_type='agents' AND ah.observed_at<=r.agreement_at
  ), rates AS (
   SELECT p.*,CASE WHEN p.deal>0 THEN p.deal WHEN p.offer>0 THEN p.offer
    WHEN p.total_rake>=10000 THEN 0.30 WHEN p.total_rake>=2000 THEN 0.20
    WHEN p.total_rake>=500 THEN 0.15 WHEN p.total_rake>=100 THEN 0.10 ELSE 0.05 END AS base_rate
   FROM parsed p
  ), effective AS (
   SELECT r.*,CASE WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate
   FROM rates r
  )
  SELECT e.player_id,max(e.total_rake) AS total_rake,sum(e.rake_credit*e.applied_rate) AS total_unrounded,
   count(*) FILTER(WHERE e.member_history_id IS NULL OR e.member IS DISTINCT FROM e.recorded_member
    OR e.member->>'club_id' IS DISTINCT FROM p_club_id::text OR e.member->>'user_id' IS DISTINCT FROM e.player_id::text
    OR COALESCE(e.member->>'status','') NOT IN('active','approved') OR e.member->>'is_active' IS DISTINCT FROM 'true') AS invalid_members,
   count(*) FILTER(WHERE e.member_agent IS NOT NULL AND (e.direct IS NULL OR e.agent_history_id IS NULL
    OR e.direct->'agreement'->'terms' IS DISTINCT FROM e.recorded_agent
    OR e.direct->>'user_id' IS DISTINCT FROM e.member_agent::text OR e.direct->>'depth' IS DISTINCT FROM '1'
    OR e.recorded_agent->>'club_id' IS DISTINCT FROM p_club_id::text OR e.recorded_agent->>'user_id' IS DISTINCT FROM e.member_agent::text
    OR e.recorded_agent->>'status' IS DISTINCT FROM 'active')) AS invalid_agents,
   count(*) FILTER(WHERE e.deal::text IN('NaN','Infinity','-Infinity') OR e.offer::text IN('NaN','Infinity','-Infinity')
    OR e.deal<0 OR e.deal>1 OR e.offer<0 OR e.offer>1
    OR (e.member_agent IS NOT NULL AND (e.cap_rate IS NULL OR e.cap_rate<0 OR e.cap_rate>1 OR e.cap_rate::text IN('NaN','Infinity','-Infinity')))) AS invalid_rates,
   count(DISTINCT COALESCE(e.member_agent::text,'club')) AS payer_count,
   count(DISTINCT COALESCE(e.coordinator_union_id::text,'standalone')) AS coordinator_count,
   min(e.member_agent::text)::uuid AS payer_user,
   min(e.coordinator_union_id::text)::uuid AS coordinator_union,
   jsonb_agg(jsonb_build_object('source_type',e.source_type,'source_id',e.source_id,'rake_record_id',e.rake_record_id,'union_id',e.union_id,
    'coordinator_union_id',e.coordinator_union_id,'rake_credit',e.rake_credit,'rate',e.applied_rate,
    'unrounded_rakeback',e.rake_credit*e.applied_rate,'earned_at',e.earned_at,'agreement_at',e.agreement_at,'membership_history_id',e.member_history_id,
    'agent_history_id',e.agent_history_id,'payer_kind',CASE WHEN e.member_agent IS NULL THEN 'club' ELSE 'agent' END,
    'payer_user_id',e.member_agent) ORDER BY e.earned_at,e.source_type,e.rake_record_id,e.source_id) AS allocations
  FROM effective e GROUP BY e.player_id ORDER BY e.player_id
 LOOP
  IF player.invalid_members>0 THEN RAISE EXCEPTION 'period_membership_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_agents>0 THEN RAISE EXCEPTION 'period_direct_agent_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_rates>0 THEN RAISE EXCEPTION 'period_observed_rate_invalid' USING ERRCODE='55000'; END IF;
  IF player.payer_count<>1 THEN RAISE EXCEPTION 'multiple_historical_payers_require_split_period' USING ERRCODE='55000'; END IF;
  IF player.coordinator_count<>1 THEN RAISE EXCEPTION 'multiple_recorded_coordinators_require_split_period' USING ERRCODE='55000'; END IF;
  total_unrounded:=player.total_unrounded;allocations:=player.allocations;payer_user:=player.payer_user;coordinator_union:=player.coordinator_union;
  payer_kind:=CASE WHEN payer_user IS NULL THEN 'club' ELSE 'agent' END;
  amount:=round(total_unrounded,2);
  display_rate:=CASE WHEN player.total_rake>0 THEN round(total_unrounded/player.total_rake,4) ELSE 0 END;
  IF amount>player.total_rake OR amount<0 THEN RAISE EXCEPTION 'period_rakeback_not_conserved' USING ERRCODE='55000'; END IF;
  fingerprint:=md5(jsonb_build_object('allocations',allocations,'rake',player.total_rake,'amount',amount,'rate',display_rate)::text);
  plan:=jsonb_build_object('player_id',player.player_id,'rake_generated',player.total_rake,
   'rakeback_amount',amount,'display_rate',display_rate,'coordinator_union_id',coordinator_union,'payer_kind',payer_kind,'payer_user_id',payer_user,
   'source_fingerprint',fingerprint,'allocations',allocations);
  SELECT * INTO existing FROM public.rakeback_periods WHERE club_id=p_club_id AND user_id=(plan->>'player_id')::uuid
    AND period_start=p_period_start AND period_end=p_period_end FOR UPDATE;
  IF FOUND AND public.fn_ca_launch_rakeback_period_waived(existing.id) THEN
   period_id:=existing.id;
   UPDATE public.rakeback_periods SET status='pending',paid_at=NULL,deferred_reason=NULL,deferred_at=NULL,
    rake_generated=(plan->>'rake_generated')::numeric,total_rake_paid=(plan->>'rake_generated')::numeric,
    rakeback_rate=(plan->>'display_rate')::numeric,rakeback_earned=(plan->>'rakeback_amount')::numeric,rakeback_amount=(plan->>'rakeback_amount')::numeric
    WHERE id=period_id;
  ELSIF FOUND THEN
   SELECT * INTO certificate FROM public.accounting_rakeback_period_calculations cert WHERE cert.period_id=existing.id ORDER BY cert.id DESC LIMIT 1;
   IF NOT FOUND OR certificate.accounting_version<>2 OR certificate.club_id IS DISTINCT FROM p_club_id
    OR certificate.player_id IS DISTINCT FROM existing.user_id OR certificate.period_start IS DISTINCT FROM p_period_start
    OR certificate.period_end IS DISTINCT FROM p_period_end
    OR existing.status<>'pending' OR existing.rake_generated IS DISTINCT FROM certificate.rake_generated
    OR existing.total_rake_paid IS DISTINCT FROM certificate.rake_generated OR existing.rakeback_rate IS DISTINCT FROM certificate.display_rate
    OR existing.rakeback_earned IS DISTINCT FROM certificate.rakeback_amount OR existing.rakeback_amount IS DISTINCT FROM certificate.rakeback_amount
   THEN RAISE EXCEPTION 'certified_period_drift_requires_reconciliation' USING ERRCODE='55000'; END IF;
   period_id:=existing.id;
   IF certificate.source_fingerprint=plan->>'source_fingerprint' THEN confirmed:=confirmed+1; CONTINUE; END IF;
   UPDATE public.rakeback_periods SET rake_generated=(plan->>'rake_generated')::numeric,total_rake_paid=(plan->>'rake_generated')::numeric,
    rakeback_rate=(plan->>'display_rate')::numeric,rakeback_earned=(plan->>'rakeback_amount')::numeric,rakeback_amount=(plan->>'rakeback_amount')::numeric
    WHERE id=period_id;
  ELSE
   INSERT INTO public.rakeback_periods(user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_earned,rakeback_amount,total_rake_paid,status)
    VALUES((plan->>'player_id')::uuid,p_club_id,p_period_start,p_period_end,(plan->>'rake_generated')::numeric,
     (plan->>'display_rate')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rake_generated')::numeric,'pending')
    RETURNING id INTO period_id;
  END IF;
  INSERT INTO public.accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,
    rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
   VALUES(period_id,plan->>'source_fingerprint',p_club_id,(plan->>'player_id')::uuid,(plan->>'coordinator_union_id')::uuid,p_period_start,p_period_end,
    (plan->>'rake_generated')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'display_rate')::numeric,
    plan->>'payer_kind',(plan->>'payer_user_id')::uuid,plan->'allocations');
  written:=written+1;confirmed:=confirmed+1;
 END LOOP;
 RETURN receipt||jsonb_build_object('status','ready','written',written,'confirmed_players',confirmed);
EXCEPTION WHEN SQLSTATE '55000' THEN
 RETURN receipt||jsonb_build_object('reason',SQLERRM);
END $function$
;

DO $launch_postimages$ BEGIN
 IF ((SELECT md5(pg_get_functiondef(q.oid))='a7b64f40053a275b392655589f12699f' AND md5(q.prosrc)='0a0290ffe8c43b21952d89af2e4d051c' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef IS TRUE AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=public", "statement_timeout=300s"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])')) IS TRUE) IS DISTINCT FROM true THEN RAISE EXCEPTION 'LAUNCH_CURRENT_WEEK_POSTIMAGE_OR_AUTHORITY_CHANGED'; END IF;
 IF ((SELECT md5(pg_get_functiondef(q.oid))='c2a380396a8d74304e07c817c4424ea1' AND md5(q.prosrc)='41637a44f6d62daf0a4a710d566714b8' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef IS TRUE AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=pg_catalog, public", "TimeZone=UTC"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_accounting_activate(uuid)')) IS TRUE) IS DISTINCT FROM true THEN RAISE EXCEPTION 'LAUNCH_CURRENT_WEEK_POSTIMAGE_OR_AUTHORITY_CHANGED'; END IF;
 IF ((SELECT md5(pg_get_functiondef(q.oid))='fbd19ea9e600c43effef72dae3cd2283' AND md5(q.prosrc)='9d54b5d52359a49ead5efc2ac4ae1c9a' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef IS TRUE AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=pg_catalog, public"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_rakeback_period_waived(uuid)')) IS TRUE) IS DISTINCT FROM true THEN RAISE EXCEPTION 'LAUNCH_CURRENT_WEEK_POSTIMAGE_OR_AUTHORITY_CHANGED'; END IF;
END $launch_postimages$;
COMMIT;
