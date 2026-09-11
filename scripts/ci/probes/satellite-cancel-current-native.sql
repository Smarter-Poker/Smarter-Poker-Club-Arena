-- Current funded source settlement followed by target cash cancellation.
-- Both entry charges, full source receipt, award, transfer, target entitlement,
-- terminal closure and refunds use installed authorities. Only the opening
-- final-hand scene is synthetic. All work remains inside one rollback.
\set ON_ERROR_STOP on

-- @FINAL_DEAL_RUNTIME@

SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='8s';

DO $prerequisites$
BEGIN
  IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
     OR to_regprocedure('public.fn_register_for_tournament_request(uuid,uuid)') IS NULL
     OR to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_settle_satellite_tournament(uuid,uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_ca_tournament_cancellation_receipt(uuid,uuid)') IS NULL
     OR to_regclass('public.tournament_cancellation_receipts') IS NULL
     OR to_regclass('public.tournament_refund_entitlements') IS NULL
     OR to_regclass('public.tournament_refund_tranches') IS NULL THEN
    RAISE EXCEPTION
      'entrant cancellation probe requires postgres and the complete installed cancellation authority';
  END IF;
END;
$prerequisites$;

-- Restore only the tracked platform source seed omitted by the schema-only rehearsal.
-- Provenance: 20260905203123, exact tuple ('atomic_cancel_tournament', 'DB caller').
INSERT INTO public.ca_settle_sources(source,note)
VALUES('atomic_cancel_tournament','DB caller') ON CONFLICT(source) DO NOTHING;

-- Only fixture construction is trigger-free. In particular, the cash entry,
-- cancellation, replay verifier, and every immutability attempt below all run
-- with session_replication_role=origin against installed production functions.
SET LOCAL session_replication_role=replica;

INSERT INTO auth.users(id)
VALUES
  ('d1000000-0000-4000-8000-000000000001'),
  ('d1000000-0000-4000-8000-000000000002'),
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d')
ON CONFLICT(id) DO NOTHING;

INSERT INTO public.users(id,username)
VALUES
  ('d1000000-0000-4000-8000-000000000001',
   'cancel_cash_entrant_probe'),
  ('d1000000-0000-4000-8000-000000000002',
   'cancel_satellite_entrant_probe'),
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','smarterpoker')
ON CONFLICT(id) DO NOTHING;

INSERT INTO public.profiles(id,username,display_name)
VALUES
  ('d1000000-0000-4000-8000-000000000001',
   'cancel_cash_entrant_probe','Cancellation Cash Entrant'),
  ('d1000000-0000-4000-8000-000000000002',
   'cancel_satellite_entrant_probe','Cancellation Satellite Entrant')
ON CONFLICT(id) DO NOTHING;

INSERT INTO public.clubs(id,club_id,name)
VALUES
  ('d2000000-0000-4000-8000-000000000001',991001,
   'Cancellation Funding Club'),
  ('d2000000-0000-4000-8000-000000000002',991002,
   'Cancellation Fee Recipient Club');

INSERT INTO public.club_members(
  club_id,user_id,role,status,chip_balance,joined_at)
VALUES
  ('d2000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001',
   'player','active',1000,clock_timestamp()-interval '2 days'),
  ('d2000000-0000-4000-8000-000000000002',
   'd1000000-0000-4000-8000-000000000001',
   'player','active',200,clock_timestamp()-interval '1 day'),
  ('d2000000-0000-4000-8000-000000000002',
   'd1000000-0000-4000-8000-000000000002',
   'player','active',300,clock_timestamp()-interval '1 day');

INSERT INTO public.tournaments(
  id,name,buy_in_amount,buy_in_fee,starting_chips,start_time,status,
  current_players,max_players,current_level,club_id,prize_pool,total_rake,
  bounty_pool,entry_contract_locked,is_rebuy,is_reentry,rebuy_levels,
  late_reg_levels,late_reg_mins)
VALUES
  ('d3000000-0000-4000-8000-000000000001',
   'Cancellation Source Satellite',100,0,1000,
   clock_timestamp()+interval '1 day','REGISTERING',0,9,1,
   'd2000000-0000-4000-8000-000000000002',0,0,0,false,
   false,false,0,0,0),
  ('d3000000-0000-4000-8000-000000000002',
   'Cancellation Entrant Target',90,10,1000,
   clock_timestamp()+interval '1 day','REGISTERING',0,100,1,
   'd2000000-0000-4000-8000-000000000002',0,0,0,false,
   false,false,0,0,0);

INSERT INTO auth.sessions(id,user_id,created_at,updated_at)
VALUES(
  'd4000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001',now(),now()),
  ('d4000000-0000-4000-8000-000000000003',
   'd1000000-0000-4000-8000-000000000002',now(),now());

UPDATE public.tournaments SET satellite_target_id='d3000000-0000-4000-8000-000000000002',
 satellite_target='d3000000-0000-4000-8000-000000000002',satellite_seats=1,
 tournament_type='SATELLITE',variant='satellite'
 WHERE id='d3000000-0000-4000-8000-000000000001';
SET LOCAL session_replication_role=origin;

-- The public production registration door creates the cash player's actual
-- wallet debit, host-club journal, immutable entitlement, target fee record,
-- escrow funding and roster row.
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub','d1000000-0000-4000-8000-000000000001',
    'role','authenticated',
    'session_id','d4000000-0000-4000-8000-000000000001')::text,
  true);

