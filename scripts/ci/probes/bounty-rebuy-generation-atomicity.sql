-- Run as postgres only on a disposable production-shape PostgreSQL 17 clone
-- after 20260909182236. The final AUDIT_TEST_PASS exception intentionally
-- rolls back every fixture and proof row.
BEGIN;

DO $fixture_guard$
BEGIN
  IF current_user<>'postgres'
     OR current_setting('server_version_num')::integer<170000
     OR to_regprocedure(
          'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)')
          IS NULL
     OR to_regprocedure(
          'public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)')
          IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.tournaments
        WHERE id='30000000-0000-0000-0000-000000000001'::uuid) THEN
    RAISE EXCEPTION
      'bounty rebuy probe requires the disposable post-migration Stage 1 fixture';
  END IF;
END;
$fixture_guard$;

-- Restore the exact tracked platform source seed omitted by the zero-data
-- schema donor. Provenance: 20260905203123, exact tuple
-- ('fn_mystery_bounty_pay', 'DB caller').
INSERT INTO public.ca_settle_sources(source,note)
VALUES('fn_mystery_bounty_pay','DB caller') ON CONFLICT(source) DO NOTHING;

SET LOCAL session_replication_role=replica;

INSERT INTO auth.users(id)
VALUES
  ('b7100000-0000-4000-8000-000000000001'),
  ('b7100000-0000-4000-8000-000000000002'),
  ('b7100000-0000-4000-8000-000000000003'),
  ('b7100000-0000-4000-8000-000000000004'),
  ('b7100000-0000-4000-8000-000000000005'),
  ('b7100000-0000-4000-8000-000000000006'),
  ('b7100000-0000-4000-8000-000000000007'),
  ('b7100000-0000-4000-8000-000000000008');

INSERT INTO public.users(id,username)
VALUES
  ('b7100000-0000-4000-8000-000000000001','bounty_rebuy_busted'),
  ('b7100000-0000-4000-8000-000000000002','bounty_rebuy_winner'),
  ('b7100000-0000-4000-8000-000000000003','pko_rebuy_busted'),
  ('b7100000-0000-4000-8000-000000000004','pko_rebuy_winner'),
  ('b7100000-0000-4000-8000-000000000005','mystery_rebuy_busted'),
  ('b7100000-0000-4000-8000-000000000006','mystery_rebuy_winner'),
  ('b7100000-0000-4000-8000-000000000007','rollback_rebuy_busted'),
  ('b7100000-0000-4000-8000-000000000008','rollback_rebuy_winner');

INSERT INTO public.profiles(id,username,display_name)
VALUES
  ('b7100000-0000-4000-8000-000000000001','bounty_rebuy_busted',
   'Bounty Rebuy Busted'),
  ('b7100000-0000-4000-8000-000000000002','bounty_rebuy_winner',
   'Bounty Rebuy Winner'),
  ('b7100000-0000-4000-8000-000000000003','pko_rebuy_busted',
   'PKO Rebuy Busted'),
  ('b7100000-0000-4000-8000-000000000004','pko_rebuy_winner',
   'PKO Rebuy Winner'),
  ('b7100000-0000-4000-8000-000000000005','mystery_rebuy_busted',
   'Mystery Rebuy Busted'),
  ('b7100000-0000-4000-8000-000000000006','mystery_rebuy_winner',
   'Mystery Rebuy Winner'),
  ('b7100000-0000-4000-8000-000000000007','rollback_rebuy_busted',
   'Rollback Rebuy Busted'),
  ('b7100000-0000-4000-8000-000000000008','rollback_rebuy_winner',
   'Rollback Rebuy Winner');

INSERT INTO public.club_members(
  club_id,user_id,role,status,chip_balance,membership_lifecycle_status)
VALUES
  ('20000000-0000-0000-0000-000000000001',
   'b7100000-0000-4000-8000-000000000001','player','active',100,'active'),
  ('20000000-0000-0000-0000-000000000001',
   'b7100000-0000-4000-8000-000000000002','player','active',0,'active'),
  ('20000000-0000-0000-0000-000000000001',
   'b7100000-0000-4000-8000-000000000003','player','active',100,'active'),
  ('20000000-0000-0000-0000-000000000001',
   'b7100000-0000-4000-8000-000000000004','player','active',0,'active'),
  ('20000000-0000-0000-0000-000000000001',
   'b7100000-0000-4000-8000-000000000005','player','active',100,'active'),
  ('20000000-0000-0000-0000-000000000001',
   'b7100000-0000-4000-8000-000000000006','player','active',0,'active'),
  ('20000000-0000-0000-0000-000000000001',
   'b7100000-0000-4000-8000-000000000007','player','active',100,'active'),
  ('20000000-0000-0000-0000-000000000001',
   'b7100000-0000-4000-8000-000000000008','player','active',0,'active');

INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,
  to_jsonb(t)||jsonb_build_object(
    'id','b7200000-0000-4000-8000-000000000001',
    'name','Atomic Standard Bounty Rebuy Probe',
    'club_id','20000000-0000-0000-0000-000000000001',
    'status','RUNNING','ended_at',NULL,'updated_at',clock_timestamp(),
    'current_players',2,'max_players',9,'prize_pool_finalized',false,
    'prize_pool',10,'bounty_pool',10,'bounty_pool_paid',0,
    'starting_chips',100,'is_bounty',true,'is_pko',false,
    'is_mystery_bounty',false,'bounty_amount',5,
    'is_rebuy',true,'is_reentry',true,'add_on_available',false,
    'max_rebuys',5,'max_reentries',5,'rebuy_cost',10,
    'rebuy_chips',100,'rebuy_levels',5,'late_reg_levels',0,
    'late_reg_mins',0,'current_level',1
  ))).*
  FROM public.tournaments t
 WHERE t.id='30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,
  to_jsonb(t)||jsonb_build_object(
    'id','b7200000-0000-4000-8000-000000000002',
    'name','Atomic PKO Rebuy Probe',
    'club_id','20000000-0000-0000-0000-000000000001',
    'status','RUNNING','ended_at',NULL,'updated_at',clock_timestamp(),
    'current_players',2,'max_players',9,'prize_pool_finalized',false,
    'prize_pool',10,'bounty_pool',10,'bounty_pool_paid',0,
    'starting_chips',100,'is_bounty',false,'is_pko',true,
    'is_mystery_bounty',false,'bounty_amount',5,
    'is_rebuy',true,'is_reentry',true,'add_on_available',false,
    'max_rebuys',5,'max_reentries',5,'rebuy_cost',10,
    'rebuy_chips',100,'rebuy_levels',5,'late_reg_levels',0,
    'late_reg_mins',0,'current_level',1
  ))).*
  FROM public.tournaments t
 WHERE t.id='30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,
  to_jsonb(t)||jsonb_build_object(
    'id','b7200000-0000-4000-8000-000000000003',
    'name','Atomic Mystery Bounty Rebuy Probe',
    'club_id','20000000-0000-0000-0000-000000000001',
    'status','RUNNING','ended_at',NULL,'updated_at',clock_timestamp(),
    'current_players',2,'max_players',9,'prize_pool_finalized',false,
    'prize_pool',10,'bounty_pool',10,'bounty_pool_paid',0,
    'starting_chips',100,'is_bounty',false,'is_pko',false,
    'is_mystery_bounty',true,'bounty_amount',5,
    'mystery_bounty_stage','active',
    'mystery_bounty_activation_generation',1,
    'is_rebuy',true,'is_reentry',true,'add_on_available',false,
    'max_rebuys',5,'max_reentries',5,'rebuy_cost',10,
    'rebuy_chips',100,'rebuy_levels',5,'late_reg_levels',0,
    'late_reg_mins',0,'current_level',1
  ))).*
  FROM public.tournaments t
 WHERE t.id='30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,
  to_jsonb(t)||jsonb_build_object(
    'id','b7200000-0000-4000-8000-000000000004',
    'name','Atomic Bounty Rebuy Rollback Probe',
    'club_id','20000000-0000-0000-0000-000000000001',
    'status','RUNNING','ended_at',NULL,'updated_at',clock_timestamp(),
    'current_players',2,'max_players',9,'prize_pool_finalized',false,
    'prize_pool',10,'bounty_pool',10,'bounty_pool_paid',0,
    'starting_chips',100,'is_bounty',true,'is_pko',false,
    'is_mystery_bounty',false,'bounty_amount',5,
    'is_rebuy',true,'is_reentry',true,'add_on_available',false,
    'max_rebuys',5,'max_reentries',5,'rebuy_cost',10,
    'rebuy_chips',100,'rebuy_levels',5,'late_reg_levels',0,
    'late_reg_mins',0,'current_level',1
  ))).*
  FROM public.tournaments t
 WHERE t.id='30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tables(
  id,name,tournament_id,status,lifecycle,current_players,game_type,club_id,
  max_players,small_blind,big_blind,stakes,seat_game_scope,
  seat_admission_key)
VALUES(
  'b7300000-0000-4000-8000-000000000001',
  'Atomic Standard Bounty Rebuy Table',
  'b7200000-0000-4000-8000-000000000001','running','live',2,
  'tournament','20000000-0000-0000-0000-000000000001',9,5,10,'5/10',
  'table:b7300000-0000-4000-8000-000000000001',
  'tournament:b7200000-0000-4000-8000-000000000001'),
  ('b7300000-0000-4000-8000-000000000002',
   'Atomic PKO Rebuy Table',
   'b7200000-0000-4000-8000-000000000002','running','live',2,
   'tournament','20000000-0000-0000-0000-000000000001',9,5,10,'5/10',
   'table:b7300000-0000-4000-8000-000000000002',
   'tournament:b7200000-0000-4000-8000-000000000002'),
  ('b7300000-0000-4000-8000-000000000003',
   'Atomic Mystery Bounty Rebuy Table',
   'b7200000-0000-4000-8000-000000000003','running','live',2,
   'tournament','20000000-0000-0000-0000-000000000001',9,5,10,'5/10',
   'table:b7300000-0000-4000-8000-000000000003',
   'tournament:b7200000-0000-4000-8000-000000000003'),
  ('b7300000-0000-4000-8000-000000000004',
   'Atomic Bounty Rebuy Rollback Table',
   'b7200000-0000-4000-8000-000000000004','running','live',2,
   'tournament','20000000-0000-0000-0000-000000000001',9,5,10,'5/10',
   'table:b7300000-0000-4000-8000-000000000004',
   'tournament:b7200000-0000-4000-8000-000000000004');

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,club_id,status,chips,table_id,seat_number,
  position,prize,current_bounty,bounty_winnings,rebuy_prompt_until)
