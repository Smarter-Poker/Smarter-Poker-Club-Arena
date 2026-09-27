-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424023730 "20260421189000_hg_harden_15_rpcs_service_role_null_bypass"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8f9b15e46b13d3cbd69ff9ef9a264afd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Deeper hunt: 15 HG RPCs use `v_role <> 'service_role'` or
-- `auth.role() <> 'service_role'`. If auth.role() ever returns NULL
-- (e.g., direct SQL w/o jwt claims injected), the comparison yields
-- NULL and the auth block is skipped. Real app traffic always has
-- claims injected by PostgREST, so this was unreachable in normal
-- flow, but we want defense-in-depth fail-closed semantics.
--
-- Fix: replace `<> 'service_role'` with `IS DISTINCT FROM 'service_role'`.
-- NULL IS DISTINCT FROM 'x' → true → block entered → auth checks apply.
DO $patch$
DECLARE r record; new_src text; new_def text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
      AND p.proname IN (
        'broadcast_to_home_game_rsvps','broadcast_to_home_group_roster',
        'fn_home_assign_seat','fn_home_init_seats','fn_home_move_seat',
        'fn_home_randomize_seats','fn_home_set_seat_status','fn_home_vacate_seat',
        'get_home_group_feed','get_home_group_member_engagement',
        'get_home_group_roster','get_recommended_home_groups',
        'revive_home_group','start_home_game_player_dm','start_home_group_roster_dm'
      )
  LOOP
    new_def := r.def;
    -- Replace both `v_role <> 'service_role'` and `auth.role() <> 'service_role'`
    new_def := regexp_replace(
      new_def,
      '(v_role|auth\.role\(\))\s*<>\s*''service_role''',
      '\1 IS DISTINCT FROM ''service_role''',
      'g');

    IF new_def IS DISTINCT FROM r.def THEN
      EXECUTE new_def;
      RAISE NOTICE 'Patched %', r.proname;
    END IF;
  END LOOP;
END $patch$;
