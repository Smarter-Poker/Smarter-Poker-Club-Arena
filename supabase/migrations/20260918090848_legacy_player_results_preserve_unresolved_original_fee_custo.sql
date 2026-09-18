-- Player finality is distinct from fee attribution. These eight original fee
-- sources predate the canonical capture cutover. The original five hold365;
-- three separately named PKOs hold324. All689 chips remain in the
-- existing escrow until original agreements can be proved. No payout, current
-- agreement, bank credit or historical record is fabricated by this migration.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';

CREATE TABLE public.accounting_tournament_fee_custody_obligations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tournament_id uuid NOT NULL UNIQUE,
 source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{32}$'),
 amount numeric NOT NULL CHECK (amount>0 AND amount=round(amount,2) AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
 reason text NOT NULL CHECK (reason IN ('tournament_fee_sources_require_reconciliation','accounting_terms_not_observed','accounting_terms_not_active','tournament_fee_not_captured_by_original_producer')),
 original_fees jsonb NOT NULL CHECK (jsonb_typeof(original_fees)='array'),
 original_funding jsonb NOT NULL CHECK (jsonb_typeof(original_funding)='array'),
 original_scope jsonb NOT NULL CHECK (jsonb_typeof(original_scope)='object'),
 escrow_snapshot jsonb NOT NULL CHECK (jsonb_typeof(escrow_snapshot)='object'),
 held_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 transaction_id bigint NOT NULL DEFAULT txid_current()
);
ALTER TABLE public.accounting_tournament_fee_custody_obligations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_tournament_fee_custody_obligations FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_legacy_fee_custody_cohort(p_tournament_id uuid)
RETURNS TABLE(amount numeric,source_fingerprint text,source_count integer)
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=public AS $fn$
 SELECT c.amount,c.source_fingerprint,c.source_count FROM (VALUES
 ('2d2319d4-09e4-4921-85f3-09832ca7f9da'::uuid,54::numeric,'94462de304de8ab16ff492cadf13d229',54),
 ('7834a033-8bf0-4a6b-bccf-9f4f6e78a9b9'::uuid,120::numeric,'57840c57d89643def8db903c4b19b487',80),
 ('80443725-b71c-4fc6-bc09-ceaf650809b3'::uuid,54::numeric,'bae6c0de665f87d378bda4249963b51b',54),
 ('b1fdf860-2fdd-40da-8fff-ef37e650ddc8'::uuid,120::numeric,'70dd50a8c0fc28b2ff5d4b53de2f56d1',80),
 ('f370585d-40ea-4085-bb8f-c7e8c74f3fb4'::uuid,17::numeric,'f67bf12ee0b00c954b6f8403de9718fe',34),
 ('1ffbd637-9241-4957-902f-3a75e09892c0'::uuid,127.50::numeric,'53fd19518004de9991312c0aaa749705',85),
 ('8fc76450-534a-4877-97b5-8f784a3d5daa'::uuid,127.50::numeric,'87fd65baf92f74a1de5c85ed09844c62',85),
 ('2421c66f-6f02-40a2-8414-23379802ce23'::uuid,69::numeric,'0dd99b682fed61573e47a2e0f8e57ab8',46)
 ) c(tournament_id,amount,source_fingerprint,source_count) WHERE c.tournament_id=p_tournament_id
