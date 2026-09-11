\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.prime_manager_request(
  p_path text,
  p_tournament_id uuid,
  p_lease_generation uuid,
  p_actor text DEFAULT 'tournament-manager',
  p_protocol text DEFAULT '2'
) RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM set_config(
    'request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true
  );
  PERFORM set_config(
    'request.headers',
    jsonb_build_object(
      'x-smarter-data-actor', p_actor,
      'x-smarter-data-protocol', p_protocol,
      'x-smarter-tournament-id', p_tournament_id,
      'x-smarter-tournament-lease-generation', p_lease_generation
    )::text,
    true
  );
  PERFORM set_config('request.path', '/rest/v1/' || p_path, true);
END;
$function$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_sql text,
  p_marker text
) RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  v_message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF position(p_marker in v_message) = 0 THEN
      RAISE EXCEPTION 'expected error marker %, got %', p_marker, v_message;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected error marker %, but statement succeeded', p_marker;
END;
$function$;

DO $catalog_contract$
DECLARE
  v_hook text;
BEGIN
  SELECT p.prosrc INTO STRICT v_hook
    FROM pg_proc p
   WHERE p.oid =
     'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure;
  IF has_table_privilege(
       'anon', 'public.tournament_chip_supply_events',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     OR has_table_privilege(
       'authenticated', 'public.tournament_chip_supply_events',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     OR has_table_privilege(
       'service_role', 'public.tournament_chip_supply_events',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_trigger g
        WHERE g.tgrelid = 'public.tournament_chip_supply_events'::regclass
          AND g.tgname = 'tournament_chip_supply_event_insert_is_valid'
          AND NOT g.tgisinternal
     )
     OR has_function_privilege(
       'anon',
       'public.trg_validate_tournament_chip_supply_event_insert()',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.trg_validate_tournament_chip_supply_event_insert()',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.trg_validate_tournament_chip_supply_event_insert()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'browser or service roles retained chip-supply table DML or INSERT boundary is unsealed';
  END IF;
  IF position('rpc/fn_issue_tournament_launch_stacks' in v_hook) = 0
     OR position('rpc/fn_materialize_tournament_launch_seats' in v_hook) = 0
     OR position('rpc/fn_project_tournament_launch_seat_stacks' in v_hook) = 0
     OR position('rpc/fn_issue_tournament_launch_stacks' in v_hook) >
          position('v_engine_service_paths' in v_hook)
     OR position('rpc/fn_materialize_tournament_launch_seats' in v_hook) >
          position('v_engine_service_paths' in v_hook)
     OR position('rpc/fn_project_tournament_launch_seat_stacks' in v_hook) >
          position('v_engine_service_paths' in v_hook) THEN
    RAISE EXCEPTION 'supply routes are not manager-exclusive';
  END IF;
  IF to_regprocedure('public.fn_credit_stalled_seat_first_stacks()') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM cron.job
        WHERE jobname = 'credit-stalled-seat-first-stacks'
     ) THEN
    RAISE EXCEPTION 'timer-driven stalled-stack repair survived cutover';
  END IF;
END;
$catalog_contract$;

/* Every new route is rejected before its body unless both authority headers
   are exact and the protocol-2 lease generation is current and fresh. */
SET ROLE service_role;
DO $strict_route_envelope$
DECLARE
  v_path text;
  v_wrong_generation constant uuid :=
    'ffffffff-ffff-4fff-8fff-ffffffffffff';
BEGIN
  FOREACH v_path IN ARRAY ARRAY[
    'rpc/fn_issue_tournament_launch_stacks',
    'rpc/fn_materialize_tournament_launch_seats',
    'rpc/fn_project_tournament_launch_seat_stacks'
  ]::text[] LOOP
    PERFORM pg_temp.prime_manager_request(
      v_path,
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      '', '2'
    );
    PERFORM pg_temp.assert_raises(
      'SELECT smarter_private.fn_smarter_data_api_pre_request()',
      'TOURNAMENT_MANAGER_AUTHORITY_REQUIRED'
    );

    PERFORM pg_temp.prime_manager_request(
      v_path,
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      'tournament-manager', '1'
    );
    PERFORM pg_temp.assert_raises(
      'SELECT smarter_private.fn_smarter_data_api_pre_request()',
      'DATA_ACTOR_INVALID'
    );

    PERFORM pg_temp.prime_manager_request(
      v_path,
      '10000000-0000-4000-8000-000000000001',
      v_wrong_generation,
      'tournament-manager', '2'
    );
    PERFORM pg_temp.assert_raises(
      'SELECT smarter_private.fn_smarter_data_api_pre_request()',
      'TOURNAMENT_MANAGER_FENCED'
    );
  END LOOP;
END;
$strict_route_envelope$;
RESET ROLE;

/* A predecessor roster row has no immutable opening event. Its launch is
   permanently version 0 and completion reports explicit unknown totals. */
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_begin_tournament_launch_atomic',
  '10000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $legacy_begin$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.fn_begin_tournament_launch_atomic(
    '10000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000001',
    clock_timestamp(),
    '40000000-0000-4000-8000-000000000001'
  );
  IF (v_result ->> 'supply_version')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'legacy launch was not explicitly supply version 0: %', v_result;
  END IF;
END;
$legacy_begin$;
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_complete_tournament_launch_atomic',
  '10000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $legacy_complete$
DECLARE
  v_result jsonb;
  v_supply jsonb;
BEGIN
  v_result := public.fn_complete_tournament_launch_atomic(
    '10000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001'
  );
  v_supply := v_result -> 'chip_supply';
  IF COALESCE((v_result ->> 'ok')::boolean, false) IS NOT TRUE
     OR (v_result ->> 'supply_version')::integer IS DISTINCT FROM 0
     OR COALESCE((v_supply ->> 'ok')::boolean, false) IS NOT TRUE
     OR COALESCE((v_supply ->> 'ledgered')::boolean, true) IS NOT FALSE
     OR v_supply ->> 'reason' IS DISTINCT FROM 'legacy_supply_unversioned'
     OR COALESCE((v_supply ->> 'stacks_deferred')::boolean, true) IS NOT FALSE
     OR jsonb_typeof(v_result -> 'issued_chips') IS DISTINCT FROM 'null'
     OR jsonb_typeof(v_result -> 'roster_chips') IS DISTINCT FROM 'null'
     OR jsonb_typeof(v_result -> 'felt_chips') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION 'legacy completion shape drifted: %', v_result;
  END IF;
END;
$legacy_complete$;
COMMIT;

/* Fully ledgered non-Spin launch with two registration bonuses. */
INSERT INTO public.tournaments(
  id,name,status,starting_chips,early_bird_chips,variant,tournament_type,
  max_players
) VALUES (
  '50000000-0000-4000-8000-000000000001',
  'Ledgered MTT','REGISTERING',1000,25,'mtt','MTT',9
);
INSERT INTO public.tables(id,tournament_id,status,max_players)
VALUES (
  '51000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001','waiting',9
);
INSERT INTO public.tournament_players(tournament_id,user_id,chips,status)
VALUES
  ('50000000-0000-4000-8000-000000000001',
   '52000000-0000-4000-8000-000000000001',25,'registered'),
  ('50000000-0000-4000-8000-000000000001',
   '52000000-0000-4000-8000-000000000002',25,'registered');
INSERT INTO public.engine_tournament_leases(
  tournament_id,instance_id,lease_generation,protocol_version
) VALUES (
  '50000000-0000-4000-8000-000000000001','fixture',
  '54000000-0000-4000-8000-000000000001',2
);

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_begin_tournament_launch_atomic',
  '50000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $ledgered_begin$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.fn_begin_tournament_launch_atomic(
    '50000000-0000-4000-8000-000000000001',
    '53000000-0000-4000-8000-000000000001',
    clock_timestamp(),
    '54000000-0000-4000-8000-000000000001'
  );
  IF (v_result ->> 'supply_version')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'ledgered launch snapshot drifted: %', v_result;
  END IF;
