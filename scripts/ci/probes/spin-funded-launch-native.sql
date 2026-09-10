-- Disposable PostgreSQL native immutable Spin launch composition.
-- Real entry/reserve/journal/escrow writes, final receipt failure, exact replay,
-- and played/vacated recovery through the lease-bound launch completion RPC.
-- The final PASS exception rolls back the complete fixture.
BEGIN;

DO $fixture_guard$
BEGIN
  IF current_user <> 'postgres'
     OR to_regprocedure('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)') IS NULL
     OR to_regprocedure('public.fn_prove_played_spin_launch_recovery(uuid)') IS NULL
     OR to_regprocedure('public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'native Spin launch probe requires the disposable composed rehearsal database';
  END IF;
  IF md5(pg_get_functiondef('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure))
       IS DISTINCT FROM '1c911e3ada50ffe0493b9b375e3fa9ae'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_spin_book_entry(uuid)'::regprocedure)
       IS DISTINCT FROM '604113bd4172433183cdd1d59af04e0f'
     OR (SELECT md5(prosrc) FROM pg_proc
          WHERE oid='public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)'::regprocedure)
       IS DISTINCT FROM 'a0f5a4d8edb0c0e403d3c00a9aadaa95' THEN
    RAISE EXCEPTION 'native Spin launch money authority fingerprint changed';
  END IF;
  IF EXISTS(SELECT 1 FROM (VALUES
      ('spin_reserve_ledger','spin_reserve_row_requires_exact_journal'),
      ('chip_ledger','zz_ca_escrow_reserve_leg'),
      ('spin_bonus_pools','trg_ca_autoledger'),
      ('tournament_escrow','zz_spin_escrow_is_enforced'),
      ('spin_draw_receipts','spin_draw_receipt_is_immutable')) guards(table_name,trigger_name)
      WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid=to_regclass('public.'||guards.table_name)
         AND t.tgname=guards.trigger_name AND t.tgenabled='O')) THEN
    RAISE EXCEPTION 'native Spin launch requires enabled money and receipt guards';
  END IF;
END;
$fixture_guard$;

SET LOCAL session_replication_role=replica;

INSERT INTO auth.users(id)
SELECT md5('played-spin-launch-user:' || g.i::text)::uuid
  FROM generate_series(1,3) g(i);

INSERT INTO public.profiles(id,username,display_name)
SELECT md5('played-spin-launch-user:' || g.i::text)::uuid,
       'played_spin_launch_' || g.i,
       'Played Spin Launch ' || g.i
  FROM generate_series(1,3) g(i);

INSERT INTO public.clubs(id,name,owner_id,chip_treasury,spins_enabled)
VALUES (
  '92000000-0000-0000-0000-000000000001',
  'Played Spin Launch Probe Club',
  md5('played-spin-launch-user:1')::uuid,
  1000,
  true
);

INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
SELECT '92000000-0000-0000-0000-000000000001',
       md5('played-spin-launch-user:' || g.i::text)::uuid,
       CASE WHEN g.i=1 THEN 'owner' ELSE 'player' END,
       'active',
       100
  FROM generate_series(1,3) g(i);

INSERT INTO public.spin_bonus_pools(
  id,club_id,balance,total_deposited,total_drawn,spin_count,bonus_count,
  seeded_amount,ceiling_amount,highest_stake,surplus_returned,is_active,
  owner_kind,offered_max_stake,seed_returned_amount,required_seed_at_activation
) VALUES (
  '92030000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  1000,1000,0,0,0,0,10000,1,0,true,'club',1,0,0
);

INSERT INTO public.tournaments(
  id,club_id,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
  start_time,status,current_players,max_players,min_players,starting_chips,
  blind_structure,table_size,prize_pool,payout_structure,spin_multiplier,spin_locked_tiers,
  synchronized_breaks
) VALUES (
  '92010000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  'Played Spin Launch Recovery',
  'NLH','spin','SPIN',1,0,now(),'REGISTERING',3,3,3,1000,
  '[{"level":1,"smallBlind":10,"bigBlind":20,"ante":0,"duration":180}]',3,3,
  '[{"place":1,"percentage":100}]',NULL,NULL,false
);

INSERT INTO public.tables(
  id,club_id,name,game_type,game_variant,max_players,current_players,status,
  starting_chips,is_spins,tournament_id,lifecycle
) VALUES (
  '92020000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  'Played Spin Launch Table',
  'tournament','nlh',3,3,'waiting',1000,true,
  '92010000-0000-0000-0000-000000000001','live'
);

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,username,chips,status,table_id,seat_number,club_id
)
SELECT md5('played-spin-launch-player:' || g.i::text)::uuid,
       '92010000-0000-0000-0000-000000000001',
       md5('played-spin-launch-user:' || g.i::text)::uuid,
       'Played Spin Launch ' || g.i,
       1000,
       'playing',
       '92020000-0000-0000-0000-000000000001',
       g.i,
       '92000000-0000-0000-0000-000000000001'
  FROM generate_series(1,3) g(i);

INSERT INTO public.table_seats(
  id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,
  is_sitting_out,is_away,club_id
)
SELECT md5('played-spin-launch-seat:' || g.i::text)::uuid,
       '92020000-0000-0000-0000-000000000001',
       g.i,
       md5('played-spin-launch-user:' || g.i::text)::uuid,
       1000,
       'active',NULL,false,false,false,
       '92000000-0000-0000-0000-000000000001'
  FROM generate_series(1,3) g(i);

INSERT INTO public.tournament_escrow(
  tournament_id,gross_in,fee_entries_in,satellite_fee_in,bounty_in,overlay_in,
  satellite_in,prize_out,bounty_out,fee_out,refund_prize,refund_bounty,
  refund_fee,reserve_out,reserve_in,prize_balance,bounty_balance,fee_balance,
  opened_from,opened_at,updated_at,enforced
) VALUES (
  '92010000-0000-0000-0000-000000000001',3,0,0,0,0,0,0,0,0,0,0,0,
  0,0,3,0,0,'played-spin-launch-probe',now(),now(),true
);

INSERT INTO public.wallet_transactions(
  id,user_id,wallet_type,amount,type,category,description,related_entity_id,
  balance_after
)
SELECT md5('played-spin-launch-wallet:' || g.i::text)::uuid,
       md5('played-spin-launch-user:' || g.i::text)::uuid,
       'PLAYER',1,'debit','tournament_buyin',
       'Played Spin launch probe buy-in',
       '92010000-0000-0000-0000-000000000001',
       99
  FROM generate_series(1,3) g(i);

INSERT INTO public.chip_ledger(
  id,performed_by,from_type,from_entity_id,to_type,to_entity_id,
  amount,category,club_id,tournament_id,description
)
SELECT md5('played-spin-launch-source-ledger:' || g.i::text)::uuid,
       md5('played-spin-launch-user:' || g.i::text)::uuid,
       'player_wallet',md5('played-spin-launch-user:' || g.i::text)::uuid,
       'prize_liability','92010000-0000-0000-0000-000000000001',
       1,'tournament_buyin','92000000-0000-0000-0000-000000000001',
       '92010000-0000-0000-0000-000000000001',
       'Played Spin launch probe source charge'
  FROM generate_series(1,3) g(i);

INSERT INTO public.tournament_refund_entitlements(
  id,tournament_id,user_id,entitlement_kind,charge_category,
  refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
  source_ledger_id,registration_id,source_satellite_id,source_award_place,
  source_ticket_id,escrow_bucket,evidence_kind
)
SELECT md5('played-spin-launch-entitlement:' || g.i::text)::uuid,
       '92010000-0000-0000-0000-000000000001',
       md5('played-spin-launch-user:' || g.i::text)::uuid,
       'wallet_charge','tournament_buyin',
       '92000000-0000-0000-0000-000000000001',
       1,1,0,0,
       md5('played-spin-launch-source-ledger:' || g.i::text)::uuid,
       NULL,NULL,NULL,NULL,'wallet_gross','cutover_wallet_charge'
  FROM generate_series(1,3) g(i);

INSERT INTO public.tournament_launch_receipts(
  tournament_id,launch_id,started_at,claimed_at,completed_at,lease_generation
) VALUES (
  '92010000-0000-0000-0000-000000000001',
  '92040000-0000-4000-8000-000000000001',
  transaction_timestamp(),transaction_timestamp(),NULL,
  '92050000-0000-4000-8000-000000000001'
);


CREATE FUNCTION pg_temp.spin_replay_state(p_tournament_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public','pg_temp'
AS $state$
  SELECT jsonb_build_object(
    'pool',(SELECT jsonb_build_object(
      'balance',p.balance,'total_deposited',p.total_deposited,
      'total_drawn',p.total_drawn,'spin_count',p.spin_count,
      'bonus_count',p.bonus_count,'seeded_amount',p.seeded_amount,
      'seed_returned_amount',p.seed_returned_amount)
      FROM public.spin_bonus_pools p
      WHERE p.id='92030000-0000-0000-0000-000000000001'),
    'reserve',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.kind,r.id)
      FROM public.spin_reserve_ledger r WHERE r.tournament_id=p_tournament_id),
    'journal',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.category,l.id)
      FROM public.chip_ledger l WHERE l.tournament_id=p_tournament_id
        AND l.category IN ('spin_entry','spin_prize')),
    'rake',(SELECT jsonb_agg(to_jsonb(rr) ORDER BY rr.id)
      FROM public.rake_records rr WHERE rr.tournament_id=p_tournament_id),
    'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e
      WHERE e.tournament_id=p_tournament_id),
    'contract',(SELECT jsonb_build_object(
      'spin_multiplier',t.spin_multiplier,'prize_pool',t.prize_pool,
      'spin_locked_tiers',t.spin_locked_tiers)
      FROM public.tournaments t WHERE t.id=p_tournament_id));
