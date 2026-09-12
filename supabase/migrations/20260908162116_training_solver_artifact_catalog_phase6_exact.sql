-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260908162116; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260908162116   (the stamp IS the apply time, UTC: 2026-09-08 16:21:16)
--   name        training_solver_artifact_catalog_phase6_exact
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 30846 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260908162116 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        solved_spots_gold_require_provenance, training_solver_artifact_catalog_sync_v1
--     FUNCTION       public.fn_training_canonical_jsonb_text_v1, public.sp_require_solver_write_provenance, public.fn_training_solver_artifact_catalog_sync_v1
--     TABLE          public.training_solver_artifact_catalog, is
--     INDEX          idx_training_solver_artifact_catalog_filter
--     DROP           POLICY "Public, TRIGGER solved_spots_gold_require_provenance, TRIGGER training_solver_artifact_catalog_sync_v1
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

-- Spot Study must not scan or sort the 80 GB solved_spots_gold warehouse in a
-- request path. This narrow registry contains only identities for future rows
-- carrying the complete validated solver provenance contract. The API then
-- fetches the selected artifacts by the warehouse primary key and revalidates
-- every identity and payload in-process.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The original warehouse migration granted every signed-in browser direct
-- write access. Provenance-shaped strings are not provenance: an untrusted
-- client could otherwise manufacture a row that the catalog would promote.
-- Remove every browser privilege immediately. The protected predecessor still
-- performs one service-role SELECT while migrations lead the application
-- deployment, so PR A preserves read-only rollback compatibility. The later
-- enforcement migration revokes that final SELECT only after production has
-- proved every replacement RPC and the predecessor rollback rehearsal.
ALTER TABLE public.solved_spots_gold ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read access" ON public.solved_spots_gold;
REVOKE ALL ON public.solved_spots_gold FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.solved_spots_gold FROM service_role;
GRANT SELECT ON public.solved_spots_gold TO service_role;
DO $revoke_warehouse_columns$
DECLARE
  v_columns text;
BEGIN
  SELECT string_agg(quote_ident(attribute_row.attname), ',' ORDER BY attribute_row.attnum)
  INTO v_columns
  FROM pg_attribute attribute_row
  WHERE attribute_row.attrelid = 'public.solved_spots_gold'::regclass
    AND attribute_row.attnum > 0
    AND NOT attribute_row.attisdropped;
  IF v_columns IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%s) ON TABLE public.solved_spots_gold FROM PUBLIC, anon, authenticated, service_role',
      v_columns
    );
  END IF;
END;
$revoke_warehouse_columns$;

