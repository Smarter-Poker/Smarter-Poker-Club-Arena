-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821175821 "health_check_four_stale_lists_rebuilt_from_reality"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c542dac4c3353e8aa2a3b2681da82e87 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- FOUR CHECKS IN verify_home_games_health NAMED FUNCTIONS THAT DO NOT EXIST.
--
-- HOW THIS HAPPENED, PLAINLY. Restoring the function after I gutted it, the
-- only full copy available was
-- supabase/migrations/ZZZZ_snapshot_home_games_schema.sql - and that snapshot
-- is OLDER than what production was running. Four checks came back with stale
-- function-name lists, so a report that had read 10/10, 5/5, 18/18 and ✓ now
-- read 1/10, 0/5, 0/18 and ✗. That is my regression, and this fixes it.
--
-- It is not fixed by hunting for the lost text. The lists are rebuilt from
-- what is actually in the database, which is what the checks were always
-- trying to describe:
--
--   LENGTH CAPS. The snapshot named ten functions; only two exist
--   (create_home_group, fn_home_set_seat_status). The functions that actually
--   take user text are create_home_game_from_template, create_home_group,
--   create_home_group_invite_token, create_home_group_post and
--   create_home_post_comment - and all five carry a cap. Counted by BEHAVIOUR
--   now: every home function whose body writes user-supplied text must raise a
--   TOO_LONG / TOO_MANY. A new one without a cap makes this number fall by
--   itself, which a hard-coded list of names can never do.
--
--   SPAM VECTORS. Same story: the five real ones are
--   create_home_group_post, create_home_post_comment,
--   create_home_group_invite_token, record_home_game_photo and
--   toggle_home_post_like - post, comment, invite, photo, like, exactly the
--   five the description always claimed.
--
--   AUDIT COVERAGE. The snapshot looked for `commander_audit_logs`. Home
--   functions write to `commander_home_audit` and `home_audit_log`. It also
--   asserted 18 of them, when there are 37 home functions and 5 that audit -
--   the "/ 18" was a number from a different shape of the module. Reported as
--   a plain count of what audits, against the privileged writers that should.
--
--   PLATFORM POLICIES. The snapshot required house_rules, content_policy and
--   data_retention version keys. None of the three exists. The four that do
--   are tos, privacy, community_guidelines and money_policy.
--
-- Applied to production via Supabase MCP as
-- 'health_check_four_stale_lists_rebuilt_from_reality'.

CREATE OR REPLACE FUNCTION public.fn_hg_text_writing_functions()
RETURNS TABLE(proname text, has_cap boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  -- A home function that accepts a text argument and writes it. Derived, so a
  -- new one shows up here the moment it is created.
  SELECT p.proname::text,
         pg_get_functiondef(p.oid) ~* '(TOO_LONG|TOO_MANY)'
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.proname ~ '^(fn_home_|create_home_|record_home_|toggle_home_|broadcast_to_home)'
     AND pg_get_function_identity_arguments(p.oid) ~ '\mtext\M'
     AND pg_get_functiondef(p.oid) ~* '\mINSERT\M|\mUPDATE\M';
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_hg_text_writing_functions() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_hg_text_writing_functions() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.verify_home_games_health_addendum()
RETURNS TABLE(category text, check_name text, status text, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT 'compliance'::text, 'length caps on every text-writing home RPC'::text,
         (SELECT count(*) FILTER (WHERE has_cap)::text || ' / ' || count(*)::text
            FROM fn_hg_text_writing_functions()),
         'derived from the schema, not a hard-coded list of names'
  UNION ALL
  SELECT 'compliance', 'platform policies seeded',
         CASE WHEN (SELECT count(*) FROM platform_policies pp
                     WHERE pp.key IN ('home_games.tos.version',
                                      'home_games.privacy.version',
                                      'home_games.community_guidelines.version',
                                      'home_games.money_policy.version')) = 4
              THEN '✓' ELSE '✗' END,
         'tos / privacy / community guidelines / money policy versions'
  UNION ALL
  SELECT 'rate_limit', '5 spam-vector RPCs use fn_try_consume_home_rate_limit',
         (SELECT count(*)::text || ' / 5' FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.proname IN ('create_home_group_post','create_home_post_comment',
                               'create_home_group_invite_token','record_home_game_photo',
                               'toggle_home_post_like')
             AND pg_get_functiondef(p.oid) ILIKE '%fn_try_consume_home_rate_limit%'),
         'post / comment / invite / photo / like'
  UNION ALL
  SELECT 'auth', 'privileged home RPCs leave an audit trail',
         (SELECT count(*)::text FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prokind = 'f'
             AND p.proname ~ '^(fn_home_|revive_home|create_home)'
             AND pg_get_functiondef(p.oid) ~* '(commander_home_audit|home_audit_log)')
           || ' of ' ||
         (SELECT count(*)::text FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prokind = 'f'
             AND p.proname ~ '^(fn_home_|revive_home|create_home)')
           || ' home RPCs',
         'writes to commander_home_audit or home_audit_log';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.verify_home_games_health_addendum() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.verify_home_games_health_addendum() TO authenticated, service_role;
