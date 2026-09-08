\set ON_ERROR_STOP on

BEGIN;

/* PostgREST invokes the configured hook after switching to the request role.
   Prove the three API roles can execute the private hook without publishing a
   public RPC spelling. */
SELECT set_config('request.headers', '{}', true);
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT set_config('request.method', 'GET', true);
SELECT set_config('request.path', '/tournaments', true);
SET LOCAL ROLE anon;
SELECT smarter_private.fn_smarter_data_api_pre_request();
RESET ROLE;

DO $anon_hook_execution$
BEGIN
  IF current_setting('app.smarter_data_actor', true) <> 'browser' THEN
    RAISE EXCEPTION 'anon could not execute the private PostgREST hook';
  END IF;
END;
$anon_hook_execution$;

SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT smarter_private.fn_smarter_data_api_pre_request();
RESET ROLE;

DO $authenticated_hook_execution$
BEGIN
  IF current_setting('app.smarter_data_actor', true) <> 'browser' THEN
    RAISE EXCEPTION 'authenticated could not execute the private PostgREST hook';
  END IF;
END;
$authenticated_hook_execution$;

SELECT set_config(
  'request.headers',
  '{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}',
  true
);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SET LOCAL ROLE service_role;
SELECT smarter_private.fn_smarter_data_api_pre_request();
RESET ROLE;

DO $service_hook_execution_and_private_surface$
BEGIN
  IF current_setting('app.smarter_data_actor', true) <> 'service' THEN
    RAISE EXCEPTION 'service_role could not execute the private PostgREST hook';
  END IF;
  IF to_regprocedure('public.fn_smarter_data_api_pre_request()') IS NOT NULL THEN
    RAISE EXCEPTION 'request hook still has a public RPC spelling';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid = s.setrole
      CROSS JOIN LATERAL unnest(COALESCE(s.setconfig, '{}'::text[])) AS setting(value)
     WHERE r.rolname = 'authenticator'
       AND setting.value =
           'pgrst.db_pre_request=smarter_private.fn_smarter_data_api_pre_request'
  ) THEN
    RAISE EXCEPTION 'PostgREST is not configured for the private request hook';
  END IF;
END;
$service_hook_execution_and_private_surface$;

DO $probe$
DECLARE
  v_denied boolean;
