-- Rollback-only proof for the two distinct seat-first products. Their
-- start_time is deliberately one hour old: it is the expired human fill
-- window, never the instant either game began. The first Spin and Heads-Up
-- Sit & Go must refund; the second pair has immutable completed launch
-- receipts and must refuse without moving money. Two scheduled MTTs then
-- prove that durable started_at and completed-launch evidence close the same
-- door even while status and the future schedule still look open. The third pair keeps both
-- launch receipt and started_at absent but has persisted hand history; that
-- irreversible play evidence must close both refund doors too.
BEGIN;

SET LOCAL session_replication_role=replica;

UPDATE public.engine_maintenance_break
   SET enforce_freeze=false,updated_at=now()
 WHERE id=true;

INSERT INTO auth.users(id) VALUES
  ('a1100000-0000-4000-8000-000000000001');

INSERT INTO public.users(id,username) VALUES
  ('a1100000-0000-4000-8000-000000000001','seat_first_unregister_probe');

INSERT INTO public.profiles(id,username,display_name) VALUES
  ('a1100000-0000-4000-8000-000000000001',
   'seat_first_unregister_probe','Seat First Unregister Probe');

INSERT INTO public.clubs(id,club_id,name,owner_id) VALUES(
  'a1200000-0000-4000-8000-000000000001',991301,
  'Seat First Unregister Probe Club',
  'a1100000-0000-4000-8000-000000000001'
);

INSERT INTO public.club_members(
  club_id,user_id,role,status,chip_balance,joined_at
) VALUES(
  'a1200000-0000-4000-8000-000000000001',
  'a1100000-0000-4000-8000-000000000001',
  'owner','active',100,now()-interval '1 day'
);

INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES(
  'a1300000-0000-4000-8000-000000000001',
  'a1100000-0000-4000-8000-000000000001',now(),now()
);

INSERT INTO public.ca_settle_sources(source,note) VALUES(
  'fn_unregister_from_tournament','seat-first actual-start probe'
) ON CONFLICT (source) DO NOTHING;

INSERT INTO public.tournaments(
  id,name,club_id,game_type,variant,tournament_type,
  buy_in_amount,buy_in_fee,starting_chips,start_time,started_at,status,
  current_players,max_players,min_players,table_size,current_level,
  prize_pool,total_rake,bounty_pool,entry_contract_locked,
  late_reg_levels,late_reg_mins,synchronized_breaks
) VALUES
  (
    'a1400000-0000-4000-8000-000000000001',
    'Spin Fill Window Expired But Not Started',
    'a1200000-0000-4000-8000-000000000001','NLH','spin','SPIN',
    1,0,1000,clock_timestamp()+interval '1 day',NULL,'REGISTERING',
    0,3,3,3,1,0,0,0,false,0,0,false
  ),
  (
    'a1400000-0000-4000-8000-000000000002',
    'Heads-Up SNG Fill Window Expired But Not Started',
    'a1200000-0000-4000-8000-000000000001','NLH','sng','SNG',
    1,0,1000,clock_timestamp()+interval '1 day',NULL,'REGISTERING',
    0,2,2,2,1,0,0,0,false,0,0,false
  ),
  (
    'a1400000-0000-4000-8000-000000000003',
    'Spin Completed Launch Refusal',
    'a1200000-0000-4000-8000-000000000001','NLH','spin','SPIN',
    1,0,1000,clock_timestamp()+interval '1 day',NULL,'REGISTERING',
    0,3,3,3,1,0,0,0,false,0,0,false
  ),
  (
    'a1400000-0000-4000-8000-000000000004',
    'Heads-Up SNG Completed Launch Refusal',
    'a1200000-0000-4000-8000-000000000001','NLH','sng','SNG',
    1,0,1000,clock_timestamp()+interval '1 day',NULL,'REGISTERING',
    0,2,2,2,1,0,0,0,false,0,0,false
  ),
  (
    'a1400000-0000-4000-8000-000000000005',
    'Spin Persisted Hand Refusal',
    'a1200000-0000-4000-8000-000000000001','NLH','spin','SPIN',
    1,0,1000,clock_timestamp()+interval '1 day',NULL,'REGISTERING',
    0,3,3,3,1,0,0,0,false,0,0,false
  ),
  (
    'a1400000-0000-4000-8000-000000000006',
    'Heads-Up SNG Persisted Hand Refusal',
    'a1200000-0000-4000-8000-000000000001','NLH','sng','SNG',
    1,0,1000,clock_timestamp()+interval '1 day',NULL,'REGISTERING',
    0,2,2,2,1,0,0,0,false,0,0,false
  ),
  (
    'a1400000-0000-4000-8000-000000000007',
    'Scheduled MTT Started At Refusal',
    'a1200000-0000-4000-8000-000000000001','NLH','nlh','MTT',
    1,0,1000,clock_timestamp()+interval '1 day',clock_timestamp(),'REGISTERING',
    1,100,2,9,1,1,0,0,false,0,0,false
  ),
  (
    'a1400000-0000-4000-8000-000000000008',
    'Scheduled MTT Completed Launch Refusal',
    'a1200000-0000-4000-8000-000000000001','NLH','nlh','MTT',
    1,0,1000,clock_timestamp()+interval '1 day',NULL,'REGISTERING',
    1,100,2,9,1,1,0,0,false,0,0,false
  );

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,username,chips,status,club_id,
  is_satellite_qualifier
) VALUES
  ('a1900000-0000-4000-8000-000000000007',
   'a1400000-0000-4000-8000-000000000007',
   'a1100000-0000-4000-8000-000000000001',
   'Seat First Unregister Probe',1000,'registered',
   'a1200000-0000-4000-8000-000000000001',false),
  ('a1900000-0000-4000-8000-000000000008',
   'a1400000-0000-4000-8000-000000000008',
   'a1100000-0000-4000-8000-000000000001',
   'Seat First Unregister Probe',1000,'registered',
   'a1200000-0000-4000-8000-000000000001',false);

