-- Phase 6: server-enforced bounded solver canary authority.
--
-- A checksum-pinned worker manifest constrains the Windows runner, but an HMAC
-- holder must not be able to ask the application gateway to ingest a third
-- artifact while an operator has authorized only one parent/child canary. This
-- migration makes the database authority explicit. Existing active authority
-- tuples retain backlog behavior; a bounded_canary tuple admits exactly two
-- operator-approved UUID/scenario/node/position identities and nothing else.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $bounded_canary_prerequisites$
BEGIN
  IF to_regclass('public.training_solver_provenance_authority') IS NULL
     OR to_regclass('public.solved_spots_gold') IS NULL
     OR to_regprocedure(
       'public.training_ingest_solver_artifact_v1(text,text,text,text,text,text,uuid,timestamp with time zone,text,jsonb)'
     ) IS NULL
     OR to_regprocedure(
       'public.training_solver_worker_row_states_v1(text[])'
     ) IS NULL THEN
    RAISE EXCEPTION 'TRAINING_SOLVER_BOUNDED_CANARY_PREREQUISITE_MISSING';
  END IF;
END;
$bounded_canary_prerequisites$;

CREATE TABLE IF NOT EXISTS public.training_solver_ingest_scopes (
  machine_id text NOT NULL,
  solver_version text NOT NULL,
  solver_binary_checksum text NOT NULL,
  pipeline_commit text NOT NULL,
  manifest_version text NOT NULL,
  manifest_checksum text NOT NULL,
  admission_mode text NOT NULL,
  partition_count integer,
  partition_index integer,
  configured_at timestamptz NOT NULL DEFAULT now(),
  configured_by text NOT NULL,
  CONSTRAINT training_solver_ingest_scopes_pkey PRIMARY KEY (
    machine_id,
    solver_version,
    solver_binary_checksum,
    pipeline_commit,
    manifest_version,
    manifest_checksum
  ),
  CONSTRAINT training_solver_ingest_scopes_authority_fkey FOREIGN KEY (
    machine_id,
    solver_version,
    solver_binary_checksum,
    pipeline_commit,
    manifest_version,
    manifest_checksum
  ) REFERENCES public.training_solver_provenance_authority (
    machine_id,
    solver_version,
    solver_binary_checksum,
    pipeline_commit,
    manifest_version,
    manifest_checksum
  ) ON DELETE CASCADE,
  CONSTRAINT training_solver_ingest_scopes_mode_check
    CHECK (admission_mode IN ('held', 'backlog', 'bounded_canary')),
  CONSTRAINT training_solver_ingest_scopes_partition_check CHECK (
    (
      admission_mode IN ('held', 'backlog')
      AND partition_count IS NULL
      AND partition_index IS NULL
    ) OR (
      admission_mode = 'bounded_canary'
      AND partition_count = 2
      AND (
        (machine_id = 'M1' AND partition_index = 0)
        OR (machine_id = 'M2' AND partition_index = 1)
      )
    )
  ),
  CONSTRAINT training_solver_ingest_scopes_labels_check CHECK (
    machine_id IN ('M1', 'M2')
    AND solver_binary_checksum ~ '^[0-9a-f]{64}$'
    AND pipeline_commit ~ '^[0-9a-f]{40}$'
    AND manifest_checksum ~ '^[0-9a-f]{64}$'
    AND char_length(btrim(solver_version)) BETWEEN 1 AND 120
    AND char_length(btrim(manifest_version)) BETWEEN 1 AND 160
    AND char_length(btrim(configured_by)) BETWEEN 3 AND 200
  )
);

CREATE TABLE IF NOT EXISTS public.training_solver_bounded_canary_targets (
  machine_id text NOT NULL,
  solver_version text NOT NULL,
  solver_binary_checksum text NOT NULL,
  pipeline_commit text NOT NULL,
  manifest_version text NOT NULL,
  manifest_checksum text NOT NULL,
  target_role text NOT NULL,
  artifact_id uuid NOT NULL,
  scenario_hash text NOT NULL,
  street text NOT NULL,
  node text NOT NULL,
  hero_position text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  approved_by text NOT NULL,
  CONSTRAINT training_solver_bounded_canary_targets_pkey PRIMARY KEY (
    machine_id,
    solver_version,
    solver_binary_checksum,
    pipeline_commit,
    manifest_version,
    manifest_checksum,
    target_role
  ),
  CONSTRAINT training_solver_canary_targets_scope_fkey FOREIGN KEY (
    machine_id,
    solver_version,
    solver_binary_checksum,
    pipeline_commit,
    manifest_version,
    manifest_checksum
  ) REFERENCES public.training_solver_ingest_scopes (
    machine_id,
    solver_version,
    solver_binary_checksum,
    pipeline_commit,
    manifest_version,
    manifest_checksum
  ) ON DELETE CASCADE,
  CONSTRAINT training_solver_canary_targets_artifact_key UNIQUE (
    machine_id,
    solver_version,
    solver_binary_checksum,
    pipeline_commit,
    manifest_version,
    manifest_checksum,
    artifact_id
  ),
  CONSTRAINT training_solver_canary_targets_scenario_key UNIQUE (
    machine_id,
    solver_version,
    solver_binary_checksum,
    pipeline_commit,
    manifest_version,
    manifest_checksum,
    scenario_hash
  ),
  CONSTRAINT training_solver_canary_targets_role_street_check CHECK (
    (target_role = 'parent' AND street = 'flop')
    OR (target_role = 'child' AND street = 'turn')
  ),
  CONSTRAINT training_solver_canary_targets_identity_check CHECK (
    char_length(scenario_hash) BETWEEN 1 AND 512
    AND char_length(node) BETWEEN 3 AND 4096
    AND starts_with(node, 'r:0')
    AND hero_position ~
      '^(UTG|UTG\+1|UTG\+2|UTG1|UTG2|MP|MP\+1|MP\+2|MP1|MP2|LJ|HJ|CO|BTN|SB|BB)$'
    AND char_length(btrim(approved_by)) BETWEEN 3 AND 200
  )
);

ALTER TABLE public.training_solver_ingest_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_solver_bounded_canary_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.training_solver_ingest_scopes
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.training_solver_bounded_canary_targets
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.training_solver_scope_migration_state (
  migration_id text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT training_solver_scope_migration_state_id_check
    CHECK (char_length(migration_id) BETWEEN 1 AND 160)
);
ALTER TABLE public.training_solver_scope_migration_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.training_solver_scope_migration_state
  FROM PUBLIC, anon, authenticated, service_role;