SET LOCAL ROLE authenticated;
CREATE TEMP TABLE cancellation_probe_results(
  name text PRIMARY KEY,
  value jsonb NOT NULL
) ON COMMIT DROP;
INSERT INTO cancellation_probe_results(name,value)
VALUES(
  'registration',
  public.fn_register_for_tournament_request(
    'd3000000-0000-4000-8000-000000000002',
    'd4000000-0000-4000-8000-000000000002'));
RESET ROLE;
GRANT INSERT,SELECT ON cancellation_probe_results TO service_role;

DO $cash_entry_is_exact$
DECLARE
  v_registration jsonb:=(
    SELECT value FROM cancellation_probe_results WHERE name='registration');
BEGIN
  IF COALESCE((v_registration->>'ok')::boolean,false) IS NOT TRUE
     OR (v_registration->>'cost')::numeric IS DISTINCT FROM 100::numeric
     OR (v_registration->>'rake')::numeric IS DISTINCT FROM 10::numeric
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='d2000000-0000-4000-8000-000000000001'
            AND user_id='d1000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 1000::numeric
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='d2000000-0000-4000-8000-000000000002'
            AND user_id='d1000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 100::numeric
     OR (SELECT count(*) FROM public.tournament_refund_entitlements e
          WHERE e.tournament_id='d3000000-0000-4000-8000-000000000002'
            AND e.user_id='d1000000-0000-4000-8000-000000000001'
            AND e.entitlement_kind='wallet_charge'
            AND e.refund_wallet_club_id=
                  'd2000000-0000-4000-8000-000000000002'
            AND e.gross=100 AND e.refund_prize=90
            AND e.refund_bounty=0 AND e.refund_fee=10)<>1
     OR (SELECT count(*) FROM public.rake_records r
          WHERE r.tournament_id='d3000000-0000-4000-8000-000000000002'
            AND r.club_id='d2000000-0000-4000-8000-000000000002'
            AND r.rake_amount=10
            AND r.metadata->>'user_id'=
                  'd1000000-0000-4000-8000-000000000001')<>1 THEN
    RAISE EXCEPTION
      'FAIL request registration did not charge and stamp the host-club wallet: %',
      v_registration;
  END IF;
END;
$cash_entry_is_exact$;

-- Fund the source through the same request-bound entry authority used above.
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub','d1000000-0000-4000-8000-000000000002',
  'role','authenticated',
  'session_id','d4000000-0000-4000-8000-000000000003')::text,true);
SET LOCAL ROLE authenticated;
INSERT INTO cancellation_probe_results(name,value)
VALUES('source_registration',public.fn_register_for_tournament_request(
  'd3000000-0000-4000-8000-000000000001',
  'd4000000-0000-4000-8000-000000000004'));