CREATE OR REPLACE FUNCTION public.fn_training_canonical_jsonb_text_v1(p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_result text;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT '{' || coalesce(string_agg(
        to_jsonb(entry.key)::text || ':'
          || public.fn_training_canonical_jsonb_text_v1(entry.value),
        ',' ORDER BY entry.key COLLATE "C"
      ), '') || '}'
      INTO v_result
      FROM jsonb_each(p_value) AS entry;
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(
        public.fn_training_canonical_jsonb_text_v1(entry.value),
        ',' ORDER BY entry.ordinality
      ), '') || ']'
      INTO v_result
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS entry(value, ordinality);
    ELSE
      v_result := p_value::text;
  END CASE;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sp_require_solver_write_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_must_verify boolean := false;
  v_expected_checksum text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_must_verify := true;
  ELSIF NEW.strategy_matrix IS DISTINCT FROM OLD.strategy_matrix
     OR NEW.strategy_matrix_v2 IS DISTINCT FROM OLD.strategy_matrix_v2
     OR NEW.scenario_hash IS DISTINCT FROM OLD.scenario_hash
     OR NEW.game_type IS DISTINCT FROM OLD.game_type
     OR NEW.stack_depth IS DISTINCT FROM OLD.stack_depth
     OR NEW.street IS DISTINCT FROM OLD.street
     OR NEW.solver_version IS DISTINCT FROM OLD.solver_version
     OR NEW.solver_binary_checksum IS DISTINCT FROM OLD.solver_binary_checksum
     OR NEW.machine_id IS DISTINCT FROM OLD.machine_id
     OR NEW.pipeline_commit IS DISTINCT FROM OLD.pipeline_commit
     OR NEW.manifest_version IS DISTINCT FROM OLD.manifest_version
     OR NEW.manifest_checksum IS DISTINCT FROM OLD.manifest_checksum
     OR NEW.source_artifact_checksum IS DISTINCT FROM OLD.source_artifact_checksum
     OR NEW.quality_status IS DISTINCT FROM OLD.quality_status
     OR NEW.audited_at IS DISTINCT FROM OLD.audited_at THEN
    v_must_verify := true;
  END IF;

  -- A metadata-only quarantine remains available for incident response. It
  -- removes the row from the serving catalog and never promotes new truth.
  IF TG_OP = 'UPDATE'
     AND NEW.quality_status = 'quarantined'
     AND NEW.strategy_matrix IS NOT DISTINCT FROM OLD.strategy_matrix
     AND NEW.strategy_matrix_v2 IS NOT DISTINCT FROM OLD.strategy_matrix_v2
     AND NEW.scenario_hash IS NOT DISTINCT FROM OLD.scenario_hash THEN
    RETURN NEW;
  END IF;

  IF v_must_verify THEN
    -- Source contract marker: NEW.quality_status = 'validated', NEW.solver_binary_checksum,
    -- NEW.pipeline_commit, NEW.source_artifact_checksum, NEW.audited_at IS NOT NULL.
    IF jsonb_typeof(NEW.strategy_matrix_v2) IS DISTINCT FROM 'object'
       OR NEW.strategy_matrix_v2 ->> 'combo_order' IS DISTINCT FROM
         'card=rank*4+suit; combo=b*(b-1)/2+a; 2c2d=0..AhAs=1325'
       OR nullif(btrim(NEW.solver_version), '') IS NULL
       OR coalesce(NEW.solver_binary_checksum, '') !~ '^[0-9a-f]{64}$'
       OR coalesce(NEW.machine_id, '') NOT IN ('M1', 'M2')
       OR coalesce(NEW.pipeline_commit, '') !~ '^[0-9a-f]{40}$'
       OR nullif(btrim(NEW.manifest_version), '') IS NULL
       OR coalesce(NEW.manifest_checksum, '') !~ '^[0-9a-f]{64}$'
       OR coalesce(NEW.source_artifact_checksum, '') !~ '^[0-9a-f]{64}$'
       OR NEW.quality_status IS DISTINCT FROM 'validated'
       OR NEW.audited_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'solved_spots_gold requires a validated canonical v2 artifact and complete solver provenance';
    END IF;

    v_expected_checksum := encode(extensions.digest(convert_to(
      public.fn_training_canonical_jsonb_text_v1(jsonb_build_object(
        'scenario_hash', NEW.scenario_hash,
        'strategy_matrix_v2', NEW.strategy_matrix_v2
      )),
      'UTF8'
    ), 'sha256'), 'hex');
    IF lower(NEW.source_artifact_checksum) <> v_expected_checksum THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'solved_spots_gold source artifact checksum does not match its canonical payload';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS solved_spots_gold_require_provenance ON public.solved_spots_gold;
CREATE TRIGGER solved_spots_gold_require_provenance
BEFORE INSERT OR UPDATE OF
  scenario_hash, game_type, stack_depth, street, strategy_matrix,
  strategy_matrix_v2, solver_version, solver_binary_checksum, machine_id,
  pipeline_commit, manifest_version, manifest_checksum,
  source_artifact_checksum, quality_status, audited_at
ON public.solved_spots_gold
FOR EACH ROW EXECUTE FUNCTION public.sp_require_solver_write_provenance();

