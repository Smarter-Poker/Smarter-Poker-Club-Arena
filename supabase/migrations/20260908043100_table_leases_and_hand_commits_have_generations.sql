/*
 * A process id says which boot most recently touched a table lease.  It does
 * not say which admission inside that boot still owns the dealer.  A delayed
 * TableEngine can therefore resume after a newer admission and commit a hand
 * through the same service-role settlement door.
 *
 * Table leases now have the same opaque UUID generation vocabulary as
 * tournament leases.  A v2 claim upgrades one row to protocol 2, exact claim
 * retries preserve that generation, and no live row can be rotated by a
 * different requested UUID -- even from the same instance.  Only a stale row
 * or a same-instance protocol-1 rolling-upgrade row can adopt a new UUID.
 * Heartbeat and release operate on exact (table, instance, generation)
 * claims.  The legacy lease signatures stay present for a DB-first rollout,
 * but cannot mutate a row once v2 has claimed it.
 *
 * Hand settlement is fenced in the database too.  The public nine-argument
 * implementation becomes an owner-private core.  Its compatibility wrapper
 * runs only behind a protocol-1 lease.  The eleven-argument overload first
 * reads table scope without locking solely to choose the relevant lease,
 * locks and proves that exact table or tournament lease, then locks/re-reads
 * the table and refuses a scope change before invoking the unchanged core.
 * Holding the lease row through the core preserves its atomic receipt/replay
 * semantics while making takeover and settlement mutually exclusive.
 */

BEGIN;

DO $assert_hand_fence_prerequisites$
BEGIN
  IF to_regclass('public.engine_table_leases') IS NULL
     OR to_regclass('public.engine_tournament_leases') IS NULL
     OR to_regclass('public.tables') IS NULL THEN
    RAISE EXCEPTION 'table/tournament lease and tables prerequisites are missing';
  END IF;
  IF NOT EXISTS (
       SELECT 1
         FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'engine_tournament_leases'
          AND c.column_name = 'lease_generation'
          AND c.data_type = 'uuid'
          AND c.is_nullable = 'NO'
     )
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
      '20260908043100 requires the tournament lease generation migration first';
  END IF;
END;
$assert_hand_fence_prerequisites$;

ALTER TABLE public.engine_table_leases
  ADD COLUMN IF NOT EXISTS lease_generation uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS protocol_version integer DEFAULT 1;

UPDATE public.engine_table_leases
   SET lease_generation = gen_random_uuid()
 WHERE lease_generation IS NULL;

UPDATE public.engine_table_leases
   SET protocol_version = 1
 WHERE protocol_version IS NULL;

ALTER TABLE public.engine_table_leases
  ALTER COLUMN lease_generation SET DEFAULT gen_random_uuid(),
  ALTER COLUMN lease_generation SET NOT NULL,
  ALTER COLUMN protocol_version SET DEFAULT 1,
  ALTER COLUMN protocol_version SET NOT NULL;

DO $add_table_lease_protocol_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'public.engine_table_leases'::regclass
       AND c.conname = 'engine_table_leases_protocol_version_check'
  ) THEN
    ALTER TABLE public.engine_table_leases
      ADD CONSTRAINT engine_table_leases_protocol_version_check
      CHECK (protocol_version IN (1, 2));
  END IF;
END;
$add_table_lease_protocol_check$;

/* One audited duration governs v2 takeover admission and the last-moment
   settlement proof.  Keeping the value owner-private prevents callers from
   weakening authority by choosing a shorter freshness window. */
CREATE OR REPLACE FUNCTION public.fn_engine_lease_stale_seconds()
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $function$
  SELECT 30;
$function$;

REVOKE ALL ON FUNCTION public.fn_engine_lease_stale_seconds()
  FROM PUBLIC, anon, authenticated, service_role;

/* Legacy table-lease doors remain callable while old pods drain.  They can
   create/renew/release only protocol-1 authority and can never overwrite a
   v2 generation. */