$fn$;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_custody_cohort(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_tournament_fee_custody_receipt(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $fn$
DECLARE o public.accounting_tournament_fee_custody_obligations%ROWTYPE;
 e public.tournament_escrow%ROWTYPE;c record;fp text;net numeric;n integer;fees jsonb;resolution jsonb;resolved boolean:=false;funding jsonb;scope jsonb;
BEGIN
 SELECT * INTO o FROM public.accounting_tournament_fee_custody_obligations WHERE tournament_id=p_tournament_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO c FROM public.fn_ca_legacy_fee_custody_cohort(p_tournament_id);
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions x WHERE x.tournament_id=p_tournament_id) THEN
  IF NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions x WHERE x.tournament_id=p_tournament_id AND x.status='recognized') THEN
   RAISE EXCEPTION 'fee custody resolution has no canonical recognition' USING ERRCODE='P0404'; END IF;
  resolution:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  IF NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions x
   WHERE x.tournament_id=p_tournament_id AND x.obligation_id=o.id AND x.amount=o.amount
    AND x.source_fingerprint=o.source_fingerprint AND (resolution->>'bank_amount')::numeric=x.amount
    AND (resolution->>'banked_at')::timestamptz=x.resolved_at AND resolution->>'status'='recognized') THEN
   RAISE EXCEPTION 'fee custody resolution has no exact original bank proof' USING ERRCODE='P0404'; END IF;
  resolved:=true;
 END IF;
 SELECT md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY r.id),'')),
  COALESCE(sum(r.rake_amount),0),count(*),jsonb_agg(to_jsonb(r)-'terminal_closed_at' ORDER BY r.id)
 INTO fp,net,n,fees FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
 SELECT * INTO e FROM public.tournament_escrow WHERE tournament_id=p_tournament_id;
 SELECT COALESCE(jsonb_agg(to_jsonb(x)-'terminal_closed_at' ORDER BY x.id),'[]'::jsonb) INTO funding
  FROM public.tournament_refund_entitlements x WHERE x.tournament_id=p_tournament_id;
 SELECT jsonb_build_object('club_id',t.club_id,'union_id',t.union_id,'is_private',t.is_private,'tournament_type',t.tournament_type)
  INTO scope FROM public.tournaments t WHERE t.id=p_tournament_id;
 IF c.amount IS NULL OR o.amount IS DISTINCT FROM c.amount OR net IS DISTINCT FROM c.amount
  OR fp IS DISTINCT FROM c.source_fingerprint OR fp IS DISTINCT FROM o.source_fingerprint
  OR n IS DISTINCT FROM c.source_count OR fees IS DISTINCT FROM o.original_fees
  OR funding IS DISTINCT FROM o.original_funding OR scope IS DISTINCT FROM o.original_scope
  OR e.tournament_id IS NULL OR e.prize_balance IS DISTINCT FROM 0::numeric
  OR e.bounty_balance IS DISTINCT FROM 0::numeric OR e.fee_balance IS DISTINCT FROM (CASE WHEN resolved THEN 0::numeric ELSE o.amount END)
  OR e.closed_at IS NOT NULL
  OR (to_jsonb(e)-ARRAY['terminal_closed_at','updated_at','fee_out','fee_balance']) IS DISTINCT FROM
     (o.escrow_snapshot-ARRAY['terminal_closed_at','updated_at','fee_out','fee_balance'])
  OR e.fee_out IS DISTINCT FROM ((o.escrow_snapshot->>'fee_out')::numeric+CASE WHEN resolved THEN o.amount ELSE 0 END)
  OR (NOT resolved AND (EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=p_tournament_id)
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=p_tournament_id)
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources WHERE tournament_id=p_tournament_id)))
 THEN RAISE EXCEPTION 'legacy fee custody no longer matches original conserved source' USING ERRCODE='P0404'; END IF;
 RETURN jsonb_build_object('accounting_version',3,'tournament_id',p_tournament_id,
  'status','fee_custody_unresolved','player_result','final','payable',false,'accounting_complete',resolved,
  'resolution',resolution,'current_held_amount',CASE WHEN resolved THEN 0 ELSE o.amount END,
  'obligation_id',o.id,'source_fingerprint',o.source_fingerprint,'source_count',n,
  'held_amount',o.amount,'held_at',o.held_at,'reason',o.reason,'custody_store','tournament_escrow',
  'recognized_source_count',0,'bank_amount',0,'banked_at',NULL,'bank_receipt_id',NULL);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_fee_custody_receipt(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_hold_legacy_tournament_fee(p_tournament_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE t public.tournaments%ROWTYPE;e public.tournament_escrow%ROWTYPE;c record;fp text;net numeric;n integer;fees jsonb;funding jsonb;reason text;
BEGIN
 PERFORM public.fn_ca_lock_settlement_lane_global();
 SELECT * INTO t FROM public.tournaments WHERE id=p_tournament_id FOR NO KEY UPDATE;
 SELECT * INTO c FROM public.fn_ca_legacy_fee_custody_cohort(p_tournament_id);
 SELECT * INTO e FROM public.tournament_escrow WHERE tournament_id=p_tournament_id FOR UPDATE;
 IF c.amount IS NULL OR t.id IS NULL OR upper(t.status) <> 'COMPLETING'
  OR t.satellite_target_id IS NOT NULL OR t.satellite_target IS NOT NULL
  OR lower(COALESCE(t.variant,'')) IN ('satellite','spin')
  OR public.fn_poker_diamond_tournament(p_tournament_id)
  OR e.tournament_id IS NULL OR e.prize_balance IS DISTINCT FROM 0::numeric
  OR e.bounty_balance IS DISTINCT FROM 0::numeric OR e.fee_balance IS DISTINCT FROM c.amount
  OR e.closed_at IS NOT NULL OR e.terminal_closed_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament_id)
  OR EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=p_tournament_id)
  OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=p_tournament_id)
 THEN RAISE EXCEPTION 'legacy fee custody requires exact unpaid named source and completed player banks' USING ERRCODE='P0404'; END IF;
 SELECT md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY r.id),'')),
  COALESCE(sum(r.rake_amount),0),count(*),jsonb_agg(to_jsonb(r)-'terminal_closed_at' ORDER BY r.id)
 INTO fp,net,n,fees FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
 IF fp IS DISTINCT FROM c.source_fingerprint OR net IS DISTINCT FROM c.amount OR n IS DISTINCT FROM c.source_count
  OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament
    AND (r.created_at >= '2026-09-17T18:24:02.831517Z'::timestamptz OR r.terminal_closed_at IS NOT NULL))
 THEN RAISE EXCEPTION 'legacy fee custody original source identity changed' USING ERRCODE='P0404'; END IF;
 -- Reclassify only with the original authoritative reader. A caller's error
 -- string cannot turn a corrupt amount, valid fee or unrelated exception into custody.
 BEGIN
  PERFORM public.fn_accounting_tournament_fee_net_plan(p_tournament_id);
 EXCEPTION WHEN SQLSTATE '55000' THEN reason:=SQLERRM; END;
 IF reason IS NULL OR reason IS DISTINCT FROM p_reason OR reason NOT IN
  ('tournament_fee_sources_require_reconciliation','accounting_terms_not_observed','accounting_terms_not_active','tournament_fee_not_captured_by_original_producer')
 THEN RAISE EXCEPTION 'legacy fee custody requires the original missing attribution refusal' USING ERRCODE='P0404'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(x)-'terminal_closed_at' ORDER BY x.id),'[]'::jsonb) INTO funding
  FROM public.tournament_refund_entitlements x WHERE x.tournament_id=p_tournament_id;
 INSERT INTO public.accounting_tournament_fee_custody_obligations
  (tournament_id,source_fingerprint,amount,reason,original_fees,original_funding,original_scope,escrow_snapshot)
 VALUES(p_tournament_id,fp,net,reason,fees,funding,
  jsonb_build_object('club_id',t.club_id,'union_id',t.union_id,'is_private',t.is_private,'tournament_type',t.tournament_type),to_jsonb(e));
 RETURN public.fn_ca_tournament_fee_custody_receipt(p_tournament_id);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_hold_legacy_tournament_fee(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_legacy_fee_custody_is_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
BEGIN RAISE EXCEPTION 'original fee custody obligations are append-only' USING ERRCODE='55000'; END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_custody_is_append_only() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER legacy_fee_custody_is_append_only BEFORE UPDATE OR DELETE
 ON public.accounting_tournament_fee_custody_obligations FOR EACH ROW EXECUTE FUNCTION public.fn_ca_legacy_fee_custody_is_append_only();

CREATE TRIGGER legacy_fee_custody_refuses_truncate BEFORE TRUNCATE
 ON public.accounting_tournament_fee_custody_obligations FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_legacy_fee_custody_is_append_only();

CREATE FUNCTION public.fn_ca_legacy_fee_custody_requires_terminal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements h
  WHERE h.tournament_id=NEW.tournament_id AND h.accounting_state='fee_custody_unresolved'
   AND h.receipt_version=3 AND h.rake_amount=NEW.amount AND h.rake_settled_at IS NULL
   AND h.rake_attributed_at IS NULL AND h.escrow_closed_at IS NULL)
 THEN RAISE EXCEPTION 'fee custody cannot commit without its exact player terminal receipt' USING ERRCODE='P0404'; END IF;
 PERFORM public.fn_ca_tournament_terminal_receipt(NEW.tournament_id,NULL);
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_custody_requires_terminal() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER legacy_fee_custody_requires_terminal AFTER INSERT
 ON public.accounting_tournament_fee_custody_obligations DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_legacy_fee_custody_requires_terminal();

