-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820192139 "search_messages_caller_must_be_the_participant"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5ca213dc08d4d0e452639af2cfd44bc8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ANY LOGGED-IN USER COULD SEARCH ANY CONVERSATION.
--
-- fn_search_messages checks that p_user_id is a participant of the
-- conversation — but p_user_id is supplied by the caller, so the check only
-- proves that the person you NAMED is a participant, not that you are them.
-- Pass a real participant's id and you read their private conversation.
--
-- The World Hub endpoint (pages/api/messenger/search-messages.js) does verify
-- the JWT properly, but the RPC is granted to `authenticated`, so PostgREST
-- exposes it directly and the endpoint's check can simply be bypassed.
--
-- Fix: when there is a caller identity, it must be the identity being asked
-- about. A NULL auth.uid() is the service-role/API path and is unaffected.

DO $mig$
DECLARE
  v_def text;
  v_pos int;
  v_guard text;
  v_marker text := 'AS $function$';
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE proname = 'fn_search_messages' AND pronamespace = 'public'::regnamespace;

  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_search_messages not found'; END IF;
  IF v_def LIKE '%not_authorised%' THEN
    RAISE NOTICE 'already guarded'; RETURN;
  END IF;

  v_guard :=
    '  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid() THEN'
    || ' RAISE EXCEPTION ''not_authorised''; END IF;';

  v_pos := position(v_marker in v_def);
  v_pos := v_pos + length(v_marker);
  v_pos := v_pos + position(E'\nBEGIN\n' in substring(v_def from v_pos)) - 1
           + length(E'\nBEGIN\n');

  v_def := substring(v_def from 1 for v_pos - 1) || v_guard || E'\n'
           || substring(v_def from v_pos);

  EXECUTE v_def;
  RAISE NOTICE 'fn_search_messages guarded';
END $mig$;
