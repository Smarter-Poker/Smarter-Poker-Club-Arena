-- Reuse the unchanged historical200 issue fixture and its actual redemption.
-- The old current cancellation must really issue the returned ticket. Its
-- redemption uses the already-existing matching-price target005. No new source
-- award, ticket issue, escrow funding or registration is fabricated here.
-- @RESTORE_INITIALLY_DEFERRED@
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true);
INSERT INTO public.ca_settle_sources(source,note)
 VALUES('atomic_cancel_tournament','DB caller') ON CONFLICT(source) DO NOTHING;
CREATE TEMP TABLE returned_chain_results(name text PRIMARY KEY,value jsonb NOT NULL) ON COMMIT DROP;
GRANT INSERT,SELECT ON returned_chain_results TO service_role,authenticated;
CREATE FUNCTION pg_temp.returned_chain_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
 RAISE NOTICE 'AUDIT_TEST_PASS: %',label;
END $assert$;
-- @TICKET_CANCEL_FINGERPRINT@
DO $old_writer_identity$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.atomic_cancel_tournament(uuid,uuid)'::regprocedure)
   IS DISTINCT FROM '16ea7acbbf76613a0a1193dff18f1330' THEN
  RAISE EXCEPTION 'legacy return chain requires the actual pre-policy cancellation writer'; END IF;
END $old_writer_identity$;
SET LOCAL ROLE service_role;
INSERT INTO returned_chain_results VALUES('legacy_cancel',public.atomic_cancel_tournament('e4100000-0000-4000-8000-000000000004',NULL));
RESET ROLE;
DO $actual_return$
DECLARE r jsonb:=(SELECT value FROM returned_chain_results WHERE name='legacy_cancel');
 entry jsonb:=(SELECT value FROM existing_ticket_results WHERE name='entry');
BEGIN
 PERFORM pg_temp.returned_chain_assert(r->>'ok'='true' AND r->>'fully_settled'='true'
  AND r->>'status'='CANCELLED' AND (r->>'total_refunded')::numeric=0
  AND (r->>'total_ticket_returned')::numeric=200 AND (r->>'ticket_return_count')::integer=1
  AND (r->>'fees_reversed')::numeric=20
  AND (SELECT count(*)=1 FROM public.tournament_tickets tk JOIN public.chip_ledger l
    ON l.to_entity_id=tk.id AND l.to_type='escrow' AND l.category='ticket_issue'
    WHERE tk.source_refund_entitlement_id=(entry->>'entitlement_id')::uuid
      AND tk.source_tournament_id='e4100000-0000-4000-8000-000000000004'
      AND tk.source_satellite_award_place IS NULL AND tk.value=200 AND tk.status='issued'
      AND tk.redemption_mode='tournament_entry_only' AND tk.entry_prize=180 AND tk.entry_bounty=0 AND tk.entry_fee=20
      AND l.from_type='prize_liability' AND l.from_entity_id=tk.source_tournament_id
      AND l.club_id=tk.club_id AND l.amount=200)
  AND NOT EXISTS(SELECT 1 FROM public.wallet_transactions WHERE user_id='e4100000-0000-4000-8000-000000000001')
  AND EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id='e4100000-0000-4000-8000-000000000004'
    AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0 AND closed_at IS NOT NULL),
  'actual old cancellation converts the consumed200 ticket entry into one genuinely funded returned200 ticket and closes its source target without cash');
END $actual_return$;
-- Capture the real returned ID as owner, then pass only that fixture input
-- through the granted temp result table to the authenticated public RPC.
INSERT INTO returned_chain_results SELECT 'issued_return_ticket',jsonb_build_object('ticket_id',tk.id)
 FROM public.tournament_tickets tk WHERE tk.source_refund_entitlement_id=
 ((SELECT value FROM existing_ticket_results WHERE name='entry')->>'entitlement_id')::uuid;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub','e4100000-0000-4000-8000-000000000001',
 'role','authenticated','session_id','e4300000-0000-4000-8000-000000000001')::text,true),
 set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;
INSERT INTO returned_chain_results VALUES('returned_entry',public.fn_register_for_tournament_with_ticket(
 'e4100000-0000-4000-8000-000000000005',
 ((SELECT value FROM returned_chain_results WHERE name='issued_return_ticket')->>'ticket_id')::uuid));