END;
$ledgered_begin$;
COMMIT;
DO $ledgered_snapshot$
BEGIN
  IF (SELECT supply_expected_issued_chips
        FROM public.tournament_launch_receipts
       WHERE tournament_id='50000000-0000-4000-8000-000000000001')
       IS DISTINCT FROM 2050 THEN
    RAISE EXCEPTION 'ledgered launch expected-supply snapshot drifted';
  END IF;
END;
$ledgered_snapshot$;

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_issue_tournament_launch_stacks',
  '50000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT pg_temp.assert_raises(
  $$SELECT public.fn_issue_tournament_launch_stacks(
    '50000000-0000-4000-8000-000000000001',
    '53000000-0000-4000-8000-000000000001',
    '54000000-0000-4000-8000-000000000001',
    ARRAY[
      '52000000-0000-4000-8000-000000000001'::uuid,
      '52000000-0000-4000-8000-000000000001'::uuid
    ]
  )$$,
  'TOURNAMENT_LAUNCH_SUPPLY_EXPECTED_USERS_DUPLICATE'
);
DO $issue_non_spin$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.fn_issue_tournament_launch_stacks(
    '50000000-0000-4000-8000-000000000001',
    '53000000-0000-4000-8000-000000000001',
    '54000000-0000-4000-8000-000000000001',
    ARRAY[
      '52000000-0000-4000-8000-000000000002'::uuid,
      '52000000-0000-4000-8000-000000000001'::uuid
    ]
  );
  IF (v_result ->> 'supply_version')::integer IS DISTINCT FROM 1
     OR (v_result ->> 'created_event_count')::integer IS DISTINCT FROM 2
     OR (v_result ->> 'credited_player_count')::integer IS DISTINCT FROM 2
     OR (v_result ->> 'issued_chips')::bigint IS DISTINCT FROM 2050
     OR (v_result ->> 'roster_chips')::bigint IS DISTINCT FROM 2050
     OR v_result #>> '{players,0,user_id}' IS DISTINCT FROM
          '52000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'non-Spin issuance receipt drifted: %', v_result;
  END IF;
END;
$issue_non_spin$;
COMMIT;

/* Issuance is receipt-idempotent. */
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_issue_tournament_launch_stacks',
  '50000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $issue_replay$
DECLARE v_result jsonb;
BEGIN
  v_result := public.fn_issue_tournament_launch_stacks(
    '50000000-0000-4000-8000-000000000001',
    '53000000-0000-4000-8000-000000000001',
    '54000000-0000-4000-8000-000000000001',
    ARRAY[
      '52000000-0000-4000-8000-000000000001'::uuid,
      '52000000-0000-4000-8000-000000000002'::uuid
    ]
  );
  IF (v_result ->> 'created_event_count')::integer IS DISTINCT FROM 0
     OR (v_result ->> 'issued_chips')::bigint IS DISTINCT FROM 2050 THEN
    RAISE EXCEPTION 'issuance replay was not idempotent: %', v_result;
  END IF;
