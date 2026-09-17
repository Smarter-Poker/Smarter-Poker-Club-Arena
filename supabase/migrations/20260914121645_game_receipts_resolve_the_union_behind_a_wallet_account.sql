-- The accounting receipt feature is optional on older installations. When
-- present, its game-prize issuer must resolve the union behind the physical
-- wallet row used by autoledger. The existing money movement, original ledger
-- IDs, other accounting categories, recipient checks and delivery stay intact.
BEGIN;
DO $do$
DECLARE v_def text; v_after text;
 v_old constant text := $old$ IF leg.to_type IN('union_wallet','union_bank') THEN payee_kind:='union';payee_id:=leg.to_entity_id;$old$;
 v_new constant text := $new$ -- Game payout journals retain the physical union_wallets.id store identity.
 -- Accounting parties use unions.id. Resolve only a matching, declared host;
 -- never rewrite the original journal or infer a different union.
 IF leg.category IN('wheel_prize','plinko_prize','crash_prize','crossing_prize','mines_prize')
    AND issuer_kind='union' AND leg.union_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.union_wallets w WHERE w.id=issuer_id AND w.union_id=leg.union_id)
 THEN issuer_id:=leg.union_id; END IF;
 IF leg.to_type IN('union_wallet','union_bank') THEN payee_kind:='union';payee_id:=leg.to_entity_id;$new$;
BEGIN
 IF to_regprocedure('public.fn_invoice_accounting_ledger_transfer(uuid)') IS NULL THEN RETURN; END IF;
 SELECT pg_get_functiondef('public.fn_invoice_accounting_ledger_transfer(uuid)'::regprocedure) INTO v_def;
 IF md5(v_def)<>'74c1f098db493dac864ac36e6c652090' OR strpos(v_def,v_old)=0 THEN RAISE EXCEPTION 'Accounting invoice authority changed; review the game issuer extension'; END IF;
 EXECUTE replace(v_def,v_old,v_new);
 SELECT pg_get_functiondef('public.fn_invoice_accounting_ledger_transfer(uuid)'::regprocedure) INTO v_after;
 IF replace(v_after,v_new,v_old) IS DISTINCT FROM v_def THEN RAISE EXCEPTION 'Unrelated accounting behavior changed'; END IF;
END $do$;
NOTIFY pgrst, 'reload schema';
COMMIT;