RESET ROLE;
DO $source_funding$
BEGIN
  IF (SELECT (value->>'ok')::boolean FROM cancellation_probe_results
       WHERE name='source_registration') IS DISTINCT FROM true
     OR (SELECT prize_balance FROM public.tournament_escrow
          WHERE tournament_id='d3000000-0000-4000-8000-000000000001')
           IS DISTINCT FROM 100::numeric
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='d2000000-0000-4000-8000-000000000002'
            AND user_id='d1000000-0000-4000-8000-000000000002')
           IS DISTINCT FROM 200::numeric THEN
    RAISE EXCEPTION 'FAIL independent source registration did not fund 100 chips';
  END IF;
END;
$source_funding$;

-- Establish only the already-played final hand scene. The two authenticated
-- registration charges above remain the sole funds and entitlement sources.
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET status='RUNNING',started_at=clock_timestamp()-interval '1 hour',
 prize_pool_finalized=true,
 entry_contract_locked=true,current_players=1
 WHERE id='d3000000-0000-4000-8000-000000000001';
INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id)
 VALUES('d5000000-0000-4000-8000-000000000001','Satellite Terminal Final Table',
 'd3000000-0000-4000-8000-000000000001','running','live',1,'tournament',
 'd2000000-0000-4000-8000-000000000002');
UPDATE public.tournament_players SET status='playing',chips=1000,
 table_id='d5000000-0000-4000-8000-000000000001',seat_number=1,
 club_id='d2000000-0000-4000-8000-000000000002'
 WHERE tournament_id='d3000000-0000-4000-8000-000000000001';
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,left_at,
 leave_pending,is_sitting_out,is_away,club_id)
 VALUES('d6000000-0000-4000-8000-000000000001',
 'd5000000-0000-4000-8000-000000000001',1,
 'd1000000-0000-4000-8000-000000000002',1000,'active',NULL,false,false,false,
 'd2000000-0000-4000-8000-000000000002');
SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true),
 set_config('app.smarter_data_actor','',true),set_config('app.smarter_manager_request_fenced','',true),
 set_config('app.smarter_tournament_id','',true),set_config('app.smarter_tournament_lease_generation','',true);

SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
INSERT INTO cancellation_probe_results(name,value)
VALUES('source_full_settlement',public.fn_settle_satellite_tournament(
  'd3000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000002'));
RESET ROLE;
DO $funded_award$
DECLARE v jsonb;
BEGIN
  SELECT value INTO v FROM cancellation_probe_results WHERE name='source_full_settlement';
  IF (v->>'ok')::boolean IS DISTINCT FROM true
     OR (v->>'fully_settled')::boolean IS DISTINCT FROM true
     OR v->>'status' IS DISTINCT FROM 'COMPLETED'
     OR (v->>'pool')::numeric IS DISTINCT FROM 100::numeric
     OR (v->>'seat_count')::integer IS DISTINCT FROM 1
     OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id='d3000000-0000-4000-8000-000000000001'
       AND status='COMPLETED' AND ended_at IS NOT NULL AND current_players=0)
     OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id='d3000000-0000-4000-8000-000000000001'
       AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0 AND prize_out=100
       AND closed_at IS NOT NULL AND close_note='atomic satellite terminal receipt: exact zero')
     OR (SELECT prize_balance FROM public.tournament_escrow
          WHERE tournament_id='d3000000-0000-4000-8000-000000000001') IS DISTINCT FROM 0::numeric
     OR NOT EXISTS (SELECT 1 FROM public.tournament_escrow
          WHERE tournament_id='d3000000-0000-4000-8000-000000000002'
            AND prize_balance=180 AND bounty_balance=0 AND fee_balance=20)
     OR (SELECT count(*) FROM public.tournament_refund_entitlements
          WHERE tournament_id='d3000000-0000-4000-8000-000000000002'
            AND entitlement_kind='satellite_seat' AND gross=100
            AND refund_prize=90 AND refund_bounty=0 AND refund_fee=10)<>1
     OR (SELECT current_players FROM public.tournaments
          WHERE id='d3000000-0000-4000-8000-000000000002')<>2 THEN
    RAISE EXCEPTION 'FAIL full source terminal did not create the exact funded target entitlement: %',v;
  END IF;
  RAISE NOTICE 'AUDIT_TEST_PASS: actual full source settlement closed its 100-chip escrow and funded one target seat with 90 prize and 10 fee';
