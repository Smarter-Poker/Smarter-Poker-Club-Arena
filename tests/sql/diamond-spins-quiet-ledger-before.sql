-- Run only in the private Diamond fixture created by test-accounting-delivery.sh,
-- BEFORE migration 20260921202827 and AFTER quiet-ledger-dependencies.sql has
-- installed the 20260921052548 roster gate. This is the reproduction half of
-- owner ruling 2026-09-21 R17: it pins what the ruling removes (a per-prize
-- accounting document, Messenger invoice, notification and push for the player
-- and the host roster) and the latent refusal that gate causes for a player.
BEGIN;
SET LOCAL statement_timeout='90s';
SET LOCAL lock_timeout='2s';
DO $$ BEGIN
  IF current_database() IS DISTINCT FROM 'diamond_games_probe'
     OR NOT EXISTS (SELECT 1 FROM public.ca_financial_epochs WHERE name='Isolated Diamond financial probe' AND is_current)
     OR to_regproc('public.fn_diamond_spin_ledger_category') IS NOT NULL
     OR md5(pg_get_functiondef('public.fn_accounting_party_users(text,uuid)'::regprocedure))<>'dd8941d9caba28d258313dfdb0499c82' THEN
    RAISE EXCEPTION 'quiet ledger reproduction requires the isolated fixture, the 20260921052548 roster gate and no exclusion yet';
  END IF;
END $$;
DO $probe$
DECLARE
  player constant uuid:='d1000000-0000-4000-8000-000000000001';
  operator constant uuid:='d1000000-0000-4000-8000-000000000002';
  union_host constant uuid:='d1000000-0000-4000-8000-000000000004';
  union_club constant uuid:='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  key text; refusal text; leg record; docs int; msgs int; notes int; pushes int;
BEGIN
  -- 1. An authenticated player (never on the union roster) wins a union chip
  --    prize: the document trigger asks for the issuer roster, the gated roster
  --    answers nothing for a non-member, and the whole prize is refused.
  PERFORM set_config('request.jwt.claim.sub',player::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',player,'role','authenticated')::text,true);
  key:='quiet-before:player:'||gen_random_uuid();
  BEGIN
    PERFORM public.fn_diamond_game_pay_chips('wheel_prize',union_host,'union',union_club,player,0.05,key,'Isolated Repro Prize','{}'::jsonb);
    refusal:='paid';
  EXCEPTION WHEN OTHERS THEN refusal:=SQLERRM;
  END;
  IF refusal IS DISTINCT FROM 'accounting_invoice_recipient_missing' THEN
    RAISE EXCEPTION 'expected the gated roster to refuse the player prize, got: %',refusal;
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key IN (key,key||':bank'))
     OR (SELECT chip_balance FROM public.club_members WHERE club_id=union_club AND user_id=player)<>0 THEN
    RAISE EXCEPTION 'the refused prize left money behind';
  END IF;

  -- 1b. The host OWNER, who is on the issuer roster, is refused as well: the
  --     payee roster is hidden from every browser caller who is not the payee,
  --     so no authenticated session can pay a union prize at all under the gate.
  PERFORM set_config('request.jwt.claim.sub',operator::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',operator,'role','authenticated')::text,true);
  key:='quiet-before:operator:'||gen_random_uuid();
  BEGIN
    PERFORM public.fn_diamond_game_pay_chips('wheel_prize',union_host,'union',union_club,player,0.05,key,'Isolated Repro Prize','{}'::jsonb);
    refusal:='paid';
  EXCEPTION WHEN OTHERS THEN refusal:=SQLERRM;
  END;
  IF refusal IS DISTINCT FROM 'accounting_invoice_recipient_missing'
     OR EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key IN (key,key||':bank')) THEN
    RAISE EXCEPTION 'expected the gated roster to refuse the owner-played prize too, got: %',refusal;
  END IF;

  -- 2. Only the engine identity (service_role) sees both rosters. Paid that way
  --    the same prize documents itself four ways for two people: the behaviour
  --    the owner reversed.
  PERFORM set_config('request.jwt.claim.sub',operator::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',operator,'role','service_role')::text,true);
  key:='quiet-before:engine:'||gen_random_uuid();
  PERFORM public.fn_diamond_game_pay_chips('wheel_prize',union_host,'union',union_club,player,0.05,key,'Isolated Documented Prize','{}'::jsonb);
  SELECT * INTO STRICT leg FROM public.chip_ledger WHERE idempotency_key=key;
  SELECT count(*) INTO docs FROM public.settlement_invoices WHERE source_ledger_id=leg.id;
  SELECT count(*) INTO msgs FROM public.social_messages m JOIN public.accounting_invoice_deliveries d ON d.message_id=m.id
    JOIN public.settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=leg.id AND m.message_type='invoice';
  SELECT count(*) INTO notes FROM public.notifications n JOIN public.accounting_invoice_deliveries d ON d.notification_id=n.id
    JOIN public.settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=leg.id AND n.type='accounting_invoice';
  SET CONSTRAINTS ALL IMMEDIATE;
  SELECT count(*) INTO pushes FROM public.push_outbox p JOIN public.accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id
    JOIN public.settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=leg.id AND p.event='accounting_invoice';
  IF ROW(leg.from_type,leg.to_type,leg.category,leg.status) IS DISTINCT FROM ROW('union_wallet','player_wallet','wheel_prize','posted')
     OR ROW(docs,msgs,notes,pushes) IS DISTINCT FROM ROW(1,2,2,2) THEN
    RAISE EXCEPTION 'expected one document with two messages, two notifications and two pushes, got docs=% msgs=% notes=% pushes=%',docs,msgs,notes,pushes;
  END IF;
  RAISE NOTICE 'PASS Quiet ledger reproduction: the gated roster refuses every authenticated union prize (player and owner) with accounting_invoice_recipient_missing, and the engine-paid union prize still issues one document, two Messenger invoices, two notifications and two pushes';
END $probe$;
ROLLBACK;
