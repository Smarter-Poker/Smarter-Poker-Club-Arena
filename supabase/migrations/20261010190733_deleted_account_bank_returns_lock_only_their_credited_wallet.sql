-- Qualify the installed account-lifecycle return's lock ordering.
-- Live proof found member-first + agent credit could deadlock: the credit
-- owned the agent row, while the bulk return owned member rows. Credit hooks
-- now lock only their source. Explicit two-wallet returns lock agent first.
-- No committed proof movements are replayed; previous probes rolled back.
-- @live-proof: (to_regprocedure('public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text)') IS NOT NULL AND position('fn_ca_deleted_wallet_bank_return' in pg_get_functiondef('public.fn_ca_deleted_wallet_credit()'::regprocedure))>0 AND NOT has_function_privilege('authenticated','public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text)','EXECUTE'))
BEGIN;
SET LOCAL lock_timeout='4s';
SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_deleted_account_bank_return(uuid,uuid)'::regprocedure))<>'ae1386ce796725e08933fb700bdae7bf' THEN RAISE EXCEPTION 'DELETED_ACCOUNT_RETURN_PREIMAGE_CHANGED'; END IF;
END $preflight$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES ('fn_ca_deleted_wallet_bank_return','system','Deleted-account lifecycle custody: locks only the credited source; full explicit return locks agent first. Conserves bank, journals sources, private service authority.') ON CONFLICT(proname) DO NOTHING;
CREATE FUNCTION public.fn_ca_deleted_wallet_bank_return(p_club uuid,p_user uuid,p_source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='4s'
AS $function$
DECLARE
 v_player numeric:=0; v_agent numeric:=0; v_bank numeric; v_owner uuid;
 v_op uuid; v_amount numeric; v_source text; v_key text; v_saved jsonb:='{}'::jsonb;
 v_keys text[]:=ARRAY['app.ledger_category','app.ledger_counterparty',
 'app.ledger_counterparty_entity','app.ledger_counterparty_label','app.ledger_settlement',
 'app.ledger_idempotency_key','app.ledger_correlation','app.ledger_tournament','app.cash_original_debit_ledger','app.ledger_autoskip_clubs',
 'app.ledger_autoskip_club_members','app.ledger_autoskip_agents'];
BEGIN
 PERFORM 1 FROM public.profiles WHERE id=p_user AND status='deleted' FOR SHARE;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('success',false,'reason','account_not_deleted');
 END IF;
 IF p_source NOT IN ('wallets','player_wallet','agent_wallet') OR p_source IS NULL THEN RAISE EXCEPTION 'unknown_deleted_wallet_source'; END IF;
 -- Agent-first for the explicit two-wallet lifecycle return. A live credit
 -- takes only its already-owned source row, never the other wallet.
 IF p_source IN ('wallets','agent_wallet') THEN
  SELECT greatest(coalesce(agent_wallet_balance,0),0) INTO v_agent
  FROM public.agents WHERE club_id=p_club AND user_id=p_user FOR UPDATE;
 END IF;
 IF p_source IN ('wallets','player_wallet') THEN
  SELECT greatest(coalesce(chip_balance,0)-coalesce(held_chips,0)-coalesce(locked_chips,0),0)
  INTO v_player FROM public.club_members WHERE club_id=p_club AND user_id=p_user FOR UPDATE;
 END IF;
 v_player:=coalesce(v_player,0); v_agent:=coalesce(v_agent,0);
 SELECT chip_treasury,owner_id INTO v_bank,v_owner FROM public.clubs
 WHERE id=p_club AND asset='chips' AND lifecycle_status='active' FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'reason','not_active_chip_club'); END IF;
 IF v_player+v_agent=0 THEN RETURN jsonb_build_object('success',true,'amount',0); END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'platform_is_frozen'; END IF;
 FOREACH v_key IN ARRAY v_keys LOOP
  v_saved:=v_saved||jsonb_build_object(v_key,coalesce(current_setting(v_key,true),''));
 END LOOP;
 FOREACH v_source IN ARRAY ARRAY['player_wallet','agent_wallet'] LOOP
  v_amount:=CASE WHEN v_source='player_wallet' THEN v_player ELSE v_agent END;
  IF v_amount=0 THEN CONTINUE; END IF;
  v_op:=gen_random_uuid();
  PERFORM set_config('app.ledger_autoskip_club_members','',true);
  PERFORM set_config('app.ledger_autoskip_agents','',true);
  PERFORM public.fn_ca_declare_ledger('club_bank_claim','club_treasury',p_club,NULL,
   'deleted_account_bank_return:'||v_op,ARRAY['clubs']);
  PERFORM set_config('app.ledger_correlation',v_op::text,true);
  PERFORM set_config('app.ledger_settlement','',true);
  PERFORM set_config('app.ledger_tournament','',true);
  IF v_source='player_wallet' THEN
   UPDATE public.club_members SET chip_balance=chip_balance-v_amount,updated_at=now()
   WHERE club_id=p_club AND user_id=p_user;
  ELSE
   UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance-v_amount,updated_at=now()
   WHERE club_id=p_club AND user_id=p_user;
  END IF;
  UPDATE public.clubs SET chip_treasury=coalesce(chip_treasury,0)+v_amount,updated_at=now()
  WHERE id=p_club RETURNING chip_treasury INTO v_bank;
  INSERT INTO public.chip_transactions
   (club_id,from_user_id,to_user_id,amount,transaction_type,notes,metadata,balance_after)
  VALUES(p_club,p_user,v_owner,v_amount,'club_bank_claim','Deleted Account Chips Returned To Club Bank',
   jsonb_build_object('op_id',v_op,'source',v_source,'direction','into_bank',
    'reason','deleted_account','bank_after',v_bank),v_bank);
 END LOOP;
 FOREACH v_key IN ARRAY v_keys LOOP PERFORM set_config(v_key,v_saved->>v_key,true); END LOOP;
 RETURN jsonb_build_object('success',true,'amount',v_player+v_agent,
  'player_chips',v_player,'agent_chips',v_agent,'bank_after',v_bank);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_deleted_account_bank_return(p_club uuid,p_user uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp
AS $function$ SELECT public.fn_ca_deleted_wallet_bank_return(p_club,p_user,'wallets') $function$;
REVOKE ALL ON FUNCTION public.fn_ca_deleted_account_bank_return(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_deleted_account_bank_return(uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_deleted_wallet_credit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $function$
DECLARE v_club uuid;
BEGIN
 IF TG_TABLE_NAME='profiles' THEN
  FOR v_club IN SELECT club_id FROM public.club_members WHERE user_id=NEW.id ORDER BY club_id LOOP
   PERFORM public.fn_ca_deleted_wallet_bank_return(v_club,NEW.id,'wallets');
  END LOOP;
  RETURN NEW;
 END IF;
 IF EXISTS (SELECT 1 FROM public.profiles WHERE id=NEW.user_id AND status='deleted') THEN
  PERFORM public.fn_ca_deleted_wallet_bank_return(NEW.club_id,NEW.user_id,CASE WHEN TG_TABLE_NAME='agents' THEN 'agent_wallet' ELSE 'player_wallet' END);
 END IF;
 RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_deleted_wallet_credit() FROM PUBLIC,anon,authenticated;
COMMIT;
