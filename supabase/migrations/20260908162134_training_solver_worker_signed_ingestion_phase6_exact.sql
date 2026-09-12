-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260908162134; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260908162134   (the stamp IS the apply time, UTC: 2026-09-08 16:21:34)
--   name        training_solver_worker_signed_ingestion_phase6_exact
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 45234 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260908162134 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.training_claim_solver_worker_request_v1, public.training_solver_worker_row_states_v1, public.training_solver_worker_board_page_v1, public.training_ingest_solver_artifact_v1
--     TABLE          public.training_solver_worker_receipts
--     INDEX          idx_training_solver_worker_receipts_received
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

-- Phase 6: signed solver-worker ingress.
--
-- M1/M2 authenticate to the application gateway with distinct HMAC keys; they
-- never receive a Supabase credential. The gateway is the only caller of these
-- service-only RPCs. Nonces are consumed durably, provenance must match one
-- exact active operator-approved tuple, and one ingest call can update only one
-- pre-existing solver artifact with the same immutable relational identity.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS public.training_solver_worker_receipts (
  machine_id text NOT NULL,
  request_nonce uuid NOT NULL,
  operation text NOT NULL,
  signed_at timestamptz NOT NULL,
  body_sha256 text NOT NULL,
  solver_version text NOT NULL,
  solver_binary_checksum text NOT NULL,
  pipeline_commit text NOT NULL,
  manifest_version text NOT NULL,
  manifest_checksum text NOT NULL,
  artifact_id uuid,
  scenario_hash text,
  source_artifact_checksum text,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT training_solver_worker_receipts_pkey
    PRIMARY KEY (machine_id, request_nonce),
  CONSTRAINT training_solver_worker_receipts_machine_check
    CHECK (machine_id IN ('M1', 'M2')),
  CONSTRAINT training_solver_worker_receipts_operation_check
    CHECK (operation IN ('ingest_artifact', 'row_states', 'board_page', 'heartbeat')),
  CONSTRAINT training_solver_worker_receipts_body_check
    CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT training_solver_worker_receipts_provenance_check CHECK (
    char_length(btrim(solver_version)) BETWEEN 1 AND 120
    AND solver_binary_checksum ~ '^[0-9a-f]{64}$'
    AND pipeline_commit ~ '^[0-9a-f]{40}$'
    AND char_length(btrim(manifest_version)) BETWEEN 1 AND 160
    AND manifest_checksum ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT training_solver_worker_receipts_artifact_check CHECK (
    (operation = 'ingest_artifact') = (
      artifact_id IS NOT NULL
      AND scenario_hash IS NOT NULL
      AND char_length(scenario_hash) BETWEEN 1 AND 512
      AND source_artifact_checksum ~ '^[0-9a-f]{64}$'
    )
  )
);

COMMENT ON TABLE public.training_solver_worker_receipts IS
  'Private durable replay/idempotency ledger for HMAC-authenticated M1/M2 gateway requests. It contains no HMAC secrets.';

ALTER TABLE public.training_solver_worker_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.training_solver_worker_receipts
  FROM PUBLIC, anon, authenticated, service_role;
DO $revoke_worker_receipt_columns$
DECLARE
  v_columns text;
BEGIN
  SELECT string_agg(quote_ident(attribute_row.attname), ',' ORDER BY attribute_row.attnum)
  INTO v_columns
  FROM pg_attribute attribute_row
  WHERE attribute_row.attrelid = 'public.training_solver_worker_receipts'::regclass
    AND attribute_row.attnum > 0
    AND NOT attribute_row.attisdropped;
  IF v_columns IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%s) ON TABLE public.training_solver_worker_receipts FROM PUBLIC, anon, authenticated, service_role',
      v_columns
    );
  END IF;
END;
$revoke_worker_receipt_columns$;

