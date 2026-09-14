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
       AND l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation
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

