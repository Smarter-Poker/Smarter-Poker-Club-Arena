-- Run only in the private Diamond fixture created by test-accounting-delivery.sh,
-- AFTER migration 20260921202827 (owner ruling 2026-09-21 R17). Every Diamond
-- Spins prize leg keeps its chip_ledger, chip_transactions and (for a union)
-- union_wallet_transactions rows exactly as before, and produces no accounting
-- document, Messenger invoice, notification or push for the player or for the
-- host roster. The refusal reproduced by diamond-spins-quiet-ledger-before.sql
-- cannot occur: an authenticated player and the authenticated owner are both
-- paid. A non-Diamond leg of the same shape still documents itself, so the
-- exclusion is exactly as narrow as fn_diamond_spin_ledger_category says.
BEGIN;
SET LOCAL statement_timeout='90s';
SET LOCAL lock_timeout='2s';
DO $$ BEGIN
  IF current_database() IS DISTINCT FROM 'diamond_games_probe'
     OR NOT EXISTS (SELECT 1 FROM public.ca_financial_epochs WHERE name='Isolated Diamond financial probe' AND is_current)
     OR md5(pg_get_functiondef('public.fn_accounting_party_users(text,uuid)'::regprocedure))<>'dd8941d9caba28d258313dfdb0499c82' THEN
    RAISE EXCEPTION 'quiet ledger probe requires the isolated fixture with the 20260921052548 roster gate installed';
  END IF;
END $$;
CREATE FUNCTION pg_temp.document_rows() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'invoices',(SELECT count(*) FROM public.settlement_invoices),
    'deliveries',(SELECT count(*) FROM public.accounting_invoice_deliveries),
    'messages',(SELECT count(*) FROM public.social_messages),
    'notifications',(SELECT count(*) FROM public.notifications),
    'outbox',(SELECT count(*) FROM public.push_outbox));
$$;
DO $probe$
DECLARE
  player constant uuid:='d1000000-0000-4000-8000-000000000001';
  operator constant uuid:='d1000000-0000-4000-8000-000000000002';
  union_host constant uuid:='d1000000-0000-4000-8000-000000000004';
  union_club constant uuid:='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  standalone constant uuid:='a0000000-0000-0000-0000-000000000001';
  categories text[]; category text; trigger_def text; note text;
  quiet_before jsonb; key text; leg record; result record; paid_legs int; legs_total numeric;
  wallet_before record; wallet_after record; member_before numeric; member_after numeric; uwt int; ctx int;
  refusal text; exp_promo numeric; exp_bank numeric;