DO $assert_worker_receipt_shape$
DECLARE
  receipt_oid pg_catalog.oid := pg_catalog.to_regclass(
    'public.training_solver_worker_receipts'
  );
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class class_row
       WHERE class_row.oid = receipt_oid
         AND class_row.relkind = 'r'
     )
     OR (
       SELECT count(*)
       FROM pg_catalog.pg_attribute attribute_row
       WHERE attribute_row.attrelid = receipt_oid
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
     ) <> 14
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('machine_id', 1, 'text', true, NULL::text),
         ('request_nonce', 2, 'uuid', true, NULL::text),
         ('operation', 3, 'text', true, NULL::text),
         ('signed_at', 4, 'timestamp with time zone', true, NULL::text),
         ('body_sha256', 5, 'text', true, NULL::text),
         ('solver_version', 6, 'text', true, NULL::text),
         ('solver_binary_checksum', 7, 'text', true, NULL::text),
         ('pipeline_commit', 8, 'text', true, NULL::text),
         ('manifest_version', 9, 'text', true, NULL::text),
         ('manifest_checksum', 10, 'text', true, NULL::text),
         ('artifact_id', 11, 'uuid', false, NULL::text),
         ('scenario_hash', 12, 'text', false, NULL::text),
         ('source_artifact_checksum', 13, 'text', false, NULL::text),
         ('received_at', 14, 'timestamp with time zone', true,
          'clock_timestamp()'::text)
       ) AS expected(attname, attnum, type_name, attnotnull, default_expr)
       LEFT JOIN pg_catalog.pg_attribute actual
         ON actual.attrelid = receipt_oid
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
       WHERE constraint_row.conrelid = receipt_oid
     ) <> 6
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = receipt_oid
         AND constraint_row.conname = 'training_solver_worker_receipts_pkey'
         AND constraint_row.contype = 'p'
         AND constraint_row.convalidated
         AND NOT constraint_row.condeferrable
         AND NOT constraint_row.condeferred
         AND constraint_row.conkey = ARRAY[1, 2]::smallint[]
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('training_solver_worker_receipts_machine_check',
          $$CHECK ((machine_id = ANY (ARRAY['M1'::text, 'M2'::text])))$$),
         ('training_solver_worker_receipts_operation_check',
          $$CHECK ((operation = ANY (ARRAY['ingest_artifact'::text, 'row_states'::text, 'board_page'::text, 'heartbeat'::text])))$$),
         ('training_solver_worker_receipts_body_check',
          $$CHECK ((body_sha256 ~ '^[0-9a-f]{64}$'::text))$$),
         ('training_solver_worker_receipts_provenance_check',
          $$CHECK ((((char_length(btrim(solver_version)) >= 1) AND (char_length(btrim(solver_version)) <= 120)) AND (solver_binary_checksum ~ '^[0-9a-f]{64}$'::text) AND (pipeline_commit ~ '^[0-9a-f]{40}$'::text) AND ((char_length(btrim(manifest_version)) >= 1) AND (char_length(btrim(manifest_version)) <= 160)) AND (manifest_checksum ~ '^[0-9a-f]{64}$'::text)))$$),
         ('training_solver_worker_receipts_artifact_check',
          $$CHECK (((operation = 'ingest_artifact'::text) = ((artifact_id IS NOT NULL) AND (scenario_hash IS NOT NULL) AND ((char_length(scenario_hash) >= 1) AND (char_length(scenario_hash) <= 512)) AND (source_artifact_checksum ~ '^[0-9a-f]{64}$'::text))))$$)
       ) expected(conname, definition)
       LEFT JOIN pg_catalog.pg_constraint actual
         ON actual.conrelid = receipt_oid
        AND actual.conname = expected.conname
        AND actual.contype = 'c'
       WHERE actual.oid IS NULL
          OR NOT actual.convalidated
          OR pg_catalog.btrim(pg_catalog.regexp_replace(
               pg_catalog.pg_get_constraintdef(actual.oid, false),
               '[[:space:]]+', ' ', 'g'
             )) IS DISTINCT FROM expected.definition
     ) THEN
    RAISE EXCEPTION 'TRAINING_SOLVER_WORKER_RECEIPT_CONTRACT_INCOMPLETE';
  END IF;
END;
$assert_worker_receipt_shape$;

CREATE INDEX IF NOT EXISTS idx_training_solver_worker_receipts_received
  ON public.training_solver_worker_receipts (received_at, machine_id);

-- board_page is intentionally a keyset query on this exact left prefix. The
-- 80 GB reference table must already have the production index built by the
-- dedicated online index migration; never fall back to a hot-primary scan.
DO $assert_worker_board_page_index$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index index_row
    JOIN pg_class table_row ON table_row.oid = index_row.indrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
    JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
    JOIN pg_am access_method ON access_method.oid = index_class.relam
    WHERE namespace_row.nspname = 'public'
      AND table_row.relname = 'solved_spots_gold'
      AND access_method.amname = 'btree'
      AND index_class.relkind = 'i'
      AND index_row.indisvalid
      AND index_row.indisready
      AND NOT index_row.indisunique
      AND NOT index_row.indisprimary
      AND NOT index_row.indisexclusion
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 4
      AND index_row.indnatts = 4
      AND (
        SELECT array_agg(attribute_row.attname::text ORDER BY key_column.ordinality)
        FROM unnest(index_row.indkey::smallint[]) WITH ORDINALITY
          AS key_column(attnum, ordinality)
        JOIN pg_attribute attribute_row
          ON attribute_row.attrelid = index_row.indrelid
         AND attribute_row.attnum = key_column.attnum
        WHERE key_column.ordinality <= 4
      ) = ARRAY['game_type', 'stack_depth', 'street', 'scenario_hash']::text[]
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.generate_series(0, 3) AS key_position(position)
        JOIN pg_catalog.pg_attribute indexed_attribute
          ON indexed_attribute.attrelid = index_row.indrelid
         AND indexed_attribute.attnum = index_row.indkey[key_position.position]
        JOIN pg_catalog.pg_opclass operator_class
          ON operator_class.oid = index_row.indclass[key_position.position]
        WHERE index_row.indoption[key_position.position] <> 0
           OR index_row.indcollation[key_position.position]
              IS DISTINCT FROM indexed_attribute.attcollation
           OR operator_class.opcmethod <> index_class.relam
           OR NOT operator_class.opcdefault
           OR operator_class.opcintype <> indexed_attribute.atttypid
      )
  ) THEN
    RAISE EXCEPTION 'TRAINING_SOLVER_WORKER_BOARD_PAGE_INDEX_MISSING';
  END IF;
