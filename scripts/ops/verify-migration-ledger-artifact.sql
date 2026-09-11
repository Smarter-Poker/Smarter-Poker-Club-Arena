\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'

WITH named AS (
  SELECT version, name, statements
    FROM supabase_migrations.schema_migrations
   WHERE name = :'migration_name'
)
SELECT
  version,
  name,
  cardinality(statements),
  encode(extensions.digest(statements[1], 'sha256'), 'hex'),
  (SELECT count(*) FROM named)
FROM named
WHERE version = :'migration_version';
