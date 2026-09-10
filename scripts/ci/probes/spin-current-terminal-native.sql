-- Accepted final-hand fixture: the remaining player busts; 3000 chips stay with the champion.
SET LOCAL session_replication_role=replica;
INSERT INTO public.users(id,username)
 SELECT md5('zero-default-spin-launch-user:'||i)::uuid,'zero_default_native_user_'||i
 FROM generate_series(1,3) g(i);
UPDATE public.tournament_players SET
 chips=CASE WHEN user_id=md5('zero-default-spin-launch-user:3')::uuid THEN 3000 ELSE 0 END,
 status=CASE WHEN user_id=md5('zero-default-spin-launch-user:3')::uuid THEN 'playing' ELSE 'eliminated' END,
 position=CASE WHEN user_id=md5('zero-default-spin-launch-user:1')::uuid THEN 3 WHEN user_id=md5('zero-default-spin-launch-user:2')::uuid THEN 2 ELSE NULL END,
 elimination_sequence=CASE WHEN user_id=md5('zero-default-spin-launch-user:1')::uuid THEN 1 WHEN user_id=md5('zero-default-spin-launch-user:2')::uuid THEN 2 ELSE NULL END,
 eliminated_at=CASE WHEN user_id=md5('zero-default-spin-launch-user:3')::uuid THEN NULL ELSE now() END
 WHERE tournament_id='92010000-0000-0000-0000-000000000001';
UPDATE public.table_seats SET stack=CASE WHEN seat_number=3 THEN 3000 ELSE 0 END
 WHERE table_id='92020000-0000-0000-0000-000000000001';
UPDATE public.tournaments SET current_players=1
 WHERE id='92010000-0000-0000-0000-000000000001';
SET LOCAL session_replication_role=origin;

-- Derive the acceptance oracle from the immutable funded draw contract.
-- The current cash calculator must independently agree with every recipient.
CREATE TEMP TABLE native_spin_expected_payouts ON COMMIT DROP AS
SELECT (a->>'place')::integer AS place,tp.user_id,
 round((r.receipt->>'prize_pool')::numeric*(a->>'percentage')::numeric/100,2) AS amount
FROM native_spin_result r CROSS JOIN LATERAL jsonb_array_elements(r.receipt->'payout_structure') a
JOIN public.tournament_players tp ON tp.tournament_id='92010000-0000-0000-0000-000000000001'
 AND CASE WHEN tp.status='playing' THEN 1 ELSE tp.position END=(a->>'place')::integer;
DO $funded_contract$
BEGIN
 IF (SELECT sum(amount) FROM native_spin_expected_payouts) IS DISTINCT FROM
      (SELECT (receipt->>'prize_pool')::numeric FROM native_spin_result)
  OR EXISTS(SELECT 1 FROM native_spin_expected_payouts WHERE amount<=0)
  OR EXISTS(SELECT place,amount FROM native_spin_expected_payouts
    EXCEPT ALL SELECT place,amount FROM public.fn_ca_tournament_place_amounts('92010000-0000-0000-0000-000000000001'))
  OR EXISTS(SELECT place,amount FROM public.fn_ca_tournament_place_amounts('92010000-0000-0000-0000-000000000001')
    EXCEPT ALL SELECT place,amount FROM native_spin_expected_payouts)
 THEN RAISE EXCEPTION 'FAIL native cash calculator differs from the funded immutable draw ladder'; END IF;
END $funded_contract$;

-- Observe real capability rows without authorizing any seat ourselves.
CREATE TEMP TABLE native_spin_terminal_expected_seats ON COMMIT DROP AS
SELECT s.id AS seat_id,s.user_id,t.tournament_id
FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
WHERE t.tournament_id='92010000-0000-0000-0000-000000000001' AND s.left_at IS NULL;
CREATE TEMP TABLE native_spin_terminal_authority_events (
 action text NOT NULL, capability jsonb NOT NULL
) ON COMMIT DROP;
CREATE FUNCTION pg_temp.spin_terminal_authority_observer() RETURNS trigger
LANGUAGE plpgsql AS $observer$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.tournament_id='92010000-0000-0000-0000-000000000001' THEN
   INSERT INTO native_spin_terminal_authority_events VALUES ('INSERT',to_jsonb(NEW));
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.tournament_id='92010000-0000-0000-0000-000000000001' THEN
  INSERT INTO native_spin_terminal_authority_events VALUES ('DELETE',to_jsonb(OLD));
 END IF;
 RETURN OLD;
END $observer$;
CREATE TRIGGER native_spin_terminal_authority_observer
AFTER INSERT OR DELETE ON public.tournament_seat_exit_authorizations
FOR EACH ROW EXECUTE FUNCTION pg_temp.spin_terminal_authority_observer();

