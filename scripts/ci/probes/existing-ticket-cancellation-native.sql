-- Appended after the unchanged six-group existing-ticket redemption proof.
-- Its historical issue fixture remains unchanged; all new money work below is
-- actual current cancellation against the genuinely redeemed target entry.
-- The preceding proof forced all deferred checks. A new request starts with
-- its declaration defaults; restore only constraints declared INITIALLY DEFERRED.
-- Initially immediate checks remain immediate throughout this extension.
DO $restore_initially_deferred$
DECLARE c record;
BEGIN
 FOR c IN SELECT DISTINCT n.nspname,k.conname FROM pg_constraint k
  JOIN pg_namespace n ON n.oid=k.connamespace
  WHERE k.condeferrable AND k.condeferred AND n.nspname='public'
 LOOP
  IF EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace
    WHERE n.nspname=c.nspname AND k.conname=c.conname AND NOT(k.condeferrable AND k.condeferred)) THEN
   RAISE EXCEPTION 'initially deferred constraint name overlaps an immediate check: %',c.conname;
  END IF;
  EXECUTE format('SET CONSTRAINTS %I.%I DEFERRED',c.nspname,c.conname);
 END LOOP;
END $restore_initially_deferred$;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true);
INSERT INTO public.ca_settle_sources(source,note)
 VALUES('atomic_cancel_tournament','DB caller') ON CONFLICT(source) DO NOTHING;
CREATE TEMP TABLE ticket_cancel_results(name text PRIMARY KEY,value jsonb NOT NULL) ON COMMIT DROP;
GRANT INSERT,SELECT ON ticket_cancel_results TO service_role;
CREATE TEMP TABLE ticket_cancel_origin AS SELECT jsonb_build_object(
 'ticket',(SELECT to_jsonb(t) FROM public.tournament_tickets t WHERE id='e4100000-0000-4000-8000-000000000008'),
 'entitlement',(SELECT to_jsonb(e) FROM public.tournament_refund_entitlements e
   WHERE id=((SELECT value FROM existing_ticket_results WHERE name='entry')->>'entitlement_id')::uuid),
 'admission_ledger',(SELECT to_jsonb(l) FROM public.chip_ledger l JOIN public.tournament_refund_entitlements e
   ON e.source_ledger_id=l.id WHERE e.id=((SELECT value FROM existing_ticket_results WHERE name='entry')->>'entitlement_id')::uuid)
 ) AS evidence;

CREATE FUNCTION pg_temp.ticket_cancel_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
 RAISE NOTICE 'AUDIT_TEST_PASS: %',label;
END $assert$;

-- @TICKET_CANCEL_FINGERPRINT@

CREATE FUNCTION pg_temp.refuse_last_ticket_cancel_receipt() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
 IF NEW.tournament_id='e4100000-0000-4000-8000-000000000004' THEN
  IF NEW.total_refunded<>200 OR NEW.total_ticket_returned<>0
     OR NEW.refund_line_count<>1 OR NEW.ticket_return_count<>0 OR NEW.fees_reversed<>20
     OR (SELECT count(*) FROM public.wallet_transactions WHERE related_entity_id=NEW.tournament_id
       AND user_id='e4100000-0000-4000-8000-000000000001' AND type='credit' AND amount=200)<>1
     OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=NEW.tournament_id
       AND closed_at IS NOT NULL AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0) THEN
   RAISE EXCEPTION 'FAIL redeemed ticket reached last cancellation receipt with wrong cash/funding: %',to_jsonb(NEW);
  END IF;
  RAISE EXCEPTION 'injected final redeemed-ticket cancellation receipt failure' USING ERRCODE='PZ013';
 END IF;
 RETURN NEW;
END $fault$;
CREATE TRIGGER native_refuse_last_ticket_cancel_receipt BEFORE INSERT
 ON public.tournament_cancellation_receipts FOR EACH ROW
 EXECUTE FUNCTION pg_temp.refuse_last_ticket_cancel_receipt();
DO $late_refusal$
DECLARE before_state text:=pg_temp.ticket_cancel_state(); refused boolean:=false;
BEGIN
 BEGIN
  PERFORM public.atomic_cancel_tournament('e4100000-0000-4000-8000-000000000004',NULL);
 EXCEPTION WHEN SQLSTATE 'PZ013' THEN refused:=true; END;
 PERFORM pg_temp.ticket_cancel_assert(refused AND before_state=pg_temp.ticket_cancel_state(),
  'actual 200 cash and 20 fee reversal reached the last receipt, whose injected fault restores every tracked financial relation');
END $late_refusal$;
DROP TRIGGER native_refuse_last_ticket_cancel_receipt ON public.tournament_cancellation_receipts;

SET LOCAL ROLE service_role;
INSERT INTO ticket_cancel_results VALUES('first',public.atomic_cancel_tournament('e4100000-0000-4000-8000-000000000004',NULL));
RESET ROLE;
DO $exact_cash$
DECLARE r jsonb:=(SELECT value FROM ticket_cancel_results WHERE name='first');
 entry jsonb:=(SELECT value FROM existing_ticket_results WHERE name='entry');
