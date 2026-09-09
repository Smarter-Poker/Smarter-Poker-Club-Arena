-- Production-shape proof for wallet-funded tournament admission.
--
-- Proves all three live doors that can charge a club wallet:
--   * RUNNING human late registration accepts NULL late/current level fields
--     through the canonical fallback and seats the player atomically;
--   * pre-start human and horse entry count one roster row exactly once;
--   * a closed late-registration window cannot debit or create evidence.
--
-- Every fixture mutation is rolled back. The final PASS exception is
-- intentional and is how the rehearsal runner distinguishes this proof from
-- a script that stopped before reaching its assertions.

BEGIN;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $probe_auth$
  SELECT nullif(current_setting('test.actor',true),'')::uuid
$probe_auth$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $probe_auth$
  SELECT 'service_role'::text
$probe_auth$;

SET LOCAL session_replication_role=replica;

INSERT INTO auth.users(id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003');

INSERT INTO public.users(id,username) VALUES
  ('10000000-0000-4000-8000-000000000001','late_registration_probe'),
  ('10000000-0000-4000-8000-000000000002','prestart_registration_probe'),
  ('10000000-0000-4000-8000-000000000003','horse_registration_probe');

INSERT INTO public.profiles(id,username,is_horse) VALUES
  ('10000000-0000-4000-8000-000000000001','Late Registration Probe',false),
  ('10000000-0000-4000-8000-000000000002','Prestart Registration Probe',false),
  ('10000000-0000-4000-8000-000000000003','Horse Registration Probe',true);

INSERT INTO public.clubs(id,club_id,name) VALUES
  ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',98641,
   'Registration Contract Club');

INSERT INTO public.club_members(
  club_id,user_id,role,status,chip_balance,is_bot
) VALUES
  ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
   '10000000-0000-4000-8000-000000000001','player','active',500,false),
  ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
   '10000000-0000-4000-8000-000000000002','player','active',500,false),
  ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
   '10000000-0000-4000-8000-000000000003','player','active',500,true);

INSERT INTO public.tournaments(
  id,name,buy_in_amount,buy_in_fee,start_time,status,current_players,
  max_players,club_id,prize_pool,total_rake,bounty_pool,
  late_reg_levels,rebuy_levels,current_level,late_reg_mins,started_at,
  starting_chips,entry_contract_locked
) VALUES
  ('30000000-0000-4000-8000-000000000001','Open Nullable-Level Tournament',
   90,10,clock_timestamp()-interval '10 minutes','RUNNING',0,9,
   'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',0,0,0,
   NULL,4,NULL,0,clock_timestamp()-interval '10 minutes',10000,false),
  ('30000000-0000-4000-8000-000000000002','Closed Level Tournament',
   90,10,clock_timestamp()-interval '10 minutes','RUNNING',0,9,
   'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',0,0,0,
   NULL,4,4,0,clock_timestamp()-interval '10 minutes',10000,false),
  ('30000000-0000-4000-8000-000000000003','Prestart Human Tournament',
   90,10,clock_timestamp()+interval '1 hour','REGISTERING',0,9,
   'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',0,0,0,
   4,4,0,60,NULL,10000,false),
  ('30000000-0000-4000-8000-000000000004','Prestart Horse Tournament',
   90,10,clock_timestamp()+interval '1 hour','REGISTERING',0,9,
   'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',0,0,0,
   4,4,0,60,NULL,10000,false);

INSERT INTO public.tables(
  id,club_id,name,game_type,game_variant,stakes,small_blind,big_blind,
  ante,min_buy_in,max_buy_in,max_players,current_players,status,
  tournament_id,action_time_seconds,big_blind_ante_enabled,all_in_or_fold
) VALUES(
  '40000000-0000-4000-8000-000000000001',
  'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
  'Open Nullable-Level Tournament - Table 1','tournament','nlh','50 / 100',
  50,100,0,0,0,9,0,'running',
  '30000000-0000-4000-8000-000000000001',15,false,false
);

SET LOCAL session_replication_role=origin;

