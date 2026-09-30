-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424004425 "20260421110300_xp_guard_v3_drop_test_artifact_and_tighten_regex"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f0db070892eb8afa77dcdda93ca164f6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- v3: drop test artifact + tighten function-name regex (drop \m \M
-- word-boundaries so embedded XP patterns like "fake_award_xp_handler"
-- are caught).

DROP FUNCTION IF EXISTS public.fake_award_xp_handler(uuid);

CREATE OR REPLACE FUNCTION public.xp_ban_guard_fn()
 RETURNS event_trigger
 LANGUAGE plpgsql
AS $fn$
DECLARE
  r      record;
  v_schema text;
  v_table  text;
  v_col    text;
  v_col_pat  text := '(^xp$|_xp$|^xp_|_xp_|^reputation_xp$|^total_xp$|^xp_total$|^xp_earned$|^xp_reward$|^bonus_xp_|^social_xp$)';
  v_fn_pat   text := '(award_xp|add_xp|gain_xp|xp_award|xp_grant|grant_xp|social_xp|reputation_xp|xp_total|xp_log)';
BEGIN
  FOR r IN
    SELECT object_type, object_identity, schema_name
      FROM pg_event_trigger_ddl_commands()
     WHERE schema_name = 'public'
  LOOP
    -- Block tables whose NAME itself is XP-shaped
    IF r.object_type = 'table'
       AND split_part(r.object_identity, '.', 2) ~* v_col_pat THEN
      RAISE EXCEPTION 'XP_BAN: table "%" violates zero-XP policy.', r.object_identity
        USING HINT = 'DROP EVENT TRIGGER xp_ban_guard if policy changed.';
    END IF;

    -- For any CREATE/ALTER TABLE, scan columns for XP names
    IF r.object_type = 'table' THEN
      v_schema := split_part(r.object_identity, '.', 1);
      v_table  := split_part(r.object_identity, '.', 2);
      FOR v_col IN
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = v_schema AND table_name = v_table
      LOOP
        IF v_col ~* v_col_pat THEN
          RAISE EXCEPTION 'XP_BAN: column "%.%" violates zero-XP policy.',
                          r.object_identity, v_col
            USING HINT = 'DROP EVENT TRIGGER xp_ban_guard if policy changed.';
        END IF;
      END LOOP;
    END IF;

    -- Block function signatures containing XP-shaped substrings
    -- (regex is substring-match now, not word-bounded — catches
    --  disguise patterns like "fake_award_xp_handler")
    IF r.object_type = 'function'
       AND split_part(r.object_identity, '(', 1) ~* v_fn_pat THEN
      RAISE EXCEPTION 'XP_BAN: function "%" violates zero-XP policy.', r.object_identity
        USING HINT = 'DROP EVENT TRIGGER xp_ban_guard if policy changed.';
    END IF;
  END LOOP;
END;
$fn$;

-- Event trigger already points at the function; no need to recreate.
COMMENT ON EVENT TRIGGER xp_ban_guard IS
  'ZERO XP POLICY v3 (substring-matching): blocks any CREATE/ALTER introducing XP-named column/table/function.';