-- CREATE TABLE IF NOT EXISTS is deliberately idempotent, but it must never
-- bless a pre-existing object with missing columns, weaker constraints, a
-- different default, or residual column grants. Normalize column ACLs first,
-- then fail the migration before any state is preserved or any trigger is
-- installed if one of the three private authority tables is not exact.
DO $revoke_solver_scope_columns$
DECLARE
  v_columns text;
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'training_solver_ingest_scopes',
    'training_solver_bounded_canary_targets',
    'training_solver_scope_migration_state'
  ] LOOP
    SELECT string_agg(
      quote_ident(attribute_row.attname), ',' ORDER BY attribute_row.attnum
    )
    INTO v_columns
    FROM pg_catalog.pg_attribute attribute_row
    WHERE attribute_row.attrelid =
        pg_catalog.to_regclass('public.' || v_table)
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped;
    IF v_columns IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',
        v_columns, v_table
      );
    END IF;
  END LOOP;
END;
$revoke_solver_scope_columns$;

DO $assert_solver_scope_table_shapes$
DECLARE
  v_scope_oid pg_catalog.oid :=
    pg_catalog.to_regclass('public.training_solver_ingest_scopes');
  v_target_oid pg_catalog.oid :=
    pg_catalog.to_regclass('public.training_solver_bounded_canary_targets');
  v_state_oid pg_catalog.oid :=
    pg_catalog.to_regclass('public.training_solver_scope_migration_state');
  v_role text;
  v_table text;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class class_row
       WHERE class_row.oid = v_scope_oid
         AND class_row.relkind = 'r'
         AND class_row.relpersistence = 'p'
         AND class_row.relrowsecurity
     )
     OR (
       SELECT count(*) FROM pg_catalog.pg_attribute attribute_row
       WHERE attribute_row.attrelid = v_scope_oid
         AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped
     ) <> 11
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('machine_id', 1, 'text', true, NULL::text),
         ('solver_version', 2, 'text', true, NULL::text),
         ('solver_binary_checksum', 3, 'text', true, NULL::text),
         ('pipeline_commit', 4, 'text', true, NULL::text),
         ('manifest_version', 5, 'text', true, NULL::text),
         ('manifest_checksum', 6, 'text', true, NULL::text),
         ('admission_mode', 7, 'text', true, NULL::text),
         ('partition_count', 8, 'integer', false, NULL::text),
         ('partition_index', 9, 'integer', false, NULL::text),
         ('configured_at', 10, 'timestamp with time zone', true, 'now()'::text),
         ('configured_by', 11, 'text', true, NULL::text)
       ) expected(attname, attnum, type_name, attnotnull, default_expr)
       LEFT JOIN pg_catalog.pg_attribute actual
         ON actual.attrelid = v_scope_oid
        AND actual.attname = expected.attname
        AND actual.attnum = expected.attnum
        AND NOT actual.attisdropped
       LEFT JOIN pg_catalog.pg_attrdef default_row
         ON default_row.adrelid = actual.attrelid
        AND default_row.adnum = actual.attnum
       WHERE actual.attname IS NULL
          OR pg_catalog.format_type(actual.atttypid, actual.atttypmod)
             IS DISTINCT FROM expected.type_name
          OR actual.attnotnull IS DISTINCT FROM expected.attnotnull
          OR pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
             IS DISTINCT FROM expected.default_expr
     )
     OR (SELECT count(*) FROM pg_catalog.pg_constraint constraint_row
         WHERE constraint_row.conrelid = v_scope_oid) <> 5
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = v_scope_oid
         AND constraint_row.conname = 'training_solver_ingest_scopes_pkey'
         AND constraint_row.contype = 'p' AND constraint_row.convalidated
         AND NOT constraint_row.condeferrable AND NOT constraint_row.condeferred
         AND constraint_row.conkey = ARRAY[1,2,3,4,5,6]::smallint[]
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = v_scope_oid
         AND constraint_row.conname = 'training_solver_ingest_scopes_authority_fkey'
         AND constraint_row.contype = 'f' AND constraint_row.convalidated
         AND NOT constraint_row.condeferrable AND NOT constraint_row.condeferred
         AND constraint_row.conkey = ARRAY[1,2,3,4,5,6]::smallint[]
         AND constraint_row.confrelid =
           'public.training_solver_provenance_authority'::pg_catalog.regclass
         AND constraint_row.confkey = ARRAY[1,2,3,4,5,6]::smallint[]
         AND constraint_row.confdeltype = 'c'
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         (
           'training_solver_ingest_scopes_mode_check',
           $definition$CHECK ((admission_mode = ANY (ARRAY['held'::text, 'backlog'::text, 'bounded_canary'::text])))$definition$
         ),
         (
           'training_solver_ingest_scopes_partition_check',
           $definition$CHECK ((((admission_mode = ANY (ARRAY['held'::text, 'backlog'::text])) AND (partition_count IS NULL) AND (partition_index IS NULL)) OR ((admission_mode = 'bounded_canary'::text) AND (partition_count = 2) AND (((machine_id = 'M1'::text) AND (partition_index = 0)) OR ((machine_id = 'M2'::text) AND (partition_index = 1))))))$definition$
         ),
         (
           'training_solver_ingest_scopes_labels_check',
           $definition$CHECK (((machine_id = ANY (ARRAY['M1'::text, 'M2'::text])) AND (solver_binary_checksum ~ '^[0-9a-f]{64}$'::text) AND (pipeline_commit ~ '^[0-9a-f]{40}$'::text) AND (manifest_checksum ~ '^[0-9a-f]{64}$'::text) AND ((char_length(btrim(solver_version)) >= 1) AND (char_length(btrim(solver_version)) <= 120)) AND ((char_length(btrim(manifest_version)) >= 1) AND (char_length(btrim(manifest_version)) <= 160)) AND ((char_length(btrim(configured_by)) >= 3) AND (char_length(btrim(configured_by)) <= 200))))$definition$
         )
       ) expected(conname, definition)
       LEFT JOIN pg_catalog.pg_constraint actual
         ON actual.conrelid = v_scope_oid
        AND actual.conname = expected.conname
        AND actual.contype = 'c'
       WHERE actual.oid IS NULL OR NOT actual.convalidated
          OR actual.condeferrable OR actual.condeferred
          OR pg_catalog.pg_get_constraintdef(actual.oid, false)
             IS DISTINCT FROM expected.definition
     )
     THEN
    RAISE EXCEPTION 'TRAINING_SOLVER_INGEST_SCOPES_CONTRACT_INCOMPLETE';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class class_row
       WHERE class_row.oid = v_target_oid
         AND class_row.relkind = 'r'
         AND class_row.relpersistence = 'p'
         AND class_row.relrowsecurity
     )
     OR (
       SELECT count(*) FROM pg_catalog.pg_attribute attribute_row
       WHERE attribute_row.attrelid = v_target_oid
         AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped
     ) <> 14
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('machine_id', 1, 'text', true, NULL::text),
         ('solver_version', 2, 'text', true, NULL::text),
         ('solver_binary_checksum', 3, 'text', true, NULL::text),
         ('pipeline_commit', 4, 'text', true, NULL::text),
         ('manifest_version', 5, 'text', true, NULL::text),
         ('manifest_checksum', 6, 'text', true, NULL::text),
         ('target_role', 7, 'text', true, NULL::text),
         ('artifact_id', 8, 'uuid', true, NULL::text),
         ('scenario_hash', 9, 'text', true, NULL::text),
         ('street', 10, 'text', true, NULL::text),
         ('node', 11, 'text', true, NULL::text),
         ('hero_position', 12, 'text', true, NULL::text),
         ('approved_at', 13, 'timestamp with time zone', true, 'now()'::text),
         ('approved_by', 14, 'text', true, NULL::text)
       ) expected(attname, attnum, type_name, attnotnull, default_expr)
       LEFT JOIN pg_catalog.pg_attribute actual
         ON actual.attrelid = v_target_oid
        AND actual.attname = expected.attname
        AND actual.attnum = expected.attnum
        AND NOT actual.attisdropped
       LEFT JOIN pg_catalog.pg_attrdef default_row
         ON default_row.adrelid = actual.attrelid
        AND default_row.adnum = actual.attnum
       WHERE actual.attname IS NULL
          OR pg_catalog.format_type(actual.atttypid, actual.atttypmod)
             IS DISTINCT FROM expected.type_name
          OR actual.attnotnull IS DISTINCT FROM expected.attnotnull
          OR pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
             IS DISTINCT FROM expected.default_expr
     )
     OR (SELECT count(*) FROM pg_catalog.pg_constraint constraint_row
         WHERE constraint_row.conrelid = v_target_oid) <> 6
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = v_target_oid
         AND constraint_row.conname = 'training_solver_bounded_canary_targets_pkey'
         AND constraint_row.contype = 'p' AND constraint_row.convalidated
         AND NOT constraint_row.condeferrable AND NOT constraint_row.condeferred
         AND constraint_row.conkey = ARRAY[1,2,3,4,5,6,7]::smallint[]
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = v_target_oid
         AND constraint_row.conname = 'training_solver_canary_targets_scope_fkey'
         AND constraint_row.contype = 'f' AND constraint_row.convalidated
         AND NOT constraint_row.condeferrable AND NOT constraint_row.condeferred
         AND constraint_row.conkey = ARRAY[1,2,3,4,5,6]::smallint[]
         AND constraint_row.confrelid = v_scope_oid
         AND constraint_row.confkey = ARRAY[1,2,3,4,5,6]::smallint[]
         AND constraint_row.confdeltype = 'c'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = v_target_oid
         AND constraint_row.conname = 'training_solver_canary_targets_artifact_key'
         AND constraint_row.contype = 'u' AND constraint_row.convalidated
         AND NOT constraint_row.condeferrable AND NOT constraint_row.condeferred
         AND constraint_row.conkey = ARRAY[1,2,3,4,5,6,8]::smallint[]
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = v_target_oid
         AND constraint_row.conname = 'training_solver_canary_targets_scenario_key'
         AND constraint_row.contype = 'u' AND constraint_row.convalidated
         AND NOT constraint_row.condeferrable AND NOT constraint_row.condeferred
         AND constraint_row.conkey = ARRAY[1,2,3,4,5,6,9]::smallint[]
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         (
           'training_solver_canary_targets_role_street_check',
           $definition$CHECK ((((target_role = 'parent'::text) AND (street = 'flop'::text)) OR ((target_role = 'child'::text) AND (street = 'turn'::text))))$definition$
         ),
         (
           'training_solver_canary_targets_identity_check',
           $definition$CHECK ((((char_length(scenario_hash) >= 1) AND (char_length(scenario_hash) <= 512)) AND ((char_length(node) >= 3) AND (char_length(node) <= 4096)) AND starts_with(node, 'r:0'::text) AND (hero_position ~ '^(UTG|UTG\+1|UTG\+2|UTG1|UTG2|MP|MP\+1|MP\+2|MP1|MP2|LJ|HJ|CO|BTN|SB|BB)$'::text) AND ((char_length(btrim(approved_by)) >= 3) AND (char_length(btrim(approved_by)) <= 200))))$definition$
         )
       ) expected(conname, definition)
       LEFT JOIN pg_catalog.pg_constraint actual
         ON actual.conrelid = v_target_oid
        AND actual.conname = expected.conname
        AND actual.contype = 'c'
       WHERE actual.oid IS NULL OR NOT actual.convalidated
          OR actual.condeferrable OR actual.condeferred
          OR pg_catalog.pg_get_constraintdef(actual.oid, false)
             IS DISTINCT FROM expected.definition
     )
     THEN
    RAISE EXCEPTION 'TRAINING_SOLVER_CANARY_TARGETS_CONTRACT_INCOMPLETE';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class class_row
       WHERE class_row.oid = v_state_oid
         AND class_row.relkind = 'r'
         AND class_row.relpersistence = 'p'
         AND class_row.relrowsecurity
     )
     OR (
       SELECT count(*) FROM pg_catalog.pg_attribute attribute_row
       WHERE attribute_row.attrelid = v_state_oid
         AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped
     ) <> 2
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('migration_id', 1, 'text', true, NULL::text),
         ('completed_at', 2, 'timestamp with time zone', true, 'now()'::text)
       ) expected(attname, attnum, type_name, attnotnull, default_expr)
       LEFT JOIN pg_catalog.pg_attribute actual
         ON actual.attrelid = v_state_oid
        AND actual.attname = expected.attname
        AND actual.attnum = expected.attnum
        AND NOT actual.attisdropped
       LEFT JOIN pg_catalog.pg_attrdef default_row
         ON default_row.adrelid = actual.attrelid
        AND default_row.adnum = actual.attnum
       WHERE actual.attname IS NULL
          OR pg_catalog.format_type(actual.atttypid, actual.atttypmod)
             IS DISTINCT FROM expected.type_name
          OR actual.attnotnull IS DISTINCT FROM expected.attnotnull
          OR pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
             IS DISTINCT FROM expected.default_expr
     )
     OR (SELECT count(*) FROM pg_catalog.pg_constraint constraint_row
         WHERE constraint_row.conrelid = v_state_oid) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = v_state_oid
         AND constraint_row.conname = 'training_solver_scope_migration_state_pkey'
         AND constraint_row.contype = 'p' AND constraint_row.convalidated
         AND NOT constraint_row.condeferrable AND NOT constraint_row.condeferred
         AND constraint_row.conkey = ARRAY[1]::smallint[]
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = v_state_oid
         AND constraint_row.conname =
           'training_solver_scope_migration_state_id_check'
         AND constraint_row.contype = 'c' AND constraint_row.convalidated
         AND NOT constraint_row.condeferrable
         AND NOT constraint_row.condeferred
         AND pg_catalog.pg_get_constraintdef(constraint_row.oid, false) =
           $definition$CHECK (((char_length(migration_id) >= 1) AND (char_length(migration_id) <= 160)))$definition$
     ) THEN
    RAISE EXCEPTION 'TRAINING_SOLVER_SCOPE_MIGRATION_STATE_CONTRACT_INCOMPLETE';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH v_table IN ARRAY ARRAY[
      'training_solver_ingest_scopes',
      'training_solver_bounded_canary_targets',
      'training_solver_scope_migration_state'
    ] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.' || v_table, 'SELECT')
         OR pg_catalog.has_table_privilege(v_role, 'public.' || v_table, 'INSERT')
         OR pg_catalog.has_table_privilege(v_role, 'public.' || v_table, 'UPDATE')
         OR pg_catalog.has_table_privilege(v_role, 'public.' || v_table, 'DELETE')
         OR pg_catalog.has_table_privilege(v_role, 'public.' || v_table, 'TRUNCATE')
         OR pg_catalog.has_table_privilege(v_role, 'public.' || v_table, 'REFERENCES')
         OR pg_catalog.has_table_privilege(v_role, 'public.' || v_table, 'TRIGGER')
         OR pg_catalog.has_table_privilege(v_role, 'public.' || v_table, 'MAINTAIN')
         OR pg_catalog.has_any_column_privilege(
           v_role, 'public.' || v_table, 'SELECT'
         )
         OR pg_catalog.has_any_column_privilege(
           v_role, 'public.' || v_table, 'INSERT'
         )
         OR pg_catalog.has_any_column_privilege(
           v_role, 'public.' || v_table, 'UPDATE'
         )
         OR pg_catalog.has_any_column_privilege(
           v_role, 'public.' || v_table, 'REFERENCES'
         ) THEN
        RAISE EXCEPTION 'TRAINING_SOLVER_PRIVATE_SCOPE_ACL_INCOMPLETE';
      END IF;
    END LOOP;
  END LOOP;