END;
$assert_worker_board_page_index$;

-- row_states is keyed by scenario_hash alone. The four-column board index
-- cannot serve that equality predicate because scenario_hash is its trailing
-- column, so require one exact standalone physical btree as a deployment gate.
DO $assert_worker_scenario_hash_index$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index index_row
    JOIN pg_class index_table ON index_table.oid = index_row.indrelid
    JOIN pg_namespace table_schema ON table_schema.oid = index_table.relnamespace
    JOIN pg_class physical_index ON physical_index.oid = index_row.indexrelid
    JOIN pg_am access_method ON access_method.oid = physical_index.relam
    WHERE table_schema.nspname = 'public'
      AND index_table.relname = 'solved_spots_gold'
      AND access_method.amname = 'btree'
      AND physical_index.relkind = 'i'
      AND index_row.indisvalid
      AND index_row.indisready
      AND NOT index_row.indisunique
      AND NOT index_row.indisprimary
      AND NOT index_row.indisexclusion
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND (
        SELECT array_agg(attribute_row.attname::text ORDER BY key_column.ordinality)
        FROM unnest(index_row.indkey::smallint[]) WITH ORDINALITY
          AS key_column(attnum, ordinality)
        JOIN pg_attribute attribute_row
          ON attribute_row.attrelid = index_row.indrelid
         AND attribute_row.attnum = key_column.attnum
      ) = ARRAY['scenario_hash']::text[]
      AND index_row.indoption[0] = 0
      AND index_row.indcollation[0] = (
        SELECT indexed_attribute.attcollation
        FROM pg_catalog.pg_attribute indexed_attribute
        WHERE indexed_attribute.attrelid = index_row.indrelid
          AND indexed_attribute.attnum = index_row.indkey[0]
      )
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_opclass operator_class
        JOIN pg_catalog.pg_attribute indexed_attribute
          ON indexed_attribute.attrelid = index_row.indrelid
         AND indexed_attribute.attnum = index_row.indkey[0]
        WHERE operator_class.oid = index_row.indclass[0]
          AND operator_class.opcmethod = physical_index.relam
          AND operator_class.opcdefault
          AND operator_class.opcintype = indexed_attribute.atttypid
      )
  ) THEN
    RAISE EXCEPTION 'TRAINING_SOLVER_WORKER_SCENARIO_HASH_INDEX_MISSING';
  END IF;
END;
$assert_worker_scenario_hash_index$;