END;
$funded_award$;

-- Cancellation is an engine command. Remove the player's earlier request
-- identity and run the installed service authority twice with the same
-- tournament command identity. The second call must be a byte-identical
-- durable receipt read, not a compensating write or reconciliation pass.
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','service_role',true);

-- Witness the final receipt insertion only after all genuine money writers.
-- The exception rolls the complete cancellation subtransaction back.
CREATE FUNCTION pg_temp.cancel_financial_fingerprint() RETURNS text
LANGUAGE plpgsql AS $fingerprint$
DECLARE r text; j jsonb:='{}'::jsonb; a jsonb;
BEGIN
  FOREACH r IN ARRAY ARRAY[
    'tournaments','tournament_players','tournament_escrow','club_members',
    'chip_ledger','chip_ledger_idem','wallet_transactions','rake_records',
    'tournament_obligations','tournament_payouts','tournament_refund_entitlements',
    'tournament_refund_tranches','tournament_refund_authorizations',
    'tournament_tickets','tournament_cancellation_receipts',
    'tournament_unregistration_receipts','table_seats','tables',
    'spin_reserve_ledger','spin_draw_receipts','tournament_satellite_settlements',
    'tournament_satellite_awards','tournament_satellite_remainders',
    'tournament_finish_receipts','tournament_satellite_terminal_authorizations',
    'tournament_seat_exit_authorizations'] LOOP
    EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),''[]''::jsonb) FROM public.%I x',r) INTO a;
    j:=j||jsonb_build_object(r,a);
  END LOOP;
  RETURN md5(j::text);
END;
$fingerprint$;
CREATE FUNCTION pg_temp.refuse_last_cancellation_receipt() RETURNS trigger
LANGUAGE plpgsql AS $failure$
BEGIN
  IF NEW.tournament_id='d3000000-0000-4000-8000-000000000002'::uuid THEN
    IF NEW.total_refunded<>200 OR NEW.total_ticket_returned<>0
       OR NEW.refund_line_count<>2 OR NEW.ticket_return_count<>0
       OR NEW.fees_reversed<>20
       OR (SELECT count(*) FROM public.wallet_transactions
            WHERE related_entity_id=NEW.tournament_id AND type='credit'
              AND category='refund' AND amount=100)<>2
       OR NOT EXISTS (SELECT 1 FROM public.tournament_escrow
            WHERE tournament_id=NEW.tournament_id AND closed_at IS NOT NULL
              AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0) THEN
      RAISE EXCEPTION 'FAIL cancellation reached its last receipt with the wrong cash/ticket/funding outcome: %',to_jsonb(NEW);
    END IF;
    RAISE EXCEPTION 'injected final cancellation receipt failure' USING ERRCODE='PZ011';
  END IF;
  RETURN NEW;
END;
$failure$;
CREATE TRIGGER native_refuse_last_cancellation_receipt
  BEFORE INSERT ON public.tournament_cancellation_receipts
  FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_last_cancellation_receipt();
DO $late_receipt_rollback$
DECLARE b text:=pg_temp.cancel_financial_fingerprint(); refused boolean:=false;
BEGIN
  BEGIN
    PERFORM public.atomic_cancel_tournament('d3000000-0000-4000-8000-000000000002',NULL);
  EXCEPTION WHEN SQLSTATE 'PZ011' THEN refused:=true;
  END;
  IF NOT refused OR pg_temp.cancel_financial_fingerprint() IS DISTINCT FROM b THEN
    RAISE EXCEPTION 'FAIL final receipt failure did not restore all 26 financial/seat relations';
  END IF;
  RAISE NOTICE 'AUDIT_TEST_PASS: the actual final receipt saw both cash refunds and zero escrow before an injected failure restored all 26 relations';
