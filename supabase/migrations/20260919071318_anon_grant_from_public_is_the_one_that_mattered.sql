-- 20260919071318_anon_grant_from_public_is_the_one_that_mattered
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-19 07:13:18 UTC.
-- APPLIED to production 2026-09-19 07:14 UTC through the Supabase MCP, which
-- stamps its own version; schema_migrations carries this under the same name.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE GRANT THAT MATTERED CAME FROM PUBLIC
--
-- PR #4872 "anon executes only what it needs" merged to main on 2026-09-18 as
-- supabase/migrations/20260918121836_anon_executes_only_what_it_needs.sql and
-- was never applied - no row for it in supabase_migrations.schema_migrations
-- and all thirteen grants still live a day later. Applying it on 2026-09-19
-- failed on its OWN assertion, which is both the reason it exists and the
-- reason nobody noticed:
--
--     ERROR: anon still executes 9 of the thirteen
--
-- It revokes EXECUTE FROM anon. Nine of the thirteen do not hold their grant
-- through anon at all - they hold it through PUBLIC, the default a function is
-- created with. Read from pg_proc.proacl, 2026-09-19 07:12 UTC:
--
--     is_admin()                           =X/postgres | postgres=X | anon=X | authenticated=X | service_role=X
--     trgfn_award_daily_trivia()           =X/postgres | postgres=X | anon=X | authenticated=X | service_role=X
--     trgfn_award_first_training_session()    (same)
--     trgfn_award_follow()                    (same)
--     trgfn_award_reaction_interaction()      (same)
--     trgfn_award_reaction_like()             (same)
--     trgfn_award_share_content()             (same)
--     trgfn_award_social_post()               (same)
--     trgfn_award_strategy_comment()          (same)
--
-- The leading `=X/postgres` is EXECUTE granted to PUBLIC. has_function_privilege
-- ('anon', ...) answers true through it whatever anon's own entry says, so
-- REVOKE ... FROM anon moved nothing for those nine. The other four -
-- fn_club_chat_is_silenced, fn_my_club_ids,
-- fn_notification_has_personal_destination and fn_table_chat_is_silenced -
-- carry no PUBLIC entry, and #4872 would have revoked those correctly.
--
-- So docs/security/anon-executable-definers.json has been describing a state
-- the database could not reach - 22 allowed against 35 live - and
-- scripts/ci/check-anon-definer-grants.mjs has been naming exactly those
-- thirteen. It was right every time; it was simply switched off, in a
-- workflow (Production Integrity Audit) that had been disabled since
-- 2026-09-14.
--
-- WHAT THIS CHANGES. PUBLIC as well as anon, on all thirteen. Revoking a grant
-- that is not there is a no-op, so the four without a PUBLIC entry are
-- unaffected by the wider revoke and the nine are finally reached. Nothing
-- else loses anything: every one of the thirteen carries an EXPLICIT
-- authenticated=X, service_role=X and postgres=X entry, so all three keep
-- EXECUTE after PUBLIC goes - asserted below rather than assumed, alongside
-- the count of the whole anonymous definer surface.
--
-- #4872's own finding stands and is why this is safe for the eight triggers:
-- Postgres checks EXECUTE when a trigger is CREATED, not when it fires, which
-- #4872 settled by experiment rather than from memory. The grants are inert and
-- removing them changes no behaviour. The five helpers are named only by
-- policies anon never evaluates, by no SECURITY INVOKER function anon may call
-- and by no security_invoker view anon may read.
--
-- The six that genuinely need the grant stay untouched, for #4872's reason: an
-- RLS policy expression is evaluated as the QUERYING role. fn_can_view_post,
-- fn_is_public_video_playback_eligible, fn_is_video_library_asset_eligible,
-- fn_is_video_library_lineage_eligible, both legacy_transition_eligible
-- overloads and fn_home_is_group_staff are named by policies and by a
-- security_invoker view that anon reaches; revoking those would break
-- anonymous reads of public content.
--
-- MEASURED AFTER: 22 anon-executable SECURITY DEFINER functions in public,
-- exactly the repository's allowlist; 0 of the thirteen still anon-executable;
-- 13 of 13 still authenticated-executable; and 0 anon-executable definers with
-- a mutable search_path, so the exploitable combination stays empty.
-- ═══════════════════════════════════════════════════════════════════════════

-- ONE TRANSACTION, not thirteen: every DDL statement fires Supabase's
-- schema-cache reload, ~28s on this database (club-arena production DDL policy,
-- and #4872's reason for the same shape).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Trigger functions: reachable only by the trigger mechanism, which does not
-- check this privilege.
REVOKE EXECUTE ON FUNCTION public.trgfn_award_daily_trivia()            FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trgfn_award_first_training_session()  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trgfn_award_follow()                  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trgfn_award_reaction_interaction()    FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trgfn_award_reaction_like()           FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trgfn_award_share_content()           FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trgfn_award_social_post()             FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trgfn_award_strategy_comment()        FROM PUBLIC, anon;

-- Policy helpers no anon-reaching policy, invoker function or invoker view
-- names. `authenticated` keeps every one of these.
REVOKE EXECUTE ON FUNCTION public.is_admin()                                              FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_my_club_ids()                                        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_notification_has_personal_destination(uuid, uuid)    FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_club_chat_is_silenced(uuid)                          FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_table_chat_is_silenced(uuid)                         FROM PUBLIC, anon;

DO $prove_it$
DECLARE
  thirteen constant text[] := ARRAY[
    'trgfn_award_daily_trivia','trgfn_award_first_training_session',
    'trgfn_award_follow','trgfn_award_reaction_interaction',
    'trgfn_award_reaction_like','trgfn_award_share_content',
    'trgfn_award_social_post','trgfn_award_strategy_comment',
    'is_admin','fn_my_club_ids','fn_notification_has_personal_destination',
    'fn_club_chat_is_silenced','fn_table_chat_is_silenced'];
  v_named int;
  v_anon int;
  v_auth_lost int;
  v_service_lost int;
  v_anon_total int;
BEGIN
  SELECT count(*) INTO v_named
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = ANY(thirteen);
  IF v_named <> 13 THEN
    RAISE EXCEPTION 'expected the thirteen named functions in public, found %', v_named;
  END IF;

  SELECT count(*) INTO v_anon
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = ANY(thirteen)
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_anon <> 0 THEN
    RAISE EXCEPTION 'anon still executes % of the thirteen - look for another route than anon or PUBLIC', v_anon;
  END IF;

  SELECT count(*) INTO v_auth_lost
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = ANY(thirteen)
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_lost <> 0 THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on % of the thirteen; revoking PUBLIC must not reach it', v_auth_lost;
  END IF;

  SELECT count(*) INTO v_service_lost
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = ANY(thirteen)
     AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_service_lost <> 0 THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on % of the thirteen; revoking PUBLIC must not reach it', v_service_lost;
  END IF;

  -- The whole anonymous definer surface, which
  -- docs/security/anon-executable-definers.json says is 22 once these are gone.
  SELECT count(*) INTO v_anon_total
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  RAISE NOTICE 'anon-executable SECURITY DEFINER functions in public: % (the repository allows 22)', v_anon_total;
END
$prove_it$;

COMMIT;
