-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424004325 "20260421110200_xp_reintroduction_guard_v2_column_aware"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 51de708c278977f5eceabe38d7acebdf of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- v2: pg_event_trigger_ddl_commands() returns the TABLE identity for
-- ALTER TABLE ADD COLUMN, not the column name. The v1 guard checked
-- the table identity against /xp/ which only matched table *names*
-- containing xp — not columns. Actual result: ALTER TABLE profiles
-- ADD COLUMN xp slipped through.
--
-- v2 fix: for every CREATE/ALTER TABLE event, iterate the target
-- table's columns and reject if any match the XP pattern.

CREATE OR REPLACE FUNCTION public.xp_ban_guard_fn()
 RETURNS event_trigger
 LANGUAGE plpgsql
AS $fn$
DECLARE
  r      record;
  v_schema text;
  v_table  text;
  v_col    text;
  v_pat    text := '(^xp$|_xp$|^xp_|_xp_|^reputation_xp$|^total_xp$|^xp_total$|^xp_earned$|^xp_reward$|^bonus_xp_|^social_xp$)';
BEGIN
  FOR r IN
    SELECT object_type, object_identity, schema_name
      FROM pg_event_trigger_ddl_commands()
     WHERE schema_name = 'public'
  LOOP
    -- Block any table whose name itself is an XP concept (e.g. xp_logs)
    IF r.object_type = 'table'
       AND split_part(r.object_identity, '.', 2) ~* v_pat THEN
      RAISE EXCEPTION 'XP_BAN: table "%" violates zero-XP policy (CEO directive).', r.object_identity
        USING HINT = 'DROP EVENT TRIGGER xp_ban_guard if policy changed.';
    END IF;

    -- For any CREATE/ALTER TABLE event, scan the target table's columns
    -- and reject if any is XP-shaped.
    IF r.object_type = 'table' THEN
      v_schema := split_part(r.object_identity, '.', 1);
      v_table  := split_part(r.object_identity, '.', 2);
      FOR v_col IN
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = v_schema AND table_name = v_table
      LOOP
        IF v_col ~* v_pat THEN
          RAISE EXCEPTION 'XP_BAN: column "%.%" violates zero-XP policy (CEO directive).',
                          r.object_identity, v_col
            USING HINT = 'DROP EVENT TRIGGER xp_ban_guard if policy changed.';
        END IF;
      END LOOP;
    END IF;

    -- Block function signatures that smell like XP work
    IF r.object_type = 'function'
       AND split_part(r.object_identity, '(', 1) ~* '\m(award_xp|add_xp|gain_xp|xp_award|xp_grant|grant_xp)\M' THEN
      RAISE EXCEPTION 'XP_BAN: function "%" violates zero-XP policy.', r.object_identity
        USING HINT = 'DROP EVENT TRIGGER xp_ban_guard if policy changed.';
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
  'ZERO XP POLICY (v2, column-aware): blocks CREATE/ALTER that would introduce any XP column/table/function.';
