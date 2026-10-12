-- Captured from production by capture-live-doors.py. Do not edit by hand.

-- fn_engine_lease_stale_seconds() md5 483a7e0ee940744fd557f1f2144d9eba
CREATE OR REPLACE FUNCTION public.fn_engine_lease_stale_seconds()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT 30;
$function$
;

-- claim_engine_leadership(text,text,integer) md5 935c9d79f348a7cd1adf27d1a5b1ebc6
CREATE OR REPLACE FUNCTION public.claim_engine_leadership(p_instance_id text, p_version text DEFAULT NULL::text, p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_holder    text;
  v_heartbeat timestamptz;
begin
  if coalesce(p_instance_id, '') = '' then
    raise exception 'claim_engine_leadership requires a non-empty instance_id';
  end if;

  insert into public.engine_leader as l
    (id, instance_id, engine_version, acquired_at, heartbeat_at)
  values
    (true, p_instance_id, p_version, now(), now())
  on conflict (id) do update
     set instance_id    = excluded.instance_id,
         engine_version = excluded.engine_version,
         acquired_at    = case
                            when l.instance_id = excluded.instance_id then l.acquired_at
                            else now()
                          end,
         heartbeat_at   = now()
   where l.instance_id = excluded.instance_id
      or l.heartbeat_at < now() - make_interval(secs => p_stale_seconds)
  returning l.instance_id, l.heartbeat_at into v_holder, v_heartbeat;

  if v_holder is not null then
    return query select true, v_holder, 0::numeric;
    return;
  end if;

  select l.instance_id, l.heartbeat_at into v_holder, v_heartbeat
    from public.engine_leader l where l.id = true;

  return query
    select false, v_holder,
           round(extract(epoch from (now() - v_heartbeat))::numeric, 1);
end;
$function$
;

-- release_engine_leadership(text) md5 9faf8a29ad5d75078d04b04aa36569cf
CREATE OR REPLACE FUNCTION public.release_engine_leadership(p_instance_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_deleted integer;
begin
  delete from public.engine_leader l where l.instance_id = p_instance_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$
;

-- claim_table_lease_v2(uuid,text,text,uuid,integer) md5 2c6a2555d927c8dbbad47b8ac7b60552
CREATE OR REPLACE FUNCTION public.claim_table_lease_v2(p_table_id uuid, p_instance_id text, p_version text DEFAULT NULL::text, p_requested_generation uuid DEFAULT NULL::uuid, p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric, lease_generation uuid, protocol_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_holder text;
  v_heartbeat timestamptz;
  v_generation uuid;
  v_protocol integer;
BEGIN
  IF p_table_id IS NULL
     OR length(btrim(COALESCE(p_instance_id, ''))) = 0
     OR p_requested_generation IS NULL THEN
    RAISE EXCEPTION
      'claim_table_lease_v2 requires table_id, instance_id, and requested_generation'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds() THEN
    RAISE EXCEPTION 'claim_table_lease_v2 requires the audited 30 second stale window'
      USING ERRCODE = '22023';
  END IF;

  /* A BUSY TABLE KEEPS ITS LEASE (2026-09-12): the takeover waits for every
     in-flight settlement (they hold FOR KEY SHARE on this row). The upsert
     below only takes FOR NO KEY UPDATE on its own, which FOR KEY SHARE does
     not block - so without this the settlement's lock would exclude nothing.
     This is the cash half of the pair claim_tournament_lease_v2 has had since
     2026-09-10. */
  PERFORM 1 FROM public.engine_table_leases l
   WHERE l.table_id = p_table_id
   FOR UPDATE;

  INSERT INTO public.engine_table_leases AS l (
    table_id,
    instance_id,
    engine_version,
    acquired_at,
    heartbeat_at,
    lease_generation,
    protocol_version
  ) VALUES (
    p_table_id,
    p_instance_id,
    p_version,
    clock_timestamp(),
    clock_timestamp(),
    p_requested_generation,
    2
  )
  ON CONFLICT (table_id) DO UPDATE
     SET instance_id = EXCLUDED.instance_id,
         engine_version = EXCLUDED.engine_version,
         acquired_at = CASE
           WHEN l.protocol_version = 2
            AND l.instance_id = EXCLUDED.instance_id
            AND l.lease_generation = EXCLUDED.lease_generation THEN l.acquired_at
           ELSE clock_timestamp()
         END,
         heartbeat_at = clock_timestamp(),
         lease_generation = EXCLUDED.lease_generation,
         protocol_version = 2
   WHERE (
       l.protocol_version = 2
       AND l.instance_id = EXCLUDED.instance_id
       AND l.lease_generation = EXCLUDED.lease_generation
     )
      OR (
       l.protocol_version < 2
       AND l.instance_id = EXCLUDED.instance_id
     )
      OR (
           l.heartbeat_at < clock_timestamp() - make_interval(
             secs => public.fn_engine_lease_stale_seconds()
           )
       AND l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation
         )
  RETURNING l.instance_id,
            l.heartbeat_at,
            l.lease_generation,
            l.protocol_version
       INTO v_holder, v_heartbeat, v_generation, v_protocol;

  IF v_holder IS NOT NULL THEN
    RETURN QUERY SELECT true, v_holder, 0::numeric, v_generation, v_protocol;
    RETURN;
  END IF;

  SELECT l.instance_id,
         l.heartbeat_at,
         l.lease_generation,
         l.protocol_version
    INTO v_holder, v_heartbeat, v_generation, v_protocol
    FROM public.engine_table_leases l
   WHERE l.table_id = p_table_id;

  RETURN QUERY
    SELECT false,
           v_holder,
           round(extract(epoch FROM (clock_timestamp() - v_heartbeat))::numeric, 1),
           v_generation,
           v_protocol;
END;
$function$
;

-- heartbeat_table_leases_v4(text,jsonb,integer) md5 d41240dd1791c6ea8b38c717a04689ab
CREATE OR REPLACE FUNCTION public.heartbeat_table_leases_v4(p_instance_id text, p_claims jsonb, p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(table_id uuid, state text, lease_generation uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF length(btrim(COALESCE(p_instance_id, ''))) = 0 THEN
    RAISE EXCEPTION 'heartbeat_table_leases_v4 requires a non-empty instance_id'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds() THEN
    RAISE EXCEPTION 'heartbeat_table_leases_v4 requires the audited 30 second stale window'
      USING ERRCODE = '22023';
  END IF;
  IF p_claims IS NULL OR jsonb_typeof(p_claims) <> 'array' THEN
    RAISE EXCEPTION 'heartbeat_table_leases_v4 requires a JSON array of claims'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_claims) item
     WHERE jsonb_typeof(item) <> 'object'
        OR length(btrim(COALESCE(item ->> 'table_id', ''))) = 0
        OR length(btrim(COALESCE(item ->> 'lease_generation', ''))) = 0
  ) THEN
    RAISE EXCEPTION
      'heartbeat_table_leases_v4 requires table_id and lease_generation for every claim'
      USING ERRCODE = '22023';
  END IF;

  /* Cast before any UPDATE and reject duplicate table ids for the whole
     request.  A partial heartbeat would falsely make omitted claims look
     current to the engine. */
  IF EXISTS (
    WITH asked AS (
      SELECT (item ->> 'table_id')::uuid AS id
        FROM jsonb_array_elements(p_claims) item
    )
    SELECT 1 FROM asked GROUP BY id HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'heartbeat_table_leases_v4 refuses duplicate tables'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH asked AS MATERIALIZED (
    SELECT (item ->> 'table_id')::uuid AS id,
           (item ->> 'lease_generation')::uuid AS requested_generation
      FROM jsonb_array_elements(p_claims) item
  ),
  lockable AS MATERIALIZED (
    SELECT l.table_id
      FROM public.engine_table_leases l
      JOIN asked a ON a.id = l.table_id
     WHERE l.instance_id = p_instance_id
       AND l.protocol_version = 2
       AND l.lease_generation = a.requested_generation
       AND l.heartbeat_at >= clock_timestamp() - make_interval(
         secs => public.fn_engine_lease_stale_seconds()
       )
     -- Keep the same conflicting lock as the UPDATE, but never queue behind
     -- a settlement while holding already-renewed leases for other tables.
     FOR NO KEY UPDATE OF l SKIP LOCKED
  ),
  renewed AS (
    UPDATE public.engine_table_leases l
       SET heartbeat_at = clock_timestamp()
      FROM asked a, lockable k
     WHERE l.table_id = a.id
       AND k.table_id = l.table_id
       AND l.instance_id = p_instance_id
       AND l.protocol_version = 2
       AND l.lease_generation = a.requested_generation
       AND l.heartbeat_at >= clock_timestamp() - make_interval(
         secs => public.fn_engine_lease_stale_seconds()
       )
    RETURNING l.table_id, l.lease_generation
  )
  SELECT a.id,
         CASE
           WHEN r.table_id IS NOT NULL THEN 'kept'
           WHEN l.table_id IS NULL THEN 'missing'
           WHEN l.heartbeat_at < clock_timestamp() - make_interval(
             secs => public.fn_engine_lease_stale_seconds()
           ) THEN 'stale'
           WHEN l.instance_id = p_instance_id
            AND l.protocol_version = 2
            AND l.lease_generation = a.requested_generation THEN 'busy'
           ELSE 'taken'
         END,
         l.lease_generation
    FROM asked a
    LEFT JOIN renewed r ON r.table_id = a.id
    LEFT JOIN public.engine_table_leases l ON l.table_id = a.id;
END;
$function$
;

-- release_table_leases_v2(text,jsonb) md5 a08340dd1708cd37530e8b66e3c2a1d9
CREATE OR REPLACE FUNCTION public.release_table_leases_v2(p_instance_id text, p_claims jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  IF length(btrim(COALESCE(p_instance_id, ''))) = 0
     OR p_claims IS NULL
     OR jsonb_typeof(p_claims) <> 'array' THEN
    RAISE EXCEPTION 'release_table_leases_v2 requires instance_id and a JSON claim array'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_claims) item
     WHERE jsonb_typeof(item) <> 'object'
        OR length(btrim(COALESCE(item ->> 'table_id', ''))) = 0
        OR length(btrim(COALESCE(item ->> 'lease_generation', ''))) = 0
  ) THEN
    RAISE EXCEPTION 'release_table_leases_v2 requires one exact generation per claim'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    WITH asked AS (
      SELECT (item ->> 'table_id')::uuid AS id
        FROM jsonb_array_elements(p_claims) item
    )
    SELECT 1 FROM asked GROUP BY id HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'release_table_leases_v2 refuses duplicate tables'
      USING ERRCODE = '22023';
  END IF;

  WITH asked AS MATERIALIZED (
    SELECT (item ->> 'table_id')::uuid AS table_id,
           (item ->> 'lease_generation')::uuid AS lease_generation
      FROM jsonb_array_elements(p_claims) item
  )
  DELETE FROM public.engine_table_leases l
   USING asked a
   WHERE l.table_id = a.table_id
     AND l.instance_id = p_instance_id
     AND l.protocol_version = 2
     AND l.lease_generation = a.lease_generation;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$
;

-- claim_tournament_lease_v2(uuid,text,text,uuid,integer) md5 14f4ed4a7659d42188f57da0a54af421
CREATE OR REPLACE FUNCTION public.claim_tournament_lease_v2(p_tournament_id uuid, p_instance_id text, p_version text DEFAULT NULL::text, p_requested_generation uuid DEFAULT NULL::uuid, p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric, lease_generation uuid, protocol_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_holder text;
  v_heartbeat timestamptz;
  v_generation uuid;
BEGIN
  IF p_tournament_id IS NULL
     OR length(btrim(COALESCE(p_instance_id, ''))) = 0
     OR p_requested_generation IS NULL THEN
    RAISE EXCEPTION
      'claim_tournament_lease_v2 requires tournament_id, instance_id, and requested_generation'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM 30 THEN
    RAISE EXCEPTION 'claim_tournament_lease_v2 requires the audited 30-second stale window'
      USING ERRCODE = '22023';
  END IF;

  /* A BUSY MANAGER KEEPS ITS LEASE (2026-09-10): the takeover waits for
     every in-flight manager transaction (they hold FOR KEY SHARE in the
     PostgREST pre-request hook). The upsert below only takes FOR NO KEY
     UPDATE on its own, which FOR KEY SHARE does not block. */
  PERFORM 1 FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;

  IF smarter_private.f06_generation_aborted(p_tournament_id,p_requested_generation) THEN
    RETURN QUERY SELECT false,NULL::text,NULL::numeric,NULL::uuid,2;
    RETURN;
  END IF;

  INSERT INTO public.engine_tournament_leases AS l (
    tournament_id,
    instance_id,
    engine_version,
    acquired_at,
    heartbeat_at,
    lease_generation,
    protocol_version
  ) VALUES (
    p_tournament_id,
    p_instance_id,
    p_version,
    clock_timestamp(),
    clock_timestamp(),
    p_requested_generation,
    2
  )
  ON CONFLICT (tournament_id) DO UPDATE
     SET instance_id = EXCLUDED.instance_id,
         engine_version = EXCLUDED.engine_version,
         acquired_at = CASE
           WHEN l.protocol_version = 2
            AND l.instance_id = EXCLUDED.instance_id
            AND l.lease_generation = EXCLUDED.lease_generation THEN l.acquired_at
           ELSE clock_timestamp()
         END,
         heartbeat_at = clock_timestamp(),
         lease_generation = EXCLUDED.lease_generation,
         protocol_version = 2
   WHERE (
           l.protocol_version = 2
       AND l.instance_id = EXCLUDED.instance_id
       AND l.lease_generation = EXCLUDED.lease_generation
         )
      OR (
           l.protocol_version < 2
       AND l.instance_id = EXCLUDED.instance_id
         )
      OR (
           l.heartbeat_at < clock_timestamp() - interval '30 seconds'
       AND (
             /* A different generation: the ordinary takeover. */
             l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation
             /* Or the same generation asked for by a DIFFERENT instance: the
                mixed manager-custody successor, which is told exactly which
                generation to request and would otherwise be locked out of a
                row its dead predecessor stamped with that same generation.
                Same-instance renewal is owned by the first branch above, so
                this can only ever admit a new holder to a stale row. */
          OR l.instance_id IS DISTINCT FROM EXCLUDED.instance_id
           )
         )
  RETURNING l.instance_id, l.heartbeat_at, l.lease_generation
       INTO v_holder, v_heartbeat, v_generation;

  IF v_holder IS NOT NULL THEN
    RETURN QUERY SELECT true, v_holder, 0::numeric, v_generation, 2;
    RETURN;
  END IF;

  SELECT l.instance_id, l.heartbeat_at, l.lease_generation
    INTO v_holder, v_heartbeat, v_generation
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id;

  RETURN QUERY
    SELECT false,
           v_holder,
           round(extract(epoch FROM (clock_timestamp() - v_heartbeat))::numeric, 1),
           v_generation,
           (SELECT l.protocol_version
              FROM public.engine_tournament_leases l
             WHERE l.tournament_id = p_tournament_id);
END;
$function$
;

-- heartbeat_tournament_leases_v4(text,jsonb,integer) md5 01fa17de7097d3c42748e6879b478411
CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases_v4(p_instance_id text, p_claims jsonb, p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(tournament_id uuid, state text, lease_generation uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF length(btrim(COALESCE(p_instance_id, ''))) = 0 THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v4 requires a non-empty instance_id'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM 30 THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v4 requires the audited 30-second stale window'
      USING ERRCODE = '22023';
  END IF;
  IF p_claims IS NULL OR jsonb_typeof(p_claims) <> 'array' THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v4 requires a JSON array of claims'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_claims) item
     WHERE jsonb_typeof(item) <> 'object'
        OR length(btrim(COALESCE(item ->> 'tournament_id', ''))) = 0
        OR length(btrim(COALESCE(item ->> 'lease_generation', ''))) = 0
  ) THEN
    RAISE EXCEPTION
      'heartbeat_tournament_leases_v4 requires tournament_id and lease_generation for every claim'
      USING ERRCODE = '22023';
  END IF;

  /* UUID casts intentionally fail the whole request on malformed authority.
     A partial heartbeat would make its omitted managers look proven. */
  IF EXISTS (
    WITH asked AS (
      SELECT (item ->> 'tournament_id')::uuid AS id
        FROM jsonb_array_elements(p_claims) item
    )
    SELECT 1 FROM asked GROUP BY id HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v4 refuses duplicate tournaments'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH asked AS MATERIALIZED (
    SELECT (item ->> 'tournament_id')::uuid AS id,
           (item ->> 'lease_generation')::uuid AS requested_generation
      FROM jsonb_array_elements(p_claims) item
  ),
  lockable AS MATERIALIZED (
    SELECT l.tournament_id
      FROM public.engine_tournament_leases l
      JOIN asked a ON a.id = l.tournament_id
     WHERE l.instance_id = p_instance_id
       AND l.protocol_version = 2
       AND l.lease_generation = a.requested_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation)
       AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     -- Keep the same conflicting lock as the UPDATE, but never queue behind
     -- a settlement while holding already-renewed leases for other tables.
     FOR NO KEY UPDATE OF l SKIP LOCKED
  ),
  renewed AS (
    UPDATE public.engine_tournament_leases l
       SET heartbeat_at = clock_timestamp()
      FROM asked a, lockable k
     WHERE l.tournament_id = a.id
       AND k.tournament_id = l.tournament_id
       AND l.instance_id = p_instance_id
       AND l.protocol_version = 2
       AND l.lease_generation = a.requested_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation)
       /* An exact UUID is not immortal authority. Once the audited takeover
          boundary passes, even the old holder must claim a new generation;
          a delayed callback may not resurrect the stale one by heartbeating. */
       AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
    RETURNING l.tournament_id, l.lease_generation
  )
  SELECT a.id,
         CASE
           WHEN r.tournament_id IS NOT NULL THEN 'kept'
           WHEN l.tournament_id IS NULL THEN 'missing'
           WHEN l.heartbeat_at < clock_timestamp() - interval '30 seconds' THEN 'stale'
           WHEN l.instance_id = p_instance_id
            AND l.protocol_version = 2
            AND l.lease_generation = a.requested_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation) THEN 'busy'
           ELSE 'taken'
         END,
         l.lease_generation
    FROM asked a
    LEFT JOIN renewed r ON r.tournament_id = a.id
    LEFT JOIN public.engine_tournament_leases l ON l.tournament_id = a.id;
END;
$function$
;

-- release_tournament_leases_v2(text,jsonb) md5 2c92f4af8b6f14b8cdc0a5af7e98fcf8
CREATE OR REPLACE FUNCTION public.release_tournament_leases_v2(p_instance_id text, p_claims jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  IF length(btrim(COALESCE(p_instance_id, ''))) = 0
     OR p_claims IS NULL
     OR jsonb_typeof(p_claims) <> 'array' THEN
    RAISE EXCEPTION 'release_tournament_leases_v2 requires instance_id and a JSON claim array'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_claims) item
     WHERE jsonb_typeof(item) <> 'object'
        OR length(btrim(COALESCE(item ->> 'tournament_id', ''))) = 0
        OR length(btrim(COALESCE(item ->> 'lease_generation', ''))) = 0
  ) THEN
    RAISE EXCEPTION 'release_tournament_leases_v2 requires one exact generation per claim'
      USING ERRCODE = '22023';
  END IF;

  /* A duplicate is a malformed authority request, not a claim to silently
     omit. Fail the transaction before deleting anything. */
  IF EXISTS (
    WITH asked AS (
      SELECT (item ->> 'tournament_id')::uuid AS tournament_id
        FROM jsonb_array_elements(p_claims) item
    )
    SELECT 1
      FROM asked
     GROUP BY tournament_id
    HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'release_tournament_leases_v2 refuses duplicate tournaments'
      USING ERRCODE = '22023';
  END IF;

  WITH asked AS MATERIALIZED (
    SELECT (item ->> 'tournament_id')::uuid AS tournament_id,
           (item ->> 'lease_generation')::uuid AS lease_generation
      FROM jsonb_array_elements(p_claims) item
  )
  DELETE FROM public.engine_tournament_leases l
   USING asked a
   WHERE l.tournament_id = a.tournament_id
     AND l.instance_id = p_instance_id
     AND l.protocol_version = 2
     AND l.lease_generation = a.lease_generation;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$
;

-- fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid) md5 c555fb7b83c889312995bc0038c1b275
CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb, p_instance_id text, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_locked_tournament_id uuid;
  v_holder text;
  v_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_lease_found boolean;
  v_scope text;
BEGIN
  IF length(btrim(COALESCE(p_instance_id, ''))) = 0
     OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'atomic_hand_commit', false,
      'reason', 'invalid_hand_lease_authority'
    );
  END IF;

  /* This read is deliberately unlocked and is used only to choose one lease
     relation.  No mutation follows until the chosen lease is locked and the
     tables row is itself locked/re-read below. */
  SELECT t.tournament_id INTO v_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'table_not_found');
  END IF;

  IF v_tournament_id IS NULL THEN
    v_scope := 'table';
    SELECT l.instance_id, l.lease_generation, l.protocol_version, l.heartbeat_at
      INTO v_holder, v_generation, v_protocol_version, v_heartbeat_at
      FROM public.engine_table_leases l
     WHERE l.table_id = p_table_id
     FOR KEY SHARE;
    v_lease_found := FOUND;
  ELSE
    v_scope := 'tournament';
    SELECT l.instance_id, l.lease_generation, l.protocol_version, l.heartbeat_at
      INTO v_holder, v_generation, v_protocol_version, v_heartbeat_at
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
     -- A HAND COMMIT DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT
     -- (2026-09-10): FOR KEY SHARE excludes a takeover (FOR UPDATE) and
     -- nothing else, so the heartbeat can still renew this row.
     FOR KEY SHARE;
    v_lease_found := FOUND;
  END IF;

  IF NOT v_lease_found
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_holder IS DISTINCT FROM p_instance_id
     OR v_generation IS DISTINCT FROM p_lease_generation THEN
    RETURN jsonb_build_object(
      'success', false,
      'atomic_hand_commit', false,
      'reason', 'hand_lease_lost',
      'lease_scope', v_scope,
      'lease_generation', v_generation
    );
  END IF;

  IF v_heartbeat_at < clock_timestamp() - make_interval(
       secs => public.fn_engine_lease_stale_seconds()
     ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'atomic_hand_commit', false,
      'reason', 'hand_lease_stale',
      'lease_scope', v_scope,
      'lease_generation', v_generation
    );
  END IF;

  /* Match the unchanged core and manager lock order before taking the mutable
     table row.  FOR SHARE excludes tournament lifecycle updates without
     serializing hands at distinct tables in the same event. */
  IF v_tournament_id IS NOT NULL THEN
    PERFORM 1
      FROM public.tournaments t
     WHERE t.id = v_tournament_id
     FOR SHARE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'reason', 'tournament_not_found');
    END IF;
  END IF;

  /* Cash uses lease -> table. Tournament settlement uses
     lease -> tournament parent -> table. Holding the exact lease now prevents
     takeover until the unchanged core has committed or rolled back. */
  SELECT t.tournament_id INTO v_locked_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'table_not_found');
  END IF;
  IF v_locked_tournament_id IS DISTINCT FROM v_tournament_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'atomic_hand_commit', false,
      'reason', 'hand_lease_scope_changed'
    );
  END IF;

  RETURN public.fn_ca_commit_hand_settlement_before_lease_generation(
    p_table_id,
    p_hand_number,
    p_stacks,
    p_rake,
    p_bbj,
    p_ref,
    p_inflow,
    p_hand_row,
    p_units
  );
END;
$function$
;

-- smarter_private.f06_generation_aborted(uuid,uuid) md5 3530559a94372866bf3baec006a8fd3c
CREATE OR REPLACE FUNCTION smarter_private.f06_generation_aborted(t uuid, g uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'smarter_private'
AS $function$
BEGIN
 -- Existing leases, heartbeats, request admission and resurrection triggers all
 -- use this VOLATILE authority after their row-lock waits.
 RETURN EXISTS(SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts
 WHERE tournament_id=t AND (generation=g OR retired_lease_generation=g))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_generation_aborts WHERE tournament_id=t AND generation=g)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_generations WHERE tournament_id=t AND generation=g);
END $function$
;

-- smarter_private.f06_aborted_generation_guard() md5 78bdb7fde133088800446a0da7dddc57
CREATE OR REPLACE FUNCTION smarter_private.f06_aborted_generation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'smarter_private'
AS $function$
BEGIN
 IF smarter_private.f06_generation_aborted(NEW.tournament_id,NEW.lease_generation) THEN
 RAISE EXCEPTION 'F06_ABORTED_GENERATION_FENCED' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $function$
;
