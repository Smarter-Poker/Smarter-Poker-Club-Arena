SET ROLE postgres; SET request.jwt.claim.role='service_role'; SET request.jwt.claims='{"role":"service_role"}';
-- Seed only the structural source rows shared by the atomic terminal SQL
-- probes. Run as postgres on a disposable schema-replay database after all
-- stage-one migrations. Individual probes clone these rows inside rollback
-- transactions and never mutate this template.
BEGIN;
SET LOCAL session_replication_role = replica;

INSERT INTO auth.users(id) VALUES
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d'),
  ('10000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users(id,username) VALUES
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','club_arena_system'),
  ('10000000-0000-0000-0000-000000000001','probe_user_1'),
  ('10000000-0000-0000-0000-000000000002','probe_user_2')
ON CONFLICT (id) DO NOTHING;

-- The hand-boundary probe intentionally creates profile 2 itself and rolls it
-- back, so only the common clone source belongs in this persistent fixture.
INSERT INTO public.profiles(id,username,display_name) VALUES
  ('10000000-0000-0000-0000-000000000001',
   'probe_user_1','Probe User One')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clubs(id,name,owner_id,chip_treasury) VALUES
  ('20000000-0000-0000-0000-000000000001','Atomic Probe Club',
   '10000000-0000-0000-0000-000000000001',1000)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
VALUES
  ('20000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001','owner','active',0),
  ('20000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002','player','active',0)
ON CONFLICT (club_id,user_id) DO NOTHING;

-- Terminal money probes begin after every promised purchase window closes.
-- The hand-boundary probe explicitly overrides levels and rebuy eligibility.
INSERT INTO public.tournaments(
  id,club_id,name,buy_in_amount,buy_in_fee,start_time,max_players,status,
  prize_pool,bounty_pool,bounty_pool_paid,total_rake,guaranteed_prize,
  current_players,payout_structure,prize_pool_finalized,
  started_at,current_level,late_reg_levels,rebuy_levels,late_reg_mins,
  is_rebuy,is_reentry,add_on_available,addon_period_started_at,addon_period_ends_at)
VALUES(
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001','Atomic Probe Template',
  10,0,now(),9,'RUNNING',10,0,0,0,0,1,
  '[{"place":1,"percentage":100}]'::jsonb,false,
  now()-interval '2 hours',5,4,4,60,false,false,false,NULL,NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,username,chips,status,prize,current_bounty,
  bounty_winnings,mystery_bounty_value)
VALUES(
  '31000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'Probe User One',10,'playing',0,0,0,0)
ON CONFLICT (tournament_id,user_id) DO NOTHING;

INSERT INTO public.tournament_escrow(
  tournament_id,gross_in,fee_entries_in,satellite_fee_in,bounty_in,
  overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,
  refund_bounty,refund_fee,reserve_out,reserve_in,prize_balance,
  bounty_balance,fee_balance,opened_from,opened_at,updated_at,enforced)
VALUES(
  '30000000-0000-0000-0000-000000000001',
  10,0,0,0,0,0,0,0,0,0,0,0,0,0,10,0,0,
  'atomic-probe-template',now(),now(),true)
ON CONFLICT (tournament_id) DO NOTHING;

COMMIT;

BEGIN; CREATE SCHEMA cash_retirement_native;
-- Run as postgres only on a disposable clone after the complete stage-one
-- migration replay. The final AUDIT_TEST_PASS exception intentionally rolls
-- back the fixture, temporary fault and every accepted-hand evidence row.


DO $fixture_guard$
BEGIN
  IF current_user <> 'postgres'
     OR NOT EXISTS (
       SELECT 1 FROM public.tournaments
        WHERE id='30000000-0000-0000-0000-000000000001'::uuid)
     OR to_regprocedure(
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)')
          IS NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)')
          IS NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)')
          IS NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)')
          IS NULL
     OR to_regclass('public.hand_atomic_commits') IS NULL
     OR to_regclass('public.tournament_knockout_candidates') IS NULL
     OR to_regclass('public.tournament_manager_wakes') IS NULL THEN
    RAISE EXCEPTION
      'atomic tournament hand boundary probe requires the disposable stage-one rehearsal database';
  END IF;
END;
$fixture_guard$;

SET LOCAL session_replication_role = replica;

INSERT INTO public.profiles(id,username,display_name)
VALUES (
  '10000000-0000-0000-0000-000000000002',
  'atomic_hand_boundary_2','Atomic Hand Boundary Two');

INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,
  to_jsonb(t) || jsonb_build_object(
    'id','86000000-0000-0000-0000-000000000001',
    'name','Atomic Tournament Hand Boundary Probe',
    'status','RUNNING','ended_at',NULL,'updated_at',now(),
    'current_players',2,'max_players',2,
    'prize_pool',20,'guaranteed_prize',0,
    'prize_pool_finalized',false,'bounty_pool',0,'bounty_pool_paid',0,
    'starting_chips',10,
    'is_bounty',false,'is_pko',false,'is_mystery_bounty',false,
    'is_rebuy',true,'is_reentry',true,'add_on_available',false,
    'max_rebuys',5,'max_reentries',5,
    'rebuy_cost',10,'rebuy_chips',10,
    'rebuy_levels',5,'late_reg_levels',5,'current_level',1
  ))).*
  FROM public.tournaments t
 WHERE t.id='30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tables
  (id,name,tournament_id,status,lifecycle,current_players,game_type,club_id)
VALUES
  ('86100000-0000-0000-0000-000000000001',
   'Atomic Tournament Hand Boundary Table',
   '86000000-0000-0000-0000-000000000001',
   'running','live',2,'tournament',
   '20000000-0000-0000-0000-000000000001');

UPDATE public.tables SET seat_game_scope='table:'||id::text,
 seat_admission_key='tournament:'||tournament_id::text
 WHERE id='86100000-0000-0000-0000-000000000001';
INSERT INTO public.tournament_players
SELECT (jsonb_populate_record(NULL::public.tournament_players,
  to_jsonb(tp) || jsonb_build_object(
    'id','86200000-0000-0000-0000-000000000001',
    'tournament_id','86000000-0000-0000-0000-000000000001',
    'user_id','10000000-0000-0000-0000-000000000001',
    'chips',10,'status','playing','position',NULL,'prize',0,
    'eliminated_at',NULL,'elimination_sequence',NULL,
    'rebuy_prompt_until',NULL,
    'table_id','86100000-0000-0000-0000-000000000001','seat_number',1
  ))).*
  FROM public.tournament_players tp
 WHERE tp.tournament_id='30000000-0000-0000-0000-000000000001'::uuid
   AND tp.user_id='10000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournament_escrow(
  tournament_id,gross_in,fee_entries_in,satellite_fee_in,bounty_in,
  overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,
  refund_bounty,refund_fee,reserve_out,reserve_in,prize_balance,
  bounty_balance,fee_balance,opened_from,opened_at,updated_at,enforced)
VALUES(
  '86000000-0000-0000-0000-000000000001',
  20,0,0,0,0,0,0,0,0,0,0,0,0,0,20,0,0,
  'atomic-hand-boundary-probe',now(),now(),true);

UPDATE public.club_members
   SET chip_balance=100
 WHERE club_id='20000000-0000-0000-0000-000000000001'::uuid
   AND user_id='10000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournament_players
SELECT (jsonb_populate_record(NULL::public.tournament_players,
  to_jsonb(tp) || jsonb_build_object(
    'id','86200000-0000-0000-0000-000000000002',
    'tournament_id','86000000-0000-0000-0000-000000000001',
    'user_id','10000000-0000-0000-0000-000000000002',
    'chips',10,'status','playing','position',NULL,'prize',0,
    'eliminated_at',NULL,'elimination_sequence',NULL,
    'rebuy_prompt_until',NULL,
    'table_id','86100000-0000-0000-0000-000000000001','seat_number',2
  ))).*
  FROM public.tournament_players tp
 WHERE tp.tournament_id='30000000-0000-0000-0000-000000000001'::uuid
   AND tp.user_id='10000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.table_seats
  (id,table_id,seat_number,user_id,stack,status,left_at,joined_at,
   leave_pending,is_sitting_out,is_away,club_id,
   time_bank_uses_remaining,time_bank_remaining,active_game_scope,active_parent_key)
VALUES
  ('86300000-0000-0000-0000-000000000001',
   '86100000-0000-0000-0000-000000000001',1,
   '10000000-0000-0000-0000-000000000001',10,'active',NULL,
   '2026-09-08 12:00:00+00',false,false,false,
   '20000000-0000-0000-0000-000000000001',4,30,'table:86100000-0000-0000-0000-000000000001','tournament:86000000-0000-0000-0000-000000000001'),
  ('86300000-0000-0000-0000-000000000002',
   '86100000-0000-0000-0000-000000000001',2,
   '10000000-0000-0000-0000-000000000002',10,'active',NULL,
   '2026-09-08 12:00:01+00',false,false,false,
   '20000000-0000-0000-0000-000000000001',4,30,'table:86100000-0000-0000-0000-000000000001','tournament:86000000-0000-0000-0000-000000000001');