$state$;

INSERT INTO public.engine_tournament_leases(
 tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,lease_generation,protocol_version)
VALUES ('92010000-0000-0000-0000-000000000001','native-spin-probe','native-spin-probe',
 transaction_timestamp(),clock_timestamp(),'92050000-0000-4000-8000-000000000001',2);
SET LOCAL session_replication_role=origin;

CREATE FUNCTION pg_temp.native_spin_rules() RETURNS jsonb LANGUAGE sql AS $rules$
 SELECT jsonb_build_object('version',1,'buy_in',1,'seats',3,'rake_rate',0.08,
  'starting_chips',1000,'tiers',jsonb_agg(jsonb_build_object(
   'multiplier',multiplier,'freq',freq,'reserveThresholdX',0,
   'blind_structure',(SELECT jsonb_agg(jsonb_build_object('level',i,'smallBlind',i*10,
    'bigBlind',i*20,'ante',0,'duration',180) || CASE WHEN i=12 THEN
     jsonb_build_object('spinContinuation',jsonb_build_object('version',1,'anchorLevel',12,
      'anchorBigBlind',240,'growth',1.4,'roundBigTo',10)) ELSE '{}'::jsonb END ORDER BY i)
      FROM generate_series(1,12) g(i)),
   'payout_structure',jsonb_build_array(jsonb_build_object('place',1,'percentage',100)))
   ORDER BY multiplier)) FROM (VALUES (2,181),(10,19)) tiers(multiplier,freq);
