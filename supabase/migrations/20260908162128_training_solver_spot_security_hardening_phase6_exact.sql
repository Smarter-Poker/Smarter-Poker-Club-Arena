-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260908162128; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260908162128   (the stamp IS the apply time, UTC: 2026-09-08 16:21:28)
--   name        training_solver_spot_security_hardening_phase6_exact
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 62287 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260908162128 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        training_solver_provenance_authority_invalidate_v1
--     FUNCTION       public.fn_training_solver_artifact_servable_v2, public.fn_training_solver_artifact_catalog_sync_v1, public.fn_training_solver_provenance_authority_invalidate_v1, public.training_solver_spot_candidates_v1, public.analyze_spots_by_game_type
--     TABLE          public.training_solver_provenance_authority, must
--     INDEX          idx_training_solver_provenance_authority_active, idx_training_solver_artifact_catalog_family_cursor, idx_training_solver_artifact_catalog_family_position_cursor, idx_training_solver_artifact_catalog_family_stack_cursor, idx_training_solver_artifact_catalog_exact_cursor
--     DROP           TRIGGER training_solver_provenance_authority_invalidate_v1, INDEX public.idx_training_solver_artifact_catalog_filter, INDEX public.idx_training_solver_artifact_catalog_family_cursor, INDEX public.idx_training_solver_artifact_catalog_family_position_cursor, INDEX public.idx_training_solver_artifact_catalog_family_stack_cursor, INDEX public.idx_training_solver_artifact_catalog_exact_cursor
--     RLS-ENABLE     
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- Phase 6 follow-up: a catalog row is a serving authority, not merely an
-- optimization hint.  Require a complete, internally consistent solver
-- payload and a centrally approved provenance tuple before a future warehouse
-- write can enter Spot Study.  Also close a legacy authenticated RPC that can
-- aggregate the 80 GB warehouse directly.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- This migration turns the small catalog into an active serving authority and
-- uses artifact_id as an ON CONFLICT arbiter. Revalidate the complete durable
-- shape before installing the active sync, even when the predecessor migration
-- was applied separately or the object was pre-created.
DO $assert_solver_artifact_catalog_shape$
DECLARE
  catalog_oid pg_catalog.oid := pg_catalog.to_regclass(
    'public.training_solver_artifact_catalog'
  );
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class class_row
       WHERE class_row.oid = catalog_oid
         AND class_row.relkind = 'r'
         AND class_row.relpersistence = 'p'
     )
     OR (
       SELECT count(*)
       FROM pg_catalog.pg_attribute attribute_row
       WHERE attribute_row.attrelid = catalog_oid
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
     ) <> 8
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('artifact_id', 1, 'uuid', true, NULL::text, false),
         ('scenario_hash', 2, 'text', true, NULL::text, true),
         ('game_type', 3, 'text', true, NULL::text, true),
         ('stack_depth', 4, 'integer', true, NULL::text, false),
         ('street', 5, 'text', true, NULL::text, true),
         ('hero_position', 6, 'text', true, NULL::text, true),
         ('registered_at', 7, 'timestamp with time zone', true, 'now()'::text, false),
         ('updated_at', 8, 'timestamp with time zone', true, 'now()'::text, false)
       ) AS expected(
         attname, attnum, type_name, attnotnull, default_expr,
         uses_default_collation
       )
       LEFT JOIN pg_catalog.pg_attribute actual
         ON actual.attrelid = catalog_oid
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
          OR actual.attcollation IS DISTINCT FROM CASE
               WHEN expected.uses_default_collation
                 THEN pg_catalog.to_regcollation('pg_catalog.default')::pg_catalog.oid
               ELSE 0::pg_catalog.oid
             END
     )
     OR (
       SELECT count(*)
       FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = catalog_oid
     ) <> 8
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = catalog_oid
         AND constraint_row.conname = 'training_solver_artifact_catalog_pkey'
         AND constraint_row.contype = 'p'
         AND constraint_row.convalidated
         AND NOT constraint_row.condeferrable
         AND NOT constraint_row.condeferred
         AND constraint_row.conkey = ARRAY[1]::smallint[]
         AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
             = 'PRIMARY KEY (artifact_id)'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = catalog_oid
         AND constraint_row.conname =
             'training_solver_artifact_catalog_scenario_hash_key'
         AND constraint_row.contype = 'u'
         AND constraint_row.convalidated
         AND NOT constraint_row.condeferrable
         AND NOT constraint_row.condeferred
         AND constraint_row.conkey = ARRAY[2]::smallint[]
         AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
             = 'UNIQUE (scenario_hash)'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = catalog_oid
         AND constraint_row.conname =
             'training_solver_artifact_catalog_artifact_id_fkey'
         AND constraint_row.contype = 'f'
         AND constraint_row.convalidated
         AND NOT constraint_row.condeferrable
         AND NOT constraint_row.condeferred
         AND constraint_row.conkey = ARRAY[1]::smallint[]
         AND constraint_row.confrelid = 'public.solved_spots_gold'::pg_catalog.regclass
         AND constraint_row.confkey = ARRAY[
           (SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute attribute_row
            WHERE attribute_row.attrelid =
                  'public.solved_spots_gold'::pg_catalog.regclass
              AND attribute_row.attname = 'id'
              AND NOT attribute_row.attisdropped)
         ]::smallint[]
         AND constraint_row.confupdtype = 'a'
         AND constraint_row.confdeltype = 'c'
         AND constraint_row.confmatchtype = 's'
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('training_solver_artifact_catalog_scenario_check',
          '((char_length(scenario_hash) >= 1) AND (char_length(scenario_hash) <= 512))'),
         ('training_solver_artifact_catalog_stack_check',
          '(stack_depth > 0)'),
         ('training_solver_artifact_catalog_contract_check',
          $$(((game_type = 'hu_cash'::text) AND (stack_depth = ANY (ARRAY[40, 100, 200]))) OR ((game_type = 'mtt_3max_chipev'::text) AND (stack_depth = 20)) OR ((game_type = 'mtt_6max_chipev'::text) AND (stack_depth = ANY (ARRAY[10, 20, 40, 100]))) OR ((game_type = 'mtt_6max_icm'::text) AND (stack_depth = ANY (ARRAY[20, 40]))) OR ((game_type = 'mtt_9max_chipev'::text) AND (stack_depth = ANY (ARRAY[20, 40, 80, 100]))) OR ((game_type = 'mtt_9max_icm'::text) AND (stack_depth = ANY (ARRAY[40, 60]))) OR ((game_type = 'mtt_hu_chipev'::text) AND (stack_depth = 40)) OR ((game_type = 'postflop_complete'::text) AND (stack_depth = 100)) OR ((game_type = 'spin_3max_chipev'::text) AND (stack_depth = ANY (ARRAY[20, 25]))) OR ((game_type = 'spin_3max_icm'::text) AND (stack_depth = ANY (ARRAY[20, 25]))) OR ((game_type = 'spin_hu_chipev'::text) AND (stack_depth = ANY (ARRAY[10, 20]))) OR ((game_type = 'spin_hu_icm'::text) AND (stack_depth = 10)))$$),
         ('training_solver_artifact_catalog_street_check',
          $$(street = ANY (ARRAY['flop'::text, 'turn'::text, 'river'::text]))$$),
         ('training_solver_artifact_catalog_position_check',
          $$(hero_position = ANY (ARRAY['UTG'::text, 'UTG+1'::text, 'UTG+2'::text, 'UTG1'::text, 'UTG2'::text, 'MP'::text, 'MP+1'::text, 'MP+2'::text, 'MP1'::text, 'MP2'::text, 'LJ'::text, 'HJ'::text, 'CO'::text, 'BTN'::text, 'SB'::text, 'BB'::text]))$$)
       ) AS expected(conname, expression)
       LEFT JOIN pg_catalog.pg_constraint actual
         ON actual.conrelid = catalog_oid
        AND actual.conname = expected.conname
        AND actual.contype = 'c'
       WHERE actual.oid IS NULL
          OR NOT actual.convalidated
          OR actual.connoinherit
          OR pg_catalog.pg_get_expr(actual.conbin, actual.conrelid)
             IS DISTINCT FROM expected.expression
     ) THEN
    RAISE EXCEPTION 'TRAINING_SOLVER_ARTIFACT_CATALOG_CONTRACT_INCOMPLETE';
  END IF;