CREATE OR REPLACE FUNCTION public.claim_table_lease(
  p_table_id uuid,
  p_instance_id text,
  p_version text DEFAULT NULL::text,
  p_stale_seconds integer DEFAULT 30
) RETURNS TABLE(
  granted boolean,
  holder text,
  holder_age_seconds numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_holder text;
  v_heartbeat timestamptz;
BEGIN
  IF p_table_id IS NULL OR length(btrim(COALESCE(p_instance_id, ''))) = 0 THEN
    RAISE EXCEPTION 'claim_table_lease requires a table_id and a non-empty instance_id'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds() THEN
    RAISE EXCEPTION 'claim_table_lease requires the audited 30 second stale window'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.engine_table_leases AS l (
    table_id,
    instance_id,
    engine_version,
    acquired_at,
    heartbeat_at,
    protocol_version
  ) VALUES (
    p_table_id,
    p_instance_id,
    p_version,
    clock_timestamp(),
    clock_timestamp(),
    1
  )
  ON CONFLICT (table_id) DO UPDATE
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
       OR l.heartbeat_at < clock_timestamp() - make_interval(
         secs => public.fn_engine_lease_stale_seconds()
       )
     )
  RETURNING l.instance_id, l.heartbeat_at INTO v_holder, v_heartbeat;

  IF v_holder IS NOT NULL THEN
    RETURN QUERY SELECT true, v_holder, 0::numeric;
    RETURN;
  END IF;

  SELECT l.instance_id, l.heartbeat_at
    INTO v_holder, v_heartbeat
    FROM public.engine_table_leases l
   WHERE l.table_id = p_table_id;

  RETURN QUERY
    SELECT false,
           v_holder,
           round(extract(epoch FROM (clock_timestamp() - v_heartbeat))::numeric, 1);
END;
$function$;