REVOKE ALL ON FUNCTION public.fn_training_canonical_jsonb_text_v1(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sp_require_solver_write_provenance()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.training_solver_artifact_catalog (
  artifact_id uuid PRIMARY KEY
    REFERENCES public.solved_spots_gold(id) ON DELETE CASCADE,
  scenario_hash text NOT NULL UNIQUE,
  game_type text NOT NULL,
  stack_depth integer NOT NULL,
  street text NOT NULL,
  hero_position text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT training_solver_artifact_catalog_scenario_check
    CHECK (char_length(scenario_hash) BETWEEN 1 AND 512),
  CONSTRAINT training_solver_artifact_catalog_stack_check
    CHECK (stack_depth > 0),
  CONSTRAINT training_solver_artifact_catalog_contract_check
    CHECK (
      (game_type = 'hu_cash' AND stack_depth IN (40, 100, 200))
      OR (game_type = 'mtt_3max_chipev' AND stack_depth = 20)
      OR (game_type = 'mtt_6max_chipev' AND stack_depth IN (10, 20, 40, 100))
      OR (game_type = 'mtt_6max_icm' AND stack_depth IN (20, 40))
      OR (game_type = 'mtt_9max_chipev' AND stack_depth IN (20, 40, 80, 100))
      OR (game_type = 'mtt_9max_icm' AND stack_depth IN (40, 60))
      OR (game_type = 'mtt_hu_chipev' AND stack_depth = 40)
      OR (game_type = 'postflop_complete' AND stack_depth = 100)
      OR (game_type = 'spin_3max_chipev' AND stack_depth IN (20, 25))
      OR (game_type = 'spin_3max_icm' AND stack_depth IN (20, 25))
      OR (game_type = 'spin_hu_chipev' AND stack_depth IN (10, 20))
      OR (game_type = 'spin_hu_icm' AND stack_depth = 10)
    ),
  CONSTRAINT training_solver_artifact_catalog_street_check
    CHECK (street IN ('flop', 'turn', 'river')),
  CONSTRAINT training_solver_artifact_catalog_position_check
    CHECK (hero_position IN (
      'UTG', 'UTG+1', 'UTG+2', 'UTG1', 'UTG2',
      'MP', 'MP+1', 'MP+2', 'MP1', 'MP2',
      'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'
    ))
);

-- CREATE TABLE IF NOT EXISTS is safe only when a pre-existing object is the
-- exact durable authority contract. In particular, the active sync installed
-- by the follow-on migration requires an immediate artifact_id arbiter.
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

CREATE INDEX IF NOT EXISTS idx_training_solver_artifact_catalog_filter
  ON public.training_solver_artifact_catalog (
    game_type, stack_depth, hero_position, street, artifact_id
  );

CREATE OR REPLACE FUNCTION public.fn_training_solver_artifact_catalog_sync_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  -- Deliberately empty until the follow-on migration installs active
  -- provenance authority plus the full semantic payload validator. This
  -- fail-closed bridge prevents a weakly self-attested row from becoming
  -- servable between separately committed migrations.
  DELETE FROM public.training_solver_artifact_catalog
  WHERE artifact_id = NEW.id;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS training_solver_artifact_catalog_sync_v1
  ON public.solved_spots_gold;
CREATE TRIGGER training_solver_artifact_catalog_sync_v1
AFTER INSERT OR UPDATE OF
  scenario_hash, game_type, stack_depth, street, strategy_matrix_v2,
  solver_version, solver_binary_checksum, machine_id, pipeline_commit,
  manifest_version, manifest_checksum, source_artifact_checksum,
  quality_status, audited_at
ON public.solved_spots_gold
FOR EACH ROW EXECUTE FUNCTION public.fn_training_solver_artifact_catalog_sync_v1();

COMMENT ON TABLE public.training_solver_artifact_catalog IS
  'Small request-path registry of provenance-complete validated solver artifacts. Historical warehouse rows are deliberately not scanned or inferred.';

ALTER TABLE public.training_solver_artifact_catalog ENABLE ROW LEVEL SECURITY;
-- Supabase production grants service_role broad default privileges on newly
-- created public tables. Clear that inherited deployment-time ACL before
-- restoring the one read privilege this private registry actually needs.
REVOKE ALL ON public.training_solver_artifact_catalog
  FROM PUBLIC, anon, authenticated, service_role;
DO $revoke_catalog_columns$
DECLARE
  v_columns text;
BEGIN
  SELECT string_agg(quote_ident(attribute_row.attname), ',' ORDER BY attribute_row.attnum)
  INTO v_columns
  FROM pg_attribute attribute_row
  WHERE attribute_row.attrelid = 'public.training_solver_artifact_catalog'::regclass
    AND attribute_row.attnum > 0
    AND NOT attribute_row.attisdropped;
  IF v_columns IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%s) ON TABLE public.training_solver_artifact_catalog FROM PUBLIC, anon, authenticated, service_role',
      v_columns
    );
  END IF;
