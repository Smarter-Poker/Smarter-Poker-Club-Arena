-- Original tournament financial identities and liability transitions, prospectively captured.
-- No historical seed, new payer, commercial ownership assumption or gameplay policy.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL search_path=public,pg_temp;

DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_capture_tournament_charge_entitlement()'::regprocedure)) IS DISTINCT FROM '01e84bcd7825d2e905fef3ec220b3a47'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_ca_capture_tournament_charge_entitlement()'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_capture_tournament_charge_entitlement()'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN
  RAISE EXCEPTION 'Original tournament prerequisite changed: fn_ca_capture_tournament_charge_entitlement()';
 END IF;
END $precondition$;

DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure)) IS DISTINCT FROM '158742fd17635f19402a289a378989c7'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN
  RAISE EXCEPTION 'Original tournament prerequisite changed: fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)';
 END IF;
END $precondition$;

DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)'::regprocedure)) IS DISTINCT FROM '414afa5822fe017914769b335a00f2c1'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN
  RAISE EXCEPTION 'Original tournament prerequisite changed: fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)';
 END IF;
END $precondition$;

DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)'::regprocedure)) IS DISTINCT FROM 'f757226e48412a8c37b0c4770549c2e3'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN
  RAISE EXCEPTION 'Original tournament prerequisite changed: fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)';
 END IF;
END $precondition$;

DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure)) IS DISTINCT FROM '5a3aa8bd1a48d18b793e39c09b645b41'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN
  RAISE EXCEPTION 'Original tournament prerequisite changed: fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)';
 END IF;
END $precondition$;

DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.log_wallet_transaction(uuid,text,numeric,text,text,text,uuid,uuid,uuid)'::regprocedure)) IS DISTINCT FROM '53e97347076b0a6de0a5f7f4abaf359d'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.log_wallet_transaction(uuid,text,numeric,text,text,text,uuid,uuid,uuid)'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.log_wallet_transaction(uuid,text,numeric,text,text,text,uuid,uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
  RAISE EXCEPTION 'Original tournament prerequisite changed: log_wallet_transaction(uuid,text,numeric,text,text,text,uuid,uuid,uuid)';
 END IF;
END $precondition$;

-- Prospective original-transaction facts, never historical reconstruction.
CREATE TABLE public.tournament_participant_funding_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 registration_id uuid NOT NULL, tournament_id uuid NOT NULL, user_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('entry','rebuy','reentry','addon')),
 purchase_key text, asset text NOT NULL CHECK(asset IN ('chips','diamonds')),
 amount numeric NOT NULL CHECK(amount >= 0 AND amount = round(amount,2) AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
 entitlement_id uuid UNIQUE, ledger_id uuid UNIQUE, wallet_transaction_id uuid UNIQUE,
 funding_club_id uuid, registration_snapshot jsonb NOT NULL, tournament_snapshot jsonb NOT NULL,
 entitlement_snapshot jsonb, ledger_snapshot jsonb, wallet_snapshot jsonb,
 custody_result jsonb,
 CHECK ((asset='chips' AND amount>0 AND entitlement_id IS NOT NULL AND ledger_id IS NOT NULL AND wallet_transaction_id IS NOT NULL AND funding_club_id IS NOT NULL)
     OR (asset='chips' AND amount=0 AND entitlement_id IS NULL AND ledger_id IS NULL)
     OR (asset='diamonds' AND entitlement_id IS NULL AND ledger_id IS NULL))
);
CREATE INDEX ON public.tournament_participant_funding_receipts(tournament_id,registration_id,observed_at);
CREATE TABLE public.tournament_accounting_credit_receipts (
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 idempotency_key text NOT NULL UNIQUE, tournament_id uuid NOT NULL, user_id uuid NOT NULL,
 asset text NOT NULL CHECK(asset='chips'), amount numeric NOT NULL CHECK(amount>0 AND amount=round(amount,2) AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
 ledger_id uuid NOT NULL UNIQUE, wallet_transaction_id uuid NOT NULL UNIQUE, payout_id uuid UNIQUE,
 credited_club_id uuid NOT NULL, ledger_snapshot jsonb NOT NULL, wallet_snapshot jsonb NOT NULL,
 payout_snapshot jsonb, registration_snapshot jsonb, tournament_snapshot jsonb NOT NULL,
 entry_receipt_ids uuid[] NOT NULL
);
CREATE TABLE public.tournament_obligation_events (
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(), obligation_id uuid NOT NULL,
 asset text NOT NULL CHECK(asset IN ('chips','diamonds','unknown')),
 tournament_id uuid NOT NULL, user_id uuid, operation text NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
 before_row jsonb, after_row jsonb, tournament_snapshot jsonb NOT NULL,
 registration_snapshot jsonb, entry_receipt_ids uuid[] NOT NULL,
 credit_receipt_id uuid, refund_tranche_ids uuid[] NOT NULL,
 CHECK((operation='INSERT' AND before_row IS NULL AND after_row IS NOT NULL)
    OR (operation='UPDATE' AND before_row IS NOT NULL AND after_row IS NOT NULL)
    OR (operation='DELETE' AND before_row IS NOT NULL AND after_row IS NULL))
);
CREATE INDEX ON public.tournament_obligation_events(obligation_id,event_id);
CREATE INDEX ON public.tournament_obligation_events(tournament_id,observed_at,event_id);

CREATE FUNCTION public.fn_ca_tournament_accounting_evidence_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
BEGIN RAISE EXCEPTION 'Original tournament accounting evidence is immutable' USING ERRCODE='55000'; END
$function$;
CREATE FUNCTION public.fn_ca_capture_tournament_credit_ledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
BEGIN
 IF NEW.tournament_id IS NOT NULL AND NEW.from_type='prize_liability'
    AND NEW.from_entity_id=NEW.tournament_id AND NEW.to_type='player_wallet'
    AND NEW.category IN ('tournament_prize','bounty','refund','tournament_refund') THEN
   PERFORM set_config('app.pnl_tournament_credit_ledger',NEW.id::text,true);
 END IF;
 RETURN NULL;
END $function$;
CREATE TRIGGER zz_tournament_accounting_credit_ledger AFTER INSERT ON public.chip_ledger
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_capture_tournament_credit_ledger();

CREATE FUNCTION public.fn_ca_record_tournament_participant_funding(
 p_registration uuid,p_operation text,p_key text,p_amount numeric,p_asset text,
 p_entitlement uuid,p_wallet uuid,p_custody jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_p jsonb;v_t jsonb;v_e public.tournament_refund_entitlements%ROWTYPE;v_l jsonb;v_w jsonb;
BEGIN
 SELECT to_jsonb(p),to_jsonb(t) INTO v_p,v_t FROM public.tournament_players p
 JOIN public.tournaments t ON t.id=p.tournament_id WHERE p.id=p_registration;
 IF v_p IS NULL THEN RAISE EXCEPTION 'Original tournament registration is missing' USING ERRCODE='55000'; END IF;
 IF p_asset='chips' AND p_amount>0 THEN
   SELECT * INTO v_e FROM public.tournament_refund_entitlements WHERE id=p_entitlement;
   SELECT to_jsonb(l) INTO v_l FROM public.chip_ledger l WHERE id=v_e.source_ledger_id;
   SELECT to_jsonb(w) INTO v_w FROM public.wallet_transactions w WHERE id=p_wallet;
   IF v_e.id IS NULL OR v_e.entitlement_kind<>'wallet_charge'
      OR v_e.tournament_id IS DISTINCT FROM (v_p->>'tournament_id')::uuid
      OR v_e.user_id IS DISTINCT FROM (v_p->>'user_id')::uuid
      OR v_e.gross IS DISTINCT FROM p_amount OR v_l IS NULL OR v_w IS NULL
      OR v_e.charge_category IS DISTINCT FROM (CASE WHEN p_operation='entry' THEN 'tournament_buyin' WHEN p_operation='addon' THEN 'addon' ELSE 'rebuy' END)
      OR (v_l->>'amount')::numeric IS DISTINCT FROM p_amount
      OR v_l->>'club_id' IS DISTINCT FROM v_e.refund_wallet_club_id::text
      OR v_l->>'from_entity_id' IS DISTINCT FROM v_e.user_id::text
      OR v_l->>'from_type' IS DISTINCT FROM 'player_wallet'
      OR v_l->>'to_type' IS DISTINCT FROM 'prize_liability'
      OR v_l->>'to_entity_id' IS DISTINCT FROM v_e.tournament_id::text
      OR v_w->>'user_id' IS DISTINCT FROM v_e.user_id::text
      OR v_w->>'related_entity_id' IS DISTINCT FROM v_e.tournament_id::text
      OR v_w->>'type' IS DISTINCT FROM 'debit'
      OR (v_w->>'amount')::numeric IS DISTINCT FROM p_amount THEN
     RAISE EXCEPTION 'Original tournament funding references do not match' USING ERRCODE='23514';
   END IF;
 END IF;
 INSERT INTO public.tournament_participant_funding_receipts(
 registration_id,tournament_id,user_id,operation,purchase_key,asset,amount,
 entitlement_id,ledger_id,wallet_transaction_id,funding_club_id,
 registration_snapshot,tournament_snapshot,entitlement_snapshot,ledger_snapshot,wallet_snapshot,custody_result)
 VALUES(p_registration,(v_p->>'tournament_id')::uuid,(v_p->>'user_id')::uuid,p_operation,p_key,p_asset,p_amount,
 v_e.id,v_e.source_ledger_id,p_wallet,v_e.refund_wallet_club_id,v_p,v_t,
 CASE WHEN v_e.id IS NOT NULL THEN to_jsonb(v_e) END,v_l,v_w,p_custody);
END $function$;

CREATE FUNCTION public.fn_ca_record_tournament_accounting_credit(
 p_key text,p_tournament uuid,p_user uuid,p_amount numeric,p_ledger uuid,p_wallet uuid,p_payout uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_l jsonb;v_w jsonb;v_payout jsonb;v_p jsonb;v_t jsonb;v_entries uuid[];
BEGIN
 SELECT to_jsonb(l) INTO v_l FROM public.chip_ledger l WHERE id=p_ledger;
 SELECT to_jsonb(w) INTO v_w FROM public.wallet_transactions w WHERE id=p_wallet;
 SELECT to_jsonb(p) INTO v_payout FROM public.tournament_payouts p WHERE id=p_payout;
 SELECT to_jsonb(t) INTO v_t FROM public.tournaments t WHERE id=p_tournament;
 SELECT to_jsonb(p) INTO v_p FROM public.tournament_players p WHERE tournament_id=p_tournament AND user_id=p_user;
 SELECT COALESCE(array_agg(id ORDER BY observed_at,id),'{}'::uuid[]) INTO v_entries
 FROM public.tournament_participant_funding_receipts WHERE registration_id=(v_p->>'id')::uuid;
 IF v_l IS NULL OR v_w IS NULL OR v_t IS NULL
    OR v_l->>'tournament_id' IS DISTINCT FROM p_tournament::text
    OR v_l->>'from_type' IS DISTINCT FROM 'prize_liability'
    OR v_l->>'from_entity_id' IS DISTINCT FROM p_tournament::text
    OR v_l->>'to_type' IS DISTINCT FROM 'player_wallet'
    OR v_l->>'to_entity_id' IS DISTINCT FROM p_user::text
    OR v_l->>'club_id' IS NULL OR (v_l->>'amount')::numeric IS DISTINCT FROM p_amount
    OR v_w->>'user_id' IS DISTINCT FROM p_user::text
    OR v_w->>'related_entity_id' IS DISTINCT FROM p_tournament::text
    OR v_w->>'type' IS DISTINCT FROM 'credit' OR (v_w->>'amount')::numeric IS DISTINCT FROM p_amount
    OR (p_payout IS NOT NULL AND (v_payout IS NULL
       OR v_payout->>'idempotency_key' IS DISTINCT FROM p_key
       OR v_payout->>'user_id' IS DISTINCT FROM p_user::text
       OR v_payout->>'tournament_id' IS DISTINCT FROM p_tournament::text
       OR (v_payout->>'amount')::numeric IS DISTINCT FROM p_amount))
    OR NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency WHERE key=p_key AND user_id=p_user AND amount=p_amount) THEN
   RAISE EXCEPTION 'Original tournament credit references do not match' USING ERRCODE='23514';
 END IF;
 INSERT INTO public.tournament_accounting_credit_receipts(
 idempotency_key,tournament_id,user_id,asset,amount,ledger_id,wallet_transaction_id,payout_id,
 credited_club_id,ledger_snapshot,wallet_snapshot,payout_snapshot,registration_snapshot,tournament_snapshot,entry_receipt_ids)
 VALUES(p_key,p_tournament,p_user,'chips',p_amount,p_ledger,p_wallet,p_payout,
 (v_l->>'club_id')::uuid,v_l,v_w,v_payout,v_p,v_t,v_entries);
END $function$;

CREATE FUNCTION public.fn_ca_capture_tournament_obligation_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_b jsonb;v_a jsonb;v_r jsonb;v_t jsonb;v_p jsonb;v_entries uuid[];v_credit uuid;v_refunds uuid[];
 v_key text;
BEGIN
 IF TG_OP<>'INSERT' THEN v_b:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN v_a:=to_jsonb(NEW); END IF;
 IF v_b IS NOT DISTINCT FROM v_a THEN RETURN NULL; END IF;
 v_r:=COALESCE(v_a,v_b);
 SELECT to_jsonb(t) INTO v_t FROM public.tournaments t WHERE id=(v_r->>'tournament_id')::uuid;
 SELECT to_jsonb(p) INTO v_p FROM public.tournament_players p
 WHERE tournament_id=(v_r->>'tournament_id')::uuid AND user_id=(v_r->>'user_id')::uuid;
 SELECT COALESCE(array_agg(id ORDER BY observed_at,id),'{}'::uuid[]) INTO v_entries
 FROM public.tournament_participant_funding_receipts WHERE registration_id=(v_p->>'id')::uuid;
 -- The existing cumulative owner names the exact original payment, never a time-window match.
 v_key:=NULLIF(current_setting('app.pnl_tournament_obligation_credit_key',true),'');
 IF TG_OP='UPDATE' AND NEW.amount_paid>OLD.amount_paid
    AND v_key='tourney:'||NEW.tournament_id::text||':obl:'||NEW.id::text||':'||(round(OLD.amount_paid*100))::bigint::text THEN
   SELECT id INTO v_credit FROM public.tournament_accounting_credit_receipts
   WHERE idempotency_key=v_key AND tournament_id=NEW.tournament_id
     AND user_id=NEW.user_id AND amount=NEW.amount_paid-OLD.amount_paid;
 END IF;
 SELECT COALESCE(array_agg(wallet_transaction_id ORDER BY wallet_transaction_id),'{}'::uuid[]) INTO v_refunds
 FROM public.tournament_refund_tranches WHERE obligation_id=(v_r->>'id')::uuid;
 INSERT INTO public.tournament_obligation_events(
 obligation_id,asset,tournament_id,user_id,operation,before_row,after_row,tournament_snapshot,
 registration_snapshot,entry_receipt_ids,credit_receipt_id,refund_tranche_ids)
 VALUES((v_r->>'id')::uuid,
 CASE WHEN v_t IS NULL THEN 'unknown' WHEN public.fn_ca_tournament_unit_cents((v_r->>'tournament_id')::uuid)=100 THEN 'diamonds' ELSE 'chips' END,
 (v_r->>'tournament_id')::uuid,(v_r->>'user_id')::uuid,TG_OP,
 v_b,v_a,COALESCE(v_t,jsonb_build_object('id',v_r->>'tournament_id','scope_unavailable',true)),v_p,v_entries,v_credit,v_refunds);
 RETURN NULL;
END $function$;
CREATE TRIGGER zz_tournament_accounting_obligation_event AFTER INSERT OR UPDATE OR DELETE ON public.tournament_obligations
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_capture_tournament_obligation_event();

INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES('chip_ledger','zz_tournament_accounting_credit_ledger','Original tournament credit ledger identity; no wallet or gameplay mutation'),
 ('tournament_obligations','zz_tournament_accounting_obligation_event','Immutable original obligation transitions for accounting; no payer or valuation policy')
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;

DO $permissions$
DECLARE v_table text;v_function text;
BEGIN
 FOREACH v_table IN ARRAY ARRAY['tournament_participant_funding_receipts','tournament_accounting_credit_receipts','tournament_obligation_events'] LOOP
   EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_table);
   EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',v_table);
   EXECUTE format('GRANT SELECT ON public.%I TO service_role',v_table);
   EXECUTE format('CREATE TRIGGER original_evidence_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tournament_accounting_evidence_immutable()',v_table);
   EXECUTE format('CREATE TRIGGER original_evidence_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_tournament_accounting_evidence_immutable()',v_table);
 END LOOP;
 FOREACH v_function IN ARRAY ARRAY[
 'fn_ca_tournament_accounting_evidence_immutable()','fn_ca_capture_tournament_credit_ledger()',
 'fn_ca_record_tournament_participant_funding(uuid,text,text,numeric,text,uuid,uuid,jsonb)',
 'fn_ca_record_tournament_accounting_credit(text,uuid,uuid,numeric,uuid,uuid,uuid)',
 'fn_ca_capture_tournament_obligation_event()'] LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role',v_function);
 END LOOP;
END $permissions$;

CREATE OR REPLACE FUNCTION public.fn_ca_capture_tournament_charge_entitlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_split record;
  v_original_entitlement uuid;
BEGIN
  IF NEW.tournament_id IS NULL
     OR NEW.from_type IS DISTINCT FROM 'player_wallet'
     OR NEW.to_type IS DISTINCT FROM 'prize_liability'
     OR NEW.to_entity_id IS DISTINCT FROM NEW.tournament_id
     OR lower(COALESCE(NEW.category,'')) NOT IN (
          'tournament_buyin','rebuy','addon') THEN
    RETURN NULL;
  END IF;
  IF NEW.from_entity_id IS NULL OR NEW.club_id IS NULL THEN
    RAISE EXCEPTION 'tournament charge ledger omitted player or source club'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_split FROM public.fn_ca_tournament_charge_split(
    NEW.tournament_id,NEW.category,NEW.amount);
  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    escrow_bucket,evidence_kind,created_at)
  VALUES(
    NEW.tournament_id,NEW.from_entity_id,'wallet_charge',lower(NEW.category),
    NEW.club_id,round(NEW.amount,2),v_split.refund_prize,
    v_split.refund_bounty,v_split.refund_fee,NEW.id,NULL,NULL,NULL,
    'wallet_gross','atomic_wallet_charge',transaction_timestamp()) RETURNING id INTO v_original_entitlement;
  PERFORM set_config('app.pnl_tournament_entitlement',v_original_entitlement::text,true);
  RETURN NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_process_tournament_chip_purchase_money_v1(p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric, p_chips numeric, p_current_level integer, p_client_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_original_entitlement uuid; v_original_wallet uuid;
  v_t record;
  v_p record;
  v_unit integer := public.fn_ca_tournament_unit_cents(p_tournament_id);  -- DIAMOND PHASE 8
  v_dia jsonb;                                                              -- DIAMOND PHASE 8
  v_balance numeric;
  v_ratio numeric;
  v_is_bounty boolean;
  v_bounty_head numeric;
  v_base numeric;
  v_fee numeric;
  v_total numeric;
  v_add integer;
  v_new_chips integer;
  v_seat record;
  v_key text;
  v_inserted integer;
  v_cat text;
  v_club uuid;
  v_stack_after numeric;
  v_expected numeric;
  v_fee_ratio numeric;
  v_was_seated boolean:=false;
  v_rows integer;
  v_led_cat text;
  v_led_cp text;
  v_led_ent text;
  v_led_tid text;
BEGIN
  IF NOT (COALESCE(auth.role(),'service_role')='service_role')
     AND (auth.uid() IS NULL OR auth.uid()<>p_user_id) THEN
    RAISE EXCEPTION
      'process_tournament_rebuy: caller may only transact for themselves'
      USING ERRCODE='42501';
  END IF;
  IF p_rebuy_type NOT IN ('rebuy','reentry','addon') THEN
    RAISE EXCEPTION 'Invalid rebuy type: %',p_rebuy_type
      USING ERRCODE='22023';
  END IF;
  IF p_client_token IS NULL OR length(btrim(p_client_token))=0
     OR length(btrim(p_client_token))>128 THEN
    RAISE EXCEPTION 'exact tournament chip-purchase token is required'
      USING ERRCODE='22023';
  END IF;

  SELECT id,name,club_id,status,buy_in_amount,buy_in_fee,starting_chips,
         is_rebuy,is_reentry,add_on_available,addon_period_triggered,
         rebuy_cost,rebuy_chips,rebuy_levels,late_reg_levels,max_rebuys,
         max_reentries,addon_cost,addon_chips,addon_levels,current_level,
         prize_pool,is_bounty,is_pko,is_mystery_bounty,bounty_amount
    INTO v_t
    FROM public.tournaments
   WHERE id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;
  IF v_t.status NOT IN ('RUNNING','REGISTERING','ANNOUNCED') THEN
    RAISE EXCEPTION 'Tournament is not accepting chip purchases (status %)',v_t.status;
  END IF;

  SELECT id,chips,status,prize,rebuys,add_on,table_id,club_id
    INTO v_p
    FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not registered in this tournament';
  END IF;
  IF v_p.status='eliminated' AND COALESCE(v_p.prize,0)>0 THEN
    RAISE EXCEPTION
      'Finishing Place Already Paid - A Rebuy Cannot Resurrect A Settled Result';
  END IF;
  v_club:=v_p.club_id;
  IF v_club IS NULL THEN
    RAISE EXCEPTION
      'Tournament entry funding club is missing; refusing a substituted wallet'
      USING ERRCODE='P0404';
  END IF;

  v_cat:=CASE WHEN p_rebuy_type='addon' THEN 'addon' ELSE 'rebuy' END;
  v_key:=CASE WHEN p_rebuy_type='addon'
    THEN 'tourney:'||p_tournament_id::text||':addon:'||p_user_id::text
    ELSE 'tourney:'||p_tournament_id::text||':'||p_rebuy_type||':'||
         p_user_id::text||':tok:'||btrim(p_client_token)
  END;

  IF p_rebuy_type='addon' THEN
    PERFORM 1
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE s.user_id=p_user_id AND s.left_at IS NULL
       AND tb.tournament_id=p_tournament_id
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'No Live Seat For This % - Aborting So No Charge Is Made',p_rebuy_type;
    END IF;
    IF NOT COALESCE(v_t.add_on_available,false) THEN
      RAISE EXCEPTION 'Add-ons are not offered in this tournament';
    END IF;
    IF COALESCE(v_p.add_on,false) THEN
      RAISE EXCEPTION 'Add-on already taken';
    END IF;
    v_base:=COALESCE(NULLIF(v_t.addon_cost,0),v_t.buy_in_amount,0);
    v_add:=COALESCE(NULLIF(v_t.addon_chips,0),v_t.starting_chips,0)::integer;
  ELSE
    IF p_rebuy_type='rebuy' AND NOT COALESCE(v_t.is_rebuy,false) THEN
      RAISE EXCEPTION 'Rebuys are not offered in this tournament';
    END IF;
    IF p_rebuy_type='reentry' AND NOT COALESCE(v_t.is_reentry,false) THEN
      RAISE EXCEPTION 'Re-entries are not offered in this tournament';
    END IF;
    IF p_rebuy_type='rebuy' AND v_t.max_rebuys IS NOT NULL
       AND COALESCE(v_p.rebuys,0)>=v_t.max_rebuys THEN
      RAISE EXCEPTION 'Rebuy limit reached (% of %)',v_p.rebuys,v_t.max_rebuys;
    END IF;
    IF p_rebuy_type='reentry' AND v_t.max_reentries IS NOT NULL
       AND COALESCE(v_p.rebuys,0)>=v_t.max_reentries THEN
      RAISE EXCEPTION
        'Re-entry limit reached (% of %)',v_p.rebuys,v_t.max_reentries;
    END IF;
    IF p_rebuy_type='rebuy'
       AND COALESCE(v_p.chips,0)>COALESCE(v_t.starting_chips,0) THEN
      RAISE EXCEPTION 'Stack too high for a rebuy';
    END IF;
    /* CONSERVATION (a) 2026-09-11. A re-entry REPLACES the seat stack below
       (stack = v_add) while the roster gains rebuys + 1, so the conservation
       check's expected side gains rebuy_chips at the same moment. Taken while
       the entry still holds chips, that destroys them AND inflates expected.
       A re-entry follows a bust, so the live population for this is zero; it
       is refused rather than left to silently unbalance the event. */
    IF p_rebuy_type='reentry' AND COALESCE(v_p.chips,0)>0 THEN
      RAISE EXCEPTION
        'A Re-Entry Starts A New Stack And This Entry Still Holds % Chips - Aborting So No Charge Is Made',
        v_p.chips
        USING ERRCODE='55000';
    END IF;
    v_base:=COALESCE(NULLIF(v_t.rebuy_cost,0),v_t.buy_in_amount,0);
    v_add:=COALESCE(NULLIF(v_t.rebuy_chips,0),v_t.starting_chips,0)::integer;
  END IF;

  v_fee_ratio:=public.fn_ca_tournament_fee_ratio(
    v_t.buy_in_amount,v_t.buy_in_fee);
  v_ratio:=CASE WHEN p_rebuy_type='addon' THEN 0 ELSE v_fee_ratio END;
  v_total:=round(v_base::numeric);
  v_fee:=CASE WHEN v_ratio>0 AND v_total>0
    THEN public.fn_ca_recovery_fee_cents(
           round(v_total*100)::bigint,v_ratio,
           public.fn_ca_tournament_unit_cents(p_tournament_id))::numeric/100    ELSE 0
  END;
  v_base:=round(v_total-v_fee,2);
  v_is_bounty:=COALESCE(v_t.is_bounty,false)
    OR COALESCE(v_t.is_pko,false)
    OR COALESCE(v_t.is_mystery_bounty,false);
  IF v_is_bounty AND p_rebuy_type<>'addon' THEN
    v_bounty_head:=public.fn_ca_unit_floor_cents(
      round(LEAST(GREATEST(0,round(COALESCE(v_t.bounty_amount,0),2)),
                  v_base)*100)::bigint,
      public.fn_ca_tournament_unit_cents(p_tournament_id))::numeric/100;
    v_base:=v_base-v_bounty_head;
  ELSE
    v_bounty_head:=0;
  END IF;
  IF p_cost IS NOT NULL AND abs(p_cost-v_total)>0.01 THEN
    RAISE EXCEPTION
      'Price mismatch: client quoted %, server computed %',p_cost,v_total
      USING ERRCODE='22023';
  END IF;
  IF v_add<=0 OR v_total<0 OR v_fee<0 OR v_base<0 OR v_bounty_head<0
     OR round(v_base+v_bounty_head+v_fee,2)<>round(v_total,2) THEN
    RAISE EXCEPTION 'Tournament chip-purchase quote does not conserve'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
  VALUES(v_key,p_user_id,v_total)
  ON CONFLICT(key) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  IF v_inserted=0 THEN
    RETURN jsonb_build_object(
      'success',true,'idempotent',true,'new_stack',v_p.chips,
      'rebuy_type',p_rebuy_type);
  END IF;

  IF v_unit = 100 THEN
    -- DIAMOND PHASE 8: the purchase reserves settled Diamonds into the entry's
    -- custody row. The chip-wallet debit below is the chip estate's.
    v_dia := public.fn_poker_diamond_tournament_charge(
      p_user_id, p_tournament_id, p_rebuy_type, v_total, v_base, v_bounty_head, v_fee, v_p.id, v_key);
    v_balance := 0;
  ELSE
  PERFORM public.fn_ensure_club_wallet(p_user_id,v_club);
  SELECT chip_balance INTO v_balance
    FROM public.club_members
   WHERE user_id=p_user_id AND club_id=v_club
   FOR UPDATE;
  IF v_balance IS NULL OR v_balance<v_total THEN
    RAISE EXCEPTION 'Insufficient club chips: need %, have %',
      v_total,COALESCE(v_balance,0);
  END IF;

  v_led_cat:=current_setting('app.ledger_category',true);
  v_led_cp:=current_setting('app.ledger_counterparty',true);
  v_led_ent:=current_setting('app.ledger_counterparty_entity',true);
  v_led_tid:=current_setting('app.ledger_tournament',true);
  PERFORM set_config('app.ledger_category',v_cat,true);
  PERFORM set_config('app.ledger_counterparty','prize_liability',true);
  PERFORM set_config(
    'app.ledger_counterparty_entity',p_tournament_id::text,true);
  PERFORM set_config('app.ledger_tournament',p_tournament_id::text,true);
  PERFORM set_config('app.pnl_tournament_entitlement','',true);
  UPDATE public.club_members
     SET chip_balance=chip_balance-v_total,updated_at=now()
   WHERE user_id=p_user_id AND club_id=v_club;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  v_original_entitlement:=NULLIF(current_setting('app.pnl_tournament_entitlement',true),'')::uuid;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'Exact tournament funding wallet changed during debit'
      USING ERRCODE='40001';
  END IF;
  END IF; -- DIAMOND PHASE 8: end of the chip-wallet branch
  PERFORM set_config('app.ledger_category',COALESCE(v_led_cat,''),true);
  PERFORM set_config('app.ledger_counterparty',COALESCE(v_led_cp,''),true);
  PERFORM set_config(
    'app.ledger_counterparty_entity',COALESCE(v_led_ent,''),true);
  PERFORM set_config('app.ledger_tournament',COALESCE(v_led_tid,''),true);

  IF p_rebuy_type='reentry' THEN
    UPDATE public.tournament_players
       SET chips=v_add,status='playing',eliminated_at=NULL,position=NULL,
           rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type='addon' THEN
    UPDATE public.tournament_players
       SET chips=COALESCE(chips,0)+v_add,add_on=true
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSE
    UPDATE public.tournament_players
       SET chips=COALESCE(chips,0)+v_add,status='playing',
           eliminated_at=NULL,position=NULL,
           rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  END IF;
  IF v_new_chips IS NULL THEN
    RAISE EXCEPTION 'Locked tournament roster changed during chip grant'
      USING ERRCODE='40001';
  END IF;

  IF v_bounty_head>0 THEN
    UPDATE public.tournament_players
       SET current_bounty=CASE WHEN p_rebuy_type='reentry'
         THEN v_bounty_head
         ELSE COALESCE(current_bounty,0)+v_bounty_head END
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id;
  END IF;

  SELECT s.id,s.stack INTO v_seat
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND tb.tournament_id=p_tournament_id
   ORDER BY (tb.status IS DISTINCT FROM 'closed') DESC,
            s.joined_at DESC NULLS LAST,s.id DESC
   LIMIT 1;
  IF FOUND THEN
    v_was_seated:=true;
    v_expected:=CASE WHEN p_rebuy_type='reentry'
      THEN v_add ELSE COALESCE(v_seat.stack,0)+v_add END;
    /* CONSERVATION (b) 2026-09-11. The roster above has already booked this
       purchase, so the supply this is measured against already contains the
       chips being bought. The felt must land inside it. An event that is
       already over its cap keeps playing; it may not get further over.
       See ca_drift_incidents 8b8fe26c and this migration's header. */
    PERFORM public.fn_ca_assert_tournament_chip_grant(
      p_tournament_id,p_user_id,v_seat.id,v_expected,
      'tournament '||p_rebuy_type);
    UPDATE public.table_seats
       SET stack=CASE WHEN p_rebuy_type='reentry'
         THEN v_add ELSE COALESCE(stack,0)+v_add END
     WHERE id=v_seat.id
     RETURNING stack INTO v_stack_after;
    IF v_stack_after IS NULL OR v_stack_after<>v_expected THEN
      RAISE EXCEPTION
        'Chip Grant Did Not Land: % Expected Stack %, Seat % Holds % - Aborting So No Charge Is Made',
        p_rebuy_type,v_expected,v_seat.id,v_stack_after;
    END IF;
    UPDATE public.tournament_players
       SET chips=(SELECT stack FROM public.table_seats WHERE id=v_seat.id)::integer
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type='addon' THEN
    RAISE EXCEPTION
      'Seat Disappeared During % - Aborting So No Charge Is Made',p_rebuy_type;
  END IF;

  UPDATE public.tournaments
     SET prize_pool=COALESCE(prize_pool,0)+v_base,
         bounty_pool=COALESCE(bounty_pool,0)+v_bounty_head
   WHERE id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'Tournament vanished during chip-purchase pool booking'
      USING ERRCODE='40001';
  END IF;

  IF v_fee>0 AND v_t.club_id IS NOT NULL AND v_unit = 100 THEN
    -- DIAMOND PHASE 8: the fee stays in custody until the event settles.
    UPDATE public.tournaments
       SET total_rake=COALESCE(total_rake,0)+v_fee
     WHERE id=p_tournament_id;
  ELSIF v_fee>0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(
      NULL,NULL,v_t.club_id,v_fee,v_fee,1,0,true,p_tournament_id,
      'process_tournament_rebuy',jsonb_build_object(
        'kind','tournament_'||p_rebuy_type||'_fee','user_id',p_user_id,
        'entry_club_id',v_club));
    UPDATE public.tournaments
       SET total_rake=COALESCE(total_rake,0)+v_fee
     WHERE id=p_tournament_id;
  END IF;

  IF v_unit = 1 THEN -- DIAMOND PHASE 8: wallet_transactions is the chip receipt
  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,type,amount,category,description,
    related_entity_id,balance_after)
  VALUES(
    p_user_id,'PLAYER','debit',v_total,v_cat,
    'Tournament '||p_rebuy_type||': '||COALESCE(v_t.name,'tournament')||
      ' ('||v_base||' prize + '||v_bounty_head||' bounty + '||v_fee||
      ' fee) [club wallet]',
    p_tournament_id,v_balance-v_total) RETURNING id INTO v_original_wallet;
  END IF; -- DIAMOND PHASE 8

  PERFORM public.fn_ca_record_tournament_participant_funding(v_p.id,p_rebuy_type,v_key,
    v_total,CASE WHEN v_unit=100 THEN 'diamonds' ELSE 'chips' END,
    v_original_entitlement,v_original_wallet,v_dia);

  RETURN jsonb_build_object(
    'success',true,'new_stack',v_new_chips,'rebuy_type',p_rebuy_type,
    'chips_added',v_add,'cost',v_total,'fee',v_fee,'seated',v_was_seated,
    'bounty_head_funded',v_bounty_head);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_credit_and_log(p_user_id uuid, p_amount numeric, p_idempotency_key text, p_category text, p_description text, p_related_entity_id uuid DEFAULT NULL::uuid, p_wallet_type text DEFAULT 'PLAYER'::text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_payout_position integer DEFAULT NULL::integer, p_payout_source text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_original_ledger uuid; v_original_wallet uuid;
  v_diamond boolean := false;  -- DIAMOND PHASE 8
  v_credited boolean;
  v_ledger_cat text;
  v_t record;
  v_field integer;
  v_shape_source text;
  v_shape_place integer;
  v_payout_source text;
  v_payout_place integer;
  v_payout_id uuid;
  v_existing_key record;
  v_key_existed boolean := false;
  v_evidence_count integer;
  v_prev_cp text;
  v_prev_cp_entity text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'fn_credit_and_log requires a user id' USING ERRCODE = '22004';
  END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'fn_credit_and_log requires an idempotency key' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <= 0
     OR p_amount IS DISTINCT FROM round(p_amount, 2) THEN
    RAISE EXCEPTION
      'fn_credit_and_log requires a finite positive whole-cent amount (got %)',
      p_amount USING ERRCODE = '22003';
  END IF;

  SELECT k.user_id, k.amount INTO v_existing_key
    FROM public.wallet_credit_idempotency k
   WHERE k.key = p_idempotency_key;
  v_key_existed := FOUND;
  IF v_key_existed
     AND (v_existing_key.user_id IS DISTINCT FROM p_user_id
       OR v_existing_key.amount IS NULL
       OR v_existing_key.amount::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_existing_key.amount IS DISTINCT FROM p_amount) THEN
    RAISE EXCEPTION 'idempotency key % belongs to a different credit',
      p_idempotency_key USING ERRCODE = '23505';
  END IF;

  v_ledger_cat := CASE lower(COALESCE(p_category, ''))
                    WHEN 'prize' THEN 'tournament_prize'
                    WHEN 'buyin' THEN 'tournament_buyin'
                    WHEN '' THEN 'adjustment'
                    ELSE lower(p_category)
                  END;

  -- Resolve mandatory evidence before the wallet move. Explicit obligation
  -- metadata wins; legacy owner-only callers may still classify their key.
  IF lower(COALESCE(p_category, '')) = 'prize' THEN
    IF p_related_entity_id IS NULL THEN
      RAISE EXCEPTION 'a tournament prize requires a tournament id'
        USING ERRCODE = '23502';
    END IF;
    SELECT t.id, t.tournament_type, t.prize_pool, t.payout_structure
      INTO v_t FROM public.tournaments t
     WHERE t.id = p_related_entity_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tournament % does not exist for prize evidence',
        p_related_entity_id USING ERRCODE = '23503';
    END IF;
    SELECT s.source, s.place INTO v_shape_source, v_shape_place
      FROM public.fn_tournament_payout_shape(p_idempotency_key) s;
    v_payout_source := COALESCE(NULLIF(btrim(p_payout_source), ''),
                                v_shape_source);
    -- A payment whose kind is unknown is not allowed to move. This check is
    -- deliberately before fn_credit_player_wallet_once: the payout row and
    -- wallet credit are one transaction, but rejecting the unnamed path here
    -- also prevents an older catch-and-alert writer from ever treating a
    -- missing classification as non-fatal.
    IF v_payout_source IS NULL THEN
      RAISE EXCEPTION
        'tournament prize % has no recognized payout source',
        p_idempotency_key USING ERRCODE = '22023';
    END IF;
    IF v_payout_source NOT IN (
      'structure','reconcile','hu_shortfall','bounty','bounty_residual',
      'own_bounty','late_reg_adjustment','clawback','final_table_deal',
      'mystery_bounty','mystery_bounty_residual','spin_backpay',
      'overlay_backpay','bubble_protection','satellite_remainder',
      'satellite_seat','satellite_ticket','finish_position_correction'
    ) THEN
      RAISE EXCEPTION
        'tournament prize % supplied unknown payout source %',
        p_idempotency_key, v_payout_source USING ERRCODE = '22023';
    END IF;
    v_payout_place := COALESCE(p_payout_position, v_shape_place);
    IF v_payout_place IS NOT NULL AND v_payout_place <= 0 THEN
      RAISE EXCEPTION 'prize evidence has invalid finish position %', v_payout_place
        USING ERRCODE = '22023';
    END IF;
    IF v_payout_source = 'structure' AND v_payout_place IS NULL THEN
      RAISE EXCEPTION 'a structure prize requires a finish position'
        USING ERRCODE = '23502';
    END IF;
    SELECT count(*) INTO v_field FROM public.tournament_players
     WHERE tournament_id = v_t.id;
  END IF;

  PERFORM set_config('app.ledger_category', v_ledger_cat, true);
  IF p_related_entity_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_tournament', p_related_entity_id::text, true);
  END IF;
  v_prev_cp := current_setting('app.ledger_counterparty', true);
  v_prev_cp_entity := current_setting('app.ledger_counterparty_entity', true);
  IF p_related_entity_id IS NOT NULL
     AND v_ledger_cat IN ('tournament_prize','bounty','refund','tournament_refund') THEN
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_related_entity_id::text, true);
  END IF;

  -- DIAMOND PHASE 8: a Diamond event pays from its own custody, never from a
  -- club chip wallet. Same key, same obligation, same evidence row below.
  v_diamond := p_related_entity_id IS NOT NULL AND public.fn_poker_diamond_tournament(p_related_entity_id);
  IF v_diamond THEN
    v_credited := public.fn_poker_diamond_tournament_pay(
      p_user_id, p_amount, p_idempotency_key, p_category, p_related_entity_id, p_description);
  ELSE
  PERFORM set_config('app.pnl_tournament_credit_ledger','',true);
  v_credited := public.fn_credit_player_wallet_once(
    p_user_id, p_amount, p_idempotency_key);
  v_original_ledger:=NULLIF(current_setting('app.pnl_tournament_credit_ledger',true),'')::uuid;
  END IF;

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_tournament', '', true);
  PERFORM set_config('app.ledger_counterparty', COALESCE(v_prev_cp, ''), true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_prev_cp_entity, ''), true);

  IF NOT v_credited THEN
    -- The first snapshot is not authoritative here. Two same-key transactions
    -- can both see no row; the loser then waits on the unique index inside
    -- fn_credit_player_wallet_once and returns FALSE after the winner commits.
    -- Re-read in a new statement snapshot, after that wait, and accept only the
    -- exact committed key. A genuinely orphaned or mismatched claim still
    -- aborts the outer transaction.
    SELECT k.user_id, k.amount INTO v_existing_key
      FROM public.wallet_credit_idempotency k
     WHERE k.key = p_idempotency_key
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'wallet credit % claimed its key but did not credit a wallet',
        p_idempotency_key USING ERRCODE = 'P0404';
    END IF;
    IF v_existing_key.user_id IS DISTINCT FROM p_user_id
       OR v_existing_key.amount IS NULL
       OR v_existing_key.amount::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_existing_key.amount IS DISTINCT FROM p_amount THEN
      RAISE EXCEPTION 'idempotency key % belongs to a different credit',
        p_idempotency_key USING ERRCODE = '23505';
    END IF;
    IF lower(COALESCE(p_category, '')) = 'prize' THEN
      SELECT count(*) INTO v_evidence_count
        FROM public.tournament_payouts tp
       WHERE tp.idempotency_key = p_idempotency_key
         AND tp.tournament_id = p_related_entity_id
         AND tp.user_id = p_user_id
         AND tp.amount = p_amount
         AND tp."position" IS NOT DISTINCT FROM v_payout_place
         AND tp.source IS NOT DISTINCT FROM v_payout_source;
      IF v_evidence_count <> 1 THEN
        RAISE EXCEPTION
          'prize replay % has % exact payout rows, expected one',
          p_idempotency_key, v_evidence_count USING ERRCODE = 'P0404';
      END IF;
    END IF;
    RETURN false;
  END IF;

  IF NOT v_diamond THEN -- DIAMOND PHASE 8: wallet_transactions is the chip receipt
  PERFORM public.log_wallet_transaction(
    p_user_id, p_wallet_type, p_amount, 'credit', p_category, p_description,
    p_table_id, p_hand_id, p_related_entity_id);
  v_original_wallet:=NULLIF(current_setting('app.pnl_tournament_wallet_tx',true),'')::uuid;
  END IF;

  IF lower(COALESCE(p_category, '')) = 'prize' THEN
    INSERT INTO public.tournament_payouts
      (tournament_id, user_id, "position", amount, source, idempotency_key,
       paid_at, tournament_type, field_size, prize_pool, payout_structure,
       recorded_by)
    VALUES
      (v_t.id, p_user_id, v_payout_place, p_amount, v_payout_source,
       p_idempotency_key, now(), v_t.tournament_type, v_field, v_t.prize_pool,
       CASE WHEN v_t.payout_structure IS NULL THEN NULL
            ELSE jsonb_build_object('payout_structure', v_t.payout_structure) END,
       'credit_and_log')
    RETURNING id INTO v_payout_id;

    IF v_payout_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.tournament_payouts tp
       WHERE tp.id = v_payout_id
         AND tp.idempotency_key = p_idempotency_key
         AND tp.tournament_id = p_related_entity_id
         AND tp.user_id = p_user_id
         AND tp.amount = p_amount
         AND tp."position" IS NOT DISTINCT FROM v_payout_place
         AND tp.source IS NOT DISTINCT FROM v_payout_source
    ) THEN
      RAISE EXCEPTION 'prize % could not verify its payout evidence',
        p_idempotency_key USING ERRCODE = 'P0404';
    END IF;
  END IF;
  IF NOT v_diamond AND p_related_entity_id IS NOT NULL
     AND v_ledger_cat IN ('tournament_prize','bounty','refund','tournament_refund') THEN
    PERFORM public.fn_ca_record_tournament_accounting_credit(p_idempotency_key,
      p_related_entity_id,p_user_id,p_amount,v_original_ledger,v_original_wallet,v_payout_id);
  END IF;
  RETURN true;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_before_atomic_capacity_20260907(p_tournament_id uuid, p_seat_first_internal boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_original_entitlement uuid; v_original_wallet uuid;
  v_uid uuid := auth.uid();
  v_unit integer := public.fn_ca_tournament_unit_cents(p_tournament_id);  -- DIAMOND PHASE 8
  v_dia jsonb;                                                              -- DIAMOND PHASE 8
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0;
  v_player_id uuid;
  v_late_open boolean := false; v_ok boolean;
  v_start_chips integer := 0;
  v_players_before integer;
  v_expected_cached_players integer;
  v_rows integer;
  v_seat jsonb := NULL;                                  -- LATE SEAT 2026-08-23
  v_seat_reason text;                                    -- SEAT FIX 2026-08-27
  v_led_cat text; v_led_cp text; v_led_ent text; v_led_tid text; -- CHIP STANDARD 1.2 2026-09-02
BEGIN
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_register_for_tournament requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         late_reg_levels, late_reg_mins, current_level, started_at, club_id, name, prize_pool_finalized,
         is_bounty, is_pko, is_mystery_bounty, bounty_amount,
         start_time, authorized_to_register, is_vip_only, early_bird_enabled, early_bird_chips,
         variant
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  -- SEAT-FIRST GUARD 2026-08-27, REBUILT 2026-08-28. A seat-first event is
  -- bought by taking a seat; registering into one debits the player for a
  -- seat that is never allocated. But the seat path ITSELF registers the
  -- player through this function, so the guard admits that caller via
  -- p_seat_first_internal - the original guard refused it too and no human
  -- could buy a Spin or Heads-Up seat at all. And the predicate is now the
  -- CANONICAL seat-first test (variant 'spin' OR a positive max_players <= 2), matching
  -- fn_take_seat_and_buy_in and fn_sync_seat_first_player_count: the original
  -- blocked ALL sngs, which left 6-max and 9-max SNGs with no entry path in
  -- either door.
  IF NOT p_seat_first_internal
     AND NOT public.fn_ca_tournament_is_unlimited(p_tournament_id)
     AND (lower(COALESCE(v_t.variant, '')) = 'spin'
       OR (v_t.max_players IS NOT NULL
         AND v_t.max_players > 0 AND v_t.max_players <= 2)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_first_variant',
      'detail', 'This format is entered by taking a seat, not by registering. '
                || 'Call fn_take_seat_and_buy_in for the seat you want.',
      'variant', v_t.variant);
  END IF;

  IF v_t.status = 'RUNNING' THEN
    v_late_open:=public.fn_tournament_late_registration_open(p_tournament_id);
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;
  SELECT count(*)::integer INTO v_players_before
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  IF v_t.current_players IS DISTINCT FROM v_players_before THEN
    RAISE EXCEPTION
      'Tournament roster cache diverged before registration (cached %, actual %)',
      v_t.current_players,v_players_before
      USING ERRCODE='P0404';
  END IF;
  IF NOT public.fn_ca_tournament_is_unlimited(p_tournament_id)
     AND v_t.max_players IS NOT NULL AND v_t.max_players > 0
     AND v_players_before >= v_t.max_players THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_full');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = p_tournament_id AND user_id = v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  -- PARITY GATE 1 (2026-08-22): owner-approved registration list.
  IF COALESCE(v_t.authorized_to_register, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.tournament_registration_approvals a
                    WHERE a.tournament_id = p_tournament_id AND a.user_id = v_uid)
       AND NOT public.is_club_admin(v_t.club_id, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized_to_register');
    END IF;
  END IF;

  -- PARITY GATE 2 (2026-08-22): VIP-only events.
  IF COALESCE(v_t.is_vip_only, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles pr
                    WHERE pr.id = v_uid AND COALESCE(pr.is_vip, false)
                      AND (pr.vip_expires_at IS NULL OR pr.vip_expires_at > now()))
       AND NOT EXISTS (SELECT 1 FROM public.club_members m
                        WHERE m.club_id = v_t.club_id AND m.user_id = v_uid
                          AND m.role IN ('owner', 'co_owner', 'admin', 'agent')) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'vip_only');
    END IF;
  END IF;

  -- PARITY 3 (2026-08-22): early bird bonus chips for pre-start registration.
  IF COALESCE(v_t.early_bird_enabled, false)
     AND now() < v_t.start_time
     AND COALESCE(v_t.early_bird_chips, 0) > 0 THEN
    v_start_chips := v_t.early_bird_chips;
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = v_uid;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty',
      'detail', format('bounty %s + rake %s exceeds buy-in %s',
                       v_split.bounty, v_split.rake, v_split.charge));
  END IF;

  -- MYSTERY BOUNTY 2026-08-25: every bounty format puts the flat bounty on
  -- the head; the mystery value is drawn from a funded inventory at the
  -- knockout, not from a seeded PRNG at the till.
  IF v_is_bounty THEN
    v_head := v_split.bounty;
  END IF;

  IF v_split.charge > 0 AND v_unit = 100 THEN
    -- DIAMOND PHASE 8: a Diamond entry is custody, not a club-wallet debit. The
    -- roster row is written first so the custody row can name it; the whole
    -- transaction still rolls back together.
    IF v_split.charge <> trunc(v_split.charge) OR v_split.prize <> trunc(v_split.prize)
       OR v_split.rake <> trunc(v_split.rake) OR v_split.bounty <> trunc(v_split.bounty) THEN
      RAISE EXCEPTION 'diamond_tournament_requires_whole_amounts' USING ERRCODE = '23514';
    END IF;
    v_player_id := gen_random_uuid();
    BEGIN
      v_dia := public.fn_poker_diamond_tournament_charge(
        v_uid, p_tournament_id, 'entry', v_split.charge, v_split.prize, v_split.bounty, v_split.rake,
        v_player_id, 'poker-tournament-entry:' || p_tournament_id::text || ':' || v_uid::text || ':' || v_player_id::text);
    EXCEPTION WHEN OTHERS THEN
      -- DIAMOND PHASE 8: an ordinary refusal is answered the way the chip core
      -- answers one, with a reason the client can say; anything else is raised.
      IF SQLERRM LIKE '%insufficient_settled_diamonds%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_diamonds');
      ELSIF SQLERRM LIKE '%diamond_tournaments_not_open%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'diamond_tournaments_not_open');
      ELSIF SQLERRM LIKE '%diamond_debt_requires_settlement%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'diamond_debt_requires_settlement');
      ELSIF SQLERRM LIKE '%diamond_tournament_entry_already_held%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
      END IF;
      RAISE;
    END;
  ELSIF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE REGISTRATION DEBIT NAMES ITS COUNTERPARTY.
    -- trg_club_members_audit_chip_movement journals the wallet write below; with no
    -- declaration it landed as adjustment player_wallet -> table_stack with no
    -- tournament_id (19,538 rows / 407,412.00 a day). Declared with set_config, not
    -- fn_ca_declare_ledger, so a vocabulary miss can never refuse a buy-in (the
    -- writer falls back to adjustment on its own). The whole charge (prize + bounty
    -- + fee) is ONE wallet write and so ONE row, booked against the tournament
    -- (prize_liability) that holds all three until it completes. The four settings
    -- are restored right after so nothing later in this transaction inherits them.
    v_led_cat := current_setting('app.ledger_category', true);
    v_led_cp  := current_setting('app.ledger_counterparty', true);
    v_led_ent := current_setting('app.ledger_counterparty_entity', true);
    v_led_tid := current_setting('app.ledger_tournament', true);
    PERFORM set_config('app.ledger_category', 'tournament_buyin', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);
    PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);
    PERFORM set_config('app.pnl_tournament_entitlement','',true);
    v_ok := public.atomic_deduct_wallet_and_log(
      v_uid, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament') ||
        CASE WHEN v_is_bounty
             THEN ' (' || v_split.prize || ' prize + ' || v_split.bounty || ' bounty + ' || v_split.rake || ' fee)'
             WHEN v_split.rake > 0
             THEN ' (' || v_split.prize || ' + ' || v_split.rake || ' fee)'
             ELSE '' END,
      NULL, NULL, p_tournament_id);
    v_original_entitlement:=NULLIF(current_setting('app.pnl_tournament_entitlement',true),'')::uuid;
    PERFORM set_config('app.ledger_category', COALESCE(v_led_cat, ''), true);
    PERFORM set_config('app.ledger_counterparty', COALESCE(v_led_cp, ''), true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_led_ent, ''), true);
    PERFORM set_config('app.ledger_tournament', COALESCE(v_led_tid, ''), true);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM public.log_wallet_transaction(
      v_uid, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
    v_original_wallet:=NULLIF(current_setting('app.pnl_tournament_wallet_tx',true),'')::uuid;
  END IF;

  BEGIN
    IF v_dia IS NOT NULL THEN
      -- DIAMOND PHASE 8: the roster row carries the id the custody row was named with.
      -- DIAMOND PHASE 9: the head rides on the roster row as it does for a
      -- chip entry, so the roster trigger does not seed it a second time.
      INSERT INTO public.tournament_players
        (id, tournament_id, user_id, username, chips, status, current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (v_player_id, p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered',
              v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSIF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION
      'Tournament registration identity changed after its atomic debit; retry the complete transaction'
      USING ERRCODE = '40001';
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL AND v_unit = 1 THEN
    -- DIAMOND PHASE 8: a Diamond fee stays in custody until the event settles;
    -- rake_records is the chip estate's fee rail.
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',v_uid,'registration_id',v_player_id));
  END IF;

  -- The roster trigger already writes the exact count while an event is
  -- ANNOUNCED/REGISTERING, but deliberately leaves RUNNING counts to the
  -- transaction that also seats the late entrant. Incrementing the cached
  -- value here therefore double-counted every pre-start entry. Require the
  -- exact state produced by that trigger (or the unchanged RUNNING state),
  -- then publish one roster-derived value together with the funded pools.
  v_expected_cached_players:=CASE
    WHEN v_t.status IN ('ANNOUNCED','REGISTERING') THEN v_players_before+1
    ELSE v_players_before
  END;
  UPDATE public.tournaments
     SET current_players = v_players_before + 1,
         prize_pool  = COALESCE(prize_pool, 0)  + v_split.prize,
         bounty_pool = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake  = COALESCE(total_rake, 0)  + v_split.rake
   WHERE id = p_tournament_id
     AND current_players IS NOT DISTINCT FROM v_expected_cached_players;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION
      'Tournament roster cache changed during registration'
      USING ERRCODE='40001';
  END IF;

  -- LATE SEAT 2026-08-23
  IF v_late_open THEN
    v_seat := public.fn_seat_late_registrant(p_tournament_id, v_uid);

    -- SEAT FIX 2026-08-27: a late registrant who cannot be seated must not be
    -- charged; abort so debit, roster row, rake record and pool increments
    -- roll back together. 'already_seated_or_missing' is NOT a failure.
    v_seat_reason := v_seat->>'reason';
    IF NOT COALESCE((v_seat->>'ok')::boolean, false)
       AND COALESCE(v_seat_reason, '') <> 'already_seated_or_missing' THEN
      RAISE EXCEPTION
        'Late registration could not seat the player (%) - no charge has been made',
        COALESCE(v_seat_reason, 'unknown')
        USING ERRCODE = '55000';
    END IF;
  END IF;

  PERFORM public.fn_ca_record_tournament_participant_funding(v_player_id,'entry',NULL,
    v_split.charge,CASE WHEN v_unit=100 THEN 'diamonds' ELSE 'chips' END,
    v_original_entitlement,v_original_wallet,v_dia);

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake,
    'bounty_head', CASE WHEN v_head > 0 THEN v_head END,
    'early_bird_chips', CASE WHEN v_start_chips > 0 THEN v_start_chips END,
    'late_registration', v_late_open,                    -- LATE SEAT 2026-08-23
    -- DIAMOND PHASE 8: the receipt names its asset and, for a Diamond entry,
    -- the wallet after the charge, so the client can move the balance it shows.
    'asset', CASE WHEN v_dia IS NOT NULL THEN 'diamonds' ELSE 'chips' END,
    'diamonds_after', CASE WHEN v_dia IS NOT NULL THEN (SELECT p.diamonds FROM public.profiles p WHERE p.id = v_uid) END,
    'seat', v_seat);                                     -- LATE SEAT 2026-08-23
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation_before_atomic_batch_gate(p_tournament_id uuid, p_kind text, p_place integer, p_user_id uuid, p_amount numeric, p_source text, p_description text DEFAULT NULL::text, p_adjustment_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_kind        text := lower(btrim(COALESCE(p_kind, '')));
  v_row_kind    text;
  v_place       integer;
  v_amount      numeric := round(COALESCE(p_amount, 0), 2);
  v_t           record;
  v_ob          public.tournament_obligations%ROWTYPE;
  v_seeded_paid numeric := 0;
  v_owed        numeric;
  v_pay         numeric;
  v_key         text;
  v_category    text;
  v_desc        text;
  v_pool_kinds  text[] := ARRAY['place','late_reg_adjustment','bubble_protection','final_table_deal','satellite_remainder','seat'];
  -- Rows paid from the BOUNTY pool (or recorded on the target by a satellite),
  -- never from the prize pool. Everything else counts against the pool.
  v_not_pool    text[] := ARRAY['satellite_seat','bounty','mystery_bounty','bounty_residual','own_bounty','mystery_bounty_residual'];
  v_paid_pool   numeric := 0;
  v_credited    boolean;
  v_alert_ctx   jsonb;
  v_payout_source text;
  v_adj         public.ca_manual_adjustments%ROWTYPE;
  v_src         text := lower(btrim(COALESCE(p_source, '')));
  v_can         jsonb;
  v_short       numeric;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'missing_ids', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;
  IF v_kind NOT IN ('place','bounty','bounty_residual','mystery_bounty','refund','seat',
                    'satellite_remainder','bubble_protection','final_table_deal','late_reg_adjustment') THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'unknown_kind', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;
  IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity') THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'invalid_amount', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;
  IF p_amount < 0 THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'negative_amount', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;

  -- A late-registration top-up is the SAME obligation as the place it corrects:
  -- it carries the new total and the difference is what moves.
  v_row_kind := CASE WHEN v_kind = 'late_reg_adjustment' THEN 'place' ELSE v_kind END;
  v_place    := CASE WHEN v_row_kind IN ('place') THEN p_place ELSE NULL END;
  IF v_row_kind = 'place' AND v_place IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'place_required', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;

  IF v_row_kind = 'place' AND v_place <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'invalid_place', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;

  -- Kill switch (Lane E): an open freeze on tournament payouts refuses everything.
  IF to_regclass('public.ca_payout_freeze') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f
                WHERE f.scope = 'tournament_payouts' AND f.cleared_at IS NULL) THEN
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
        'refused_reason', 'payout_frozen', 'obligation_id', NULL, 'idempotency_key', NULL);
    END IF;
  END IF;

  /* CHIP STANDARD PHASE 6.1 (2026-09-05): A SETTLEMENT FROM OUTSIDE THE
     PLATFORM NEEDS AN APPROVED ADJUSTMENT. The engine, the recovery and the
     registered doors settle under their own names (ca_settle_sources). Any
     other caller - a migration, an operator, an agent under CLAUDE.md 10.9 -
     must name a ca_manual_adjustments row that is approved, for this event,
     this player, at least this amount, in chips; the row is marked settled
     when the chips move and the obligation carries its id. p_adjustment_id
     was accepted and ignored until today. */
  IF NOT (v_src LIKE 'engine.%' OR EXISTS (SELECT 1 FROM public.ca_settle_sources s WHERE s.source = v_src)) THEN
    IF p_adjustment_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
        'refused_reason', 'adjustment_required', 'obligation_id', NULL, 'idempotency_key', NULL,
        'detail', format('source %s is not a platform settle source; name an approved ca_manual_adjustments row (fn_ca_adjustment_under_10_9 writes one)', COALESCE(NULLIF(v_src, ''), '<none>')));
    END IF;
    SELECT * INTO v_adj FROM public.ca_manual_adjustments WHERE id = p_adjustment_id FOR UPDATE;
    IF NOT FOUND OR v_adj.status <> 'approved' OR v_adj.asset <> 'chips'
       OR v_adj.tournament_id IS DISTINCT FROM p_tournament_id
       OR v_adj.target_kind <> 'player_wallet' OR v_adj.target_id IS DISTINCT FROM p_user_id
       OR v_adj.amount < v_amount THEN
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
        'refused_reason', 'adjustment_mismatch', 'obligation_id', NULL, 'idempotency_key', NULL,
        'detail', 'the adjustment must be approved, in chips, for this tournament, this player wallet, and at least this amount');
    END IF;
  END IF;

  SELECT t.id, t.name, t.club_id, t.prize_pool, t.bounty_pool, t.bounty_pool_paid, t.status
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'tournament_not_found', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;

  -- Upsert the obligation. amount_owed only ever rises.
  IF v_place IS NOT NULL THEN
    SELECT * INTO v_ob FROM public.tournament_obligations
     WHERE tournament_id = p_tournament_id AND kind = v_row_kind AND place = v_place
     FOR UPDATE;
  ELSE
    SELECT * INTO v_ob FROM public.tournament_obligations
     WHERE tournament_id = p_tournament_id AND kind = v_row_kind AND place IS NULL AND user_id = p_user_id
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    -- Legacy seeding: what did the old key shapes already pay for this obligation?
    IF v_place IS NOT NULL THEN
      SELECT COALESCE(sum(tp.amount), 0) INTO v_seeded_paid
        FROM public.tournament_payouts tp
       WHERE tp.tournament_id = p_tournament_id AND tp."position" = v_place
         AND COALESCE(tp.source, '') NOT IN ('satellite_seat');
    ELSIF v_row_kind = 'refund' THEN
      SELECT COALESCE(sum(w.amount), 0) INTO v_seeded_paid
        FROM public.wallet_transactions w
       WHERE w.related_entity_id = p_tournament_id AND w.user_id = p_user_id
         AND w.type = 'credit' AND lower(w.category) IN ('refund','tournament_refund');
    END IF;
    v_seeded_paid := round(v_seeded_paid, 2);
    v_owed := GREATEST(v_amount, v_seeded_paid);

    -- Refuse before creating a new debt. The later guard still protects an
    -- existing unpaid obligation; neither path rewrites historical records.
    -- Only an existing positive legacy payment exempts a no-payment replay.
    IF v_row_kind = 'place' AND (v_seeded_paid <= 0 OR v_amount > v_seeded_paid)
       AND EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
            AND o.user_id = p_user_id AND o.place <> v_place
            AND o.amount_paid > 0
       ) THEN
      v_pay := round(v_amount - v_seeded_paid, 2);
      v_alert_ctx := jsonb_build_object(
        'kind','second_place_prize_refused','tournament_id',p_tournament_id,
        'user_id',p_user_id,'place',v_place,'amount',v_pay,'source',p_source);
      PERFORM public.fn_raise_server_financial_alert(
        'critical','fn_settle_tournament_obligation',
        format('Refused a second structure place: this player already holds a paid place in tournament %s', p_tournament_id),
        v_alert_ctx, 'obl:second_place:' || p_tournament_id::text || ':' || p_user_id::text);
      RETURN jsonb_build_object(
        'ok',false,'paid',0,'already_paid',v_seeded_paid,
        'refused_reason','player_already_holds_a_place',
        'obligation_id',NULL,'idempotency_key',NULL);
    END IF;

    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid, source)
    VALUES (p_tournament_id, v_row_kind, v_place, p_user_id, v_owed, v_seeded_paid, p_source)
    RETURNING * INTO v_ob;
  ELSE
  -- The player on record for a place is whoever was first paid for it; a
  -- different user asking for an already-paid place gets a refusal, not chips.
  IF v_place IS NOT NULL AND v_ob.user_id IS NOT NULL AND v_ob.user_id <> p_user_id AND v_ob.amount_paid > 0 THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', 'place_paid_to_another_user', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
  END IF;

    -- An existing unpaid second-place row also remains unchanged on refusal.
    -- A no-payment replay still reports the durable unpaid amount.
    IF v_row_kind = 'place' AND v_amount > v_ob.amount_paid
       AND EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
            AND o.user_id = p_user_id AND o.place <> v_place
            AND o.amount_paid > 0
       ) THEN
      v_pay := round(v_amount - v_ob.amount_paid, 2);
      v_alert_ctx := jsonb_build_object(
        'kind','second_place_prize_refused','tournament_id',p_tournament_id,
        'user_id',p_user_id,'place',v_place,'amount',v_pay,'source',p_source);
      PERFORM public.fn_raise_server_financial_alert(
        'critical','fn_settle_tournament_obligation',
        format('Refused a second structure place: this player already holds a paid place in tournament %s', p_tournament_id),
        v_alert_ctx, 'obl:second_place:' || p_tournament_id::text || ':' || p_user_id::text);
      RETURN jsonb_build_object(
        'ok',false,'paid',0,'already_paid',v_ob.amount_paid,
        'refused_reason','player_already_holds_a_place',
        'obligation_id',v_ob.id,'idempotency_key',NULL);
    END IF;

    IF v_amount > v_ob.amount_owed THEN
      UPDATE public.tournament_obligations
         SET amount_owed = v_amount, updated_at = now(), user_id = COALESCE(user_id, p_user_id)
       WHERE id = v_ob.id
       RETURNING * INTO v_ob;
    END IF;
  END IF;

  v_pay := round(LEAST(v_amount, v_ob.amount_owed) - v_ob.amount_paid, 2);
  IF v_pay <= 0 THEN
    -- A replay of an older, smaller request can still leave the recorded
    -- obligation unpaid. Report the durable total, not the caller's amount.
    RETURN jsonb_build_object('ok', true, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'amount_owed', v_ob.amount_owed, 'amount_paid', v_ob.amount_paid,
      'remaining', GREATEST(0, v_ob.amount_owed - v_ob.amount_paid),
      'fully_settled', v_ob.amount_paid >= v_ob.amount_owed,
      'refused_reason', NULL, 'obligation_id', v_ob.id, 'idempotency_key', NULL);
  END IF;

  -- R2b: one finisher, one place.
  IF v_row_kind = 'place' THEN
    IF EXISTS (SELECT 1 FROM public.tournament_obligations o
                WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
                  AND o.user_id = p_user_id AND o.place <> v_place AND o.amount_paid > 0) THEN
      v_alert_ctx := jsonb_build_object('kind','second_place_prize_refused','tournament_id',p_tournament_id,
        'user_id',p_user_id,'place',v_place,'amount',v_pay,'source',p_source);
      PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
        format('Refused a second structure place: this player already holds a paid place in tournament %s', p_tournament_id),
        v_alert_ctx, 'obl:second_place:' || p_tournament_id::text || ':' || p_user_id::text);
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
        'refused_reason', 'player_already_holds_a_place', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
    END IF;
  END IF;

  /* R1 (chip standard Phase 5.1, 2026-09-04): the ESCROW BALANCE decides.
     tournament_escrow holds what the event holds, per bank; a place is paid
     from the prize bank, a bounty from the bounty bank, a refund from all
     three. When the balance knows the event, the counter cap below is not
     consulted; the escrow trigger refuses again inside the credit if a race
     gets past this read. An event the balance has never seen (opened on its
     first row) keeps the old counter cap for this call. */
  v_can := public.fn_ca_escrow_can_pay(p_tournament_id, v_row_kind, v_pay);

  /* A BANK THAT IS SHORT PAYS WHAT IT HOLDS (2026-09-07). This used to refuse
     the whole payment, so a bank 180.00 short of a 13,441.68 obligation paid
     the winner nothing and froze 13,261.68 - three events were sitting like
     that when this was written. Paying what is there takes nothing from
     anybody: amount_owed is untouched, so the remainder stays owed and
     payable, and the credit is still capped by the bank and refused again by
     the escrow trigger if a race gets past this read. */
  IF (v_can->>'known')::boolean AND NOT (v_can->>'ok')::boolean
     AND COALESCE((v_can->>'available')::numeric, 0) >= 0.01 THEN
    v_short := round(v_pay - (v_can->>'available')::numeric, 2);
    v_pay   := round((v_can->>'available')::numeric, 2);
    v_alert_ctx := jsonb_build_object('kind','escrow_short_paid_what_it_holds',
      'tournament_id',p_tournament_id,'tournament',v_t.name,'user_id',p_user_id,
      'obligation_kind',v_kind,'place',v_place,'paid',v_pay,'still_owed',v_short,
      'prize_balance',(v_can->>'prize_balance')::numeric,
      'bounty_balance',(v_can->>'bounty_balance')::numeric,
      'fee_balance',(v_can->>'fee_balance')::numeric,'source',p_source);
    PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
      format('Paid %s of %s to %s for %s and %s is still owed: the escrow bank was short (%s)',
             v_pay, v_pay + v_short, p_user_id, v_kind, v_short, v_t.name),
      v_alert_ctx, 'obl:escrow_short_partial:' || v_ob.id::text);
    v_can := public.fn_ca_escrow_can_pay(p_tournament_id, v_row_kind, v_pay);
  END IF;

  IF (v_can->>'known')::boolean AND NOT (v_can->>'ok')::boolean THEN
    v_alert_ctx := jsonb_build_object('kind','escrow_short','tournament_id',p_tournament_id,'tournament',v_t.name,
      'user_id',p_user_id,'obligation_kind',v_kind,'place',v_place,'requested',v_pay,
      'escrow_available',(v_can->>'available')::numeric,'prize_balance',(v_can->>'prize_balance')::numeric,
      'bounty_balance',(v_can->>'bounty_balance')::numeric,'fee_balance',(v_can->>'fee_balance')::numeric,'source',p_source);
    PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
      format('Refused %s to %s for %s: the escrow holds %s for that bank (%s)',
             v_pay, p_user_id, v_kind, (v_can->>'available')::numeric, v_t.name),
      v_alert_ctx, 'obl:escrow_short:' || v_ob.id::text);
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', 'escrow_short', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
  END IF;

  -- R1-lite (counter cap), only for an event the balance has never seen.
  IF v_row_kind = ANY (v_pool_kinds) AND NOT (v_can->>'known')::boolean THEN
    SELECT COALESCE(sum(tp.amount), 0) INTO v_paid_pool
      FROM public.tournament_payouts tp
     WHERE tp.tournament_id = p_tournament_id
       AND NOT (COALESCE(tp.source, '') = ANY (v_not_pool));
    IF v_paid_pool + v_pay > COALESCE(v_t.prize_pool, 0) + 0.05 THEN
      v_alert_ctx := jsonb_build_object('kind','escrow_short','tournament_id',p_tournament_id,'tournament',v_t.name,
        'user_id',p_user_id,'obligation_kind',v_kind,'place',v_place,'requested',v_pay,
        'paid_from_pool_so_far',v_paid_pool,'prize_pool',v_t.prize_pool,'source',p_source);
      PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
        format('Refused %s to %s for %s: the prize pool of %s has already paid %s (%s)',
               v_pay, p_user_id, v_kind, round(COALESCE(v_t.prize_pool,0),2), v_paid_pool, v_t.name),
        v_alert_ctx, 'obl:escrow_short:' || v_ob.id::text);
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
        'refused_reason', 'escrow_short', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
    END IF;
  END IF;

  /* THE KEY NAMES THE TOURNAMENT (Lane A3, 2026-09-02). fn_credit_player_wallet_once
     resolves WHICH club wallet to credit from a 'tourney:<id>:...' key
     (tournament_players.club_id for that entry); any other shape falls back to
     fn_player_home_club, which is the club the player joined FIRST, not the
     club they bought in from. Measured in the rolled-back probe: 3 of 4 places
     landed in the wrong club under the old 'obl:<id>:<n>' shape. No 'obl:' key
     was ever spent in production, so the rename costs nothing. */
  v_key := 'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':' || (round(v_ob.amount_paid * 100))::bigint::text;
  v_category := CASE
                  WHEN v_row_kind IN ('bounty','bounty_residual','mystery_bounty') THEN 'bounty'
                  WHEN v_row_kind = 'refund' THEN 'refund'
                  ELSE 'prize'
                END;
  /* THE PAYOUT RECORD KEEPS ITS CLASS (2026-09-02). tournament_payouts.source is
     the CLASS of a payment ('structure', 'reconcile', 'late_reg_adjustment',
     'final_table_deal', ...) and every detector downstream filters on it:
     fn_tournament_guarantee_check and fn_tournament_double_paid_obligations
     whitelist it, fn_payout_guarantee_check blacklists the bounty classes. The
     engine calls this function with its own provenance ('engine.finishTournament'
     and friends), which the first build wrote straight into that column - so
     the moment the engine cut over, the guarantee check would have counted
     every engine-paid place as unpaid. Provenance stays on
     tournament_obligations.source; the payout row gets the class. */
  v_payout_source := CASE
    WHEN lower(COALESCE(p_source, '')) IN ('structure','reconcile','hu_shortfall','spin_backpay',
         'overlay_backpay','late_reg_adjustment','final_table_deal','bubble_protection',
         'satellite_remainder','clawback') THEN lower(p_source)
    WHEN v_kind = 'late_reg_adjustment' THEN 'late_reg_adjustment'
    WHEN v_row_kind IN ('final_table_deal','bubble_protection','satellite_remainder') THEN v_row_kind
    ELSE 'structure'
  END;
  v_desc := COALESCE(NULLIF(btrim(p_description), ''),
              CASE
                WHEN v_row_kind = 'place' THEN format('Tournament prize: position %s', v_place)
                WHEN v_row_kind = 'refund' THEN 'Tournament refund'
                ELSE format('Tournament %s', replace(v_row_kind, '_', ' '))
              END);

  PERFORM set_config('app.money_path', 'fn_settle_tournament_obligation', true);

  -- Guard against a key that was already spent while the obligation says otherwise:
  -- that means the obligation row was rebuilt without its payments, and paying
  -- again would be exactly the bug this function exists to end.
  IF EXISTS (SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key = v_key) THEN
    RAISE EXCEPTION 'fn_settle_tournament_obligation: key % already spent while obligation % shows paid %; refusing',
      v_key, v_ob.id, v_ob.amount_paid;
  END IF;

  v_credited := public.fn_credit_and_log(
    p_user_id, v_pay, v_key, v_category, v_desc, p_tournament_id,
    'PLAYER', NULL, NULL,
    CASE WHEN v_category = 'prize' THEN v_place ELSE NULL END,
    CASE WHEN v_category = 'prize' THEN v_payout_source ELSE NULL END);

  PERFORM set_config('app.money_path', '', true);

  IF NOT v_credited THEN
    -- fn_credit_and_log returns false only when the key was already spent or a
    -- guard inside it refused; either way no chips moved for THIS call.
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', 'credit_refused', 'obligation_id', v_ob.id, 'idempotency_key', v_key);
  END IF;

  PERFORM set_config('app.pnl_tournament_obligation_credit_key',v_key,true);
  UPDATE public.tournament_obligations
     SET amount_paid = amount_paid + v_pay,
         user_id     = COALESCE(user_id, p_user_id),
         source      = COALESCE(p_source, source),
         adjustment_id = COALESCE(adjustment_id, p_adjustment_id),
         updated_at  = now(),
         settled_at  = CASE WHEN amount_paid + v_pay >= amount_owed THEN now() ELSE settled_at END
   WHERE id = v_ob.id;
  PERFORM set_config('app.pnl_tournament_obligation_credit_key','',true);
  IF v_adj.id IS NOT NULL THEN
    UPDATE public.ca_manual_adjustments SET status = 'settled' WHERE id = v_adj.id;
  END IF;

  -- ok acknowledges this operation; it is not proof that the entire debt
  -- was paid. v_ob holds the pre-credit row, so include this call's v_pay.
  RETURN jsonb_build_object('ok', true, 'paid', v_pay, 'already_paid', v_ob.amount_paid,
    'amount_owed', v_ob.amount_owed, 'amount_paid', v_ob.amount_paid + v_pay,
    'remaining', GREATEST(0, v_ob.amount_owed - v_ob.amount_paid - v_pay),
    'fully_settled', v_ob.amount_paid + v_pay >= v_ob.amount_owed,
    'refused_reason', NULL, 'obligation_id', v_ob.id, 'idempotency_key', v_key);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.log_wallet_transaction(p_user_id uuid, p_wallet_type text, p_amount numeric, p_type text, p_category text, p_description text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_original_wallet uuid; v_bal NUMERIC; v_club uuid; v_entry boolean := false;
BEGIN
  /* ZERO-DRIFT (2026-08-31): club members' live balance is
     club_members.chip_balance; public.wallets has been frozen since
     2026-08-21, so reading it stamped a stale balance_after on every row. */
  IF p_wallet_type = 'PLAYER' THEN
    -- Use the debit's union-aware resolver and preferred ledger club. A host
    -- club balance is not the balance of the member wallet actually charged.
    IF p_type = 'debit'
       AND p_related_entity_id IS NOT NULL
       AND lower(COALESCE(p_category, '')) IN
         ('tournament_buyin', 'tournament_rebuy', 'rebuy', 'reentry', 'addon') THEN
      v_entry := true;
      v_club := public.fn_tournament_club_for_user(
        p_user_id,p_related_entity_id,
        NULLIF(current_setting('app.ledger_club_id',true),'')::uuid);
      IF v_club IS NULL THEN
        RAISE EXCEPTION 'Tournament entry receipt has no charged club wallet'
          USING ERRCODE='55000';
      END IF;
    ELSE
      v_club := public.fn_player_home_club(p_user_id, NULL);
    END IF;
    IF v_club IS NOT NULL THEN
      SELECT chip_balance INTO v_bal FROM club_members
       WHERE user_id = p_user_id AND club_id = v_club;
    END IF;
  END IF;
  IF v_entry AND v_bal IS NULL THEN
    RAISE EXCEPTION 'Tournament entry receipt cannot read its charged club wallet'
      USING ERRCODE='55000';
  END IF;
  IF v_bal IS NULL THEN
    SELECT balance INTO v_bal FROM wallets WHERE user_id = p_user_id AND wallet_type = p_wallet_type;
  END IF;
  INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description, table_id, hand_id, related_entity_id, balance_after, created_at)
  VALUES (p_user_id, p_wallet_type, p_amount, p_type, p_category, p_description, p_table_id, p_hand_id, p_related_entity_id, COALESCE(v_bal, 0), NOW()) RETURNING id INTO v_original_wallet;
  PERFORM set_config('app.pnl_tournament_wallet_tx',v_original_wallet::text,true);
END;
$function$
;

COMMIT;
