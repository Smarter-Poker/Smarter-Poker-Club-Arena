CREATE OR REPLACE FUNCTION public.fn_ca_rakeback_payout_leg_is_documented()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  m        jsonb := COALESCE(NEW.metadata,'{}'::jsonb);
  v_period uuid; v_cert bigint; v_payout uuid;
  v_kind   text; v_scope uuid; v_start timestamptz; v_end timestamptz;
  v_docs   int;
  v_legacy_operation uuid;
BEGIN
  IF NEW.idempotency_key IS NULL OR btrim(NEW.idempotency_key)='' THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' carries no idempotency key';
  END IF;
  IF m->>'routing_version' IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has no routed accounting identity';
  END IF;
  BEGIN
    v_period:=(m->>'period_id')::uuid;   v_cert :=(m->>'certificate_id')::bigint;
    v_payout:=(m->>'payout_id')::uuid;   v_kind :=m->>'accounting_scope_kind';
    v_scope :=(m->>'accounting_scope_id')::uuid;
    v_start :=(m->>'period_start')::timestamptz;
    v_end   :=(m->>'period_end')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has an unreadable routed accounting identity';
  END;
  IF v_period IS NULL OR v_cert IS NULL OR v_payout IS NULL OR v_kind IS NULL
     OR v_scope IS NULL OR v_start IS NULL OR v_end IS NULL THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' is missing part of its period, certificate or payout identity';
  END IF;

  -- The settlement run a disputing player is shown the payment under.
  IF NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
    WHERE r.scope_kind=v_kind AND r.scope_id=v_scope AND r.period_start=v_start
      AND r.period_end=v_end AND r.round_no=3 AND r.routing_version=3)
    AND NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c
      JOIN public.rakeback_period_payouts pp ON pp.id=v_payout AND pp.rakeback_period_id=c.period_id
      JOIN public.rakeback_periods rp ON rp.id=c.period_id
      WHERE NOT(m ? 'certificate_kind') AND c.id=v_cert AND c.accounting_version=2
       AND c.period_id=v_period AND c.club_id=NEW.club_id AND c.player_id=NEW.to_entity_id
       AND pp.club_id=c.club_id AND pp.user_id=c.player_id AND pp.status='paid' AND pp.payout_amount=c.rakeback_amount
       AND rp.status='paid' AND rp.club_id=c.club_id AND rp.user_id=c.player_id
       AND c.period_start=(v_start AT TIME ZONE 'America/Los_Angeles')::date
       AND c.period_end=(v_end AT TIME ZONE 'America/Los_Angeles')::date-1 AND c.period_end=c.period_start+6
       AND v_end<=now()-interval '5 minutes' AND v_start=public.fn_union_week_start(v_start)
       AND v_end=public.fn_union_week_start(v_start+interval '8 days')
       AND m->>'source_fingerprint'=c.source_fingerprint
       AND((v_kind='union' AND c.coordinator_union_id=v_scope)
         OR(v_kind='club' AND c.coordinator_union_id IS NULL AND c.club_id=v_scope))) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no routed settlement run';
  END IF;

  IF m->>'wallet_destination_version'='own-agent-v1' THEN
    IF m?'certificate_kind'OR NOT smarter_private.rakeback_wallet_payout_complete(v_payout,v_cert)
     OR NOT EXISTS(SELECT FROM public.accounting_rakeback_wallet_transfers t WHERE t.payout_id=v_payout AND t.calculation_id=v_cert AND t.period_id=v_period AND t.ledger_id=NEW.id AND t.amount=NEW.amount AND t.destination_kind=NEW.to_type)
    THEN RAISE EXCEPTION 'typed_rakeback_payout_leg_undocumented' USING ERRCODE='23514';END IF;
    RETURN NULL;
  END IF;
  IF NEW.to_type='agent_wallet' THEN RAISE EXCEPTION 'typed_rakeback_payout_leg_undocumented' USING ERRCODE='23514';END IF;

  IF EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.id=v_cert AND c.payer_kind='split') THEN
    IF NOT smarter_private.split_rakeback_payout_complete(v_payout,v_cert)
      OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_payer_transfers t WHERE t.payout_id=v_payout AND t.calculation_id=v_cert AND t.period_id=v_period AND t.ledger_id=NEW.id AND t.amount=NEW.amount)
    THEN RAISE EXCEPTION 'split_rakeback_payout_leg_undocumented' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp
    WHERE pp.id=v_payout AND pp.rakeback_period_id=v_period AND pp.club_id=NEW.club_id
      AND pp.user_id=NEW.to_entity_id AND pp.status='paid' AND pp.payout_amount=NEW.amount) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no matching paid rakeback period payout';
  END IF;

  IF m ? 'certificate_kind' THEN
    -- The only other certificate kind is the owner-authorized legacy one. It
    -- must name its operation, and the certificate must be that operation's.
    IF m->>'certificate_kind' IS DISTINCT FROM 'owner_legacy_v1' THEN
      RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
        DETAIL='chip_ledger '||NEW.id::text||' names an unknown certificate kind';
    END IF;
    BEGIN v_legacy_operation:=(m->>'legacy_operation_id')::uuid;
    EXCEPTION WHEN OTHERS THEN v_legacy_operation:=NULL; END;
    IF v_legacy_operation IS NULL OR NOT EXISTS(SELECT 1 FROM public.accounting_legacy_rakeback_certificates c
      JOIN public.accounting_owner_legacy_operations o ON o.operation_id=c.operation_id
      WHERE c.id=v_cert AND c.operation_id=v_legacy_operation AND c.period_id=v_period AND c.club_id=NEW.club_id
        AND c.player_id=NEW.to_entity_id AND c.rakeback_amount=NEW.amount
        AND o.period_start=v_start AND o.period_end=v_end) THEN
      RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
        DETAIL='chip_ledger '||NEW.id::text||' names no matching owner legacy certificate';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c
    WHERE c.id=v_cert AND c.period_id=v_period AND c.club_id=NEW.club_id
      AND c.player_id=NEW.to_entity_id AND c.rakeback_amount=NEW.amount) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no matching rakeback certificate';
  END IF;

  SELECT count(*) INTO v_docs FROM public.settlement_invoices i
   WHERE i.source_ledger_id=NEW.id AND i.status='paid' AND i.chips_transferred
     AND i.gross_amount=NEW.amount AND i.net_amount=NEW.amount;
  IF v_docs<>1 THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has '||v_docs::text||' source-linked paid receipts, expected exactly 1';
  END IF;
  RETURN NULL;
END $function$
;
-- Existing PLAYER trigger remains unchanged. AGENT destination now receives
-- the same deferred full certificate/payment/invoice proof.
CREATE CONSTRAINT TRIGGER zz_ca_own_agent_rakeback_leg_documented
AFTER INSERT ON public.chip_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN(NEW.status='posted' AND NEW.category='rakeback' AND NEW.to_type='agent_wallet')
EXECUTE FUNCTION public.fn_ca_rakeback_payout_leg_is_documented();

INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)VALUES('chip_ledger','zz_ca_own_agent_rakeback_leg_documented','Deferred exact typed own-agent certificate, payout, wallet transaction and paid invoice proof; original PLAYER predicate retained.');