INSERT INTO public.tables(
  id,club_id,name,game_type,game_variant,max_players,current_players,
  status,starting_chips,is_spins,tournament_id,lifecycle
) VALUES
  ('a1500000-0000-4000-8000-000000000001',
   'a1200000-0000-4000-8000-000000000001','Spin Prestart Table',
   'tournament','nlh',3,0,'waiting',1000,true,
   'a1400000-0000-4000-8000-000000000001','live'),
  ('a1500000-0000-4000-8000-000000000002',
   'a1200000-0000-4000-8000-000000000001','Heads-Up SNG Prestart Table',
   'tournament','nlh',2,0,'waiting',1000,false,
   'a1400000-0000-4000-8000-000000000002','live'),
  ('a1500000-0000-4000-8000-000000000003',
   'a1200000-0000-4000-8000-000000000001','Spin Started Table',
   'tournament','nlh',3,0,'waiting',1000,true,
   'a1400000-0000-4000-8000-000000000003','live'),
  ('a1500000-0000-4000-8000-000000000004',
   'a1200000-0000-4000-8000-000000000001','Heads-Up SNG Started Table',
   'tournament','nlh',2,0,'waiting',1000,false,
   'a1400000-0000-4000-8000-000000000004','live'),
  ('a1500000-0000-4000-8000-000000000005',
   'a1200000-0000-4000-8000-000000000001','Spin Persisted Hand Table',
   'tournament','nlh',3,0,'waiting',1000,true,
   'a1400000-0000-4000-8000-000000000005','live'),
  ('a1500000-0000-4000-8000-000000000006',
   'a1200000-0000-4000-8000-000000000001','Heads-Up SNG Persisted Hand Table',
   'tournament','nlh',2,0,'waiting',1000,false,
   'a1400000-0000-4000-8000-000000000006','live');

SET LOCAL session_replication_role=origin;

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub','a1100000-0000-4000-8000-000000000001',
    'role','authenticated',
    'session_id','a1300000-0000-4000-8000-000000000001')::text,
  true
);