RESET ROLE;
DO $actual_returned_admission$
DECLARE e jsonb:=(SELECT value FROM returned_chain_results WHERE name='returned_entry');
BEGIN
 PERFORM pg_temp.returned_chain_assert(e->>'ok'='true' AND e->>'replayed'='false'
  AND (e->>'ticket_value')::numeric=200 AND (e->>'wallet_chips_credited')::numeric=0
  AND EXISTS(SELECT 1 FROM public.tournament_refund_entitlements ent JOIN public.chip_ledger l ON l.id=ent.source_ledger_id
    JOIN public.tournament_tickets tk ON tk.id=ent.source_ticket_id
    WHERE ent.id=(e->>'entitlement_id')::uuid AND ent.entitlement_kind='tournament_ticket'
      AND ent.tournament_id='e4100000-0000-4000-8000-000000000005'
      AND ent.registration_id=(e->>'registration_id')::uuid AND ent.source_ticket_id=(e->>'ticket_id')::uuid
      AND ent.gross=200 AND ent.refund_prize=180 AND ent.refund_bounty=0 AND ent.refund_fee=20
      AND ent.refund_wallet_club_id='e4100000-0000-4000-8000-000000000002'
      AND tk.source_refund_entitlement_id IS NOT NULL AND tk.status='redeemed'
      AND l.from_type='escrow' AND l.from_entity_id=tk.id AND l.to_type='prize_liability'
      AND l.to_entity_id=ent.tournament_id AND l.amount=200 AND l.category='ticket_redeem')
  AND EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id='e4100000-0000-4000-8000-000000000005'
    AND prize_balance=180 AND bounty_balance=0 AND fee_balance=20)
  AND (SELECT chip_balance=0 FROM public.club_members WHERE club_id='e4100000-0000-4000-8000-000000000002'
    AND user_id='e4100000-0000-4000-8000-000000000001'),
  'actual returned-ticket admission moves the same200 liability into target005 as a proved tournament_ticket entitlement with180/20 rails and no wallet movement');
END $actual_returned_admission$;
CREATE TEMP TABLE returned_chain_origin AS SELECT jsonb_build_object(
 'tickets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.tournament_tickets t),
 'entitlements',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.tournament_refund_entitlements e),
 'ticket_journals',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.chip_ledger l WHERE category IN ('ticket_issue','ticket_redeem')),
 'chip_transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.chip_transactions t WHERE transaction_type IN ('tournament_ticket_issue','tournament_ticket_entry'))
 ) AS evidence;
-- Install only the real candidate after the actual historical return exists.
-- @CASH_POLICY_CANDIDATE@
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true);
DO $historical_replay_after_cutover$
DECLARE old_receipt jsonb:=(SELECT value FROM returned_chain_results WHERE name='legacy_cancel');
 before_state text:=pg_temp.ticket_cancel_state(); replay jsonb; verified jsonb;
BEGIN
 replay:=public.atomic_cancel_tournament('e4100000-0000-4000-8000-000000000004',NULL);
 verified:=public.fn_ca_tournament_cancellation_receipt('e4100000-0000-4000-8000-000000000004',NULL);
 PERFORM pg_temp.returned_chain_assert(replay=old_receipt AND verified=old_receipt AND before_state=pg_temp.ticket_cancel_state(),
  'after cash-policy installation and returned-ticket redemption the historical ticket-return cancellation still replays byte-identically without paying cash');
END $historical_replay_after_cutover$;
CREATE FUNCTION pg_temp.refuse_last_returned_chain_receipt() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
 IF NEW.tournament_id='e4100000-0000-4000-8000-000000000005' THEN
  IF NEW.total_refunded<>200 OR NEW.total_ticket_returned<>0 OR NEW.refund_line_count<>1
    OR NEW.ticket_return_count<>0 OR NEW.fees_reversed<>20
    OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=NEW.tournament_id
      AND closed_at IS NOT NULL AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0)
    OR (SELECT chip_balance FROM public.club_members WHERE club_id='e4100000-0000-4000-8000-000000000002'
      AND user_id='e4100000-0000-4000-8000-000000000001') IS DISTINCT FROM 200::numeric THEN
   RAISE EXCEPTION 'returned-ticket chain last receipt has wrong cash/fee/escrow'; END IF;
  RAISE EXCEPTION 'injected returned-ticket chain final receipt fault' USING ERRCODE='PZ014';
 END IF;
 RETURN NEW;
END $fault$;
CREATE TRIGGER native_refuse_last_returned_chain_receipt BEFORE INSERT ON public.tournament_cancellation_receipts
 FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_last_returned_chain_receipt();
DO $late_rollback$
DECLARE before_state text:=pg_temp.ticket_cancel_state(); refused boolean:=false;
BEGIN
 BEGIN
  PERFORM public.atomic_cancel_tournament('e4100000-0000-4000-8000-000000000005',NULL);
 EXCEPTION WHEN SQLSTATE 'PZ014' THEN refused:=true; END;
 PERFORM pg_temp.returned_chain_assert(refused AND before_state=pg_temp.ticket_cancel_state(),
  'returned-ticket cash cancellation reaches its final receipt after real money work and a late fault restores the complete chain');
END $late_rollback$;
DROP TRIGGER native_refuse_last_returned_chain_receipt ON public.tournament_cancellation_receipts;
SET LOCAL ROLE service_role;
INSERT INTO returned_chain_results VALUES('cash_cancel',public.atomic_cancel_tournament('e4100000-0000-4000-8000-000000000005',NULL));
RESET ROLE;
DO $cash_outcome$
DECLARE r jsonb:=(SELECT value FROM returned_chain_results WHERE name='cash_cancel');
 entry jsonb:=(SELECT value FROM returned_chain_results WHERE name='returned_entry');
 old_ent uuid:=((SELECT value FROM existing_ticket_results WHERE name='entry')->>'entitlement_id')::uuid;
 current_origin jsonb;