BEGIN
  /* Headerless authenticated browser traffic remains valid. */
  PERFORM set_config('request.headers', '{}', true);
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  PERFORM set_config('request.method', 'GET', true);
  PERFORM set_config('request.path', '/tournaments', true);
  PERFORM smarter_private.fn_smarter_data_api_pre_request();
  IF current_setting('app.smarter_data_actor', true) <> 'browser' THEN
    RAISE EXCEPTION 'headerless authenticated request was not admitted as browser';
  END IF;

  /* The PostgREST hook is database-wide. Unrelated headerless service-role
     traffic belongs to the shared estate and must remain valid. */
  PERFORM set_config('request.headers', '{}', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.method', 'PATCH', true);
  PERFORM set_config('request.path', '/tournaments', true);
  PERFORM smarter_private.fn_smarter_data_api_pre_request();
  IF current_setting('app.smarter_data_actor', true) <>
       'shared-estate-service' THEN
    RAISE EXCEPTION 'headerless shared-estate service request was misclassified';
  END IF;
  UPDATE public.tournaments SET name = 'shared-estate-service'
   WHERE id = '10000000-0000-4000-8000-000000000002';

  /* The same unmarked credential cannot enter an engine-private exact lease
     route. This closes old/headerless engine binaries without rejecting
     unrelated World Hub or Club Arena work. Exercise the gateway-prefixed
     path shape as well as the direct PostgREST shape. */
  v_denied := false;
  PERFORM set_config('request.path', '/rest/v1/rpc/claim_table_lease_v2', true);
  BEGIN
    PERFORM smarter_private.fn_smarter_data_api_pre_request();
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'unmarked service entered an exact engine authority route';
  END IF;

  /* A protocol-1 service marker also cannot impersonate a manager on a
     manager-exclusive RPC. */
  v_denied := false;
  PERFORM set_config(
    'request.headers',
    '{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}',
    true
  );
  PERFORM set_config('request.path', '/rpc/fn_begin_tournament_launch_atomic', true);
  BEGIN
    PERFORM smarter_private.fn_smarter_data_api_pre_request();
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'ordinary service actor entered a manager-exclusive route';
  END IF;

  /* Marked recovery/coordination service work is admitted on engine-private
     routes that legitimately run outside a manager object. */
  PERFORM set_config('request.path', '/rpc/fn_sweep_pending_tournament_bounties', true);
  PERFORM smarter_private.fn_smarter_data_api_pre_request();
  IF current_setting('app.smarter_data_actor', true) <> 'service' THEN
    RAISE EXCEPTION 'marked engine service route lost its service identity';
  END IF;

  /* Ordinary explicitly marked service work also remains valid on shared rows. */
  PERFORM set_config(
    'request.headers',
    '{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}',
    true
  );
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.method', 'PATCH', true);
  PERFORM set_config('request.path', '/tournaments', true);
  PERFORM smarter_private.fn_smarter_data_api_pre_request();
  UPDATE public.tournaments SET name = 'ordinary-service'
   WHERE id = '10000000-0000-4000-8000-000000000002';

  /* A fresh exact manager generation enters and writes its own row. */
  PERFORM set_config(
    'request.headers',
    '{"x-smarter-data-actor":"tournament-manager",'
      '"x-smarter-data-protocol":"2",'
      '"x-smarter-tournament-id":"10000000-0000-4000-8000-000000000001",'
      '"x-smarter-tournament-lease-generation":"50000000-0000-4000-8000-000000000001"}',
    true
  );
  PERFORM set_config('request.method', 'POST', true);
  PERFORM set_config('request.path', '/rpc/fn_begin_tournament_launch_atomic', true);
  PERFORM smarter_private.fn_smarter_data_api_pre_request();
  IF current_setting('app.smarter_manager_request_fenced', true) <> 'protocol-2' THEN
    RAISE EXCEPTION 'fresh exact manager did not acquire request proof';
  END IF;

  /* Use the relation path for the direct write transaction represented by
     this probe. */
  PERFORM set_config('request.method', 'PATCH', true);
  PERFORM set_config('request.path', '/tournaments', true);
  PERFORM smarter_private.fn_smarter_data_api_pre_request();
  UPDATE public.tournaments SET name = 'exact-manager'
   WHERE id = '10000000-0000-4000-8000-000000000001';

  /* The same valid manager cannot write another tournament. */
  v_denied := false;
  BEGIN
    UPDATE public.tournaments SET name = 'cross-scope-manager'
     WHERE id = '10000000-0000-4000-8000-000000000002';
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'manager wrote a tournament outside its request scope';
  END IF;

  /* A parent-table teardown is valid manager work. Its BEFORE DELETE scope
     proof records the exact table id, allowing the FK cascade's seat DELETE
     after the parent tuple is no longer visible. The child row must disappear
     with the parent instead of aborting teardown or bypassing scope broadly. */
  INSERT INTO public.table_seats (
    table_id, user_id, seat_number, stack, left_at
  ) VALUES (
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    1, 1000, NULL
  );
  PERFORM set_config('request.method', 'DELETE', true);
  PERFORM set_config('request.path', '/tables', true);
  PERFORM smarter_private.fn_smarter_data_api_pre_request();
  DELETE FROM public.tables
   WHERE id = '20000000-0000-4000-8000-000000000001';
  IF EXISTS (
    SELECT 1 FROM public.table_seats
     WHERE table_id = '20000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'manager parent-table delete did not cascade its live seat';
  END IF;

  /* A different/replaced generation cannot enter. */
  v_denied := false;
  PERFORM set_config(
    'request.headers',
    '{"x-smarter-data-actor":"tournament-manager",'
      '"x-smarter-data-protocol":"2",'
      '"x-smarter-tournament-id":"10000000-0000-4000-8000-000000000001",'
      '"x-smarter-tournament-lease-generation":"50000000-0000-4000-8000-000000000099"}',
    true
  );
  BEGIN
    PERFORM smarter_private.fn_smarter_data_api_pre_request();
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'replaced manager generation entered Stage B';
  END IF;

  /* The exact generation also stops at the audited freshness boundary. */
  UPDATE public.engine_tournament_leases
     SET heartbeat_at = clock_timestamp() - interval '31 seconds'
   WHERE tournament_id = '10000000-0000-4000-8000-000000000001';
  v_denied := false;
  PERFORM set_config(
    'request.headers',
    '{"x-smarter-data-actor":"tournament-manager",'
      '"x-smarter-data-protocol":"2",'
      '"x-smarter-tournament-id":"10000000-0000-4000-8000-000000000001",'
      '"x-smarter-tournament-lease-generation":"50000000-0000-4000-8000-000000000001"}',
    true
  );
  BEGIN
    PERFORM smarter_private.fn_smarter_data_api_pre_request();
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'stale manager generation entered Stage B';
  END IF;

  IF to_regprocedure('public.claim_tournament_lease(uuid,text,text,integer)')
       IS NOT NULL
     OR to_regprocedure('public.heartbeat_tournament_leases_v2(text,uuid[],integer)')
       IS NOT NULL
     OR to_regprocedure('public.heartbeat_tournament_leases(text,uuid[])')
       IS NOT NULL
     OR to_regprocedure('public.release_tournament_leases(text,uuid[])')
       IS NOT NULL
     OR to_regprocedure(
          'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz)'
        ) IS NOT NULL
     OR to_regprocedure(
          'public.fn_complete_tournament_launch_atomic(uuid,uuid)'
        ) IS NOT NULL
     OR to_regprocedure('public.claim_table_lease(uuid,text,text,integer)')
        IS NOT NULL
     OR to_regprocedure('public.heartbeat_table_leases_v2(text,uuid[],integer)')
        IS NOT NULL
     OR to_regprocedure('public.heartbeat_table_leases(text,uuid[])')
        IS NOT NULL
     OR to_regprocedure('public.release_table_leases(text,uuid[])')
        IS NOT NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
        ) IS NOT NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
        ) IS NOT NULL THEN
    RAISE EXCEPTION 'legacy or superseded authority function survived the probe';
  END IF;

  IF to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'
     ) IS NULL
     OR to_regprocedure(
       'public.fn_ca_process_hand_post_commit_obligations(uuid)'
     ) IS NULL
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_process_hand_post_commit_obligations(uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_process_hand_post_commit_obligations(uuid)',
       'EXECUTE'
     )
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
     ) IS NULL
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'obligations-aware exact settlement authority is wrong';
  END IF;

END;
$probe$;

/* Execute as the real application role, not migration owner. The surviving
   12-argument SECURITY DEFINER door must still resolve its owner-only core
   after Stage B drops the 11-argument rolling wrapper. This catches a PL/pgSQL
   late-name dependency that catalog-existence checks alone cannot see. */
SET LOCAL ROLE service_role;
DO $settlement_probe$
DECLARE
  v_settlement jsonb;
BEGIN
  v_settlement := public.fn_ca_commit_hand_settlement(
    '20000000-0000-4000-8000-000000000099',
    1,
    '{}'::jsonb,
    0,
    0,
    'stage-b-probe',
    0,
    '{}'::jsonb,
    '{}'::jsonb,
    'stage-b-probe',
    '50000000-0000-4000-8000-000000000099',
    '{}'::jsonb
  );
  IF COALESCE((v_settlement->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_settlement->>'post_commit_obligations')::boolean, false)
        IS NOT TRUE THEN
    RAISE EXCEPTION '12-argument settlement broke after the 11-argument cutover';
  END IF;
END;
$settlement_probe$;
RESET ROLE;

ROLLBACK;

SELECT 'stage-b rollback probe passed' AS result;