$rules$;

CREATE FUNCTION pg_temp.native_spin_call(rules jsonb DEFAULT pg_temp.native_spin_rules())
RETURNS jsonb LANGUAGE sql AS $call$
 SELECT public.fn_spin_draw_and_settle_atomic(
  '92010000-0000-0000-0000-000000000001','92040000-0000-4000-8000-000000000001',
  '92050000-0000-4000-8000-000000000001',rules);
$call$;

CREATE FUNCTION pg_temp.native_spin_state() RETURNS jsonb LANGUAGE sql AS $snapshot$
 SELECT jsonb_build_array(
  pg_temp.spin_replay_state('92010000-0000-0000-0000-000000000001'),
  (SELECT to_jsonb(r) FROM public.spin_draw_receipts r
   WHERE tournament_id='92010000-0000-0000-0000-000000000001'));
$snapshot$;

CREATE FUNCTION pg_temp.native_spin_final_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
 IF NEW.tournament_id='92010000-0000-0000-0000-000000000001' THEN
  IF NEW.receipt->>'ok' IS DISTINCT FROM 'true'
   OR (SELECT count(*) FROM public.spin_reserve_ledger WHERE tournament_id=NEW.tournament_id)<>2
   OR (SELECT count(*) FROM public.chip_ledger WHERE tournament_id=NEW.tournament_id
       AND category IN ('spin_entry','spin_prize'))<>2
   OR (SELECT count(*) FROM public.rake_records WHERE tournament_id=NEW.tournament_id)<>1
   OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=NEW.tournament_id
       AND reserve_out=2.76 AND reserve_in=(NEW.receipt->>'prize_pool')::numeric
       AND fee_entries_in=.24 AND prize_balance=(NEW.receipt->>'prize_pool')::numeric) THEN
    RAISE EXCEPTION 'FAIL immutable receipt fault did not follow exact native money writes';
  END IF;
  RAISE EXCEPTION 'expected final immutable receipt fault' USING ERRCODE='ZX002';
 END IF;
 RETURN NEW;