CREATE OR REPLACE FUNCTION public.heartbeat_table_leases(
  p_instance_id text,
  p_table_ids uuid[]
) RETURNS TABLE(table_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  UPDATE public.engine_table_leases l
     SET heartbeat_at = clock_timestamp()
   WHERE l.protocol_version < 2
     AND l.instance_id = p_instance_id
     AND l.table_id = ANY(COALESCE(p_table_ids, '{}'::uuid[]))
  RETURNING l.table_id;
$function$;

CREATE OR REPLACE FUNCTION public.heartbeat_table_leases_v2(
  p_instance_id text,
  p_table_ids uuid[],
  p_stale_seconds integer DEFAULT 30
) RETURNS TABLE(table_id uuid, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF length(btrim(COALESCE(p_instance_id, ''))) = 0 THEN
    RAISE EXCEPTION 'heartbeat_table_leases_v2 requires a non-empty instance_id'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds() THEN
    RAISE EXCEPTION 'heartbeat_table_leases_v2 requires the audited 30 second stale window'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH renewed AS (
    UPDATE public.engine_table_leases l
       SET heartbeat_at = clock_timestamp()
     WHERE l.protocol_version < 2
       AND l.instance_id = p_instance_id
       AND l.table_id = ANY(COALESCE(p_table_ids, '{}'::uuid[]))
    RETURNING l.table_id
  ),
  asked AS (
    SELECT unnest(COALESCE(p_table_ids, '{}'::uuid[])) AS id
  )
  SELECT a.id,
         CASE
           WHEN r.table_id IS NOT NULL THEN 'kept'
           WHEN l.table_id IS NULL THEN 'missing'
           WHEN l.protocol_version >= 2 THEN 'taken'
           WHEN l.heartbeat_at < clock_timestamp() - make_interval(
             secs => public.fn_engine_lease_stale_seconds()
           )
             THEN 'stale'
           ELSE 'taken'
         END
    FROM asked a
    LEFT JOIN renewed r ON r.table_id = a.id
    LEFT JOIN public.engine_table_leases l ON l.table_id = a.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_table_leases(
  p_instance_id text,
  p_table_ids uuid[] DEFAULT NULL::uuid[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.engine_table_leases l
   WHERE l.protocol_version < 2
     AND l.instance_id = p_instance_id
     AND (p_table_ids IS NULL OR l.table_id = ANY(p_table_ids));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

/* These generation-blind overloads exist only for a DB-first rolling deploy.
   Explicitly remove PostgreSQL's default PUBLIC EXECUTE while the old engine
   still needs service-role access. Stage B drops all four after the
   exact-generation engine is the sole live build. */
REVOKE ALL ON FUNCTION public.claim_table_lease(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_table_lease(uuid, text, text, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.heartbeat_table_leases(text, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_table_leases(text, uuid[])
  TO service_role;
REVOKE ALL ON FUNCTION public.heartbeat_table_leases_v2(text, uuid[], integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_table_leases_v2(text, uuid[], integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.release_table_leases(text, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_table_leases(text, uuid[])
  TO service_role;

/* The caller chooses one UUID before admission and retains it across causal
   retries.  UUIDs have no ordering, so a live protocol-2 row accepts only the
   exact current UUID.  Allowing an arbitrary same-instance rotation would let
   a delayed retry of the old admission rotate authority backwards. */
CREATE OR REPLACE FUNCTION public.claim_table_lease_v2(
  p_table_id uuid,
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
$function$;

REVOKE ALL ON FUNCTION public.claim_table_lease_v2(uuid, text, text, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_table_lease_v2(uuid, text, text, uuid, integer)
  TO service_role;

COMMENT ON FUNCTION public.claim_table_lease_v2(uuid, text, text, uuid, integer) IS
  'Claims one caller-selected table generation. Exact retry is stable only while fresh; a different live protocol-2 generation is refused even for the same instance; a stale row requires a different generation.';

CREATE OR REPLACE FUNCTION public.heartbeat_table_leases_v3(
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
    RAISE EXCEPTION 'heartbeat_table_leases_v3 requires a non-empty instance_id'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds() THEN
    RAISE EXCEPTION 'heartbeat_table_leases_v3 requires the audited 30 second stale window'
      USING ERRCODE = '22023';
  END IF;
  IF p_claims IS NULL OR jsonb_typeof(p_claims) <> 'array' THEN
    RAISE EXCEPTION 'heartbeat_table_leases_v3 requires a JSON array of claims'
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
      'heartbeat_table_leases_v3 requires table_id and lease_generation for every claim'
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
    RAISE EXCEPTION 'heartbeat_table_leases_v3 refuses duplicate tables'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH asked AS MATERIALIZED (
    SELECT (item ->> 'table_id')::uuid AS id,
           (item ->> 'lease_generation')::uuid AS requested_generation
      FROM jsonb_array_elements(p_claims) item
  ),
  renewed AS (
    UPDATE public.engine_table_leases l
       SET heartbeat_at = clock_timestamp()
      FROM asked a
     WHERE l.table_id = a.id
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
           ELSE 'taken'
         END,
         l.lease_generation
    FROM asked a
    LEFT JOIN renewed r ON r.table_id = a.id
    LEFT JOIN public.engine_table_leases l ON l.table_id = a.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.heartbeat_table_leases_v3(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_table_leases_v3(text, jsonb, integer)
  TO service_role;

COMMENT ON FUNCTION public.heartbeat_table_leases_v3(text, jsonb, integer) IS
  'Renews only exact, still-fresh protocol-2 table generations. kept proves the submitted generation; missing, stale, or taken means that dealer must stop.';

CREATE OR REPLACE FUNCTION public.release_table_leases_v2(
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
$function$;

REVOKE ALL ON FUNCTION public.release_table_leases_v2(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_table_leases_v2(text, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.release_table_leases_v2(text, jsonb) IS
  'Releases only exact protocol-2 table generations. A stale same-instance dealer cannot delete its successor lease.';

/* Keep the already-audited nine-argument settlement implementation byte-for-
   byte under an owner-only name.  Re-application sees the private core and
   simply replaces the two public wrappers. */
DO $rename_hand_settlement_core_for_lease_fencing$
BEGIN
  IF to_regprocedure(
       'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
     ) IS NULL THEN
    IF to_regprocedure(
         'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
       ) IS NULL THEN
      RAISE EXCEPTION 'nine-argument atomic hand settlement core is missing';
    END IF;
    ALTER FUNCTION public.fn_ca_commit_hand_settlement(
      uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb
    ) RENAME TO fn_ca_commit_hand_settlement_before_lease_generation;
  END IF;
END;
$rename_hand_settlement_core_for_lease_fencing$;

REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

/* Rolling compatibility: an old engine has no generation argument.  It may
   keep committing only while the relevant lease remains protocol 1.  Scope is
   read once without a row lock solely to choose the lease; the lease is then
   locked before the table row and the scope is re-proved. */
CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(
  p_table_id uuid,
  p_hand_number bigint,
  p_stacks jsonb,
  p_rake numeric,
  p_bbj numeric,
  p_ref text,
  p_inflow numeric,
  p_hand_row jsonb,
  p_units jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tournament_id uuid;
  v_locked_tournament_id uuid;
  v_protocol_version integer;
BEGIN
  SELECT t.tournament_id INTO v_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'table_not_found');
  END IF;

  IF v_tournament_id IS NULL THEN
    SELECT l.protocol_version INTO v_protocol_version
      FROM public.engine_table_leases l
     WHERE l.table_id = p_table_id
     FOR SHARE;
  ELSE
    SELECT l.protocol_version INTO v_protocol_version
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
     FOR SHARE;
  END IF;

  IF NOT FOUND OR v_protocol_version >= 2 THEN
    RETURN jsonb_build_object(
      'success', false,
      'atomic_hand_commit', false,
      'reason', 'legacy_hand_protocol_closed'
    );
  END IF;

  /* The core takes tournament -> player -> seat.  Join that order before the
     tables-row scope proof so a lifecycle writer that already owns the parent
     and needs this table cannot deadlock with settlement in table -> parent
     order.  Distinct table settlements share this parent lock. */
  IF v_tournament_id IS NOT NULL THEN
    PERFORM 1
      FROM public.tournaments t
     WHERE t.id = v_tournament_id
     FOR SHARE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'reason', 'tournament_not_found');
    END IF;
  END IF;

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
$function$;

/* Generation-aware settlement.  Tournament table engines submit their
   tournament-manager generation; cash table engines submit their table lease
   generation.  The locked tables row, never a caller-supplied scope flag,
   decides which authority is valid. */
CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(
  p_table_id uuid,
  p_hand_number bigint,
  p_stacks jsonb,
  p_rake numeric,
  p_bbj numeric,
  p_ref text,
  p_inflow numeric,
  p_hand_row jsonb,
  p_units jsonb,
  p_instance_id text,
  p_lease_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
     FOR SHARE;
    v_lease_found := FOUND;
  ELSE
    v_scope := 'tournament';
    SELECT l.instance_id, l.lease_generation, l.protocol_version, l.heartbeat_at
      INTO v_holder, v_generation, v_protocol_version, v_heartbeat_at
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
     FOR SHARE;
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
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
) TO service_role;

COMMENT ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb
) IS
  'DB-first compatibility hand settlement. It self-closes as soon as the relevant table or tournament lease reaches protocol 2.';

COMMENT ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
) IS
  'Commits one hand only while holding the exact protocol-2 table generation for cash or tournament generation for a tournament table, then delegates to the unchanged atomic core.';

DO $assert_table_lease_and_hand_generation_fence$
DECLARE
  v_claim_source text;
  v_legacy_claim_source text;
  v_legacy_heartbeat_source text;
  v_legacy_release_source text;
  v_heartbeat_source text;
  v_release_source text;
  v_legacy_hand_source text;
  v_exact_hand_source text;
  v_table_lease_at integer;
  v_tournament_lease_at integer;
  v_parent_at integer;
  v_locked_table_at integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'engine_table_leases'
       AND c.column_name = 'lease_generation'
       AND c.data_type = 'uuid'
       AND c.is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'engine_table_leases'
       AND c.column_name = 'protocol_version'
       AND c.data_type = 'integer'
       AND c.is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'engine_table_leases generation columns are not required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'public.engine_table_leases'::regclass
       AND c.conname = 'engine_table_leases_protocol_version_check'
       AND pg_get_constraintdef(c.oid) LIKE '%protocol_version%ANY%1%2%'
  ) OR public.fn_engine_lease_stale_seconds() <> 30 THEN
    RAISE EXCEPTION 'table lease protocol domain or audited stale window is missing';
  END IF;

  SELECT p.prosrc INTO STRICT v_claim_source
    FROM pg_proc p
   WHERE p.oid = 'public.claim_table_lease_v2(uuid,text,text,uuid,integer)'::regprocedure;
  SELECT p.prosrc INTO STRICT v_legacy_claim_source
    FROM pg_proc p
   WHERE p.oid = 'public.claim_table_lease(uuid,text,text,integer)'::regprocedure;
  SELECT p.prosrc INTO STRICT v_legacy_heartbeat_source
    FROM pg_proc p
   WHERE p.oid = 'public.heartbeat_table_leases_v2(text,uuid[],integer)'::regprocedure;
  SELECT p.prosrc INTO STRICT v_legacy_release_source
    FROM pg_proc p
   WHERE p.oid = 'public.release_table_leases(text,uuid[])'::regprocedure;

  IF position('p_requested_generation' IN v_claim_source) = 0
     OR position('l.protocol_version = 2' IN v_claim_source) = 0
     OR position('l.lease_generation = EXCLUDED.lease_generation' IN v_claim_source) = 0
     OR position('l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation' IN v_claim_source) = 0
     OR position('l.protocol_version < 2' IN v_claim_source) = 0
     OR position('fn_engine_lease_stale_seconds()' IN v_claim_source) = 0
     OR position('protocol_version < 2' IN v_legacy_claim_source) = 0
     OR position('fn_engine_lease_stale_seconds()' IN v_legacy_claim_source) = 0
     OR position('protocol_version < 2' IN v_legacy_heartbeat_source) = 0
     OR position('fn_engine_lease_stale_seconds()' IN v_legacy_heartbeat_source) = 0
     OR position('protocol_version < 2' IN v_legacy_release_source) = 0 THEN
    RAISE EXCEPTION 'table lease claim or rolling protocol fence is incomplete';
  END IF;

  SELECT p.prosrc INTO STRICT v_heartbeat_source
    FROM pg_proc p
   WHERE p.oid = 'public.heartbeat_table_leases_v3(text,jsonb,integer)'::regprocedure;
  SELECT p.prosrc INTO STRICT v_release_source
    FROM pg_proc p
   WHERE p.oid = 'public.release_table_leases_v2(text,jsonb)'::regprocedure;
  IF position('l.instance_id = p_instance_id' IN v_heartbeat_source) = 0
     OR position('l.protocol_version = 2' IN v_heartbeat_source) = 0
     OR position('l.lease_generation = a.requested_generation' IN v_heartbeat_source) = 0
     OR position('l.heartbeat_at >= clock_timestamp()' IN v_heartbeat_source) = 0
     OR position($needle$THEN 'stale'$needle$ IN v_heartbeat_source) = 0
     OR position('refuses duplicate tables' IN v_heartbeat_source) = 0
     OR position('l.instance_id = p_instance_id' IN v_release_source) = 0
     OR position('l.protocol_version = 2' IN v_release_source) = 0
     OR position('l.lease_generation = a.lease_generation' IN v_release_source) = 0
     OR position('refuses duplicate tables' IN v_release_source) = 0 THEN
    RAISE EXCEPTION 'exact table heartbeat/release lost generation or input proof';
  END IF;

  SELECT p.prosrc INTO STRICT v_legacy_hand_source
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure;
  SELECT p.prosrc INTO STRICT v_exact_hand_source
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure;

  v_tournament_lease_at := position(
    'FROM public.engine_tournament_leases l' IN v_legacy_hand_source
  );
  v_parent_at := position(
    'FROM public.tournaments t
     WHERE t.id = v_tournament_id
     FOR SHARE' IN v_legacy_hand_source
  );
  v_locked_table_at := position(
    'FROM public.tables t
   WHERE t.id = p_table_id
   FOR UPDATE' IN v_legacy_hand_source
  );

  IF position('FROM public.engine_table_leases l' IN v_legacy_hand_source) = 0
     OR v_tournament_lease_at = 0
     OR position('v_protocol_version >= 2' IN v_legacy_hand_source) = 0
     OR position('WHERE l.table_id = p_table_id
     FOR SHARE' IN v_legacy_hand_source) = 0
     OR position('WHERE l.tournament_id = v_tournament_id
     FOR SHARE' IN v_legacy_hand_source) = 0
     OR v_parent_at <= v_tournament_lease_at
     OR v_locked_table_at <= v_parent_at THEN
    RAISE EXCEPTION 'legacy atomic hand door does not self-close on protocol 2';
  END IF;

  v_table_lease_at := position('FROM public.engine_table_leases l' IN v_exact_hand_source);
  v_tournament_lease_at := position(
    'FROM public.engine_tournament_leases l' IN v_exact_hand_source
  );
  v_locked_table_at := position(
    'FROM public.tables t
   WHERE t.id = p_table_id
   FOR UPDATE' IN v_exact_hand_source
  );
  v_parent_at := position(
    'FROM public.tournaments t
     WHERE t.id = v_tournament_id
     FOR SHARE' IN v_exact_hand_source
  );
  IF v_table_lease_at = 0
     OR v_tournament_lease_at = 0
     OR v_parent_at <= v_tournament_lease_at
     OR v_locked_table_at <= v_parent_at
     OR v_locked_table_at <= v_table_lease_at
     OR v_locked_table_at <= v_tournament_lease_at
     OR position('v_holder IS DISTINCT FROM p_instance_id' IN v_exact_hand_source) = 0
     OR position('v_generation IS DISTINCT FROM p_lease_generation' IN v_exact_hand_source) = 0
     OR position('v_protocol_version IS DISTINCT FROM 2' IN v_exact_hand_source) = 0
     OR position('WHERE l.table_id = p_table_id
     FOR SHARE' IN v_exact_hand_source) = 0
     OR position('WHERE l.tournament_id = v_tournament_id
     FOR SHARE' IN v_exact_hand_source) = 0
     OR position('v_heartbeat_at < clock_timestamp()' IN v_exact_hand_source) = 0
     OR position('fn_engine_lease_stale_seconds()' IN v_exact_hand_source) = 0
     OR position('hand_lease_stale' IN v_exact_hand_source) = 0
     OR position('hand_lease_scope_changed' IN v_exact_hand_source) = 0 THEN
    RAISE EXCEPTION 'atomic hand wrapper lost exact lease -> locked table order/proof';
  END IF;

  IF has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'atomic hand core/wrapper privileges are unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid IN (
       'public.claim_table_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'public.heartbeat_table_leases_v3(text,jsonb,integer)'::regprocedure,
       'public.release_table_leases_v2(text,jsonb)'::regprocedure,
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure,
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure
     )
       AND NOT p.prosecdef
  ) THEN
    RAISE EXCEPTION 'a table lease or hand fence is not SECURITY DEFINER';
  END IF;
END;
$assert_table_lease_and_hand_generation_fence$;

COMMIT;