BEGIN
 PERFORM pg_temp.ticket_cancel_assert(r->>'ok'='true' AND r->>'success'='true'
  AND r->>'fully_settled'='true' AND r->>'status'='CANCELLED'
  AND (r->>'total_refunded')::numeric=200 AND (r->>'total_ticket_returned')::numeric=0
  AND (r->>'refunded_count')::integer=1 AND (r->>'refund_line_count')::integer=1
  AND (r->>'ticket_return_count')::integer=0 AND (r->>'fees_reversed')::numeric=20
  AND EXISTS(SELECT 1 FROM public.tournament_cancellation_receipts c
    WHERE c.tournament_id='e4100000-0000-4000-8000-000000000004' AND c.receipt=r
      AND c.total_refunded=200 AND c.total_ticket_returned=0 AND c.fees_reversed=20)
  AND (SELECT count(*)=1 FROM public.wallet_transactions w WHERE w.related_entity_id='e4100000-0000-4000-8000-000000000004'
    AND w.user_id='e4100000-0000-4000-8000-000000000001' AND w.type='credit' AND w.amount=200)
  AND (SELECT chip_balance=200 FROM public.club_members
    WHERE club_id='e4100000-0000-4000-8000-000000000002' AND user_id='e4100000-0000-4000-8000-000000000001')
  AND EXISTS(SELECT 1 FROM public.tournament_refund_tranches tr JOIN public.chip_ledger l ON l.id=tr.credit_ledger_id
    JOIN public.wallet_transactions w ON w.id=tr.wallet_transaction_id
    WHERE tr.entitlement_id=(entry->>'entitlement_id')::uuid
      AND tr.tournament_id='e4100000-0000-4000-8000-000000000004'
      AND tr.source_wallet_club_id='e4100000-0000-4000-8000-000000000002'
      AND tr.refund_prize=180 AND tr.refund_bounty=0 AND tr.refund_fee=20
      AND l.from_type='prize_liability' AND l.from_entity_id=tr.tournament_id
      AND l.to_type='player_wallet' AND l.to_entity_id=tr.user_id
      AND l.club_id=tr.source_wallet_club_id AND l.amount=200
      AND w.related_entity_id=tr.tournament_id AND w.user_id=tr.user_id AND w.amount=200)
  AND (SELECT count(*)=1 FROM public.rake_records
    WHERE tournament_id='e4100000-0000-4000-8000-000000000004'
      AND source='atomic_cancel_tournament' AND rake_amount=-20
      AND club_id='e4100000-0000-4000-8000-000000000002'
      AND metadata->>'kind'='tournament_fee_refund')
  AND EXISTS(SELECT 1 FROM public.tournaments WHERE id='e4100000-0000-4000-8000-000000000004'
    AND status='CANCELLED' AND current_players=0 AND prize_pool=0 AND bounty_pool=0 AND total_rake=0)
  AND EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id='e4100000-0000-4000-8000-000000000004'
    AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0 AND closed_at IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM public.tournament_tickets WHERE source_refund_entitlement_id=(entry->>'entitlement_id')::uuid),
  'the actually redeemed 200-chip ticket cancels as 200 cash to its immutable club wallet, reverses the exact 20 fee and closes escrow without a replacement ticket');
END $exact_cash$;
DO $historical_evidence$
DECLARE current_origin jsonb; current_issue text;
BEGIN
 SELECT jsonb_build_object(
  'ticket',(SELECT to_jsonb(t) FROM public.tournament_tickets t WHERE id='e4100000-0000-4000-8000-000000000008'),
  'entitlement',(SELECT to_jsonb(e) FROM public.tournament_refund_entitlements e
   WHERE id=((SELECT value FROM existing_ticket_results WHERE name='entry')->>'entitlement_id')::uuid),
  'admission_ledger',(SELECT to_jsonb(l) FROM public.chip_ledger l JOIN public.tournament_refund_entitlements e ON e.source_ledger_id=l.id
   WHERE e.id=((SELECT value FROM existing_ticket_results WHERE name='entry')->>'entitlement_id')::uuid)) INTO current_origin;
 SELECT md5(jsonb_build_object(
  'ticket',(SELECT to_jsonb(t)-'status'-'redeemed_at' FROM public.tournament_tickets t WHERE id='e4100000-0000-4000-8000-000000000008'),
  'issue_ledger',(SELECT to_jsonb(l) FROM public.chip_ledger l WHERE id='e4100000-0000-4000-8000-000000000010'),
  'issue_receipt',(SELECT to_jsonb(t) FROM public.chip_transactions t WHERE transaction_type='tournament_ticket_issue'
   AND metadata->>'ticket_id'='e4100000-0000-4000-8000-000000000008'))::text) INTO current_issue;
 PERFORM pg_temp.ticket_cancel_assert(current_origin=(SELECT evidence FROM ticket_cancel_origin)
   AND current_issue=(SELECT fingerprint FROM existing_ticket_issue_before)
   AND current_origin->'ticket'->>'status'='redeemed',
  'cancellation preserves the original redeemed ticket, issue journal, issue receipt, immutable admission entitlement and funding journal exactly');
END $historical_evidence$;
DO $cancel_replay$
DECLARE first_receipt jsonb:=(SELECT value FROM ticket_cancel_results WHERE name='first');
 before_state text:=pg_temp.ticket_cancel_state(); replay jsonb; verified jsonb;
BEGIN
 replay:=public.atomic_cancel_tournament('e4100000-0000-4000-8000-000000000004',NULL);
 verified:=public.fn_ca_tournament_cancellation_receipt('e4100000-0000-4000-8000-000000000004',NULL);
 PERFORM pg_temp.ticket_cancel_assert(replay=first_receipt AND verified=first_receipt
   AND pg_temp.ticket_cancel_state()=before_state,
  'redeemed-ticket cancellation replay and durable verifier return the same receipt without another cash movement');
END $cancel_replay$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'EXISTING_TICKET_CANCELLATION_NATIVE_EVIDENCE='||jsonb_build_object(
 'entry',(SELECT value FROM existing_ticket_results WHERE name='entry'),
 'cancellation',(SELECT value FROM ticket_cancel_results WHERE name='first'),
 'origin',(SELECT evidence FROM ticket_cancel_origin))::text;