END;
$late_receipt_rollback$;
DROP TRIGGER native_refuse_last_cancellation_receipt ON public.tournament_cancellation_receipts;

INSERT INTO cancellation_probe_results(name,value)
VALUES(
  'first_cancellation',
  public.atomic_cancel_tournament(
    'd3000000-0000-4000-8000-000000000002',NULL));

INSERT INTO cancellation_probe_results(name,value)
VALUES(
  'same_command_replay',
  public.atomic_cancel_tournament(
    'd3000000-0000-4000-8000-000000000002',NULL));

INSERT INTO cancellation_probe_results(name,value)
VALUES(
  'durable_verifier',
  public.fn_ca_tournament_cancellation_receipt(
    'd3000000-0000-4000-8000-000000000002',NULL));

-- Force the deferred parent invariant now. ROLLBACK alone would otherwise
-- discard it before commit-time execution.
SET CONSTRAINTS tournaments_cancel_must_refund IMMEDIATE;

DO $assert_exact_cancellation$
DECLARE
  v_target constant uuid:='d3000000-0000-4000-8000-000000000002';
  v_cash_user constant uuid:='d1000000-0000-4000-8000-000000000001';
  v_sat_user constant uuid:='d1000000-0000-4000-8000-000000000002';
  v_funding_club constant uuid:='d2000000-0000-4000-8000-000000000001';
  v_fee_club constant uuid:='d2000000-0000-4000-8000-000000000002';
  v_first jsonb:=(
    SELECT value FROM cancellation_probe_results
     WHERE name='first_cancellation');
  v_replay jsonb:=(
    SELECT value FROM cancellation_probe_results
     WHERE name='same_command_replay');
  v_verified jsonb:=(
    SELECT value FROM cancellation_probe_results
     WHERE name='durable_verifier');
  v_receipt public.tournament_cancellation_receipts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_receipt
    FROM public.tournament_cancellation_receipts r
   WHERE r.tournament_id=v_target;

  IF v_replay IS DISTINCT FROM v_first
     OR v_verified IS DISTINCT FROM v_first
     OR COALESCE((v_first->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_first->>'success')::boolean,false) IS NOT TRUE
     OR COALESCE((v_first->>'fully_settled')::boolean,false) IS NOT TRUE
     OR v_first->>'status' IS DISTINCT FROM 'CANCELLED'
     OR (v_first->>'source_player_count')::integer IS DISTINCT FROM 2
     OR (v_first->>'refunded_count')::integer IS DISTINCT FROM 2
     OR (v_first->>'refund_line_count')::integer IS DISTINCT FROM 2
     OR (v_first->>'ticket_return_count')::integer IS DISTINCT FROM 0
     OR (v_first->>'total_refunded')::numeric IS DISTINCT FROM 200::numeric
     OR (v_first->>'total_ticket_returned')::numeric
          IS DISTINCT FROM 0::numeric
     OR (v_first->>'fees_reversed')::numeric IS DISTINCT FROM 20::numeric
     OR v_receipt.receipt IS DISTINCT FROM v_first
     OR v_receipt.source_player_count IS DISTINCT FROM 2
     OR v_receipt.refund_line_count IS DISTINCT FROM 2
     OR v_receipt.ticket_return_count IS DISTINCT FROM 0
     OR v_receipt.total_refunded IS DISTINCT FROM 200::numeric
     OR v_receipt.total_ticket_returned IS DISTINCT FROM 0::numeric
     OR v_receipt.fees_reversed IS DISTINCT FROM 20::numeric
     OR v_receipt.total_rake_before IS DISTINCT FROM 20::numeric
     OR v_receipt.total_rake_after IS DISTINCT FROM 0::numeric
     OR cardinality(v_receipt.fee_reversal_ids)<>2
     OR (SELECT count(*) FROM public.tournament_cancellation_receipts r
          WHERE r.tournament_id=v_target)<>1
     OR (SELECT count(*) FROM public.tournament_refund_tranches tr
          WHERE tr.tournament_id=v_target)<>2
     OR (SELECT count(*) FROM public.wallet_transactions w
          WHERE w.related_entity_id=v_target AND w.type='credit'
            AND lower(w.category) IN ('refund','tournament_refund'))<>2
     OR (SELECT count(*) FROM public.wallet_transactions w
          WHERE w.related_entity_id=v_target AND w.type='credit'
            AND w.user_id=v_cash_user AND w.amount=100)<>1
     OR (SELECT count(*) FROM public.wallet_transactions w
        WHERE w.related_entity_id=v_target AND w.type='credit'
          AND w.user_id=v_sat_user AND w.amount=100)<>1
     OR (SELECT count(*) FROM public.tournament_refund_tranches tr
        WHERE tr.tournament_id=v_target AND tr.user_id=v_sat_user
          AND tr.source_wallet_club_id=v_fee_club
          AND tr.refund_prize=90 AND tr.refund_fee=10)<>1
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id=v_funding_club AND user_id=v_cash_user)
          IS DISTINCT FROM 1000::numeric
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id=v_fee_club AND user_id=v_cash_user)
          IS DISTINCT FROM 200::numeric
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id=v_fee_club AND user_id=v_sat_user)
          IS DISTINCT FROM 300::numeric
     OR EXISTS(SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_tournament_id=v_target
             OR tk.source_refund_entitlement_id IN (SELECT id
                  FROM public.tournament_refund_entitlements
                  WHERE tournament_id=v_target))
     OR (SELECT count(*) FROM public.rake_records r
          WHERE r.tournament_id=v_target
            AND r.source='atomic_cancel_tournament'
            AND r.rake_amount=-10
            AND r.club_id=v_fee_club
            AND r.metadata->>'kind'='tournament_fee_refund')<>2
     OR EXISTS(
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id=v_target AND r.rake_amount<0
          AND r.club_id<>v_fee_club)
     OR NOT EXISTS(
       SELECT 1 FROM public.wallet_transactions w
        JOIN public.tournament_refund_tranches tr
          ON tr.wallet_transaction_id=w.id
        JOIN public.chip_ledger l ON l.id=tr.credit_ledger_id
       WHERE w.related_entity_id=v_target AND w.user_id=v_cash_user
         AND w.type='credit' AND w.amount=100
         AND tr.source_wallet_club_id=v_fee_club
         AND tr.refund_prize=90 AND tr.refund_bounty=0 AND tr.refund_fee=10
         AND l.club_id=v_fee_club
         AND l.from_type='prize_liability' AND l.from_entity_id=v_target
         AND l.to_type='player_wallet' AND l.to_entity_id=v_cash_user
         AND l.amount=100)
     OR NOT EXISTS(
       SELECT 1 FROM public.tournaments t
        WHERE t.id=v_target AND t.status='CANCELLED'
          AND t.current_players=0 AND t.prize_pool=0
          AND t.bounty_pool=0 AND t.total_rake=0)
     OR NOT EXISTS(
       SELECT 1 FROM public.tournament_escrow e
        WHERE e.tournament_id=v_target AND e.closed_at IS NOT NULL
          AND e.prize_balance=0 AND e.bounty_balance=0 AND e.fee_balance=0)
     OR EXISTS(
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id=v_target
          AND (tp.status<>'eliminated' OR tp.chips<>0)) THEN
    RAISE EXCEPTION
      'FAIL entrant cancellation did not return cash and satellite funding on their exact rails: %',
      v_first;
  END IF;

  RAISE NOTICE
    'AUDIT_TEST_PASS: cancellation returned each entrant exactly 100 chips to its recorded host-club wallet and created no ticket, reversed both 10 fees only at the actual fee recipient, stored one exact receipt, and same-command replay returned identical bytes without duplicate money';
