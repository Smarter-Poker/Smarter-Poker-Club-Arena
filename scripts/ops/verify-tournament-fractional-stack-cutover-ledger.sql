\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'

-- Read-only ledger evidence for the one-shot renderer. apply_migration stores
-- the submitted SQL as one statement element; its exact bytes must match the
-- reviewed artifact, not merely produce equivalent live objects. The global
-- name count closes an ambiguous-response retry: two versions with this name
-- are never an acceptable one-shot history, even if one version has the right
-- bytes.
WITH named AS (
  SELECT version, name, statements
    FROM supabase_migrations.schema_migrations
   WHERE name = 'tournament_fractional_stacks_are_normalized_once'
)
SELECT
  version,
  name,
  cardinality(statements),
  encode(extensions.digest(statements[1], 'sha256'), 'hex'),
  (SELECT count(*) FROM named)
FROM named
WHERE version = :'migration_version';
