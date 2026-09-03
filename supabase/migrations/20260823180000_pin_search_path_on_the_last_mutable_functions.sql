-- 20260823180000_pin_search_path_on_the_last_mutable_functions.sql
--
-- Supabase's security advisor reports 12 functions with a mutable search_path.
-- One of them, fn_cron_field, is mine - added in 20260823060000 without a
-- SET search_path, which is the same omission I have been correcting in other
-- people's code all session.
--
-- All 12 are SECURITY INVOKER, so none of them is the classic definer-rights
-- escalation. The risk is narrower but real: a function with an unpinned
-- search_path resolves unqualified names against whatever the CALLER has set,
-- so a caller can change which object the body actually touches.
--
-- Pinned to 'public, extensions' rather than bare 'public' on purpose - that is
-- the pattern already used elsewhere in this database (the four-argument
-- log_audit_event has exactly that), and it keeps extension operators such as
-- pg_trgm resolvable. Pinning to bare 'public' would be the way to break
-- something.
--
-- ALTER FUNCTION ... SET search_path changes no function body, no signature and
-- no grant. It only fixes how unqualified names resolve inside them.

ALTER FUNCTION public.ca_assert_self(uuid)                     SET search_path = 'public', 'extensions';
ALTER FUNCTION public.fn_arena_avatar_pick(uuid, boolean)      SET search_path = 'public', 'extensions';
ALTER FUNCTION public.fn_clear_sitout_on_turnover()            SET search_path = 'public', 'extensions';
ALTER FUNCTION public.fn_club_role_rank(text)                  SET search_path = 'public', 'extensions';
ALTER FUNCTION public.fn_club_scoped_chips_enabled()           SET search_path = 'public', 'extensions';
ALTER FUNCTION public.fn_cron_field(text, integer)             SET search_path = 'public', 'extensions';
ALTER FUNCTION public.fn_enforce_whole_dollar_buyin()          SET search_path = 'public', 'extensions';
ALTER FUNCTION public.fn_role_rank(text)                       SET search_path = 'public', 'extensions';
ALTER FUNCTION public.fn_union_oversight_tables()              SET search_path = 'public', 'extensions';
ALTER FUNCTION public.fn_union_week_start(timestamptz)         SET search_path = 'public', 'extensions';
ALTER FUNCTION public.sp_pending_boards(text, integer, text, text[], boolean, integer)
                                                               SET search_path = 'public', 'extensions';
ALTER FUNCTION public.log_audit_event(integer, uuid, uuid, text, text, text, text, text, jsonb, jsonb)
                                                               SET search_path = 'public', 'extensions';

DO $assert$
DECLARE
  v_unpinned text;
BEGIN
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    INTO v_unpinned
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('ca_assert_self','fn_arena_avatar_pick','fn_clear_sitout_on_turnover',
                       'fn_club_role_rank','fn_club_scoped_chips_enabled','fn_cron_field',
                       'fn_enforce_whole_dollar_buyin','fn_role_rank','fn_union_oversight_tables',
                       'fn_union_week_start','sp_pending_boards','log_audit_event')
     AND p.proconfig IS NULL;

  IF v_unpinned IS NOT NULL THEN
    RAISE EXCEPTION 'still unpinned: %', v_unpinned;
  END IF;
END $assert$;

DO $smoke$
BEGIN
  IF public.fn_cron_field('*/10', 59) <> ARRAY[0,10,20,30,40,50] THEN
    RAISE EXCEPTION 'fn_cron_field broke after pinning search_path';
  END IF;
  IF public.fn_role_rank('owner') IS NULL THEN
    RAISE EXCEPTION 'fn_role_rank returned NULL for a known role after pinning search_path';
  END IF;
END $smoke$;

-- ROLLBACK
--   ALTER FUNCTION <each function above> RESET search_path;
