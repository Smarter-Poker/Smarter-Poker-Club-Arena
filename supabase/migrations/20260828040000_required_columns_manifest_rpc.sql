-- ═══════════════════════════════════════════════════════════════════════════
--  A WRITE CAN ALSO FAIL BY LEAVING A REQUIRED COLUMN OUT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Applied to production 2026-08-28 via the Supabase MCP (apply_migration
-- "fn_required_columns_manifest_for_the_write_gate"). This file is the record.
--
-- check-phantom-columns catches a write that NAMES a column which does not
-- exist. It cannot catch a write that OMITS one that must be there. Postgres
-- refuses the statement just as completely, the error lands in a catch, and the
-- control silently does nothing - the same failure from the opposite direction,
-- invisible to every gate in this repo until now. Four instances, all found by
-- hand in one day:
--
--   audit_trail.actor_role, .target_type   the agent audit trail wrote nothing
--   referrals.referral_code_used           bonuses paid, referral never recorded
--   club_announcements.author_id           creating an announcement never worked
--   credit_requests.club_id                every credit increase request threw
--
-- The first two are why this is not a nice-to-have. They were ALSO
-- phantom-column bugs, and repointing the wrong names - the obvious fix, the one
-- that passes review - would have left both inserts failing exactly as before.
--
-- This function is the source of truth for scripts/ci/check-required-columns.mjs.
-- It is shaped like fn_schema_manifest and fn_columns_manifest so
-- gen-schema-manifest.mjs emits it alongside them and the daily Schema Manifest
-- Refresh keeps it from rotting - the drift that produced this repo's other
-- manifest incidents.
--
-- REQUIRED means: NOT NULL, no DEFAULT, not identity, not generated. A column
-- with a default, or one a trigger fills, is not the caller's problem, and
-- including it would produce noise that teaches people to ignore the gate.

CREATE OR REPLACE FUNCTION public.fn_required_columns_manifest()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'information_schema', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_object_agg(t.table_name, t.required), '{}'::jsonb)
  FROM (
    SELECT c.table_name,
           jsonb_agg(c.column_name::text ORDER BY c.ordinal_position) AS required
      FROM information_schema.columns c
      JOIN information_schema.tables tt
        ON tt.table_schema = c.table_schema
       AND tt.table_name = c.table_name
       AND tt.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public'
       AND c.is_nullable = 'NO'
       AND c.column_default IS NULL
       AND c.is_identity = 'NO'
       AND c.is_generated = 'NEVER'
     GROUP BY c.table_name
  ) t;
$function$;

REVOKE ALL ON FUNCTION public.fn_required_columns_manifest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_required_columns_manifest() TO service_role;

COMMENT ON FUNCTION public.fn_required_columns_manifest() IS
  'Every public base table mapped to the columns an INSERT must supply: NOT NULL, no default, not identity, not generated. Read by scripts/ci/gen-schema-manifest.mjs for the required-column write gate. service_role only.';
