-- One durable cash-source work authority delegates the existing liability and
-- stats writers. Refusal is never success; retry cannot lose downstream work.
-- No historical repair, new payout writer, wallet transfer, or rate change.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_credit_agent_commissions_batch(jsonb)'::regprocedure))<>'0649a58a4a82bcc1f4835abf63093b43'
 OR md5(pg_get_functiondef('public.apply_rakeback_player_stats(uuid,uuid,uuid,integer,numeric)'::regprocedure))<>'7f2b71a539db1b9c5cf6dbf6a489d40e'
 THEN RAISE EXCEPTION 'cash batch or stats authority changed since review'; END IF;
 IF to_regprocedure('public.fn_accrue_cash_hand_commissions(uuid)') IS NULL
 OR to_regclass('public.accounting_period_recompute_requests') IS NULL THEN
 RAISE EXCEPTION 'canonical cash source and period queue dependencies required';END IF;
END $guard$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_credit_agent_commissions_batch','approved','Existing batch delegates cash records to the one durable source authority. Legacy callers retain separate failure counts; source receipts distinguish durable refusal from credit.'),
 ('fn_process_cash_accounting_source','approved','Calls existing whole-hand liability and idempotent stats writers, queues existing full-week calculation, then records one durable source outcome. Financial subtransaction rolls back on refusal; no payout or rate calculation.'),
 ('fn_retry_cash_accounting_sources','approved','Bounded retry delegates the same cash-source authority; no alternate money writer.')
 ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
CREATE TABLE public.accounting_cash_source_receipts(
 id uuid PRIMARY KEY,
 rake_record_id uuid NOT NULL REFERENCES public.rake_records(id),
 attempt bigint NOT NULL CHECK(attempt>0),
 earned_at timestamptz NOT NULL,
 source_fingerprint text NOT NULL,
 status text NOT NULL CHECK(status IN('accrued','blocked')),
 reason text,
 sqlstate text,
 error_detail text,
 scope jsonb NOT NULL,
 result jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(rake_record_id,attempt),
 CHECK((status='blocked')=(reason IS NOT NULL)),
 CHECK(scope->>'kind' IN('union','club','unknown'))
);
CREATE TABLE public.accounting_cash_source_work(
 rake_record_id uuid PRIMARY KEY REFERENCES public.rake_records(id),
 receipt_id uuid NOT NULL REFERENCES public.accounting_cash_source_receipts(id),
 source_fingerprint text NOT NULL,
 status text NOT NULL CHECK(status IN('accrued','blocked')),
 attempts bigint NOT NULL CHECK(attempts>0),
 next_attempt_at timestamptz NOT NULL
);
CREATE INDEX accounting_cash_source_work_retry ON public.accounting_cash_source_work(next_attempt_at,rake_record_id) WHERE status='blocked';
ALTER TABLE public.accounting_cash_source_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_cash_source_work ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_cash_source_receipts,public.accounting_cash_source_work FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_cash_source_receipts,public.accounting_cash_source_work TO service_role;
CREATE TRIGGER accounting_cash_source_receipts_immutable BEFORE UPDATE OR DELETE ON public.accounting_cash_source_receipts FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_source_receipts_no_truncate BEFORE TRUNCATE ON public.accounting_cash_source_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE FUNCTION public.fn_cash_source_refusal_scope(p_rake_record_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE r public.rake_records%ROWTYPE;b public.accounting_cash_bank_receipts%ROWTYPE;
 n int; historical_union uuid; cutoff timestamptz;
BEGIN
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id;
 SELECT * INTO b FROM public.accounting_cash_bank_receipts WHERE rake_record_id=r.id;
 -- A source's bank receipt is immutable. A real union deposit identifies its
 -- book even when a player's attribution or commercial terms are incomplete.
 IF b.union_id IS NOT NULL AND b.amount=r.rake_amount AND b.banked_at=r.created_at
  AND EXISTS(SELECT 1 FROM public.union_wallet_transactions t WHERE t.id=b.union_transaction_id
   AND t.union_id=b.union_id AND t.wallet='rake_wallet' AND t.direction='credit'
   AND t.tx_type='rake' AND t.amount=b.amount AND t.created_at=b.banked_at) THEN
  RETURN jsonb_build_object('kind','union','id',b.union_id,'proof','union_bank_receipt');
 END IF;
 IF b.union_id IS NULL AND b.club_id=r.club_id AND b.amount=r.rake_amount AND b.banked_at=r.created_at
  AND EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=b.club_ledger_id
   AND l.from_type='table_stack' AND l.to_type='chip_retirement' AND l.to_entity_id IS NULL AND l.club_id=b.club_id
   AND l.amount=b.amount AND l.category='burn' AND l.created_at=b.banked_at) THEN
  SELECT count(*),(array_agg((h.after_terms->>'union_id')::uuid))[1] INTO n,historical_union FROM (
   SELECT DISTINCT ON(entity_key) after_terms FROM public.accounting_agreement_history
    WHERE entity_type='union_clubs' AND club_id=b.club_id AND observed_at<=r.created_at
    ORDER BY entity_key,observed_at DESC,id DESC)h
   WHERE h.after_terms IS NOT NULL AND h.after_terms->>'club_id'=b.club_id::text;
  IF n=1 AND historical_union IS NOT NULL THEN
   RETURN jsonb_build_object('kind','union','id',historical_union,'proof','private_bank_and_observed_membership');
  END IF;
  SELECT starts_at INTO cutoff FROM public.accounting_cash_accrual_cutover WHERE singleton;
  -- After source cutover the installed observer covers all union membership
  -- transitions. Before it, absence of a historical row proves no absence.
  IF n=0 AND r.created_at>=cutoff THEN
   RETURN jsonb_build_object('kind','club','id',b.club_id,'proof','private_bank_after_history_cutover');
  END IF;
 END IF;
 RETURN jsonb_build_object('kind','unknown','id',NULL,'proof','coordinator_not_proven');