END;
$assert_solver_scope_table_shapes$;

-- Preserve the behavior of every authority tuple that existed before this
-- migration. This statement runs before the future-authority trigger exists,
-- so only provenance already present at migration time becomes backlog scope.
DO $preserve_preexisting_backlog_once$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.training_solver_scope_migration_state state
    WHERE state.migration_id =
      '20260910120000-preserve-preexisting-authority-as-backlog'
  ) THEN
    INSERT INTO public.training_solver_ingest_scopes (
      machine_id, solver_version, solver_binary_checksum, pipeline_commit,
      manifest_version, manifest_checksum, admission_mode,
      partition_count, partition_index, configured_by
    )
    SELECT
      authority.machine_id, authority.solver_version,
      authority.solver_binary_checksum, authority.pipeline_commit,
      authority.manifest_version, authority.manifest_checksum,
      'backlog', NULL, NULL,
      'migration-preserved-existing-backlog-authority'
    FROM public.training_solver_provenance_authority authority;

    INSERT INTO public.training_solver_scope_migration_state (migration_id)
    VALUES ('20260910120000-preserve-preexisting-authority-as-backlog');
  END IF;
END;
$preserve_preexisting_backlog_once$;

-- A newly approved provenance tuple begins in a non-ingesting held state. The
-- protected approval transaction must then either activate explicit backlog
-- scope (with zero canary targets) or install exactly one parent and one child
-- target before activating bounded_canary. There is no implicit future
-- backlog authority.
CREATE OR REPLACE FUNCTION public.fn_training_solver_scope_hold_on_authority_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO public.training_solver_ingest_scopes (
    machine_id, solver_version, solver_binary_checksum, pipeline_commit,
    manifest_version, manifest_checksum, admission_mode,
    partition_count, partition_index, configured_by
  ) VALUES (
    NEW.machine_id, NEW.solver_version, NEW.solver_binary_checksum,
    NEW.pipeline_commit, NEW.manifest_version, NEW.manifest_checksum,
    'held', NULL, NULL, 'automatic-fail-closed-authority-hold'
  );
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_training_solver_scope_hold_on_authority_v1()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS training_solver_scope_hold_on_authority_v1
  ON public.training_solver_provenance_authority;
