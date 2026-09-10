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

CREATE FUNCTION pg_temp.spin_terminal_state() RETURNS jsonb LANGUAGE sql STABLE AS $state$
SELECT jsonb_build_object(
 'launch',pg_temp.native_spin_state(),
 'tournament',(SELECT to_jsonb(t) FROM public.tournaments t WHERE id='92010000-0000-0000-0000-000000000001'),
 'players',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_players t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'obligations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_obligations t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'payouts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_payouts t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
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
   OR (SELECT count(*) FROM public.tournament_payouts WHERE tournament_id=NEW.tournament_id)<>1
   OR (SELECT status FROM public.tournaments WHERE id=NEW.tournament_id)<>'COMPLETED'
   OR EXISTS(SELECT 1 FROM public.tables WHERE tournament_id=NEW.tournament_id AND (status<>'closed' OR lifecycle<>'closed'))
   OR EXISTS(SELECT 1 FROM public.table_seats WHERE table_id='92020000-0000-0000-0000-000000000001' AND left_at IS NULL) THEN
   RAISE EXCEPTION 'FAIL final terminal receipt did not follow exact Spin money and closure';
  END IF;
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
  OR NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id='92010000-0000-0000-0000-000000000001' AND status='winner' AND position=1 AND prize=v_prize)
  OR (SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id='92010000-0000-0000-0000-000000000001') IS DISTINCT FROM v_prize
  OR (SELECT count(*) FROM public.tournament_payouts WHERE tournament_id='92010000-0000-0000-0000-000000000001')<>1
  OR EXISTS(SELECT 1 FROM public.tournament_obligations WHERE tournament_id='92010000-0000-0000-0000-000000000001' AND (amount_paid IS DISTINCT FROM amount_owed OR settled_at IS NULL)) THEN
  RAISE EXCEPTION 'FAIL current native Spin terminal settlement: %',result;
 END IF;
 before_state:=pg_temp.spin_terminal_state();
 replay:=public.fn_complete_tournament_terminal('92010000-0000-0000-0000-000000000001',md5('zero-default-spin-launch-user:3')::uuid,'places');
 outcome:=public.fn_resolve_tournament_terminal_outcome('92010000-0000-0000-0000-000000000001',md5('zero-default-spin-launch-user:3')::uuid,'places');
 IF replay->>'ok' IS DISTINCT FROM 'true' OR replay->>'fully_settled' IS DISTINCT FROM 'true'
  OR outcome->>'outcome' IS DISTINCT FROM 'committed'
  OR pg_temp.spin_terminal_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL native Spin terminal retry or resolver changed financial state: % / %',replay,outcome;
 END IF;
END $settle$;
DO $pass$ BEGIN RAISE EXCEPTION 'AUDIT_TEST_PASS: current native Spin zero-default draw, launch, final cash payout, rake attribution, exact-zero escrow, table and seat closure, late terminal receipt rollback and immutable terminal replay passed; outer transaction rolls back'; END $pass$;