ALTER TABLE public.tournament_terminal_settlements
 ALTER COLUMN rake_settled_at DROP NOT NULL,
 ALTER COLUMN escrow_closed_at DROP NOT NULL,
 ALTER COLUMN escrow_close_note DROP NOT NULL,
 DROP CONSTRAINT tournament_terminal_settlements_accounting_state_check,
 DROP CONSTRAINT terminal_receipt_version_matches_accounting_state,
 DROP CONSTRAINT terminal_rake_attribution_matches_accounting_state,
 ADD CONSTRAINT tournament_terminal_settlements_accounting_state_check CHECK(accounting_state IN
  ('legacy','recognized','cancelled','banked_accrual_deferred','fee_custody_unresolved')),
 ADD CONSTRAINT terminal_receipt_version_matches_accounting_state CHECK(receipt_version=CASE
  WHEN accounting_state='legacy' THEN 1 WHEN accounting_state='fee_custody_unresolved' THEN 3 ELSE 2 END),
 ADD CONSTRAINT terminal_rake_attribution_matches_accounting_state CHECK(
  (accounting_state IN('banked_accrual_deferred','fee_custody_unresolved') AND rake_attributed_at IS NULL AND rake_attributed_users=0)
  OR(accounting_state NOT IN('banked_accrual_deferred','fee_custody_unresolved') AND rake_attributed_at IS NOT NULL)),
 ADD CONSTRAINT terminal_fee_custody_has_no_banked_timestamp CHECK(
  (accounting_state='fee_custody_unresolved' AND rake_settled_at IS NULL AND escrow_closed_at IS NULL
   AND escrow_close_note IS NULL AND rake_destination='tournament_escrow' AND rake_amount>0)
  OR(accounting_state<>'fee_custody_unresolved' AND rake_settled_at IS NOT NULL
   AND escrow_closed_at IS NOT NULL AND escrow_close_note IS NOT NULL));

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