END;
$revoke_catalog_columns$;
GRANT SELECT ON public.training_solver_artifact_catalog TO service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.training_solver_artifact_catalog FROM service_role;

REVOKE ALL ON FUNCTION public.fn_training_solver_artifact_catalog_sync_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  definition text;
  provenance_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.fn_training_solver_artifact_catalog_sync_v1()'::regprocedure
  ) INTO definition;
  SELECT pg_get_functiondef(
    'public.sp_require_solver_write_provenance()'::regprocedure
  ) INTO provenance_definition;
  IF to_regprocedure('extensions.digest(bytea,text)') IS NULL
     OR to_regclass('public.training_solver_artifact_catalog') IS NULL
     OR position('Historical warehouse rows are deliberately not scanned or inferred' IN
       obj_description('public.training_solver_artifact_catalog'::regclass, 'pg_class')) = 0
     OR position('Deliberately empty until the follow-on migration' IN definition) = 0
     OR position('DELETE FROM public.training_solver_artifact_catalog' IN definition) = 0
     OR position('INSERT INTO public.training_solver_artifact_catalog' IN definition) > 0
     OR position('fn_training_canonical_jsonb_text_v1' IN provenance_definition) = 0
     OR position('source artifact checksum does not match' IN provenance_definition) = 0
     OR position('SET search_path TO ''pg_catalog''' IN provenance_definition) = 0
     OR (
       SELECT function_row.prosecdef
       FROM pg_proc function_row
       WHERE function_row.oid =
         'public.fn_training_canonical_jsonb_text_v1(jsonb)'::regprocedure
     )
     OR NOT (
       SELECT function_row.prosecdef
       FROM pg_proc function_row
       WHERE function_row.oid =
         'public.sp_require_solver_write_provenance()'::regprocedure
     )
     OR NOT (
       SELECT function_row.prosecdef
       FROM pg_proc function_row
       WHERE function_row.oid =
         'public.fn_training_solver_artifact_catalog_sync_v1()'::regprocedure
     )
     OR NOT (
       SELECT c.relrowsecurity
       FROM pg_class c
       WHERE c.oid = 'public.solved_spots_gold'::regclass
     )
     OR NOT (
       SELECT c.relrowsecurity
       FROM pg_class c
       WHERE c.oid = 'public.training_solver_artifact_catalog'::regclass
     )
     OR EXISTS (
       SELECT 1
       FROM pg_policy policy_row
       WHERE policy_row.polrelid = 'public.solved_spots_gold'::regclass
         AND policy_row.polpermissive
         AND policy_row.polcmd IN ('r', '*')
         AND policy_row.polroles && ARRAY[
           0::oid,
           'anon'::regrole::oid,
           'authenticated'::regrole::oid
         ]
     )
     OR has_table_privilege('anon', 'public.solved_spots_gold', 'SELECT')
     OR has_table_privilege('authenticated', 'public.solved_spots_gold', 'SELECT')
     OR has_table_privilege('authenticated', 'public.solved_spots_gold', 'INSERT')
     OR has_table_privilege('authenticated', 'public.solved_spots_gold', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.solved_spots_gold', 'DELETE')
     OR has_table_privilege('anon', 'public.solved_spots_gold', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.solved_spots_gold', 'REFERENCES')
     OR has_table_privilege('anon', 'public.solved_spots_gold', 'TRIGGER')
     OR has_table_privilege('anon', 'public.solved_spots_gold', 'MAINTAIN')
     OR has_table_privilege('authenticated', 'public.solved_spots_gold', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.solved_spots_gold', 'REFERENCES')
     OR has_table_privilege('authenticated', 'public.solved_spots_gold', 'TRIGGER')
     OR has_table_privilege('authenticated', 'public.solved_spots_gold', 'MAINTAIN')
     OR has_any_column_privilege('anon', 'public.solved_spots_gold', 'SELECT')
     OR has_any_column_privilege('anon', 'public.solved_spots_gold', 'INSERT')
     OR has_any_column_privilege('anon', 'public.solved_spots_gold', 'UPDATE')
     OR has_any_column_privilege('anon', 'public.solved_spots_gold', 'REFERENCES')
     OR has_any_column_privilege('authenticated', 'public.solved_spots_gold', 'SELECT')
     OR has_any_column_privilege('authenticated', 'public.solved_spots_gold', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.solved_spots_gold', 'UPDATE')
     OR has_any_column_privilege('authenticated', 'public.solved_spots_gold', 'REFERENCES')
     OR NOT has_table_privilege('service_role', 'public.solved_spots_gold', 'SELECT')
     OR has_table_privilege('service_role', 'public.solved_spots_gold', 'INSERT')
     OR has_table_privilege('service_role', 'public.solved_spots_gold', 'UPDATE')
     OR has_table_privilege('service_role', 'public.solved_spots_gold', 'DELETE')
     OR has_table_privilege('service_role', 'public.solved_spots_gold', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.solved_spots_gold', 'REFERENCES')
     OR has_table_privilege('service_role', 'public.solved_spots_gold', 'TRIGGER')
     OR has_table_privilege('service_role', 'public.solved_spots_gold', 'MAINTAIN')
     OR has_any_column_privilege('service_role', 'public.solved_spots_gold', 'INSERT')
     OR has_any_column_privilege('service_role', 'public.solved_spots_gold', 'UPDATE')
     OR has_any_column_privilege('service_role', 'public.solved_spots_gold', 'REFERENCES')
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgrelid = 'public.solved_spots_gold'::regclass
         AND tgname = 'training_solver_artifact_catalog_sync_v1'
         AND NOT tgisinternal
         AND tgenabled <> 'D'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgrelid = 'public.solved_spots_gold'::regclass
         AND tgname = 'solved_spots_gold_require_provenance'
         AND NOT tgisinternal
         AND tgenabled <> 'D'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_constraint constraint_row
       WHERE constraint_row.conrelid = 'public.training_solver_artifact_catalog'::regclass
         AND constraint_row.contype = 'p'
         AND constraint_row.conkey = ARRAY[
           (SELECT attnum FROM pg_attribute
            WHERE attrelid = 'public.training_solver_artifact_catalog'::regclass
              AND attname = 'artifact_id')
         ]::smallint[]
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_constraint constraint_row
       WHERE constraint_row.conrelid = 'public.training_solver_artifact_catalog'::regclass
         AND constraint_row.contype = 'u'
         AND constraint_row.conkey = ARRAY[
           (SELECT attnum FROM pg_attribute
            WHERE attrelid = 'public.training_solver_artifact_catalog'::regclass
              AND attname = 'scenario_hash')
         ]::smallint[]
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_constraint constraint_row
       WHERE constraint_row.conrelid = 'public.training_solver_artifact_catalog'::regclass
         AND constraint_row.contype = 'f'
         AND constraint_row.confrelid = 'public.solved_spots_gold'::regclass
         AND constraint_row.confdeltype = 'c'
         AND constraint_row.conkey = ARRAY[
           (SELECT attnum FROM pg_attribute
            WHERE attrelid = 'public.training_solver_artifact_catalog'::regclass
              AND attname = 'artifact_id')
         ]::smallint[]
         AND constraint_row.confkey = ARRAY[
           (SELECT attnum FROM pg_attribute
            WHERE attrelid = 'public.solved_spots_gold'::regclass
              AND attname = 'id')
         ]::smallint[]
     )
     OR has_table_privilege('anon', 'public.training_solver_artifact_catalog', 'SELECT')
     OR has_table_privilege('anon', 'public.training_solver_artifact_catalog', 'INSERT')
     OR has_table_privilege('anon', 'public.training_solver_artifact_catalog', 'UPDATE')
     OR has_table_privilege('anon', 'public.training_solver_artifact_catalog', 'DELETE')
     OR has_table_privilege('authenticated', 'public.training_solver_artifact_catalog', 'SELECT')
     OR has_table_privilege('authenticated', 'public.training_solver_artifact_catalog', 'INSERT')
     OR has_table_privilege('authenticated', 'public.training_solver_artifact_catalog', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.training_solver_artifact_catalog', 'DELETE')
     OR has_table_privilege('anon', 'public.training_solver_artifact_catalog', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.training_solver_artifact_catalog', 'REFERENCES')
     OR has_table_privilege('anon', 'public.training_solver_artifact_catalog', 'TRIGGER')
     OR has_table_privilege('anon', 'public.training_solver_artifact_catalog', 'MAINTAIN')
     OR has_table_privilege('authenticated', 'public.training_solver_artifact_catalog', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.training_solver_artifact_catalog', 'REFERENCES')
     OR has_table_privilege('authenticated', 'public.training_solver_artifact_catalog', 'TRIGGER')
     OR has_table_privilege('authenticated', 'public.training_solver_artifact_catalog', 'MAINTAIN')
     OR has_any_column_privilege('anon', 'public.training_solver_artifact_catalog', 'SELECT')
     OR has_any_column_privilege('anon', 'public.training_solver_artifact_catalog', 'INSERT')
     OR has_any_column_privilege('anon', 'public.training_solver_artifact_catalog', 'UPDATE')
     OR has_any_column_privilege('anon', 'public.training_solver_artifact_catalog', 'REFERENCES')
     OR has_any_column_privilege('authenticated', 'public.training_solver_artifact_catalog', 'SELECT')
     OR has_any_column_privilege('authenticated', 'public.training_solver_artifact_catalog', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.training_solver_artifact_catalog', 'UPDATE')
     OR has_any_column_privilege('authenticated', 'public.training_solver_artifact_catalog', 'REFERENCES')
     OR NOT has_table_privilege('service_role', 'public.training_solver_artifact_catalog', 'SELECT')
     OR has_table_privilege('service_role', 'public.training_solver_artifact_catalog', 'INSERT')
     OR has_table_privilege('service_role', 'public.training_solver_artifact_catalog', 'UPDATE')
     OR has_table_privilege('service_role', 'public.training_solver_artifact_catalog', 'DELETE')
     OR has_table_privilege('service_role', 'public.training_solver_artifact_catalog', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.training_solver_artifact_catalog', 'REFERENCES')
     OR has_table_privilege('service_role', 'public.training_solver_artifact_catalog', 'TRIGGER')
     OR has_table_privilege('service_role', 'public.training_solver_artifact_catalog', 'MAINTAIN')
     OR has_any_column_privilege('service_role', 'public.training_solver_artifact_catalog', 'INSERT')
     OR has_any_column_privilege('service_role', 'public.training_solver_artifact_catalog', 'UPDATE')
     OR has_any_column_privilege('service_role', 'public.training_solver_artifact_catalog', 'REFERENCES')
     OR has_function_privilege(
       'service_role', 'public.fn_training_canonical_jsonb_text_v1(jsonb)', 'EXECUTE'
     )
     OR has_function_privilege(
       'service_role', 'public.sp_require_solver_write_provenance()', 'EXECUTE'
     )
     OR has_function_privilege(
       'service_role', 'public.fn_training_solver_artifact_catalog_sync_v1()', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.fn_training_canonical_jsonb_text_v1(jsonb)', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.sp_require_solver_write_provenance()', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.fn_training_solver_artifact_catalog_sync_v1()', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'public.fn_training_canonical_jsonb_text_v1(jsonb)', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'public.sp_require_solver_write_provenance()', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'public.fn_training_solver_artifact_catalog_sync_v1()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'TRAINING_SOLVER_ARTIFACT_CATALOG_CONTRACT_INCOMPLETE';
  END IF;
END;
$$;

COMMIT;
