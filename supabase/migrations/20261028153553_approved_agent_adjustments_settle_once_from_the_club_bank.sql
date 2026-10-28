-- An already approved positive agent adjustment settles through the existing
-- club treasury, agent alias sync and original balance/ledger invariant owners.
-- It never reprices or rewrites paid periods, source contracts or commissions.
-- Journal performer is the existing real original-R2 platform attribution;
-- metadata separately records postgres execution and standing approval. The
-- audit reader retains its truthful single_actor classification without an exception.
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure))='1edc12539a8b79db0614bf0470a3cf23'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_adjustments_report(timestamptz)'::regprocedure))='ce9438bbfc0ce1f7c88348889683fb00'
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $pre$
BEGIN
 IF to_regprocedure('public.fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)')IS NOT NULL OR EXISTS(SELECT FROM public.ca_money_rpc_registry WHERE proname='fn_ca_settle_approved_agent_adjustment')THEN RAISE EXCEPTION 'approved_agent_adjustment_owner_already_exists';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_adjustments_report(timestamptz)'::regprocedure))<>'d497da70300bfd0bee940d1517645bdc'THEN RAISE EXCEPTION 'approved_agent_adjustment_audit_preimage_changed';END IF;
 IF md5(pg_get_functiondef('public.enforce_chip_ledger_performed_by()'::regprocedure))<>'ed92ea331aeddaffca0ae46a7f6801ea'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'enforce_chip_ledger_performed_by()';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_autoledger()'::regprocedure))<>'620ce72294bdf8e3c8d3c556c8de35c9'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_ca_autoledger()';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_balance_has_its_ledger_row()'::regprocedure))<>'2df7b3f67e95b8a6c0abe7ba3faff63c'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_ca_balance_has_its_ledger_row()';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_chip_ledger_enrich()'::regprocedure))<>'5931f47d922eea26ab1ea2b12f3f7c8c'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_ca_chip_ledger_enrich()';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_chip_store_declared()'::regprocedure))<>'d5b08956826e56a0d414db4bfd022d3b'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_ca_chip_store_declared()';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_current_epoch()'::regprocedure))<>'6a803a80ab2b368acdbded9435112f98'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_ca_current_epoch()';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])'::regprocedure))<>'2eb458ce27b0116d2f7ad4603ca719dd'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_ledger_tally_add(text,text,numeric)'::regprocedure))<>'03b49d93d25551e4e74dedbb5dc7c08e'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_ca_ledger_tally_add(text,text,numeric)';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_ledger_tally_key(text,uuid,uuid)'::regprocedure))<>'ff30c09043719389496193946bbec15e'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_ca_ledger_tally_key(text,uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_refuse_replica_money_write()'::regprocedure))<>'42ed613371ddac424b618f5ac767a733'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_ca_refuse_replica_money_write()';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_tally_balance_move()'::regprocedure))<>'b7911a245d4bf33134a9a2f474c1f410'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_ca_tally_balance_move()';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_tally_ledger_leg()'::regprocedure))<>'9b3ab2f5a78cb7fa0adfb377706ecb85'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_ca_tally_ledger_leg()';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_tally_pair(text,numeric,text,numeric)'::regprocedure))<>'54e8f073910b0a538bf26d8e625cce33'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_ca_tally_pair(text,numeric,text,numeric)';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_tally_store_move()'::regprocedure))<>'6db4f04e33013c8f9b00e2155b31e72d'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_ca_tally_store_move()';END IF;
 IF md5(pg_get_functiondef('public.fn_cashier_assert_active_actor(uuid)'::regprocedure))<>'3ceb097db1a05a550e8b2a42fe931d36'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_cashier_assert_active_actor(uuid)';END IF;
 IF md5(pg_get_functiondef('public.fn_cashier_balance_actor_guard()'::regprocedure))<>'178146284da8fbab643c2e6fcbb8bd42'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_cashier_balance_actor_guard()';END IF;
 IF md5(pg_get_functiondef('public.fn_cashier_operation_mutex_guard()'::regprocedure))<>'344aae5352ca162b3f89971599fcda78'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_cashier_operation_mutex_guard()';END IF;
 IF md5(pg_get_functiondef('public.fn_platform_frozen()'::regprocedure))<>'ec683805e052fceeae74789e82dce4cc'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'fn_platform_frozen()';END IF;
 IF md5(pg_get_functiondef('public.guard_agent_wallet_direct_update()'::regprocedure))<>'736aa9e92265453c3015223562108141'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'guard_agent_wallet_direct_update()';END IF;
 IF md5(pg_get_functiondef('public.sync_agent_wallet_columns()'::regprocedure))<>'3a3d351dd05b5dc13b525b7eb4635e5c'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'sync_agent_wallet_columns()';END IF;
 IF md5(pg_get_functiondef('public.zz_chip_ledger_key_is_claimed_once()'::regprocedure))<>'57a2b2eb1bc5b1c5ac36394c2ac23bcd'THEN RAISE EXCEPTION 'approved_agent_adjustment_original_component_changed:%', 'zz_chip_ledger_key_is_claimed_once()';END IF;
END $pre$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes)VALUES('fn_ca_settle_approved_agent_adjustment','approved','PG-only execution of existing approved positive agent adjustment; exact intent, funded club bank, original journal and durable replay receipt.');
CREATE OR REPLACE FUNCTION public.fn_ca_settle_approved_agent_adjustment(p_adjustment uuid,p_club uuid,p_expected_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET lock_timeout='1s'
AS $body$
DECLARE a public.ca_manual_adjustments%ROWTYPE; g public.agents%ROWTYPE;
 l public.chip_ledger%ROWTYPE; intent jsonb; key text; n int;
 bank_before numeric;bank_after numeric;wallet_before numeric;wallet_after numeric;
 saved jsonb;setting text;result jsonb;
BEGIN
 IF session_user<>'postgres' OR current_user<>'postgres' THEN RAISE EXCEPTION 'approved_agent_adjustment_postgres_only' USING ERRCODE='42501';END IF;
 IF p_adjustment IS NULL OR p_club IS NULL OR p_expected_payload IS NULL OR jsonb_typeof(p_expected_payload)<>'object' THEN RAISE EXCEPTION 'approved_agent_adjustment_exact_payload_required' USING ERRCODE='22023';END IF;
 SELECT*INTO STRICT a FROM public.ca_manual_adjustments WHERE id=p_adjustment FOR UPDATE;
 intent:=jsonb_build_object('club_id',p_club,'approved_adjustment',to_jsonb(a)-'status');
 IF intent IS DISTINCT FROM p_expected_payload THEN RAISE EXCEPTION 'approved_agent_adjustment_payload_changed' USING ERRCODE='23514';END IF;
 IF a.target_kind<>'agent_wallet' OR a.asset<>'chips' OR a.target_id IS NULL OR a.approver IS NULL OR a.approver=a.actor OR a.approved_at IS NULL OR a.amount<=0 OR a.amount<>round(a.amount,2) OR a.amount::text IN('NaN','Infinity','-Infinity') OR length(btrim(a.reason))<20 THEN RAISE EXCEPTION 'approved_agent_adjustment_not_positive_approved_chips' USING ERRCODE='23514';END IF;
 key:='manual-agent-adjustment:'||p_adjustment;
 SELECT count(*)INTO n FROM public.chip_ledger WHERE idempotency_key=key;
 IF a.status='settled' THEN
  IF n<>1 THEN RAISE EXCEPTION 'approved_agent_adjustment_settled_receipt_missing_or_ambiguous' USING ERRCODE='23514';END IF;
  SELECT*INTO STRICT l FROM public.chip_ledger WHERE idempotency_key=key;
  IF l.status IS DISTINCT FROM 'posted' OR l.category IS DISTINCT FROM 'correction' OR l.club_id IS DISTINCT FROM p_club OR l.from_type IS DISTINCT FROM 'club_treasury' OR l.from_entity_id IS DISTINCT FROM p_club OR l.to_type IS DISTINCT FROM 'agent_wallet' OR l.to_entity_id IS DISTINCT FROM a.target_id OR l.amount IS DISTINCT FROM a.amount OR l.correlation_id IS DISTINCT FROM a.id OR l.performed_by IS DISTINCT FROM '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid OR l.metadata->>'approved_actor'IS DISTINCT FROM a.actor::text OR l.metadata->>'approved_by'IS DISTINCT FROM a.approver::text OR l.metadata->>'paid_to'IS DISTINCT FROM 'agent_wallet' OR l.metadata->>'executed_by_db_role'IS DISTINCT FROM 'postgres' OR l.metadata->>'executed_by_session_user'IS DISTINCT FROM 'postgres' OR l.metadata->'approved_intent'IS DISTINCT FROM intent OR l.metadata->>'approved_intent_md5'IS DISTINCT FROM md5(intent::text) OR l.pre_from_balance-l.post_from_balance IS DISTINCT FROM a.amount OR l.post_to_balance-l.pre_to_balance IS DISTINCT FROM a.amount THEN RAISE EXCEPTION 'approved_agent_adjustment_replay_receipt_changed' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('success',true,'replayed',true,'adjustment_id',a.id,'ledger_id',l.id,'club_id',p_club,'user_id',a.target_id,'amount',a.amount,'bank_before',l.pre_from_balance,'bank_after',l.post_from_balance,'wallet_before',l.pre_to_balance,'wallet_after',l.post_to_balance,'approved_intent_md5',md5(intent::text));
 END IF;
 IF a.status<>'approved' OR n<>0 THEN RAISE EXCEPTION 'approved_agent_adjustment_not_unsettled_approved' USING ERRCODE='23514';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'approved_agent_adjustment_platform_frozen' USING ERRCODE='55006';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('cashier-agent-authority:'||p_club||':'||a.target_id,0));
 SELECT chip_treasury INTO STRICT bank_before FROM public.clubs WHERE id=p_club FOR NO KEY UPDATE;
 SELECT*INTO STRICT g FROM public.agents WHERE club_id=p_club AND user_id=a.target_id FOR NO KEY UPDATE;
 wallet_before:=g.agent_wallet_balance;
 IF g.status IS DISTINCT FROM 'active' OR g.role IS NULL OR g.role NOT IN('super_agent','agent','sub_agent') OR wallet_before IS NULL OR wallet_before<0 OR wallet_before<>round(wallet_before,2) OR wallet_before::text IN('NaN','Infinity','-Infinity') OR g.business_balance IS DISTINCT FROM wallet_before THEN RAISE EXCEPTION 'approved_agent_adjustment_agent_wallet_invalid' USING ERRCODE='23514';END IF;
 IF bank_before IS NULL OR bank_before<a.amount OR bank_before<>round(bank_before,2) OR bank_before::text IN('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'approved_agent_adjustment_bank_funding_shortfall' USING ERRCODE='23514';END IF;
 SELECT jsonb_object_agg(k,coalesce(current_setting(k,true),''))INTO saved FROM unnest(ARRAY['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_counterparty_label','app.ledger_settlement','app.ledger_idempotency_key','app.ledger_correlation','app.ledger_autoskip_clubs','app.ledger_autoskip_agents','app.ledger_hand_id','app.ledger_tournament_id'])k;
 PERFORM public.fn_ca_declare_ledger('correction','club_treasury',p_club,p_adjustment,key,ARRAY['clubs','agents']);
 PERFORM set_config('app.ledger_correlation',a.id::text,true);PERFORM set_config('app.ledger_hand_id','',true);PERFORM set_config('app.ledger_tournament_id','',true);
 UPDATE public.clubs SET chip_treasury=chip_treasury-a.amount,updated_at=now()WHERE id=p_club AND chip_treasury=bank_before RETURNING chip_treasury INTO bank_after;
 UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance+a.amount,updated_at=now()WHERE id=g.id AND agent_wallet_balance=wallet_before RETURNING agent_wallet_balance INTO wallet_after;
 IF bank_after IS NULL OR wallet_after IS NULL OR bank_before-bank_after<>a.amount OR wallet_after-wallet_before<>a.amount OR NOT EXISTS(SELECT FROM public.agents WHERE id=g.id AND agent_wallet_balance=wallet_after AND business_balance=wallet_after)THEN RAISE EXCEPTION 'approved_agent_adjustment_transfer_not_conserved' USING ERRCODE='23514';END IF;
 INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,description,idempotency_key,correlation_id,metadata,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
 -- Same existing real platform journal attribution used by original R2.
 -- This is automated postgres execution, not a human cashier session.
 VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,'club_treasury',p_club,'agent_wallet',a.target_id,a.amount,'correction',p_club,a.reason,key,a.id,jsonb_build_object('adjustment_id',a.id,'approved_intent',intent,'approved_intent_md5',md5(intent::text),'approved_actor',a.actor,'approved_by',a.approver,'executed_by_db_role',current_user,'executed_by_session_user',session_user,'executor_application',current_setting('application_name',true),'paid_to','agent_wallet','platform_error_absorbed',true),bank_before,bank_after,wallet_before,wallet_after)RETURNING*INTO l;
 IF l.status IS DISTINCT FROM 'posted' OR l.amount IS DISTINCT FROM a.amount OR l.idempotency_key IS DISTINCT FROM key OR l.performed_by IS DISTINCT FROM '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid OR l.metadata->>'approved_actor'IS DISTINCT FROM a.actor::text OR l.metadata->>'approved_by'IS DISTINCT FROM a.approver::text OR l.metadata->>'paid_to'IS DISTINCT FROM 'agent_wallet' OR l.metadata->>'executed_by_db_role'IS DISTINCT FROM 'postgres' OR l.metadata->>'executed_by_session_user'IS DISTINCT FROM 'postgres' OR l.metadata->'approved_intent'IS DISTINCT FROM intent OR l.pre_from_balance-l.post_from_balance IS DISTINCT FROM a.amount OR l.post_to_balance-l.pre_to_balance IS DISTINCT FROM a.amount THEN RAISE EXCEPTION 'approved_agent_adjustment_journal_receipt_invalid' USING ERRCODE='23514';END IF;
 UPDATE public.ca_manual_adjustments SET status='settled'WHERE id=a.id AND status='approved';GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'approved_agent_adjustment_status_transition_lost';END IF;
 FOR setting IN SELECT jsonb_object_keys(saved)LOOP PERFORM set_config(setting,saved->>setting,true);END LOOP;
 RETURN jsonb_build_object('success',true,'replayed',false,'adjustment_id',a.id,'ledger_id',l.id,'club_id',p_club,'user_id',a.target_id,'amount',a.amount,'bank_before',bank_before,'bank_after',bank_after,'wallet_before',wallet_before,'wallet_after',wallet_after,'approved_intent_md5',md5(intent::text));