CREATE FUNCTION pg_temp.assert_spin_terminal_authority() RETURNS void
LANGUAGE plpgsql AS $assert_authority$
BEGIN
 IF (SELECT count(*) FROM native_spin_terminal_authority_events WHERE action='INSERT')<>(SELECT count(*) FROM native_spin_terminal_expected_seats)
  OR (SELECT count(*) FROM native_spin_terminal_authority_events WHERE action='DELETE')<>(SELECT count(*) FROM native_spin_terminal_expected_seats)
  OR (SELECT count(DISTINCT capability->>'token') FROM native_spin_terminal_authority_events)<>LEAST((SELECT count(*) FROM native_spin_terminal_expected_seats),1)
  OR EXISTS(SELECT 1 FROM native_spin_terminal_authority_events e
   WHERE e.capability->>'operation'<>'terminal_finish'
    OR e.capability->>'tournament_id'<>'92010000-0000-0000-0000-000000000001'
    OR NOT EXISTS(SELECT 1 FROM native_spin_terminal_expected_seats s
      WHERE s.seat_id=(e.capability->>'seat_id')::uuid
       AND s.user_id=(e.capability->>'user_id')::uuid
       AND s.tournament_id=(e.capability->>'tournament_id')::uuid))
  OR EXISTS(SELECT capability FROM native_spin_terminal_authority_events WHERE action='INSERT'
            EXCEPT ALL SELECT capability FROM native_spin_terminal_authority_events WHERE action='DELETE')
  OR EXISTS(SELECT 1 FROM public.tournament_seat_exit_authorizations
            WHERE tournament_id='92010000-0000-0000-0000-000000000001')
 THEN RAISE EXCEPTION 'FAIL exact per-seat authority rows were not minted and consumed'; END IF;
END $assert_authority$;