CREATE OR REPLACE FUNCTION public.training_claim_solver_worker_request_v1(
  p_machine_id text,
  p_solver_version text,
  p_solver_binary_checksum text,
  p_pipeline_commit text,
  p_manifest_version text,
  p_manifest_checksum text,
  p_nonce uuid,
  p_operation text,
  p_signed_at timestamptz,
  p_body_sha256 text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_inserted integer;
BEGIN
  IF p_machine_id NOT IN ('M1', 'M2')
     OR p_operation NOT IN ('row_states', 'board_page', 'heartbeat')
     OR p_nonce IS NULL
     OR p_signed_at IS NULL
     OR abs(extract(epoch FROM (clock_timestamp() - p_signed_at))) > 300
     OR coalesce(p_body_sha256, '') !~ '^[0-9a-f]{64}$'
     OR NOT EXISTS (
       SELECT 1
       FROM public.training_solver_provenance_authority authority
       WHERE authority.machine_id = p_machine_id
         AND authority.solver_version = p_solver_version
         AND authority.solver_binary_checksum = p_solver_binary_checksum
         AND authority.pipeline_commit = p_pipeline_commit
         AND authority.manifest_version = p_manifest_version
         AND authority.manifest_checksum = p_manifest_checksum
         AND authority.retired_at IS NULL
     ) THEN
    RETURN false;
  END IF;

  -- A signature older than five minutes can never be accepted again. Retain
  -- receipts for 24 hours for incident evidence and prune only a bounded batch
  -- so heartbeat/poll nonces cannot grow this private ledger without limit.
  WITH stale_candidates AS MATERIALIZED (
    SELECT candidate.machine_id, candidate.request_nonce
    FROM public.training_solver_worker_receipts candidate
    WHERE candidate.received_at < clock_timestamp() - interval '24 hours'
    ORDER BY candidate.received_at, candidate.machine_id
    FOR UPDATE SKIP LOCKED
    LIMIT 100
  )
  DELETE FROM public.training_solver_worker_receipts stale
  USING stale_candidates candidate
  WHERE stale.machine_id = candidate.machine_id
    AND stale.request_nonce = candidate.request_nonce;

  INSERT INTO public.training_solver_worker_receipts (
    machine_id, request_nonce, operation, signed_at, body_sha256,
    solver_version, solver_binary_checksum, pipeline_commit,
    manifest_version, manifest_checksum
  ) VALUES (
    p_machine_id, p_nonce, p_operation, p_signed_at, p_body_sha256,
    p_solver_version, p_solver_binary_checksum, p_pipeline_commit,
    p_manifest_version, p_manifest_checksum
  ) ON CONFLICT (machine_id, request_nonce) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.training_claim_solver_worker_request_v1(
  text, text, text, text, text, text, uuid, text, timestamptz, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.training_claim_solver_worker_request_v1(
  text, text, text, text, text, text, uuid, text, timestamptz, text
) TO service_role;

-- Worker resume state must distinguish a reservable warehouse identity from a
-- currently admitted artifact. A field-shaped warehouse row is not certified
-- unless the catalog identity and exact active provenance tuple join in this
-- same statement/snapshot.
CREATE OR REPLACE FUNCTION public.training_solver_worker_row_states_v1(
  p_scenario_hashes text[]
)
RETURNS TABLE(
  id uuid,
  scenario_hash text,
  game_type text,
  stack_depth integer,
  street text,
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

-- Board discovery is the only worker operation that needs to enumerate the
-- warehouse. This worker path stays behind a narrow function and has no raw
-- write capability; PR A temporarily preserves predecessor read-only SELECT
-- solely for migration-first rollback compatibility. The explicit bounds and
-- keyset cursor match the required four-column btree; no LIKE predicate is
-- used.
CREATE OR REPLACE FUNCTION public.training_solver_worker_board_page_v1(
  p_game_type text,
  p_stack_depth integer,
  p_street text,
  p_position text,
  p_after_scenario text DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE(scenario_hash text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
ROWS 500
AS $function$
DECLARE
  v_prefix text;
  v_upper_bound text;
BEGIN
  IF NOT (
       (p_game_type = 'hu_cash' AND p_stack_depth IN (40, 100, 200))
       OR (p_game_type = 'mtt_3max_chipev' AND p_stack_depth = 20)
       OR (p_game_type = 'mtt_6max_chipev' AND p_stack_depth IN (10, 20, 40, 100))
       OR (p_game_type = 'mtt_9max_chipev' AND p_stack_depth IN (20, 40, 80, 100))
       OR (p_game_type = 'mtt_hu_chipev' AND p_stack_depth = 40)
       OR (p_game_type = 'postflop_complete' AND p_stack_depth = 100)
       OR (p_game_type = 'spin_3max_chipev' AND p_stack_depth IN (20, 25))
       OR (p_game_type = 'spin_hu_chipev' AND p_stack_depth IN (10, 20))
     )
     OR p_street IS DISTINCT FROM 'flop'
     OR coalesce(p_position, '') !~
       '^(UTG|UTG\+1|UTG\+2|UTG1|UTG2|MP|MP\+1|MP\+2|MP1|MP2|LJ|HJ|CO|BTN|SB|BB)$'
     OR p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 500 THEN
    RETURN;
  END IF;

  v_prefix := p_game_type || '_' || p_position || '_'
    || p_stack_depth::text || 'bb_';
  -- Canonical suffixes begin with one of 2-9/T/J/Q/K/A. Z is therefore a
  -- strict upper bound in both C and the production en_US.UTF-8 collation.
  -- DEL is not safe here: locale-aware collations can sort printable board
  -- text after DEL and silently turn the page into an empty range.
  v_upper_bound := v_prefix || 'Z';
  IF p_after_scenario IS NOT NULL
     AND (
       NOT starts_with(p_after_scenario, v_prefix)
       OR substring(p_after_scenario FROM char_length(v_prefix) + 1)
          !~ '^([2-9TJQKA][cdhs]){3}$'
     ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT artifact.scenario_hash
  FROM public.solved_spots_gold artifact
  WHERE artifact.game_type = p_game_type
    AND artifact.stack_depth = p_stack_depth
    AND artifact.street = p_street
    AND artifact.scenario_hash >= v_prefix
    AND artifact.scenario_hash < v_upper_bound
    AND (p_after_scenario IS NULL OR artifact.scenario_hash > p_after_scenario)
  ORDER BY artifact.scenario_hash
  LIMIT p_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.training_solver_worker_board_page_v1(
  text, integer, text, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.training_solver_worker_board_page_v1(
  text, integer, text, text, text, integer
) TO service_role;

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
DECLARE
  v_artifact_id uuid;
  v_audited_at timestamptz;
  v_existing public.training_solver_worker_receipts%ROWTYPE;
  v_expected_keys text[] := ARRAY[
    'audited_at', 'game_type', 'id', 'machine_id', 'manifest_checksum',
    'manifest_version', 'pipeline_commit', 'quality_status', 'scenario_hash',
    'solved_v2_at', 'solver_binary_checksum', 'solver_version',
    'source_artifact_checksum', 'stack_depth', 'strategy_matrix_v2', 'street'
  ]::text[];
  v_inserted integer;
  v_solved_at timestamptz;
  v_updated integer;
BEGIN
  IF p_machine_id NOT IN ('M1', 'M2')
     OR p_nonce IS NULL
     OR p_signed_at IS NULL
     OR abs(extract(epoch FROM (clock_timestamp() - p_signed_at))) > 300
     OR coalesce(p_body_sha256, '') !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(p_artifact) IS DISTINCT FROM 'object'
     OR pg_column_size(p_artifact) > 2097152
     OR NOT EXISTS (
       SELECT 1
       FROM public.training_solver_provenance_authority authority
       WHERE authority.machine_id = p_machine_id
         AND authority.solver_version = p_solver_version
         AND authority.solver_binary_checksum = p_solver_binary_checksum
         AND authority.pipeline_commit = p_pipeline_commit
         AND authority.manifest_version = p_manifest_version
         AND authority.manifest_checksum = p_manifest_checksum
         AND authority.source_combo_order_sha256 =
           p_artifact -> 'strategy_matrix_v2' ->> 'source_combo_order_sha256'
         AND authority.training_game_contracts_sha256 =
           p_artifact -> 'strategy_matrix_v2' ->> 'training_game_contracts_sha256'
         AND authority.retired_at IS NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023', MESSAGE = 'SOLVER_WORKER_INGEST_AUTHORITY_INVALID';
  END IF;

  IF (
       SELECT array_agg(artifact_key.value ORDER BY artifact_key.value COLLATE "C")
       FROM jsonb_object_keys(p_artifact) AS artifact_key(value)
     ) IS DISTINCT FROM v_expected_keys THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023', MESSAGE = 'SOLVER_WORKER_ARTIFACT_SHAPE_INVALID';
  END IF;

  BEGIN
    v_artifact_id := (p_artifact ->> 'id')::uuid;
    v_solved_at := (p_artifact ->> 'solved_v2_at')::timestamptz;
    v_audited_at := (p_artifact ->> 'audited_at')::timestamptz;
  EXCEPTION
    WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023', MESSAGE = 'SOLVER_WORKER_ARTIFACT_TYPES_INVALID';
  END;

  IF p_artifact ->> 'machine_id' IS DISTINCT FROM p_machine_id
     OR p_artifact ->> 'solver_version' IS DISTINCT FROM p_solver_version
     OR p_artifact ->> 'solver_binary_checksum' IS DISTINCT FROM p_solver_binary_checksum
     OR p_artifact ->> 'pipeline_commit' IS DISTINCT FROM p_pipeline_commit
     OR p_artifact ->> 'manifest_version' IS DISTINCT FROM p_manifest_version
     OR p_artifact ->> 'manifest_checksum' IS DISTINCT FROM p_manifest_checksum
     OR p_artifact ->> 'quality_status' IS DISTINCT FROM 'validated'
     OR p_artifact ->> 'game_type' LIKE '%\_icm' ESCAPE '\'
     OR jsonb_typeof(p_artifact -> 'stack_depth') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_artifact -> 'strategy_matrix_v2') IS DISTINCT FROM 'object'
     OR v_solved_at IS DISTINCT FROM v_audited_at
     OR abs(extract(epoch FROM (p_signed_at - v_audited_at))) > 300 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023', MESSAGE = 'SOLVER_WORKER_ARTIFACT_BINDING_INVALID';
  END IF;

  IF NOT public.fn_training_solver_artifact_servable_v2(
    p_artifact ->> 'scenario_hash',
    p_artifact ->> 'game_type',
    (p_artifact ->> 'stack_depth')::integer,
    p_artifact ->> 'street',
    p_artifact -> 'strategy_matrix_v2',
    p_solver_version,
    p_solver_binary_checksum,
    p_machine_id,
    p_pipeline_commit,
    p_manifest_version,
    p_manifest_checksum,
    p_artifact ->> 'source_artifact_checksum',
    p_artifact ->> 'quality_status',
    v_audited_at
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'SOLVER_WORKER_ARTIFACT_NOT_SERVABLE';
  END IF;

  WITH stale_candidates AS MATERIALIZED (
    SELECT candidate.machine_id, candidate.request_nonce
    FROM public.training_solver_worker_receipts candidate
    WHERE candidate.received_at < clock_timestamp() - interval '24 hours'
    ORDER BY candidate.received_at, candidate.machine_id
    FOR UPDATE SKIP LOCKED
    LIMIT 100
  )
  DELETE FROM public.training_solver_worker_receipts stale
  USING stale_candidates candidate
  WHERE stale.machine_id = candidate.machine_id
    AND stale.request_nonce = candidate.request_nonce;

  SELECT receipt.*
  INTO v_existing
  FROM public.training_solver_worker_receipts receipt
  WHERE receipt.machine_id = p_machine_id
    AND receipt.request_nonce = p_nonce
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.operation = 'ingest_artifact'
       AND v_existing.body_sha256 = p_body_sha256
       AND v_existing.solver_version = p_solver_version
       AND v_existing.solver_binary_checksum = p_solver_binary_checksum
       AND v_existing.pipeline_commit = p_pipeline_commit
       AND v_existing.manifest_version = p_manifest_version
       AND v_existing.manifest_checksum = p_manifest_checksum
       AND v_existing.artifact_id = v_artifact_id
       AND v_existing.scenario_hash = p_artifact ->> 'scenario_hash'
       AND v_existing.source_artifact_checksum =
         p_artifact ->> 'source_artifact_checksum' THEN
      IF EXISTS (
        SELECT 1
        FROM public.solved_spots_gold artifact
        JOIN public.training_solver_artifact_catalog catalog
          ON catalog.artifact_id = artifact.id
         AND catalog.scenario_hash = artifact.scenario_hash
         AND catalog.game_type = artifact.game_type
         AND catalog.stack_depth = artifact.stack_depth
         AND catalog.street = artifact.street
        WHERE artifact.id = v_artifact_id
          AND artifact.scenario_hash = p_artifact ->> 'scenario_hash'
          AND artifact.game_type = p_artifact ->> 'game_type'
          AND artifact.stack_depth = (p_artifact ->> 'stack_depth')::integer
          AND artifact.street = p_artifact ->> 'street'
          AND artifact.strategy_matrix_v2 IS NOT DISTINCT FROM
            p_artifact -> 'strategy_matrix_v2'
          AND artifact.solved_v2_at IS NOT DISTINCT FROM v_solved_at
          AND artifact.solver_version = p_solver_version
          AND artifact.solver_binary_checksum = p_solver_binary_checksum
          AND artifact.machine_id = p_machine_id
          AND artifact.pipeline_commit = p_pipeline_commit
          AND artifact.manifest_version = p_manifest_version
          AND artifact.manifest_checksum = p_manifest_checksum
          AND artifact.source_artifact_checksum =
            p_artifact ->> 'source_artifact_checksum'
          AND artifact.quality_status = 'validated'
          AND artifact.audited_at IS NOT DISTINCT FROM v_audited_at
      ) THEN
        RETURN QUERY SELECT
          v_existing.artifact_id,
          v_existing.scenario_hash,
          v_existing.source_artifact_checksum,
          true;
        RETURN;
      END IF;
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'SOLVER_WORKER_REPLAY_ARTIFACT_NOT_CURRENT';
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '23505', MESSAGE = 'SOLVER_WORKER_NONCE_REUSE_CONFLICT';
  END IF;

  INSERT INTO public.training_solver_worker_receipts (
    machine_id, request_nonce, operation, signed_at, body_sha256,
    solver_version, solver_binary_checksum, pipeline_commit,
    manifest_version, manifest_checksum, artifact_id, scenario_hash,
    source_artifact_checksum
  ) VALUES (
    p_machine_id, p_nonce, 'ingest_artifact', p_signed_at, p_body_sha256,
    p_solver_version, p_solver_binary_checksum, p_pipeline_commit,
    p_manifest_version, p_manifest_checksum, v_artifact_id,
    p_artifact ->> 'scenario_hash', p_artifact ->> 'source_artifact_checksum'
  ) ON CONFLICT (machine_id, request_nonce) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> 1 THEN
    -- A concurrent request consumed the nonce. Re-enter once now that the
    -- unique-index wait has completed; it must be byte-identical to replay.
    SELECT receipt.*
    INTO v_existing
    FROM public.training_solver_worker_receipts receipt
    WHERE receipt.machine_id = p_machine_id
      AND receipt.request_nonce = p_nonce
    FOR UPDATE;
    IF v_existing.operation = 'ingest_artifact'
       AND v_existing.body_sha256 = p_body_sha256
       AND v_existing.solver_version = p_solver_version
       AND v_existing.solver_binary_checksum = p_solver_binary_checksum
       AND v_existing.pipeline_commit = p_pipeline_commit
       AND v_existing.manifest_version = p_manifest_version
       AND v_existing.manifest_checksum = p_manifest_checksum
       AND v_existing.artifact_id = v_artifact_id
       AND v_existing.scenario_hash = p_artifact ->> 'scenario_hash'
       AND v_existing.source_artifact_checksum =
         p_artifact ->> 'source_artifact_checksum' THEN
      IF EXISTS (
        SELECT 1
        FROM public.solved_spots_gold artifact
        JOIN public.training_solver_artifact_catalog catalog
          ON catalog.artifact_id = artifact.id
         AND catalog.scenario_hash = artifact.scenario_hash
         AND catalog.game_type = artifact.game_type
         AND catalog.stack_depth = artifact.stack_depth
         AND catalog.street = artifact.street
        WHERE artifact.id = v_artifact_id
          AND artifact.scenario_hash = p_artifact ->> 'scenario_hash'
          AND artifact.game_type = p_artifact ->> 'game_type'
          AND artifact.stack_depth = (p_artifact ->> 'stack_depth')::integer
          AND artifact.street = p_artifact ->> 'street'
          AND artifact.strategy_matrix_v2 IS NOT DISTINCT FROM
            p_artifact -> 'strategy_matrix_v2'
          AND artifact.solved_v2_at IS NOT DISTINCT FROM v_solved_at
          AND artifact.solver_version = p_solver_version
          AND artifact.solver_binary_checksum = p_solver_binary_checksum
          AND artifact.machine_id = p_machine_id
          AND artifact.pipeline_commit = p_pipeline_commit
          AND artifact.manifest_version = p_manifest_version
          AND artifact.manifest_checksum = p_manifest_checksum
          AND artifact.source_artifact_checksum =
            p_artifact ->> 'source_artifact_checksum'
          AND artifact.quality_status = 'validated'
          AND artifact.audited_at IS NOT DISTINCT FROM v_audited_at
      ) THEN
        RETURN QUERY SELECT
          v_existing.artifact_id,
          v_existing.scenario_hash,
          v_existing.source_artifact_checksum,
          true;
        RETURN;
      END IF;
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'SOLVER_WORKER_REPLAY_ARTIFACT_NOT_CURRENT';
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '23505', MESSAGE = 'SOLVER_WORKER_NONCE_REUSE_CONFLICT';
  END IF;

  UPDATE public.solved_spots_gold artifact
  SET strategy_matrix_v2 = p_artifact -> 'strategy_matrix_v2',
      solved_v2_at = v_solved_at,
      solver_version = p_solver_version,
      solver_binary_checksum = p_solver_binary_checksum,
      machine_id = p_machine_id,
      pipeline_commit = p_pipeline_commit,
      manifest_version = p_manifest_version,
      manifest_checksum = p_manifest_checksum,
      source_artifact_checksum = p_artifact ->> 'source_artifact_checksum',
      quality_status = 'validated',
      audited_at = v_audited_at
  WHERE artifact.id = v_artifact_id
    AND artifact.scenario_hash = p_artifact ->> 'scenario_hash'
    AND artifact.game_type = p_artifact ->> 'game_type'
    AND artifact.stack_depth = (p_artifact ->> 'stack_depth')::integer
    AND artifact.street = p_artifact ->> 'street';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 OR NOT EXISTS (
    SELECT 1
    FROM public.training_solver_artifact_catalog catalog
    WHERE catalog.artifact_id = v_artifact_id
      AND catalog.scenario_hash = p_artifact ->> 'scenario_hash'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'SOLVER_WORKER_EXACT_ARTIFACT_NOT_UPDATED';
  END IF;

  RETURN QUERY SELECT
    v_artifact_id,
    p_artifact ->> 'scenario_hash',
    p_artifact ->> 'source_artifact_checksum',
    false;
END;
$function$;

REVOKE ALL ON FUNCTION public.training_ingest_solver_artifact_v1(
  text, text, text, text, text, text, uuid, timestamptz, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.training_ingest_solver_artifact_v1(
  text, text, text, text, text, text, uuid, timestamptz, text, jsonb
) TO service_role;

-- The service key may invoke the narrow SECURITY DEFINER read/write RPCs. PR A
-- also preserves the predecessor application's read-only warehouse SELECT so
-- a migration-first rollout and rollback cannot outage Training. No raw write,
-- ownership, trigger, reference, or maintenance privilege survives. The held
-- enforcement migration removes SELECT only after live replacement and
-- predecessor compatibility have both been attested.
REVOKE ALL ON public.solved_spots_gold FROM service_role;
GRANT SELECT ON public.solved_spots_gold TO service_role;
DO $revoke_worker_warehouse_column_dml$
DECLARE
  v_columns text;
BEGIN
  SELECT string_agg(quote_ident(attribute_row.attname), ', ' ORDER BY attribute_row.attnum)
  INTO v_columns
  FROM pg_attribute attribute_row
  WHERE attribute_row.attrelid = 'public.solved_spots_gold'::regclass
    AND attribute_row.attnum > 0
    AND NOT attribute_row.attisdropped;
  IF v_columns IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%s) ON public.solved_spots_gold FROM service_role',
      v_columns
    );
  END IF;
END;
$revoke_worker_warehouse_column_dml$;

-- The legacy aggregate has no runtime consumer and remains operator-only,
-- invoker-rights, input-bounded, and unavailable to every application role.
-- Do not turn it into a SECURITY DEFINER escape hatch around warehouse ACLs.
REVOKE ALL ON FUNCTION public.analyze_spots_by_game_type(text, integer)
  FROM PUBLIC, anon, authenticated, service_role;

DO $worker_ingest_contract_assertions$
DECLARE
  v_claim_definition text;
  v_board_page_definition text;
  v_ingest_definition text;
  v_row_states_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.training_claim_solver_worker_request_v1(text,text,text,text,text,text,uuid,text,timestamp with time zone,text)'::regprocedure
  ) INTO v_claim_definition;
  SELECT pg_get_functiondef(
    'public.training_ingest_solver_artifact_v1(text,text,text,text,text,text,uuid,timestamp with time zone,text,jsonb)'::regprocedure
  ) INTO v_ingest_definition;
  SELECT pg_get_functiondef(
    'public.training_solver_worker_row_states_v1(text[])'::regprocedure
  ) INTO v_row_states_definition;
  SELECT pg_get_functiondef(
    'public.training_solver_worker_board_page_v1(text,integer,text,text,text,integer)'::regprocedure
  ) INTO v_board_page_definition;

  IF NOT (
       SELECT class_row.relrowsecurity
       FROM pg_class class_row
       WHERE class_row.oid = 'public.training_solver_worker_receipts'::regclass
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
         'public.training_solver_worker_receipts',
         privilege_under_test.privilege_name
       )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute attributes
       CROSS JOIN LATERAL pg_catalog.aclexplode(attributes.attacl) acl
       WHERE attributes.attrelid =
         'public.training_solver_worker_receipts'::pg_catalog.regclass
         AND attributes.attnum > 0
         AND NOT attributes.attisdropped
         AND acl.grantee IN (
           0,
           pg_catalog.to_regrole('anon'),
           pg_catalog.to_regrole('authenticated'),
           pg_catalog.to_regrole('service_role')
         )
     )
     OR NOT has_table_privilege(
       'service_role', 'public.solved_spots_gold', 'SELECT'
     )
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES
           ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
           ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')
       ) AS privilege_under_test(privilege_name)
       WHERE has_table_privilege(
         'service_role',
         'public.solved_spots_gold',
         privilege_under_test.privilege_name
       )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_attribute attribute_row
       WHERE attribute_row.attrelid = 'public.solved_spots_gold'::regclass
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
         AND (
           has_column_privilege(
             'service_role', 'public.solved_spots_gold', attribute_row.attname, 'INSERT'
           )
           OR has_column_privilege(
             'service_role', 'public.solved_spots_gold', attribute_row.attname, 'UPDATE'
           )
         )
     )
     OR has_function_privilege(
       'anon',
       'public.training_ingest_solver_artifact_v1(text,text,text,text,text,text,uuid,timestamp with time zone,text,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.training_ingest_solver_artifact_v1(text,text,text,text,text,text,uuid,timestamp with time zone,text,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.training_ingest_solver_artifact_v1(text,text,text,text,text,text,uuid,timestamp with time zone,text,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.training_claim_solver_worker_request_v1(text,text,text,text,text,text,uuid,text,timestamp with time zone,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.training_claim_solver_worker_request_v1(text,text,text,text,text,text,uuid,text,timestamp with time zone,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.training_claim_solver_worker_request_v1(text,text,text,text,text,text,uuid,text,timestamp with time zone,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.training_solver_worker_row_states_v1(text[])',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.training_solver_worker_row_states_v1(text[])',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.training_solver_worker_row_states_v1(text[])',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.training_solver_worker_board_page_v1(text,integer,text,text,text,integer)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.training_solver_worker_board_page_v1(text,integer,text,text,text,integer)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.training_solver_worker_board_page_v1(text,integer,text,text,text,integer)',
       'EXECUTE'
     )
     OR position('artifact.scenario_hash >= v_prefix' IN v_board_page_definition) = 0
     OR position('artifact.scenario_hash < v_upper_bound' IN v_board_page_definition) = 0
     OR position('artifact.scenario_hash > p_after_scenario' IN v_board_page_definition) = 0
     OR position('SELECT DISTINCT artifact.scenario_hash' IN v_board_page_definition) = 0
     OR position('ORDER BY artifact.scenario_hash' IN v_board_page_definition) = 0
     OR position('LIMIT p_limit' IN v_board_page_definition) = 0
     OR NOT (
       'hu_cash_BTN_100bb_2c2d2h' >= 'hu_cash_BTN_100bb_'
       AND 'hu_cash_BTN_100bb_2c2d2h' < 'hu_cash_BTN_100bb_Z'
       AND 'hu_cash_BTN_100bb_AsAhAd' < 'hu_cash_BTN_100bb_Z'
       AND 'hu_cash_BTN_100bb_TsKsQs' < 'hu_cash_BTN_100bb_Z'
     )
     OR position('training_solver_artifact_catalog catalog' IN v_row_states_definition) = 0
     OR position('authority.retired_at IS NULL' IN v_row_states_definition) = 0
     OR position('LIMIT 150' IN v_row_states_definition) = 0
     OR position('training_solver_provenance_authority' IN v_claim_definition) = 0
     OR position('ON CONFLICT (machine_id, request_nonce) DO NOTHING' IN v_claim_definition) = 0
     OR position('LIMIT 100' IN v_claim_definition) = 0
     OR position('FOR UPDATE ' || 'SKIP LOCKED' IN v_claim_definition) = 0
     OR position('fn_training_solver_artifact_servable_v2' IN v_ingest_definition) = 0
     OR position('UPDATE public.solved_spots_gold artifact' IN v_ingest_definition) = 0
     OR position('artifact.id = v_artifact_id' IN v_ingest_definition) = 0
     OR position('SOLVER_WORKER_NONCE_REUSE_CONFLICT' IN v_ingest_definition) = 0
     OR position('LIMIT 100' IN v_ingest_definition) = 0
     OR position('FOR UPDATE ' || 'SKIP LOCKED' IN v_ingest_definition) = 0
     OR (
       char_length(v_ingest_definition)
       - char_length(replace(
           v_ingest_definition,
           'SOLVER_WORKER_REPLAY_ARTIFACT_NOT_CURRENT',
           ''
         ))
     ) / char_length('SOLVER_WORKER_REPLAY_ARTIFACT_NOT_CURRENT') < 2
     OR (
       char_length(v_ingest_definition)
       - char_length(replace(
           v_ingest_definition,
           'JOIN public.training_solver_artifact_catalog catalog',
           ''
         ))
     ) / char_length('JOIN public.training_solver_artifact_catalog catalog') < 2
     OR position(
       'search_path=pg_catalog' IN coalesce(array_to_string((
         SELECT function_row.proconfig FROM pg_proc function_row
         WHERE function_row.oid =
           'public.training_ingest_solver_artifact_v1(text,text,text,text,text,text,uuid,timestamp with time zone,text,jsonb)'::regprocedure
         ), ','), '')
     ) = 0
     OR (
       SELECT function_row.prosecdef
       FROM pg_proc function_row
       WHERE function_row.oid =
         'public.analyze_spots_by_game_type(text,integer)'::regprocedure
     )
     OR has_function_privilege(
       'service_role',
       'public.analyze_spots_by_game_type(text,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'TRAINING_SOLVER_WORKER_INGEST_CONTRACT_INCOMPLETE';
  END IF;
END;
$worker_ingest_contract_assertions$;

COMMIT;
