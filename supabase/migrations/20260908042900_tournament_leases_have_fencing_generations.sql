/*
 * A tournament lease must fence an OLD owner, not merely name the CURRENT
 * process.  instance_id answers "who most recently claimed this row?" but it
 * cannot prove that a manager was created by the current claim generation.
 * A stalled manager could otherwise wake after takeover and finish an
 * incomplete launch with authority it no longer owns.
 *
 * The generation is an opaque UUID so it survives JSON/PostgREST without the
 * precision hazards of a JavaScript number.  Renewing the same ownership
 * generation preserves it; a stale-owner takeover always rotates it. A live
 * protocol-2 generation cannot be replaced merely because the delayed caller
 * shares its process instance id. Launch
 * begin/completion then hold and prove the exact lease row for the duration of
 * their transaction.  This is a transaction fence, not a repair sweep.
 */

BEGIN;

ALTER TABLE public.engine_tournament_leases
  ADD COLUMN IF NOT EXISTS lease_generation uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS protocol_version integer DEFAULT 1;

UPDATE public.engine_tournament_leases
   SET lease_generation = gen_random_uuid()
 WHERE lease_generation IS NULL;

UPDATE public.engine_tournament_leases
   SET protocol_version = 1
 WHERE protocol_version IS NULL;

ALTER TABLE public.engine_tournament_leases
  ALTER COLUMN lease_generation SET DEFAULT gen_random_uuid(),
  ALTER COLUMN lease_generation SET NOT NULL,
  ALTER COLUMN protocol_version SET DEFAULT 1,
  ALTER COLUMN protocol_version SET NOT NULL;

DO $add_tournament_lease_protocol_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'public.engine_tournament_leases'::regclass
       AND c.conname = 'engine_tournament_leases_protocol_version_check'
  ) THEN
    ALTER TABLE public.engine_tournament_leases
      ADD CONSTRAINT engine_tournament_leases_protocol_version_check
      CHECK (protocol_version IN (1, 2));
  END IF;
END;
$add_tournament_lease_protocol_check$;

/* The legacy app stays callable while the database lands first, but it may
   mutate only a protocol-1 lease. Once any v2 admission claims the row, an old
   same-process manager can neither renew nor release that new generation. */
CREATE OR REPLACE FUNCTION public.claim_tournament_lease(
  p_tournament_id uuid,
  p_instance_id text,
  p_version text DEFAULT NULL::text,
  p_stale_seconds integer DEFAULT 30
) RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_holder text;
  v_heartbeat timestamptz;
BEGIN
  IF p_tournament_id IS NULL OR length(btrim(COALESCE(p_instance_id, ''))) = 0 THEN
    RAISE EXCEPTION
      'claim_tournament_lease requires a tournament_id and a non-empty instance_id'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM 30 THEN
    RAISE EXCEPTION 'claim_tournament_lease requires the audited 30-second stale window'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.engine_tournament_leases AS l (
    tournament_id, instance_id, engine_version, acquired_at, heartbeat_at, protocol_version
  ) VALUES (
    p_tournament_id, p_instance_id, p_version, clock_timestamp(), clock_timestamp(), 1
  )
  ON CONFLICT (tournament_id) DO UPDATE
     SET instance_id = EXCLUDED.instance_id,
         engine_version = EXCLUDED.engine_version,
         acquired_at = CASE
           WHEN l.instance_id = EXCLUDED.instance_id THEN l.acquired_at
           ELSE clock_timestamp()
         END,
         heartbeat_at = clock_timestamp()
   WHERE l.protocol_version < 2
     AND (
       l.instance_id = EXCLUDED.instance_id
       OR l.heartbeat_at < clock_timestamp() - interval '30 seconds'
     )
  RETURNING l.instance_id, l.heartbeat_at INTO v_holder, v_heartbeat;

  IF v_holder IS NOT NULL THEN
    RETURN QUERY SELECT true, v_holder, 0::numeric;
    RETURN;
  END IF;

  SELECT l.instance_id, l.heartbeat_at
    INTO v_holder, v_heartbeat
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id;
  RETURN QUERY
    SELECT false,
           v_holder,
           round(extract(epoch FROM (clock_timestamp() - v_heartbeat))::numeric, 1);