INSERT INTO public.engine_tournament_leases(
  tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,
  lease_generation,protocol_version)
VALUES (
  '86000000-0000-0000-0000-000000000001',
  'atomic-hand-boundary-probe','probe',
  clock_timestamp(),clock_timestamp(),
  '86500000-0000-0000-0000-000000000001',2);




SET LOCAL session_replication_role = origin;
CREATE FUNCTION cash_retirement_native.atomic_hand_stacks()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $stacks$
  SELECT jsonb_build_array(
    jsonb_build_object(
      'seat_id','86300000-0000-0000-0000-000000000001','seat_joined_at','2026-09-08T12:00:00+00:00','user_id','10000000-0000-0000-0000-000000000001',
      'stack_before',10,'stack',0),
    jsonb_build_object(
      'seat_id','86300000-0000-0000-0000-000000000002','seat_joined_at','2026-09-08T12:00:01+00:00','user_id','10000000-0000-0000-0000-000000000002',
      'stack_before',10,'stack',20));
$stacks$;

CREATE FUNCTION cash_retirement_native.atomic_hand_row()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $hand$
  SELECT jsonb_build_object(
    'id','86400000-0000-0000-0000-000000000001',
    'table_id','86100000-0000-0000-0000-000000000001',
    'tournament_id','86000000-0000-0000-0000-000000000001',
    'hand_number',8600001,
    'game_variant','nlh',
    'small_blind',1,
    'big_blind',2,
    'pot_size',20,
    'rake_amount',0,
    'bbj_amount',0,
    'players',jsonb_build_array(
      jsonb_build_object(
        'user_id','10000000-0000-0000-0000-000000000001','stack',0),
      jsonb_build_object(
        'user_id','10000000-0000-0000-0000-000000000002','stack',20)),
    'actions','[]'::jsonb,
    'winners',jsonb_build_array(
      jsonb_build_object(
        'user_id','10000000-0000-0000-0000-000000000002','amount',20)),
    '_accepted_post_commit_facts',jsonb_build_object(
      'contributions',jsonb_build_object(
        '10000000-0000-0000-0000-000000000001',10,
        '10000000-0000-0000-0000-000000000002',10),
      'returned_uncalled','{}'::jsonb,
      'insurance','[]'::jsonb));
$hand$;

CREATE FUNCTION cash_retirement_native.atomic_hand_obligations()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $obligations$
  SELECT jsonb_build_object(
    'version','1',
    'time_banks',jsonb_build_array(
      jsonb_build_object(
        'seat_id','86300000-0000-0000-0000-000000000001','seat_joined_at','2026-09-08T12:00:00+00:00','user_id','10000000-0000-0000-0000-000000000001',
        'uses_remaining',3,'seconds_remaining',17),
      jsonb_build_object(
        'seat_id','86300000-0000-0000-0000-000000000002','seat_joined_at','2026-09-08T12:00:01+00:00','user_id','10000000-0000-0000-0000-000000000002',
        'uses_remaining',2,'seconds_remaining',19)),
    'promo_playthrough','[]'::jsonb,
    'insurance','[]'::jsonb,
    'pending_addons','null'::jsonb,
    'rake','null'::jsonb,
    'bbj_contribution','null'::jsonb);
$obligations$;

CREATE FUNCTION cash_retirement_native.submission_request() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
 'p_table_id','86100000-0000-0000-0000-000000000001','p_hand_number',8600001,
 'p_stacks',cash_retirement_native.atomic_hand_stacks(),'p_rake',0,'p_bbj',0,'p_ref','atomic-zero-seat','p_inflow',0,
 'p_hand_row',cash_retirement_native.atomic_hand_row(),'p_units','[]'::jsonb,
 'p_instance_id','atomic-hand-boundary-probe','p_lease_generation','86500000-0000-0000-0000-000000000001',
 'p_post_commit_obligations',cash_retirement_native.atomic_hand_obligations());
$$;
CREATE FUNCTION cash_retirement_native.commit_submission() RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.fn_ca_commit_hand_submission('86400000-0000-0000-0000-000000000001',
 'atomic-hand-boundary-probe','86500000-0000-0000-0000-000000000001');
$$;
CREATE FUNCTION cash_retirement_native.submission_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'HAND SUBMISSION FAIL: %',label; END IF;
RAISE NOTICE 'HAND SUBMISSION PASS: %',label; END $$;


COMMIT;