BEGIN
 SELECT jsonb_build_object(
  'tickets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.tournament_tickets t),
  'entitlements',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.tournament_refund_entitlements e),
  'ticket_journals',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.chip_ledger l WHERE category IN ('ticket_issue','ticket_redeem')),
  'chip_transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.chip_transactions t WHERE transaction_type IN ('tournament_ticket_issue','tournament_ticket_entry'))) INTO current_origin;
 PERFORM pg_temp.returned_chain_assert(r->>'ok'='true' AND r->>'fully_settled'='true' AND r->>'status'='CANCELLED'
  AND (r->>'total_refunded')::numeric=200 AND (r->>'total_ticket_returned')::numeric=0
  AND (r->>'ticket_return_count')::integer=0 AND (r->>'fees_reversed')::numeric=20
  AND (SELECT chip_balance=200 FROM public.club_members WHERE club_id='e4100000-0000-4000-8000-000000000002'
    AND user_id='e4100000-0000-4000-8000-000000000001')
  AND EXISTS(SELECT 1 FROM public.tournament_refund_tranches tr JOIN public.chip_ledger l ON l.id=tr.credit_ledger_id
    JOIN public.wallet_transactions w ON w.id=tr.wallet_transaction_id
    WHERE tr.entitlement_id=(entry->>'entitlement_id')::uuid
      AND tr.source_wallet_club_id='e4100000-0000-4000-8000-000000000002'
      AND tr.refund_prize=180 AND tr.refund_bounty=0 AND tr.refund_fee=20
      AND l.from_type='prize_liability' AND l.from_entity_id='e4100000-0000-4000-8000-000000000005'
      AND l.to_type='player_wallet' AND l.to_entity_id=tr.user_id AND l.amount=200 AND l.club_id=tr.source_wallet_club_id
      AND w.related_entity_id=tr.tournament_id AND w.user_id=tr.user_id AND w.type='credit' AND w.amount=200)
  AND (SELECT count(*)=1 FROM public.wallet_transactions WHERE user_id='e4100000-0000-4000-8000-000000000001' AND type='credit')
  AND (SELECT count(*)=1 FROM public.rake_records WHERE tournament_id='e4100000-0000-4000-8000-000000000005'
    AND rake_amount=-20 AND source='atomic_cancel_tournament' AND club_id='e4100000-0000-4000-8000-000000000002')
  AND NOT EXISTS(SELECT 1 FROM public.tournament_refund_tranches WHERE entitlement_id=old_ent)
  AND NOT EXISTS(SELECT 1 FROM public.tournament_tickets WHERE source_refund_entitlement_id=(entry->>'entitlement_id')::uuid)
  AND EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id='e4100000-0000-4000-8000-000000000005'
    AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0 AND closed_at IS NOT NULL)
  AND current_origin=(SELECT evidence FROM returned_chain_origin),
  'returned-ticket cancellation pays exactly200 cash with20 fee reversal, preserves both consumed tickets and both admission/issue histories, and cannot pay the old returned entitlement again');
END $cash_outcome$;
DO $both_receipts_replay$
DECLARE before_state text:=pg_temp.ticket_cancel_state(); old_receipt jsonb:=(SELECT value FROM returned_chain_results WHERE name='legacy_cancel');
 new_receipt jsonb:=(SELECT value FROM returned_chain_results WHERE name='cash_cancel');
BEGIN
 PERFORM pg_temp.returned_chain_assert(
  public.atomic_cancel_tournament('e4100000-0000-4000-8000-000000000004',NULL)=old_receipt
  AND public.fn_ca_tournament_cancellation_receipt('e4100000-0000-4000-8000-000000000004',NULL)=old_receipt
  AND public.atomic_cancel_tournament('e4100000-0000-4000-8000-000000000005',NULL)=new_receipt
  AND public.fn_ca_tournament_cancellation_receipt('e4100000-0000-4000-8000-000000000005',NULL)=new_receipt
  AND before_state=pg_temp.ticket_cancel_state(),
  'both the historical ticket-return receipt and new cash receipt replay byte-identically after the complete chain without moving chips');
END $both_receipts_replay$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'EXISTING_TICKET_CANCELLATION_NATIVE_EVIDENCE='||jsonb_build_object(
 'historical_entry',(SELECT value FROM existing_ticket_results WHERE name='entry'),
 'legacy_ticket_return',(SELECT value FROM returned_chain_results WHERE name='legacy_cancel'),
 'actual_returned_ticket_entry',(SELECT value FROM returned_chain_results WHERE name='returned_entry'),
 'cash_cancellation',(SELECT value FROM returned_chain_results WHERE name='cash_cancel'))::text;