CREATE TEMP TABLE registration_probe_results(
  name text PRIMARY KEY,
  value jsonb NOT NULL
) ON COMMIT DROP;

SELECT set_config(
  'test.actor','10000000-0000-4000-8000-000000000001',true);
INSERT INTO registration_probe_results VALUES(
  'late_open',public.fn_register_for_tournament(
    '30000000-0000-4000-8000-000000000001'));
INSERT INTO registration_probe_results VALUES(
  'late_open_replay',public.fn_register_for_tournament(
    '30000000-0000-4000-8000-000000000001'));
INSERT INTO registration_probe_results VALUES(
  'late_closed',public.fn_register_for_tournament(
    '30000000-0000-4000-8000-000000000002'));

SELECT set_config(
  'test.actor','10000000-0000-4000-8000-000000000002',true);
INSERT INTO registration_probe_results VALUES(
  'prestart_human',public.fn_register_for_tournament(
    '30000000-0000-4000-8000-000000000003'));

SELECT set_config(
  'test.actor','10000000-0000-4000-8000-000000000003',true);
INSERT INTO registration_probe_results VALUES(
  'prestart_horse',public.fn_register_horse_for_tournament(
    '30000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000003'));

DO $registration_contract$
DECLARE
  v_result jsonb;
  v_count integer;
