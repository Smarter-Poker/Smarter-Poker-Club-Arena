-- A busy settlement must not turn a fleet heartbeat into a global lock queue.
-- v3 remains available to the running predecessor until the scheduled cutover.
BEGIN;

CREATE OR REPLACE FUNCTION public.heartbeat_table_leases_v4(
  p_instance_id text,
  p_claims jsonb,
  p_stale_seconds integer DEFAULT 30
) RETURNS TABLE(
  table_id uuid,
  state text,
  lease_generation uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
$function$;

REVOKE ALL ON FUNCTION public.heartbeat_table_leases_v4(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_table_leases_v4(text, jsonb, integer)
  TO service_role;


COMMENT ON FUNCTION public.heartbeat_table_leases_v4(text,jsonb,integer) IS
  'Exact-generation renewal without cross-table row-lock waits. busy grants no proof; retain only the prior local deadline. v3 remains for predecessor compatibility.';

CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases_v4(
  p_instance_id text,
  p_claims jsonb,
  p_stale_seconds integer DEFAULT 30
) RETURNS TABLE(
  tournament_id uuid,
  state text,
  lease_generation uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
            AND l.lease_generation = a.requested_generation THEN 'busy'
           ELSE 'taken'
         END,
         l.lease_generation
    FROM asked a
    LEFT JOIN renewed r ON r.tournament_id = a.id
    LEFT JOIN public.engine_tournament_leases l ON l.tournament_id = a.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases_v4(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v4(text, jsonb, integer)
  TO service_role;


COMMENT ON FUNCTION public.heartbeat_tournament_leases_v4(text,jsonb,integer) IS
  'Exact-generation renewal without cross-table row-lock waits. busy grants no proof; retain only the prior local deadline. v3 remains for predecessor compatibility.';

COMMIT;