END;
$issue_replay$;
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_materialize_tournament_launch_seats',
  '50000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT pg_temp.assert_raises(
  $$SELECT public.fn_materialize_tournament_launch_seats(
    '50000000-0000-4000-8000-000000000001',
    '53000000-0000-4000-8000-000000000001',
    '54000000-0000-4000-8000-000000000001',
    ARRAY[
      '52000000-0000-4000-8000-000000000001'::uuid,
      '52000000-0000-4000-8000-000000000002'::uuid
    ],
    '[{"user_id":"52000000-0000-4000-8000-000000000001","table_id":"51000000-0000-4000-8000-000000000001","seat_number":1},{"user_id":"52000000-0000-4000-8000-000000000002","table_id":"51000000-0000-4000-8000-000000000001","seat_number":1}]'::jsonb
  )$$,
  'TOURNAMENT_LAUNCH_SEAT_ASSIGNMENT_SET_MISMATCH'
);
DO $materialize_non_spin$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.fn_materialize_tournament_launch_seats(
    '50000000-0000-4000-8000-000000000001',
    '53000000-0000-4000-8000-000000000001',
    '54000000-0000-4000-8000-000000000001',
    ARRAY[
      '52000000-0000-4000-8000-000000000002'::uuid,
      '52000000-0000-4000-8000-000000000001'::uuid
    ],
    '[{"user_id":"52000000-0000-4000-8000-000000000002","table_id":"51000000-0000-4000-8000-000000000001","seat_number":2},{"user_id":"52000000-0000-4000-8000-000000000001","table_id":"51000000-0000-4000-8000-000000000001","seat_number":1}]'::jsonb
  );
  IF COALESCE((v_result ->> 'stacks_deferred')::boolean, true)
     OR (v_result ->> 'materialized_player_count')::integer IS DISTINCT FROM 2
     OR (v_result ->> 'felt_chips')::bigint IS DISTINCT FROM 2050
     OR v_result #>> '{players,0,user_id}' IS DISTINCT FROM
          '52000000-0000-4000-8000-000000000001'
     OR v_result #>> '{tables,0,current_players}' IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'non-Spin materialization receipt drifted: %', v_result;
  END IF;
END;
$materialize_non_spin$;
COMMIT;

/* The table inventory is fenced once the RPC transaction ends. */
SELECT pg_temp.assert_raises(
  $$UPDATE public.table_seats
       SET stack=stack+1
     WHERE table_id='51000000-0000-4000-8000-000000000001'
       AND seat_number=1$$,
  'TOURNAMENT_LAUNCH_SUPPLY_FROZEN'
);

/* Exact same-coordinate replay is safe and leaves headcounts derived. */
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_materialize_tournament_launch_seats',
  '50000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $materialize_replay$
DECLARE v_result jsonb;
BEGIN
  v_result := public.fn_materialize_tournament_launch_seats(
    '50000000-0000-4000-8000-000000000001',
    '53000000-0000-4000-8000-000000000001',
    '54000000-0000-4000-8000-000000000001',
    ARRAY[
      '52000000-0000-4000-8000-000000000001'::uuid,
      '52000000-0000-4000-8000-000000000002'::uuid
    ],
    '[{"user_id":"52000000-0000-4000-8000-000000000001","table_id":"51000000-0000-4000-8000-000000000001","seat_number":1},{"user_id":"52000000-0000-4000-8000-000000000002","table_id":"51000000-0000-4000-8000-000000000001","seat_number":2}]'::jsonb
  );
  IF (v_result ->> 'felt_chips')::bigint IS DISTINCT FROM 2050
     OR v_result #>> '{tables,0,current_players}' IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'materialization replay drifted: %', v_result;
  END IF;
END;
$materialize_replay$;
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_complete_tournament_launch_atomic',
  '50000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $complete_non_spin$
DECLARE v_result jsonb;
BEGIN
  v_result := public.fn_complete_tournament_launch_atomic(
    '50000000-0000-4000-8000-000000000001',
    '53000000-0000-4000-8000-000000000001',
    '54000000-0000-4000-8000-000000000001'
  );
  IF COALESCE((v_result ->> 'ok')::boolean, false) IS NOT TRUE
     OR (v_result ->> 'supply_version')::integer IS DISTINCT FROM 1
     OR (v_result ->> 'issued_chips')::bigint IS DISTINCT FROM 2050
     OR (v_result ->> 'roster_chips')::bigint IS DISTINCT FROM 2050
     OR (v_result ->> 'felt_chips')::bigint IS DISTINCT FROM 2050 THEN
    RAISE EXCEPTION 'non-Spin exact completion drifted: %', v_result;
  END IF;
END;
$complete_non_spin$;
COMMIT;

/* Canonical post-launch purchases append supply in the purchase transaction.
   A reentry from exact zero additionally needs one accepted hand generation. */
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/process_tournament_rebuy',
  '50000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT public.process_tournament_rebuy(
  '50000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000001',
  'rebuy',0,100,1,'rebuy-1'
);
COMMIT;
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/process_tournament_rebuy',
  '50000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT public.process_tournament_rebuy(
  '50000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000001',
  'addon',0,50,1,'addon-1'
);
COMMIT;

DO $redistribute_and_accept_zero$
DECLARE
  v_seat_id uuid;
  v_joined_at timestamptz;
BEGIN
  UPDATE public.tournament_players
     SET chips = CASE user_id
       WHEN '52000000-0000-4000-8000-000000000001'::uuid THEN 0
       ELSE chips + 1175 END
   WHERE tournament_id='50000000-0000-4000-8000-000000000001';
  UPDATE public.table_seats
     SET stack = CASE user_id
       WHEN '52000000-0000-4000-8000-000000000001'::uuid THEN 0
       ELSE stack + 1175 END
   WHERE table_id='51000000-0000-4000-8000-000000000001'
     AND left_at IS NULL;
  SELECT id, joined_at INTO STRICT v_seat_id, v_joined_at
    FROM public.table_seats
   WHERE table_id='51000000-0000-4000-8000-000000000001'
     AND user_id='52000000-0000-4000-8000-000000000001'
     AND left_at IS NULL;
  INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id)
  VALUES (
    '51000000-0000-4000-8000-000000000001',1000000,
    '55000000-0000-4000-8000-000000000001'
  );
  INSERT INTO public.tournament_knockout_candidates(
    tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,
    hand_id,hand_number,stack_before,stack_after,state
  ) VALUES (
    '50000000-0000-4000-8000-000000000001',
    '52000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000001',v_seat_id,v_joined_at,
    '55000000-0000-4000-8000-000000000001',1000000,1175,0,'eliminated'
  );