END;
$fault$;
CREATE TRIGGER native_spin_final_receipt_fault AFTER INSERT ON public.spin_draw_receipts
FOR EACH ROW EXECUTE FUNCTION pg_temp.native_spin_final_receipt_fault();

DO $rollback$
DECLARE before_state jsonb:=pg_temp.native_spin_state(); refused boolean:=false;
BEGIN
 BEGIN PERFORM pg_temp.native_spin_call(); EXCEPTION WHEN SQLSTATE 'ZX002' THEN refused:=true; END;
 IF NOT refused OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL immutable Spin receipt failure retained partial money or receipt';
 END IF;
END;
$rollback$;
DROP TRIGGER native_spin_final_receipt_fault ON public.spin_draw_receipts;
DROP FUNCTION pg_temp.native_spin_final_receipt_fault();

CREATE TEMP TABLE native_spin_result(receipt jsonb NOT NULL, durable_state jsonb NOT NULL);
DO $native$
DECLARE first_receipt jsonb; replay_receipt jsonb; before_state jsonb; refused boolean:=false;
BEGIN
 first_receipt:=pg_temp.native_spin_call();
 IF first_receipt->>'ok' IS DISTINCT FROM 'true' OR first_receipt->>'replay' IS DISTINCT FROM 'false'
  OR (first_receipt->>'multiplier')::numeric NOT IN (2,10)
  OR (first_receipt->>'prize_pool')::numeric IS DISTINCT FROM (first_receipt->>'multiplier')::numeric
  OR (first_receipt->>'house_rake')::numeric IS DISTINCT FROM .24
  OR (first_receipt->>'operator_shortfall')::numeric IS DISTINCT FROM 0
  OR (first_receipt->>'pool_covered')::numeric IS DISTINCT FROM (first_receipt->>'prize_pool')::numeric
  OR NOT EXISTS(SELECT 1 FROM public.spin_bonus_pools
     WHERE id='92030000-0000-0000-0000-000000000001'
       AND balance=1002.76-(first_receipt->>'prize_pool')::numeric
       AND total_deposited=1002.76 AND total_drawn=(first_receipt->>'prize_pool')::numeric
       AND spin_count=1)
  OR (SELECT count(*) FROM public.spin_draw_receipts WHERE tournament_id='92010000-0000-0000-0000-000000000001')<>1 THEN
  RAISE EXCEPTION 'FAIL funded immutable Spin receipt: %',first_receipt;
 END IF;
 before_state:=pg_temp.native_spin_state();
 replay_receipt:=pg_temp.native_spin_call(jsonb_set(pg_temp.native_spin_rules(),'{starting_chips}','999'));
 IF replay_receipt IS DISTINCT FROM first_receipt||'{"replay":true}'::jsonb
  OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL response-loss retry changed funded receipt or financial state';
 END IF;
 IF (public.fn_spin_draw_and_settle_atomic(
  '92010000-0000-0000-0000-000000000001','92040000-0000-4000-8000-000000000001',
  '92050000-0000-4000-8000-000000000099',pg_temp.native_spin_rules())->>'reason') IS DISTINCT FROM 'launch_lease_lost'
  OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL stale owner used the immutable receipt';
 END IF;
 BEGIN DELETE FROM public.spin_draw_receipts WHERE tournament_id='92010000-0000-0000-0000-000000000001';
 EXCEPTION WHEN check_violation THEN refused:=true; END;
 IF NOT refused OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL privileged receipt mutation was accepted';
 END IF;
 INSERT INTO native_spin_result VALUES(first_receipt,before_state);
