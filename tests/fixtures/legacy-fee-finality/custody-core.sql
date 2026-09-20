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
