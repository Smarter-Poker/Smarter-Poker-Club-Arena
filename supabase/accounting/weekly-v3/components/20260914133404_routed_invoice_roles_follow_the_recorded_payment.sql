-- Routed payouts retain the role recorded by the atomic stage, including a
-- player's rakeback when that same account also has an agent profile. Only the
-- matching private stage's transaction context can assert a recorded role;
-- arbitrary message or transfer metadata cannot override the invoice party.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_invoice_accounting_ledger_transfer(uuid)'::regprocedure))<>'dd1871aa89f1709b9b45cb16542b5fa9'
 THEN RAISE EXCEPTION 'accounting invoice source changed since review'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_invoice_accounting_ledger_transfer(p_ledger_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE leg public.chip_ledger%ROWTYPE; inv_id uuid; issuer_kind text; issuer_id uuid; payee_kind text; payee_id uuid; kind text; recorded_role text; routed boolean;
BEGIN
 SELECT * INTO leg FROM public.chip_ledger WHERE id=p_ledger_id;
 IF NOT FOUND OR leg.status IS DISTINCT FROM 'posted' OR leg.amount IS NULL OR leg.amount<=0
    OR leg.amount::text IN('NaN','Infinity','-Infinity') OR leg.amount<>round(leg.amount,2)
 THEN RAISE EXCEPTION 'invalid_accounting_transfer' USING ERRCODE='23514'; END IF;
 routed:=COALESCE(leg.metadata->>'routing_version'='3'
  AND current_setting('app.accounting_routing_context',true)=
   CASE WHEN leg.union_id IS NOT NULL THEN leg.union_id::text
    WHEN leg.metadata->>'accounting_scope_kind'='club' AND leg.metadata->>'accounting_scope_id'=leg.club_id::text
     THEN 'club:'||leg.club_id::text END
   ||':'||((leg.metadata->>'period_start')::timestamptz)::text||':'||((leg.metadata->>'period_end')::timestamptz)::text,false);
 recorded_role:=CASE WHEN routed THEN leg.metadata->>'payee_role_at_transfer' END;
 IF routed AND leg.to_type IN('player_wallet','agent_wallet') AND (recorded_role IS NULL OR recorded_role NOT IN('player','sub_agent','agent','super_agent')) THEN
  RAISE EXCEPTION 'routed_payment_recipient_role_missing' USING ERRCODE='23514'; END IF;

 IF leg.from_type IN('union_wallet','union_bank') THEN issuer_kind:='union';issuer_id:=leg.from_entity_id;
 ELSIF leg.from_type='club_treasury' THEN issuer_kind:='club';issuer_id:=leg.from_entity_id;
 ELSIF leg.from_type IN('player_wallet','agent_wallet') THEN issuer_id:=leg.from_entity_id;
   issuer_kind:=CASE WHEN routed OR leg.from_type='agent_wallet' OR EXISTS(SELECT 1 FROM public.agents a WHERE a.user_id=issuer_id AND a.club_id=leg.club_id) THEN 'agent' ELSE 'player' END;
 ELSIF leg.from_type='settlement_suspense' AND leg.category='rakeback' AND leg.club_id IS NOT NULL THEN
   -- Club-issued receipt for the existing clearing-account leg; preserve its actual source in breakdown.
   issuer_kind:='club';issuer_id:=leg.club_id;
 ELSE RAISE EXCEPTION 'unsupported_accounting_transfer_source' USING ERRCODE='23514'; END IF;
 -- Game payout journals retain the physical union_wallets.id store identity.
 -- Accounting parties use unions.id. Resolve only a matching, declared host;
 -- never rewrite the original journal or infer a different union.
 IF leg.category IN('wheel_prize','plinko_prize','crash_prize','crossing_prize','mines_prize')
    AND issuer_kind='union' AND leg.union_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.union_wallets w WHERE w.id=issuer_id AND w.union_id=leg.union_id)
 THEN issuer_id:=leg.union_id; END IF;
 IF leg.to_type IN('union_wallet','union_bank') THEN payee_kind:='union';payee_id:=leg.to_entity_id;
 ELSIF leg.to_type='club_treasury' THEN payee_kind:='club';payee_id:=leg.to_entity_id;
 ELSIF leg.to_type IN('player_wallet','agent_wallet') THEN
   payee_id:=leg.to_entity_id;
   payee_kind:=CASE WHEN routed THEN CASE WHEN recorded_role='player' THEN 'player' ELSE 'agent' END WHEN leg.category='commission' OR EXISTS(SELECT 1 FROM public.agents a WHERE a.user_id=payee_id AND a.club_id=leg.club_id) THEN 'agent' ELSE 'player' END;
 ELSE RAISE EXCEPTION 'unsupported_accounting_transfer_recipient' USING ERRCODE='23514'; END IF;
 kind:=CASE WHEN issuer_kind='union' AND payee_kind='club' THEN 'union_to_club'
            WHEN issuer_kind='club' AND payee_kind='agent' THEN 'club_to_agent'
            WHEN issuer_kind='agent' AND payee_kind='agent' THEN 'agent_to_subagent'
            WHEN issuer_kind='agent' AND payee_kind='player' THEN 'agent_to_player' ELSE 'transaction_receipt' END;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_ledger_invoice:'||leg.id::text,0));
 SELECT id INTO inv_id FROM public.settlement_invoices WHERE source_ledger_id=leg.id;
 IF inv_id IS NULL THEN
   INSERT INTO public.settlement_invoices(club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
    gross_amount,net_amount,deductions,breakdown,status,chips_transferred,transferred_at,notes,source_ledger_id)
   VALUES(COALESCE(leg.club_id,leg.union_id),kind,issuer_kind,issuer_id::text,payee_kind,payee_id::text,leg.amount,leg.amount,0,
    COALESCE(leg.metadata,'{}'::jsonb)||jsonb_build_object('ledger_id',leg.id,'category',leg.category,'ledger_from_type',leg.from_type,
      'ledger_from_entity_id',leg.from_entity_id,'ledger_to_type',leg.to_type,'ledger_to_entity_id',leg.to_entity_id,
      'payee_role_at_transfer',CASE WHEN routed AND recorded_role IS NOT NULL THEN recorded_role WHEN payee_kind='player' THEN 'player' ELSE (SELECT a.role FROM public.agents a WHERE a.user_id=payee_id AND a.club_id=leg.club_id ORDER BY a.id LIMIT 1) END),
    'paid',true,leg.created_at,'Receipt For A Posted Accounting Transfer. This Does Not Certify The Entire Weekly Close.',leg.id)
   RETURNING id INTO inv_id;
 END IF;
 PERFORM public.fn_deliver_accounting_invoice(inv_id);
 RETURN inv_id;
END $function$

;

COMMIT;