CREATE TEMP TABLE seat_first_probe_results(
  phase text PRIMARY KEY,
  value jsonb NOT NULL
) ON COMMIT DROP;
GRANT SELECT,INSERT ON seat_first_probe_results TO authenticated;

SET LOCAL ROLE authenticated;
INSERT INTO seat_first_probe_results(phase,value) VALUES
  ('spin_registration',public.fn_take_seat_and_buy_in(
    'a1500000-0000-4000-8000-000000000001',1)),
  ('heads_up_registration',public.fn_take_seat_and_buy_in(
    'a1500000-0000-4000-8000-000000000002',1)),
  ('spin_started_registration',public.fn_take_seat_and_buy_in(
    'a1500000-0000-4000-8000-000000000003',1)),
  ('heads_up_started_registration',public.fn_take_seat_and_buy_in(
    'a1500000-0000-4000-8000-000000000004',1));
RESET ROLE;

DO $registration_proof$
BEGIN
  IF (SELECT count(*) FROM seat_first_probe_results r
       WHERE r.phase LIKE '%registration'
         AND COALESCE((r.value->>'ok')::boolean,false)
         AND (r.value->>'cost')::numeric=1)<>4 THEN
    RAISE EXCEPTION 'FAIL real wallet registrations did not commit: %',
      (SELECT jsonb_object_agg(r.phase,r.value)
         FROM seat_first_probe_results r
        WHERE r.phase LIKE '%registration');
  END IF;
END;
$registration_proof$;

-- Registration above uses each product's real seat-taking door, identity and
-- wallet/journal/entitlement authority. One paid seat cannot trigger a Spin
-- draw. Fixture-only DML now expires each fill window.
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments t
   SET start_time=clock_timestamp()-interval '1 hour'
 WHERE t.id IN (
   'a1400000-0000-4000-8000-000000000001',
   'a1400000-0000-4000-8000-000000000002',
   'a1400000-0000-4000-8000-000000000003',
   'a1400000-0000-4000-8000-000000000004');
SET LOCAL session_replication_role=origin;

SET LOCAL ROLE authenticated;
INSERT INTO seat_first_probe_results(phase,value) VALUES
  ('spin_prestart_refund',public.fn_unregister_from_tournament(
    'a1400000-0000-4000-8000-000000000001',
    'a1600000-0000-4000-8000-000000000001')),
  ('heads_up_prestart_refund',public.fn_unregister_from_tournament(
    'a1400000-0000-4000-8000-000000000002',
    'a1600000-0000-4000-8000-000000000002'));
RESET ROLE;

DO $prestart_refund_proof$
DECLARE
  v_spin jsonb:=(SELECT value FROM seat_first_probe_results
                  WHERE phase='spin_prestart_refund');
  v_heads_up jsonb:=(SELECT value FROM seat_first_probe_results
                      WHERE phase='heads_up_prestart_refund');
BEGIN
  IF COALESCE((v_spin->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_spin->>'replayed')::boolean,true)
     OR (v_spin->>'refunded_chips')::numeric IS DISTINCT FROM 1
     OR v_spin->>'start_authority' IS DISTINCT FROM 'spin_actual_start'
     OR COALESCE((v_heads_up->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_heads_up->>'replayed')::boolean,true)
     OR (v_heads_up->>'refunded_chips')::numeric IS DISTINCT FROM 1
     OR v_heads_up->>'start_authority'
          IS DISTINCT FROM 'heads_up_sng_actual_start'
     OR (SELECT count(*) FROM public.tournament_unregistration_receipts r
          WHERE r.start_authority='spin_actual_start'
            AND r.settled_at>=r.scheduled_start_at)<>1
     OR (SELECT count(*) FROM public.tournament_unregistration_receipts r
          WHERE r.start_authority='heads_up_sng_actual_start'
            AND r.settled_at>=r.scheduled_start_at)<>1
     OR EXISTS (
       SELECT 1 FROM public.tournament_players p
        WHERE p.tournament_id IN (
          'a1400000-0000-4000-8000-000000000001',
          'a1400000-0000-4000-8000-000000000002'))
     OR EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id IN (
          'a1500000-0000-4000-8000-000000000001',
          'a1500000-0000-4000-8000-000000000002')
          AND s.left_at IS NULL)
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='a1200000-0000-4000-8000-000000000001'
            AND user_id='a1100000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 98 THEN
    RAISE EXCEPTION
      'FAIL expired fill windows blocked a prestart refund: Spin %, Heads-Up %',
      v_spin,v_heads_up;
  END IF;
