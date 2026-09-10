-- 20260910042137_stage_b_lease_keyshare_once
/*
 * A live hand must not make its own lease heartbeat look lost.
 *
 * The final/current-postimage Stage-B authority leaves four lease-fenced
 * functions: exact hand settlement (cash table or tournament lease), unbound
 * add-on resolution, empty-table close, and the private manager request hook.
 * Production migrations 20260910063559 and 20260910064701 already made the
 * hook, tournament-hand, and empty-close fences FOR KEY SHARE, and made
 * claim_tournament_lease_v2 take FOR UPDATE before its upsert. Stage-B #5
 * authenticates and preserves those repairs. Only the cash-hand and add-on
 * table-lease fences still arrive here as FOR SHARE.
 *
 * This forward-only, stopped-engine cutover completes that already-repaired
 * postimage without replaying a stale all-FOR-SHARE replacement. The two
 * redundant ownership constraints are deliberate. PostgreSQL treats every
 * column belonging to a non-partial unique key as a key column.  Once
 * instance_id and lease_generation are key columns, FOR KEY SHARE has the
 * exact contract required here:
 *
 *   - UPDATE heartbeat_at (FOR NO KEY UPDATE) remains compatible;
 *   - changing instance_id or lease_generation requires FOR UPDATE and waits;
 *   - DELETE/release requires FOR UPDATE and waits.
 *
 * NOWAIT makes an unexpected live writer a refusal, never a partially
 * weakened authority boundary. PG17-derived definition/body hashes and full
 * function metadata authenticate both the composed preimage and the complete
 * postimage. A complete postimage is an exact no-op; every mixed, stale, or
 * drifted state aborts atomically before an unknown fence can be weakened.
 */
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL transaction_timeout = '150s';

-- This transaction must prove the stopped-engine boundary for itself. A prior
-- migration's committed proof and an operator-held host mutex do not block a
-- database engine restart. Authenticate and hold the durable freeze, then take
-- the global realtime/maintenance/engine relation order before topology reads
-- or ownership-key DDL.
SELECT pg_advisory_xact_lock_shared(530090,1);

DO $authenticate_stage_b_stopped_engine_authority$
DECLARE
  v_break_relation oid := to_regclass('public.engine_maintenance_break');
  v_predicate oid := to_regprocedure('public.fn_platform_frozen()');
  v_writer oid :=
    to_regprocedure('public.fn_serialize_engine_maintenance_break_write()');
  v_relation_owner oid;
BEGIN
  IF v_break_relation IS NULL OR v_predicate IS NULL OR v_writer IS NULL THEN
    RAISE EXCEPTION 'Stage-B stopped-engine authority is missing'
      USING ERRCODE = '55000';
  END IF;

  SELECT c.relowner INTO STRICT v_relation_owner
    FROM pg_class c WHERE c.oid = v_break_relation;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_predicate
       AND md5(p.prosrc) = '112b1265824ee082b8adc67ea367d826'
       AND p.proowner = v_relation_owner
       AND p.prokind = 'f' AND p.provolatile = 'v'
       AND NOT p.prosecdef AND NOT p.proretset
       AND p.prorettype = 'boolean'::regtype
       AND p.pronargs = 0 AND p.pronargdefaults = 0
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND l.lanname = 'sql'
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_writer
       AND md5(p.prosrc) = '084ed24f99e9d08765bd86ff8b920284'
       AND p.proowner = v_relation_owner
       AND p.prokind = 'f' AND p.provolatile = 'v'
       AND NOT p.prosecdef AND NOT p.proretset
       AND p.prorettype = 'trigger'::regtype
       AND p.pronargs = 0 AND p.pronargdefaults = 0
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND l.lanname = 'plpgsql'
  ) THEN
    RAISE EXCEPTION 'Stage-B durable platform freeze authority is not canonical'
      USING ERRCODE = '55000';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_trigger tg
     WHERE tg.tgrelid = v_break_relation
       AND tg.tgname = 'aa_serialize_maintenance_break_write'
       AND tg.tgfoid = v_writer
       AND NOT tg.tgisinternal
       AND tg.tgenabled = 'O'
       AND tg.tgtype = 62
       AND tg.tgattr::text = ''
       AND tg.tgqual IS NULL
       AND tg.tgnargs = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'Stage-B maintenance serialization trigger is not canonical'
      USING ERRCODE = '55000';
  END IF;