VALUES
  ('b7500000-0000-4000-8000-000000000001',
   'b7200000-0000-4000-8000-000000000001',
   'b7100000-0000-4000-8000-000000000001',
   '20000000-0000-0000-0000-000000000001','playing',0,
   'b7300000-0000-4000-8000-000000000001',1,NULL,0,5,0,
   clock_timestamp()+interval '5 minutes'),
  ('b7500000-0000-4000-8000-000000000002',
   'b7200000-0000-4000-8000-000000000001',
   'b7100000-0000-4000-8000-000000000002',
   '20000000-0000-0000-0000-000000000001','playing',100,
   'b7300000-0000-4000-8000-000000000001',2,NULL,0,5,0,NULL),
  ('b7500000-0000-4000-8000-000000000003',
   'b7200000-0000-4000-8000-000000000002',
   'b7100000-0000-4000-8000-000000000003',
   '20000000-0000-0000-0000-000000000001','playing',0,
   'b7300000-0000-4000-8000-000000000002',1,NULL,0,5,0,
   clock_timestamp()+interval '5 minutes'),
  ('b7500000-0000-4000-8000-000000000004',
   'b7200000-0000-4000-8000-000000000002',
   'b7100000-0000-4000-8000-000000000004',
   '20000000-0000-0000-0000-000000000001','playing',100,
   'b7300000-0000-4000-8000-000000000002',2,NULL,0,5,0,NULL),
  ('b7500000-0000-4000-8000-000000000005',
   'b7200000-0000-4000-8000-000000000003',
   'b7100000-0000-4000-8000-000000000005',
   '20000000-0000-0000-0000-000000000001','playing',0,
   'b7300000-0000-4000-8000-000000000003',1,NULL,0,5,0,
   clock_timestamp()+interval '5 minutes'),
  ('b7500000-0000-4000-8000-000000000006',
   'b7200000-0000-4000-8000-000000000003',
   'b7100000-0000-4000-8000-000000000006',
   '20000000-0000-0000-0000-000000000001','playing',100,
   'b7300000-0000-4000-8000-000000000003',2,NULL,0,5,0,NULL),
  ('b7500000-0000-4000-8000-000000000007',
   'b7200000-0000-4000-8000-000000000004',
   'b7100000-0000-4000-8000-000000000007',
   '20000000-0000-0000-0000-000000000001','playing',0,
   'b7300000-0000-4000-8000-000000000004',1,NULL,0,5,0,
   clock_timestamp()+interval '5 minutes'),
  ('b7500000-0000-4000-8000-000000000008',
   'b7200000-0000-4000-8000-000000000004',
   'b7100000-0000-4000-8000-000000000008',
   '20000000-0000-0000-0000-000000000001','playing',100,
   'b7300000-0000-4000-8000-000000000004',2,NULL,0,5,0,NULL);

INSERT INTO public.table_seats(
  id,table_id,seat_number,user_id,stack,status,joined_at,left_at,
  leave_pending,is_sitting_out,is_away,club_id,active_game_scope,
  active_parent_key)
VALUES
  ('b7400000-0000-4000-8000-000000000001',
   'b7300000-0000-4000-8000-000000000001',1,
   'b7100000-0000-4000-8000-000000000001',0,'active',
   clock_timestamp()-interval '2 minutes',NULL,false,false,false,
   '20000000-0000-0000-0000-000000000001',
   'table:b7300000-0000-4000-8000-000000000001',
   'tournament:b7200000-0000-4000-8000-000000000001'),
  ('b7400000-0000-4000-8000-000000000002',
   'b7300000-0000-4000-8000-000000000001',2,
   'b7100000-0000-4000-8000-000000000002',100,'active',
   clock_timestamp()-interval '2 minutes',NULL,false,false,false,
   '20000000-0000-0000-0000-000000000001',
   'table:b7300000-0000-4000-8000-000000000001',
   'tournament:b7200000-0000-4000-8000-000000000001'),
  ('b7400000-0000-4000-8000-000000000003',
   'b7300000-0000-4000-8000-000000000002',1,
   'b7100000-0000-4000-8000-000000000003',0,'active',
   clock_timestamp()-interval '2 minutes',NULL,false,false,false,
   '20000000-0000-0000-0000-000000000001',
   'table:b7300000-0000-4000-8000-000000000002',
   'tournament:b7200000-0000-4000-8000-000000000002'),
  ('b7400000-0000-4000-8000-000000000004',
   'b7300000-0000-4000-8000-000000000002',2,
   'b7100000-0000-4000-8000-000000000004',100,'active',
   clock_timestamp()-interval '2 minutes',NULL,false,false,false,
   '20000000-0000-0000-0000-000000000001',
   'table:b7300000-0000-4000-8000-000000000002',
   'tournament:b7200000-0000-4000-8000-000000000002'),
  ('b7400000-0000-4000-8000-000000000005',
   'b7300000-0000-4000-8000-000000000003',1,
   'b7100000-0000-4000-8000-000000000005',0,'active',
   clock_timestamp()-interval '2 minutes',NULL,false,false,false,
   '20000000-0000-0000-0000-000000000001',
   'table:b7300000-0000-4000-8000-000000000003',
   'tournament:b7200000-0000-4000-8000-000000000003'),
  ('b7400000-0000-4000-8000-000000000006',
   'b7300000-0000-4000-8000-000000000003',2,
   'b7100000-0000-4000-8000-000000000006',100,'active',
   clock_timestamp()-interval '2 minutes',NULL,false,false,false,
   '20000000-0000-0000-0000-000000000001',
   'table:b7300000-0000-4000-8000-000000000003',
   'tournament:b7200000-0000-4000-8000-000000000003'),
  ('b7400000-0000-4000-8000-000000000007',
   'b7300000-0000-4000-8000-000000000004',1,
   'b7100000-0000-4000-8000-000000000007',0,'active',
   clock_timestamp()-interval '2 minutes',NULL,false,false,false,
   '20000000-0000-0000-0000-000000000001',
   'table:b7300000-0000-4000-8000-000000000004',
   'tournament:b7200000-0000-4000-8000-000000000004'),
  ('b7400000-0000-4000-8000-000000000008',
   'b7300000-0000-4000-8000-000000000004',2,
   'b7100000-0000-4000-8000-000000000008',100,'active',
   clock_timestamp()-interval '2 minutes',NULL,false,false,false,
   '20000000-0000-0000-0000-000000000001',
   'table:b7300000-0000-4000-8000-000000000004',
   'tournament:b7200000-0000-4000-8000-000000000004');

DO $fixture_active_seats_match_canonical_parent_scope$
BEGIN
  IF (SELECT count(*)
        FROM public.table_seats s
        JOIN public.tables t ON t.id=s.table_id
       WHERE s.id::text LIKE 'b7400000-0000-4000-8000-%'
         AND s.left_at IS NULL
         AND s.active_game_scope=t.seat_game_scope
         AND s.active_parent_key=t.seat_admission_key
         AND t.seat_game_scope='table:'||t.id::text
         AND t.seat_admission_key='tournament:'||t.tournament_id::text)<>8 THEN
    RAISE EXCEPTION
      'bounty rebuy fixture active seats do not match their canonical table scope'
      USING ERRCODE='55000';
  END IF;
END;
$fixture_active_seats_match_canonical_parent_scope$;

