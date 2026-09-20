-- A continuation is possible only after the same canonical net plan proves
-- the original fee agreements. This does not create those missing facts.
CREATE TABLE public.accounting_tournament_fee_custody_resolutions (
 tournament_id uuid PRIMARY KEY,
 obligation_id uuid NOT NULL UNIQUE,
 amount numeric NOT NULL CHECK(amount>0 AND amount=round(amount,2)),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[0-9a-f]{32}$'),
 original_plan jsonb NOT NULL CHECK(jsonb_typeof(original_plan)='object'),
 resolved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 transaction_id bigint NOT NULL DEFAULT txid_current()
);
ALTER TABLE public.accounting_tournament_fee_custody_resolutions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_tournament_fee_custody_resolutions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER legacy_fee_resolution_is_append_only BEFORE UPDATE OR DELETE
 ON public.accounting_tournament_fee_custody_resolutions FOR EACH ROW EXECUTE FUNCTION public.fn_ca_legacy_fee_custody_is_append_only();

CREATE TRIGGER legacy_fee_resolution_refuses_truncate BEFORE TRUNCATE
 ON public.accounting_tournament_fee_custody_resolutions FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_legacy_fee_custody_is_append_only();

-- A completed event cannot generally acquire new fee sources. This immutable
-- same-transaction admission binds only the original retained custody before
-- the existing recorded-evidence producer runs. Its deferred check refuses a
-- commit unless that same transaction also completes canonical recognition.
CREATE TABLE public.accounting_tournament_fee_custody_capture_admissions (
 tournament_id uuid PRIMARY KEY,
 obligation_id uuid NOT NULL UNIQUE,
 source_fingerprint text NOT NULL,
 amount numeric NOT NULL,
 transaction_id bigint NOT NULL DEFAULT txid_current()
);
ALTER TABLE public.accounting_tournament_fee_custody_capture_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_tournament_fee_custody_capture_admissions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER legacy_fee_capture_admission_is_append_only BEFORE UPDATE OR DELETE
 ON public.accounting_tournament_fee_custody_capture_admissions FOR EACH ROW EXECUTE FUNCTION public.fn_ca_legacy_fee_custody_is_append_only();
CREATE TRIGGER legacy_fee_capture_admission_refuses_truncate BEFORE TRUNCATE
 ON public.accounting_tournament_fee_custody_capture_admissions FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_legacy_fee_custody_is_append_only();