DO $patch$
DECLARE source text;
BEGIN
 SELECT pg_get_functiondef('public.fn_accounting_tournament_terminal_fee_receipt(uuid)'::regprocedure) INTO source;
 IF md5(source)<>'6e446f6d6d19ec8b28b31d124a8c6ac3' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_accounting_tournament_terminal_fee_receipt(uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_accounting_tournament_terminal_fee_receipt(uuid)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'fn_accounting_tournament_terminal_fee_receipt preimage changed' USING ERRCODE='55000'; END IF;
 source:=replace(source,$old0$IF NOT FOUND THEN RETURN NULL; END IF;$old0$,$new0$IF NOT FOUND THEN RETURN public.fn_ca_tournament_fee_custody_receipt(p_tournament_id); END IF;$new0$);
 EXECUTE source;
END $patch$;

DO $patch$
DECLARE source text;
BEGIN
 SELECT pg_get_functiondef('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'::regprocedure) INTO source;
 IF md5(source)<>'6a45fe9bf30c94f9366ec88f0863087e' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'fn_complete_tournament_terminal_pre_seat_guard preimage changed' USING ERRCODE='55000'; END IF;
 source:=replace(source,$old0$  v_accounting jsonb; v_deferred boolean := false;$old0$,$new0$  v_accounting jsonb; v_deferred boolean := false;
  v_custody boolean:=false;v_fee_error text;v_fee_reason text;$new0$);
 source:=replace(source,$old1$  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id,'engine.fn_complete_tournament_terminal');
  IF COALESCE((v_rake_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament % rake authority refused: %',
      p_tournament_id,v_rake_result USING ERRCODE = 'P0404';
  END IF;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  SELECT rs.* INTO v_rake FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id FOR UPDATE;
  IF v_rake.tournament_id IS NULL
     OR v_rake.amount IS DISTINCT FROM v_rake_total
     OR v_rake.settled_at IS NULL OR (v_rake.attributed_at IS NULL AND NOT v_deferred)
     OR v_rake.attributed_users IS NULL OR v_rake.attributed_users < 0
     OR (v_rake.attribution_error IS NOT NULL AND NOT v_deferred)
     OR lower(v_rake.destination) IN ('pending','')
     OR (v_rake.amount > 0 AND v_t.club_id IS NOT NULL AND NOT v_diamond AND NOT v_deferred
         AND (v_rake.attributed_users < 1
           OR (v_rake.destination NOT LIKE 'union:%'
               AND v_rake.destination NOT LIKE 'chip_retirement:%'))) THEN
    RAISE EXCEPTION 'tournament % rake attribution did not complete: %',
      p_tournament_id,v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'tournament % did not close all three escrow banks',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_completed_at := COALESCE(v_t.ended_at,transaction_timestamp());
  -- Persist the exact-zero proof before lifecycle. The historical after-status
  -- observer was detached above; this authority is now the only owner of the
  -- terminal escrow marker.
  UPDATE public.tournament_escrow
     SET closed_at = v_completed_at,
         close_note = 'terminal receipt: exact zero',
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND prize_balance = 0 AND bounty_balance = 0 AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its exact zero escrow close',
      p_tournament_id USING ERRCODE = '40001';
  END IF;
$old1$,$new1$  BEGIN
    v_rake_result := public.fn_settle_tournament_rake(
      p_tournament_id,'engine.fn_complete_tournament_terminal');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_fee_error:=SQLERRM;
    v_fee_reason:=substring(v_fee_error FROM length('tournament '||p_tournament_id::text||' rake attribution incomplete: ')+1);
    IF v_fee_error IS DISTINCT FROM 'tournament '||p_tournament_id::text||' rake attribution incomplete: '||v_fee_reason
      OR v_fee_reason NOT IN ('tournament_fee_sources_require_reconciliation','accounting_terms_not_observed','accounting_terms_not_active','tournament_fee_not_captured_by_original_producer') THEN RAISE; END IF;
    -- The failed fee subtransaction has rolled back its provisional claim.
    -- The exact bounded proof retains fees; all existing player checks above remain.
    v_accounting:=public.fn_ca_hold_legacy_tournament_fee(p_tournament_id,v_fee_reason);
    v_custody:=true;
  END;
  IF NOT v_custody AND COALESCE((v_rake_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament % rake authority refused: %',p_tournament_id,v_rake_result USING ERRCODE='P0404';
  END IF;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  v_completed_at := COALESCE(v_t.ended_at,transaction_timestamp());
  IF v_custody THEN
    SELECT v_rake_total AS amount,'tournament_escrow'::text AS destination,
     NULL::timestamptz AS settled_at,NULL::timestamptz AS attributed_at,0 AS attributed_users INTO v_rake;
  ELSE
  SELECT rs.* INTO v_rake FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id FOR UPDATE;
  IF v_rake.tournament_id IS NULL
     OR v_rake.amount IS DISTINCT FROM v_rake_total
     OR v_rake.settled_at IS NULL OR (v_rake.attributed_at IS NULL AND NOT v_deferred)
     OR v_rake.attributed_users IS NULL OR v_rake.attributed_users < 0
     OR (v_rake.attribution_error IS NOT NULL AND NOT v_deferred)
     OR lower(v_rake.destination) IN ('pending','')
     OR (v_rake.amount > 0 AND v_t.club_id IS NOT NULL AND NOT v_diamond AND NOT v_deferred
         AND (v_rake.attributed_users < 1
           OR (v_rake.destination NOT LIKE 'union:%'
               AND v_rake.destination NOT LIKE 'chip_retirement:%'))) THEN
    RAISE EXCEPTION 'tournament % rake attribution did not complete: %',
      p_tournament_id,v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'tournament % did not close all three escrow banks',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Persist the exact-zero proof before lifecycle. The historical after-status
  -- observer was detached above; this authority is now the only owner of the
  -- terminal escrow marker.
  UPDATE public.tournament_escrow
     SET closed_at = v_completed_at,
         close_note = 'terminal receipt: exact zero',
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND prize_balance = 0 AND bounty_balance = 0 AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its exact zero escrow close',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  END IF;
$new1$);
 source:=replace(source,$old2$     v_rake.attributed_users,v_completed_at,'terminal receipt: exact zero',
     v_completed_at,transaction_timestamp(),CASE WHEN v_accounting IS NULL THEN 1 ELSE 2 END,COALESCE(v_accounting->>'status','legacy'));$old2$,$new2$     v_rake.attributed_users,CASE WHEN v_custody THEN NULL ELSE v_completed_at END,
     CASE WHEN v_custody THEN NULL ELSE 'terminal receipt: exact zero' END,
     v_completed_at,transaction_timestamp(),CASE WHEN v_custody THEN 3 WHEN v_accounting IS NULL THEN 1 ELSE 2 END,COALESCE(v_accounting->>'status','legacy'));$new2$);
 EXECUTE source;
END $patch$;

DO $patch$
DECLARE source text;
BEGIN
 SELECT pg_get_functiondef('public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure) INTO source;
 IF md5(source)<>'787eb9a718a648ac29753dfc9234f4c3' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'fn_ca_tournament_terminal_receipt preimage changed' USING ERRCODE='55000'; END IF;
 source:=replace(source,$old0$  v_accounting jsonb; v_deferred boolean := false;$old0$,$new0$  v_accounting jsonb; v_deferred boolean := false;v_custody boolean:=false;v_resolved boolean:=false;v_original_witness jsonb;$new0$);
 source:=replace(source,$old1$  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);$old1$,$new1$  v_accounting:=CASE WHEN v_h.accounting_state='fee_custody_unresolved' THEN public.fn_ca_tournament_fee_custody_receipt(p_tournament_id) ELSE public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id) END;$new1$);
 source:=replace(source,$old2$  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);$old2$,$new2$  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  v_custody:=v_h.accounting_state='fee_custody_unresolved';
  v_resolved:=v_custody AND COALESCE((v_accounting->>'accounting_complete')::boolean,false);$new2$);
 source:=replace(source,$old3$     OR (v_accounting IS NOT NULL AND v_h.receipt_version<>2)$old3$,$new3$     OR (v_accounting IS NOT NULL AND v_h.receipt_version<>CASE WHEN v_custody THEN 3 ELSE 2 END)$new3$);
 source:=replace(source,$old4$     OR v_e.fee_balance IS DISTINCT FROM 0::numeric$old4$,$new4$     OR v_e.fee_balance IS DISTINCT FROM (CASE WHEN v_custody AND NOT v_resolved THEN v_h.rake_amount ELSE 0::numeric END)$new4$);
 source:=replace(source,$old5$  SELECT rs.* INTO v_r FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  IF v_r.tournament_id IS NULL
     OR v_r.amount IS DISTINCT FROM v_rake_total
     OR v_r.amount IS DISTINCT FROM v_h.rake_amount
     OR v_r.destination IS DISTINCT FROM v_h.rake_destination
     OR v_r.settled_at IS DISTINCT FROM v_h.rake_settled_at
     OR v_r.attributed_at IS DISTINCT FROM v_h.rake_attributed_at
     OR v_r.attributed_users IS DISTINCT FROM v_h.rake_attributed_users
     OR v_r.attributed_users IS NULL OR v_r.attributed_users < 0
     OR (v_r.attribution_error IS NOT NULL AND NOT v_deferred)
     OR lower(v_r.destination) IN ('pending','')
     OR (v_r.amount > 0 AND v_t.club_id IS NOT NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id) AND NOT v_deferred
         AND (v_r.attributed_users < 1
           OR v_r.destination NOT LIKE 'union:%'
              AND v_r.destination NOT LIKE 'chip_retirement:%'
              AND NOT (v_h.receipt_version=1 AND v_h.accounting_state='legacy'
                       AND v_r.destination LIKE 'club_treasury:%'))) THEN
    RAISE EXCEPTION 'tournament % rake is not durably and successfully attributed',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