CREATE FUNCTION pg_temp.spin_terminal_state() RETURNS jsonb LANGUAGE sql STABLE AS $state$
SELECT jsonb_build_object(
 'launch',pg_temp.native_spin_state(),
 'authority_rows',(SELECT jsonb_agg(to_jsonb(t) ORDER BY token,seat_id)
   FROM public.tournament_seat_exit_authorizations t),
 'authority_observation',(SELECT jsonb_agg(to_jsonb(t) ORDER BY action,capability::text)
   FROM native_spin_terminal_authority_events t),
 'authority_settings',jsonb_build_array(
   COALESCE(current_setting('app.tournament_seat_exit_token',true),''),
   COALESCE(current_setting('app.tournament_seat_exit_operation',true),'')),
 'tournament',(SELECT to_jsonb(t) FROM public.tournaments t WHERE id='92010000-0000-0000-0000-000000000001'),
 'players',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_players t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'obligations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_obligations t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'payouts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_payouts t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'place_batch',(SELECT to_jsonb(t) FROM public.tournament_place_settlement_batches t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'terminal_receipt',(SELECT to_jsonb(t) FROM public.tournament_terminal_settlements t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'finish_receipt',(SELECT to_jsonb(t) FROM public.tournament_finish_receipts t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'wallet_transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.wallet_transactions t WHERE related_entity_id='92010000-0000-0000-0000-000000000001'),
 'member_wallets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM public.club_members t WHERE club_id='92000000-0000-0000-0000-000000000001'),
 'club',(SELECT to_jsonb(t) FROM public.clubs t WHERE id='92000000-0000-0000-0000-000000000001'),
 'club_wallet',(SELECT to_jsonb(t) FROM public.club_wallets t WHERE club_id='92000000-0000-0000-0000-000000000001'),
 'rake',(SELECT to_jsonb(t) FROM public.tournament_rake_settlements t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'tables',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tables t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'seats',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.table_seats t WHERE table_id='92020000-0000-0000-0000-000000000001'));
$state$;

DO $claim$
DECLARE result jsonb;
BEGIN
 result:=public.fn_claim_tournament_finish('92010000-0000-0000-0000-000000000001',md5('zero-default-spin-launch-user:3')::uuid,'native-spin-terminal-probe');
 IF result->>'ok' IS DISTINCT FROM 'true' OR result->>'status' IS DISTINCT FROM 'COMPLETING' THEN
  RAISE EXCEPTION 'FAIL native Spin finish claim: %',result;
 END IF;
END $claim$;

CREATE FUNCTION pg_temp.spin_terminal_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
 IF NEW.tournament_id='92010000-0000-0000-0000-000000000001' THEN
  IF NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=NEW.tournament_id
       AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0 AND closed_at IS NOT NULL)
   OR NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=NEW.tournament_id
       AND amount=.24 AND settled_at IS NOT NULL AND attributed_at IS NOT NULL AND attributed_users=3)
   OR (SELECT count(*) FROM public.tournament_payouts WHERE tournament_id=NEW.tournament_id)<>(SELECT count(*) FROM native_spin_expected_payouts)
   OR (SELECT status FROM public.tournaments WHERE id=NEW.tournament_id)<>'COMPLETED'
   OR EXISTS(SELECT 1 FROM public.tables WHERE tournament_id=NEW.tournament_id AND (status<>'closed' OR lifecycle<>'closed'))
   OR EXISTS(SELECT 1 FROM public.table_seats WHERE table_id='92020000-0000-0000-0000-000000000001' AND left_at IS NULL) THEN
   RAISE EXCEPTION 'FAIL final terminal receipt did not follow exact Spin money and closure: %',
    jsonb_build_object(
     'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE tournament_id=NEW.tournament_id),
     'rake',(SELECT to_jsonb(r) FROM public.tournament_rake_settlements r WHERE tournament_id=NEW.tournament_id),
     'payout_count',(SELECT count(*) FROM public.tournament_payouts WHERE tournament_id=NEW.tournament_id),
     'status',(SELECT status FROM public.tournaments WHERE id=NEW.tournament_id),
     'spin_multiplier',(SELECT spin_multiplier FROM public.tournaments WHERE id=NEW.tournament_id),
     'tables',(SELECT jsonb_agg(jsonb_build_object('status',status,'lifecycle',lifecycle)) FROM public.tables WHERE tournament_id=NEW.tournament_id),
     'live_seats',(SELECT count(*) FROM public.table_seats WHERE table_id='92020000-0000-0000-0000-000000000001' AND left_at IS NULL));
  END IF;
  PERFORM pg_temp.assert_spin_terminal_authority();
  IF current_setting('app.tournament_seat_exit_operation',true) IS DISTINCT FROM 'terminal_finish'
   OR current_setting('app.tournament_seat_exit_token',true) IS DISTINCT FROM
      (SELECT capability->>'token' FROM native_spin_terminal_authority_events LIMIT 1)
  THEN RAISE EXCEPTION 'FAIL final receipt is outside its seat authority scope'; END IF;
  RAISE EXCEPTION 'expected final native Spin terminal receipt fault' USING ERRCODE='ZX004';
 END IF;
 RETURN NEW;
END $fault$;
CREATE TRIGGER native_spin_terminal_receipt_fault AFTER INSERT ON public.tournament_terminal_settlements
FOR EACH ROW EXECUTE FUNCTION pg_temp.spin_terminal_receipt_fault();
DO $rollback$
DECLARE before_state jsonb:=pg_temp.spin_terminal_state(); refused boolean:=false;
BEGIN
 BEGIN PERFORM public.fn_complete_tournament_terminal('92010000-0000-0000-0000-000000000001',md5('zero-default-spin-launch-user:3')::uuid,'places');
 EXCEPTION WHEN SQLSTATE 'ZX004' THEN refused:=true; END;
 IF NOT refused OR pg_temp.spin_terminal_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL final native Spin terminal fault retained partial money or closure';
 END IF;
END $rollback$;
DROP TRIGGER native_spin_terminal_receipt_fault ON public.tournament_terminal_settlements;
DROP FUNCTION pg_temp.spin_terminal_receipt_fault();
DO $settle$
DECLARE result jsonb; replay jsonb; outcome jsonb; before_state jsonb; v_prize numeric;
BEGIN
 SELECT (receipt->>'prize_pool')::numeric INTO v_prize FROM native_spin_result;
 result:=public.fn_complete_tournament_terminal('92010000-0000-0000-0000-000000000001',md5('zero-default-spin-launch-user:3')::uuid,'places');
 IF result->>'ok' IS DISTINCT FROM 'true' OR result->>'fully_settled' IS DISTINCT FROM 'true'
  OR result->>'status' IS DISTINCT FROM 'COMPLETED'
  OR NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id='92010000-0000-0000-0000-000000000001' AND status='winner' AND position=1 AND prize=(SELECT amount FROM native_spin_expected_payouts WHERE place=1))
  OR (SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id='92010000-0000-0000-0000-000000000001') IS DISTINCT FROM v_prize
  OR (SELECT count(*) FROM public.tournament_payouts WHERE tournament_id='92010000-0000-0000-0000-000000000001')<>(SELECT count(*) FROM native_spin_expected_payouts)
  OR EXISTS(SELECT 1 FROM native_spin_expected_payouts e
    LEFT JOIN public.tournament_payouts p ON p.tournament_id='92010000-0000-0000-0000-000000000001'
     AND p.position=e.place AND p.user_id=e.user_id
    LEFT JOIN public.tournament_players tp ON tp.tournament_id=p.tournament_id AND tp.user_id=p.user_id
    WHERE p.id IS NULL OR p.amount IS DISTINCT FROM e.amount OR tp.prize IS DISTINCT FROM e.amount)
  OR EXISTS(SELECT 1 FROM public.tournament_obligations WHERE tournament_id='92010000-0000-0000-0000-000000000001' AND (amount_paid IS DISTINCT FROM amount_owed OR settled_at IS NULL)) THEN
  RAISE EXCEPTION 'FAIL current native Spin terminal settlement: %',result;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournament_place_settlement_batches
   WHERE tournament_id='92010000-0000-0000-0000-000000000001'
     AND contract_version=2 AND settled_at IS NOT NULL)
  OR (public.fn_ca_verify_terminal_place_batch('92010000-0000-0000-0000-000000000001',true)->>'ok') IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'FAIL completed Spin has no verified immutable version-2 place batch'; END IF;
 PERFORM pg_temp.assert_spin_terminal_authority();
 IF COALESCE(current_setting('app.tournament_seat_exit_token',true),'')<>''
  OR COALESCE(current_setting('app.tournament_seat_exit_operation',true),'')<>''
 THEN RAISE EXCEPTION 'FAIL terminal wrapper left capability settings behind'; END IF;
 before_state:=pg_temp.spin_terminal_state();
 replay:=public.fn_complete_tournament_terminal('92010000-0000-0000-0000-000000000001',md5('zero-default-spin-launch-user:3')::uuid,'places');
 outcome:=public.fn_resolve_tournament_terminal_outcome('92010000-0000-0000-0000-000000000001',md5('zero-default-spin-launch-user:3')::uuid,'places');
 IF replay->>'ok' IS DISTINCT FROM 'true' OR replay->>'fully_settled' IS DISTINCT FROM 'true'
  OR outcome->>'terminal_committed' IS DISTINCT FROM 'true'
  OR outcome->>'definitively_not_committed' IS DISTINCT FROM 'false'
  OR outcome->'receipt' IS DISTINCT FROM result
  OR replay IS DISTINCT FROM result
  OR pg_temp.spin_terminal_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL native Spin terminal retry or resolver changed financial state: % / %',replay,outcome;
 END IF;
