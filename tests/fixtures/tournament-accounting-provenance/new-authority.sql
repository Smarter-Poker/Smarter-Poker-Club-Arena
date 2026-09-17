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