$old5$,$new5$  IF v_custody THEN
    IF v_accounting->>'status' IS DISTINCT FROM 'fee_custody_unresolved'
      OR (v_accounting->>'held_amount')::numeric IS DISTINCT FROM v_h.rake_amount
      OR v_h.rake_amount IS DISTINCT FROM v_rake_total
      OR v_h.rake_destination IS DISTINCT FROM 'tournament_escrow'
      OR v_h.rake_settled_at IS NOT NULL OR v_h.rake_attributed_at IS NOT NULL
      OR v_h.rake_attributed_users IS DISTINCT FROM 0 OR v_h.escrow_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'terminal unresolved fee proof disagrees with original custody' USING ERRCODE='P0404';
    END IF;
  ELSE
  SELECT rs.* INTO v_r FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  IF v_r.tournament_id IS NULL
     OR v_r.amount IS DISTINCT FROM v_rake_total
     OR v_r.amount IS DISTINCT FROM v_h.rake_amount
     OR v_r.destination IS DISTINCT FROM v_h.rake_destination
     OR v_r.settled_at IS DISTINCT FROM v_h.rake_settled_at
     OR v_r.attributed_at IS DISTINCT FROM v_h.rake_attributed_at
     OR v_r.attributed_users IS DISTINCT FROM v_h.rake_attributed_users
     OR v_r.attributed_users IS NULL OR v_r.attributed_users < 0
     OR (v_r.attribution_error IS NOT NULL AND NOT v_deferred)
     OR lower(v_r.destination) IN ('pending','')
     OR (v_r.amount > 0 AND v_t.club_id IS NOT NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id) AND NOT v_deferred
         AND (v_r.attributed_users < 1
           OR v_r.destination NOT LIKE 'union:%'
              AND v_r.destination NOT LIKE 'chip_retirement:%'
              AND NOT (v_h.receipt_version=1 AND v_h.accounting_state='legacy'
                       AND v_r.destination LIKE 'club_treasury:%'))) THEN
    RAISE EXCEPTION 'tournament % rake is not durably and successfully attributed',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  END IF;