END $function$;

CREATE FUNCTION public.fn_process_cash_accounting_source(p_rake_record_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE r public.rake_records%ROWTYPE;w public.accounting_cash_source_work%ROWTYPE;
 receipt public.accounting_cash_source_receipts%ROWTYPE; fingerprint text;result jsonb;credits jsonb:='[]';
 status_value text:='accrued';reason_value text;state_value text;detail_value text;scope jsonb;
 player record;club record;week_start date;next_attempt bigint; applied boolean;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id;
 IF NOT FOUND OR COALESCE(r.is_tournament,false) OR r.tournament_id IS NOT NULL THEN
  RAISE EXCEPTION 'cash_source_record_required' USING ERRCODE='22023'; END IF;
 -- Share the existing hand authority. Nothing locks work rows before this.
 PERFORM pg_advisory_xact_lock(hashtextextended(CASE WHEN r.hand_id IS NULL THEN 'accounting_cash_source:'||r.id::text
  ELSE 'accounting_cash_hand:'||r.hand_id::text END,0));
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR SHARE;
 SELECT md5(jsonb_build_object('id',r.id,'hand',r.hand_id,'club',r.club_id,'rake',r.rake_amount,
  'earned_at',r.created_at,'metadata',r.metadata,'attributions',COALESCE(jsonb_agg(
   jsonb_build_array(a.id,a.hand_id,a.player_id,a.club_id,a.weighted_rake_credit) ORDER BY a.id),'[]'::jsonb))::text)
  INTO fingerprint FROM public.rake_attributions a WHERE a.rake_record_id=r.id;
 SELECT * INTO w FROM public.accounting_cash_source_work WHERE rake_record_id=r.id;
 IF w.status='accrued' AND w.source_fingerprint=fingerprint THEN
  SELECT * INTO receipt FROM public.accounting_cash_source_receipts WHERE id=w.receipt_id;
  RETURN receipt.result||jsonb_build_object('duplicate',true);
 END IF;
 next_attempt:=COALESCE(w.attempts,0)+1;
 BEGIN
  IF r.hand_id IS NULL OR NOT isfinite(r.created_at) OR r.rake_amount IS NULL OR r.rake_amount<=0
   OR r.rake_amount::text IN('NaN','Infinity','-Infinity') OR r.rake_amount<>round(r.rake_amount,2)
   OR (SELECT count(*) FROM public.rake_records WHERE hand_id=r.hand_id)<>1 THEN
   RAISE EXCEPTION 'cash_source_identity_or_amount_invalid' USING ERRCODE='23514'; END IF;
  result:=public.fn_accrue_cash_hand_commissions(r.hand_id);
  IF result->>'status'='legacy_unverified' AND result->>'recorded'='true' THEN
   status_value:='blocked';reason_value:='cash_source_legacy_unverified';state_value:='55000';
  ELSE
   IF result->>'status' IS DISTINCT FROM 'accrued' OR result->>'recorded' IS DISTINCT FROM 'true'
    OR result->>'source_version' IS DISTINCT FROM '2'
    OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches WHERE rake_record_id=r.id AND status='accrued') THEN
    RAISE EXCEPTION 'cash_source_accrual_receipt_invalid' USING ERRCODE='23514'; END IF;
   week_start:=(public.fn_union_week_start(r.created_at) AT TIME ZONE 'America/Los_Angeles')::date;
   FOR player IN SELECT * FROM public.accounting_cash_rake_sources WHERE rake_record_id=r.id ORDER BY club_id,player_id LOOP
    applied:=public.apply_rakeback_player_stats(r.id,player.player_id,player.club_id,1,player.rake_credit);
    IF NOT EXISTS(SELECT 1 FROM public.rakeback_stats_applied a WHERE a.rake_record_id=r.id AND a.user_id=player.player_id
      AND a.hands=1 AND a.rake=player.rake_credit) THEN
     RAISE EXCEPTION 'cash_source_player_stats_receipt_invalid' USING ERRCODE='23514'; END IF;
    credits:=credits||jsonb_build_array(jsonb_build_object('player_id',player.player_id,'club_id',player.club_id,
      'rake_credit',player.rake_credit,'period_start',week_start,'period_end',week_start+6));
   END LOOP;
   IF jsonb_array_length(credits)=0 THEN RAISE EXCEPTION 'cash_source_contributor_receipts_missing' USING ERRCODE='23514'; END IF;
   -- Queue the existing complete-week calculator; do not invent another
   -- calculator or depend on a later hand arriving to repair this source.
   FOR club IN SELECT DISTINCT club_id FROM public.accounting_cash_rake_sources WHERE rake_record_id=r.id ORDER BY club_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||club.club_id::text||':'||week_start::text,0));
    INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
     VALUES(club.club_id,week_start,week_start+6)
     ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL;
   END LOOP;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS reason_value=MESSAGE_TEXT,state_value=RETURNED_SQLSTATE,detail_value=PG_EXCEPTION_DETAIL;
  status_value:='blocked';credits:='[]';
 END;
 scope:=public.fn_cash_source_refusal_scope(r.id);
 receipt.id:=gen_random_uuid();
 result:=jsonb_build_object('receipt_version',3,'receipt_id',receipt.id,'rake_record_id',r.id,'hand_id',r.hand_id,
  'earned_at',r.created_at,'status',status_value,'recorded',true,'attempt',next_attempt,
  'source_fingerprint',fingerprint,'reason',reason_value,'sqlstate',state_value,'scope',scope,'credits',credits);
 INSERT INTO public.accounting_cash_source_receipts(id,rake_record_id,attempt,earned_at,source_fingerprint,status,reason,sqlstate,error_detail,scope,result)
  VALUES(receipt.id,r.id,next_attempt,r.created_at,fingerprint,status_value,reason_value,state_value,detail_value,scope,result);
 INSERT INTO public.accounting_cash_source_work(rake_record_id,receipt_id,source_fingerprint,status,attempts,next_attempt_at)
  VALUES(r.id,receipt.id,fingerprint,status_value,next_attempt,clock_timestamp()+make_interval(secs=>LEAST(3600,60*next_attempt)::int))
  ON CONFLICT(rake_record_id) DO UPDATE SET receipt_id=EXCLUDED.receipt_id,source_fingerprint=EXCLUDED.source_fingerprint,
   status=EXCLUDED.status,attempts=EXCLUDED.attempts,next_attempt_at=EXCLUDED.next_attempt_at;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_credit_agent_commissions_batch(p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='300s' AS $function$
DECLARE it jsonb;r jsonb;receipts jsonb:='[]';record_id uuid;v_ok int:=0;v_failed int:=0;v_blocked int:=0;first_error text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items)>2000 THEN
  RETURN jsonb_build_object('ok',0,'failed',0,'error','p_items must be a jsonb array of at most 2000 items'); END IF;
 FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  BEGIN
   IF it->>'source_type' IN('cash_rake_record','rake_settlement') THEN
    IF it->>'source_type'='cash_rake_record' THEN record_id:=(it->>'source_id')::uuid;
    ELSE
     SELECT id INTO STRICT record_id FROM public.rake_records WHERE hand_id=(it->>'source_id')::uuid;
     -- Keep the legacy caller's scope validation. A batched user cannot move
     -- one contributor's recorded earning into a different club.
     IF NOT EXISTS(SELECT 1 FROM public.rake_attributions WHERE rake_record_id=record_id
      AND player_id=(it->>'user_id')::uuid AND club_id=(it->>'club_id')::uuid
      AND weighted_rake_credit=(it->>'rake_credit')::numeric) THEN
      RAISE EXCEPTION 'cash_source_legacy_input_not_proven' USING ERRCODE='23514'; END IF;
    END IF;
    r:=public.fn_process_cash_accounting_source(record_id);receipts:=receipts||jsonb_build_array(r);
    IF r->>'status'='accrued' THEN v_ok:=v_ok+1;
    ELSE v_failed:=v_failed+1;v_blocked:=v_blocked+1;first_error:=COALESCE(first_error,r->>'reason'); END IF;
   ELSE
    PERFORM public.credit_agent_commission_from_rake((it->>'user_id')::uuid,(it->>'club_id')::uuid,
     COALESCE((it->>'rake_credit')::numeric,0),it->>'source_type',NULLIF(it->>'source_id','')::uuid,it->>'notes');
    v_ok:=v_ok+1;
   END IF;
  EXCEPTION WHEN OTHERS THEN v_failed:=v_failed+1;first_error:=COALESCE(first_error,SQLERRM);
  END;
 END LOOP;
 RETURN jsonb_build_object('receipt_version',3,'ok',v_ok,'failed',v_failed,'blocked',v_blocked,'first_error',first_error,'receipts',receipts);