CREATE FUNCTION public.fn_ca_legacy_fee_capture_admitted(p_tournament_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $fn$
DECLARE receipt jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_capture_admissions a
  JOIN public.accounting_tournament_fee_custody_obligations o ON o.tournament_id=a.tournament_id AND o.id=a.obligation_id
  WHERE a.tournament_id=p_tournament_id AND a.transaction_id=txid_current()
   AND a.source_fingerprint=o.source_fingerprint AND a.amount=o.amount)
 THEN RETURN false; END IF;
 receipt:=public.fn_ca_tournament_terminal_receipt(p_tournament_id,NULL);
 RETURN receipt->>'receipt_version'='3' AND receipt->>'accounting_state'='fee_custody_unresolved'
  AND receipt->>'accounting_complete'='false' AND receipt->>'player_result'='final';
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_capture_admitted(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_begin_legacy_fee_resolution(p_tournament_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE o public.accounting_tournament_fee_custody_obligations%ROWTYPE;plan jsonb;raw record;
BEGIN
 SELECT * INTO o FROM public.accounting_tournament_fee_custody_obligations WHERE tournament_id=p_tournament_id;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions WHERE tournament_id=p_tournament_id) THEN RETURN; END IF;
 PERFORM public.fn_ca_lock_settlement_lane_global();
 PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id FOR NO KEY UPDATE;
 PERFORM 1 FROM public.tournament_escrow WHERE tournament_id=p_tournament_id FOR UPDATE;
 PERFORM public.fn_ca_tournament_terminal_receipt(p_tournament_id,NULL);
 INSERT INTO public.accounting_tournament_fee_custody_capture_admissions
  (tournament_id,obligation_id,source_fingerprint,amount)
 VALUES(p_tournament_id,o.id,o.source_fingerprint,o.amount);
 FOR raw IN SELECT r.id FROM public.rake_records r WHERE r.tournament_id=p_tournament_id
  AND r.is_tournament AND r.rake_amount>0
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id)
  ORDER BY r.id LOOP
  PERFORM public.fn_ca_capture_tournament_fee_from_recorded_evidence(raw.id);
 END LOOP;
 plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);
 IF plan->>'status' IS DISTINCT FROM 'proven' OR plan->>'source_fingerprint' IS DISTINCT FROM o.source_fingerprint
  OR (plan->>'net_fee')::numeric IS DISTINCT FROM o.amount
  OR jsonb_array_length(plan->'active_source_ids')<1
 THEN RAISE EXCEPTION 'original fee continuation requires exact canonical attribution proof' USING ERRCODE='P0404'; END IF;
 INSERT INTO public.accounting_tournament_fee_custody_resolutions
  (tournament_id,obligation_id,amount,source_fingerprint,original_plan)
 VALUES(p_tournament_id,o.id,o.amount,o.source_fingerprint,plan);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_begin_legacy_fee_resolution(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_legacy_fee_resolution_write_is_exact(p_table text,p_operation text,p_old jsonb,p_new jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $fn$
DECLARE t uuid:=NULLIF(p_new->>'tournament_id','')::uuid;r public.accounting_tournament_fee_custody_resolutions%ROWTYPE;
 o public.accounting_tournament_fee_custody_obligations%ROWTYPE;h public.tournament_terminal_settlements%ROWTYPE;
BEGIN
 IF p_operation='DELETE' OR t IS NULL THEN RETURN false; END IF;
 SELECT * INTO r FROM public.accounting_tournament_fee_custody_resolutions WHERE tournament_id=t AND transaction_id=txid_current();
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO o FROM public.accounting_tournament_fee_custody_obligations WHERE id=r.obligation_id AND tournament_id=t;
 SELECT * INTO h FROM public.tournament_terminal_settlements WHERE tournament_id=t AND accounting_state='fee_custody_unresolved' AND receipt_version=3;
 IF o.id IS NULL OR h.tournament_id IS NULL OR r.amount IS DISTINCT FROM o.amount
  OR r.source_fingerprint IS DISTINCT FROM o.source_fingerprint
  OR r.original_plan IS DISTINCT FROM public.fn_accounting_tournament_fee_net_plan(t)
 THEN RETURN false; END IF;
 IF p_table='tournament_rake_settlements' THEN
  IF p_operation='INSERT' THEN
   RETURN (p_new->>'amount')::numeric=0 AND p_new->>'destination'='pending'
    AND p_new->>'settled_at' IS NULL AND p_new->>'attributed_at' IS NULL
    AND p_new->>'terminal_closed_at' IS NULL;
  END IF;
  RETURN p_operation='UPDATE' AND p_old->>'terminal_closed_at' IS NULL
   AND (p_old-ARRAY['amount','union_id','destination','settled_at','attributed_at','attributed_users','attribution_error'])
    IS NOT DISTINCT FROM (p_new-ARRAY['amount','union_id','destination','settled_at','attributed_at','attributed_users','attribution_error'])
   AND p_old->>'destination'='pending' AND (p_old->>'amount')::numeric=0
   AND (p_new->>'amount')::numeric=r.amount
   AND (p_new->>'settled_at')::timestamptz=r.resolved_at
   AND (p_new->>'attributed_at')::timestamptz=r.resolved_at
   AND (p_new->>'attributed_users')::integer>0
   AND p_new->>'attribution_error' IS NULL
   AND EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions q WHERE q.tournament_id=t
    AND q.status='recognized' AND q.net_rake=r.amount AND q.recognized_at=r.resolved_at
    AND q.source_fingerprint=r.source_fingerprint);
 ELSIF p_table='chip_ledger' THEN
  RETURN p_operation='INSERT' AND p_new->>'from_type'='prize_liability'
   AND p_new->>'from_entity_id'=t::text AND p_new->>'to_type'='chip_retirement'
   AND p_new->>'to_entity_id' IS NULL AND p_new->>'category'='burn'
   AND (p_new->>'amount')::numeric=r.amount AND r.original_plan->>'union_id' IS NULL
   AND p_new->>'description'='Standalone tournament fee retired (fn_settle_tournament_rake)';
 ELSIF p_table='tournament_escrow' THEN
  RETURN p_operation='UPDATE' AND (p_old->>'terminal_closed_at')::timestamptz=h.completed_at
   AND (p_old-ARRAY['fee_out','fee_balance','updated_at']) IS NOT DISTINCT FROM
       (p_new-ARRAY['fee_out','fee_balance','updated_at'])
   AND (p_old->>'prize_balance')::numeric=0 AND (p_old->>'bounty_balance')::numeric=0
   AND EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions q WHERE q.tournament_id=t
    AND q.status='recognized' AND q.net_rake=r.amount AND q.recognized_at=r.resolved_at
    AND q.source_fingerprint=r.source_fingerprint)
   AND (((p_old->>'fee_out')::numeric=(o.escrow_snapshot->>'fee_out')::numeric
      AND (p_new->>'fee_out')::numeric=(p_old->>'fee_out')::numeric+r.amount
      AND (p_old->>'fee_balance')::numeric=r.amount AND (p_new->>'fee_balance')::numeric=r.amount)
    OR ((p_old->>'fee_out')::numeric=(o.escrow_snapshot->>'fee_out')::numeric+r.amount
      AND (p_new->>'fee_out')::numeric=(p_old->>'fee_out')::numeric
      AND (p_old->>'fee_balance')::numeric=r.amount AND (p_new->>'fee_balance')::numeric=0));
 END IF;
 RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_resolution_write_is_exact(text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_legacy_fee_resolution_requires_recognition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE receipt jsonb;h public.tournament_terminal_settlements%ROWTYPE;
BEGIN
 receipt:=public.fn_accounting_tournament_terminal_fee_receipt(NEW.tournament_id);
 SELECT * INTO h FROM public.tournament_terminal_settlements WHERE tournament_id=NEW.tournament_id;
 IF receipt->>'status' IS DISTINCT FROM 'recognized'
  OR receipt->>'source_fingerprint' IS DISTINCT FROM NEW.source_fingerprint
  OR (receipt->>'bank_amount')::numeric IS DISTINCT FROM NEW.amount
  OR (receipt->>'banked_at')::timestamptz IS DISTINCT FROM NEW.resolved_at
  OR NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements s WHERE s.tournament_id=NEW.tournament_id
   AND s.amount=NEW.amount AND s.settled_at=NEW.resolved_at AND s.attributed_at=NEW.resolved_at
   AND s.attributed_users>0 AND s.attribution_error IS NULL AND s.terminal_closed_at=h.completed_at)
  OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=NEW.tournament_id
   AND e.prize_balance=0 AND e.bounty_balance=0 AND e.fee_balance=0)
 THEN RAISE EXCEPTION 'fee continuation cannot commit without exact original attribution and bank proof' USING ERRCODE='P0404'; END IF;
 PERFORM public.fn_ca_tournament_terminal_receipt(NEW.tournament_id,NULL);
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_resolution_requires_recognition() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER legacy_fee_resolution_requires_recognition AFTER INSERT
 ON public.accounting_tournament_fee_custody_resolutions DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_legacy_fee_resolution_requires_recognition();

CREATE FUNCTION public.fn_ca_legacy_fee_capture_requires_resolution()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions r
  WHERE r.tournament_id=NEW.tournament_id AND r.obligation_id=NEW.obligation_id
   AND r.source_fingerprint=NEW.source_fingerprint AND r.amount=NEW.amount
   AND r.transaction_id=NEW.transaction_id AND r.transaction_id=txid_current())
 THEN RAISE EXCEPTION 'original fee capture cannot commit without its same-transaction resolution' USING ERRCODE='P0404'; END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_capture_requires_resolution() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER legacy_fee_capture_requires_resolution AFTER INSERT
 ON public.accounting_tournament_fee_custody_capture_admissions DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_legacy_fee_capture_requires_resolution();