END;
$redistribute_and_accept_zero$;

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/process_tournament_rebuy',
  '50000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT public.process_tournament_rebuy(
  '50000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000001',
  'reentry',0,200,1,'reentry-2'
);
COMMIT;

DO $purchase_events$
DECLARE
  v_kinds text;
  v_issued bigint;
  v_roster bigint;
  v_felt bigint;
BEGIN
  SELECT string_agg(event_kind, ',' ORDER BY recorded_at, event_id),
         sum(amount_delta)::bigint
    INTO v_kinds, v_issued
    FROM public.tournament_chip_supply_events
   WHERE tournament_id='50000000-0000-4000-8000-000000000001';
  SELECT sum(chips)::bigint INTO v_roster
    FROM public.tournament_players
   WHERE tournament_id='50000000-0000-4000-8000-000000000001';
  SELECT sum(s.stack)::bigint INTO v_felt
    FROM public.table_seats s
    JOIN public.tables t ON t.id=s.table_id
   WHERE t.tournament_id='50000000-0000-4000-8000-000000000001'
     AND s.left_at IS NULL;
  IF position('rebuy' in v_kinds) = 0
     OR position('addon' in v_kinds) = 0
     OR position('reentry' in v_kinds) = 0
     OR v_issued IS DISTINCT FROM 2400
     OR v_roster IS DISTINCT FROM 2400
     OR v_felt IS DISTINCT FROM 2400 THEN
    RAISE EXCEPTION
      'canonical purchase supply drifted: kinds %, totals %/%/%',
      v_kinds,v_issued,v_roster,v_felt;
  END IF;
END;
$purchase_events$;

/* Spin supply is issued to the roster at launch but the felt remains zero
   until the database-derived reveal beat. */
INSERT INTO public.tournaments(
  id,name,status,starting_chips,early_bird_chips,variant,tournament_type,
  max_players,spin_multiplier,spin_reveal_at
) VALUES (
  '60000000-0000-4000-8000-000000000001',
  'Ledgered Spin','REGISTERING',500,10,'spin','SPIN',3,2,clock_timestamp()
);
INSERT INTO public.tables(id,tournament_id,status,max_players)
VALUES (
  '61000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000001','waiting',3
);
INSERT INTO public.tournament_players(tournament_id,user_id,chips,status)
VALUES
  ('60000000-0000-4000-8000-000000000001',
   '62000000-0000-4000-8000-000000000001',10,'registered'),
  ('60000000-0000-4000-8000-000000000001',
   '62000000-0000-4000-8000-000000000002',10,'registered');
INSERT INTO public.engine_tournament_leases(
  tournament_id,instance_id,lease_generation,protocol_version
) VALUES (
  '60000000-0000-4000-8000-000000000001','fixture',
  '64000000-0000-4000-8000-000000000001',2
);

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_begin_tournament_launch_atomic',
  '60000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $spin_begin$
DECLARE v_result jsonb;
BEGIN
  v_result := public.fn_begin_tournament_launch_atomic(
    '60000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    clock_timestamp(),
    '64000000-0000-4000-8000-000000000001'
  );
  IF (v_result ->> 'supply_version')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Spin launch did not select deferred v1 supply: %', v_result;
  END IF;
END;
$spin_begin$;
COMMIT;
DO $spin_snapshot$
BEGIN
  IF NOT (SELECT supply_projection_deferred
            FROM public.tournament_launch_receipts
           WHERE tournament_id='60000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'Spin launch snapshot is not deferred';
  END IF;
END;
$spin_snapshot$;

/* A valid request for tournament A cannot mutate tournament B through any of
   the three RPC bodies. */
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_issue_tournament_launch_stacks',
  '50000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT pg_temp.assert_raises(
  $$SELECT public.fn_issue_tournament_launch_stacks(
    '60000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000001',
    ARRAY['62000000-0000-4000-8000-000000000001'::uuid,'62000000-0000-4000-8000-000000000002'::uuid]
  )$$,
  'TOURNAMENT_MANAGER_SCOPE_VIOLATION'
);
COMMIT;
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_materialize_tournament_launch_seats',
  '50000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT pg_temp.assert_raises(
  $$SELECT public.fn_materialize_tournament_launch_seats(
    '60000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000001',
    ARRAY['62000000-0000-4000-8000-000000000001'::uuid,'62000000-0000-4000-8000-000000000002'::uuid],
    '[]'::jsonb
  )$$,
  'TOURNAMENT_MANAGER_SCOPE_VIOLATION'
);
COMMIT;
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_project_tournament_launch_seat_stacks',
  '50000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT pg_temp.assert_raises(
  $$SELECT public.fn_project_tournament_launch_seat_stacks(
    '60000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000001',
    ARRAY['62000000-0000-4000-8000-000000000001'::uuid,'62000000-0000-4000-8000-000000000002'::uuid]
  )$$,
  'TOURNAMENT_MANAGER_SCOPE_VIOLATION'
);
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_issue_tournament_launch_stacks',
  '60000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $issue_spin$
DECLARE v_result jsonb;
BEGIN
  v_result := public.fn_issue_tournament_launch_stacks(
    '60000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000001',
    ARRAY['62000000-0000-4000-8000-000000000001'::uuid,'62000000-0000-4000-8000-000000000002'::uuid]
  );
  IF (v_result ->> 'issued_chips')::bigint IS DISTINCT FROM 1020 THEN
    RAISE EXCEPTION 'Spin issuance total drifted: %', v_result;
  END IF;
END;
$issue_spin$;
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_materialize_tournament_launch_seats',
  '60000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $materialize_spin$
