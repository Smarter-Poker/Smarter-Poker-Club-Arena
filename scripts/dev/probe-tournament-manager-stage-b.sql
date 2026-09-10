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

/* All three are intentionally authenticated player RPCs as well as manager RPCs.
   Test the actual hook under the request role before any routine body runs. */
SELECT set_config('request.method', 'POST', true);
SELECT set_config('request.path', '/rpc/process_tournament_rebuy', true);
SET LOCAL ROLE authenticated;
SELECT smarter_private.fn_smarter_data_api_pre_request();
RESET ROLE;
SELECT set_config('request.path', '/rest/v1/rpc/fn_decline_tournament_rebuy', true);
SET LOCAL ROLE authenticated;
SELECT smarter_private.fn_smarter_data_api_pre_request();
RESET ROLE;
SELECT set_config('request.path', '/rpc/fn_mystery_bounty_reveal', true);
SET LOCAL ROLE authenticated;
SELECT smarter_private.fn_smarter_data_api_pre_request();
RESET ROLE;
DO $player_purchase_scope$
BEGIN
  IF current_setting('app.smarter_data_actor', true) <> 'browser'
     OR COALESCE(current_setting('app.smarter_manager_request_fenced', true), '') <> '' THEN
    RAISE EXCEPTION 'player purchase received manager authority';
  END IF;
END;
$player_purchase_scope$;
SELECT set_config('request.method', 'GET', true);
SELECT set_config('request.path', '/tournaments', true);


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
DECLARE
  v_authenticator_oid oid;
  v_current_database_oid oid;
  v_canonical_global_hook_settings bigint;
  v_applicable_hook_settings bigint;
BEGIN
  SELECT r.oid INTO STRICT v_authenticator_oid
    FROM pg_roles r
   WHERE r.rolname = 'authenticator';
  SELECT d.oid INTO STRICT v_current_database_oid
    FROM pg_database d
   WHERE d.datname = current_database();

  IF current_setting('app.smarter_data_actor', true) <> 'service' THEN
    RAISE EXCEPTION 'service_role could not execute the private PostgREST hook';
  END IF;
  IF to_regprocedure('public.fn_smarter_data_api_pre_request()') IS NOT NULL THEN
    RAISE EXCEPTION 'request hook still has a public RPC spelling';
  END IF;
  SELECT
    count(*) FILTER (
      WHERE s.setdatabase = 0
        AND s.setrole = v_authenticator_oid
        AND setting.value =
            'pgrst.db_pre_request=smarter_private.fn_smarter_data_api_pre_request'
    ),
    count(*)
    INTO v_canonical_global_hook_settings, v_applicable_hook_settings
    FROM pg_db_role_setting s
    CROSS JOIN LATERAL unnest(COALESCE(s.setconfig, '{}'::text[])) AS setting(value)
   WHERE s.setdatabase IN (0, v_current_database_oid)
     AND s.setrole IN (0, v_authenticator_oid)
     AND setting.value LIKE 'pgrst.db_pre_request=%';

  IF v_canonical_global_hook_settings <> 1
     OR v_applicable_hook_settings <> 1 THEN
    RAISE EXCEPTION
      'PostgREST private request hook settings are not exact (canonical global %, applicable %)',
      v_canonical_global_hook_settings,
      v_applicable_hook_settings;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_db_role_setting s
      CROSS JOIN LATERAL unnest(COALESCE(s.setconfig, '{}'::text[])) AS setting(value)
      CROSS JOIN LATERAL regexp_split_to_table(
        split_part(setting.value, '=', 2),
        '[[:space:]]*,[[:space:]]*'
      ) AS exposed(schema_name)
     WHERE s.setdatabase IN (0, v_current_database_oid)
       AND s.setrole IN (0, v_authenticator_oid)
       AND setting.value LIKE 'pgrst.db_schemas=%'
       AND exposed.schema_name = 'smarter_private'
  ) THEN
    RAISE EXCEPTION 'smarter_private is exposed to this PostgREST instance';
  END IF;
END;
$service_hook_execution_and_private_surface$;

DO $probe$
DECLARE
  v_denied boolean;
  v_kind text;
  v_route text;
  v_result jsonb;