INSERT INTO public.tournament_escrow(
  tournament_id,gross_in,fee_entries_in,satellite_fee_in,bounty_in,
  overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,
  refund_bounty,refund_fee,reserve_out,reserve_in,prize_balance,
  bounty_balance,fee_balance,opened_from,opened_at,updated_at,enforced)
VALUES(
  'b7200000-0000-4000-8000-000000000001',20,0,0,10,0,0,0,0,0,0,0,0,
  0,0,10,10,0,'bounty-rebuy-generation-probe',now(),now(),true),
  ('b7200000-0000-4000-8000-000000000002',20,0,0,10,0,0,0,0,0,0,0,0,
   0,0,10,10,0,'bounty-rebuy-generation-probe',now(),now(),true),
  ('b7200000-0000-4000-8000-000000000003',20,0,0,10,0,0,0,0,0,0,0,0,
   0,0,10,10,0,'bounty-rebuy-generation-probe',now(),now(),true),
  ('b7200000-0000-4000-8000-000000000004',20,0,0,10,0,0,0,0,0,0,0,0,
   0,0,10,10,0,'bounty-rebuy-generation-probe',now(),now(),true);

INSERT INTO public.tournament_mystery_activation_receipts(
  tournament_id,activation_generation,activated_at,chest_count,pool_cents)
VALUES(
  'b7200000-0000-4000-8000-000000000003',1,
  clock_timestamp()-interval '10 minutes',1,500);

INSERT INTO public.tournament_bounty_chests(
  id,tournament_id,seq,tier,amount_cents,status)
VALUES(
  'b7900000-0000-4000-8000-000000000003',
  'b7200000-0000-4000-8000-000000000003',1,'base',500,'available');

INSERT INTO public.settlement_idempotency_keys(
  table_id,hand_id,status,result,completed_at)
VALUES(
  'b7300000-0000-4000-8000-000000000001',
  'b7700000-0000-4000-8000-000000000001','succeeded',
  jsonb_build_object(
    'success',true,'hand_id','b7700000-0000-4000-8000-000000000001',
    'hand_number',9720001,
    'table_id','b7300000-0000-4000-8000-000000000001',
    'written',jsonb_build_object(
      'b7100000-0000-4000-8000-000000000001',0)),
  clock_timestamp()-interval '45 seconds'),
  ('b7300000-0000-4000-8000-000000000002',
   'b7700000-0000-4000-8000-000000000002','succeeded',
   jsonb_build_object(
     'success',true,'hand_id','b7700000-0000-4000-8000-000000000002',
     'hand_number',9720002,
     'table_id','b7300000-0000-4000-8000-000000000002',
     'written',jsonb_build_object(
       'b7100000-0000-4000-8000-000000000003',0)),
   clock_timestamp()-interval '45 seconds'),
  ('b7300000-0000-4000-8000-000000000003',
   'b7700000-0000-4000-8000-000000000003','succeeded',
   jsonb_build_object(
     'success',true,'hand_id','b7700000-0000-4000-8000-000000000003',
     'hand_number',9720003,
     'table_id','b7300000-0000-4000-8000-000000000003',
     'written',jsonb_build_object(
       'b7100000-0000-4000-8000-000000000005',0)),
   clock_timestamp()-interval '45 seconds'),
  ('b7300000-0000-4000-8000-000000000004',
   'b7700000-0000-4000-8000-000000000004','succeeded',
   jsonb_build_object(
     'success',true,'hand_id','b7700000-0000-4000-8000-000000000004',
     'hand_number',9720004,
     'table_id','b7300000-0000-4000-8000-000000000004',
     'written',jsonb_build_object(
       'b7100000-0000-4000-8000-000000000007',0)),
   clock_timestamp()-interval '45 seconds');

INSERT INTO public.hand_atomic_commits(
  table_id,hand_number,hand_id,payload_hash,stack_result,committed_at)
VALUES(
  'b7300000-0000-4000-8000-000000000001',9720001,
  'b7600000-0000-4000-8000-000000000001',repeat('b',64),
  jsonb_build_object(
    'success',true,'hand_id','b7700000-0000-4000-8000-000000000001',
    'hand_number',9720001,
    'table_id','b7300000-0000-4000-8000-000000000001',
    'written',jsonb_build_object(
      'b7100000-0000-4000-8000-000000000001',0)),
  clock_timestamp()-interval '40 seconds'),
  ('b7300000-0000-4000-8000-000000000002',9720002,
   'b7600000-0000-4000-8000-000000000002',repeat('c',64),
   jsonb_build_object(
     'success',true,'hand_id','b7700000-0000-4000-8000-000000000002',
     'hand_number',9720002,
     'table_id','b7300000-0000-4000-8000-000000000002',
     'written',jsonb_build_object(
       'b7100000-0000-4000-8000-000000000003',0)),
   clock_timestamp()-interval '40 seconds'),
  ('b7300000-0000-4000-8000-000000000003',9720003,
   'b7600000-0000-4000-8000-000000000003',repeat('d',64),
   jsonb_build_object(
     'success',true,'hand_id','b7700000-0000-4000-8000-000000000003',
     'hand_number',9720003,
     'table_id','b7300000-0000-4000-8000-000000000003',
     'written',jsonb_build_object(
       'b7100000-0000-4000-8000-000000000005',0)),
   clock_timestamp()-interval '40 seconds'),
  ('b7300000-0000-4000-8000-000000000004',9720004,
   'b7600000-0000-4000-8000-000000000004',repeat('e',64),
   jsonb_build_object(
     'success',true,'hand_id','b7700000-0000-4000-8000-000000000004',
     'hand_number',9720004,
     'table_id','b7300000-0000-4000-8000-000000000004',
     'written',jsonb_build_object(
       'b7100000-0000-4000-8000-000000000007',0)),
   clock_timestamp()-interval '40 seconds');

INSERT INTO public.hand_history(
  id,table_id,tournament_id,hand_number,created_at,players,pots,winners)
