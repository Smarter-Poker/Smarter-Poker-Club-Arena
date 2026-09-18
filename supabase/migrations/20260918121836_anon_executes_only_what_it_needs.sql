-- ANON EXECUTES ONLY WHAT IT NEEDS (2026-09-18)
--
-- 2,571 SECURITY DEFINER functions live in public. 35 of them are executable
-- by `anon` - a logged-out stranger - and 772 by `authenticated`. The search
-- path hygiene is good: 2 of the 2,571 leave it mutable, and none of those is
-- anon-executable, so the exploitable combination is currently empty.
--
-- Thirteen of the 35 grants do nothing, and this removes those. Each was
-- measured rather than assumed, because the first reading of this was wrong in
-- a way that would have broken anonymous reads.
--
-- The eight trgfn_award_* are trigger functions, called by the trigger
-- mechanism and by nothing else - no policy, no view, no default, no other
-- function references them. Six of their eight tables do grant anon INSERT, so
-- "nothing can reach them" was not good enough, and the question of whether
-- firing a trigger checks the triggering role's EXECUTE was settled by
-- experiment rather than from memory: with a throwaway temp table, a temp
-- SECURITY DEFINER trigger function, and EXECUTE explicitly revoked from anon,
-- an INSERT performed as anon still succeeded and the trigger still ran.
-- Postgres checks that privilege when the trigger is created, not when it
-- fires. The grants are inert.
--
-- The five helpers are referenced only by policies that anon never evaluates,
-- by no SECURITY INVOKER function anon may call, and by no security_invoker
-- view anon may read. `authenticated` keeps EXECUTE on all thirteen.
--
-- DELIBERATELY UNTOUCHED, and the reason this migration is thirteen rather
-- than fifteen: an RLS policy expression is evaluated as the QUERYING role, so
-- a helper named by a policy that reaches anon genuinely needs the grant.
-- fn_can_view_post, fn_is_public_video_playback_eligible,
-- fn_is_video_library_asset_eligible, fn_is_video_library_lineage_eligible and
-- both overloads of legacy_transition_eligible are named by policies on
-- social_posts, social_reels and video_library_videos that anon evaluates;
-- revoking those would have broken anonymous reads of public content.
-- fn_home_is_group_staff is used by a security_invoker view that anon can
-- SELECT, which is the same hazard by a different route.

-- ONE TRANSACTION, not thirteen. Every DDL statement fires Supabase's
-- schema-cache reload, ~28s on this database; thirteen loose REVOKEs would
-- mean thirteen reloads (club-arena production DDL policy, and the reason
-- scripts/new-migration.mjs writes BEGIN/COMMIT into its template).
BEGIN;

-- Trigger functions: reachable only by the trigger mechanism, which does not
-- check this privilege.
REVOKE EXECUTE ON FUNCTION public.trgfn_award_daily_trivia()            FROM anon;
REVOKE EXECUTE ON FUNCTION public.trgfn_award_first_training_session()  FROM anon;
REVOKE EXECUTE ON FUNCTION public.trgfn_award_follow()                  FROM anon;
REVOKE EXECUTE ON FUNCTION public.trgfn_award_reaction_interaction()    FROM anon;
REVOKE EXECUTE ON FUNCTION public.trgfn_award_reaction_like()           FROM anon;
REVOKE EXECUTE ON FUNCTION public.trgfn_award_share_content()           FROM anon;
REVOKE EXECUTE ON FUNCTION public.trgfn_award_social_post()             FROM anon;
REVOKE EXECUTE ON FUNCTION public.trgfn_award_strategy_comment()        FROM anon;

-- Policy helpers no anon-reaching policy, invoker function or invoker view
-- names. `authenticated` keeps every one of these.
REVOKE EXECUTE ON FUNCTION public.is_admin()                                              FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_my_club_ids()                                        FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_notification_has_personal_destination(uuid, uuid)    FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_club_chat_is_silenced(uuid)                          FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_table_chat_is_silenced(uuid)                         FROM anon;

DO $$
DECLARE
  still_granted int;
  authenticated_lost int;
BEGIN
  SELECT count(*) INTO still_granted
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('trgfn_award_daily_trivia','trgfn_award_first_training_session',
                      'trgfn_award_follow','trgfn_award_reaction_interaction',
                      'trgfn_award_reaction_like','trgfn_award_share_content',
                      'trgfn_award_social_post','trgfn_award_strategy_comment',
                      'is_admin','fn_my_club_ids','fn_notification_has_personal_destination',
                      'fn_club_chat_is_silenced','fn_table_chat_is_silenced')
    AND has_function_privilege('anon', p.oid, 'EXECUTE');

  SELECT count(*) INTO authenticated_lost
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('trgfn_award_daily_trivia','trgfn_award_first_training_session',
                      'trgfn_award_follow','trgfn_award_reaction_interaction',
                      'trgfn_award_reaction_like','trgfn_award_share_content',
                      'trgfn_award_social_post','trgfn_award_strategy_comment',
                      'is_admin','fn_my_club_ids','fn_notification_has_personal_destination',
                      'fn_club_chat_is_silenced','fn_table_chat_is_silenced')
    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF still_granted <> 0 THEN
    RAISE EXCEPTION 'anon still executes % of the thirteen', still_granted;
  END IF;
  IF authenticated_lost <> 0 THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on % of the thirteen; this migration must not touch that role', authenticated_lost;
  END IF;
END $$;

COMMIT;