BEGIN
  SELECT value INTO v_result FROM registration_probe_results
   WHERE name='late_open';
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'late_registration')::boolean,false) IS NOT TRUE
     OR (v_result->>'cost')::numeric IS DISTINCT FROM 100::numeric
     OR (v_result->>'prize_contribution')::numeric IS DISTINCT FROM 90::numeric
     OR (v_result->>'rake')::numeric IS DISTINCT FROM 10::numeric
     OR COALESCE((v_result->'seat'->>'ok')::boolean,false) IS NOT TRUE
     OR (v_result->'seat'->>'table_id')::uuid IS DISTINCT FROM
          '40000000-0000-4000-8000-000000000001'::uuid
     OR (v_result->'seat'->>'seat_number')::integer IS DISTINCT FROM 1
     OR (v_result->'seat'->>'chips')::integer IS DISTINCT FROM 10000 THEN
    RAISE EXCEPTION 'FAIL nullable-level late wallet registration: %',v_result;
  END IF;

  SELECT value INTO v_result FROM registration_probe_results
   WHERE name='late_open_replay';
  IF v_result->>'reason' IS DISTINCT FROM 'already_registered' THEN
    RAISE EXCEPTION 'FAIL repeated wallet entry was not refused exactly: %',v_result;
  END IF;

  SELECT value INTO v_result FROM registration_probe_results
   WHERE name='late_closed';
  IF v_result->>'reason' IS DISTINCT FROM 'registration_closed' THEN
    RAISE EXCEPTION 'FAIL closed late-registration window admitted entry: %',v_result;
  END IF;

  SELECT value INTO v_result FROM registration_probe_results
   WHERE name='prestart_human';
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'late_registration')::boolean,false) IS TRUE THEN
    RAISE EXCEPTION 'FAIL pre-start human registration: %',v_result;
  END IF;
  SELECT value INTO v_result FROM registration_probe_results
   WHERE name='prestart_horse';
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL pre-start horse registration: %',v_result;
  END IF;

  IF EXISTS(
    SELECT 1 FROM public.tournaments t
     WHERE t.id IN(
       '30000000-0000-4000-8000-000000000001',
       '30000000-0000-4000-8000-000000000003',
       '30000000-0000-4000-8000-000000000004')
       AND (t.current_players IS DISTINCT FROM 1
         OR t.prize_pool IS DISTINCT FROM 90::numeric
         OR t.bounty_pool IS DISTINCT FROM 0::numeric
         OR t.total_rake IS DISTINCT FROM 10::numeric
         OR t.entry_contract_locked IS DISTINCT FROM true)
  ) THEN
    RAISE EXCEPTION 'FAIL a funded entry did not publish one exact roster count and pool split';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.tournaments t
     WHERE t.id='30000000-0000-4000-8000-000000000002'
       AND (t.current_players IS DISTINCT FROM 0
         OR t.prize_pool IS DISTINCT FROM 0::numeric
         OR t.total_rake IS DISTINCT FROM 0::numeric
         OR t.entry_contract_locked IS DISTINCT FROM false)
  ) THEN
    RAISE EXCEPTION 'FAIL closed entry window changed tournament state';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id IN(
     '30000000-0000-4000-8000-000000000001',
     '30000000-0000-4000-8000-000000000003',
     '30000000-0000-4000-8000-000000000004');
  IF v_count<>3 THEN
    RAISE EXCEPTION 'FAIL funded entries created % roster rows instead of 3',v_count;
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.tournament_players tp
    JOIN public.table_seats s
      ON s.table_id=tp.table_id AND s.seat_number=tp.seat_number
     AND s.user_id=tp.user_id AND s.left_at IS NULL
   WHERE tp.tournament_id='30000000-0000-4000-8000-000000000001'
     AND tp.user_id='10000000-0000-4000-8000-000000000001'
     AND tp.status='playing' AND tp.chips=10000 AND s.stack=10000
     AND s.table_id='40000000-0000-4000-8000-000000000001'
     AND s.seat_number=1
  ) THEN
    RAISE EXCEPTION 'FAIL late entry did not commit one matching live seat and roster row';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN(
     '30000000-0000-4000-8000-000000000003',
     '30000000-0000-4000-8000-000000000004')
     AND (tp.status IS DISTINCT FROM 'registered'
       OR tp.table_id IS NOT NULL OR tp.seat_number IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'FAIL pre-start entries were seated before tournament start';
  END IF;

  IF EXISTS(
    SELECT 1 FROM public.club_members m
   WHERE m.club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
     AND m.user_id IN(
       '10000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000003')
     AND m.chip_balance IS DISTINCT FROM 400::numeric
  ) THEN
    RAISE EXCEPTION 'FAIL an admitted wallet was not debited exactly once';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.wallet_transactions w
   WHERE w.related_entity_id IN(
       '30000000-0000-4000-8000-000000000001',
       '30000000-0000-4000-8000-000000000003',
       '30000000-0000-4000-8000-000000000004')
     AND w.type='debit' AND lower(w.category)='tournament_buyin'
     AND w.amount=100;
  IF v_count<>3 THEN
    RAISE EXCEPTION 'FAIL funded entries wrote % wallet debits instead of 3',v_count;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id IN(
       '30000000-0000-4000-8000-000000000001',
       '30000000-0000-4000-8000-000000000003',
       '30000000-0000-4000-8000-000000000004')
     AND e.entitlement_kind='wallet_charge'
     AND e.charge_category='tournament_buyin'
     AND e.refund_wallet_club_id=
          'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
     AND e.gross=100 AND e.refund_prize=90
     AND e.refund_bounty=0 AND e.refund_fee=10;
  IF v_count<>3 THEN
    RAISE EXCEPTION 'FAIL funded entries wrote % exact refund entitlements instead of 3',v_count;
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.wallet_transactions w
   WHERE w.related_entity_id='30000000-0000-4000-8000-000000000002'
  ) OR EXISTS(
    SELECT 1 FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id='30000000-0000-4000-8000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FAIL closed late-registration window created financial evidence';
  END IF;

  IF has_function_privilege(
       'authenticated','public.fn_register_for_tournament(uuid,boolean)','EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'authenticated','public.fn_register_for_tournament(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'FAIL registration ACL exposes an internal authority or closes the player door';
  END IF;
END;
$registration_contract$;

-- Exercise the deferred exact-evidence constraints before the intentional
-- rollback sentinel below.
SET CONSTRAINTS ALL IMMEDIATE;

DO $pass$
BEGIN
  RAISE EXCEPTION
    'AUDIT_TEST_PASS: wallet registration lifecycle, seat, count and refund evidence are atomic';
END;
$pass$;