END $settle$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'NATIVE_TERMINAL_EVIDENCE=' || jsonb_build_object(
 'draw_multiplier',(SELECT (receipt->>'multiplier')::numeric FROM native_spin_result),
 'approved_payout_structure',(SELECT receipt->'payout_structure' FROM native_spin_result),
 'expected_payouts',(SELECT jsonb_agg(jsonb_build_object('place',place,'amount',amount) ORDER BY place) FROM native_spin_expected_payouts),
 'tournament_status',(SELECT status FROM public.tournaments WHERE id='92010000-0000-0000-0000-000000000001'),
 'batch',(SELECT jsonb_build_object('contract_version',contract_version,'mode',mode,
   'place_count',place_count,'place_amount_owed',amount_owed,
   'bubble_enabled',bubble_contract_required,'bubble_amount_owed',bubble_amount_owed,
   'settled',settled_at IS NOT NULL,'plan_fingerprint',plan_fingerprint)
   FROM public.tournament_place_settlement_batches WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'payout_count',(SELECT count(*) FROM public.tournament_payouts WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'payout_total',(SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'escrow',(SELECT jsonb_build_object('prize_balance',prize_balance,'bounty_balance',bounty_balance,
   'fee_balance',fee_balance,'closed',closed_at IS NOT NULL) FROM public.tournament_escrow
   WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'rake',(SELECT jsonb_build_object('amount',amount,'settled',settled_at IS NOT NULL,
   'attributed',attributed_at IS NOT NULL,'attributed_users',attributed_users)
   FROM public.tournament_rake_settlements WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'expected_live_seats',(SELECT count(*) FROM native_spin_terminal_expected_seats),
 'capability_insert_count',(SELECT count(*) FROM native_spin_terminal_authority_events WHERE action='INSERT'),
 'capability_delete_count',(SELECT count(*) FROM native_spin_terminal_authority_events WHERE action='DELETE'),
 'capability_token_count',(SELECT count(DISTINCT capability->>'token') FROM native_spin_terminal_authority_events),
 'capability_rows_remaining',(SELECT count(*) FROM public.tournament_seat_exit_authorizations
   WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'capability_settings_cleared',COALESCE(current_setting('app.tournament_seat_exit_token',true),'')=''
   AND COALESCE(current_setting('app.tournament_seat_exit_operation',true),'')='',
 'deferred_constraints_forced',true
)::text;
DO $pass$ BEGIN RAISE EXCEPTION 'AUDIT_TEST_PASS: current native Spin zero-default draw, launch, final cash payout, rake attribution, exact-zero escrow, table and seat closure with exact per-seat authority consumption, late terminal receipt rollback and immutable terminal replay passed; outer transaction rolls back'; END $pass$;
