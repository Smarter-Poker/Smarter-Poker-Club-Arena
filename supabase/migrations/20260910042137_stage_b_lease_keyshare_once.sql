-- 20260910042137_stage_b_lease_keyshare_once
/*
 * A live hand must not make its own lease heartbeat look lost.
 *
 * The final/current-postimage Stage-B authority leaves exactly four lease
 * fences: exact hand settlement, unbound add-on resolution, empty-table
 * close, and the private manager request hook.  Those transactions keep an
 * exact lease row locked until commit.  FOR SHARE protects the generation,
 * but it conflicts with the heartbeat's FOR NO KEY UPDATE row lock.  Busy
 * tournament tables can therefore deny every heartbeat for a full proof
 * window and make a healthy manager fence and destroy its child engines.
 *
 * This forward-only, stopped-engine cutover carries the proven key-share
 * repair from the retired historical chain onto that final postimage. The two
 * redundant ownership constraints are deliberate.  PostgreSQL treats every
 * column belonging to a non-partial unique key as a key column.  Once
 * instance_id and lease_generation are key columns, FOR KEY SHARE has the
 * exact contract required here:
 *
 *   - UPDATE heartbeat_at (FOR NO KEY UPDATE) remains compatible;
 *   - changing instance_id or lease_generation requires FOR UPDATE and waits;
 *   - DELETE/release requires FOR UPDATE and waits.
 *
 * NOWAIT makes an unexpected live writer a refusal, never a partially
 * weakened authority boundary. A complete prior postimage is verified as an
 * exact no-op; a pristine preimage is applied once; every mixed or drifted
 * state aborts atomically before an unknown fence can be weakened.
 */
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $require_strict_stage_b_topology$
BEGIN
  IF to_regprocedure(
       'public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)'
     ) IS NOT NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
        ) IS NOT NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
        ) IS NOT NULL
     OR to_regclass(
          'public.tournament_mutator_scheduler_retirement_receipts'
        ) IS NULL
     OR (
       SELECT count(*)
         FROM public.tournament_mutator_scheduler_retirement_receipts receipt
        WHERE receipt.migration_version =
          '20260910042112_stage_b_current_postimage_contraction'
     ) <> 1 THEN
    RAISE EXCEPTION
      'LEASE_KEYSHARE_REQUIRES_STRICT_STAGE_B: generation-blind lease fences are still callable';
  END IF;
END;
$require_strict_stage_b_topology$;

LOCK TABLE public.engine_table_leases IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.engine_tournament_leases IN ACCESS EXCLUSIVE MODE NOWAIT;

CREATE TEMP TABLE pg_temp.lease_keyshare_cutover_mode (
  mode text PRIMARY KEY CHECK (mode IN ('apply', 'verify'))
) ON COMMIT DROP;

DO $classify_lease_keyshare_preimage$
DECLARE
  v_table_key_count integer;
  v_tournament_key_count integer;
BEGIN
  SELECT count(*)::integer INTO v_table_key_count
    FROM pg_constraint con
   WHERE con.conrelid = 'public.engine_table_leases'::regclass
     AND con.conname = 'engine_table_leases_owner_generation_key';
  SELECT count(*)::integer INTO v_tournament_key_count
    FROM pg_constraint con
   WHERE con.conrelid = 'public.engine_tournament_leases'::regclass
     AND con.conname = 'engine_tournament_leases_owner_generation_key';

  IF v_table_key_count = 0 AND v_tournament_key_count = 0 THEN
    INSERT INTO pg_temp.lease_keyshare_cutover_mode(mode) VALUES ('apply');
  ELSIF v_table_key_count = 1 AND v_tournament_key_count = 1 THEN
    INSERT INTO pg_temp.lease_keyshare_cutover_mode(mode) VALUES ('verify');
  ELSE
    RAISE EXCEPTION
      'LEASE_KEYSHARE_MIXED_PREIMAGE: table key %, tournament key %',
      v_table_key_count,
      v_tournament_key_count;
  END IF;
END;
$classify_lease_keyshare_preimage$;

DO $install_lease_ownership_keys_once$
BEGIN
  IF (SELECT mode FROM pg_temp.lease_keyshare_cutover_mode) = 'apply' THEN
    ALTER TABLE public.engine_table_leases
      ADD CONSTRAINT engine_table_leases_owner_generation_key
      UNIQUE (table_id, instance_id, lease_generation);

    ALTER TABLE public.engine_tournament_leases
      ADD CONSTRAINT engine_tournament_leases_owner_generation_key
      UNIQUE (tournament_id, instance_id, lease_generation);
  END IF;