END;
$prestart_refund_proof$;

-- A completed launch receipt is immutable start truth. Keep the parent rows
-- REGISTERING/started_at NULL to prove the receipt alone closes the refund
-- door; replication-role bypass is fixture setup only.
SET LOCAL session_replication_role=replica;
INSERT INTO public.tournament_launch_receipts(
  tournament_id,launch_id,started_at,claimed_at,completed_at
) VALUES
  ('a1400000-0000-4000-8000-000000000003',
   'a1700000-0000-4000-8000-000000000003',now(),now(),now()),
  ('a1400000-0000-4000-8000-000000000004',
   'a1700000-0000-4000-8000-000000000004',now(),now(),now()),
  ('a1400000-0000-4000-8000-000000000008',
   'a1700000-0000-4000-8000-000000000008',now(),now(),now());
SET LOCAL session_replication_role=origin;

SET LOCAL ROLE authenticated;
INSERT INTO seat_first_probe_results(phase,value) VALUES
  ('spin_after_launch_refusal',public.fn_unregister_from_tournament(
    'a1400000-0000-4000-8000-000000000003',
    'a1600000-0000-4000-8000-000000000003')),
  ('heads_up_after_launch_refusal',public.fn_unregister_from_tournament(
    'a1400000-0000-4000-8000-000000000004',
    'a1600000-0000-4000-8000-000000000004')),
  ('scheduled_after_started_at_refusal',public.fn_unregister_from_tournament(
    'a1400000-0000-4000-8000-000000000007',
    'a1600000-0000-4000-8000-000000000007')),
  ('scheduled_after_launch_refusal',public.fn_unregister_from_tournament(
    'a1400000-0000-4000-8000-000000000008',
    'a1600000-0000-4000-8000-000000000008'));
RESET ROLE;

DO $actual_start_refusal_proof$
DECLARE
  v_spin jsonb:=(SELECT value FROM seat_first_probe_results
                  WHERE phase='spin_after_launch_refusal');
  v_heads_up jsonb:=(SELECT value FROM seat_first_probe_results
                      WHERE phase='heads_up_after_launch_refusal');
  v_scheduled_started_at jsonb:=(SELECT value FROM seat_first_probe_results
                      WHERE phase='scheduled_after_started_at_refusal');
  v_scheduled_launch jsonb:=(SELECT value FROM seat_first_probe_results
                      WHERE phase='scheduled_after_launch_refusal');