END;
$assert_solver_artifact_catalog_shape$;

CREATE TABLE IF NOT EXISTS public.training_solver_provenance_authority (
  machine_id text NOT NULL,
  solver_version text NOT NULL,
  solver_binary_checksum text NOT NULL,
  pipeline_commit text NOT NULL,
  manifest_version text NOT NULL,
  manifest_checksum text NOT NULL,
  source_combo_order_sha256 text NOT NULL,
  training_game_contracts_sha256 text NOT NULL,
  manifest_contracts jsonb NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  approved_by text NOT NULL,
  retired_at timestamptz,
  CONSTRAINT training_solver_provenance_authority_pkey PRIMARY KEY (
    machine_id,
    solver_version,
    solver_binary_checksum,
    pipeline_commit,
    manifest_version,
    manifest_checksum
  ),
  CONSTRAINT training_solver_provenance_authority_machine_check
    CHECK (machine_id IN ('M1', 'M2')),
  CONSTRAINT training_solver_provenance_authority_solver_checksum_check
    CHECK (solver_binary_checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT training_solver_provenance_authority_pipeline_check
    CHECK (pipeline_commit ~ '^[0-9a-f]{40}$'),
  CONSTRAINT training_solver_provenance_authority_manifest_checksum_check
    CHECK (manifest_checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT training_solver_provenance_authority_source_order_check
    CHECK (
      source_combo_order_sha256 ~ '^[0-9a-f]{64}$'
      AND source_combo_order_sha256 <> repeat('0', 64)
    ),
  CONSTRAINT training_solver_provenance_authority_game_scope_check
    CHECK (
      training_game_contracts_sha256 ~ '^[0-9a-f]{64}$'
      AND training_game_contracts_sha256 <> repeat('0', 64)
    ),
  CONSTRAINT training_solver_provenance_authority_contracts_check CHECK (
    CASE WHEN jsonb_typeof(manifest_contracts) = 'array'
      THEN jsonb_array_length(manifest_contracts) BETWEEN 1 AND 64
      ELSE false
    END
  ),
  CONSTRAINT training_solver_provenance_authority_labels_check
    CHECK (
      char_length(btrim(solver_version)) BETWEEN 1 AND 120
      AND char_length(btrim(manifest_version)) BETWEEN 1 AND 160
      AND char_length(btrim(approved_by)) BETWEEN 3 AND 200
    ),
  CONSTRAINT training_solver_provenance_authority_retirement_check
    CHECK (retired_at IS NULL OR retired_at >= approved_at)
);

COMMENT ON TABLE public.training_solver_provenance_authority IS
  'Migration-administered allowlist of exact solver binary, pipeline, manifest, and machine tuples eligible for Training catalog admission. Empty is deliberately fail-closed.';

ALTER TABLE public.training_solver_provenance_authority ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.training_solver_provenance_authority
  FROM PUBLIC, anon, authenticated, service_role;
DO $revoke_authority_columns$
DECLARE
  v_columns text;
BEGIN
  SELECT string_agg(quote_ident(attribute_row.attname), ',' ORDER BY attribute_row.attnum)
  INTO v_columns
  FROM pg_attribute attribute_row
  WHERE attribute_row.attrelid = 'public.training_solver_provenance_authority'::regclass
    AND attribute_row.attnum > 0
    AND NOT attribute_row.attisdropped;
  IF v_columns IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%s) ON TABLE public.training_solver_provenance_authority FROM PUBLIC, anon, authenticated, service_role',
      v_columns
    );
  END IF;
END;
$revoke_authority_columns$;

-- CREATE TABLE IF NOT EXISTS must never silently bless an object created with
-- the same name but a weaker schema.  Reject any pre-existing wrong shape
-- before functions or indexes begin depending on it.
DO $assert_authority_shape$
DECLARE
  authority_oid pg_catalog.oid := pg_catalog.to_regclass(
    'public.training_solver_provenance_authority'
  );
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class class_row
       WHERE class_row.oid = authority_oid
         AND class_row.relkind = 'r'
     )
     OR (
       SELECT count(*)
       FROM pg_catalog.pg_attribute attribute_row
       WHERE attribute_row.attrelid = authority_oid
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
     ) <> 12
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('machine_id', 1, 'text', true, NULL::text),
         ('solver_version', 2, 'text', true, NULL::text),
         ('solver_binary_checksum', 3, 'text', true, NULL::text),
         ('pipeline_commit', 4, 'text', true, NULL::text),
         ('manifest_version', 5, 'text', true, NULL::text),
         ('manifest_checksum', 6, 'text', true, NULL::text),
         ('source_combo_order_sha256', 7, 'text', true, NULL::text),
         ('training_game_contracts_sha256', 8, 'text', true, NULL::text),
         ('manifest_contracts', 9, 'jsonb', true, NULL::text),
         ('approved_at', 10, 'timestamp with time zone', true, 'now()'::text),
         ('approved_by', 11, 'text', true, NULL::text),
         ('retired_at', 12, 'timestamp with time zone', false, NULL::text)
       ) AS expected(attname, attnum, type_name, attnotnull, default_expr)
       LEFT JOIN pg_catalog.pg_attribute actual
         ON actual.attrelid = authority_oid
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
     OR (
       SELECT count(*)
       FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = authority_oid
     ) <> 10
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = authority_oid
         AND constraint_row.conname =
           'training_solver_provenance_authority_pkey'
         AND constraint_row.contype = 'p'
         AND constraint_row.convalidated
         AND constraint_row.conkey = ARRAY[1, 2, 3, 4, 5, 6]::smallint[]
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('training_solver_provenance_authority_machine_check',
          $$CHECK ((machine_id = ANY (ARRAY['M1'::text, 'M2'::text])))$$),
         ('training_solver_provenance_authority_solver_checksum_check',
          $$CHECK ((solver_binary_checksum ~ '^[0-9a-f]{64}$'::text))$$),
         ('training_solver_provenance_authority_pipeline_check',
          $$CHECK ((pipeline_commit ~ '^[0-9a-f]{40}$'::text))$$),
         ('training_solver_provenance_authority_manifest_checksum_check',
          $$CHECK ((manifest_checksum ~ '^[0-9a-f]{64}$'::text))$$),
         ('training_solver_provenance_authority_source_order_check',
          $$CHECK (((source_combo_order_sha256 ~ '^[0-9a-f]{64}$'::text) AND (source_combo_order_sha256 <> repeat('0'::text, 64))))$$),
         ('training_solver_provenance_authority_game_scope_check',
          $$CHECK (((training_game_contracts_sha256 ~ '^[0-9a-f]{64}$'::text) AND (training_game_contracts_sha256 <> repeat('0'::text, 64))))$$),
         ('training_solver_provenance_authority_contracts_check',
          $$CHECK ( CASE WHEN (jsonb_typeof(manifest_contracts) = 'array'::text) THEN ((jsonb_array_length(manifest_contracts) >= 1) AND (jsonb_array_length(manifest_contracts) <= 64)) ELSE false END)$$),
         ('training_solver_provenance_authority_labels_check',
          $$CHECK ((((char_length(btrim(solver_version)) >= 1) AND (char_length(btrim(solver_version)) <= 120)) AND ((char_length(btrim(manifest_version)) >= 1) AND (char_length(btrim(manifest_version)) <= 160)) AND ((char_length(btrim(approved_by)) >= 3) AND (char_length(btrim(approved_by)) <= 200))))$$),
         ('training_solver_provenance_authority_retirement_check',
          $$CHECK (((retired_at IS NULL) OR (retired_at >= approved_at)))$$)
       ) expected(conname, definition)
       LEFT JOIN pg_catalog.pg_constraint actual
         ON actual.conrelid = authority_oid
        AND actual.conname = expected.conname
        AND actual.contype = 'c'
       WHERE actual.oid IS NULL
          OR NOT actual.convalidated
          OR pg_catalog.btrim(pg_catalog.regexp_replace(
               pg_catalog.pg_get_constraintdef(actual.oid, false),
               '[[:space:]]+', ' ', 'g'
             )) IS DISTINCT FROM expected.definition
     ) THEN
    RAISE EXCEPTION 'TRAINING_SOLVER_PROVENANCE_AUTHORITY_CONTRACT_INCOMPLETE';
  END IF;
