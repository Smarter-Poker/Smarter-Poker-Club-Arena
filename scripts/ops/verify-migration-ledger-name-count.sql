\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

SELECT count(*)
  FROM supabase_migrations.schema_migrations
 WHERE name = :'migration_name';