BEGIN
  -- 1. One list, in one function, read by the trigger predicate and by this probe.
  SELECT array_agg(c ORDER BY c) INTO categories FROM unnest(ARRAY['wheel_prize','plinko_prize','crash_prize','crossing_prize','mines_prize']) c
   WHERE public.fn_diamond_spin_ledger_category(c);
  IF categories IS DISTINCT FROM ARRAY['crash_prize','crossing_prize','mines_prize','plinko_prize','wheel_prize']
     OR public.fn_diamond_spin_ledger_category('rakeback') OR public.fn_diamond_spin_ledger_category('spin_prize')
     OR public.fn_diamond_spin_ledger_category('transfer') OR public.fn_diamond_spin_ledger_category(NULL)
     OR public.fn_diamond_spin_ledger_category('WHEEL_PRIZE') THEN
    RAISE EXCEPTION 'fn_diamond_spin_ledger_category does not name exactly the five Diamond Spins categories';
  END IF;
  SELECT pg_get_triggerdef(t.oid,true) INTO trigger_def FROM pg_trigger t
   WHERE t.tgrelid='public.chip_ledger'::regclass AND t.tgname='accounting_transfer_document' AND t.tgenabled='O';
  SELECT d.note INTO note FROM public.ca_declared_money_triggers d WHERE d.table_name='chip_ledger' AND d.trigger_name='accounting_transfer_document';
  IF trigger_def IS NULL OR position('NOT fn_diamond_spin_ledger_category(new.category)' IN trigger_def)=0
     OR note IS NULL OR position('fn_diamond_spin_ledger_category' IN note)=0 OR position('20260921202827' IN note)=0 THEN
    RAISE EXCEPTION 'the document trigger or its declaration does not carry the Diamond Spins exclusion';
  END IF;

  -- 2. Every category, both hosts, promo leg AND bank shortfall leg, paid by an
  --    authenticated PLAYER who is on no roster: paid, journaled, undocumented.
  quiet_before:=pg_temp.document_rows();
  PERFORM set_config('request.jwt.claim.sub',player::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',player,'role','authenticated')::text,true);
  FOREACH category IN ARRAY categories LOOP
    FOR leg IN SELECT * FROM (VALUES (union_host,'union'::text,union_club),(standalone,'club'::text,standalone)) h(host,kind,club) LOOP
      SELECT * INTO STRICT wallet_before FROM public.fn_diamond_game_cover_lock(leg.host,leg.kind);
      SELECT chip_balance INTO STRICT member_before FROM public.club_members WHERE club_id=leg.club AND user_id=player AND status='active';
      -- The promo wallet is paid down to one cent through the same writer, so
      -- the next prize spans the promo leg and the bank shortfall leg.
      IF wallet_before.o_promo>0.01 THEN
        PERFORM public.fn_diamond_game_pay_chips(category,leg.host,leg.kind,leg.club,player,wallet_before.o_promo-0.01,'quiet:drain:'||gen_random_uuid(),'Isolated Promo Drain','{}'::jsonb);
        SELECT * INTO STRICT wallet_before FROM public.fn_diamond_game_cover_lock(leg.host,leg.kind);
        SELECT chip_balance INTO STRICT member_before FROM public.club_members WHERE club_id=leg.club AND user_id=player AND status='active';
      END IF;
      exp_promo:=LEAST(0.03,wallet_before.o_promo); exp_bank:=0.03-exp_promo;
      key:='quiet:'||leg.kind||':'||category||':'||gen_random_uuid();
      SELECT * INTO STRICT result FROM public.fn_diamond_game_pay_chips(category,leg.host,leg.kind,leg.club,player,0.03,key,'Isolated Quiet Prize','{}'::jsonb);
      SELECT * INTO STRICT wallet_after FROM public.fn_diamond_game_cover_lock(leg.host,leg.kind);
      SELECT chip_balance INTO STRICT member_after FROM public.club_members WHERE club_id=leg.club AND user_id=player AND status='active';
      SELECT count(*),COALESCE(sum(amount),0) INTO paid_legs,legs_total FROM public.chip_ledger WHERE idempotency_key IN (key,key||':bank') AND status='posted';
      SELECT count(*) INTO ctx FROM public.chip_transactions WHERE club_id=leg.club AND to_user_id=player AND transaction_type=category AND amount=0.03
        AND (metadata->>'from_promo')::numeric=exp_promo AND (metadata->>'from_bank')::numeric=exp_bank;
      SELECT count(*) INTO uwt FROM public.union_wallet_transactions WHERE union_id=leg.host AND club_id=leg.club AND tx_type=category AND direction='debit'
        AND ((wallet='promo_wallet' AND amount=exp_promo) OR (wallet='chip_balance' AND amount=exp_bank));
      IF exp_bank<=0 THEN RAISE EXCEPTION 'the % % prize did not reach the bank leg',leg.kind,category; END IF;
      IF ROW(result.from_promo,result.from_bank,paid_legs,legs_total,member_after-member_before,wallet_before.o_promo-wallet_after.o_promo,wallet_before.o_bank-wallet_after.o_bank,ctx,uwt)
         IS DISTINCT FROM ROW(exp_promo,exp_bank,(exp_promo>0)::int+1,0.03::numeric,0.03::numeric,exp_promo,exp_bank,1,CASE WHEN leg.kind='union' THEN (exp_promo>0)::int+1 ELSE 0 END) THEN
        RAISE EXCEPTION 'the % % prize was not paid and journaled exactly: %',leg.kind,category,to_jsonb(result);
      END IF;
      IF EXISTS (SELECT 1 FROM public.settlement_invoices i JOIN public.chip_ledger l ON l.id=i.source_ledger_id WHERE l.idempotency_key IN (key,key||':bank')) THEN
        RAISE EXCEPTION 'a % % leg still issued an accounting document',leg.kind,category;
      END IF;
    END LOOP;
  END LOOP;
  IF pg_temp.document_rows() IS DISTINCT FROM quiet_before THEN
    RAISE EXCEPTION 'Diamond Spins prizes still produced documents, messages, notifications or pushes: % -> %',quiet_before,pg_temp.document_rows();
  END IF;

  -- 3. The owner-played union prize that the gate refused is paid too.
  PERFORM set_config('request.jwt.claim.sub',operator::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',operator,'role','authenticated')::text,true);
  key:='quiet:owner:'||gen_random_uuid();
  PERFORM public.fn_diamond_game_pay_chips('wheel_prize',union_host,'union',union_club,player,0.02,key,'Isolated Owner Played Prize','{}'::jsonb);
  IF (SELECT COALESCE(sum(amount),0) FROM public.chip_ledger WHERE idempotency_key IN (key,key||':bank') AND status='posted')<>0.02
     OR pg_temp.document_rows() IS DISTINCT FROM quiet_before THEN
    RAISE EXCEPTION 'the owner-played union prize was refused or documented';
  END IF;

  -- 4. Control: the standalone club's bank leg under a category the function
  --    does not name still reaches the document writer (issuer club, payee
  --    player): under the gate it refuses a browser caller, and paid by the
  --    engine it documents. The exclusion is exactly the five categories.
  SELECT * INTO STRICT wallet_before FROM public.fn_diamond_game_cover_lock(standalone,'club');
  IF wallet_before.o_promo>0 THEN
    PERFORM public.fn_diamond_game_pay_chips('wheel_prize',standalone,'club',standalone,player,wallet_before.o_promo,'quiet:drain:'||gen_random_uuid(),'Isolated Promo Drain','{}'::jsonb);
  END IF;
  PERFORM set_config('request.jwt.claim.sub',player::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',player,'role','authenticated')::text,true);
  key:='quiet:control:'||gen_random_uuid();
  BEGIN
    PERFORM public.fn_diamond_game_pay_chips('transfer',standalone,'club',standalone,player,0.02,key,'Isolated Control Transfer','{}'::jsonb);
    refusal:='documented';
  EXCEPTION WHEN OTHERS THEN refusal:=SQLERRM;
  END;
  IF refusal IS DISTINCT FROM 'accounting_invoice_recipient_missing' THEN
    RAISE EXCEPTION 'a non-Diamond leg should still reach the document writer, got: %',refusal;
  END IF;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',operator,'role','service_role')::text,true);
  key:='quiet:control-engine:'||gen_random_uuid();
  PERFORM public.fn_diamond_game_pay_chips('transfer',standalone,'club',standalone,player,0.02,key,'Isolated Control Transfer','{}'::jsonb);
  SET CONSTRAINTS ALL IMMEDIATE;
  IF (SELECT count(*) FROM public.settlement_invoices i JOIN public.chip_ledger l ON l.id=i.source_ledger_id
       WHERE l.idempotency_key=key||':bank' AND l.from_type='club_treasury' AND l.category='transfer')<>1
     OR (pg_temp.document_rows()->>'outbox')::int<=(quiet_before->>'outbox')::int THEN
    RAISE EXCEPTION 'the control leg did not document itself';
  END IF;
  RAISE NOTICE 'PASS Quiet ledger: five Diamond Spins categories named once, union and club, promo and bank legs paid to an authenticated player and by the owner with exact chip_ledger, chip_transactions and union wallet rows and zero documents, messages, notifications or pushes; a non-Diamond leg still documents';
END $probe$;
ROLLBACK;