END;
$authenticate_stage_b_stopped_engine_authority$;

LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.engine_maintenance_break IN SHARE MODE NOWAIT;
LOCK TABLE public.engine_leader IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.engine_table_leases IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.engine_tournament_leases IN ACCESS EXCLUSIVE MODE NOWAIT;

DO $require_stage_b_stopped_engine_authority$
DECLARE
  v_database_is_pristine boolean;
BEGIN
  SELECT NOT (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
    OR EXISTS (SELECT 1 FROM public.tournament_tickets)
  ) INTO v_database_is_pristine;

  IF NOT v_database_is_pristine
     AND (
       public.fn_platform_frozen() IS NOT TRUE
       OR (
         SELECT count(*)
           FROM public.engine_maintenance_break b
          WHERE b.id
            AND b.enforce_freeze
            AND b.phase = 'counting_down'
            AND b.break_started_at IS NOT NULL
            AND b.break_started_at >= b.announced_at
            AND b.break_ends_at > b.break_started_at
            AND b.break_ends_at < b.announced_at + interval '15 minutes'
            AND b.break_ends_at >= clock_timestamp() + interval '3 minutes'
       ) <> 1
     ) THEN
    RAISE EXCEPTION
      'Stage-B boundary requires an authenticated counting-down freeze with three minutes of headroom'
      USING ERRCODE = '55006';
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.engine_leader l
        WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     ) OR EXISTS (
       SELECT 1 FROM public.engine_table_leases l
        WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     ) OR EXISTS (
       SELECT 1 FROM public.engine_tournament_leases l
        WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     ) THEN
    RAISE EXCEPTION 'Stage-B boundary requires every engine authority heartbeat to be stale'
      USING ERRCODE = '55006';
  END IF;
END;
$require_stage_b_stopped_engine_authority$;

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

CREATE TEMP TABLE pg_temp.lease_keyshare_cutover_mode (
  mode text PRIMARY KEY CHECK (mode IN ('apply', 'verify'))
) ON COMMIT DROP;

DO $classify_lease_keyshare_preimage$
DECLARE
  v_table_key_count integer;
  v_tournament_key_count integer;
  v_preimage_ok boolean;
  v_postimage_ok boolean;
  v_bad integer;
  v_postgres oid:='postgres'::regrole;
