-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260911230657 "an_arena_table_is_governed_by_the_diamond_boundary_not_a_cluster"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 22c5a382a9e9cf5d4191ce29d67d1e22 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

ALTER TABLE public.tables DROP CONSTRAINT IF EXISTS tables_cash_needs_a_game;

ALTER TABLE public.tables ADD CONSTRAINT tables_cash_needs_a_game CHECK (
  tournament_id IS NOT NULL
  OR cluster_id IS NOT NULL
  OR status = ANY (ARRAY['closed'::text, 'deleted'::text])
  OR COALESCE(is_deleted, false)
  OR club_id IS NULL
  OR game_variant IS NULL
  OR COALESCE(small_blind, 0::numeric) <= 0::numeric
  OR COALESCE(big_blind, 0::numeric) <= COALESCE(small_blind, 0::numeric)
  -- The platform Diamond arena. Governed by the Diamond boundary, run on
  -- demand by ensureCashTableEngine, and never by the cluster controller.
  OR club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid
) NOT VALID;

ALTER TABLE public.tables VALIDATE CONSTRAINT tables_cash_needs_a_game;

COMMENT ON CONSTRAINT tables_cash_needs_a_game ON public.tables IS
  'Gate 7: an open cash table must be owned by a tournament or a cluster, so '
  'the cluster rules cannot stop at it. The platform Diamond arena is exempt '
  'because the Diamond boundary refuses every one of those rules outright and '
  'replaces them with a stricter check applied at load, at every settings '
  'refresh, at admission and at settlement; its tables are a fixed staff ladder '
  'woken on demand by ensureCashTableEngine.';