DECLARE v_result jsonb;
BEGIN
  v_result := public.fn_materialize_tournament_launch_seats(
    '60000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000001',
    ARRAY['62000000-0000-4000-8000-000000000001'::uuid,'62000000-0000-4000-8000-000000000002'::uuid],
    '[{"user_id":"62000000-0000-4000-8000-000000000001","table_id":"61000000-0000-4000-8000-000000000001","seat_number":1},{"user_id":"62000000-0000-4000-8000-000000000002","table_id":"61000000-0000-4000-8000-000000000001","seat_number":2}]'::jsonb
  );
  IF COALESCE((v_result ->> 'stacks_deferred')::boolean, false) IS NOT TRUE
     OR (v_result ->> 'issued_chips')::bigint IS DISTINCT FROM 1020
     OR (v_result ->> 'roster_chips')::bigint IS DISTINCT FROM 1020
     OR (v_result ->> 'felt_chips')::bigint IS DISTINCT FROM 0
     OR v_result #>> '{tables,0,current_players}' IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'Spin materialization leaked supply early: %', v_result;
  END IF;
END;
$materialize_spin$;
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_complete_tournament_launch_atomic',
  '60000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $spin_completion_blocked$
DECLARE v_result jsonb;
BEGIN
  v_result := public.fn_complete_tournament_launch_atomic(
    '60000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000001'
  );
  IF COALESCE((v_result ->> 'ok')::boolean, true)
     OR v_result ->> 'reason' IS DISTINCT FROM 'launch_chip_projection_pending' THEN
    RAISE EXCEPTION 'Spin completion did not wait for projection: %', v_result;
  END IF;
END;
$spin_completion_blocked$;
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_project_tournament_launch_seat_stacks',
  '60000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT pg_temp.assert_raises(
  $$SELECT public.fn_project_tournament_launch_seat_stacks(
    '60000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000001',
    ARRAY['62000000-0000-4000-8000-000000000001'::uuid,'62000000-0000-4000-8000-000000000002'::uuid]
  )$$,
  'TOURNAMENT_LAUNCH_SPIN_PROJECTION_TOO_EARLY'
);
COMMIT;

UPDATE public.tournaments
   SET spin_reveal_at=clock_timestamp()-interval '20 seconds'
 WHERE id='60000000-0000-4000-8000-000000000001';

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_project_tournament_launch_seat_stacks',
  '60000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $project_spin$
DECLARE v_result jsonb;
BEGIN
  v_result := public.fn_project_tournament_launch_seat_stacks(
    '60000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000001',
    ARRAY['62000000-0000-4000-8000-000000000001'::uuid,'62000000-0000-4000-8000-000000000002'::uuid]
  );
  IF COALESCE((v_result ->> 'stacks_deferred')::boolean, true)
     OR (v_result ->> 'created_projection_count')::integer IS DISTINCT FROM 1
     OR (v_result ->> 'projected_player_count')::integer IS DISTINCT FROM 2
     OR (v_result ->> 'issued_chips')::bigint IS DISTINCT FROM 1020
     OR (v_result ->> 'roster_chips')::bigint IS DISTINCT FROM 1020
     OR (v_result ->> 'felt_chips')::bigint IS DISTINCT FROM 1020
     OR v_result #>> '{players,0,user_id}' IS DISTINCT FROM
          '62000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'Spin projection receipt drifted: %', v_result;
  END IF;
END;
$project_spin$;
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_project_tournament_launch_seat_stacks',
  '60000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $project_spin_replay$
DECLARE v_result jsonb;
BEGIN
  v_result := public.fn_project_tournament_launch_seat_stacks(
    '60000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000001',
    ARRAY['62000000-0000-4000-8000-000000000001'::uuid,'62000000-0000-4000-8000-000000000002'::uuid]
  );
  IF (v_result ->> 'created_projection_count')::integer IS DISTINCT FROM 0
     OR (v_result ->> 'felt_chips')::bigint IS DISTINCT FROM 1020 THEN
    RAISE EXCEPTION 'Spin projection replay was not idempotent: %', v_result;
  END IF;
END;
$project_spin_replay$;
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_complete_tournament_launch_atomic',
  '60000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $complete_spin$
DECLARE v_result jsonb;
BEGIN
  v_result := public.fn_complete_tournament_launch_atomic(
    '60000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000001'
  );
  IF COALESCE((v_result ->> 'ok')::boolean, false) IS NOT TRUE
     OR (v_result ->> 'supply_version')::integer IS DISTINCT FROM 1
     OR (v_result ->> 'issued_chips')::bigint IS DISTINCT FROM 1020
     OR (v_result ->> 'roster_chips')::bigint IS DISTINCT FROM 1020
     OR (v_result ->> 'felt_chips')::bigint IS DISTINCT FROM 1020 THEN
    RAISE EXCEPTION 'Spin exact completion drifted: %', v_result;
  END IF;
END;
$complete_spin$;
COMMIT;

/* A ghost live seat causes an atomic refusal; no partial roster coordinates or
   target seats are materialized. */
