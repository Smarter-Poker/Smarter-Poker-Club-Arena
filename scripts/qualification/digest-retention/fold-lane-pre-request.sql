CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
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
  v_request_role := btrim(COALESCE(auth.role(), ''));

  -- P3 targeted revocation: no blanket restriction on legacy/sessionless accounts.
  IF v_request_role='authenticated' THEN
    IF EXISTS(SELECT 1 FROM public.ca_player_session_revocations WHERE user_id=auth.uid()) THEN
      IF NOT public.fn_ca_player_session_live(auth.uid(),NULLIF(v_claims->>'session_id','')::uuid) THEN
        RAISE EXCEPTION 'SESSION_REVOKED: sign in again' USING ERRCODE='PT401';
      END IF;
    END IF;
  END IF;

  IF v_actor <> ''
     AND v_request_role <> btrim(COALESCE(v_claims ->> 'role', '')) THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: verified JWT role disagrees with request claims'
      USING ERRCODE = '22023';
  END IF;
  v_method := upper(btrim(COALESCE(current_setting('request.method', true), '')));
  v_path := lower(btrim(COALESCE(current_setting('request.path', true), ''), '/'));

  /* This route cannot exist while smarter_private stays outside db-schemas.
     Keep the refusal as fail-closed defence if that deployment boundary is
     ever misconfigured. */
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
  IF v_method IN ('GET', 'HEAD', 'OPTIONS')
     OR current_setting('transaction_read_only') = 'on' THEN
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,v_lease_generation)
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds);
  ELSE
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,v_lease_generation)
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds)
     /* A BUSY MANAGER KEEPS ITS LEASE (2026-09-10): FOR KEY SHARE, not
        FOR SHARE. The heartbeat renews heartbeat_at with FOR NO KEY
        UPDATE ... SKIP LOCKED; FOR SHARE made every in-flight manager
        request read as busy and expired the manager after 20 seconds.
        A takeover still waits: claim_tournament_lease_v2 takes FOR
        UPDATE, which FOR KEY SHARE does conflict with. */
     FOR KEY SHARE;
  END IF;

  IF NOT FOUND THEN
    /* A FENCED MANAGER'S STOPPED CUSTODY GOES THROUGH THE PROCESS WRITE
       (2026-09-26, migration 20260926131014). Exactly one request shape
       passes this point: a POST to engine_presence_parked. It is admitted
       under its own marker, never as a manager, and
       smarter_private.fn_fenced_manager_stopped_custody_park() (BEFORE
       INSERT on that table) either routes a stopped-custody row through
       public.fn_park_stopped_time_bank_custody - the same refusing write the
       engine calls at the process root since #5323 - and suppresses the raw
       upsert, or raises this same TOURNAMENT_MANAGER_FENCED. Every other
       method, path and row is fenced exactly as before. */
    IF v_method = 'POST' AND v_path = 'engine_presence_parked' THEN
      PERFORM set_config('app.smarter_data_actor', 'fenced-manager-stopped-custody', true);
      PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
      PERFORM set_config(
        'app.smarter_tournament_lease_generation',
        v_lease_generation::text,
        true
      );
      RETURN;
    END IF;
    /* A FENCED GENERATION MAY READ ITS OWN TIME BANK RECEIPT (2026-10-03,
       migration 20261003185214). One more shape passes: a POST to
       rpc/fn_consume_time_bank, admitted under its own marker, never as a
       manager. fn_consume_time_bank answers it ONLY from the receipt that
       request id already committed, and otherwise raises this same
       TOURNAMENT_MANAGER_FENCED: a fenced generation never debits. */
    IF v_method = 'POST' AND v_path = 'rpc/fn_consume_time_bank' THEN
      PERFORM set_config('app.smarter_data_actor', 'fenced-manager-time-bank-receipt', true);
      PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
      PERFORM set_config(
        'app.smarter_tournament_lease_generation',
        v_lease_generation::text,
        true
      );
      RETURN;
    END IF;
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
$function$

