/*
 * STAGE A — transport and database foundation for tournament-manager request
 * fencing.  This migration is deliberately rolling-deploy compatible:
 *
 *   - an old engine sends no actor headers and is still admitted;
 *   - every new shared server client identifies ordinary work as `service`;
 *   - a new tournament manager identifies its exact protocol-2
 *     (tournament_id, lease_generation);
 *   - a marked manager request is rejected when that generation is stale;
 *   - the matching lease row is held FOR SHARE for the whole mutating
 *     PostgREST transaction, so takeover cannot commit halfway through it.
 *
 * Headerless traffic MUST NOT be rejected in this migration.  Stage B is a
 * later, database-only activation after the exact Stage-A engine build is
 * served and every old process has drained.  Stage B may then close legacy
 * manager doors and install manager-exclusive row/RPC guards.  Observability
 * can prove that rollout boundary; it must never repair correctness later.
 */

BEGIN;

DO $require_protocol_two_tournament_leases$
BEGIN
  IF to_regprocedure(
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'
     ) IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'engine_tournament_leases'
          AND c.column_name = 'protocol_version'
          AND c.data_type = 'integer'
          AND c.is_nullable = 'NO'
     ) THEN
    RAISE EXCEPTION
      'Stage-A manager request fencing requires protocol-2 tournament leases first';
  END IF;
END;
$require_protocol_two_tournament_leases$;

CREATE OR REPLACE FUNCTION public.fn_smarter_data_api_pre_request()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_headers jsonb;
  v_claims jsonb;
  v_actor text;
  v_protocol text;
  v_request_role text;
  v_method text;
  v_path text;
  v_tournament_id uuid;
  v_lease_generation uuid;
  /* Must remain identical to TOURNAMENT_LEASE_STALE_SECONDS and the claim RPC
     default. The catalog assertion below pins this audited takeover window. */
  v_stale_seconds constant integer := 30;