END;
$native$;


-- Model the authenticated engine request, retaining the native lifecycle guards.
-- The engine may project only the funded immutable receipt it just received.
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
UPDATE public.tournaments SET
 spin_multiplier=(r.receipt->>'multiplier')::numeric,
 prize_pool=(r.receipt->>'prize_pool')::numeric,
 spin_locked_tiers=r.receipt->'locked',
 payout_structure=(r.receipt->'payout_structure')::text,
 blind_structure=(r.receipt->'blind_structure')::text
FROM native_spin_result r WHERE id='92010000-0000-0000-0000-000000000001';
SET LOCAL session_replication_role=replica;

UPDATE public.table_seats
   SET stack=CASE seat_number WHEN 1 THEN 0 WHEN 2 THEN 1000 ELSE 2000 END
 WHERE table_id='92020000-0000-0000-0000-000000000001';
UPDATE public.tournament_players
   SET chips=CASE seat_number WHEN 1 THEN 0 WHEN 2 THEN 1000 ELSE 2000 END
 WHERE tournament_id='92010000-0000-0000-0000-000000000001';

UPDATE public.table_seats
   SET left_at=transaction_timestamp(),status='left'
 WHERE table_id='92020000-0000-0000-0000-000000000001'
   AND seat_number=1;
UPDATE public.tournament_players
   SET status='eliminated',table_id=NULL,seat_number=NULL,
       eliminated_at=transaction_timestamp()
 WHERE tournament_id='92010000-0000-0000-0000-000000000001'
   AND user_id=md5('played-spin-launch-user:1')::uuid;
UPDATE public.tables
   SET current_players=2
 WHERE id='92020000-0000-0000-0000-000000000001';

INSERT INTO public.hand_history(
  id,table_id,tournament_id,hand_number,game_variant,pot_size,players,actions,
  started_at,ended_at
) VALUES (
  '92060000-0000-4000-8000-000000000001',
  '92020000-0000-0000-0000-000000000001',
  '92010000-0000-0000-0000-000000000001',
  992000001,'nlh',3000,'[]','[]',
  transaction_timestamp(),transaction_timestamp()
);

SET LOCAL session_replication_role=origin;

DO $positive_preflight$
DECLARE
  v_proof jsonb;