END;
$assert_exact_cancellation$;

-- Target cancellation must leave its historical source settlement readable.
DO $source_receipt_survives_target_cancellation$
DECLARE original jsonb:=(SELECT value FROM cancellation_probe_results WHERE name='source_full_settlement');
 before_state text:=pg_temp.cancel_financial_fingerprint(); verified jsonb; replay jsonb; outcome jsonb;
BEGIN
 verified:=public.fn_ca_satellite_settlement_receipt('d3000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000002');
 replay:=public.fn_settle_satellite_tournament('d3000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000002');
 outcome:=public.fn_resolve_satellite_settlement_outcome('d3000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000002');
 IF verified IS DISTINCT FROM original OR replay IS DISTINCT FROM original
    OR outcome->'receipt' IS DISTINCT FROM original
    OR outcome->>'satellite_committed' IS DISTINCT FROM 'true'
    OR pg_temp.cancel_financial_fingerprint() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL target cancellation changed source receipt replay or moved money';
 END IF;
 RAISE NOTICE 'AUDIT_TEST_PASS: after target cash cancellation the original source receipt, public replay and outcome resolver remain byte-identical without changing any of 26 financial/seat relations';
END $source_receipt_survives_target_cancellation$;

-- Every durable source read by replay is protected at write time. A direct
-- superuser mutation is useful here because it proves trigger-enforced
-- immutability instead of relying on application ACLs or a later watcher.
DO $immutable_evidence$
DECLARE
  v_receipt public.tournament_cancellation_receipts%ROWTYPE;
  v_receipt_blocked boolean:=false;
  v_source_rake_blocked boolean:=false;
  v_reversal_rake_blocked boolean:=false;
  v_wallet_blocked boolean:=false;
  v_parent_blocked boolean:=false;
  v_wallet_id uuid;
  v_cash_rake_id uuid;