BEGIN
  SELECT count(*)::integer INTO v_table_key_count
    FROM pg_constraint con
   WHERE con.conrelid = 'public.engine_table_leases'::regclass
     AND con.conname = 'engine_table_leases_owner_generation_key';
  SELECT count(*)::integer INTO v_tournament_key_count
    FROM pg_constraint con
   WHERE con.conrelid = 'public.engine_tournament_leases'::regclass
     AND con.conname = 'engine_tournament_leases_owner_generation_key';

  /* Definition and prosrc hashes were derived on isolated PostgreSQL 17 by
     replaying the byte-exact 063559 and 064701 live migrations, installing
     #5's preserved KEY SHARE hook, and applying only the two remaining table
     lease substitutions below. */
  SELECT count(*)=6
         AND bool_and(md5(pg_get_functiondef(p.oid))=expected.definition_md5)
         AND bool_and(md5(p.prosrc)=expected.source_md5)
    INTO v_preimage_ok
    FROM (
      VALUES
        ('public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)',
         'e3a2120fc6db33ad84fc4967126fe9b8','457ad8f1e1528ad205f7bd43488f3e14'),
        ('public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)',
         '276314a02cecc35607cde1afdc2fdf21','8ab94f005d1dcc695c7094eec3fd279d'),
        ('public.fn_close_empty_tournament_table(uuid,uuid,uuid)',
         '0af954ab1264dc12ebce7741b7845343','4abef1a7ccd6d56c2523fe6cb02396b6'),
        ('smarter_private.fn_smarter_data_api_pre_request()',
         'f85b1aa5d752c9ca90a50cefc7e2dbf7','37a538d5284da673b4334ad7fe655f6b'),
        ('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)',
         '73abfc4523de42cb4b8bca5443602cbd','d1b5100c2b9f92bec5fd1680b0b4f230'),
        ('public.heartbeat_tournament_leases_v4(text,jsonb,integer)',
         '4a41b0124e75e46ed8121e6a56014758','5e6c99545e07c21efcb50e5cb3441c14')
    ) expected(identity,definition_md5,source_md5)
    JOIN pg_proc p ON p.oid=to_regprocedure(expected.identity);

  SELECT count(*)=6
         AND bool_and(md5(pg_get_functiondef(p.oid))=expected.definition_md5)
         AND bool_and(md5(p.prosrc)=expected.source_md5)
    INTO v_postimage_ok
    FROM (
      VALUES
        ('public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)',
         'c555fb7b83c889312995bc0038c1b275','21eee4aac1840bd768592caff4b2c492'),
        ('public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)',
         '3b69f7d3d104ff1c612df0581ca05493','dceb3cbdf762f5ec0720d9ff91a09c2d'),
        ('public.fn_close_empty_tournament_table(uuid,uuid,uuid)',
         '0af954ab1264dc12ebce7741b7845343','4abef1a7ccd6d56c2523fe6cb02396b6'),
        ('smarter_private.fn_smarter_data_api_pre_request()',
         'f85b1aa5d752c9ca90a50cefc7e2dbf7','37a538d5284da673b4334ad7fe655f6b'),
        ('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)',
         '73abfc4523de42cb4b8bca5443602cbd','d1b5100c2b9f92bec5fd1680b0b4f230'),
        ('public.heartbeat_tournament_leases_v4(text,jsonb,integer)',
         '4a41b0124e75e46ed8121e6a56014758','5e6c99545e07c21efcb50e5cb3441c14')
    ) expected(identity,definition_md5,source_md5)
    JOIN pg_proc p ON p.oid=to_regprocedure(expected.identity);

  IF v_table_key_count = 0 AND v_tournament_key_count = 0
     AND v_preimage_ok THEN
    INSERT INTO pg_temp.lease_keyshare_cutover_mode(mode) VALUES ('apply');
  ELSIF v_table_key_count = 1 AND v_tournament_key_count = 1
        AND v_postimage_ok THEN
    INSERT INTO pg_temp.lease_keyshare_cutover_mode(mode) VALUES ('verify');
  ELSE
    RAISE EXCEPTION
      'LEASE_KEYSHARE_UNKNOWN_PREIMAGE: table key %, tournament key %, source preimage %, source postimage %',
      v_table_key_count,
      v_tournament_key_count,
      v_preimage_ok,
      v_postimage_ok;
  END IF;

  SELECT count(*)::integer INTO v_bad
    FROM (
      VALUES
        ('public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)',
         'jsonb'::regtype,false,11,0,
         ARRAY['search_path=public, pg_temp']::text[],
         ARRAY['postgres']::name[]),
        ('public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)',
         'jsonb'::regtype,false,4,0,
         ARRAY['search_path=public, extensions, pg_temp']::text[],
         ARRAY['postgres','service_role']::name[]),
        ('public.fn_close_empty_tournament_table(uuid,uuid,uuid)',
         'jsonb'::regtype,false,3,0,
         ARRAY['search_path=public, pg_temp']::text[],
         ARRAY['postgres','service_role']::name[]),
        ('smarter_private.fn_smarter_data_api_pre_request()',
         'void'::regtype,false,0,0,
         ARRAY['search_path=pg_catalog, pg_temp']::text[],
         ARRAY['anon','authenticated','postgres','service_role']::name[]),
        ('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)',
         'record'::regtype,true,5,3,
         ARRAY['search_path=public, pg_temp']::text[],
         ARRAY['postgres','service_role']::name[]),
        ('public.heartbeat_tournament_leases_v4(text,jsonb,integer)',
         'record'::regtype,true,3,1,
         ARRAY['search_path=public, pg_temp']::text[],
         ARRAY['postgres','service_role']::name[])
    ) expected(
      identity,return_type,returns_set,argument_count,default_count,
      configuration,execute_grantees)
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.identity)
    LEFT JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid IS NULL
      OR p.proowner IS DISTINCT FROM v_postgres
      OR NOT p.prosecdef OR p.proretset IS DISTINCT FROM expected.returns_set
      OR p.proisstrict OR p.proleakproof
      OR p.provolatile<>'v' OR p.proparallel<>'u' OR p.prokind<>'f'
      OR p.prorettype IS DISTINCT FROM expected.return_type
      OR p.pronargs IS DISTINCT FROM expected.argument_count
      OR p.pronargdefaults IS DISTINCT FROM expected.default_count
      OR p.proconfig IS DISTINCT FROM expected.configuration
      OR l.lanname IS DISTINCT FROM 'plpgsql'
      OR (
        SELECT array_agg(
                 (CASE WHEN acl.grantee=0 THEN 'PUBLIC'
                       ELSE pg_get_userbyid(acl.grantee) END)::name
                 ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC'
                               ELSE pg_get_userbyid(acl.grantee) END)
          FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
         WHERE acl.privilege_type='EXECUTE'
           AND acl.grantor=p.proowner
           AND NOT acl.is_grantable
      ) IS DISTINCT FROM expected.execute_grantees
      OR EXISTS (
        SELECT 1
          FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
         WHERE acl.privilege_type<>'EXECUTE'
            OR acl.grantor<>p.proowner
            OR acl.is_grantable
      );
  IF v_bad<>0 THEN
    RAISE EXCEPTION
      'LEASE_KEYSHARE_FUNCTION_METADATA_DRIFT: % current authorities',v_bad;
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
       p.proconfig,
       p.provolatile,
       p.proparallel,
       p.proisstrict,
       p.proleakproof,
       p.prokind,
       p.proretset,
       p.prorettype,
       p.pronargs,
       p.pronargdefaults
  FROM pg_proc p
 WHERE p.oid = ANY(ARRAY[
   'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure::oid,
   'public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)'::regprocedure::oid,
   'public.fn_close_empty_tournament_table(uuid,uuid,uuid)'::regprocedure::oid,
   'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure::oid,
   'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure::oid,
   'public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure::oid
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

  /* 064701 already changed the tournament-lease row. Change only the remaining
     cash table-lease row; its separate tournament-parent FOR SHARE remains
     untouched. */
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
END;
$patch_effective_lease_fences$;

DO $verify_effective_lease_fences$
DECLARE
  v_source text;
  v_residual regprocedure;
  v_bad integer;
BEGIN
  SELECT pg_get_functiondef(
           'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure
         )
    INTO v_source;
  IF position(E'FROM public.engine_table_leases l\n     WHERE l.table_id = p_table_id\n     FOR KEY SHARE;' IN v_source) = 0
     OR v_source !~
          'FROM[[:space:]]+public\.engine_tournament_leases[[:space:]]+l[[:space:]]+WHERE[[:space:]]+l\.tournament_id[[:space:]]*=[[:space:]]*v_tournament_id[^;]+FOR[[:space:]]+KEY[[:space:]]+SHARE[[:space:]]*;'
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
  IF v_source !~
       'FROM[[:space:]]+public\.engine_tournament_leases[[:space:]]+l[[:space:]]+WHERE[[:space:]]+l\.tournament_id[[:space:]]*=[[:space:]]*p_tournament_id[^;]+FOR[[:space:]]+KEY[[:space:]]+SHARE[[:space:]]*;' THEN
    RAISE EXCEPTION 'LEASE_FENCE_POSTCONDITION_FAILED: empty-table close';
  END IF;

  SELECT pg_get_functiondef(
           'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
         )
    INTO v_source;
  IF v_source !~
       'FROM[[:space:]]+public\.engine_tournament_leases[[:space:]]+l[[:space:]]+WHERE[[:space:]]+l\.tournament_id[[:space:]]*=[[:space:]]*v_tournament_id[^;]+FOR[[:space:]]+KEY[[:space:]]+SHARE[[:space:]]*;' THEN
    RAISE EXCEPTION 'LEASE_FENCE_POSTCONDITION_FAILED: manager request hook';
  END IF;

  SELECT pg_get_functiondef(
           'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure
         )
    INTO v_source;
  IF position(E'PERFORM 1 FROM public.engine_tournament_leases l\n'
              '   WHERE l.tournament_id = p_tournament_id\n'
              '   FOR UPDATE;\n\n'
              '  INSERT INTO public.engine_tournament_leases' IN v_source) = 0 THEN
    RAISE EXCEPTION
      'LEASE_FENCE_POSTCONDITION_FAILED: claim takeover is not FOR UPDATE before upsert';
  END IF;

  SELECT p.prosrc INTO STRICT v_source
    FROM pg_proc p
   WHERE p.oid=
     'public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure;
  IF position('FOR NO KEY UPDATE OF l SKIP LOCKED' IN v_source)=0 THEN
    RAISE EXCEPTION
      'LEASE_FENCE_POSTCONDITION_FAILED: tournament heartbeat lock shape drifted';
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

  SELECT count(*)::integer INTO v_bad
    FROM (
      VALUES
        ('public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)',
         'c555fb7b83c889312995bc0038c1b275','21eee4aac1840bd768592caff4b2c492'),
        ('public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)',
         '3b69f7d3d104ff1c612df0581ca05493','dceb3cbdf762f5ec0720d9ff91a09c2d'),
        ('public.fn_close_empty_tournament_table(uuid,uuid,uuid)',
         '0af954ab1264dc12ebce7741b7845343','4abef1a7ccd6d56c2523fe6cb02396b6'),
        ('smarter_private.fn_smarter_data_api_pre_request()',
         'f85b1aa5d752c9ca90a50cefc7e2dbf7','37a538d5284da673b4334ad7fe655f6b'),
        ('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)',
         '73abfc4523de42cb4b8bca5443602cbd','d1b5100c2b9f92bec5fd1680b0b4f230'),
        ('public.heartbeat_tournament_leases_v4(text,jsonb,integer)',
         '4a41b0124e75e46ed8121e6a56014758','5e6c99545e07c21efcb50e5cb3441c14')
    ) expected(identity,definition_md5,source_md5)
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.identity)
   WHERE p.oid IS NULL
      OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM expected.definition_md5
      OR md5(p.prosrc) IS DISTINCT FROM expected.source_md5;
  IF v_bad<>0 THEN
    RAISE EXCEPTION
      'LEASE_FENCE_POSTCONDITION_FAILED: % authenticated function sources drifted',
      v_bad;
  END IF;

  IF (SELECT count(*) FROM pg_temp.lease_fence_metadata_before) <> 6 THEN
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
        OR current_fn.provolatile IS DISTINCT FROM snap.provolatile
        OR current_fn.proparallel IS DISTINCT FROM snap.proparallel
        OR current_fn.proisstrict IS DISTINCT FROM snap.proisstrict
        OR current_fn.proleakproof IS DISTINCT FROM snap.proleakproof
        OR current_fn.prokind IS DISTINCT FROM snap.prokind
        OR current_fn.proretset IS DISTINCT FROM snap.proretset
        OR current_fn.prorettype IS DISTINCT FROM snap.prorettype
        OR current_fn.pronargs IS DISTINCT FROM snap.pronargs
        OR current_fn.pronargdefaults IS DISTINCT FROM snap.pronargdefaults
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