$new5$);
 source:=replace(source,$old6$    'fully_settled',true,$old6$,$new6$    'fully_settled',NOT v_custody OR v_resolved,
    'player_result','final',
    'accounting_complete',(NOT v_custody AND NOT v_deferred) OR v_resolved,
    'accounting_state',CASE WHEN v_resolved THEN 'recognized' ELSE v_h.accounting_state END,$new6$);
 source:=replace(source,$old7$      'attributed',NOT v_deferred,$old7$,$new7$      'attributed',NOT (v_deferred OR v_custody),$new7$);
 source:=replace(source,$old8$  SELECT (p->>'user_id')::uuid,(p->>'amount')::numeric$old8$,$new8$  IF to_regprocedure('smarter_private.breakfast_standings_witness(uuid,uuid)') IS NOT NULL THEN
    EXECUTE 'SELECT smarter_private.breakfast_standings_witness($1,$2)' INTO v_original_witness USING p_tournament_id,v_h.winner_id;
  END IF;
  IF NULLIF(v_h.cash_receipt->'original_witness','null'::jsonb) IS DISTINCT FROM NULLIF(v_original_witness,'null'::jsonb) THEN
    RAISE EXCEPTION 'terminal cash original witness disagrees with immutable standings' USING ERRCODE='P0404';
  END IF;
  SELECT (p->>'user_id')::uuid,(p->>'amount')::numeric$new8$);
 EXECUTE source;