BEGIN
  FOREACH v_kind IN ARRAY ARRAY[
    'place', 'late_reg_adjustment', 'bubble_protection',
    'final_table_deal', 'satellite_remainder', 'seat'
  ]::text[] LOOP
    v_result := public.fn_settle_tournament_obligation(
      '10000000-0000-4000-8000-000000000001', v_kind,
      CASE WHEN v_kind IN ('place', 'late_reg_adjustment') THEN 1 ELSE NULL END,
      '30000000-0000-4000-8000-000000000001', 1, 'pg17.stage_b', NULL, NULL
    );
    IF v_result->>'refused_reason' IS DISTINCT FROM 'atomic_batch_required' THEN
      RAISE EXCEPTION 'public payer admitted pool kind %: %', v_kind, v_result;
    END IF;
  END LOOP;
  v_result := public.fn_settle_tournament_obligation(
    '10000000-0000-4000-8000-000000000001', 'refund', NULL,
    '30000000-0000-4000-8000-000000000001', 1, 'pg17.stage_b', NULL, NULL
  );
  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'public payer stopped delegating a non-pool refund: %', v_result;
  END IF;
  IF (
    SELECT count(*)
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.tournaments'::regclass
       AND t.tgname IN (
         'aaa_guard_atomic_satellite_completion',
         'aa_guard_tournament_completing_claim',
         'zzzz_tournaments_atomic_place_completion_guard',
         'zzzzz_tournaments_atomic_final_table_deal_completion_guard',
         'zzzzzz_tournaments_financial_certificate',
         'zzzz_tournament_pool_finalization_window_guard',
         'zzzz_freeze_finalized_tournament_prize_pool'
       )
       AND NOT t.tgisinternal
       AND t.tgenabled <> 'D'
  ) <> 7 THEN
    RAISE EXCEPTION 'Stage B did not activate all seven settlement guards';
  END IF;

  IF to_regprocedure(
       'public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'Stage B did not retire the raw legacy capacity bridge';
  END IF;
  IF (
    SELECT count(*)
      FROM public.tournament_table_origins o
      JOIN public.tournament_capacity_table_receipts c
        ON c.table_id = o.table_id
       AND c.tournament_id = o.tournament_id
      JOIN public.tournament_manager_wakes w
        ON w.id = c.manager_wake_id
     WHERE o.table_id IN (
       '20000000-0000-4000-8000-000000000003',
       '20000000-0000-4000-8000-000000000005'
     )
       AND o.origin_kind = 'capacity'
       AND w.reason = 'late_registration'
  ) <> 2 THEN
    RAISE EXCEPTION
      'Stage B lost canonical provenance for a Stage-A bridge-born table';
  END IF;

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

  /* Shared player/manager routines are not a generic service back door.
     Their unmarked authenticated shape is tested above; every service shape
     except an exact manager lease must stop at the request boundary. */
  FOREACH v_route IN ARRAY ARRAY[
    'rpc/fn_decline_tournament_rebuy',
    'rpc/fn_mystery_bounty_reveal',
    'rpc/process_tournament_rebuy'
  ]::text[] LOOP
    v_denied := false;
    PERFORM set_config('request.headers', '{}', true);
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    PERFORM set_config('request.path', '/' || v_route, true);
    BEGIN
      PERFORM smarter_private.fn_smarter_data_api_pre_request();
    EXCEPTION WHEN insufficient_privilege THEN
      v_denied := true;
    END;
    IF NOT v_denied THEN
      RAISE EXCEPTION 'unmarked service entered shared player/manager route %', v_route;
    END IF;

    v_denied := false;
    PERFORM set_config(
      'request.headers',
      '{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}',
      true
    );
    BEGIN
      PERFORM smarter_private.fn_smarter_data_api_pre_request();
    EXCEPTION WHEN insufficient_privilege THEN
      v_denied := true;
    END;
    IF NOT v_denied THEN
      RAISE EXCEPTION 'generic service actor entered shared player/manager route %', v_route;
    END IF;
  END LOOP;

  /* The same unmarked credential cannot enter an engine-private exact lease
     route. This closes old/headerless engine binaries without rejecting
     unrelated World Hub or Club Arena work. Exercise the gateway-prefixed
     path shape as well as the direct PostgREST shape. */
  v_denied := false;
  PERFORM set_config('request.headers', '{}', true);
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

  FOREACH v_route IN ARRAY ARRAY[
    'rpc/fn_decline_tournament_rebuy',
    'rpc/fn_mystery_bounty_reveal',
    'rpc/process_tournament_rebuy'
  ]::text[] LOOP
    PERFORM set_config('request.path', '/' || v_route, true);
    PERFORM smarter_private.fn_smarter_data_api_pre_request();
    IF current_setting('app.smarter_manager_request_fenced', true) <> 'protocol-2' THEN
      RAISE EXCEPTION 'exact manager lost lease proof on shared route %', v_route;
    END IF;
  END LOOP;

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
DO $settlement_fixture_scope$
BEGIN
  IF (
    SELECT count(*)
      FROM public.tables t
     WHERE t.id = '20000000-0000-4000-8000-000000000002'
       AND t.club_id = '70000000-0000-4000-8000-000000000002'
       AND t.tournament_id IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION
      'Stage-B settlement fixture lost its exact cash-table club scope';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.hand_atomic_commits c
     WHERE c.table_id = '20000000-0000-4000-8000-000000000002'
       AND c.hand_number = 1
  ) THEN
    RAISE EXCEPTION
      'Stage-B settlement fixture started with a pre-existing hand receipt';
  END IF;
END;
$settlement_fixture_scope$;

SET LOCAL ROLE service_role;
DO $settlement_probe$
DECLARE
  v_settlement jsonb;
BEGIN
  v_settlement := public.fn_ca_commit_hand_settlement(
    '20000000-0000-4000-8000-000000000002',
    1,
    '[]'::jsonb,
    0,
    0,
    'stage-b-probe',
    0,
    jsonb_build_object(
      'pot_size', 0,
      'big_blind', 2,
      '_accepted_post_commit_facts', jsonb_build_object(
        'contributions', '{}'::jsonb,
        'returned_uncalled', '{}'::jsonb,
        'insurance', '[]'::jsonb
      )
    ),
    '{}'::jsonb,
    'stage-b-probe',
    '50000000-0000-4000-8000-000000000099',
    jsonb_build_object(
      'version', '1',
      'time_banks', '[]'::jsonb,
      'promo_playthrough', '[]'::jsonb,
      'insurance', '[]'::jsonb,
      'pending_addons', jsonb_build_object('enabled', true, 'max_buy_in', 1),
      'rake', NULL,
      'bbj_contribution', NULL
    )
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
