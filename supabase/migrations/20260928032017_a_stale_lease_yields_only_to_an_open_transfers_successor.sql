-- 20260928032017_a_stale_lease_yields_only_to_an_open_transfers_successor.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A STALE LEASE YIELDS ONLY TO AN OPEN TRANSFER'S NAMED SUCCESSOR (2026-09-28).
--
-- On 2026-09-26 09:31-09:33 UTC engine cd5892e8's lease collapse left 44
-- RUNNING tournaments whose lease row still named the dead instance
-- (1-2fe24354 / 1-00e3989e) at generation G, where G is the
-- successor_generation of the event's open mixed manager-custody transfer
-- (smarter_private.f06_manager_custody_transfers). The next engine is told to
-- ask for exactly G (fn_f06_find_mixed_manager_custody hands it the transfer's
-- successor_generation), and claim_tournament_lease_v2 only took a stale row
-- over for a DIFFERENT generation, so every claim came back granted=false and
-- the engine logged "Standing down" for 36 hours.
--
-- 20260927231300 (applied to production 2026-09-27 23:13 UTC from PR #5493)
-- opened the stale branch to ANY claimant from a different instance asking
-- for the row's own generation. That unstuck the 44, but it is wider than the
-- defect: the data fence (smarter_private.fn_smarter_data_api_pre_request)
-- admits a manager request on (tournament_id, lease_generation) alone, so a
-- same-generation takeover hands the new holder the SAME fence token the old
-- holder carries. A holder that was only paused past 30 s (event-loop stall,
-- GC, network partition) and resumes would pass the fence alongside its
-- successor. The only claimant that legitimately asks another process's
-- generation is the durable mixed-custody successor: every other admission
-- asks for a generation this process minted (retained, or randomUUID()) - see
-- GameServer.performTournamentManagerAdmission.
--
-- So the same-generation, different-instance stale takeover is kept for
-- exactly that case and no other:
--   * the row is stale (heartbeat older than the audited 30 s window), AND
--   * the claimant is a different instance, AND
--   * the requested generation is the successor_generation of a transfer for
--     THIS tournament (unique on (tournament_id, successor_generation)), AND
--   * that transfer is still OPEN: no row in
--     smarter_private.f06_manager_custody_completions.
-- Once the transfer completes, a restarted engine asks for a fresh generation
-- and takes the stale row through the ordinary different-generation branch,
-- which is unchanged. Nothing else changes: signature, 30-second window, abort
-- check, FOR UPDATE ordering, acquired_at rule, return shape, owner, ACL,
-- config. No row is written by this migration.
--
-- Proof: scripts/dev/probe-a-stale-lease-yields-only-to-an-open-transfers-successor-pg17.sh
-- runs every claim scenario against main's body (20260918053310, which strands
-- the successor), the live production body (20260927231300, which admits
-- non-transfer same-generation takeovers) and this body.
--
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure) = '5a9784b9e11d8a075acc02b786c09d60'
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $preimage$
DECLARE
  p pg_proc;
BEGIN
  SELECT * INTO p FROM pg_proc
   WHERE oid = to_regprocedure('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)');
  IF NOT FOUND
     OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM '14f4ed4a7659d42188f57da0a54af421'
     OR md5(p.prosrc) IS DISTINCT FROM 'e3397fe6782ed685d3aba81f547bb42c'
     OR pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres'
     OR NOT p.prosecdef
     OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'STALE_LEASE_SUCCESSOR_PREIMAGE_CHANGED public.claim_tournament_lease_v2';
  END IF;

  -- The lookup this body adds is answered by these exact keys.
  IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('smarter_private.f06_manager_custody_transfers')
          AND contype = 'u'
          AND pg_get_constraintdef(oid) = 'UNIQUE (tournament_id, successor_generation)'
          AND convalidated)
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('smarter_private.f06_manager_custody_completions')
          AND contype = 'p'
          AND pg_get_constraintdef(oid) = 'PRIMARY KEY (transfer_id)'
          AND convalidated) THEN
    RAISE EXCEPTION 'STALE_LEASE_SUCCESSOR_TRANSFER_KEYS_CHANGED';
  END IF;
END
$preimage$;

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
             /* Or the same generation asked for by a DIFFERENT instance, and
                only when that generation is the named successor of this
                event's OPEN mixed manager-custody transfer. The data fence
                is (tournament, generation), so a same-generation takeover
                shares the fence token with the stale holder; the durable
                successor is the one claimant that has no other generation to
                ask for. Every other claimant mints its own generation. */
          OR (
               l.instance_id IS DISTINCT FROM EXCLUDED.instance_id
           AND EXISTS (
                 SELECT 1
                   FROM smarter_private.f06_manager_custody_transfers tr
                  WHERE tr.tournament_id = p_tournament_id
                    AND tr.successor_generation = p_requested_generation
                    AND NOT EXISTS (
                          SELECT 1
                            FROM smarter_private.f06_manager_custody_completions c
                           WHERE c.transfer_id = tr.transfer_id))
             )
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

REVOKE ALL ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) TO service_role;

DO $postimage$
DECLARE
  p pg_proc;
BEGIN
  SELECT * INTO p FROM pg_proc
   WHERE oid = to_regprocedure('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)');
  IF NOT FOUND
     OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM 'ec62ed7afc218747201b8a5dcc8a8571'
     OR md5(p.prosrc) IS DISTINCT FROM '5a9784b9e11d8a075acc02b786c09d60'
     OR pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres'
     OR NOT p.prosecdef
     OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'STALE_LEASE_SUCCESSOR_POSTIMAGE_MISMATCH public.claim_tournament_lease_v2';
  END IF;
END
$postimage$;

COMMIT;