INSERT INTO public.tournaments(
  id,name,status,starting_chips,variant,tournament_type,max_players
) VALUES (
  '70000000-0000-4000-8000-000000000001',
  'Collision MTT','REGISTERING',1000,'mtt','MTT',9
);
INSERT INTO public.tables(id,tournament_id,status,max_players)
VALUES (
  '71000000-0000-4000-8000-000000000001',
  '70000000-0000-4000-8000-000000000001','waiting',9
);
INSERT INTO public.tournament_players(tournament_id,user_id,chips,status)
VALUES (
  '70000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000001',0,'registered'
);
INSERT INTO public.table_seats(table_id,user_id,seat_number,stack)
VALUES (
  '71000000-0000-4000-8000-000000000001',
  '72ffffff-ffff-4fff-8fff-ffffffffffff',9,1
);
INSERT INTO public.engine_tournament_leases(
  tournament_id,instance_id,lease_generation,protocol_version
) VALUES (
  '70000000-0000-4000-8000-000000000001','fixture',
  '74000000-0000-4000-8000-000000000001',2
);
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_begin_tournament_launch_atomic',
  '70000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT public.fn_begin_tournament_launch_atomic(
  '70000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000001',clock_timestamp(),
  '74000000-0000-4000-8000-000000000001'
);
COMMIT;
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_issue_tournament_launch_stacks',
  '70000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT public.fn_issue_tournament_launch_stacks(
  '70000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001',
  ARRAY['72000000-0000-4000-8000-000000000001'::uuid]
);
COMMIT;
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.prime_manager_request(
  'rpc/fn_materialize_tournament_launch_seats',
  '70000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001'
);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT pg_temp.assert_raises(
  $$SELECT public.fn_materialize_tournament_launch_seats(
    '70000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000001',
    ARRAY['72000000-0000-4000-8000-000000000001'::uuid],
    '[{"user_id":"72000000-0000-4000-8000-000000000001","table_id":"71000000-0000-4000-8000-000000000001","seat_number":1}]'::jsonb
  )$$,
  'TOURNAMENT_LAUNCH_SEAT_EXISTING_OWNERSHIP_MISMATCH'
);
COMMIT;
DO $collision_rollback$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.tournament_players
        WHERE tournament_id='70000000-0000-4000-8000-000000000001'
          AND (table_id IS NOT NULL OR seat_number IS NOT NULL)
     ) OR EXISTS (
       SELECT 1 FROM public.table_seats
        WHERE table_id='71000000-0000-4000-8000-000000000001'
          AND user_id='72000000-0000-4000-8000-000000000001'
          AND left_at IS NULL
     ) THEN
    RAISE EXCEPTION 'collision refusal left a partial materialization';
  END IF;
END;
$collision_rollback$;

/* Prestart deletion writes an exact reversal and a later re-registration uses
   a fresh generation; no mutable legacy row is ever backfilled. */
INSERT INTO public.tournaments(
  id,name,status,starting_chips,variant,tournament_type,max_players
) VALUES (
  '80000000-0000-4000-8000-000000000001',
  'Unregister MTT','REGISTERING',1000,'mtt','MTT',9
);
INSERT INTO public.tournament_players(tournament_id,user_id,chips,status)
VALUES (
  '80000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',25,'registered'
);
DELETE FROM public.tournament_players
 WHERE tournament_id='80000000-0000-4000-8000-000000000001'
   AND user_id='82000000-0000-4000-8000-000000000001';
DO $unregister_reversal$
BEGIN
  IF (SELECT sum(amount_delta)::bigint
        FROM public.tournament_chip_supply_events
       WHERE tournament_id='80000000-0000-4000-8000-000000000001')
       IS DISTINCT FROM 0
     OR (SELECT count(*)
           FROM public.tournament_chip_supply_events
          WHERE tournament_id='80000000-0000-4000-8000-000000000001'
            AND event_kind='entry_closed') IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'prestart unregister did not reverse exact issued supply';
  END IF;
END;
$unregister_reversal$;
INSERT INTO public.tournament_players(tournament_id,user_id,chips,status)
VALUES (
  '80000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',25,'registered'
);
DO $fresh_generation$
BEGIN
  IF (SELECT count(DISTINCT entry_generation)
        FROM public.tournament_chip_supply_events
       WHERE tournament_id='80000000-0000-4000-8000-000000000001'
         AND event_kind='entry_opened') IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 're-registration reused a closed supply generation';
  END IF;
END;
$fresh_generation$;

/* Seat-first leave closes the full bonus-plus-initial generation after the
   seat is vacated; tournament cancellation does the same on its status path. */
INSERT INTO public.tournaments(
  id,name,status,starting_chips,variant,tournament_type,max_players
) VALUES
  ('85000000-0000-4000-8000-000000000001','Seat Leave','REGISTERING',1000,'mtt','MTT',2),
  ('86000000-0000-4000-8000-000000000001','Cancel Supply','REGISTERING',1000,'mtt','MTT',9);
INSERT INTO public.tables(id,tournament_id,status,max_players)
VALUES (
  '85100000-0000-4000-8000-000000000001',
  '85000000-0000-4000-8000-000000000001','waiting',2
);
INSERT INTO public.tournament_players(
  tournament_id,user_id,chips,status,table_id,seat_number
) VALUES (
  '85000000-0000-4000-8000-000000000001',
  '85200000-0000-4000-8000-000000000001',1025,'playing',
  '85100000-0000-4000-8000-000000000001',1
);
INSERT INTO public.table_seats(table_id,user_id,seat_number,stack)
VALUES (
  '85100000-0000-4000-8000-000000000001',
  '85200000-0000-4000-8000-000000000001',1,1025
);
UPDATE public.table_seats
   SET left_at=clock_timestamp()
 WHERE table_id='85100000-0000-4000-8000-000000000001'
   AND user_id='85200000-0000-4000-8000-000000000001';
DELETE FROM public.tournament_players
 WHERE tournament_id='85000000-0000-4000-8000-000000000001'
   AND user_id='85200000-0000-4000-8000-000000000001';
INSERT INTO public.tournament_players(tournament_id,user_id,chips,status)
VALUES (
  '86000000-0000-4000-8000-000000000001',
  '86200000-0000-4000-8000-000000000001',25,'registered'
);
UPDATE public.tournaments SET status='CANCELLED'
 WHERE id='86000000-0000-4000-8000-000000000001';
UPDATE public.tournament_players SET status='eliminated'
 WHERE tournament_id='86000000-0000-4000-8000-000000000001'
   AND user_id='86200000-0000-4000-8000-000000000001';
DO $close_path_reversals$
BEGIN
  IF (SELECT sum(amount_delta)::bigint
        FROM public.tournament_chip_supply_events
       WHERE tournament_id='85000000-0000-4000-8000-000000000001')
       IS DISTINCT FROM 0
     OR (SELECT sum(amount_delta)::bigint
           FROM public.tournament_chip_supply_events
          WHERE tournament_id='86000000-0000-4000-8000-000000000001')
       IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'seat-leave or cancellation did not reverse its exact supply generation';
  END IF;
END;
$close_path_reversals$;