VALUES(
  'b7600000-0000-4000-8000-000000000001',
  'b7300000-0000-4000-8000-000000000001',
  'b7200000-0000-4000-8000-000000000001',9720001,
  clock_timestamp()-interval '30 seconds',
  jsonb_build_array(
    jsonb_build_object(
      'userId','b7100000-0000-4000-8000-000000000001','stack',0),
    jsonb_build_object(
      'userId','b7100000-0000-4000-8000-000000000002','stack',100)),
  jsonb_build_array(jsonb_build_object(
    'index',0,'amount',100,'eligible',jsonb_build_array(
      'b7100000-0000-4000-8000-000000000001',
      'b7100000-0000-4000-8000-000000000002'))),
  jsonb_build_array(jsonb_build_object(
    'userId','b7100000-0000-4000-8000-000000000002',
    'potIndex',0,'amount',100))),
  ('b7600000-0000-4000-8000-000000000002',
   'b7300000-0000-4000-8000-000000000002',
   'b7200000-0000-4000-8000-000000000002',9720002,
   clock_timestamp()-interval '30 seconds',
   jsonb_build_array(
     jsonb_build_object(
       'userId','b7100000-0000-4000-8000-000000000003','stack',0),
     jsonb_build_object(
       'userId','b7100000-0000-4000-8000-000000000004','stack',100)),
   jsonb_build_array(jsonb_build_object(
     'index',0,'amount',100,'eligible',jsonb_build_array(
       'b7100000-0000-4000-8000-000000000003',
       'b7100000-0000-4000-8000-000000000004'))),
   jsonb_build_array(jsonb_build_object(
     'userId','b7100000-0000-4000-8000-000000000004',
     'potIndex',0,'amount',100))),
  ('b7600000-0000-4000-8000-000000000003',
   'b7300000-0000-4000-8000-000000000003',
   'b7200000-0000-4000-8000-000000000003',9720003,
   clock_timestamp()-interval '30 seconds',
   jsonb_build_array(
     jsonb_build_object(
       'userId','b7100000-0000-4000-8000-000000000005','stack',0),
     jsonb_build_object(
       'userId','b7100000-0000-4000-8000-000000000006','stack',100)),
   jsonb_build_array(jsonb_build_object(
     'index',0,'amount',100,'eligible',jsonb_build_array(
       'b7100000-0000-4000-8000-000000000005',
       'b7100000-0000-4000-8000-000000000006'))),
   jsonb_build_array(jsonb_build_object(
     'userId','b7100000-0000-4000-8000-000000000006',
     'potIndex',0,'amount',100))),
  ('b7600000-0000-4000-8000-000000000004',
   'b7300000-0000-4000-8000-000000000004',
   'b7200000-0000-4000-8000-000000000004',9720004,
   clock_timestamp()-interval '30 seconds',
   jsonb_build_array(
     jsonb_build_object(
       'userId','b7100000-0000-4000-8000-000000000007','stack',0),
     jsonb_build_object(
       'userId','b7100000-0000-4000-8000-000000000008','stack',100)),
   jsonb_build_array(jsonb_build_object(
     'index',0,'amount',100,'eligible',jsonb_build_array(
       'b7100000-0000-4000-8000-000000000007',
       'b7100000-0000-4000-8000-000000000008'))),
   jsonb_build_array(jsonb_build_object(
     'userId','b7100000-0000-4000-8000-000000000008',
     'potIndex',0,'amount',100)));

INSERT INTO public.tournament_knockout_candidates(
  id,tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,
  hand_id,hand_number,stack_before,stack_after,state,rebuy_prompt_until)
VALUES(
  'b7800000-0000-4000-8000-000000000001',
  'b7200000-0000-4000-8000-000000000001',
  'b7100000-0000-4000-8000-000000000001',
  'b7300000-0000-4000-8000-000000000001',
  'b7400000-0000-4000-8000-000000000001',
  (SELECT joined_at FROM public.table_seats
    WHERE id='b7400000-0000-4000-8000-000000000001'),
  'b7600000-0000-4000-8000-000000000001',9720001,100,0,'pending',
  clock_timestamp()+interval '5 minutes'),
  ('b7800000-0000-4000-8000-000000000002',
   'b7200000-0000-4000-8000-000000000002',
   'b7100000-0000-4000-8000-000000000003',
   'b7300000-0000-4000-8000-000000000002',
   'b7400000-0000-4000-8000-000000000003',
   (SELECT joined_at FROM public.table_seats
     WHERE id='b7400000-0000-4000-8000-000000000003'),
   'b7600000-0000-4000-8000-000000000002',9720002,100,0,'pending',
   clock_timestamp()+interval '5 minutes'),
  ('b7800000-0000-4000-8000-000000000003',
   'b7200000-0000-4000-8000-000000000003',
   'b7100000-0000-4000-8000-000000000005',
   'b7300000-0000-4000-8000-000000000003',
   'b7400000-0000-4000-8000-000000000005',
   (SELECT joined_at FROM public.table_seats
     WHERE id='b7400000-0000-4000-8000-000000000005'),
   'b7600000-0000-4000-8000-000000000003',9720003,100,0,'pending',
   clock_timestamp()+interval '5 minutes'),
  ('b7800000-0000-4000-8000-000000000004',
   'b7200000-0000-4000-8000-000000000004',
   'b7100000-0000-4000-8000-000000000007',
   'b7300000-0000-4000-8000-000000000004',
   'b7400000-0000-4000-8000-000000000007',
   (SELECT joined_at FROM public.table_seats
     WHERE id='b7400000-0000-4000-8000-000000000007'),
   'b7600000-0000-4000-8000-000000000004',9720004,100,0,'pending',
   clock_timestamp()+interval '5 minutes');

SET LOCAL session_replication_role=origin;

DO $standard_bounty_success$
DECLARE
  v_result jsonb;
  v_replay jsonb;
  v_old_seat_joined_at timestamptz;