END;
$function$;

/* Old heartbeat and release doors self-close for a row upgraded to v2. */
CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases_v2(
  p_instance_id text,
  p_tournament_ids uuid[],
  p_stale_seconds integer DEFAULT 30
) RETURNS TABLE(tournament_id uuid, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF length(btrim(COALESCE(p_instance_id, ''))) = 0 THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v2 requires a non-empty instance_id'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM 30 THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v2 requires the audited 30-second stale window'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH renewed AS (
    UPDATE public.engine_tournament_leases l
       SET heartbeat_at = clock_timestamp()
     WHERE l.protocol_version < 2
       AND l.instance_id = p_instance_id
       AND l.tournament_id = ANY(COALESCE(p_tournament_ids, '{}'::uuid[]))
    RETURNING l.tournament_id
  ),
  asked AS (
    SELECT unnest(COALESCE(p_tournament_ids, '{}'::uuid[])) AS id
  )
  SELECT a.id,
         CASE
           WHEN r.tournament_id IS NOT NULL THEN 'kept'
           WHEN l.tournament_id IS NULL THEN 'missing'
           WHEN l.protocol_version >= 2 THEN 'taken'
           WHEN l.heartbeat_at < clock_timestamp() - interval '30 seconds'
             THEN 'stale'
           ELSE 'taken'
         END
    FROM asked a
    LEFT JOIN renewed r ON r.tournament_id = a.id
    LEFT JOIN public.engine_tournament_leases l ON l.tournament_id = a.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases(
  p_instance_id text,
  p_tournament_ids uuid[]
) RETURNS TABLE(tournament_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  UPDATE public.engine_tournament_leases l
     SET heartbeat_at = clock_timestamp()
   WHERE l.protocol_version < 2
     AND l.instance_id = p_instance_id
     AND l.tournament_id = ANY(COALESCE(p_tournament_ids, '{}'::uuid[]))
  RETURNING l.tournament_id;
$function$;

CREATE OR REPLACE FUNCTION public.release_tournament_leases(
  p_instance_id text,
  p_tournament_ids uuid[] DEFAULT NULL::uuid[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.engine_tournament_leases l
   WHERE l.protocol_version < 2
     AND l.instance_id = p_instance_id
     AND (p_tournament_ids IS NULL OR l.tournament_id = ANY(p_tournament_ids));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

/* Rolling compatibility is an engine-only surface. PostgreSQL grants new
   functions to PUBLIC by default, so close every generation-blind door to
   browser roles while preserving old service-role pods until Stage B drops
   these overloads after the exact-generation engine is the sole live build. */
REVOKE ALL ON FUNCTION public.claim_tournament_lease(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease(uuid, text, text, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases_v2(text, uuid[], integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v2(text, uuid[], integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases(text, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases(text, uuid[])
  TO service_role;
REVOKE ALL ON FUNCTION public.release_tournament_leases(text, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_tournament_leases(text, uuid[])
  TO service_role;

/* A new admission chooses a UUID before its first RPC and reuses it across
   causal retries. A genuinely new admission supplies a new UUID, but may take
   authority only after the old exact generation was released or became stale.
   The same process id is not authority: delayed work from an older admission
   shares INSTANCE_ID with its successor. A same-instance protocol-1 row may be
   upgraded once during the rolling boundary. */
CREATE OR REPLACE FUNCTION public.claim_tournament_lease_v2(
  p_tournament_id uuid,
  p_instance_id text,
  p_version text DEFAULT NULL::text,
  p_requested_generation uuid DEFAULT NULL::uuid,
  p_stale_seconds integer DEFAULT 30
) RETURNS TABLE(
  granted boolean,
  holder text,
  holder_age_seconds numeric,
  lease_generation uuid,
  protocol_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
$function$;

REVOKE ALL ON FUNCTION public.claim_tournament_lease_v2(uuid, text, text, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(uuid, text, text, uuid, integer)
  TO service_role;

COMMENT ON FUNCTION public.claim_tournament_lease_v2(uuid, text, text, uuid, integer) IS
  'Claims one caller-selected tournament generation. Exact retry preserves it only while fresh; a distinct generation may replace a stale row, while same-instance protocol-1 rows may upgrade once. Upgrades the row to protocol 2 so legacy mutation doors self-close.';

/* A successful heartbeat response is now proof about (tournament,generation),
   not merely about an instance id.  Keep v2 during the rolling database/app
   boundary; the new engine calls v3 exclusively. */
CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases_v3(
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
    RAISE EXCEPTION 'heartbeat_tournament_leases_v3 requires a non-empty instance_id'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM 30 THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v3 requires the audited 30-second stale window'
      USING ERRCODE = '22023';
  END IF;
  IF p_claims IS NULL OR jsonb_typeof(p_claims) <> 'array' THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v3 requires a JSON array of claims'
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
      'heartbeat_tournament_leases_v3 requires tournament_id and lease_generation for every claim'
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
    RAISE EXCEPTION 'heartbeat_tournament_leases_v3 refuses duplicate tournaments'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH asked AS MATERIALIZED (
    SELECT (item ->> 'tournament_id')::uuid AS id,
           (item ->> 'lease_generation')::uuid AS requested_generation
      FROM jsonb_array_elements(p_claims) item
  ),
  renewed AS (
    UPDATE public.engine_tournament_leases l
       SET heartbeat_at = clock_timestamp()
      FROM asked a
     WHERE l.tournament_id = a.id
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
           ELSE 'taken'
         END,
         l.lease_generation
    FROM asked a
    LEFT JOIN renewed r ON r.tournament_id = a.id
    LEFT JOIN public.engine_tournament_leases l ON l.tournament_id = a.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases_v3(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v3(text, jsonb, integer)
  TO service_role;

COMMENT ON FUNCTION public.heartbeat_tournament_leases_v3(text, jsonb, integer) IS
  'Renews only exact, still-fresh tournament lease generations. kept proves the submitted generation; missing, stale, or taken means the manager is no longer fenced and must stop.';

CREATE OR REPLACE FUNCTION public.release_tournament_leases_v2(
  p_instance_id text,
  p_claims jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
$function$;

REVOKE ALL ON FUNCTION public.release_tournament_leases_v2(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_tournament_leases_v2(text, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.release_tournament_leases_v2(text, jsonb) IS
  'Releases only exact protocol-2 tournament generations. A stale same-instance manager cannot delete its successor lease.';

/* Bind every incomplete launch receipt to the manager generation that owns
   its next mutation.  Existing rows are backfilled before the stricter trigger
   is installed; a new owner may rotate only an INCOMPLETE receipt through the
   private begin wrapper below. */
DROP TRIGGER IF EXISTS tournament_launch_receipt_is_immutable
  ON public.tournament_launch_receipts;

ALTER TABLE public.tournament_launch_receipts
  ADD COLUMN IF NOT EXISTS lease_generation uuid;

UPDATE public.tournament_launch_receipts r
   SET lease_generation = l.lease_generation
  FROM public.engine_tournament_leases l
 WHERE r.tournament_id = l.tournament_id
   AND r.lease_generation IS NULL;

UPDATE public.tournament_launch_receipts
   SET lease_generation = gen_random_uuid()
 WHERE lease_generation IS NULL;

ALTER TABLE public.tournament_launch_receipts
  ALTER COLUMN lease_generation SET DEFAULT gen_random_uuid(),
  ALTER COLUMN lease_generation SET NOT NULL;

CREATE OR REPLACE FUNCTION public.trg_tournament_launch_receipt_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tournament launch receipts cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
     OR NEW.launch_id IS DISTINCT FROM OLD.launch_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
    RAISE EXCEPTION 'tournament launch receipt identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'completed tournament launch receipts are immutable'
      USING ERRCODE = '55000';
  END IF;

  /* Completion may set completed_at once, but cannot change its authority. */
  IF NEW.completed_at IS NOT NULL THEN
    IF NEW.lease_generation IS DISTINCT FROM OLD.lease_generation THEN
      RAISE EXCEPTION 'a tournament launch receipt generation cannot rotate during completion'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  /* Takeover adoption may rotate only the generation of an incomplete
     receipt, under the exact transaction-local marker set by begin. */
  IF NEW.lease_generation IS DISTINCT FROM OLD.lease_generation
     AND current_setting('app.atomic_tournament_launch_lease_adoption', true)
         = OLD.tournament_id::text || ':' || OLD.lease_generation::text || ':' || NEW.lease_generation::text THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'an incomplete tournament launch receipt may only rotate its lease generation during adoption'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER tournament_launch_receipt_is_immutable
  BEFORE UPDATE OR DELETE ON public.tournament_launch_receipts
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_launch_receipt_is_immutable();

REVOKE ALL ON FUNCTION public.trg_tournament_launch_receipt_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

/* Preserve the already-audited launch implementation as owner-only cores.
   The wrappers add the lease row as the FIRST mutable-row lock and hold it
   through the core's receipt/parent locks and commit. */
DO $rename_launch_cores_for_lease_fencing$
BEGIN
  IF to_regprocedure(
       'public.fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamptz)'
     ) IS NULL THEN
    IF to_regprocedure(
         'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz)'
       ) IS NULL THEN
      RAISE EXCEPTION 'three-argument tournament launch begin core is missing';
    END IF;
    ALTER FUNCTION public.fn_begin_tournament_launch_atomic(uuid, uuid, timestamptz)
      RENAME TO fn_begin_tournament_launch_before_lease_generation;
  ELSIF to_regprocedure(
          'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz)'
        ) IS NOT NULL THEN
    DROP FUNCTION public.fn_begin_tournament_launch_atomic(uuid, uuid, timestamptz);
  END IF;

  IF to_regprocedure(
       'public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'
     ) IS NULL THEN
    IF to_regprocedure(
         'public.fn_complete_tournament_launch_atomic(uuid,uuid)'
       ) IS NULL THEN
      RAISE EXCEPTION 'two-argument tournament launch completion core is missing';
    END IF;
    ALTER FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid)
      RENAME TO fn_complete_tournament_launch_before_lease_generation;
  ELSIF to_regprocedure(
          'public.fn_complete_tournament_launch_atomic(uuid,uuid)'
        ) IS NOT NULL THEN
    DROP FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid);
  END IF;
END;
$rename_launch_cores_for_lease_fencing$;

REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_before_lease_generation(
  uuid, uuid, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_before_lease_generation(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

/* Rolling-deploy compatibility. Old engines keep their original signatures,
   but only while the relevant lease row is still protocol 1. A v2 claim flips
   the row before any new manager is published, permanently refusing stale
   old launch continuations against that ownership generation. */
CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(
  p_tournament_id uuid,
  p_launch_id uuid,
  p_started_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_protocol_version integer;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  SELECT l.protocol_version INTO v_protocol_version
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR v_protocol_version >= 2 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'legacy_launch_protocol_closed');
  END IF;
  RETURN public.fn_begin_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id,
    p_started_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(
  p_tournament_id uuid,
  p_launch_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_protocol_version integer;
BEGIN
  SELECT l.protocol_version INTO v_protocol_version
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR v_protocol_version >= 2 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'legacy_launch_protocol_closed');
  END IF;
  RETURN public.fn_complete_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_atomic(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(uuid, uuid, timestamptz)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(
  p_tournament_id uuid,
  p_launch_id uuid,
  p_started_at timestamptz,
  p_lease_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_current_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_receipt_generation uuid;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT l.lease_generation, l.protocol_version, l.heartbeat_at
    INTO v_current_generation, v_protocol_version, v_heartbeat_at
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_current_generation IS DISTINCT FROM p_lease_generation
     OR v_heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  v_result := public.fn_begin_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id,
    p_started_at
  );

  IF COALESCE((v_result ->> 'ok')::boolean, false)
     AND NOT COALESCE((v_result ->> 'completed')::boolean, false) THEN
    SELECT r.lease_generation INTO STRICT v_receipt_generation
      FROM public.tournament_launch_receipts r
     WHERE r.tournament_id = p_tournament_id
     FOR UPDATE;
    IF v_receipt_generation IS DISTINCT FROM p_lease_generation THEN
      PERFORM set_config(
        'app.atomic_tournament_launch_lease_adoption',
        p_tournament_id::text || ':' || v_receipt_generation::text || ':' || p_lease_generation::text,
        true
      );
      UPDATE public.tournament_launch_receipts r
         SET lease_generation = p_lease_generation
       WHERE r.tournament_id = p_tournament_id
         AND r.completed_at IS NULL
         AND r.lease_generation = v_receipt_generation;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'tournament launch receipt changed during lease adoption'
          USING ERRCODE = '40001';
      END IF;
    END IF;
  END IF;

  RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(
  p_tournament_id uuid,
  p_launch_id uuid,
  p_lease_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_current_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_receipt_generation uuid;
  v_receipt_launch_id uuid;
  v_result jsonb;
BEGIN
  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT l.lease_generation, l.protocol_version, l.heartbeat_at
    INTO v_current_generation, v_protocol_version, v_heartbeat_at
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_current_generation IS DISTINCT FROM p_lease_generation
     OR v_heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  SELECT r.launch_id, r.lease_generation
    INTO v_receipt_launch_id, v_receipt_generation
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_receipt_launch_id IS DISTINCT FROM p_launch_id
     OR v_receipt_generation IS DISTINCT FROM p_lease_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_mismatch');
  END IF;

  v_result := public.fn_complete_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id
  );
  RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz, uuid
) TO service_role;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz, uuid
) IS
  'Begins/adopts a launch only while holding the exact current tournament lease generation. An incomplete receipt is rebound transactionally on takeover.';
COMMENT ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid, uuid) IS
  'Completes a launch only when the current lease and incomplete receipt both match the caller generation; the lease row remains locked through RUNNING commit.';

/* Catalog assertions: no unfenced public launch door, no direct role access to
   the cores, and no accidental invoker-mode authority. */
DO $assert_tournament_lease_generation_fence$
DECLARE
  v_claim_source text;
  v_legacy_claim_source text;
  v_legacy_heartbeat_source text;
  v_legacy_begin_source text;
  v_legacy_release_source text;
  v_heartbeat_source text;
  v_begin_source text;
  v_complete_source text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'engine_tournament_leases'
       AND c.column_name = 'lease_generation'
       AND c.data_type = 'uuid'
       AND c.is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'engine_tournament_leases.lease_generation is not a required uuid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'engine_tournament_leases'
       AND c.column_name = 'protocol_version'
       AND c.is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'engine_tournament_leases.protocol_version is not required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'public.engine_tournament_leases'::regclass
       AND c.conname = 'engine_tournament_leases_protocol_version_check'
       AND c.contype = 'c'
  ) THEN
    RAISE EXCEPTION 'engine_tournament_leases.protocol_version is not range constrained';
  END IF;

  SELECT p.prosrc INTO STRICT v_claim_source
    FROM pg_proc p
   WHERE p.oid = 'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure;
  SELECT p.prosrc INTO STRICT v_legacy_claim_source
    FROM pg_proc p
   WHERE p.oid = 'public.claim_tournament_lease(uuid,text,text,integer)'::regprocedure;
  SELECT p.prosrc INTO STRICT v_legacy_heartbeat_source
    FROM pg_proc p
   WHERE p.oid =
     'public.heartbeat_tournament_leases_v2(text,uuid[],integer)'::regprocedure;
  SELECT p.prosrc INTO STRICT v_legacy_release_source
    FROM pg_proc p
   WHERE p.oid = 'public.release_tournament_leases(text,uuid[])'::regprocedure;
  SELECT p.prosrc INTO STRICT v_heartbeat_source
    FROM pg_proc p
   WHERE p.oid = 'public.heartbeat_tournament_leases_v3(text,jsonb,integer)'::regprocedure;
  IF position('p_requested_generation' IN v_claim_source) = 0
     OR position('protocol_version = 2' IN v_claim_source) = 0
     OR position('l.lease_generation = EXCLUDED.lease_generation' IN v_claim_source) = 0
     OR position('l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation' IN v_claim_source) = 0
     OR position('l.protocol_version < 2' IN v_claim_source) = 0
     OR position('p_stale_seconds IS DISTINCT FROM 30' IN v_claim_source) = 0
     OR position('protocol_version < 2' IN v_legacy_claim_source) = 0
     OR position('p_stale_seconds IS DISTINCT FROM 30' IN v_legacy_claim_source) = 0
     OR position('p_stale_seconds IS DISTINCT FROM 30' IN v_legacy_heartbeat_source) = 0
     OR position('l.heartbeat_at >= clock_timestamp()' IN v_heartbeat_source) = 0
     OR position($needle$THEN 'stale'$needle$ IN v_heartbeat_source) = 0
     OR position('protocol_version < 2' IN v_legacy_release_source) = 0 THEN
    RAISE EXCEPTION 'tournament lease protocol compatibility fence is incomplete';
  END IF;

  SELECT p.prosrc INTO STRICT v_begin_source
    FROM pg_proc p
   WHERE p.oid = 'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz,uuid)'::regprocedure;
  SELECT p.prosrc INTO STRICT v_complete_source
    FROM pg_proc p
   WHERE p.oid = 'public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)'::regprocedure;
  SELECT p.prosrc INTO STRICT v_legacy_begin_source
    FROM pg_proc p
   WHERE p.oid = 'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz)'::regprocedure;
  IF position('FOR UPDATE' IN v_begin_source) = 0
     OR position('p_lease_generation' IN v_begin_source) = 0
     OR position('FOR UPDATE' IN v_complete_source) = 0
     OR position('p_lease_generation' IN v_complete_source) = 0
     OR position('v_heartbeat_at < clock_timestamp()' IN v_begin_source) = 0
     OR position('v_heartbeat_at < clock_timestamp()' IN v_complete_source) = 0
     OR position('v_protocol_version >= 2' IN v_legacy_begin_source) = 0 THEN
    RAISE EXCEPTION 'launch wrappers do not hold/prove the lease generation';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamptz)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'tournament launch generation function privileges are unsafe';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.heartbeat_tournament_leases_v3(text,jsonb,integer)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.release_tournament_leases_v2(text,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz,uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'service_role is missing a fenced tournament authority door';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid IN (
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'public.heartbeat_tournament_leases_v3(text,jsonb,integer)'::regprocedure,
       'public.release_tournament_leases_v2(text,jsonb)'::regprocedure,
       'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz,uuid)'::regprocedure,
       'public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)'::regprocedure
     )
       AND NOT p.prosecdef
  ) THEN
    RAISE EXCEPTION 'a tournament generation authority function is not SECURITY DEFINER';
  END IF;
END;
$assert_tournament_lease_generation_fence$;

COMMIT;