BEGIN
  BEGIN
    v_headers := COALESCE(
      NULLIF(current_setting('request.headers', true), '')::jsonb,
      '{}'::jsonb
    );
    v_claims := COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: malformed PostgREST request context'
      USING ERRCODE = '22023';
  END;

  v_actor := lower(btrim(COALESCE(v_headers ->> 'x-smarter-data-actor', '')));
  v_protocol := btrim(COALESCE(v_headers ->> 'x-smarter-data-protocol', ''));
  /* This function is SECURITY DEFINER, so current_user is its owner, not the
     impersonated API role. The transaction-scoped, PostgREST-verified JWT
     claims are the request identity inside this privileged function. */
  v_request_role := btrim(COALESCE(v_claims ->> 'role', ''));
  v_method := upper(btrim(COALESCE(current_setting('request.method', true), '')));
  v_path := lower(btrim(COALESCE(current_setting('request.path', true), ''), '/'));

  /* The hook must be executable by each impersonated API role, but it is not
     itself an application RPC. Refuse its otherwise auto-exposed route. */
  IF v_path = 'rpc/fn_smarter_data_api_pre_request' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: request hook is not an RPC'
      USING ERRCODE = '42501';
  END IF;

  /* Stage A strict mode is intentionally OFF.  Unmarked old engines and
     ordinary browser clients remain compatible until a later activation
     migration.  Recording the local marker lets downstream Stage-B guards
     distinguish this path without guessing from table names or payloads. */
  IF v_actor = '' THEN
    PERFORM set_config('app.smarter_data_actor', 'legacy-unmarked', true);
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_request_role <> 'service_role' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: marked server actor requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor = 'service' THEN
    IF v_protocol <> '1'
       OR length(btrim(COALESCE(v_headers ->> 'x-smarter-tournament-id', ''))) > 0
       OR length(
            btrim(
              COALESCE(v_headers ->> 'x-smarter-tournament-lease-generation', '')
            )
          ) > 0 THEN
      RAISE EXCEPTION 'DATA_ACTOR_INVALID: service authority headers are inconsistent'
        USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('app.smarter_data_actor', 'service', true);
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_actor <> 'tournament-manager' OR v_protocol <> '2' THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: unknown actor or protocol'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_tournament_id := (v_headers ->> 'x-smarter-tournament-id')::uuid;
    v_lease_generation :=
      (v_headers ->> 'x-smarter-tournament-lease-generation')::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END;
  IF v_tournament_id IS NULL OR v_lease_generation IS NULL THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END IF;

  /* PostgREST executes this hook inside the same transaction as the requested
     statement.  Read-only GET/HEAD requests need exact validation only.
     Every possible mutation method takes a shared row lock first; a lease
     takeover/update therefore waits until this manager transaction commits. */
  IF v_method IN ('GET', 'HEAD', 'OPTIONS') THEN
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds);
  ELSE
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds)
     FOR SHARE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.smarter_data_actor', 'tournament-manager', true);
  PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
  PERFORM set_config(
    'app.smarter_tournament_lease_generation',
    v_lease_generation::text,
    true
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_smarter_data_api_pre_request()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_smarter_data_api_pre_request()
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.fn_smarter_data_api_pre_request() IS
  'Stage-A Data API actor boundary. Headerless legacy traffic remains allowed; marked protocol-2 tournament managers must prove and transaction-lock their exact current lease generation.';

/* Prove the SECURITY DEFINER identity edge in executable SQL.  The migration
   owner is deliberately not service_role, yet a verified service-role claim
   must admit a marked service request. An authenticated claim using identical
   headers must fail. */
DO $prove_request_claims_not_function_owner$
DECLARE
  v_denied boolean := false;
BEGIN
  IF current_user = 'service_role' THEN
    RAISE EXCEPTION
      'Request-claim proof requires a migration owner distinct from service_role';
  END IF;

  PERFORM set_config(
    'request.headers',
    '{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}',
    true
  );
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.method', 'GET', true);
  PERFORM set_config('request.path', '/tournaments', true);
  PERFORM public.fn_smarter_data_api_pre_request();
  IF current_setting('app.smarter_data_actor', true) <> 'service' THEN
    RAISE EXCEPTION 'Verified service-role claims did not establish service actor context';
  END IF;

  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  BEGIN
    PERFORM public.fn_smarter_data_api_pre_request();
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Non-service JWT claims could forge a marked server actor';
  END IF;

  PERFORM set_config('request.headers', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.method', '', true);
  PERFORM set_config('request.path', '', true);
  PERFORM set_config('app.smarter_data_actor', '', true);
END;
$prove_request_claims_not_function_owner$;

/* Never silently replace an unrelated PostgREST hook.  A composed hook needs
   an explicit audited migration because hook order can be correctness-critical. */
DO $install_smarter_data_api_pre_request$
DECLARE
  v_conflicting_setting text;
BEGIN
  SELECT setting.value
    INTO v_conflicting_setting
    FROM pg_db_role_setting s
    JOIN pg_roles r ON r.oid = s.setrole
    CROSS JOIN LATERAL unnest(COALESCE(s.setconfig, '{}'::text[])) AS setting(value)
   WHERE r.rolname = 'authenticator'
     AND s.setdatabase IN (
       0,
       (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())
     )
     AND setting.value LIKE 'pgrst.db_pre_request=%'
     AND split_part(setting.value, '=', 2)
         <> 'public.fn_smarter_data_api_pre_request'
   LIMIT 1;

  IF v_conflicting_setting IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to replace existing PostgREST hook: %',
      v_conflicting_setting;
  END IF;
END;
$install_smarter_data_api_pre_request$;

ALTER ROLE authenticator
  SET pgrst.db_pre_request = 'public.fn_smarter_data_api_pre_request';

NOTIFY pgrst, 'reload config';

DO $assert_stage_a_manager_request_fence$
DECLARE
  v_source text;
BEGIN
  SELECT p.prosrc
    INTO STRICT v_source
    FROM pg_proc p
   WHERE p.oid = 'public.fn_smarter_data_api_pre_request()'::regprocedure
     AND p.prosecdef;

  IF position($needle$v_actor = ''$needle$ IN v_source) = 0
     OR position($needle$'legacy-unmarked'$needle$ IN v_source) = 0
     OR position($needle$v_actor = 'service'$needle$ IN v_source) = 0
     OR position($needle$v_actor <> 'tournament-manager'$needle$ IN v_source) = 0
     OR position('v_stale_seconds constant integer := 30' IN v_source) = 0
     OR position('l.protocol_version = 2' IN v_source) = 0
     OR position('l.lease_generation = v_lease_generation' IN v_source) = 0
     OR position('l.heartbeat_at >=' IN v_source) = 0
     OR position('FOR SHARE' IN v_source) = 0 THEN
    RAISE EXCEPTION 'Stage-A manager request fence is incomplete';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'anon',
       'public.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'PostgREST cannot execute the Stage-A request hook';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid = s.setrole
      CROSS JOIN LATERAL unnest(COALESCE(s.setconfig, '{}'::text[])) AS setting(value)
     WHERE r.rolname = 'authenticator'
       AND setting.value =
           'pgrst.db_pre_request=public.fn_smarter_data_api_pre_request'
  ) THEN
    RAISE EXCEPTION 'PostgREST Stage-A request hook setting did not persist';
  END IF;
END;
$assert_stage_a_manager_request_fence$;

COMMIT;