BEGIN
  SELECT joined_at INTO STRICT v_old_seat_joined_at
    FROM public.table_seats
   WHERE id='b7400000-0000-4000-8000-000000000001';

  v_result:=public.process_tournament_rebuy(
    'b7200000-0000-4000-8000-000000000001',
    'b7100000-0000-4000-8000-000000000001',
    'rebuy',10,100,1,'atomic-standard-bounty-rebuy');
  v_replay:=public.process_tournament_rebuy(
    'b7200000-0000-4000-8000-000000000001',
    'b7100000-0000-4000-8000-000000000001',
    'rebuy',10,100,1,'atomic-standard-bounty-rebuy');

  IF v_result IS DISTINCT FROM v_replay
     OR v_result->>'success'<>'true'
     OR v_result->>'candidate_state'<>'rebought'
     OR v_result->>'prior_bounty_marker_verified'<>'true'
     OR COALESCE(v_result->>'prior_bounty_obligation_id','')=''
     OR (v_result->>'bounty_head_funded')::numeric<>5
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_bounty_obligations o
        WHERE o.id=(v_result->>'prior_bounty_obligation_id')::uuid
          AND o.tournament_id='b7200000-0000-4000-8000-000000000001'
          AND o.eliminated_user_id='b7100000-0000-4000-8000-000000000001'
          AND o.hand_id='b7600000-0000-4000-8000-000000000001'
          AND o.hand_number=9720001 AND o.state='settled'
          AND o.mode='regular'
          AND public.fn_bounty_obligation_has_complete_marker(o.id))
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id='b7200000-0000-4000-8000-000000000001'
          AND tp.user_id='b7100000-0000-4000-8000-000000000001'
          AND tp.status='playing' AND tp.chips=100
          AND tp.current_bounty=5 AND tp.rebuy_prompt_until IS NULL)
     OR (SELECT count(*) FROM public.tournament_bounties b
          WHERE b.bounty_obligation_id=
            (v_result->>'prior_bounty_obligation_id')::uuid
            AND b.eliminated_player_id=
              'b7100000-0000-4000-8000-000000000001'
            AND b.collector_player_id=
              'b7100000-0000-4000-8000-000000000002'
            AND b.bounty_amount=5)<>1
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_knockout_candidates c
        WHERE c.id='b7800000-0000-4000-8000-000000000001'
          AND c.state='rebought' AND c.resolved_at IS NOT NULL)
     OR (SELECT count(*) FROM public.table_seats s
          JOIN public.tables tb ON tb.id=s.table_id
         WHERE tb.tournament_id='b7200000-0000-4000-8000-000000000001'
           AND s.user_id='b7100000-0000-4000-8000-000000000001'
           AND s.left_at IS NULL AND s.stack=100)<>1
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.id='b7400000-0000-4000-8000-000000000001'
          AND s.joined_at>v_old_seat_joined_at AND s.left_at IS NULL
          AND s.stack=100)
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_knockout_candidates c
        WHERE c.id='b7800000-0000-4000-8000-000000000001'
          AND c.seat_joined_at=v_old_seat_joined_at)
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='20000000-0000-0000-0000-000000000001'
            AND user_id='b7100000-0000-4000-8000-000000000001')<>90
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='20000000-0000-0000-0000-000000000001'
            AND user_id='b7100000-0000-4000-8000-000000000002')<>5 THEN
    RAISE EXCEPTION
      'FAIL standard bounty rebuy did not settle the old generation before funding exactly one new head: %, replay %',
      v_result,v_replay;
  END IF;
END;
$standard_bounty_success$;

DO $pko_success$
DECLARE
  v_result jsonb;
  v_replay jsonb;
BEGIN
  v_result:=public.process_tournament_rebuy(
    'b7200000-0000-4000-8000-000000000002',
    'b7100000-0000-4000-8000-000000000003',
    'rebuy',10,100,1,'atomic-pko-rebuy');
  v_replay:=public.process_tournament_rebuy(
    'b7200000-0000-4000-8000-000000000002',
    'b7100000-0000-4000-8000-000000000003',
    'rebuy',10,100,1,'atomic-pko-rebuy');

  IF v_result IS DISTINCT FROM v_replay
     OR v_result->>'success'<>'true'
     OR v_result->>'candidate_state'<>'rebought'
     OR v_result->>'prior_bounty_marker_verified'<>'true'
     OR (v_result->>'bounty_head_funded')::numeric<>5
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_bounty_obligations o
        WHERE o.id=(v_result->>'prior_bounty_obligation_id')::uuid
          AND o.tournament_id='b7200000-0000-4000-8000-000000000002'
          AND o.eliminated_user_id='b7100000-0000-4000-8000-000000000003'
          AND o.hand_id='b7600000-0000-4000-8000-000000000002'
          AND o.hand_number=9720002 AND o.state='settled'
          AND o.mode='pko' AND o.head_amount=5
          AND public.fn_bounty_obligation_has_complete_marker(o.id))
     OR (SELECT count(*) FROM public.tournament_bounties b
          WHERE b.bounty_obligation_id=
            (v_result->>'prior_bounty_obligation_id')::uuid
            AND b.eliminated_player_id=
              'b7100000-0000-4000-8000-000000000003'
            AND b.collector_player_id=
              'b7100000-0000-4000-8000-000000000004'
            AND b.bounty_amount=5
            AND b.added_to_collector_bounty=2.5)<>1
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id='b7200000-0000-4000-8000-000000000002'
          AND tp.user_id='b7100000-0000-4000-8000-000000000003'
          AND tp.status='playing' AND tp.chips=100
          AND tp.current_bounty=5 AND tp.rebuy_prompt_until IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id='b7200000-0000-4000-8000-000000000002'
          AND tp.user_id='b7100000-0000-4000-8000-000000000004'
          AND tp.current_bounty=7.5 AND tp.bounty_winnings=2.5)
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='20000000-0000-0000-0000-000000000001'
            AND user_id='b7100000-0000-4000-8000-000000000003')<>90
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='20000000-0000-0000-0000-000000000001'
            AND user_id='b7100000-0000-4000-8000-000000000004')<>2.5
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_pko_settlement_watermarks w
        WHERE w.tournament_id='b7200000-0000-4000-8000-000000000002'
          AND w.last_settled_hand_number=9720002
          AND w.last_obligation_id=
            (v_result->>'prior_bounty_obligation_id')::uuid) THEN
    RAISE EXCEPTION
      'FAIL PKO rebuy did not pay the old cash/head split before funding one new head: %, replay %',
      v_result,v_replay;
  END IF;