END $function$;

CREATE FUNCTION public.fn_retry_cash_accounting_sources(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='300s' AS $function$
DECLARE w record;r jsonb;receipts jsonb:='[]';v_ok int:=0;v_blocked int:=0;v_failed int:=0;first_error text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>200 THEN RAISE EXCEPTION 'invalid_cash_retry_limit' USING ERRCODE='22023'; END IF;
 -- Do not lock work rows here: all callers acquire the original hand lock
 -- first. SKIP LOCKED on work would invert that order against direct callers.
 FOR w IN SELECT rake_record_id FROM public.accounting_cash_source_work WHERE status='blocked'
  AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,rake_record_id LIMIT p_limit LOOP
  BEGIN
   r:=public.fn_process_cash_accounting_source(w.rake_record_id);receipts:=receipts||jsonb_build_array(r);
   IF r->>'status'='accrued' THEN v_ok:=v_ok+1; ELSE v_blocked:=v_blocked+1; END IF;
  EXCEPTION WHEN OTHERS THEN v_failed:=v_failed+1;first_error:=COALESCE(first_error,SQLERRM);END;
 END LOOP;
 RETURN jsonb_build_object('receipt_version',3,'ok',v_ok,'blocked',v_blocked,'failed',v_failed+v_blocked,
  'first_error',first_error,'receipts',receipts);
END $function$;

CREATE FUNCTION public.fn_cash_source_refusals_for_period(p_union_id uuid,p_club_id uuid,p_from timestamptz,p_to timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE problems jsonb;
BEGIN
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from)
  OR NOT isfinite(p_to) OR p_to<=p_from THEN RAISE EXCEPTION 'invalid_cash_refusal_scope' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('rake_record_id',r.rake_record_id,'reason',r.reason,'scope',r.scope)
  ORDER BY r.rake_record_id),'[]'::jsonb) INTO problems
 FROM public.accounting_cash_source_work w JOIN public.accounting_cash_source_receipts r ON r.id=w.receipt_id
 WHERE w.status='blocked' AND (NOT isfinite(r.earned_at) OR(r.earned_at>=p_from AND r.earned_at<p_to))
 AND(r.scope->>'kind'='unknown' OR(r.scope->>'kind'='union' AND r.scope->>'id'=p_union_id::text)
  OR(r.scope->>'kind'='club' AND r.scope->>'id'=p_club_id::text));
 RETURN jsonb_build_object('status',CASE WHEN jsonb_array_length(problems)=0 THEN 'ready' ELSE 'blocked' END,
  'count',jsonb_array_length(problems),'sources',problems);
END $function$;

REVOKE ALL ON FUNCTION public.fn_cash_source_refusal_scope(uuid),public.fn_process_cash_accounting_source(uuid),public.fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz),public.fn_retry_cash_accounting_sources(integer),public.fn_credit_agent_commissions_batch(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb),public.fn_retry_cash_accounting_sources(integer) TO service_role;
COMMIT;