END;
$assert_authority_shape$;

CREATE INDEX IF NOT EXISTS idx_training_solver_provenance_authority_active
  ON public.training_solver_provenance_authority (
    machine_id,
    solver_binary_checksum,
    pipeline_commit,
    manifest_checksum
  )
  WHERE retired_at IS NULL;

CREATE OR REPLACE FUNCTION public.fn_training_solver_artifact_servable_v2(
  p_scenario_hash text,
  p_game_type text,
  p_stack_depth integer,
  p_street text,
  p_matrix jsonb,
  p_solver_version text,
  p_solver_binary_checksum text,
  p_machine_id text,
  p_pipeline_commit text,
  p_manifest_version text,
  p_manifest_checksum text,
  p_source_artifact_checksum text,
  p_quality_status text,
  p_audited_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_action jsonb;
  v_action_code text;
  v_action_codes text[] := ARRAY[]::text[];
  v_action_count integer;
  v_action_targets numeric[] := ARRAY[]::numeric[];
  v_accuracy_fraction numeric;
  v_achieved_exploitability_chips numeric;
  v_achieved_exploitability_fraction numeric;
  v_actor integer := 1;
  v_board text[];
  v_board_count integer;
  v_contributions numeric[] := ARRAY[0::numeric, 0::numeric];
  v_expected_hash text;
  v_frequency jsonb;
  v_frequency_key_count integer;
  v_frequency_value numeric;
  v_hand_ev jsonb;
  v_high_card text;
  v_high_card_index integer;
  v_index integer;
  v_live_combos integer := 0;
  v_last_full_raise numeric := 0;
  v_low_card text;
  v_low_card_index integer;
  v_node_tokens text[];
  v_numeric numeric;
  v_runout text[] := ARRAY[]::text[];
  v_runout_count integer;
  v_round_state text := 'open';
  v_raise_size numeric;
  v_raise_reopened boolean := true;
  v_street_baseline numeric := 0;
  v_starting_pot_chips numeric;
  v_sum numeric;
  v_summary_field text;
  v_target numeric;
  v_token text;
  v_token_index integer;
  v_wager_is_all_in boolean := false;
BEGIN
  IF p_scenario_hash IS NULL
     OR char_length(p_scenario_hash) NOT BETWEEN 1 AND 512
     OR p_game_type IS NULL
     OR p_stack_depth IS NULL
     OR p_stack_depth <= 0
     OR p_street NOT IN ('flop', 'turn', 'river')
     -- ICM rows cannot be admitted until the warehouse persists a payout
     -- vector, field/stack state, objective, and a seal binding those inputs.
     OR p_game_type LIKE '%\_icm' ESCAPE '\'
     OR jsonb_typeof(p_matrix) IS DISTINCT FROM 'object'
     OR p_quality_status IS DISTINCT FROM 'validated'
     OR p_audited_at IS NULL
     OR p_audited_at > clock_timestamp() + interval '5 minutes'
     OR coalesce(p_source_artifact_checksum, '') !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  IF NOT (
    (p_game_type = 'hu_cash' AND p_stack_depth IN (40, 100, 200))
    OR (p_game_type = 'mtt_3max_chipev' AND p_stack_depth = 20)
    OR (p_game_type = 'mtt_6max_chipev' AND p_stack_depth IN (10, 20, 40, 100))
    OR (p_game_type = 'mtt_6max_icm' AND p_stack_depth IN (20, 40))
    OR (p_game_type = 'mtt_9max_chipev' AND p_stack_depth IN (20, 40, 80, 100))
    OR (p_game_type = 'mtt_9max_icm' AND p_stack_depth IN (40, 60))
    OR (p_game_type = 'mtt_hu_chipev' AND p_stack_depth = 40)
    OR (p_game_type = 'postflop_complete' AND p_stack_depth = 100)
    OR (p_game_type = 'spin_3max_chipev' AND p_stack_depth IN (20, 25))
    OR (p_game_type = 'spin_3max_icm' AND p_stack_depth IN (20, 25))
    OR (p_game_type = 'spin_hu_chipev' AND p_stack_depth IN (10, 20))
    OR (p_game_type = 'spin_hu_icm' AND p_stack_depth = 10)
  ) THEN
    RETURN false;
  END IF;

  -- Provenance labels alone are self-attestation.  The tuple must first be
  -- approved by a migration/operator role that the solver service credential
  -- cannot write as. The follow-on signed-ingestion migration binds this same
  -- authority tuple to a distinct HMAC-authenticated worker identity.
  IF NOT EXISTS (
    SELECT 1
    FROM public.training_solver_provenance_authority authority
    WHERE authority.machine_id = p_machine_id
      AND authority.solver_version = p_solver_version
      AND authority.solver_binary_checksum = p_solver_binary_checksum
      AND authority.pipeline_commit = p_pipeline_commit
      AND authority.manifest_version = p_manifest_version
      AND authority.manifest_checksum = p_manifest_checksum
      AND authority.source_combo_order_sha256 =
        p_matrix ->> 'source_combo_order_sha256'
      AND authority.training_game_contracts_sha256 =
        p_matrix ->> 'training_game_contracts_sha256'
      AND authority.retired_at IS NULL
  ) THEN
    RETURN false;
  END IF;

  IF p_matrix ->> 'combo_order' IS DISTINCT FROM
       'card=rank*4+suit; combo=b*(b-1)/2+a; 2c2d=0..AhAs=1325'
     OR p_matrix ->> 'source_combo_order_schema'
       IS DISTINCT FROM 'piosolver.show_hand_order.v1'
     OR coalesce(p_matrix ->> 'source_combo_order_sha256', '')
       !~ '^[0-9a-f]{64}$'
     OR p_matrix ->> 'source_combo_order_sha256' = repeat('0', 64)
     OR coalesce(p_matrix ->> 'training_game_contracts_sha256', '')
       !~ '^[0-9a-f]{64}$'
     OR p_matrix ->> 'training_game_contracts_sha256' = repeat('0', 64)
     OR p_matrix ->> 'range_combo_order' IS DISTINCT FROM
       'card=rank*4+suit; combo=b*(b-1)/2+a; 2c2d=0..AhAs=1325'
     OR coalesce(p_matrix ->> 'oop_range_checksum', '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_matrix ->> 'ip_range_checksum', '') !~ '^[0-9a-f]{64}$'
     OR p_matrix ->> 'oop_range_checksum' = repeat('0', 64)
     OR p_matrix ->> 'ip_range_checksum' = repeat('0', 64)
     OR p_matrix ->> 'solver' IS DISTINCT FROM 'PioSOLVER'
     OR p_matrix ->> 'street' IS DISTINCT FROM p_street
     OR coalesce(p_matrix ->> 'position', '') !~ '^(UTG|UTG\+1|UTG\+2|UTG1|UTG2|MP|MP\+1|MP\+2|MP1|MP2|LJ|HJ|CO|BTN|SB|BB)$'
     OR coalesce(p_matrix ->> 'hero', '') NOT IN ('OOP', 'IP')
     OR coalesce(p_matrix ->> 'oop_player', '') !~ '^(UTG|UTG\+1|UTG\+2|UTG1|UTG2|MP|MP\+1|MP\+2|MP1|MP2|LJ|HJ|CO|BTN|SB|BB)$'
     OR coalesce(p_matrix ->> 'ip_player', '') !~ '^(UTG|UTG\+1|UTG\+2|UTG1|UTG2|MP|MP\+1|MP\+2|MP1|MP2|LJ|HJ|CO|BTN|SB|BB)$'
     OR p_matrix ->> 'oop_player' = p_matrix ->> 'ip_player'
     OR (p_matrix ->> 'position') IS DISTINCT FROM (CASE p_matrix ->> 'hero'
       WHEN 'OOP' THEN p_matrix ->> 'oop_player'
       WHEN 'IP' THEN p_matrix ->> 'ip_player'
       ELSE NULL
     END)
     OR jsonb_typeof(p_matrix -> 'pot_bb') IS DISTINCT FROM 'number'
     OR (p_matrix ->> 'pot_bb')::numeric <= 0
     OR jsonb_typeof(p_matrix -> 'eff_stack_bb') IS DISTINCT FROM 'number'
     OR (p_matrix ->> 'eff_stack_bb')::numeric <= 0
     OR (p_matrix ->> 'eff_stack_bb')::numeric > p_stack_depth
     OR coalesce(p_matrix ->> 'rake', '')
       !~ '^(0|1|0\.[0-9]*[1-9]) (0|[1-9][0-9]*)$'
     OR coalesce(p_matrix ->> 'tree_geometry', '') !~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'
     OR jsonb_typeof(p_matrix -> 'board') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_matrix -> 'convergence') IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF split_part(p_matrix ->> 'rake', ' ', 1)::numeric NOT BETWEEN 0 AND 1 THEN
    RETURN false;
  END IF;

  IF p_matrix -> 'convergence' ->> 'schema'
       IS DISTINCT FROM 'piosolver.calc-results.v1'
     OR p_matrix -> 'convergence' ->> 'source_command'
       IS DISTINCT FROM 'calc_results'
     OR jsonb_typeof(p_matrix -> 'convergence' -> 'accuracy_fraction')
       IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_matrix -> 'convergence' -> 'starting_pot_chips')
       IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_matrix -> 'convergence' -> 'achieved_exploitability_chips')
       IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_matrix -> 'convergence' -> 'achieved_exploitability_fraction')
       IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_matrix -> 'exploitability_pct') IS DISTINCT FROM 'number' THEN
    RETURN false;
  END IF;
  v_accuracy_fraction :=
    (p_matrix -> 'convergence' ->> 'accuracy_fraction')::numeric;
  v_starting_pot_chips :=
    (p_matrix -> 'convergence' ->> 'starting_pot_chips')::numeric;
  v_achieved_exploitability_chips :=
    (p_matrix -> 'convergence' ->> 'achieved_exploitability_chips')::numeric;
  v_achieved_exploitability_fraction :=
    (p_matrix -> 'convergence' ->> 'achieved_exploitability_fraction')::numeric;
  IF v_accuracy_fraction <= 0 OR v_accuracy_fraction > 0.01
     OR v_starting_pot_chips <= 0
     OR abs(v_starting_pot_chips - (p_matrix ->> 'pot_bb')::numeric * 100)
       > 0.000001
     OR v_achieved_exploitability_chips < 0
     OR v_achieved_exploitability_fraction < 0
     OR abs(
       v_achieved_exploitability_fraction
       - v_achieved_exploitability_chips / v_starting_pot_chips
     ) > 0.000000001
     OR v_achieved_exploitability_fraction > v_accuracy_fraction + 0.000000001
     OR abs(
       (p_matrix ->> 'exploitability_pct')::numeric
       - v_achieved_exploitability_fraction * 100
     ) > 0.0000001 THEN
    RETURN false;
  END IF;

  -- Worker authentication proves which machine submitted a row, not which
  -- game inputs or range artifacts it was authorized to solve. Require one
  -- and only one operator-approved contract from the active manifest tuple.
  IF 1 <> (
    SELECT count(*)
    FROM public.training_solver_provenance_authority authority
    CROSS JOIN LATERAL jsonb_array_elements(authority.manifest_contracts)
      AS approved_contract(value)
    WHERE authority.machine_id = p_machine_id
      AND authority.solver_version = p_solver_version
      AND authority.solver_binary_checksum = p_solver_binary_checksum
      AND authority.pipeline_commit = p_pipeline_commit
      AND authority.manifest_version = p_manifest_version
      AND authority.manifest_checksum = p_manifest_checksum
      AND authority.source_combo_order_sha256 =
        p_matrix ->> 'source_combo_order_sha256'
      AND authority.training_game_contracts_sha256 =
        p_matrix ->> 'training_game_contracts_sha256'
      AND authority.retired_at IS NULL
      AND approved_contract.value ->> 'game_type' = p_game_type
      AND approved_contract.value -> 'stack_depth' = to_jsonb(p_stack_depth)
      AND approved_contract.value ->> 'oop_player' = p_matrix ->> 'oop_player'
      AND approved_contract.value ->> 'ip_player' = p_matrix ->> 'ip_player'
      AND approved_contract.value -> 'pot_chips' =
        to_jsonb((p_matrix ->> 'pot_bb')::numeric * 100)
      AND approved_contract.value -> 'eff_chips' =
        to_jsonb((p_matrix ->> 'eff_stack_bb')::numeric * 100)
      AND approved_contract.value ->> 'rake' = p_matrix ->> 'rake'
      AND approved_contract.value -> 'accuracy_fraction' =
        p_matrix -> 'convergence' -> 'accuracy_fraction'
      AND approved_contract.value ->> 'oop_range_checksum' =
        p_matrix ->> 'oop_range_checksum'
      AND approved_contract.value ->> 'ip_range_checksum' =
        p_matrix ->> 'ip_range_checksum'
      AND approved_contract.value ->> 'range_combo_order' =
        p_matrix ->> 'range_combo_order'
      AND approved_contract.value ->> 'source_combo_order_sha256' =
        p_matrix ->> 'source_combo_order_sha256'
      AND approved_contract.value ->> 'tree_geometry' =
        p_matrix ->> 'tree_geometry'
      AND CASE
        WHEN jsonb_typeof(approved_contract.value -> 'streets') = 'array'
        THEN approved_contract.value -> 'streets' @> to_jsonb(ARRAY[p_street])
        ELSE false
      END
  ) THEN
    RETURN false;
  END IF;

  v_board_count := CASE p_street WHEN 'flop' THEN 3 WHEN 'turn' THEN 4 ELSE 5 END;
  IF jsonb_array_length(p_matrix -> 'board') <> v_board_count THEN
    RETURN false;
  END IF;
  SELECT array_agg(board_card.value ORDER BY board_card.ordinality)
  INTO v_board
  FROM jsonb_array_elements_text(p_matrix -> 'board')
       WITH ORDINALITY AS board_card(value, ordinality);
  IF cardinality(v_board) <> v_board_count
     OR EXISTS (
       SELECT 1 FROM unnest(v_board) AS board_card(value)
       WHERE board_card.value !~ '^[2-9TJQKA][cdhs]$'
     )
     OR (SELECT count(DISTINCT board_card.value) FROM unnest(v_board) AS board_card(value))
       <> v_board_count THEN
    RETURN false;
  END IF;

  v_expected_hash := CASE WHEN p_street = 'flop' THEN '' ELSE p_street || '_' END
    || p_game_type || '_' || (p_matrix ->> 'position') || '_'
    || p_stack_depth::text || 'bb_' || array_to_string(v_board, '');
  IF p_scenario_hash IS DISTINCT FROM v_expected_hash THEN
    RETURN false;
  END IF;

  v_node_tokens := string_to_array(p_matrix ->> 'node', ':');
  IF nullif(p_matrix ->> 'node', '') IS NULL
     OR char_length(p_matrix ->> 'node') > 4096
     OR cardinality(v_node_tokens) < 2
     OR cardinality(v_node_tokens) > 64
     OR v_node_tokens[1] IS DISTINCT FROM 'r'
     OR v_node_tokens[2] IS DISTINCT FROM '0'
     OR array_position(v_node_tokens, '') IS NOT NULL THEN
    RETURN false;
  END IF;
  IF cardinality(v_node_tokens) > 2 THEN
    FOR v_token_index IN 3..cardinality(v_node_tokens) LOOP
      v_token := v_node_tokens[v_token_index];
      IF v_token ~ '^[2-9TJQKA][cdhs]$' THEN
        -- Equal contributions alone are not proof that a betting round is
        -- closed: they are also equal at the root and after a single check.
        IF v_round_state IS DISTINCT FROM 'closed'
           OR abs(v_contributions[1] - v_contributions[2]) > 0.000001
           OR v_token = ANY(v_runout) THEN
          RETURN false;
        END IF;
        v_runout := array_append(v_runout, v_token);
        -- Pio bNNN values remain cumulative across streets. Preserve both
        -- contributions as the new street baseline; only per-street action
        -- state and the minimum-full-raise increment reset here.
        v_street_baseline := greatest(v_contributions[1], v_contributions[2]);
        v_actor := 1;
        v_round_state := 'open';
        v_last_full_raise := 0;
        v_raise_reopened := true;
        v_wager_is_all_in := false;
      ELSIF v_token = 'c' THEN
        IF v_round_state IN ('closed', 'all_in_terminal') THEN RETURN false; END IF;
        v_target := greatest(v_contributions[1], v_contributions[2]);
        IF v_target < v_contributions[v_actor] THEN RETURN false; END IF;
        v_contributions[v_actor] := v_target;
        v_round_state := CASE v_round_state
          WHEN 'open' THEN 'checked'
          WHEN 'checked' THEN 'closed'
          WHEN 'facing_wager' THEN CASE
            WHEN v_wager_is_all_in THEN 'all_in_terminal'
            ELSE 'closed'
          END
          ELSE 'invalid'
        END;
        IF v_round_state = 'invalid' THEN RETURN false; END IF;
        v_actor := 3 - v_actor;
      ELSIF v_token ~ '^b[1-9][0-9]*$' THEN
        IF v_round_state IN ('closed', 'all_in_terminal') THEN RETURN false; END IF;
        IF v_round_state = 'facing_wager' AND NOT v_raise_reopened THEN
          RETURN false;
        END IF;
        v_target := substring(v_token FROM 2)::numeric;
        -- Bet/raise tokens are cumulative postflop contribution targets.  A
        -- new wager must exceed both players' prior contributions.
        IF v_target <= greatest(v_contributions[1], v_contributions[2])
           OR v_target > (p_matrix ->> 'eff_stack_bb')::numeric * 100 THEN
          RETURN false;
        END IF;
        v_raise_size := v_target - greatest(v_contributions[1], v_contributions[2]);
        IF v_round_state <> 'facing_wager'
           AND v_raise_size < 100
           AND v_target <> (p_matrix ->> 'eff_stack_bb')::numeric * 100 THEN
          RETURN false;
        END IF;
        IF v_round_state = 'facing_wager'
           AND v_raise_size < v_last_full_raise
           AND v_target <> (p_matrix ->> 'eff_stack_bb')::numeric * 100 THEN
          RETURN false;
        END IF;
        v_contributions[v_actor] := v_target;
        v_actor := 3 - v_actor;
        v_round_state := 'facing_wager';
        v_wager_is_all_in := v_target = (p_matrix ->> 'eff_stack_bb')::numeric * 100;
        -- A short all-in raise gives a prior actor only Call/Fold; it does not
        -- reopen raising. This is explicit even though equal effective stacks
        -- also make a larger target impossible in the common HU case.
        v_raise_reopened := NOT v_wager_is_all_in
          OR v_last_full_raise = 0
          OR v_raise_size >= v_last_full_raise;
        IF NOT v_wager_is_all_in OR v_raise_size >= v_last_full_raise THEN
          v_last_full_raise := v_raise_size;
        END IF;
      ELSE
        RETURN false;
      END IF;
    END LOOP;
  END IF;
  -- A catalog row carries a decision policy.  Check-check and bet-call are
  -- terminal until a runout card begins the next street.
  IF v_round_state IN ('closed', 'all_in_terminal') THEN RETURN false; END IF;
  IF (CASE v_actor WHEN 1 THEN 'OOP' ELSE 'IP' END)
       IS DISTINCT FROM p_matrix ->> 'hero' THEN
    RETURN false;
  END IF;

  v_runout_count := cardinality(v_runout);
  -- Pio can solve a complete turn/river board directly at r:0, in which case
  -- the node has no runout tokens. Continuation-tree artifacts must expose the
  -- complete trailing suffix; partial runout histories are ambiguous.
  IF v_runout_count <> 0 AND v_runout_count <> v_board_count - 3 THEN
    RETURN false;
  END IF;
  IF v_runout_count > 0 THEN
    FOR v_index IN 1..v_runout_count LOOP
      IF v_runout[v_index]
           IS DISTINCT FROM v_board[v_board_count - v_runout_count + v_index] THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;

  IF jsonb_typeof(p_matrix -> 'actions') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_matrix -> 'frequencies') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_matrix -> 'hand_evs_bb') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  v_action_count := jsonb_array_length(p_matrix -> 'actions');
  IF v_action_count NOT BETWEEN 2 AND 16
     OR jsonb_array_length(p_matrix -> 'hand_evs_bb') <> 1326 THEN
    RETURN false;
  END IF;

  FOR v_action IN SELECT action_row.value
                  FROM jsonb_array_elements(p_matrix -> 'actions') AS action_row(value) LOOP
    IF jsonb_typeof(v_action) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    v_action_code := v_action ->> 'code';
    IF v_action_code !~ '^(c|f|b[1-9][0-9]*)$'
       OR nullif(btrim(v_action ->> 'key'), '') IS NULL
       OR array_position(v_action_codes, v_action_code) IS NOT NULL THEN
      RETURN false;
    END IF;
    IF v_action_code ~ '^b' THEN
      IF jsonb_typeof(v_action -> 'size_chips') IS DISTINCT FROM 'number'
         OR (v_round_state = 'facing_wager' AND NOT v_raise_reopened)
         OR (v_action ->> 'size_chips')::numeric
              <> substring(v_action_code FROM 2)::numeric
         OR (v_action ->> 'size_chips')::numeric
              <= greatest(v_contributions[1], v_contributions[2])
         OR (v_action ->> 'size_chips')::numeric
              > (p_matrix ->> 'eff_stack_bb')::numeric * 100
         OR (
              v_round_state <> 'facing_wager'
              AND (v_action ->> 'size_chips')::numeric
                    - v_contributions[v_actor] < 100
              AND (v_action ->> 'size_chips')::numeric
                    <> (p_matrix ->> 'eff_stack_bb')::numeric * 100
            )
         OR (
              v_round_state = 'facing_wager'
              AND (v_action ->> 'size_chips')::numeric
                    - greatest(v_contributions[1], v_contributions[2])
                    < v_last_full_raise
              AND (v_action ->> 'size_chips')::numeric
                    <> (p_matrix ->> 'eff_stack_bb')::numeric * 100
            )
         OR (v_action ->> 'size_chips')::numeric <= v_street_baseline
         OR array_position(
              v_action_targets,
              (v_action ->> 'size_chips')::numeric
            ) IS NOT NULL
         OR v_action ->> 'size_semantics' IS DISTINCT FROM
              'cumulative_postflop_contribution_target'
         OR v_action ->> 'key' IS DISTINCT FROM
              (CASE WHEN v_round_state = 'facing_wager'
                THEN 'raise_chips_' ELSE 'bet_chips_' END)
              || substring(v_action_code FROM 2) THEN
        RETURN false;
      END IF;
      v_action_targets := array_append(
        v_action_targets,
        (v_action ->> 'size_chips')::numeric
      );
    ELSIF v_action_code = 'f' THEN
      IF v_round_state <> 'facing_wager'
         OR v_action ->> 'key' IS DISTINCT FROM 'fold' THEN
        RETURN false;
      END IF;
    ELSIF jsonb_typeof(v_action -> 'size_pct') IS DISTINCT FROM 'number'
       OR (v_action ->> 'size_pct')::numeric <> 0
       OR v_action ->> 'key' IS DISTINCT FROM
          (CASE WHEN v_round_state = 'facing_wager' THEN 'call' ELSE 'check' END) THEN
      RETURN false;
    END IF;
    v_action_codes := array_append(v_action_codes, v_action_code);
  END LOOP;

  -- Every Pio decision exposes the passive legal action. At an open node this
  -- is Check; while facing a wager it is Call. A facing-wager policy must also
  -- expose Fold. Requiring these tokens prevents a skeletal self-attestation
  -- such as [b200,b500] (or a call-only wager response) from entering the
  -- serving catalog even when the remaining vector shape looks plausible.
  IF array_position(v_action_codes, 'c') IS NULL
     OR (
       v_round_state = 'facing_wager'
       AND array_position(v_action_codes, 'f') IS NULL
     ) THEN
    RETURN false;
  END IF;

  SELECT count(*) INTO v_frequency_key_count
  FROM jsonb_object_keys(p_matrix -> 'frequencies');
  IF v_frequency_key_count <> v_action_count THEN RETURN false; END IF;
  FOREACH v_action_code IN ARRAY v_action_codes LOOP
    v_frequency := p_matrix -> 'frequencies' -> v_action_code;
    IF jsonb_typeof(v_frequency) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_frequency) <> 1326 THEN
      RETURN false;
    END IF;
  END LOOP;

  FOREACH v_summary_field IN ARRAY ARRAY['ev_oop_bb', 'ev_ip_bb', 'exploitability_pct'] LOOP
    IF jsonb_typeof(p_matrix -> v_summary_field) IS DISTINCT FROM 'number' THEN
      RETURN false;
    END IF;
  END LOOP;
  IF (p_matrix ->> 'exploitability_pct')::numeric < 0 THEN RETURN false; END IF;

  FOR v_index IN 0..1325 LOOP
    v_sum := 0;
    FOREACH v_action_code IN ARRAY v_action_codes LOOP
      v_frequency := p_matrix -> 'frequencies' -> v_action_code -> v_index;
      IF jsonb_typeof(v_frequency) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
      v_frequency_value := (v_frequency #>> '{}')::numeric;
      IF v_frequency_value < 0 OR v_frequency_value > 1 THEN RETURN false; END IF;
      v_sum := v_sum + v_frequency_value;
    END LOOP;
    -- Combo order is triangular over card indexes.  A solver can retain
    -- placeholders for board-dead combos, but it must assign them zero
    -- strategy mass; otherwise Spot Study could display impossible cards.
    v_high_card_index := floor((1 + sqrt(1 + 8 * v_index)) / 2)::integer;
    WHILE v_high_card_index * (v_high_card_index - 1) / 2 > v_index LOOP
      v_high_card_index := v_high_card_index - 1;
    END LOOP;
    WHILE (v_high_card_index + 1) * v_high_card_index / 2 <= v_index LOOP
      v_high_card_index := v_high_card_index + 1;
    END LOOP;
    v_low_card_index := v_index
      - (v_high_card_index * (v_high_card_index - 1) / 2);
    v_low_card := substr('23456789TJQKA', (v_low_card_index / 4) + 1, 1)
      || substr('cdhs', (v_low_card_index % 4) + 1, 1);
    v_high_card := substr('23456789TJQKA', (v_high_card_index / 4) + 1, 1)
      || substr('cdhs', (v_high_card_index % 4) + 1, 1);
    IF (v_low_card = ANY(v_board) OR v_high_card = ANY(v_board))
       AND v_sum <> 0 THEN
      RETURN false;
    END IF;
    IF v_sum > 0.001 THEN
      v_live_combos := v_live_combos + 1;
      -- Newly harvested V2 values are rounded to six decimals. Even across
      -- the maximum 16 actions, aggregate rounding drift cannot exceed 8e-6,
      -- so ±1e-5 is the strict shared JS/SQL admission tolerance.
      IF v_sum < 0.99999 OR v_sum > 1.00001 THEN RETURN false; END IF;
      v_hand_ev := p_matrix -> 'hand_evs_bb' -> v_index;
      IF jsonb_typeof(v_hand_ev) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
      v_numeric := (v_hand_ev #>> '{}')::numeric;
    END IF;
  END LOOP;
  RETURN v_live_combos > 0;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_training_solver_artifact_servable_v2(
  text, text, integer, text, jsonb, text, text, text, text, text, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_training_solver_artifact_catalog_sync_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF public.fn_training_solver_artifact_servable_v2(
       NEW.scenario_hash,
       NEW.game_type,
       NEW.stack_depth,
       NEW.street,
       NEW.strategy_matrix_v2,
       NEW.solver_version,
       NEW.solver_binary_checksum,
       NEW.machine_id,
       NEW.pipeline_commit,
       NEW.manifest_version,
       NEW.manifest_checksum,
       NEW.source_artifact_checksum,
       NEW.quality_status,
       NEW.audited_at
     ) THEN
    INSERT INTO public.training_solver_artifact_catalog AS catalog (
      artifact_id, scenario_hash, game_type, stack_depth, street,
      hero_position, registered_at, updated_at
    ) VALUES (
      NEW.id, NEW.scenario_hash, NEW.game_type, NEW.stack_depth, NEW.street,
      NEW.strategy_matrix_v2 ->> 'position', now(), now()
    )
    ON CONFLICT (artifact_id) DO UPDATE SET
      scenario_hash = EXCLUDED.scenario_hash,
      game_type = EXCLUDED.game_type,
      stack_depth = EXCLUDED.stack_depth,
      street = EXCLUDED.street,
      hero_position = EXCLUDED.hero_position,
      updated_at = now();
  ELSE
    DELETE FROM public.training_solver_artifact_catalog
    WHERE artifact_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_training_solver_artifact_catalog_sync_v1()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_training_solver_provenance_authority_invalidate_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  -- Retirement or replacement must immediately withdraw any serving rows
  -- admitted by the old tuple.  Drive from the small catalog and use the
  -- warehouse primary key; never scan solved_spots_gold.
  IF TG_OP = 'DELETE'
     OR NEW.retired_at IS NOT NULL
     OR ROW(
       NEW.machine_id,
       NEW.solver_version,
       NEW.solver_binary_checksum,
       NEW.pipeline_commit,
       NEW.manifest_version,
       NEW.manifest_checksum,
       NEW.source_combo_order_sha256,
       NEW.training_game_contracts_sha256,
       NEW.manifest_contracts
     ) IS DISTINCT FROM ROW(
       OLD.machine_id,
       OLD.solver_version,
       OLD.solver_binary_checksum,
       OLD.pipeline_commit,
       OLD.manifest_version,
       OLD.manifest_checksum,
       OLD.source_combo_order_sha256,
       OLD.training_game_contracts_sha256,
       OLD.manifest_contracts
     ) THEN
    DELETE FROM public.training_solver_artifact_catalog catalog
    USING public.solved_spots_gold artifact
    WHERE artifact.id = catalog.artifact_id
      AND artifact.machine_id = OLD.machine_id
      AND artifact.solver_version = OLD.solver_version
      AND artifact.solver_binary_checksum = OLD.solver_binary_checksum
      AND artifact.pipeline_commit = OLD.pipeline_commit
      AND artifact.manifest_version = OLD.manifest_version
      AND artifact.manifest_checksum = OLD.manifest_checksum;
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS training_solver_provenance_authority_invalidate_v1
  ON public.training_solver_provenance_authority;
CREATE TRIGGER training_solver_provenance_authority_invalidate_v1
AFTER UPDATE OR DELETE ON public.training_solver_provenance_authority
FOR EACH ROW EXECUTE FUNCTION
  public.fn_training_solver_provenance_authority_invalidate_v1();

REVOKE ALL ON FUNCTION public.fn_training_solver_provenance_authority_invalidate_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- Revalidation is bounded by the small serving catalog.  It performs primary-
-- key lookups into solved_spots_gold and never scans the warehouse.
DELETE FROM public.training_solver_artifact_catalog catalog
WHERE NOT EXISTS (
  SELECT 1
  FROM public.solved_spots_gold artifact
  WHERE artifact.id = catalog.artifact_id
    AND public.fn_training_solver_artifact_servable_v2(
      artifact.scenario_hash,
      artifact.game_type,
      artifact.stack_depth,
      artifact.street,
      artifact.strategy_matrix_v2,
      artifact.solver_version,
      artifact.solver_binary_checksum,
      artifact.machine_id,
      artifact.pipeline_commit,
      artifact.manifest_version,
      artifact.manifest_checksum,
      artifact.source_artifact_checksum,
      artifact.quality_status,
      artifact.audited_at
    )
);

-- Match the actual Spot Study predicates without placing an unfiltered street
-- column before artifact_id.  Each optional-filter shape gets a bounded,
-- order-compatible path through the small registry.
DROP INDEX IF EXISTS public.idx_training_solver_artifact_catalog_filter;
DROP INDEX IF EXISTS public.idx_training_solver_artifact_catalog_family_cursor;
DROP INDEX IF EXISTS public.idx_training_solver_artifact_catalog_family_position_cursor;
DROP INDEX IF EXISTS public.idx_training_solver_artifact_catalog_family_stack_cursor;
DROP INDEX IF EXISTS public.idx_training_solver_artifact_catalog_exact_cursor;
CREATE INDEX IF NOT EXISTS idx_training_solver_artifact_catalog_family_cursor
  ON public.training_solver_artifact_catalog (game_type, artifact_id);
CREATE INDEX IF NOT EXISTS idx_training_solver_artifact_catalog_family_position_cursor
  ON public.training_solver_artifact_catalog (game_type, hero_position, artifact_id);
CREATE INDEX IF NOT EXISTS idx_training_solver_artifact_catalog_family_stack_cursor
  ON public.training_solver_artifact_catalog (game_type, stack_depth, artifact_id);
CREATE INDEX IF NOT EXISTS idx_training_solver_artifact_catalog_exact_cursor
  ON public.training_solver_artifact_catalog (
    game_type, stack_depth, hero_position, artifact_id
  );

-- Return a bounded candidate page in one database statement.  Expanding the
-- caller's small set of exact family/stack contracts through LATERAL gives
-- each pair an index-ordered LIMIT, avoiding a sort of every matching family.
-- Joining the active provenance tuple in this same snapshot removes the old
-- catalog-read/warehouse-read retirement gap.
CREATE OR REPLACE FUNCTION public.training_solver_spot_candidates_v1(
  p_family_stacks jsonb,
  p_position text DEFAULT NULL,
  p_lower_inclusive uuid DEFAULT NULL,
  p_lower_exclusive uuid DEFAULT NULL,
  p_upper_exclusive uuid DEFAULT NULL,
  p_limit integer DEFAULT 12,
  p_artifact_id uuid DEFAULT NULL,
  p_scenario_hash text DEFAULT NULL,
  p_street text DEFAULT NULL,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  id uuid,
  scenario_hash text,
  game_type text,
  stack_depth integer,
  street text,
  strategy_matrix_v2 jsonb,
  solver_version text,
  solver_binary_checksum text,
  machine_id text,
  pipeline_commit text,
  manifest_version text,
  manifest_checksum text,
  source_artifact_checksum text,
  quality_status text,
  audited_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
ROWS 128
AS $function$
  WITH requested AS MATERIALIZED (
    SELECT DISTINCT
      request_item.value ->> 'game_type' AS game_type,
      CASE
        WHEN request_item.value ->> 'stack_depth' ~ '^[1-9][0-9]{0,3}$'
        THEN (request_item.value ->> 'stack_depth')::integer
        ELSE NULL
      END AS stack_depth
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(p_family_stacks) = 'array'
        THEN CASE
          WHEN jsonb_array_length(p_family_stacks) BETWEEN 1 AND 32
          THEN p_family_stacks
          ELSE '[]'::jsonb
        END
        ELSE '[]'::jsonb
      END
    ) AS request_item(value)
  ), allowed AS MATERIALIZED (
    SELECT request.game_type, request.stack_depth
    FROM requested request
    WHERE
      (request.game_type = 'hu_cash' AND request.stack_depth IN (40, 100, 200))
      OR (request.game_type = 'mtt_3max_chipev' AND request.stack_depth = 20)
      OR (request.game_type = 'mtt_6max_chipev' AND request.stack_depth IN (10, 20, 40, 100))
      OR (request.game_type = 'mtt_9max_chipev' AND request.stack_depth IN (20, 40, 80, 100))
      OR (request.game_type = 'mtt_hu_chipev' AND request.stack_depth = 40)
      OR (request.game_type = 'postflop_complete' AND request.stack_depth = 100)
      OR (request.game_type = 'spin_3max_chipev' AND request.stack_depth IN (20, 25))
      OR (request.game_type = 'spin_hu_chipev' AND request.stack_depth IN (10, 20))
  ), candidates AS MATERIALIZED (
    SELECT candidate.*
    FROM allowed request
    CROSS JOIN LATERAL (
      SELECT
        artifact.id,
        artifact.scenario_hash,
        artifact.game_type,
        artifact.stack_depth,
        artifact.street,
        artifact.strategy_matrix_v2,
        artifact.solver_version,
        artifact.solver_binary_checksum,
        artifact.machine_id,
        artifact.pipeline_commit,
        artifact.manifest_version,
        artifact.manifest_checksum,
        artifact.source_artifact_checksum,
        artifact.quality_status,
        artifact.audited_at
      FROM public.training_solver_artifact_catalog catalog
      JOIN public.solved_spots_gold artifact
        ON artifact.id = catalog.artifact_id
       AND artifact.scenario_hash = catalog.scenario_hash
       AND artifact.game_type = catalog.game_type
       AND artifact.stack_depth = catalog.stack_depth
       AND artifact.street = catalog.street
       AND artifact.strategy_matrix_v2 ->> 'position' = catalog.hero_position
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
      WHERE catalog.game_type = request.game_type
        AND catalog.stack_depth = request.stack_depth
        AND (p_position IS NULL OR catalog.hero_position = p_position)
        AND (p_artifact_id IS NULL OR catalog.artifact_id = p_artifact_id)
        AND (p_scenario_hash IS NULL OR catalog.scenario_hash = p_scenario_hash)
        AND (p_street IS NULL OR catalog.street = p_street)
        AND (p_lower_inclusive IS NULL OR catalog.artifact_id >= p_lower_inclusive)
        AND (p_lower_exclusive IS NULL OR catalog.artifact_id > p_lower_exclusive)
        AND (p_upper_exclusive IS NULL OR catalog.artifact_id < p_upper_exclusive)
      ORDER BY catalog.artifact_id
      LIMIT greatest(1, least(128, coalesce(p_limit, 12)))
      OFFSET greatest(0, least(4096, coalesce(p_offset, 0)))
    ) candidate
    WHERE coalesce(p_offset, 0) = 0
       OR (SELECT count(*) FROM allowed) = 1
  )
  SELECT candidate.*
  FROM candidates candidate
  ORDER BY candidate.id
  LIMIT greatest(1, least(128, coalesce(p_limit, 12)))
$function$;

REVOKE ALL ON FUNCTION public.training_solver_spot_candidates_v1(
  jsonb, text, uuid, uuid, uuid, integer, uuid, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.training_solver_spot_candidates_v1(
  jsonb, text, uuid, uuid, uuid, integer, uuid, text, text, integer
) TO service_role;

-- This legacy aggregate is only used by a server-side analysis script.  A
-- browser must never be able to request an aggregate over the 80 GB table.
-- Make it invoker-rights with a fixed search path as well, so its narrow
-- service grant cannot become an accidental definer-rights escalation.
CREATE OR REPLACE FUNCTION public.analyze_spots_by_game_type(
  p_game_type text DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS TABLE(game_type text, count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog'
SET statement_timeout TO '5s'
AS $function$
  SELECT artifact.game_type, count(*)::bigint
  FROM public.solved_spots_gold artifact
  WHERE coalesce(p_game_type, '') ~ '^[a-z0-9_]{1,64}$'
    AND artifact.game_type = p_game_type
  GROUP BY artifact.game_type
  ORDER BY count(*) DESC
  LIMIT greatest(1, least(1000, coalesce(p_limit, 100)))
$function$;

REVOKE ALL ON FUNCTION public.analyze_spots_by_game_type(text, integer)
  FROM PUBLIC, anon, authenticated, service_role;

DO $contract_assertions$
DECLARE
  v_candidate_definition text;
  v_sync_definition text;
  v_validator_definition text;
  v_analysis_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.training_solver_spot_candidates_v1(jsonb,text,uuid,uuid,uuid,integer,uuid,text,text,integer)'::regprocedure
  ) INTO v_candidate_definition;
  SELECT pg_get_functiondef(
    'public.fn_training_solver_artifact_catalog_sync_v1()'::regprocedure
  ) INTO v_sync_definition;
  SELECT pg_get_functiondef(
    'public.analyze_spots_by_game_type(text,integer)'::regprocedure
  ) INTO v_analysis_definition;
  SELECT pg_get_functiondef(
    'public.fn_training_solver_artifact_servable_v2(text,text,integer,text,jsonb,text,text,text,text,text,text,text,text,timestamp with time zone)'::regprocedure
  ) INTO v_validator_definition;

  IF to_regclass('public.training_solver_provenance_authority') IS NULL
     OR (
       SELECT count(*)
       FROM pg_attribute attribute_row
       WHERE attribute_row.attrelid =
         'public.training_solver_artifact_catalog'::regclass
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
     ) <> 8
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('artifact_id', 'uuid'::regtype, true),
         ('scenario_hash', 'text'::regtype, true),
         ('game_type', 'text'::regtype, true),
         ('stack_depth', 'integer'::regtype, true),
         ('street', 'text'::regtype, true),
         ('hero_position', 'text'::regtype, true),
         ('registered_at', 'timestamp with time zone'::regtype, true),
         ('updated_at', 'timestamp with time zone'::regtype, true)
       ) AS expected(attname, atttypid, attnotnull)
       LEFT JOIN pg_attribute actual
         ON actual.attrelid = 'public.training_solver_artifact_catalog'::regclass
        AND actual.attname = expected.attname
        AND actual.attnum > 0
        AND NOT actual.attisdropped
       WHERE actual.attname IS NULL
          OR actual.atttypid <> expected.atttypid
          OR actual.attnotnull <> expected.attnotnull
     )
     OR position('fn_training_solver_artifact_servable_v2' IN v_sync_definition) = 0
     OR position('jsonb_array_length' IN v_validator_definition) = 0
     OR position('v_live_combos > 0' IN v_validator_definition) = 0
     OR position('v_round_state' IN v_validator_definition) = 0
     OR position('v_low_card = ANY(v_board)' IN v_validator_definition) = 0
     OR position('training_solver_provenance_authority' IN v_validator_definition) = 0
     OR position('CROSS JOIN LATERAL' IN v_candidate_definition) = 0
     OR position('authority.retired_at IS NULL' IN v_candidate_definition) = 0
     OR position('LIMIT greatest(1, least(128' IN v_candidate_definition) = 0
     OR position('catalog.artifact_id = p_artifact_id' IN v_candidate_definition) = 0
     OR position('catalog.scenario_hash = p_scenario_hash' IN v_candidate_definition) = 0
     OR position('catalog.street = p_street' IN v_candidate_definition) = 0
     OR NOT (
       SELECT function_row.prosecdef
       FROM pg_proc function_row
       WHERE function_row.oid =
         'public.fn_training_solver_artifact_servable_v2(text,text,integer,text,jsonb,text,text,text,text,text,text,text,text,timestamp with time zone)'::regprocedure
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES ('anon'), ('authenticated'), ('service_role'))
         AS role_under_test(role_name)
       CROSS JOIN (
         VALUES
           ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
           ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')
       ) AS privilege_under_test(privilege_name)
       WHERE has_table_privilege(
         role_under_test.role_name,
         'public.training_solver_provenance_authority',
         privilege_under_test.privilege_name
       )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute attributes
       CROSS JOIN LATERAL pg_catalog.aclexplode(attributes.attacl) acl
       WHERE attributes.attrelid =
         'public.training_solver_provenance_authority'::pg_catalog.regclass
         AND attributes.attnum > 0
         AND NOT attributes.attisdropped
         AND acl.grantee IN (
           0,
           pg_catalog.to_regrole('anon'),
           pg_catalog.to_regrole('authenticated'),
           pg_catalog.to_regrole('service_role')
         )
     )
     OR NOT (
       SELECT class_row.relrowsecurity
       FROM pg_class class_row
       WHERE class_row.oid =
         'public.training_solver_provenance_authority'::regclass
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_training_solver_artifact_servable_v2(text,text,integer,text,jsonb,text,text,text,text,text,text,text,text,timestamp with time zone)',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES ('anon'), ('authenticated'), ('service_role'))
         AS role_under_test(role_name)
       CROSS JOIN (
         VALUES
           ('public.fn_training_solver_artifact_servable_v2(text,text,integer,text,jsonb,text,text,text,text,text,text,text,text,timestamp with time zone)'),
           ('public.fn_training_solver_artifact_catalog_sync_v1()'),
           ('public.fn_training_solver_provenance_authority_invalidate_v1()')
       ) AS function_under_test(function_signature)
       WHERE has_function_privilege(
         role_under_test.role_name,
         function_under_test.function_signature,
         'EXECUTE'
       )
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_trigger trigger_row
       WHERE trigger_row.tgrelid =
         'public.training_solver_provenance_authority'::regclass
         AND trigger_row.tgname =
           'training_solver_provenance_authority_invalidate_v1'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled <> 'D'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_training_solver_provenance_authority_invalidate_v1()',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.training_solver_spot_candidates_v1(jsonb,text,uuid,uuid,uuid,integer,uuid,text,text,integer)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.training_solver_spot_candidates_v1(jsonb,text,uuid,uuid,uuid,integer,uuid,text,text,integer)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.training_solver_spot_candidates_v1(jsonb,text,uuid,uuid,uuid,integer,uuid,text,text,integer)',
       'EXECUTE'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_index index_row
       WHERE index_row.indexrelid =
         'public.idx_training_solver_artifact_catalog_family_stack_cursor'::regclass
         AND index_row.indisvalid
         AND index_row.indpred IS NULL
         AND position(
           '(game_type, stack_depth, artifact_id)'
           IN pg_get_indexdef(index_row.indexrelid)
         ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_index index_row
       WHERE index_row.indexrelid =
         'public.idx_training_solver_artifact_catalog_exact_cursor'::regclass
         AND index_row.indisvalid
         AND index_row.indpred IS NULL
         AND position(
           '(game_type, stack_depth, hero_position, artifact_id)'
           IN pg_get_indexdef(index_row.indexrelid)
         ) > 0
     )
     OR (
       to_regprocedure('public.analyze_spots_by_game_type(text,integer)') IS NOT NULL
       AND has_function_privilege(
         'authenticated', 'public.analyze_spots_by_game_type(text,integer)', 'EXECUTE'
       )
     )
     OR (
       to_regprocedure('public.analyze_spots_by_game_type(text,integer)') IS NOT NULL
       AND has_function_privilege(
         'anon', 'public.analyze_spots_by_game_type(text,integer)', 'EXECUTE'
       )
     )
     OR (
       SELECT function_row.prosecdef
       FROM pg_proc function_row
       WHERE function_row.oid =
         'public.analyze_spots_by_game_type(text,integer)'::regprocedure
     )
     OR position(
       'search_path=pg_catalog' IN coalesce(array_to_string((
         SELECT function_row.proconfig
         FROM pg_proc function_row
         WHERE function_row.oid =
           'public.analyze_spots_by_game_type(text,integer)'::regprocedure
       ), ','), '')
     ) = 0
     OR position(
       'statement_timeout=5s' IN coalesce(array_to_string((
         SELECT function_row.proconfig
         FROM pg_proc function_row
         WHERE function_row.oid =
           'public.analyze_spots_by_game_type(text,integer)'::regprocedure
       ), ','), '')
     ) = 0
     OR position('artifact.game_type = p_game_type' IN v_analysis_definition) = 0
     OR position('p_game_type IS NULL OR' IN v_analysis_definition) > 0
     OR has_function_privilege(
       'service_role',
       'public.analyze_spots_by_game_type(text,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'TRAINING_SOLVER_SPOT_SECURITY_CONTRACT_INCOMPLETE';
  END IF;
END;
$contract_assertions$;

COMMIT;