END $body$;
REVOKE ALL ON FUNCTION public.fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)FROM PUBLIC,anon,authenticated,service_role;
DO $audit$
DECLARE d text; before_meta jsonb;
BEGIN
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc'INTO STRICT d,before_meta FROM pg_proc p WHERE oid='public.fn_ca_adjustments_report(timestamptz)'::regprocedure;
 IF md5(d)<>'d497da70300bfd0bee940d1517645bdc'OR before_meta->'proacl'IS DISTINCT FROM '["postgres=X/postgres","service_role=X/postgres"]'::jsonb THEN RAISE EXCEPTION 'approved_agent_adjustment_audit_authority_changed';END IF;
 IF(length(d)-length(replace(d,$old$WHERE a.status = 'approved'$old$,'')))/length($old$WHERE a.status = 'approved'$old$)<>1 THEN RAISE EXCEPTION 'approved_agent_adjustment_audit_anchor_changed';END IF;
 EXECUTE replace(d,$old$WHERE a.status = 'approved'$old$,$new$WHERE a.status IN ('approved','settled')$new$);
 IF md5(pg_get_functiondef('public.fn_ca_adjustments_report(timestamptz)'::regprocedure))<>'ce9438bbfc0ce1f7c88348889683fb00'OR(SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid='public.fn_ca_adjustments_report(timestamptz)'::regprocedure)IS DISTINCT FROM before_meta THEN RAISE EXCEPTION 'approved_agent_adjustment_audit_postimage_or_metadata_changed';END IF;
END $audit$;
DO $post$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure))<>'1edc12539a8b79db0614bf0470a3cf23'OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure)<>'{postgres=X/postgres}'OR(SELECT proowner FROM pg_proc WHERE oid='public.fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure)<>'postgres'::regrole THEN RAISE EXCEPTION 'approved_agent_adjustment_new_owner_metadata_or_ACL_changed';END IF;
END $post$;
COMMIT;