/* A running cancellation retires every generation, not only the entrants
   still marked playing. The nested exception is a forced refund failure after
   a wallet write: PostgreSQL must roll back the wallet, active-player close,
   tournament status and both supply reversals as one unit. */
CREATE TEMP TABLE cancel_refund_wallet (
  user_id uuid PRIMARY KEY,
  balance bigint NOT NULL DEFAULT 0
) ON COMMIT PRESERVE ROWS;
INSERT INTO cancel_refund_wallet(user_id)
VALUES ('87200000-0000-4000-8000-000000000002');
INSERT INTO public.tournaments(
  id,name,status,starting_chips,variant,tournament_type,max_players
) VALUES (
  '87000000-0000-4000-8000-000000000001',
  'Midgame Cancel Supply','REGISTERING',1000,'mtt','MTT',9
);
INSERT INTO public.tournament_players(tournament_id,user_id,chips,status)
VALUES
  ('87000000-0000-4000-8000-000000000001',
   '87200000-0000-4000-8000-000000000001',1000,'playing'),
  ('87000000-0000-4000-8000-000000000001',
   '87200000-0000-4000-8000-000000000002',1000,'playing');
UPDATE public.tournaments SET status='RUNNING'
 WHERE id='87000000-0000-4000-8000-000000000001';
UPDATE public.tournament_players SET status='eliminated'
 WHERE tournament_id='87000000-0000-4000-8000-000000000001'
   AND user_id='87200000-0000-4000-8000-000000000001';