END;
$pko_success$;

DO $mystery_success$
DECLARE
  v_result jsonb;
  v_replay jsonb;
  v_obligation_id uuid;
BEGIN
  v_result:=public.process_tournament_rebuy(
    'b7200000-0000-4000-8000-000000000003',
    'b7100000-0000-4000-8000-000000000005',
    'rebuy',10,100,1,'atomic-mystery-bounty-rebuy');
  v_replay:=public.process_tournament_rebuy(
    'b7200000-0000-4000-8000-000000000003',
    'b7100000-0000-4000-8000-000000000005',
    'rebuy',10,100,1,'atomic-mystery-bounty-rebuy');
  v_obligation_id:=(v_result->>'prior_bounty_obligation_id')::uuid;

  IF v_result IS DISTINCT FROM v_replay
     OR v_result->>'success'<>'true'
     OR v_result->>'candidate_state'<>'rebought'
     OR v_result->>'prior_bounty_marker_verified'<>'true'
     OR (v_result->>'bounty_head_funded')::numeric<>5
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_bounty_obligations o
        WHERE o.id=v_obligation_id
          AND o.tournament_id='b7200000-0000-4000-8000-000000000003'
          AND o.eliminated_user_id='b7100000-0000-4000-8000-000000000005'
          AND o.hand_id='b7600000-0000-4000-8000-000000000003'
          AND o.hand_number=9720003 AND o.state='settled'
          AND o.mode='mystery_chest' AND o.activation_generation=1
          AND public.fn_bounty_obligation_has_complete_marker(o.id))
     OR NOT EXISTS (
       SELECT 1
         FROM public.tournament_bounty_awards a
         JOIN public.tournament_bounty_chests c ON c.id=a.chest_id
         JOIN public.tournament_bounty_award_recipients r
           ON r.award_id=a.id
        WHERE a.bounty_obligation_id=v_obligation_id
          AND a.tournament_id='b7200000-0000-4000-8000-000000000003'
          AND a.eliminated_user_id='b7100000-0000-4000-8000-000000000005'
          AND a.status='completed' AND a.amount_cents=500
          AND a.activation_generation=1
          AND c.id='b7900000-0000-4000-8000-000000000003'
          AND c.status='paid' AND c.award_id=a.id
          AND r.user_id='b7100000-0000-4000-8000-000000000006'
          AND r.amount_cents=500 AND r.paid_at IS NOT NULL)
     OR (SELECT count(*) FROM public.tournament_bounties b
          WHERE b.bounty_obligation_id=v_obligation_id
            AND b.eliminated_player_id=
              'b7100000-0000-4000-8000-000000000005'
            AND b.collector_player_id=
              'b7100000-0000-4000-8000-000000000006'
            AND b.bounty_amount=5
            AND b.is_mystery_revealed)<>1
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id='b7200000-0000-4000-8000-000000000003'
          AND tp.user_id='b7100000-0000-4000-8000-000000000005'
          AND tp.status='playing' AND tp.chips=100
          AND tp.current_bounty=5 AND tp.rebuy_prompt_until IS NULL)
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='20000000-0000-0000-0000-000000000001'
            AND user_id='b7100000-0000-4000-8000-000000000005')<>90
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='20000000-0000-0000-0000-000000000001'
            AND user_id='b7100000-0000-4000-8000-000000000006')<>5 THEN
    RAISE EXCEPTION
      'FAIL mystery bounty rebuy did not complete its exact chest before funding one new head: %, replay %',
      v_result,v_replay;
  END IF;
END;
$mystery_success$;

CREATE FUNCTION pg_temp.bounty_rebuy_state(
  p_tournament_id uuid,
  p_user_ids uuid[]
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public','pg_temp'
AS $state$
  SELECT jsonb_build_object(
    'tournament',(SELECT to_jsonb(t) FROM public.tournaments t
                   WHERE t.id=p_tournament_id),
    'tables',COALESCE((SELECT jsonb_agg(to_jsonb(tb) ORDER BY tb.id)
      FROM public.tables tb WHERE tb.tournament_id=p_tournament_id),'[]'::jsonb),
    'players',COALESCE((SELECT jsonb_agg(to_jsonb(tp) ORDER BY tp.id)
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id),'[]'::jsonb),
    'seats',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id),'[]'::jsonb),
    'candidates',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)
      FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id),'[]'::jsonb),
    'atomic_hands',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.hand_number)
      FROM public.hand_atomic_commits h JOIN public.tables tb ON tb.id=h.table_id
     WHERE tb.tournament_id=p_tournament_id),'[]'::jsonb),
    'settlements',COALESCE((SELECT jsonb_agg(to_jsonb(k) ORDER BY k.hand_id)
      FROM public.settlement_idempotency_keys k
      JOIN public.tables tb ON tb.id=k.table_id
     WHERE tb.tournament_id=p_tournament_id),'[]'::jsonb),
    'obligations',COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id)
      FROM public.tournament_bounty_obligations o
     WHERE o.tournament_id=p_tournament_id),'[]'::jsonb),
    'payouts',COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id)
      FROM public.tournament_bounties b
     WHERE b.tournament_id=p_tournament_id),'[]'::jsonb),
    'money_obligations',COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id)
      FROM public.tournament_obligations o
     WHERE o.tournament_id=p_tournament_id),'[]'::jsonb),
    'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e
               WHERE e.tournament_id=p_tournament_id),
    'wallets',COALESCE((SELECT jsonb_agg(to_jsonb(cm) ORDER BY cm.user_id)
      FROM public.club_members cm
     WHERE cm.club_id='20000000-0000-0000-0000-000000000001'
       AND cm.user_id=ANY(p_user_ids)),'[]'::jsonb),
    'wallet_transactions',COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id)
      FROM public.wallet_transactions w
     WHERE w.related_entity_id=p_tournament_id),'[]'::jsonb),
    'wallet_keys',COALESCE((SELECT jsonb_agg(to_jsonb(k) ORDER BY k.key)
      FROM public.wallet_credit_idempotency k
     WHERE k.key LIKE 'tourney:'||p_tournament_id::text||':%'),'[]'::jsonb),
    'entry_receipts',COALESCE((SELECT jsonb_agg(to_jsonb(r)
          ORDER BY r.key_domain,r.idempotency_key)
      FROM public.entry_purchase_idempotency_receipts r
     WHERE r.idempotency_key LIKE
       'tourney:'||p_tournament_id::text||':%'),'[]'::jsonb),
    'ledger',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.chain_seq,l.id)
      FROM public.chip_ledger l
     WHERE l.tournament_id=p_tournament_id),'[]'::jsonb),
    'refund_evidence',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)
      FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=p_tournament_id),'[]'::jsonb),
    'rake',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)
      FROM public.rake_records r
     WHERE r.tournament_id=p_tournament_id),'[]'::jsonb),
    'wakes',COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id)
      FROM public.tournament_manager_wakes w
     WHERE w.tournament_id=p_tournament_id),'[]'::jsonb),
    'seat_exit_authority',COALESCE((SELECT jsonb_agg(to_jsonb(a)
          ORDER BY a.token,a.seat_id)
      FROM public.tournament_seat_exit_authorizations a
     WHERE a.tournament_id=p_tournament_id),'[]'::jsonb),
    'alerts',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
      FROM public.financial_alerts a
     WHERE a.context->>'tournament_id'=p_tournament_id::text),'[]'::jsonb)
  );
