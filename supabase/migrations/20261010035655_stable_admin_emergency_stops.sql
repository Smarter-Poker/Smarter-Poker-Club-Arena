-- 20261010035655_stable_admin_emergency_stops
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-10 03:56:55 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- TIER 3. Adds authoritative transaction stops; writes no player/money rows.
-- Existing entry/money RPCs alone cannot close alternate service-role doors.
-- Owner triggers reject new admission, positive chip/Diamond supply, cashier hold and
-- cashier delivery, rolling back the entire original transaction. Shared
-- transaction locks serialize admission with the operator's exclusive toggle.
-- Prior completed receipts still replay; refunds/burns/transfers remain on
-- existing rails. No repair loop, synthetic production fixture or engine restart.
-- Read live columns, canonical cashier v2 authority and mint supply registry
-- 2026-10-10. Qualification must exercise real PostgreSQL trigger transactions.
-- Rollback: remove only the five new triggers/functions through a new
-- qualified migration, restoring the eight original refund owners first.
-- Preserve all operation/refund receipts. Existing money calls and permission
-- policy remain intact; only receipt hooks are added to refund owner bodies.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='45s';

CREATE TABLE public.ca_emergency_stops (
 path text PRIMARY KEY CHECK(path IN ('tournament_registration','positive_issuance','cashout')),
 stopped boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 reason text,
 actor_id uuid,
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
INSERT INTO public.ca_emergency_stops(path) VALUES ('tournament_registration'),('positive_issuance'),('cashout');
ALTER TABLE public.ca_emergency_stops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_emergency_stops FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.ca_emergency_stops TO service_role;
CREATE TABLE public.ca_emergency_stop_operations (
 op_id uuid PRIMARY KEY,
 actor_id uuid NOT NULL,
 path text NOT NULL REFERENCES public.ca_emergency_stops(path),
 stopped boolean NOT NULL,
 expected_version bigint NOT NULL,
 version bigint NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 500),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE public.ca_emergency_stop_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_emergency_stop_operations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.ca_emergency_stop_operations TO service_role;

-- Refund provenance is an operation receipt, never a second money writer.
CREATE TABLE public.ca_emergency_refund_provenance (
 asset text NOT NULL CHECK(asset IN('chips','diamonds')),refund_key text NOT NULL,
 source_owner text NOT NULL,source_id uuid NOT NULL,user_id uuid NOT NULL,
 original_debit_id uuid NOT NULL,amount numeric NOT NULL CHECK(amount>0),
 journal_id uuid,state text NOT NULL CHECK(state IN('planned','consumed')),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(asset,refund_key,user_id),UNIQUE(asset,journal_id)
);
ALTER TABLE public.ca_emergency_refund_provenance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_emergency_refund_provenance FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.ca_emergency_refund_provenance TO service_role;
CREATE FUNCTION public.fn_ca_authorize_funded_return(p_owner text,p_source uuid,p_asset text,p_user uuid,p_amount numeric,p_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE row_data jsonb; source_reference text; total numeric; historical numeric:=0; already numeric;
 debit_id uuid; exact_debits integer; debit_amount numeric; prior public.ca_emergency_refund_provenance%ROWTYPE;
BEGIN
 IF p_owner NOT IN('shop','merch','commerce','campaign','pvp','vip_card') OR p_asset NOT IN('chips','diamonds')
  OR p_source IS NULL OR p_user IS NULL OR p_amount IS NULL OR p_amount<=0 OR p_amount<>round(p_amount,2)
  OR length(COALESCE(p_key,'')) NOT BETWEEN 1 AND 400 THEN RAISE EXCEPTION 'invalid_funded_return' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ca-funded-return:'||p_owner||':'||p_source::text,0));
 SELECT * INTO prior FROM public.ca_emergency_refund_provenance WHERE asset=p_asset AND refund_key=p_key AND user_id=p_user FOR UPDATE;
 IF FOUND THEN
  IF prior.source_owner IS DISTINCT FROM p_owner OR prior.source_id IS DISTINCT FROM p_source OR prior.amount IS DISTINCT FROM p_amount
  THEN RAISE EXCEPTION 'funded_return_identity_changed' USING ERRCODE='22023'; END IF;
  RETURN;
 END IF;
 CASE p_owner
 WHEN 'shop' THEN
  SELECT to_jsonb(p) INTO row_data FROM public.club_shop_purchases p WHERE id=p_source FOR UPDATE;
  IF row_data->>'buyer_id' IS DISTINCT FROM p_user::text OR row_data->>'currency' IS DISTINCT FROM p_asset
   OR row_data->>'refunded_at' IS NOT NULL OR p_key IS DISTINCT FROM 'ca-shop-refund-'||p_source::text
  THEN RAISE EXCEPTION 'shop_return_identity_unproved' USING ERRCODE='P0404'; END IF;
  total:=(row_data->>'price_paid')::numeric;source_reference:=row_data->>'charge_reference';
 WHEN 'merch' THEN
  SELECT to_jsonb(p) INTO row_data FROM public.merchandise_orders p WHERE id=p_source FOR UPDATE;
  IF p_asset<>'diamonds' OR row_data->>'user_id' IS DISTINCT FROM p_user::text OR row_data->>'payment_method'<>'diamonds'
  THEN RAISE EXCEPTION 'merch_return_identity_unproved' USING ERRCODE='P0404'; END IF;
  total:=(row_data->>'diamonds_spent')::numeric;historical:=COALESCE((row_data->>'refunded_diamonds')::numeric,0);source_reference:=row_data->>'purchase_reference';
 WHEN 'commerce' THEN
  SELECT to_jsonb(p) INTO row_data FROM public.ca_commerce_purchases p WHERE id=p_source FOR UPDATE;
  IF p_asset<>'diamonds' OR row_data->>'payer_id' IS DISTINCT FROM p_user::text OR p_key NOT LIKE 'ca-commerce-refund:%'
  THEN RAISE EXCEPTION 'commerce_return_identity_unproved' USING ERRCODE='P0404'; END IF;
  total:=(row_data->>'net')::numeric;debit_id:=(row_data->>'diamond_tx_id')::uuid;
  SELECT COALESCE(sum(gross),0) INTO historical FROM public.ca_commerce_refunds WHERE purchase_id=p_source;
 WHEN 'campaign' THEN
  SELECT to_jsonb(p) INTO row_data FROM public.ad_campaign p WHERE id=p_source FOR UPDATE;
  IF p_asset<>'diamonds' OR row_data->>'submitted_by' IS DISTINCT FROM p_user::text OR p_key IS DISTINCT FROM 'adcamp-refund:'||p_source::text
  THEN RAISE EXCEPTION 'campaign_return_identity_unproved' USING ERRCODE='P0404'; END IF;
  total:=(row_data->>'diamonds_charged')::numeric;historical:=COALESCE((row_data->>'diamonds_refunded')::numeric,0);source_reference:='adcamp:'||p_source::text;
 WHEN 'pvp' THEN
  SELECT to_jsonb(p) INTO row_data FROM public.trivia_pvp_matches p WHERE id=p_source FOR UPDATE;
  IF p_asset<>'diamonds' OR p_user::text NOT IN(row_data->>'player1_id',row_data->>'player2_id')
   OR p_key NOT IN('pvp_match_win_'||p_source::text,'pvp_refund_'||p_source::text||'_'||p_user::text,'pvp_tie_refund_'||p_source::text||'_'||p_user::text)
  THEN RAISE EXCEPTION 'pvp_return_identity_unproved' USING ERRCODE='P0404'; END IF;
  source_reference:='pvp_stake_'||p_source::text||'_'||p_user::text;
  total:=(row_data->>'stake_amount')::numeric;
  IF p_key='pvp_match_win_'||p_source::text THEN
   SELECT count(*)::integer,COALESCE(sum(-amount),0),min(id::text)::uuid INTO exact_debits,debit_amount,debit_id FROM public.diamond_transactions
    WHERE (user_id=(row_data->>'player1_id')::uuid AND reference_id='pvp_stake_'||p_source::text||'_'||(row_data->>'player1_id')
     OR user_id=(row_data->>'player2_id')::uuid AND reference_id='pvp_stake_'||p_source::text||'_'||(row_data->>'player2_id')) AND amount=-total;
   IF exact_debits<>2 OR debit_amount<>2*total THEN RAISE EXCEPTION 'pvp_pot_original_debits_unproved' USING ERRCODE='P0404'; END IF;
   total:=2*total;
  END IF;
  SELECT COALESCE(sum(amount),0) INTO historical FROM public.diamond_transactions WHERE user_id=p_user AND amount>0
   AND reference_id IN('pvp_match_win_'||p_source::text,'pvp_refund_'||p_source::text||'_'||p_user::text,'pvp_tie_refund_'||p_source::text||'_'||p_user::text);
 WHEN 'vip_card' THEN
  SELECT to_jsonb(p) INTO row_data FROM public.diamond_purchases p WHERE id=p_source FOR UPDATE;
  IF p_asset<>'diamonds' OR row_data->>'user_id' IS DISTINCT FROM p_user::text OR p_key IS DISTINCT FROM 'card-redemption-refund:'||p_source::text
   OR row_data->'metadata'->'redemption_intent'->>'kind' IS DISTINCT FROM 'vip_daily'
  THEN RAISE EXCEPTION 'vip_return_identity_unproved' USING ERRCODE='P0404'; END IF;
  total:=150;source_reference:='card-redemption:'||p_source::text;
 END CASE;
 IF row_data IS NULL OR total IS NULL OR total<=0 THEN RAISE EXCEPTION 'funded_return_liability_missing' USING ERRCODE='P0404'; END IF;
 IF p_asset='diamonds' AND NOT(p_owner='pvp' AND p_key='pvp_match_win_'||p_source::text) THEN
  SELECT count(*)::integer,min(id::text)::uuid INTO exact_debits,debit_id FROM public.diamond_transactions
   WHERE user_id=p_user AND amount=-total AND (id=debit_id OR reference_id=source_reference);
 ELSIF p_asset='chips' THEN
  SELECT count(*)::integer,min(id::text)::uuid INTO exact_debits,debit_id FROM public.chip_ledger
   WHERE from_type='player_wallet' AND from_entity_id=p_user AND amount=total AND idempotency_key=source_reference
    AND to_type=ANY(public.fn_ca_noncirculating_chip_stores());
 END IF;
 IF exact_debits<>1 AND NOT(p_owner='pvp' AND exact_debits=2 AND p_key='pvp_match_win_'||p_source::text) OR debit_id IS NULL
 THEN RAISE EXCEPTION 'funded_return_original_debit_unproved' USING ERRCODE='P0404'; END IF;
 SELECT COALESCE(sum(amount),0) INTO already FROM public.ca_emergency_refund_provenance
  WHERE source_owner=p_owner AND source_id=p_source AND asset=p_asset;
 IF p_owner='pvp' THEN
  IF p_amount+already>2*(row_data->>'stake_amount')::numeric THEN RAISE EXCEPTION 'funded_return_exceeds_original_pot' USING ERRCODE='P0404'; END IF;
  SELECT COALESCE(sum(amount),0) INTO already FROM public.ca_emergency_refund_provenance
   WHERE source_owner=p_owner AND source_id=p_source AND asset=p_asset AND user_id=p_user;
 END IF;
 IF p_amount>total-GREATEST(COALESCE(historical,0),already) THEN RAISE EXCEPTION 'funded_return_exceeds_original_debit' USING ERRCODE='P0404'; END IF;
 INSERT INTO public.ca_emergency_refund_provenance(asset,refund_key,source_owner,source_id,user_id,original_debit_id,amount,state)
 VALUES(p_asset,p_key,p_owner,p_source,p_user,debit_id,p_amount,'planned');
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_authorize_funded_return(text,uuid,text,uuid,numeric,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_authorize_funded_return(text,uuid,text,uuid,numeric,text) TO service_role;

CREATE FUNCTION public.fn_ca_assert_emergency_path(p_path text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE active boolean;
BEGIN
 IF p_path IS NULL OR p_path NOT IN('tournament_registration','positive_issuance','cashout')
 THEN RAISE EXCEPTION 'unknown_emergency_path' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('ca-emergency-stop:'||p_path,0));
 SELECT stopped INTO active FROM public.ca_emergency_stops WHERE path=p_path FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'emergency_stop_authority_missing' USING ERRCODE='55000'; END IF;
 IF active THEN RAISE EXCEPTION 'emergency_path_stopped:%',p_path USING ERRCODE='P0410'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_assert_emergency_path(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_assert_emergency_path(text) TO service_role;

CREATE FUNCTION public.fn_ca_set_emergency_stop(p_path text,p_stopped boolean,p_expected_version bigint,p_reason text,p_op_id uuid,p_actor_id uuid,p_request_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE required_permission text; permissions jsonb; prior public.ca_emergency_stop_operations%ROWTYPE;
 before_row public.ca_emergency_stops%ROWTYPE; result jsonb;
BEGIN
 required_permission:=CASE p_path WHEN 'tournament_registration' THEN 'settings.write' WHEN 'positive_issuance' THEN 'money.write' WHEN 'cashout' THEN 'cashier.write' END;
 IF required_permission IS NULL OR p_stopped IS NULL OR p_actor_id IS NULL OR p_op_id IS NULL OR p_expected_version IS NULL OR p_expected_version<0
  OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 10 AND 500 OR length(COALESCE(p_request_id,'')) NOT BETWEEN 1 AND 200
 THEN RAISE EXCEPTION 'invalid_stop_operation' USING ERRCODE='22023'; END IF;
 permissions:=public.fn_ca_operator_permissions(p_actor_id)->'permissions';
 IF NOT COALESCE(permissions ? required_permission,false) OR NOT COALESCE(permissions ? 'console.read',false)
 THEN RAISE EXCEPTION 'stop_permission_denied' USING ERRCODE='42501'; END IF;
 -- Operation lock first; a reused UUID may never change paths or actors.
 PERFORM pg_advisory_xact_lock(hashtextextended('ca-stop-op:'||p_op_id::text,0));
 SELECT * INTO prior FROM public.ca_emergency_stop_operations WHERE op_id=p_op_id;
 IF FOUND THEN
  IF prior.actor_id IS DISTINCT FROM p_actor_id OR prior.path IS DISTINCT FROM p_path OR prior.stopped IS DISTINCT FROM p_stopped
   OR prior.expected_version IS DISTINCT FROM p_expected_version OR prior.reason IS DISTINCT FROM btrim(p_reason)
  THEN RAISE EXCEPTION 'stop_operation_conflict' USING ERRCODE='22023'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 -- Wait for all previously admitted transactions. Once this returns, no new
 -- operation can commit using an earlier observed open state.
 PERFORM pg_advisory_xact_lock(hashtextextended('ca-emergency-stop:'||p_path,0));
 SELECT * INTO before_row FROM public.ca_emergency_stops WHERE path=p_path FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'emergency_stop_authority_missing' USING ERRCODE='55000'; END IF;
 IF before_row.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'stop_version_changed' USING ERRCODE='40001'; END IF;
 UPDATE public.ca_emergency_stops SET stopped=p_stopped,version=version+1,reason=btrim(p_reason),actor_id=p_actor_id,updated_at=transaction_timestamp() WHERE path=p_path;
 result:=jsonb_build_object('ok',true,'op_id',p_op_id,'path',p_path,'stopped',p_stopped,'version',before_row.version+1,'replayed',false);
 INSERT INTO public.ca_emergency_stop_operations(op_id,actor_id,path,stopped,expected_version,version,reason,result)
 VALUES(p_op_id,p_actor_id,p_path,p_stopped,p_expected_version,before_row.version+1,btrim(p_reason),result);
 PERFORM public.fn_log_admin_action(p_actor_id,'platform.emergency_stop','emergency_stop',p_path,
  jsonb_build_object('op_id',p_op_id,'reason',btrim(p_reason),'permission',required_permission),
  to_jsonb(before_row),result,NULL,NULL,p_request_id);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_set_emergency_stop(text,boolean,bigint,text,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_set_emergency_stop(text,boolean,bigint,text,uuid,uuid,text) TO service_role;

CREATE FUNCTION public.fn_ca_emergency_registration_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM public.fn_ca_assert_emergency_path('tournament_registration');
 ELSIF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
  OR COALESCE(NEW.rebuys,0)>COALESCE(OLD.rebuys,0) OR (NEW.add_on IS TRUE AND OLD.add_on IS DISTINCT FROM true)
  OR (upper(COALESCE(NEW.status::text,'')) IN('REGISTERED','REGISTRATION','ACTIVE') AND upper(COALESCE(OLD.status::text,'')) IN('ELIMINATED','UNREGISTERED','CANCELLED','REFUNDED'))
 THEN PERFORM public.fn_ca_assert_emergency_path('tournament_registration'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ca_emergency_registration BEFORE INSERT OR UPDATE ON public.tournament_players
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_emergency_registration_guard();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
 VALUES('tournament_players','ca_emergency_registration','Global registration stop refuses admission and paid rebuys/add-ons atomically; no money movement.')
 ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;

CREATE FUNCTION public.fn_ca_emergency_issuance_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE leg public.chip_ledger%ROWTYPE; parts text[]; week_start timestamptz; week_end timestamptz; retired numeric;
BEGIN
 -- The authoritative supply register covers every journal-origin issuer,
 -- bridge mint, opening grant and operator mint. A refund within circulating
 -- stores creates no mint row. A burn, correction or transfer is not issuance.
 IF NEW.asset IN('chips','diamonds') AND NEW.action='mint' AND NEW.amount>0 THEN
  IF EXISTS(SELECT 1 FROM public.ca_emergency_refund_provenance p WHERE p.asset=NEW.asset AND p.state='consumed'
   AND p.journal_id=COALESCE(NEW.chip_ledger_id,NEW.diamond_tx_id) AND p.amount=NEW.amount) THEN RETURN NEW; END IF;
  -- A standalone club is owed the rake it already retired. This existing
  -- bank restores an immutable week's receipts, rather than discretionary
  -- supply. Prove its exact key, journal direction and closed-week amount;
  -- neither a caller's reason nor an ambient setting can claim exemption.
  parts:=regexp_match(NEW.op_id,'^standalone-rake-bank:([0-9a-f-]{36}):([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)\.\.([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)$');
  IF NEW.asset='chips' AND parts IS NOT NULL AND parts[1]=NEW.holder_id::text AND NEW.holder_type='club' THEN
   SELECT * INTO leg FROM public.chip_ledger WHERE id=NEW.chip_ledger_id;
   week_start:=parts[2]::timestamptz; week_end:=parts[3]::timestamptz;
   IF leg.id IS NOT NULL AND leg.from_type='system_mint' AND leg.to_type='club_treasury'
    AND leg.to_entity_id=NEW.holder_id AND leg.amount=NEW.amount AND leg.idempotency_key=NEW.op_id AND leg.category='mint'
    AND week_start=public.fn_union_week_start(week_start) AND week_end=public.fn_union_week_start(week_start+interval '8 days')
    AND week_end<=public.fn_union_week_start(clock_timestamp())
    AND EXISTS(SELECT 1 FROM public.clubs WHERE id=NEW.holder_id AND is_union IS NOT TRUE) THEN
    SELECT COALESCE((SELECT sum(b.amount) FROM public.accounting_cash_bank_receipts b WHERE b.union_id IS NULL AND b.club_id=NEW.holder_id
     AND b.club_ledger_id IS NOT NULL AND b.banked_at>=week_start AND b.banked_at<week_end),0)
     +COALESCE((SELECT sum(s.amount) FROM public.tournament_rake_settlements s WHERE s.destination='chip_retirement:'||NEW.holder_id::text
      AND s.settled_at>=week_start AND s.settled_at<week_end),0) INTO retired;
    IF retired=NEW.amount THEN RETURN NEW; END IF;
   END IF;
  END IF;
  PERFORM public.fn_ca_assert_emergency_path('positive_issuance');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ca_emergency_positive_issuance BEFORE INSERT ON public.ca_mint_ledger
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_emergency_issuance_guard();

-- The Diamond register follower deliberately logs register errors instead of
-- aborting a credit. Its journal door must reject issuance before that follower
-- can swallow the stop. Exact original funded owners are pinned below;
-- caller-supplied kind, class, source and description never exempt a credit.
CREATE FUNCTION public.fn_ca_emergency_diamond_journal_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE writer_stack text;
BEGIN
 IF NEW.amount>0 THEN
  UPDATE public.ca_emergency_refund_provenance SET journal_id=NEW.id,state='consumed'
   WHERE asset='diamonds' AND refund_key=NEW.reference_id AND user_id=NEW.user_id AND amount=NEW.amount AND state='planned';
  IF FOUND THEN RETURN NEW; END IF;
 END IF;
 IF NEW.amount>0 THEN
  -- Only the immutable, preflight-pinned original funded owners may bypass
  -- issuance. PG_CONTEXT is generated by PostgreSQL, not caller metadata.
  -- These owners atomically validate/debit their bank or counterparty before
  -- returning. Any owner failure rolls this credit back with its liability.
  GET DIAGNOSTICS writer_stack=PG_CONTEXT;
  IF writer_stack ~ E'(^|\\n)PL/pgSQL function (public\\.)?(fn_poker_diamond_release|fn_poker_diamond_tournament_pay|fn_poker_diamond_jackpot_pay|send_stream_gift|send_wallet_diamond_transfer|fn_diamond_game_pay_diamonds|fn_diamond_spin_settle_day|fn_wheel_diamond_cards_pick|fn_wheel_spin_core)\\([^\\n]*\\) line [0-9]+ at ' THEN RETURN NEW; END IF;
  PERFORM public.fn_ca_assert_emergency_path('positive_issuance');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aa_ca_emergency_diamond_issuance BEFORE INSERT ON public.diamond_transactions
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_emergency_diamond_journal_guard();

CREATE FUNCTION public.fn_ca_funded_chip_return_journal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.amount>0 AND NEW.category='refund' AND NEW.from_type=ANY(public.fn_ca_noncirculating_chip_stores()) AND NEW.to_type='player_wallet' THEN
  UPDATE public.ca_emergency_refund_provenance SET journal_id=NEW.id,state='consumed'
   WHERE asset='chips' AND refund_key=NEW.idempotency_key AND user_id=NEW.to_entity_id AND amount=NEW.amount AND state='planned';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_ca_funded_return_journal BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.fn_ca_funded_chip_return_journal();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES('chip_ledger','zz_ca_funded_return_journal','Consumes exact original-debit refund provenance without issuing new money') ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;
REVOKE ALL ON FUNCTION public.fn_ca_funded_chip_return_journal() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.fn_ca_emergency_cashout_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF lower(COALESCE(NEW.status,'')) IN('pending','approved','completed','paid') THEN PERFORM public.fn_ca_assert_emergency_path('cashout'); END IF;
 ELSIF NEW.status IS DISTINCT FROM OLD.status AND lower(COALESCE(NEW.status,'')) IN('pending','approved','completed','paid')
  OR (NEW.completed_at IS NOT NULL AND OLD.completed_at IS NULL)
 THEN PERFORM public.fn_ca_assert_emergency_path('cashout'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ca_emergency_cashout BEFORE INSERT OR UPDATE ON public.cashout_requests
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_emergency_cashout_guard();
REVOKE ALL ON FUNCTION public.fn_ca_emergency_registration_guard(),public.fn_ca_emergency_issuance_guard(),public.fn_ca_emergency_cashout_guard() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_emergency_diamond_journal_guard() FROM PUBLIC,anon,authenticated;

DO $$ BEGIN
 IF (SELECT count(*) FROM public.ca_emergency_stops WHERE NOT stopped AND version=0)<>3 THEN RAISE EXCEPTION 'stop default changed'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname IN('ca_emergency_registration','ca_emergency_positive_issuance','ca_emergency_cashout','aa_ca_emergency_diamond_issuance','zz_ca_funded_return_journal') AND NOT tgisinternal AND tgenabled='O')<>5 THEN RAISE EXCEPTION 'stop guards missing'; END IF;
 IF has_function_privilege('authenticated','public.fn_ca_set_emergency_stop(text,boolean,bigint,text,uuid,uuid,text)','EXECUTE') THEN RAISE EXCEPTION 'browser can mutate stops'; END IF;
END $$;
DO $source_patch$
DECLARE original text; updated text;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO original FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='decide_trivia_pvp_settlement_v1';
 IF original IS NULL OR md5(original)<>'0008fc5cfb2a78f05f5296f8accbfc58' THEN RAISE EXCEPTION 'funded-return owner preimage changed: decide_trivia_pvp_settlement_v1'; END IF;
 updated:=replace(original,$owner_decide_trivia_pvp_settlement_v1$        SELECT public.add_diamonds_to_balance($owner_decide_trivia_pvp_settlement_v1$,$owner_decide_trivia_pvp_settlement_v1$        IF v_credit->>'transaction_type'='pvp_refund' OR (v_credit->>'transaction_type'='pvp_win' AND v_p1_charged AND v_p2_charged) THEN
          PERFORM public.fn_ca_authorize_funded_return('pvp',p_match_id,'diamonds',(v_credit->>'user_id')::uuid,(v_credit->>'amount')::numeric,v_credit->>'reference_id');
        END IF;
        SELECT public.add_diamonds_to_balance($owner_decide_trivia_pvp_settlement_v1$);
 IF updated=original THEN RAISE EXCEPTION 'funded-return source hook absent: decide_trivia_pvp_settlement_v1'; END IF;
 EXECUTE updated;
END $source_patch$;
DO $source_patch$
DECLARE original text; updated text;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO original FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_ad_campaign_review';
 IF original IS NULL OR md5(original)<>'bab23780b07293bdf73c407bebebdf38' THEN RAISE EXCEPTION 'funded-return owner preimage changed: fn_ad_campaign_review'; END IF;
 updated:=replace(original,$owner_fn_ad_campaign_review$      v_ref := public.add_diamonds_to_balance($owner_fn_ad_campaign_review$,$owner_fn_ad_campaign_review$      PERFORM public.fn_ca_authorize_funded_return('campaign',v_c.id,'diamonds',v_c.submitted_by,v_c.diamonds_charged,'adcamp-refund:'||v_c.id::text);
      v_ref := public.add_diamonds_to_balance($owner_fn_ad_campaign_review$);
 IF updated=original THEN RAISE EXCEPTION 'funded-return source hook absent: fn_ad_campaign_review'; END IF;
 EXECUTE updated;
END $source_patch$;
DO $source_patch$
DECLARE original text; updated text;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO original FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_ca_commerce_refund';
 IF original IS NULL OR md5(original)<>'5d0b17879b13f24a4d69d9306fa94ff5' THEN RAISE EXCEPTION 'funded-return owner preimage changed: fn_ca_commerce_refund'; END IF;
 updated:=replace(original,$owner_fn_ca_commerce_refund$  v_credit := public.add_diamonds_to_balance(v_p.payer_id, p_amount, 'refund',$owner_fn_ca_commerce_refund$,$owner_fn_ca_commerce_refund$  PERFORM public.fn_ca_authorize_funded_return('commerce',v_p.id,'diamonds',v_p.payer_id,p_amount,v_ref);
  v_credit := public.add_diamonds_to_balance(v_p.payer_id, p_amount, 'refund',$owner_fn_ca_commerce_refund$);
 IF updated=original THEN RAISE EXCEPTION 'funded-return source hook absent: fn_ca_commerce_refund'; END IF;
 EXECUTE updated;
END $source_patch$;
DO $source_patch$
DECLARE original text; updated text;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO original FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_club_ad_cancel';
 IF original IS NULL OR md5(original)<>'ff0dc589d102e1e5b4b4d1fe0e328465' THEN RAISE EXCEPTION 'funded-return owner preimage changed: fn_club_ad_cancel'; END IF;
 updated:=replace(original,$owner_fn_club_ad_cancel$    v_ref := public.add_diamonds_to_balance($owner_fn_club_ad_cancel$,$owner_fn_club_ad_cancel$    PERFORM public.fn_ca_authorize_funded_return('campaign',v_c.id,'diamonds',v_c.submitted_by,v_c.diamonds_charged,'adcamp-refund:'||v_c.id::text);
    v_ref := public.add_diamonds_to_balance($owner_fn_club_ad_cancel$);
 IF updated=original THEN RAISE EXCEPTION 'funded-return source hook absent: fn_club_ad_cancel'; END IF;
 EXECUTE updated;
END $source_patch$;
DO $source_patch$
DECLARE original text; updated text;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO original FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_diamond_purchase_refund';
 IF original IS NULL OR md5(original)<>'b652bdae9b8874de870d5dc0dd6f4c9c' THEN RAISE EXCEPTION 'funded-return owner preimage changed: fn_diamond_purchase_refund'; END IF;
 updated:=replace(original,$owner_fn_diamond_purchase_refund$        v_wallet := public.add_diamonds_to_balance(v_purchase.user_id, v_daily_cost, 'refund',$owner_fn_diamond_purchase_refund$,$owner_fn_diamond_purchase_refund$        PERFORM public.fn_ca_authorize_funded_return('vip_card',v_purchase.id,'diamonds',v_purchase.user_id,v_daily_cost,'card-redemption-refund:'||v_purchase.id::text);
        v_wallet := public.add_diamonds_to_balance(v_purchase.user_id, v_daily_cost, 'refund',$owner_fn_diamond_purchase_refund$);
 IF updated=original THEN RAISE EXCEPTION 'funded-return source hook absent: fn_diamond_purchase_refund'; END IF;
 EXECUTE updated;
END $source_patch$;
DO $source_patch$
DECLARE original text; updated text;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO original FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_refund_shop_purchase';
 IF original IS NULL OR md5(original)<>'c4ffe3f33be5585b1fde39919f2e9163' THEN RAISE EXCEPTION 'funded-return owner preimage changed: fn_refund_shop_purchase'; END IF;
 updated:=replace(original,$owner_fn_refund_shop_purchase$  IF v_purchase.currency = 'diamonds' THEN$owner_fn_refund_shop_purchase$,$owner_fn_refund_shop_purchase$  PERFORM public.fn_ca_authorize_funded_return('shop',p_purchase_id,v_purchase.currency,v_purchase.buyer_id,v_purchase.price_paid,'ca-shop-refund-'||p_purchase_id::text);
  IF v_purchase.currency = 'diamonds' THEN$owner_fn_refund_shop_purchase$);
 IF updated=original THEN RAISE EXCEPTION 'funded-return source hook absent: fn_refund_shop_purchase'; END IF;
 EXECUTE updated;
END $source_patch$;
DO $source_patch$
DECLARE original text; updated text;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO original FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='refund_diamond_merch_order_atomic';
 IF original IS NULL OR md5(original)<>'2b44da82dd14be077f2807db5ca4a5d8' THEN RAISE EXCEPTION 'funded-return owner preimage changed: refund_diamond_merch_order_atomic'; END IF;
 updated:=replace(original,$owner_refund_diamond_merch_order_atomic$  v_wallet := public.add_diamonds_to_balance($owner_refund_diamond_merch_order_atomic$,$owner_refund_diamond_merch_order_atomic$  PERFORM public.fn_ca_authorize_funded_return('merch',v_order.id,'diamonds',v_order.user_id,v_refund,p_reference_id);
  v_wallet := public.add_diamonds_to_balance($owner_refund_diamond_merch_order_atomic$);
 IF updated=original THEN RAISE EXCEPTION 'funded-return source hook absent: refund_diamond_merch_order_atomic'; END IF;
 EXECUTE updated;
END $source_patch$;
DO $source_patch$
DECLARE original text; updated text;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO original FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='refund_diamond_merch_order_atomic_v2';
 IF original IS NULL OR md5(original)<>'a76e8fb5badbab10d7d8c73c63c002b0' THEN RAISE EXCEPTION 'funded-return owner preimage changed: refund_diamond_merch_order_atomic_v2'; END IF;
 updated:=replace(original,$owner_refund_diamond_merch_order_atomic_v2$  v_wallet := public.add_diamonds_to_balance($owner_refund_diamond_merch_order_atomic_v2$,$owner_refund_diamond_merch_order_atomic_v2$  PERFORM public.fn_ca_authorize_funded_return('merch',v_order.id,'diamonds',v_order.user_id,v_refund,p_reference_id);
  v_wallet := public.add_diamonds_to_balance($owner_refund_diamond_merch_order_atomic_v2$);
 IF updated=original THEN RAISE EXCEPTION 'funded-return source hook absent: refund_diamond_merch_order_atomic_v2'; END IF;
 EXECUTE updated;
END $source_patch$;

-- Funded Diamond owner preimages: caller labels cannot create an exemption.
DO $$ BEGIN
 IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_diamond_game_pay_diamonds') IS DISTINCT FROM 'f44e7cfd291b5f2491822fc6f2a411a6' THEN RAISE EXCEPTION 'funded owner preimage drift: fn_diamond_game_pay_diamonds'; END IF;
 IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_diamond_spin_settle_day') IS DISTINCT FROM '847fb068b5bef85494181e6be8be28c8' THEN RAISE EXCEPTION 'funded owner preimage drift: fn_diamond_spin_settle_day'; END IF;
 IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_poker_diamond_jackpot_pay') IS DISTINCT FROM 'c98b6d4bc76b5e531590db5594e856f3' THEN RAISE EXCEPTION 'funded owner preimage drift: fn_poker_diamond_jackpot_pay'; END IF;
 IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_poker_diamond_release') IS DISTINCT FROM 'd525cb1e20d6fb05e5b5e51497b127e7' THEN RAISE EXCEPTION 'funded owner preimage drift: fn_poker_diamond_release'; END IF;
 IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_poker_diamond_tournament_pay') IS DISTINCT FROM '19cd9ea4fb671379fe84f05d409812a1' THEN RAISE EXCEPTION 'funded owner preimage drift: fn_poker_diamond_tournament_pay'; END IF;
 IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_wheel_diamond_cards_pick') IS DISTINCT FROM '79f3711b99ef751482e8b1c3e3cd3c76' THEN RAISE EXCEPTION 'funded owner preimage drift: fn_wheel_diamond_cards_pick'; END IF;
 IF md5(pg_get_functiondef(to_regprocedure('public.fn_wheel_spin_core(uuid,uuid,text,boolean,uuid)'))) IS DISTINCT FROM 'd2d449daa747be0d4ae53006cf0c8eba' THEN RAISE EXCEPTION 'funded owner preimage drift: fn_wheel_spin_core(uuid,uuid,text,boolean,uuid)'; END IF;
 IF md5(pg_get_functiondef(to_regprocedure('public.fn_wheel_spin_core(uuid,uuid,text,boolean)'))) IS DISTINCT FROM '4c9c2645c10f7440951f15ffeca63d68' THEN RAISE EXCEPTION 'funded owner preimage drift: fn_wheel_spin_core(uuid,uuid,text,boolean)'; END IF;
 IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='send_stream_gift') IS DISTINCT FROM '76536e8602346214027a6187f5e09c77' THEN RAISE EXCEPTION 'funded owner preimage drift: send_stream_gift'; END IF;
 IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='send_wallet_diamond_transfer') IS DISTINCT FROM '8d5b95d8ad2a74c1ba85339168349606' THEN RAISE EXCEPTION 'funded owner preimage drift: send_wallet_diamond_transfer'; END IF;
END $$;
COMMIT;

-- Executable recovery candidate is maintained at
-- scripts/qualification/stable-admin-cancel-stops/rollback.sql. It checks exact
-- postimages before restoring the eight original refund owners, removes all
-- five guards and source writers, and retains receipt/history tables plus the
-- additive approval kind. Qualify it as a new reserved migration before use.