DO $cancel_refund_failure_rolls_back_supply$
BEGIN
  BEGIN
    UPDATE public.tournaments SET status='CANCELLED'
     WHERE id='87000000-0000-4000-8000-000000000001';
    UPDATE cancel_refund_wallet SET balance=balance+100
     WHERE user_id='87200000-0000-4000-8000-000000000002';
    UPDATE public.tournament_players SET status='eliminated'
     WHERE tournament_id='87000000-0000-4000-8000-000000000001'
       AND status IN ('registered','playing');
    RAISE EXCEPTION 'FORCED_CANCEL_REFUND_FAILURE';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM IS DISTINCT FROM 'FORCED_CANCEL_REFUND_FAILURE' THEN
      RAISE;
    END IF;
  END;

  IF (SELECT status FROM public.tournaments
       WHERE id='87000000-0000-4000-8000-000000000001')
       IS DISTINCT FROM 'RUNNING'
     OR (SELECT status FROM public.tournament_players
          WHERE tournament_id='87000000-0000-4000-8000-000000000001'
            AND user_id='87200000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 'eliminated'
     OR (SELECT status FROM public.tournament_players
          WHERE tournament_id='87000000-0000-4000-8000-000000000001'
            AND user_id='87200000-0000-4000-8000-000000000002')
          IS DISTINCT FROM 'playing'
     OR (SELECT balance FROM cancel_refund_wallet
          WHERE user_id='87200000-0000-4000-8000-000000000002')
          IS DISTINCT FROM 0::bigint
     OR EXISTS (
          SELECT 1 FROM public.tournament_chip_supply_events
           WHERE tournament_id='87000000-0000-4000-8000-000000000001'
             AND event_kind='entry_closed'
        )
     OR (SELECT sum(amount_delta)::bigint
           FROM public.tournament_chip_supply_events
          WHERE tournament_id='87000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 2000::bigint THEN
    RAISE EXCEPTION
      'forced refund failure did not roll back wallet, player, cancellation and supply closes';
  END IF;
END;
$cancel_refund_failure_rolls_back_supply$;

UPDATE public.tournaments SET status='CANCELLED'
 WHERE id='87000000-0000-4000-8000-000000000001';
UPDATE cancel_refund_wallet SET balance=balance+100
 WHERE user_id='87200000-0000-4000-8000-000000000002';
UPDATE public.tournament_players SET status='eliminated'
 WHERE tournament_id='87000000-0000-4000-8000-000000000001'
   AND status IN ('registered','playing');
DO $midgame_cancel_closes_every_generation$
BEGIN
  IF (SELECT status FROM public.tournaments
       WHERE id='87000000-0000-4000-8000-000000000001')
       IS DISTINCT FROM 'CANCELLED'
     OR (SELECT balance FROM cancel_refund_wallet
          WHERE user_id='87200000-0000-4000-8000-000000000002')
          IS DISTINCT FROM 100::bigint
     OR (SELECT count(*) FROM public.tournament_chip_supply_events
          WHERE tournament_id='87000000-0000-4000-8000-000000000001'
            AND event_kind='entry_closed') IS DISTINCT FROM 2::bigint
     OR (SELECT sum(amount_delta)::bigint
           FROM public.tournament_chip_supply_events
          WHERE tournament_id='87000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION
      'midgame cancellation did not close every still-open supply generation';
  END IF;
END;
$midgame_cancel_closes_every_generation$;

/* Both seat-first entry doors retain an already-issued registration bonus. */
INSERT INTO public.tournaments(
  id,name,status,starting_chips,early_bird_chips,variant,tournament_type,max_players
) VALUES
  ('90000000-0000-4000-8000-000000000001','Human Seat First','REGISTERING',1000,25,'mtt','MTT',9),
  ('90000000-0000-4000-8000-000000000002','Horse Seat First','REGISTERING',1000,25,'mtt','MTT',9);
INSERT INTO public.tables(id,tournament_id,status,max_players)
VALUES (
  '91000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000001','waiting',9
);
INSERT INTO public.tournament_players(tournament_id,user_id,chips,status)
VALUES
  ('90000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',25,'registered'),
  ('90000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000002',25,'registered');
SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"92000000-0000-4000-8000-000000000001"}',
  false
);
SELECT public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(
  '91000000-0000-4000-8000-000000000001',1
);
SELECT public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(
  '90000000-0000-4000-8000-000000000002',
  '92000000-0000-4000-8000-000000000002'
);
DO $seat_first_bonus$
BEGIN
  IF (SELECT chips FROM public.tournament_players
       WHERE tournament_id='90000000-0000-4000-8000-000000000001')
       IS DISTINCT FROM 1025
     OR (SELECT chips FROM public.tournament_players
       WHERE tournament_id='90000000-0000-4000-8000-000000000002')
       IS DISTINCT FROM 1025 THEN
    RAISE EXCEPTION 'seat-first path erased a registration bonus';
  END IF;
END;
$seat_first_bonus$;

/* Even the owner cannot rewrite an immutable fact after it commits. */
SELECT pg_temp.assert_raises(
  $$UPDATE public.tournament_chip_supply_events
       SET amount_delta=amount_delta+1
     WHERE tournament_id='50000000-0000-4000-8000-000000000001'$$,
  'append-only'
);
SELECT pg_temp.assert_raises(
  $$DELETE FROM public.tournament_chip_supply_events
     WHERE tournament_id='50000000-0000-4000-8000-000000000001'$$,
  'append-only'
);

/* The immutable INSERT boundary, not just its canonical wrapper, proves an
   exact close. The open tournaments are retained for the shell harness's
   opposite-order two-session cancellation/issuance and seat-first races. */
INSERT INTO public.tournaments(
  id,name,status,starting_chips,variant,tournament_type,max_players
) VALUES
  ('a1000000-0000-4000-8000-000000000001',
   'Positive First Supply Race','REGISTERING',1000,'mtt','MTT',9),
  ('b1000000-0000-4000-8000-000000000001',
   'Cancel First Supply Race','REGISTERING',1000,'mtt','MTT',9),
  ('c1000000-0000-4000-8000-000000000001',
   'Exact Close Supply Guard','REGISTERING',1000,'mtt','MTT',9),
  ('d1000000-0000-4000-8000-000000000001',
   'Parent First Seat Race','REGISTERING',1000,'mtt','MTT',9),
  ('e1000000-0000-4000-8000-000000000001',
   'Deliberate Zero Supply Close','REGISTERING',1000,'mtt','MTT',9);
INSERT INTO public.tables(id,tournament_id,status,max_players)
VALUES (
  'd3000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001','waiting',9
);
INSERT INTO public.tournament_players(tournament_id,user_id,chips,status)
VALUES
  ('a1000000-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000001',1000,'playing'),
  ('b1000000-0000-4000-8000-000000000001',
   'b2000000-0000-4000-8000-000000000001',1000,'playing'),
  ('c1000000-0000-4000-8000-000000000001',
   'c2000000-0000-4000-8000-000000000001',1000,'playing'),
  ('d1000000-0000-4000-8000-000000000001',
   'd2000000-0000-4000-8000-000000000001',0,'registered'),
  ('e1000000-0000-4000-8000-000000000001',
   'e2000000-0000-4000-8000-000000000001',0,'registered');
UPDATE public.tournaments
   SET status='RUNNING'
 WHERE id IN (
   'a1000000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000001',
   'c1000000-0000-4000-8000-000000000001'
 );

SELECT pg_temp.assert_raises(
  $$SELECT public.fn_append_tournament_chip_supply_event(
       'c1000000-0000-4000-8000-000000000001',
       (SELECT id FROM public.tournament_players
         WHERE tournament_id='c1000000-0000-4000-8000-000000000001'),
       'c2000000-0000-4000-8000-000000000001',
       (SELECT chip_supply_generation FROM public.tournament_players
         WHERE tournament_id='c1000000-0000-4000-8000-000000000001'),
       'entry_closed', -999,
       'race-probe-wrong-close-delta', 'pg17_probe', '{}'::jsonb
     )$$,
  'TOURNAMENT_CHIP_SUPPLY_CLOSE_DELTA_MISMATCH'
);
DO $wrong_close_was_atomic$
BEGIN
  IF (SELECT sum(amount_delta)::bigint
        FROM public.tournament_chip_supply_events
       WHERE tournament_id='c1000000-0000-4000-8000-000000000001')
       IS DISTINCT FROM 1000::bigint
     OR EXISTS (
       SELECT 1 FROM public.tournament_chip_supply_events
        WHERE tournament_id='c1000000-0000-4000-8000-000000000001'
          AND event_kind='entry_closed'
     ) THEN
    RAISE EXCEPTION 'refused close delta mutated immutable supply history';
  END IF;
END;
$wrong_close_was_atomic$;
UPDATE public.tournaments SET status='CANCELLED'
 WHERE id='c1000000-0000-4000-8000-000000000001';

/* A zero close is lawful only for a generation whose sole prior fact is its
   zero-valued opening marker. This is deliberate retirement, not issuance. */
UPDATE public.tournaments SET status='CANCELLED'
 WHERE id='e1000000-0000-4000-8000-000000000001';
DO $deliberate_zero_supply_close$
BEGIN
  IF (SELECT count(*) FROM public.tournament_chip_supply_events
       WHERE tournament_id='e1000000-0000-4000-8000-000000000001')
       IS DISTINCT FROM 2::bigint
     OR (SELECT count(*) FROM public.tournament_chip_supply_events
          WHERE tournament_id='e1000000-0000-4000-8000-000000000001'
            AND event_kind='entry_closed'
            AND amount_delta=0) IS DISTINCT FROM 1::bigint
     OR COALESCE((
          SELECT sum(amount_delta)::bigint
            FROM public.tournament_chip_supply_events
           WHERE tournament_id='e1000000-0000-4000-8000-000000000001'
        ), 0) <> 0 THEN
    RAISE EXCEPTION
      'zero close was not limited to one deliberately unissued generation';
  END IF;
END;
$deliberate_zero_supply_close$;

SELECT 'TOURNAMENT_CHIP_SUPPLY_LEDGER_RACE_SETUP_PG17_OK' AS race_setup;

SELECT 'TOURNAMENT_CHIP_SUPPLY_LEDGER_PG17_OK' AS result;