BEGIN
  IF COALESCE((v_spin->>'ok')::boolean,true)
     OR v_spin->>'reason' IS DISTINCT FROM 'tournament_started'
     OR COALESCE((v_heads_up->>'ok')::boolean,true)
     OR v_heads_up->>'reason' IS DISTINCT FROM 'tournament_started'
     OR COALESCE((v_scheduled_started_at->>'ok')::boolean,true)
     OR v_scheduled_started_at->>'reason' IS DISTINCT FROM 'tournament_started'
     OR COALESCE((v_scheduled_launch->>'ok')::boolean,true)
     OR v_scheduled_launch->>'reason' IS DISTINCT FROM 'tournament_started'
     OR (SELECT count(*) FROM public.tournament_players p
          WHERE p.tournament_id IN (
            'a1400000-0000-4000-8000-000000000003',
            'a1400000-0000-4000-8000-000000000004',
            'a1400000-0000-4000-8000-000000000007',
            'a1400000-0000-4000-8000-000000000008'))<>4
     OR (SELECT count(*) FROM public.table_seats s
          WHERE s.table_id IN (
            'a1500000-0000-4000-8000-000000000003',
            'a1500000-0000-4000-8000-000000000004')
            AND s.left_at IS NULL)<>2
     OR EXISTS (
       SELECT 1 FROM public.tournament_unregistration_receipts r
        WHERE r.request_id IN (
          'a1600000-0000-4000-8000-000000000003',
          'a1600000-0000-4000-8000-000000000004',
          'a1600000-0000-4000-8000-000000000007',
          'a1600000-0000-4000-8000-000000000008'))
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='a1200000-0000-4000-8000-000000000001'
            AND user_id='a1100000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 98 THEN
    RAISE EXCEPTION
      'FAIL durable actual-start truth did not close every refund door: Spin %, Heads-Up %, scheduled started_at %, scheduled launch %',
      v_spin,v_heads_up,v_scheduled_started_at,v_scheduled_launch;
  END IF;

  RAISE NOTICE
    'AUDIT_TEST_PASS: Spin and Heads-Up SNG separately refunded after their fill-window deadlines while still unstarted; seat-first and scheduled tournaments refused after durable started_at or immutable launch completion; wallet-origin chips returned only to the exact source wallet; all probe work rolls back';
END;
$actual_start_refusal_proof$;

-- The first two successful refunds released two of the four active games, so
-- the same player can take the two persisted-hand probe seats without evading
-- the platform's four-game admission ceiling.
SET LOCAL ROLE authenticated;
INSERT INTO seat_first_probe_results(phase,value) VALUES
  ('spin_hand_registration',public.fn_take_seat_and_buy_in(
    'a1500000-0000-4000-8000-000000000005',1)),
  ('heads_up_hand_registration',public.fn_take_seat_and_buy_in(
    'a1500000-0000-4000-8000-000000000006',1));
RESET ROLE;

DO $persisted_hand_registration_proof$
BEGIN
  IF (SELECT count(*) FROM seat_first_probe_results r
       WHERE r.phase IN ('spin_hand_registration','heads_up_hand_registration')
         AND COALESCE((r.value->>'ok')::boolean,false)
         AND (r.value->>'cost')::numeric=1)<>2
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='a1200000-0000-4000-8000-000000000001'
            AND user_id='a1100000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 96 THEN
    RAISE EXCEPTION 'FAIL persisted-hand registrations did not commit exactly: %',
      (SELECT jsonb_object_agg(r.phase,r.value)
         FROM seat_first_probe_results r
        WHERE r.phase IN ('spin_hand_registration','heads_up_hand_registration'));
  END IF;
END;
$persisted_hand_registration_proof$;

-- Reproduce the interrupted-launch gap exactly: both rows still look open and
-- have no completed launch receipt, while a hand has durably persisted. The
-- Spin row deliberately omits hand_history.tournament_id to prove the linked
-- table fallback; the Heads-Up row proves the canonical direct identifier.
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments t
   SET start_time=clock_timestamp()-interval '1 hour'
 WHERE t.id IN (
   'a1400000-0000-4000-8000-000000000005',
   'a1400000-0000-4000-8000-000000000006');

INSERT INTO public.hand_history(
  id,table_id,tournament_id,hand_number,game_variant,
  small_blind,big_blind,pot_size,rake_amount,players,actions,created_at
) VALUES
  (
    'a1800000-0000-4000-8000-000000000005',
    'a1500000-0000-4000-8000-000000000005',NULL,19130501,'nlh',
    5,10,20,0,'[]'::jsonb,'[]'::jsonb,clock_timestamp()
  ),
  (
    'a1800000-0000-4000-8000-000000000006',
    'a1500000-0000-4000-8000-000000000006',
    'a1400000-0000-4000-8000-000000000006',19130601,'nlh',
    5,10,20,0,'[]'::jsonb,'[]'::jsonb,clock_timestamp()
  );
SET LOCAL session_replication_role=origin;