END $patch$;

DO $patch$
DECLARE source text;
BEGIN
 SELECT pg_get_functiondef('public.fn_tournament_finish_readiness(uuid,uuid)'::regprocedure) INTO source;
 IF md5(source)<>'b3067dd214bcc1979b6d80a4d7144bfe' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_tournament_finish_readiness(uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_tournament_finish_readiness(uuid,uuid)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'fn_tournament_finish_readiness preimage changed' USING ERRCODE='55000'; END IF;
 source:=replace(source,$old0$  v_accounting jsonb; v_deferred boolean := false;$old0$,$new0$  v_accounting jsonb; v_deferred boolean := false;v_custody boolean:=false;$new0$);
 source:=replace(source,$old1$  SELECT * INTO v_escrow FROM public.tournament_escrow$old1$,$new1$  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_custody:=COALESCE(v_accounting->>'status'='fee_custody_unresolved',false);
  SELECT * INTO v_escrow FROM public.tournament_escrow$new1$);
 source:=replace(source,$old2$     OR abs(round(v_escrow.fee_balance,2)) > 0.005 THEN$old2$,$new2$     OR (NOT v_custody AND abs(round(v_escrow.fee_balance,2)) > 0.005) THEN$new2$);
 source:=replace(source,$old3$  IF NOT v_rake_found OR v_rake_settled_at IS NULL$old3$,$new3$  IF NOT v_custody AND (NOT v_rake_found OR v_rake_settled_at IS NULL$new3$);
 source:=replace(source,$old4$     OR abs(round(COALESCE(v_rake_recorded,0),2) - v_rake_expected) > 0.005 THEN$old4$,$new4$     OR abs(round(COALESCE(v_rake_recorded,0),2) - v_rake_expected) > 0.005) THEN$new4$);
 source:=replace(source,$old5$    'finish_kind',v_kind,'failures',v_failures,$old5$,$new5$    'finish_kind',v_kind,'failures',v_failures,
    'player_result',CASE WHEN jsonb_array_length(v_failures)=0 THEN 'final' ELSE 'unresolved' END,
    'accounting_complete',NOT v_custody AND NOT v_deferred,'accounting',v_accounting,$new5$);
 EXECUTE source;
END $patch$;

DO $patch$
DECLARE source text;
BEGIN
 SELECT pg_get_functiondef('public.fn_settle_tournament_rake(uuid,text)'::regprocedure) INTO source;
 IF md5(source)<>'70f5b72172818526db98ebf59c393355' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_settle_tournament_rake(uuid,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_settle_tournament_rake(uuid,text)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'fn_settle_tournament_rake preimage changed' USING ERRCODE='55000'; END IF;
 source:=replace(source,$old0$ INSERT INTO public.tournament_rake_settlements(tournament_id,club_id,amount,destination,source)$old0$,$new0$ PERFORM public.fn_ca_begin_legacy_fee_resolution(p_tournament_id);
 INSERT INTO public.tournament_rake_settlements(tournament_id,club_id,amount,destination,source)$new0$);
 source:=replace(source,$old1$ RETURN jsonb_build_object('ok',true,'amount',v_net,'destination',v_dest,'attributed',true,$old1$,$new1$ IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions WHERE tournament_id=p_tournament_id AND transaction_id=txid_current()) THEN
  UPDATE public.tournament_rake_settlements SET terminal_closed_at=(SELECT completed_at FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament_id) WHERE tournament_id=p_tournament_id AND terminal_closed_at IS NULL;
 END IF;
 RETURN jsonb_build_object('ok',true,'amount',v_net,'destination',v_dest,'attributed',true,$new1$);
 EXECUTE source;
END $patch$;

DO $patch$
DECLARE source text;
BEGIN
 SELECT pg_get_functiondef('public.fn_terminal_tournament_evidence_is_immutable()'::regprocedure) INTO source;
 IF md5(source)<>'a129e4214f59e7f95ffe397e2245bbd0' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_terminal_tournament_evidence_is_immutable()'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_terminal_tournament_evidence_is_immutable()'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'fn_terminal_tournament_evidence_is_immutable preimage changed' USING ERRCODE='55000'; END IF;
 source:=replace(source,$old0$BEGIN
$old0$,$new0$BEGIN
  IF TG_OP<>'DELETE' AND public.fn_ca_legacy_fee_resolution_write_is_exact(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW)) THEN RETURN NEW; END IF;
$new0$);
 EXECUTE source;
END $patch$;

DO $patch$
DECLARE source text;
BEGIN
 SELECT pg_get_functiondef('public.fn_terminal_tournament_escrow_is_immutable()'::regprocedure) INTO source;
 IF md5(source)<>'a16d9de27073e03f2605ecc36cfc08c6' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_terminal_tournament_escrow_is_immutable()'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_terminal_tournament_escrow_is_immutable()'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'fn_terminal_tournament_escrow_is_immutable preimage changed' USING ERRCODE='55000'; END IF;
 source:=replace(source,$old0$BEGIN
$old0$,$new0$BEGIN
  IF TG_OP<>'DELETE' AND public.fn_ca_legacy_fee_resolution_write_is_exact(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW)) THEN RETURN NEW; END IF;
$new0$);
 EXECUTE source;
END $patch$;

DO $patch$
DECLARE source text;
BEGIN
 SELECT pg_get_functiondef('public.fn_satellite_transfer_ledger_is_immutable()'::regprocedure) INTO source;
 IF md5(source)<>'b2affe52c4e95101c985c30c483d5127' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_satellite_transfer_ledger_is_immutable()'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_satellite_transfer_ledger_is_immutable()'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'fn_satellite_transfer_ledger_is_immutable preimage changed' USING ERRCODE='55000'; END IF;
 source:=replace(source,$old0$BEGIN
$old0$,$new0$BEGIN
  IF TG_OP<>'DELETE' AND public.fn_ca_legacy_fee_resolution_write_is_exact(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW)) THEN RETURN NEW; END IF;
$new0$);
 EXECUTE source;
END $patch$;

DO $patch$
DECLARE source text;
BEGIN
 SELECT pg_get_functiondef('public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)'::regprocedure) INTO source;
 IF md5(source)<>'47c613c5ecc3d383db4b4941dc1ff830' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'fn_ca_capture_tournament_fee_from_recorded_evidence preimage changed' USING ERRCODE='55000'; END IF;
 source:=replace(source,$old0$  IF upper(COALESCE(t.status::text,'')) NOT IN ('RUNNING','BREAK','REGISTERING','COMPLETING') THEN$old0$,$new0$  IF upper(COALESCE(t.status::text,'')) NOT IN ('RUNNING','BREAK','REGISTERING','COMPLETING')
   AND NOT public.fn_ca_legacy_fee_capture_admitted(r.tournament_id) THEN$new0$);
 EXECUTE source;
END $patch$;

COMMIT;