END;
$install_lease_ownership_keys_once$;

DO $verify_ownership_keys$
DECLARE
  v_relation regclass;
  v_constraint_name text;
  v_expected_columns name[];
  v_ok boolean;
BEGIN
  FOR v_relation, v_constraint_name, v_expected_columns IN
    SELECT 'public.engine_table_leases'::regclass,
           'engine_table_leases_owner_generation_key'::text,
           ARRAY['table_id', 'instance_id', 'lease_generation']::name[]
    UNION ALL
    SELECT 'public.engine_tournament_leases'::regclass,
           'engine_tournament_leases_owner_generation_key'::text,
           ARRAY['tournament_id', 'instance_id', 'lease_generation']::name[]
  LOOP
    SELECT con.contype = 'u'
           AND con.convalidated
           AND NOT con.condeferrable
           AND idx.indisunique
           AND idx.indisvalid
           AND idx.indisready
           AND idx.indimmediate
           AND idx.indpred IS NULL
           AND idx.indexprs IS NULL
           AND idx.indnkeyatts = 3
           AND idx.indnatts = 3
           AND (
             SELECT array_agg(att.attname ORDER BY key_column.ordinality)
               FROM unnest(con.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
               JOIN pg_attribute att
                 ON att.attrelid = con.conrelid
                AND att.attnum = key_column.attnum
           ) = v_expected_columns
      INTO v_ok
      FROM pg_constraint con
      JOIN pg_index idx ON idx.indexrelid = con.conindid
     WHERE con.conrelid = v_relation
       AND con.conname = v_constraint_name;

    IF NOT COALESCE(v_ok, false) THEN
      RAISE EXCEPTION
        'LEASE_OWNERSHIP_KEY_INVALID: % on % is not the exact ready non-partial unique key',
        v_constraint_name,
        v_relation;
    END IF;
  END LOOP;
END;
$verify_ownership_keys$;

DO $refuse_heartbeat_key_columns$
DECLARE
  v_relation regclass;
  v_index regclass;
BEGIN
  SELECT idx.indrelid::regclass,
         idx.indexrelid::regclass
    INTO v_relation, v_index
    FROM pg_index idx
    JOIN LATERAL unnest(idx.indkey)
      WITH ORDINALITY AS key_column(attnum, ordinality)
      ON key_column.ordinality <= idx.indnkeyatts
    JOIN pg_attribute att
      ON att.attrelid = idx.indrelid
     AND att.attnum = key_column.attnum
   WHERE idx.indrelid IN (
           'public.engine_table_leases'::regclass,
           'public.engine_tournament_leases'::regclass
         )
     AND idx.indisunique
     AND idx.indisvalid
     AND idx.indisready
     AND idx.indimmediate
     AND idx.indpred IS NULL
     AND idx.indexprs IS NULL
     AND att.attname = 'heartbeat_at'
   ORDER BY idx.indrelid, idx.indexrelid
   LIMIT 1;

  IF v_index IS NOT NULL THEN
    RAISE EXCEPTION
      'LEASE_HEARTBEAT_KEY_COLUMN_INVALID: heartbeat_at is an ownership key in % on %',
      v_index,
      v_relation;
  END IF;
END;
$refuse_heartbeat_key_columns$;

CREATE TEMP TABLE pg_temp.lease_fence_metadata_before
ON COMMIT DROP
AS
SELECT p.oid AS function_oid,
       p.oid::regprocedure::text AS function_identity,
       p.proowner,
       p.proacl,
       p.prosecdef,
       p.proconfig
  FROM pg_proc p
 WHERE p.oid = ANY(ARRAY[
   'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure::oid,
   'public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)'::regprocedure::oid,
   'public.fn_close_empty_tournament_table(uuid,uuid,uuid)'::regprocedure::oid,
   'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure::oid
 ]);

DO $patch_effective_lease_fences$
DECLARE
  v_oid regprocedure;
  v_source text;
  v_before text;
  v_after text;
  v_count integer;
BEGIN
  IF (SELECT mode FROM pg_temp.lease_keyshare_cutover_mode) = 'verify' THEN
    RETURN;
  END IF;

  /* Current hand settlement: change only the two lease rows.  Its separate
     tournament-parent FOR SHARE remains untouched. */
  v_oid := to_regprocedure(
    'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
  );
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'LEASE_FENCE_FUNCTION_MISSING: exact hand settlement';
  END IF;
  v_source := pg_get_functiondef(v_oid);

  v_before := E'FROM public.engine_table_leases l\n     WHERE l.table_id = p_table_id\n     FOR SHARE;';
  v_after := E'FROM public.engine_table_leases l\n     WHERE l.table_id = p_table_id\n     FOR KEY SHARE;';
  v_count := (length(v_source) - length(replace(v_source, v_before, ''))) / length(v_before);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'LEASE_FENCE_SOURCE_DRIFT: exact hand table fence matched % times', v_count;
  END IF;
  v_source := replace(v_source, v_before, v_after);

  v_before := E'FROM public.engine_tournament_leases l\n     WHERE l.tournament_id = v_tournament_id\n     FOR SHARE;';
  v_after := E'FROM public.engine_tournament_leases l\n     WHERE l.tournament_id = v_tournament_id\n     FOR KEY SHARE;';
  v_count := (length(v_source) - length(replace(v_source, v_before, ''))) / length(v_before);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'LEASE_FENCE_SOURCE_DRIFT: exact hand tournament fence matched % times', v_count;
  END IF;
  EXECUTE replace(v_source, v_before, v_after);

  /* Idle cash add-on resolution holds the same exact table generation. */
  v_oid := to_regprocedure(
    'public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)'
  );
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'LEASE_FENCE_FUNCTION_MISSING: pending add-on resolver';
  END IF;
  v_source := pg_get_functiondef(v_oid);
  v_before := E'FROM public.engine_table_leases l\n   WHERE l.table_id = p_table_id\n   FOR SHARE;';
  v_after := E'FROM public.engine_table_leases l\n   WHERE l.table_id = p_table_id\n   FOR KEY SHARE;';
  v_count := (length(v_source) - length(replace(v_source, v_before, ''))) / length(v_before);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'LEASE_FENCE_SOURCE_DRIFT: pending add-on fence matched % times', v_count;
  END IF;
  EXECUTE replace(v_source, v_before, v_after);

  /* Empty-table close holds the current tournament-manager generation. */
  v_oid := to_regprocedure(
    'public.fn_close_empty_tournament_table(uuid,uuid,uuid)'
  );
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'LEASE_FENCE_FUNCTION_MISSING: empty tournament table close';
  END IF;
  v_source := pg_get_functiondef(v_oid);
  v_before := E'FROM public.engine_tournament_leases l\n   WHERE l.tournament_id = p_tournament_id\n     AND l.protocol_version = 2\n     AND l.lease_generation = p_lease_generation\n     AND l.heartbeat_at >= clock_timestamp() - interval ''30 seconds''\n   FOR SHARE;';
  v_after := E'FROM public.engine_tournament_leases l\n   WHERE l.tournament_id = p_tournament_id\n     AND l.protocol_version = 2\n     AND l.lease_generation = p_lease_generation\n     AND l.heartbeat_at >= clock_timestamp() - interval ''30 seconds''\n   FOR KEY SHARE;';
  v_count := (length(v_source) - length(replace(v_source, v_before, ''))) / length(v_before);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'LEASE_FENCE_SOURCE_DRIFT: empty-table close fence matched % times', v_count;
  END IF;
  EXECUTE replace(v_source, v_before, v_after);

  /* Every mutating manager request takes one transaction-wide parent lease
     fence in the private PostgREST pre-request hook. */
  v_oid := to_regprocedure('smarter_private.fn_smarter_data_api_pre_request()');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'LEASE_FENCE_FUNCTION_MISSING: manager request hook';
  END IF;
  v_source := pg_get_functiondef(v_oid);
  v_before := E'FROM public.engine_tournament_leases l\n     WHERE l.tournament_id = v_tournament_id\n       AND l.protocol_version = 2\n       AND l.lease_generation = v_lease_generation\n       AND l.heartbeat_at >=\n           clock_timestamp() - make_interval(secs => v_stale_seconds)\n     FOR SHARE;';
  v_after := E'FROM public.engine_tournament_leases l\n     WHERE l.tournament_id = v_tournament_id\n       AND l.protocol_version = 2\n       AND l.lease_generation = v_lease_generation\n       AND l.heartbeat_at >=\n           clock_timestamp() - make_interval(secs => v_stale_seconds)\n     FOR KEY SHARE;';
  v_count := (length(v_source) - length(replace(v_source, v_before, ''))) / length(v_before);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'LEASE_FENCE_SOURCE_DRIFT: manager request fence matched % times', v_count;
  END IF;
  EXECUTE replace(v_source, v_before, v_after);
END;
$patch_effective_lease_fences$;

DO $verify_effective_lease_fences$
DECLARE
  v_source text;
  v_residual regprocedure;
BEGIN
  SELECT pg_get_functiondef(
           'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure
         )
    INTO v_source;
  IF position(E'FROM public.engine_table_leases l\n     WHERE l.table_id = p_table_id\n     FOR KEY SHARE;' IN v_source) = 0
     OR position(E'FROM public.engine_tournament_leases l\n     WHERE l.tournament_id = v_tournament_id\n     FOR KEY SHARE;' IN v_source) = 0
     OR position(E'FROM public.tournaments t\n     WHERE t.id = v_tournament_id\n     FOR SHARE;' IN v_source) = 0 THEN
    RAISE EXCEPTION 'LEASE_FENCE_POSTCONDITION_FAILED: exact hand settlement';
  END IF;

  SELECT pg_get_functiondef(
           'public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)'::regprocedure
         )
    INTO v_source;
  IF position(E'FROM public.engine_table_leases l\n   WHERE l.table_id = p_table_id\n   FOR KEY SHARE;' IN v_source) = 0 THEN
    RAISE EXCEPTION 'LEASE_FENCE_POSTCONDITION_FAILED: pending add-on resolver';
  END IF;

  SELECT pg_get_functiondef(
           'public.fn_close_empty_tournament_table(uuid,uuid,uuid)'::regprocedure
         )
    INTO v_source;
  IF position(E'FROM public.engine_tournament_leases l\n   WHERE l.tournament_id = p_tournament_id\n     AND l.protocol_version = 2\n     AND l.lease_generation = p_lease_generation\n     AND l.heartbeat_at >= clock_timestamp() - interval ''30 seconds''\n   FOR KEY SHARE;' IN v_source) = 0 THEN
    RAISE EXCEPTION 'LEASE_FENCE_POSTCONDITION_FAILED: empty-table close';
  END IF;

  SELECT pg_get_functiondef(
           'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
         )
    INTO v_source;
  IF position(E'FROM public.engine_tournament_leases l\n     WHERE l.tournament_id = v_tournament_id\n       AND l.protocol_version = 2\n       AND l.lease_generation = v_lease_generation\n       AND l.heartbeat_at >=\n           clock_timestamp() - make_interval(secs => v_stale_seconds)\n     FOR KEY SHARE;' IN v_source) = 0 THEN
    RAISE EXCEPTION 'LEASE_FENCE_POSTCONDITION_FAILED: manager request hook';
  END IF;

  SELECT p.oid::regprocedure
    INTO v_residual
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'smarter_private')
     AND p.prosrc ~
         'FROM[[:space:]]+public\.engine_(table|tournament)_leases[[:space:]]+[a-zA-Z_][a-zA-Z_0-9]*[[:space:]]+WHERE[^;]+FOR[[:space:]]+SHARE[[:space:]]*;'
   ORDER BY p.oid
   LIMIT 1;
  IF v_residual IS NOT NULL THEN
    RAISE EXCEPTION
      'LEASE_FENCE_POSTCONDITION_FAILED: residual lease-row FOR SHARE in %',
      v_residual;
  END IF;

  IF (SELECT count(*) FROM pg_temp.lease_fence_metadata_before) <> 4 THEN
    RAISE EXCEPTION 'LEASE_FENCE_METADATA_SNAPSHOT_INCOMPLETE';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_temp.lease_fence_metadata_before snap
      LEFT JOIN pg_proc current_fn ON current_fn.oid = snap.function_oid
     WHERE current_fn.oid IS NULL
        OR current_fn.proowner IS DISTINCT FROM snap.proowner
        OR current_fn.proacl IS DISTINCT FROM snap.proacl
        OR current_fn.prosecdef IS DISTINCT FROM snap.prosecdef
        OR current_fn.proconfig IS DISTINCT FROM snap.proconfig
  ) THEN
    RAISE EXCEPTION
      'LEASE_FENCE_METADATA_CHANGED: owner, ACL, security mode, or function configuration drifted';
  END IF;
END;
$verify_effective_lease_fences$;

COMMENT ON CONSTRAINT engine_table_leases_owner_generation_key
  ON public.engine_table_leases IS
  'Makes owner/generation key-changing so transaction fences can coexist with heartbeat-only updates.';
COMMENT ON CONSTRAINT engine_tournament_leases_owner_generation_key
  ON public.engine_tournament_leases IS
  'Makes owner/generation key-changing so transaction fences can coexist with heartbeat-only updates.';

COMMIT;