$state$;

-- A candidate row cannot replace the accepted-hand proof. Corrupt the atomic
-- zero inside a subtransaction, demand refusal, and prove both the corruption
-- and every attempted rebuy mutation rolled back to the byte-for-byte state.
DO $evidence_failure_is_closed$
DECLARE
  v_before jsonb:=pg_temp.bounty_rebuy_state(
    'b7200000-0000-4000-8000-000000000004',
    ARRAY[
      'b7100000-0000-4000-8000-000000000007'::uuid,
      'b7100000-0000-4000-8000-000000000008'::uuid]);
  v_refused boolean:=false;
BEGIN
  BEGIN
    UPDATE public.hand_atomic_commits h
       SET stack_result=jsonb_set(
         h.stack_result,
         '{written,b7100000-0000-4000-8000-000000000007}',
         '1'::jsonb,false)
     WHERE h.table_id='b7300000-0000-4000-8000-000000000004'
       AND h.hand_number=9720004;
    PERFORM public.process_tournament_rebuy(
      'b7200000-0000-4000-8000-000000000004',
      'b7100000-0000-4000-8000-000000000007',
      'rebuy',10,100,1,'atomic-bounty-evidence-refusal');
  EXCEPTION WHEN OTHERS THEN
    v_refused:=SQLERRM LIKE
      '%candidate hand did not commit a zero stack%';
  END;

  IF NOT v_refused
     OR pg_temp.bounty_rebuy_state(
          'b7200000-0000-4000-8000-000000000004',
          ARRAY[
            'b7100000-0000-4000-8000-000000000007'::uuid,
            'b7100000-0000-4000-8000-000000000008'::uuid])
          IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION
      'FAIL mismatched accepted-hand evidence did not refuse without any state change';
  END IF;
END;
$evidence_failure_is_closed$;

CREATE FUNCTION pg_temp.reject_final_bounty_rebuy_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $failure$
BEGIN
  IF NEW.idempotency_key LIKE '%:tok:atomic-bounty-late-failure'
     AND OLD.response IS NULL AND NEW.response IS NOT NULL THEN
    RAISE EXCEPTION 'injected final bounty rebuy receipt failure'
      USING ERRCODE='ZX921';
  END IF;
  RETURN NEW;
END;
$failure$;

CREATE TRIGGER zz_probe_reject_final_bounty_rebuy_receipt
  BEFORE UPDATE OF response
  ON public.entry_purchase_idempotency_receipts
  FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_final_bounty_rebuy_receipt();

-- This fault lands after old-head payout, wallet debit, new-head funding, seat
-- assignment, candidate close, and manager wake. The outer exception creates
-- a subtransaction and proves none of those rows or balances survive alone.
DO $late_failure_rolls_everything_back$
DECLARE
  v_before jsonb:=pg_temp.bounty_rebuy_state(
    'b7200000-0000-4000-8000-000000000004',
    ARRAY[
      'b7100000-0000-4000-8000-000000000007'::uuid,
      'b7100000-0000-4000-8000-000000000008'::uuid]);
  v_refused boolean:=false;
BEGIN
  BEGIN
    PERFORM public.process_tournament_rebuy(
      'b7200000-0000-4000-8000-000000000004',
      'b7100000-0000-4000-8000-000000000007',
      'rebuy',10,100,1,'atomic-bounty-late-failure');
  EXCEPTION WHEN SQLSTATE 'ZX921' THEN
    v_refused:=SQLERRM='injected final bounty rebuy receipt failure';
  END;

  IF NOT v_refused
     OR pg_temp.bounty_rebuy_state(
          'b7200000-0000-4000-8000-000000000004',
          ARRAY[
            'b7100000-0000-4000-8000-000000000007'::uuid,
            'b7100000-0000-4000-8000-000000000008'::uuid])
          IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION
      'FAIL a late rebuy fault left payout, debit, head, seat, candidate, wake, or receipt state behind';
  END IF;
END;
$late_failure_rolls_everything_back$;

DROP TRIGGER zz_probe_reject_final_bounty_rebuy_receipt
  ON public.entry_purchase_idempotency_receipts;

DO $pass$
BEGIN
  RAISE EXCEPTION
    'AUDIT_TEST_PASS: bounty, PKO, and mystery rebuy each settled the exact old generation before one new head; exact-evidence and injected late failures left no payout, debit, head, seat, candidate, wake, or receipt behind; fixtures rolled back';
END;
$pass$;
