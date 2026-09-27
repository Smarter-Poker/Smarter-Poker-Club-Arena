-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424004157 "20260421110100_xp_reintroduction_guard_event_trigger"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5049d87bc72a7d0d07a5b585cdfde449 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- XP REINTRODUCTION GUARD — permanent defense against xp being
-- re-added via DDL. Can be lifted with DROP EVENT TRIGGER xp_ban_guard.

CREATE OR REPLACE FUNCTION public.xp_ban_guard_fn()
 RETURNS event_trigger
 LANGUAGE plpgsql
AS $fn$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT object_type, object_identity, schema_name
    FROM pg_event_trigger_ddl_commands()
   WHERE schema_name = 'public' OR schema_name IS NULL
  LOOP
    IF r.object_type IN ('table column','table') THEN
      IF r.object_identity ~* '\m(xp|xp_total|xp_earned|xp_reward|xp_logs|reputation_xp|total_xp|bonus_xp|social_xp)\M' THEN
        RAISE EXCEPTION 'XP_BAN: object "%" violates the zero-XP policy. Per CEO directive, XP is permanently removed.', r.object_identity
          USING HINT = 'If policy has changed, DROP EVENT TRIGGER xp_ban_guard first.';
      END IF;
    END IF;
    IF r.object_type = 'function' THEN
      IF r.object_identity ~* '\m(award_xp|add_xp|gain_xp|social_xp|xp_award|xp_grant|grant_xp)\M'
         AND r.object_identity !~ 'REMOVED' THEN  -- allow our stub renames if tagged
        RAISE EXCEPTION 'XP_BAN: function "%" violates the zero-XP policy.', r.object_identity
          USING HINT = 'If policy has changed, DROP EVENT TRIGGER xp_ban_guard first.';
      END IF;
    END IF;
  END LOOP;
END;
$fn$;

DROP EVENT TRIGGER IF EXISTS xp_ban_guard;

CREATE EVENT TRIGGER xp_ban_guard
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE','ALTER TABLE','CREATE FUNCTION')
  EXECUTE FUNCTION public.xp_ban_guard_fn();

COMMENT ON EVENT TRIGGER xp_ban_guard IS
  'ZERO XP POLICY: blocks re-introduction of any XP-named column/table/function. Per CEO directive.';
