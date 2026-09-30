/*
 * A STALE LEASE YIELDS TO ITS NAMED SUCCESSOR (2026-09-27).
 *
 * The stale-takeover branch of claim_tournament_lease_v2 read
 *
 *       l.heartbeat_at < clock_timestamp() - interval '30 seconds'
 *   AND l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation
 *
 * so a stale row could only be adopted by a claimant asking for a DIFFERENT
 * generation. That is exactly the one generation a mixed manager-custody
 * successor is not allowed to ask for: fn_f06_find_mixed_manager_custody
 * hands the next engine the transfer's successor_generation, and the holder
 * that died already stamped that same generation into the lease row when it
 * was admitted. Requested generation == row generation, so the takeover
 * branch was false; the row's instance differs, so the renewal branch was
 * false; no branch matched, and the claim came back owned_elsewhere forever.
 *
 * Measured on production 2026-09-27 22:00 UTC: 44 RUNNING tournaments whose
 * leases were last heartbeated 2026-09-26 09:34 UTC - 1.37 days - by the dead
 * instance 1-2fe24354, every one of them carrying a mixed custody transfer
 * created 09-26 09:33-09:34 whose successor_generation equals the lease row's
 * lease_generation. The live engine logged "[tournament-lease] <id> is held
 * by 1-2fe24354. Standing down." on every pass, 36 hours after that holder
 * stopped breathing, and not one hand was dealt in any of them.
 *
 * The guard was also redundant. A claimant asking for the generation the row
 * already carries, from the instance the row already names, is granted by the
 * FIRST branch (same instance, same protocol-2 generation) whether the row is
 * stale or not - that is ordinary renewal. So the only case this clause could
 * ever decide is a DIFFERENT instance adopting a stale row that names the
 * generation it was told to ask for, which is the case that must be allowed.
 *
 * Staleness still does all of the safety work: 30 seconds without a heartbeat
 * is the audited boundary the whole protocol is built on, a live holder can
 * never be stale, and heartbeat_tournament_leases_v4 already refuses to renew
 * past it ("an exact UUID is not immortal authority"). Nothing else about the
 * function changes: same signature, same audited window, same abort check,
 * same FOR UPDATE ordering, same acquired_at rule, same return shape.
 */
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
$function$;