BEGIN
  SELECT * INTO STRICT v_receipt
    FROM public.tournament_cancellation_receipts r
   WHERE r.tournament_id='d3000000-0000-4000-8000-000000000002';
  SELECT w.id INTO STRICT v_wallet_id
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=v_receipt.tournament_id AND w.type='credit'
     AND w.user_id='d1000000-0000-4000-8000-000000000001';
  SELECT r.id INTO STRICT v_cash_rake_id
    FROM public.rake_records r
   WHERE r.tournament_id=v_receipt.tournament_id AND r.rake_amount>0
     AND r.metadata->>'user_id'='d1000000-0000-4000-8000-000000000001';

  BEGIN
    UPDATE public.tournament_cancellation_receipts
       SET receipt=receipt WHERE tournament_id=v_receipt.tournament_id;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_receipt_blocked:=true;
  END;
  BEGIN
    UPDATE public.rake_records
       SET metadata=metadata||jsonb_build_object('_probe_mutation',true)
     WHERE id=v_cash_rake_id;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_source_rake_blocked:=true;
  END;
  BEGIN
    DELETE FROM public.rake_records
     WHERE id=v_receipt.fee_reversal_ids[1];
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_reversal_rake_blocked:=true;
  END;
  BEGIN
    UPDATE public.wallet_transactions
       SET description=description WHERE id=v_wallet_id;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_wallet_blocked:=true;
  END;
  BEGIN
    UPDATE public.tournaments
       SET prize_pool=prize_pool WHERE id=v_receipt.tournament_id;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_parent_blocked:=true;
  END;

  IF NOT v_receipt_blocked OR NOT v_source_rake_blocked
     OR NOT v_reversal_rake_blocked OR NOT v_wallet_blocked
     OR NOT v_parent_blocked THEN
    RAISE EXCEPTION
      'FAIL cancellation evidence was mutable (receipt %, source rake %, reversal %, wallet %, parent %)',
      v_receipt_blocked,v_source_rake_blocked,v_reversal_rake_blocked,
      v_wallet_blocked,v_parent_blocked;
  END IF;

  RAISE NOTICE
    'AUDIT_TEST_PASS: cancellation receipt, positive fee source, negative fee reversal, exact wallet credit and terminal tournament row all reject direct mutation at the database root';
END;
$immutable_evidence$;

SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;

SELECT 'SATELLITE_CANCEL_CURRENT_NATIVE_PASS' AS result;
