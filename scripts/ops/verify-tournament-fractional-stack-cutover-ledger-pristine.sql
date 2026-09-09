\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- The one-shot name must not exist before apply_migration. A timeout is
-- resolved by rereading this count; it is never answered by blind replay.
SELECT count(*)
  FROM supabase_migrations.schema_migrations
 WHERE name = 'tournament_fractional_stacks_are_normalized_once';