SET LOCAL ROLE authenticated;
INSERT INTO seat_first_probe_results(phase,value) VALUES
  ('spin_after_hand_refusal',public.fn_unregister_from_tournament(
    'a1400000-0000-4000-8000-000000000005',
    'a1600000-0000-4000-8000-000000000005')),
  ('heads_up_after_hand_refusal',public.fn_unregister_from_tournament(
    'a1400000-0000-4000-8000-000000000006',
    'a1600000-0000-4000-8000-000000000006'));
RESET ROLE;

DO $persisted_hand_refusal_proof$
DECLARE
  v_spin jsonb:=(SELECT value FROM seat_first_probe_results
                  WHERE phase='spin_after_hand_refusal');
  v_heads_up jsonb:=(SELECT value FROM seat_first_probe_results
                      WHERE phase='heads_up_after_hand_refusal');
BEGIN
  IF COALESCE((v_spin->>'ok')::boolean,true)
     OR v_spin->>'reason' IS DISTINCT FROM 'tournament_started'
     OR COALESCE((v_heads_up->>'ok')::boolean,true)
     OR v_heads_up->>'reason' IS DISTINCT FROM 'tournament_started'
     OR EXISTS (
       SELECT 1 FROM public.tournament_launch_receipts r
        WHERE r.tournament_id IN (
          'a1400000-0000-4000-8000-000000000005',
          'a1400000-0000-4000-8000-000000000006'))
     OR EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id IN (
          'a1400000-0000-4000-8000-000000000005',
          'a1400000-0000-4000-8000-000000000006')
          AND (upper(t.status::text)<>'REGISTERING' OR t.started_at IS NOT NULL))
     OR (SELECT count(*) FROM public.tournament_players p
          WHERE p.tournament_id IN (
            'a1400000-0000-4000-8000-000000000005',
            'a1400000-0000-4000-8000-000000000006'))<>2
     OR (SELECT count(*) FROM public.table_seats s
          WHERE s.table_id IN (
            'a1500000-0000-4000-8000-000000000005',
            'a1500000-0000-4000-8000-000000000006')
            AND s.left_at IS NULL)<>2
     OR (SELECT count(*) FROM public.tournament_refund_entitlements e
          WHERE e.tournament_id IN (
            'a1400000-0000-4000-8000-000000000005',
            'a1400000-0000-4000-8000-000000000006')
            AND e.entitlement_kind='wallet_charge'
            AND e.gross=1)<>2
     OR (SELECT count(*) FROM public.tournament_escrow e
          WHERE e.tournament_id IN (
            'a1400000-0000-4000-8000-000000000005',
            'a1400000-0000-4000-8000-000000000006')
            AND e.prize_balance=1
            AND e.bounty_balance=0
            AND e.fee_balance=0)<>2
     OR (SELECT count(*) FROM public.tournaments t
          WHERE t.id IN (
            'a1400000-0000-4000-8000-000000000005',
            'a1400000-0000-4000-8000-000000000006')
            AND t.current_players=1
            AND t.prize_pool=1
            AND t.bounty_pool=0
            AND t.total_rake=0)<>2
     OR EXISTS (
       SELECT 1 FROM public.tournament_unregistration_receipts r
        WHERE r.request_id IN (
          'a1600000-0000-4000-8000-000000000005',
          'a1600000-0000-4000-8000-000000000006'))
     OR (SELECT count(*) FROM public.hand_history h
          WHERE h.id IN (
            'a1800000-0000-4000-8000-000000000005',
            'a1800000-0000-4000-8000-000000000006'))<>2
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='a1200000-0000-4000-8000-000000000001'
            AND user_id='a1100000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 96 THEN
    RAISE EXCEPTION
      'FAIL persisted hand truth did not close both refund doors atomically: Spin %, Heads-Up %',
      v_spin,v_heads_up;
  END IF;

  RAISE NOTICE
    'AUDIT_TEST_PASS: persisted hand history independently closes Spin and Heads-Up SNG unregistration when launch completion and started_at are missing; both direct tournament identity and table-linked legacy identity refuse without moving wallet, escrow, entitlement, roster, or seat state; all probe work rolls back';
END;
$persisted_hand_refusal_proof$;

ROLLBACK;