BEGIN
  v_proof := public.fn_prove_played_spin_launch_recovery(
    '92010000-0000-0000-0000-000000000001'
  );
  IF v_proof->>'ok' IS DISTINCT FROM 'true'
     OR v_proof->>'recovery_mode' IS DISTINCT FROM 'played_vacated_spin'
     OR (v_proof->>'original_field')::integer <> 3
     OR (v_proof->>'active_field')::integer <> 2
     OR (v_proof->>'paid_users')::integer <> 3
     OR (v_proof->>'entitlement_users')::integer <> 3
     OR (v_proof->>'live_seats')::integer <> 2
     OR (v_proof->>'hand_count')::integer < 1
     OR (v_proof->>'funding_floor')::numeric <> 3000
     OR (v_proof->>'roster_chips')::numeric <> 3000
     OR (v_proof->>'seat_chips')::numeric <> 3000
     OR jsonb_array_length(v_proof->'original_player_ids') <> 3
     OR jsonb_array_length(v_proof->'active_player_ids') <> 2 THEN
    RAISE EXCEPTION 'FAIL played Spin preflight was not exact: %',v_proof;
  END IF;
END;
$positive_preflight$;

DO $played_replay$
DECLARE before_state jsonb:=pg_temp.native_spin_state(); first_receipt jsonb; replay_receipt jsonb;
BEGIN
 SELECT receipt INTO first_receipt FROM native_spin_result;
 replay_receipt:=pg_temp.native_spin_call(NULL);
 IF replay_receipt IS DISTINCT FROM first_receipt||'{"replay":true}'::jsonb
  OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL played/vacated immutable launch replay changed the receipt or money';
 END IF;
END;
$played_replay$;

SAVEPOINT native_missing_hand;
SET LOCAL session_replication_role=replica;
DELETE FROM public.hand_history WHERE id='92060000-0000-4000-8000-000000000001';
SET LOCAL session_replication_role=origin;
DO $no_hand$
DECLARE before_state jsonb:=pg_temp.native_spin_state();
BEGIN
 IF (pg_temp.native_spin_call(NULL)->>'reason') IS DISTINCT FROM 'spin_field_unproven'
  OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL immutable launch replay accepted a vacated field without a persisted hand';
 END IF;
END;
$no_hand$;
ROLLBACK TO SAVEPOINT native_missing_hand;

SAVEPOINT native_underfunded;
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_players SET chips=999 WHERE tournament_id='92010000-0000-0000-0000-000000000001'
 AND user_id=md5('played-spin-launch-user:2')::uuid;
UPDATE public.table_seats SET stack=999 WHERE table_id='92020000-0000-0000-0000-000000000001'
 AND user_id=md5('played-spin-launch-user:2')::uuid;
SET LOCAL session_replication_role=origin;
DO $unfunded$
DECLARE before_state jsonb:=pg_temp.native_spin_state();
BEGIN
 IF (pg_temp.native_spin_call(NULL)->>'reason') IS DISTINCT FROM 'spin_field_unproven'
  OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL immutable launch replay accepted a short starting-stack total';
 END IF;
END;
$unfunded$;
ROLLBACK TO SAVEPOINT native_underfunded;

DO $complete_launch$
DECLARE before_state jsonb:=pg_temp.native_spin_state(); completed jsonb;
BEGIN
 completed:=public.fn_complete_tournament_launch_atomic(
  '92010000-0000-0000-0000-000000000001','92040000-0000-4000-8000-000000000001',
  '92050000-0000-4000-8000-000000000001');
 IF completed->>'ok' IS DISTINCT FROM 'true'
  OR (SELECT status FROM public.tournaments WHERE id='92010000-0000-0000-0000-000000000001')<>'RUNNING'
  OR (SELECT completed_at FROM public.tournament_launch_receipts
      WHERE tournament_id='92010000-0000-0000-0000-000000000001') IS NULL
  OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL lease-bound played Spin completion changed money or refused valid recovery: %',completed;
 END IF;
END;
$complete_launch$;

DO $pass$ BEGIN RAISE EXCEPTION
 'AUDIT_TEST_PASS: real immutable Spin wrapper rolled back all money after final receipt failure, same event retried once, exact funded receipt survived changed rules and stale owner refusal, privileged receipt deletion failed, played/vacated replay retained the funded receipt, missing-hand and short-stack states were refused, valid lease-bound recovery completed RUNNING, and native financial state remained unchanged; all probe work rolled back'; END $pass$;