CREATE TRIGGER training_solver_scope_hold_on_authority_v1
AFTER INSERT ON public.training_solver_provenance_authority
FOR EACH ROW EXECUTE FUNCTION
  public.fn_training_solver_scope_hold_on_authority_v1();

-- Retirement is permanent. Re-enabling a retired backlog tuple would make it
-- ingest-capable without traversing the serialized held->active scope guard and
-- could recreate a second active scope beside a bounded canary.
CREATE OR REPLACE FUNCTION
  public.fn_training_solver_provenance_reactivation_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'TRAINING_SOLVER_PROVENANCE_RETIREMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION
  public.fn_training_solver_provenance_reactivation_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS training_solver_provenance_reactivation_guard_v1
  ON public.training_solver_provenance_authority;
CREATE TRIGGER training_solver_provenance_reactivation_guard_v1
BEFORE UPDATE OF retired_at ON public.training_solver_provenance_authority
FOR EACH ROW EXECUTE FUNCTION
  public.fn_training_solver_provenance_reactivation_guard_v1();

CREATE OR REPLACE FUNCTION public.fn_training_solver_canary_target_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_mode text;
BEGIN
  -- A target may be edited only while its exact authority tuple is held. On an
  -- UPDATE, inspect both sides: checking only NEW would permit moving a target
  -- out of an activated canary into a different held tuple and silently
  -- weakening the activated tuple's two-target seal.
  IF TG_OP = 'UPDATE' AND (
       NEW.machine_id IS DISTINCT FROM OLD.machine_id
       OR NEW.solver_version IS DISTINCT FROM OLD.solver_version
       OR NEW.solver_binary_checksum IS DISTINCT FROM OLD.solver_binary_checksum
       OR NEW.pipeline_commit IS DISTINCT FROM OLD.pipeline_commit
       OR NEW.manifest_version IS DISTINCT FROM OLD.manifest_version
       OR NEW.manifest_checksum IS DISTINCT FROM OLD.manifest_checksum
       OR NEW.target_role IS DISTINCT FROM OLD.target_role
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'TRAINING_SOLVER_CANARY_TARGETS_IMMUTABLE';
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT scope.admission_mode
    INTO v_mode
    FROM public.training_solver_ingest_scopes scope
    WHERE scope.machine_id = OLD.machine_id
      AND scope.solver_version = OLD.solver_version
      AND scope.solver_binary_checksum = OLD.solver_binary_checksum
      AND scope.pipeline_commit = OLD.pipeline_commit
      AND scope.manifest_version = OLD.manifest_version
      AND scope.manifest_checksum = OLD.manifest_checksum
    FOR UPDATE;
    IF NOT FOUND OR v_mode IS DISTINCT FROM 'held' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000', MESSAGE = 'TRAINING_SOLVER_CANARY_TARGETS_IMMUTABLE';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT scope.admission_mode
    INTO v_mode
    FROM public.training_solver_ingest_scopes scope
    WHERE scope.machine_id = NEW.machine_id
      AND scope.solver_version = NEW.solver_version
      AND scope.solver_binary_checksum = NEW.solver_binary_checksum
      AND scope.pipeline_commit = NEW.pipeline_commit
      AND scope.manifest_version = NEW.manifest_version
      AND scope.manifest_checksum = NEW.manifest_checksum
    FOR UPDATE;
    IF NOT FOUND OR v_mode IS DISTINCT FROM 'held' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000', MESSAGE = 'TRAINING_SOLVER_CANARY_TARGETS_IMMUTABLE';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NOT EXISTS (
    SELECT 1
    FROM public.solved_spots_gold artifact
    WHERE artifact.id = NEW.artifact_id
      AND artifact.scenario_hash = NEW.scenario_hash
      AND artifact.street = NEW.street
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503', MESSAGE = 'TRAINING_SOLVER_CANARY_TARGET_NOT_PREEXISTING';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_training_solver_canary_target_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS training_solver_canary_target_guard_v1
  ON public.training_solver_bounded_canary_targets;
CREATE TRIGGER training_solver_canary_target_guard_v1
BEFORE INSERT OR UPDATE OR DELETE
ON public.training_solver_bounded_canary_targets
FOR EACH ROW EXECUTE FUNCTION
  public.fn_training_solver_canary_target_guard_v1();

CREATE OR REPLACE FUNCTION public.fn_training_solver_scope_transition_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_parent_count integer;
  v_child_count integer;
  v_target_count integer;
  v_lineage_valid boolean;
BEGIN
  IF OLD.admission_mode IS DISTINCT FROM 'held'
     OR NEW.machine_id IS DISTINCT FROM OLD.machine_id
     OR NEW.solver_version IS DISTINCT FROM OLD.solver_version
     OR NEW.solver_binary_checksum IS DISTINCT FROM OLD.solver_binary_checksum
     OR NEW.pipeline_commit IS DISTINCT FROM OLD.pipeline_commit
     OR NEW.manifest_version IS DISTINCT FROM OLD.manifest_version
     OR NEW.manifest_checksum IS DISTINCT FROM OLD.manifest_checksum
     OR NEW.admission_mode NOT IN ('backlog', 'bounded_canary') THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'TRAINING_SOLVER_INGEST_SCOPE_IMMUTABLE';
  END IF;

  -- Serialize activation per physical worker. M1 and M2 intentionally use
  -- independent advisory keys, so either machine may run while the other does.
  -- Both backlog and bounded-canary transitions take this lock; otherwise two
  -- concurrent held->active transactions could each miss the other.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'training-solver-ingest-scope:' || OLD.machine_id,
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM public.training_solver_ingest_scopes other_scope
    JOIN public.training_solver_provenance_authority other_authority
      USING (
        machine_id, solver_version, solver_binary_checksum, pipeline_commit,
        manifest_version, manifest_checksum
      )
    WHERE other_scope.machine_id = OLD.machine_id
      AND other_scope.admission_mode IN ('backlog', 'bounded_canary')
      AND other_authority.retired_at IS NULL
      AND (
        other_scope.solver_version IS DISTINCT FROM OLD.solver_version
        OR other_scope.solver_binary_checksum IS DISTINCT FROM
          OLD.solver_binary_checksum
        OR other_scope.pipeline_commit IS DISTINCT FROM OLD.pipeline_commit
        OR other_scope.manifest_version IS DISTINCT FROM OLD.manifest_version
        OR other_scope.manifest_checksum IS DISTINCT FROM OLD.manifest_checksum
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'TRAINING_SOLVER_MACHINE_INGEST_SCOPE_ALREADY_ACTIVE';
  END IF;

  SELECT count(*), count(*) FILTER (WHERE target.target_role = 'parent'),
         count(*) FILTER (WHERE target.target_role = 'child')
  INTO v_target_count, v_parent_count, v_child_count
  FROM public.training_solver_bounded_canary_targets target
  WHERE target.machine_id = OLD.machine_id
    AND target.solver_version = OLD.solver_version
    AND target.solver_binary_checksum = OLD.solver_binary_checksum
    AND target.pipeline_commit = OLD.pipeline_commit
    AND target.manifest_version = OLD.manifest_version
    AND target.manifest_checksum = OLD.manifest_checksum;

  IF (NEW.admission_mode = 'backlog' AND v_target_count <> 0)
     OR (NEW.admission_mode = 'bounded_canary'
         AND (v_target_count <> 2 OR v_parent_count <> 1 OR v_child_count <> 1)) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'TRAINING_SOLVER_INGEST_SCOPE_TARGET_SET_INVALID';
  END IF;
  IF NEW.admission_mode = 'bounded_canary' THEN
    SELECT
      left(child.scenario_hash, char_length('turn_' || parent.scenario_hash)) =
        'turn_' || parent.scenario_hash
      AND char_length(child.scenario_hash) =
        char_length('turn_' || parent.scenario_hash) + 2
      AND right(child.scenario_hash, 2) ~ '^[2-9TJQKA][cdhs]$'
      AND starts_with(child.node, parent.node || ':')
      AND child.hero_position = parent.hero_position
    INTO v_lineage_valid
    FROM public.training_solver_bounded_canary_targets parent
    JOIN public.training_solver_bounded_canary_targets child
      ON child.machine_id = parent.machine_id
     AND child.solver_version = parent.solver_version
     AND child.solver_binary_checksum = parent.solver_binary_checksum
     AND child.pipeline_commit = parent.pipeline_commit
     AND child.manifest_version = parent.manifest_version
     AND child.manifest_checksum = parent.manifest_checksum
     AND child.target_role = 'child'
    WHERE parent.machine_id = OLD.machine_id
      AND parent.solver_version = OLD.solver_version
      AND parent.solver_binary_checksum = OLD.solver_binary_checksum
      AND parent.pipeline_commit = OLD.pipeline_commit
      AND parent.manifest_version = OLD.manifest_version
      AND parent.manifest_checksum = OLD.manifest_checksum
      AND parent.target_role = 'parent';
    IF v_lineage_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'TRAINING_SOLVER_CANARY_LINEAGE_INVALID';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_training_solver_scope_transition_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS training_solver_scope_transition_guard_v1
  ON public.training_solver_ingest_scopes;
CREATE TRIGGER training_solver_scope_transition_guard_v1
BEFORE UPDATE ON public.training_solver_ingest_scopes
FOR EACH ROW EXECUTE FUNCTION
  public.fn_training_solver_scope_transition_guard_v1();

CREATE OR REPLACE FUNCTION public.fn_training_solver_scope_insert_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NEW.admission_mode IS DISTINCT FROM 'held' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000', MESSAGE = 'TRAINING_SOLVER_NEW_SCOPE_MUST_BE_HELD';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_training_solver_scope_insert_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS training_solver_scope_insert_guard_v1
  ON public.training_solver_ingest_scopes;
CREATE TRIGGER training_solver_scope_insert_guard_v1
BEFORE INSERT ON public.training_solver_ingest_scopes
FOR EACH ROW EXECUTE FUNCTION public.fn_training_solver_scope_insert_guard_v1();

CREATE OR REPLACE FUNCTION public.fn_training_solver_ingest_scope_guard_v1(
  p_machine_id text,
  p_solver_version text,
  p_solver_binary_checksum text,
  p_pipeline_commit text,
  p_manifest_version text,
  p_manifest_checksum text,
  p_artifact jsonb
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_mode text;
  v_target_count integer;
  v_target_matches boolean;
BEGIN
  SELECT scope.admission_mode
  INTO v_mode
  FROM public.training_solver_ingest_scopes scope
  JOIN public.training_solver_provenance_authority authority
    ON authority.machine_id = scope.machine_id
   AND authority.solver_version = scope.solver_version
   AND authority.solver_binary_checksum = scope.solver_binary_checksum
   AND authority.pipeline_commit = scope.pipeline_commit
   AND authority.manifest_version = scope.manifest_version
   AND authority.manifest_checksum = scope.manifest_checksum
   AND authority.retired_at IS NULL
  WHERE scope.machine_id = p_machine_id
    AND scope.solver_version = p_solver_version
    AND scope.solver_binary_checksum = p_solver_binary_checksum
    AND scope.pipeline_commit = p_pipeline_commit
    AND scope.manifest_version = p_manifest_version
    AND scope.manifest_checksum = p_manifest_checksum
  FOR SHARE OF scope;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'SOLVER_WORKER_INGEST_SCOPE_MISSING';
  END IF;
  IF v_mode = 'backlog' THEN
    RETURN;
  END IF;
  IF v_mode IS DISTINCT FROM 'bounded_canary' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'SOLVER_WORKER_INGEST_SCOPE_INVALID';
  END IF;

  SELECT count(*), coalesce(bool_or(
    target.artifact_id::text = p_artifact ->> 'id'
    AND target.scenario_hash = p_artifact ->> 'scenario_hash'
    AND target.street = p_artifact ->> 'street'
    AND target.node = p_artifact -> 'strategy_matrix_v2' ->> 'node'
    AND target.hero_position =
      p_artifact -> 'strategy_matrix_v2' ->> 'position'
  ), false)
  INTO v_target_count, v_target_matches
  FROM public.training_solver_bounded_canary_targets target
  WHERE target.machine_id = p_machine_id
    AND target.solver_version = p_solver_version
    AND target.solver_binary_checksum = p_solver_binary_checksum
    AND target.pipeline_commit = p_pipeline_commit
    AND target.manifest_version = p_manifest_version
    AND target.manifest_checksum = p_manifest_checksum;
  IF v_target_count <> 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'SOLVER_WORKER_CANARY_SCOPE_INCOMPLETE';
  END IF;
  IF NOT v_target_matches THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'SOLVER_WORKER_CANARY_TARGET_NOT_AUTHORIZED';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_training_solver_ingest_scope_guard_v1(
  text, text, text, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the API's stable RPC name while moving the previously audited
-- implementation behind an owner-only internal name. The new wrapper performs
-- the server authority check in the same database statement and transaction.
DO $wrap_solver_ingest$
BEGIN
  IF to_regprocedure(
       'public.training_ingest_solver_artifact_unscoped_v1(text,text,text,text,text,text,uuid,timestamp with time zone,text,jsonb)'
     ) IS NULL THEN
    ALTER FUNCTION public.training_ingest_solver_artifact_v1(
      text, text, text, text, text, text, uuid, timestamptz, text, jsonb
    ) RENAME TO training_ingest_solver_artifact_unscoped_v1;
  END IF;
END;
$wrap_solver_ingest$;

REVOKE ALL ON FUNCTION public.training_ingest_solver_artifact_unscoped_v1(
  text, text, text, text, text, text, uuid, timestamptz, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role CASCADE;

-- ALTER FUNCTION RENAME preserves the original function ACL. Do not assume
-- the four application roles above were the only historical grantees: remove
-- every explicit EXECUTE grantee except the function owner so no custom role
-- can retain a direct path around the new scope-enforcing wrapper.
DO $normalize_unscoped_solver_ingest_acl$
DECLARE
  v_function_oid pg_catalog.oid := pg_catalog.to_regprocedure(
    'public.training_ingest_solver_artifact_unscoped_v1(text,text,text,text,text,text,uuid,timestamp with time zone,text,jsonb)'
  );
  v_grantee pg_catalog.oid;
  v_grantee_name name;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT expanded_acl.grantee
    FROM pg_catalog.pg_proc function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) expanded_acl
    WHERE function_row.oid = v_function_oid
      AND expanded_acl.privilege_type = 'EXECUTE'
      AND expanded_acl.grantee <> function_row.proowner
  LOOP
    IF v_grantee = 0 THEN
      EXECUTE
        'REVOKE ALL PRIVILEGES ON FUNCTION public.training_ingest_solver_artifact_unscoped_v1(text,text,text,text,text,text,uuid,timestamptz,text,jsonb) FROM PUBLIC CASCADE';
    ELSE
      SELECT role_row.rolname
      INTO STRICT v_grantee_name
      FROM pg_catalog.pg_roles role_row
      WHERE role_row.oid = v_grantee;
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.training_ingest_solver_artifact_unscoped_v1(text,text,text,text,text,text,uuid,timestamptz,text,jsonb) FROM %I CASCADE',
        v_grantee_name
      );
    END IF;
  END LOOP;
END;
$normalize_unscoped_solver_ingest_acl$;

CREATE OR REPLACE FUNCTION public.training_ingest_solver_artifact_v1(
  p_machine_id text,
  p_solver_version text,
  p_solver_binary_checksum text,
  p_pipeline_commit text,
  p_manifest_version text,
  p_manifest_checksum text,
  p_nonce uuid,
  p_signed_at timestamptz,
  p_body_sha256 text,
  p_artifact jsonb
)
RETURNS TABLE(
  artifact_id uuid,
  scenario_hash text,
  source_artifact_checksum text,
  replayed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  PERFORM public.fn_training_solver_ingest_scope_guard_v1(
    p_machine_id,
    p_solver_version,
    p_solver_binary_checksum,
    p_pipeline_commit,
    p_manifest_version,
    p_manifest_checksum,
    p_artifact
  );
  RETURN QUERY
  SELECT ingest.artifact_id,
         ingest.scenario_hash,
         ingest.source_artifact_checksum,
         ingest.replayed
  FROM public.training_ingest_solver_artifact_unscoped_v1(
    p_machine_id,
    p_solver_version,
    p_solver_binary_checksum,
    p_pipeline_commit,
    p_manifest_version,
    p_manifest_checksum,
    p_nonce,
    p_signed_at,
    p_body_sha256,
    p_artifact
  ) ingest;
END;
$function$;

REVOKE ALL ON FUNCTION public.training_ingest_solver_artifact_v1(
  text, text, text, text, text, text, uuid, timestamptz, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.training_ingest_solver_artifact_v1(
  text, text, text, text, text, text, uuid, timestamptz, text, jsonb
) TO service_role;

-- Return the exact persisted decision node and hero position. Resume code may
-- skip an admitted target only after both fields match the sealed target.
DROP FUNCTION IF EXISTS public.training_solver_worker_row_states_v2(
  text, text, text, text, text, text, text[]
);
DROP FUNCTION public.training_solver_worker_row_states_v1(text[]);
CREATE FUNCTION public.training_solver_worker_row_states_v1(
  p_scenario_hashes text[]
)
RETURNS TABLE(
  id uuid,
  scenario_hash text,
  game_type text,
  stack_depth integer,
  street text,
  node text,
  hero_position text,
  solved_v2_at timestamptz,
  quality_status text,
  solver_version text,
  solver_binary_checksum text,
  machine_id text,
  pipeline_commit text,
  manifest_version text,
  manifest_checksum text,
  source_artifact_checksum text,
  audited_at timestamptz,
  admitted boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
ROWS 150
AS $function$
  WITH requested AS MATERIALIZED (
    SELECT DISTINCT requested_hash.value AS scenario_hash
    FROM unnest(
      CASE
        WHEN cardinality(p_scenario_hashes) BETWEEN 1 AND 75
        THEN p_scenario_hashes
        ELSE ARRAY[]::text[]
      END
    ) AS requested_hash(value)
    WHERE char_length(requested_hash.value) BETWEEN 1 AND 512
  )
  SELECT
    artifact.id,
    artifact.scenario_hash,
    artifact.game_type,
    artifact.stack_depth,
    artifact.street,
    artifact.strategy_matrix_v2 ->> 'node' AS node,
    artifact.strategy_matrix_v2 ->> 'position' AS hero_position,
    artifact.solved_v2_at,
    artifact.quality_status,
    artifact.solver_version,
    artifact.solver_binary_checksum,
    artifact.machine_id,
    artifact.pipeline_commit,
    artifact.manifest_version,
    artifact.manifest_checksum,
    artifact.source_artifact_checksum,
    artifact.audited_at,
    EXISTS (
      SELECT 1
      FROM public.training_solver_artifact_catalog catalog
      JOIN public.training_solver_provenance_authority authority
        ON authority.machine_id = artifact.machine_id
       AND authority.solver_version = artifact.solver_version
       AND authority.solver_binary_checksum = artifact.solver_binary_checksum
       AND authority.pipeline_commit = artifact.pipeline_commit
       AND authority.manifest_version = artifact.manifest_version
       AND authority.manifest_checksum = artifact.manifest_checksum
       AND authority.source_combo_order_sha256 =
         artifact.strategy_matrix_v2 ->> 'source_combo_order_sha256'
       AND authority.training_game_contracts_sha256 =
         artifact.strategy_matrix_v2 ->> 'training_game_contracts_sha256'
       AND authority.retired_at IS NULL
      WHERE catalog.artifact_id = artifact.id
        AND catalog.scenario_hash = artifact.scenario_hash
        AND catalog.game_type = artifact.game_type
        AND catalog.stack_depth = artifact.stack_depth
        AND catalog.street = artifact.street
        AND catalog.hero_position = artifact.strategy_matrix_v2 ->> 'position'
    ) AS admitted
  FROM requested
  JOIN public.solved_spots_gold artifact
    ON artifact.scenario_hash = requested.scenario_hash
  ORDER BY artifact.scenario_hash, artifact.id
  LIMIT 150
$function$;

REVOKE ALL ON FUNCTION public.training_solver_worker_row_states_v1(text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.training_solver_worker_row_states_v1(text[])
  TO service_role;

-- Caller-bound state proof for the Windows worker. This extends the persisted
-- row state with the immutable server admission scope and the exact authorized
-- target node/position. A canary runner must receive canary_authorized=true for
-- both sealed identities before starting Pio and again after admission.
CREATE OR REPLACE FUNCTION public.training_solver_worker_row_states_v2(
  p_machine_id text,
  p_solver_version text,
  p_solver_binary_checksum text,
  p_pipeline_commit text,
  p_manifest_version text,
  p_manifest_checksum text,
  p_scenario_hashes text[]
)
RETURNS TABLE(
  id uuid,
  scenario_hash text,
  game_type text,
  stack_depth integer,
  street text,
  node text,
  hero_position text,
  solved_v2_at timestamptz,
  quality_status text,
  solver_version text,
  solver_binary_checksum text,
  machine_id text,
  pipeline_commit text,
  manifest_version text,
  manifest_checksum text,
  source_artifact_checksum text,
  audited_at timestamptz,
  admitted boolean,
  admission_mode text,
  partition_count integer,
  partition_index integer,
  canary_target_role text,
  authorized_node text,
  authorized_hero_position text,
  canary_authorized boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
ROWS 150
AS $function$
  WITH caller_scope AS MATERIALIZED (
    SELECT scope.*
    FROM public.training_solver_ingest_scopes scope
    JOIN public.training_solver_provenance_authority authority
      ON authority.machine_id = scope.machine_id
     AND authority.solver_version = scope.solver_version
     AND authority.solver_binary_checksum = scope.solver_binary_checksum
     AND authority.pipeline_commit = scope.pipeline_commit
     AND authority.manifest_version = scope.manifest_version
     AND authority.manifest_checksum = scope.manifest_checksum
     AND authority.retired_at IS NULL
    WHERE scope.machine_id = p_machine_id
      AND scope.solver_version = p_solver_version
      AND scope.solver_binary_checksum = p_solver_binary_checksum
      AND scope.pipeline_commit = p_pipeline_commit
      AND scope.manifest_version = p_manifest_version
      AND scope.manifest_checksum = p_manifest_checksum
  ), target_count AS MATERIALIZED (
    SELECT count(*)::integer AS value
    FROM public.training_solver_bounded_canary_targets target
    JOIN caller_scope scope
      ON scope.machine_id = target.machine_id
     AND scope.solver_version = target.solver_version
     AND scope.solver_binary_checksum = target.solver_binary_checksum
     AND scope.pipeline_commit = target.pipeline_commit
     AND scope.manifest_version = target.manifest_version
     AND scope.manifest_checksum = target.manifest_checksum
  ), row_state AS MATERIALIZED (
    SELECT *
    FROM public.training_solver_worker_row_states_v1(p_scenario_hashes)
  )
  SELECT
    row_state.id, row_state.scenario_hash, row_state.game_type,
    row_state.stack_depth, row_state.street, row_state.node,
    row_state.hero_position, row_state.solved_v2_at,
    row_state.quality_status, row_state.solver_version,
    row_state.solver_binary_checksum, row_state.machine_id,
    row_state.pipeline_commit, row_state.manifest_version,
    row_state.manifest_checksum, row_state.source_artifact_checksum,
    row_state.audited_at, row_state.admitted,
    scope.admission_mode, scope.partition_count, scope.partition_index,
    target.target_role, target.node, target.hero_position,
    coalesce(
      scope.admission_mode = 'bounded_canary'
      AND target_count.value = 2
      AND target.target_role IN ('parent', 'child'),
      false
    ) AS canary_authorized
  FROM row_state
  LEFT JOIN caller_scope scope ON true
  LEFT JOIN target_count ON true
  LEFT JOIN public.training_solver_bounded_canary_targets target
    ON target.machine_id = scope.machine_id
   AND target.solver_version = scope.solver_version
   AND target.solver_binary_checksum = scope.solver_binary_checksum
   AND target.pipeline_commit = scope.pipeline_commit
   AND target.manifest_version = scope.manifest_version
   AND target.manifest_checksum = scope.manifest_checksum
   AND target.artifact_id = row_state.id
   AND target.scenario_hash = row_state.scenario_hash
   AND target.street = row_state.street
  ORDER BY row_state.scenario_hash, row_state.id
  LIMIT 150
$function$;

REVOKE ALL ON FUNCTION public.training_solver_worker_row_states_v2(
  text, text, text, text, text, text, text[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.training_solver_worker_row_states_v2(
  text, text, text, text, text, text, text[]
) TO service_role;

DO $bounded_canary_contract_assertions$
DECLARE
  v_wrapper_definition text;
  v_row_states_definition text;
  v_row_states_v2_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.training_ingest_solver_artifact_v1(text,text,text,text,text,text,uuid,timestamp with time zone,text,jsonb)'::regprocedure
  ) INTO v_wrapper_definition;
  SELECT pg_get_functiondef(
    'public.training_solver_worker_row_states_v1(text[])'::regprocedure
  ) INTO v_row_states_definition;
  SELECT pg_get_functiondef(
    'public.training_solver_worker_row_states_v2(text,text,text,text,text,text,text[])'::regprocedure
  ) INTO v_row_states_v2_definition;
  IF to_regclass('public.training_solver_ingest_scopes') IS NULL
     OR to_regclass('public.training_solver_bounded_canary_targets') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger trigger_row
       WHERE trigger_row.tgrelid =
         'public.training_solver_provenance_authority'::regclass
         AND trigger_row.tgname =
           'training_solver_provenance_reactivation_guard_v1'
         AND trigger_row.tgfoid =
           'public.fn_training_solver_provenance_reactivation_guard_v1()'::regprocedure
         AND trigger_row.tgenabled = 'O'
         AND NOT trigger_row.tgisinternal
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.training_ingest_solver_artifact_v1(text,text,text,text,text,text,uuid,timestamp with time zone,text,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.training_ingest_solver_artifact_unscoped_v1(text,text,text,text,text,text,uuid,timestamp with time zone,text,jsonb)',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         coalesce(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) expanded_acl
       WHERE function_row.oid =
         'public.training_ingest_solver_artifact_unscoped_v1(text,text,text,text,text,text,uuid,timestamp with time zone,text,jsonb)'::regprocedure
         AND expanded_acl.privilege_type = 'EXECUTE'
         AND expanded_acl.grantee <> function_row.proowner
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_training_solver_ingest_scope_guard_v1(text,text,text,text,text,text,jsonb)',
       'EXECUTE'
     )
     OR has_table_privilege(
       'service_role', 'public.training_solver_ingest_scopes', 'SELECT'
     )
     OR has_table_privilege(
       'service_role', 'public.training_solver_bounded_canary_targets', 'SELECT'
     )
     OR has_table_privilege(
       'service_role', 'public.training_solver_scope_migration_state', 'SELECT'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.training_solver_worker_row_states_v2(text,text,text,text,text,text,text[])',
       'EXECUTE'
     )
     OR position('fn_training_solver_ingest_scope_guard_v1' IN v_wrapper_definition) = 0
     OR position('training_ingest_solver_artifact_unscoped_v1' IN v_wrapper_definition) = 0
     OR position(
       'artifact.strategy_matrix_v2 ->> ''node''' IN v_row_states_definition
     ) = 0
     OR position(
       'artifact.strategy_matrix_v2 ->> ''position''' IN v_row_states_definition
     ) = 0
     OR position('training_solver_bounded_canary_targets' IN
       v_row_states_v2_definition) = 0
     OR position('canary_authorized' IN v_row_states_v2_definition) = 0 THEN
    RAISE EXCEPTION 'TRAINING_SOLVER_BOUNDED_CANARY_CONTRACT_INCOMPLETE';
  END IF;
END;
$bounded_canary_contract_assertions$;

COMMIT;
