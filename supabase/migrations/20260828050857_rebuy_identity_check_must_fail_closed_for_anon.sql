-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828050857; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
--  AN UNAUTHENTICATED CALLER COULD BUY REBUYS WITH SOMEBODY ELSE'S CHIPS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- process_tournament_rebuy guarded its identity check like this:
--
--     IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
--       RAISE EXCEPTION 'caller may only transact for themselves' ... 42501
--     END IF;
--
-- The check is skipped entirely when auth.uid() IS NULL. That was written to
-- let the ENGINE through, which calls this for horses on the service key and
-- has no auth.uid() to offer - a real requirement, solved the wrong way. `anon`
-- also has no auth.uid(), and `anon` held EXECUTE on the function.
--
-- So the guard failed OPEN for exactly the caller it most needed to stop: one
-- holding nothing but the public anon key, which ships in the client bundle.
--
-- PROVEN, not assumed. As `anon`, with no `sub` claim at all, against a real
-- seated player in a live rebuy-enabled event, inside a transaction that rolled
-- itself back:
--
--   PROBE8 "$100 Freeroll - 12:00 AM" victim=00000000-...-000000000002
--     anon call -> CALL COMPLETED: {"success": true, "chips_added": 5000,
--                   "new_stack": 8746, "cost": 1, "rebuy_type": "rebuy"}
--     balance 25814.61 -> 25813.61
--
-- An attacker could force any seated player in any rebuy-enabled tournament to
-- buy rebuys they did not ask for, repeatedly with a fresh client token, and
-- drain their club wallet. No account required.
--
-- THE FIX, the same shape as the two authorization bypasses closed on
-- 2026-08-27 (#1532): identify the engine by WHAT ROLE IS CALLING, never by the
-- absence of a user.
--
--   * service_role, or no PostgREST request context at all, is the engine.
--   * everyone else must be logged in AND must be the player being charged.
--
-- A NULL auth.uid() is now a refusal, not a free pass. And `anon` loses EXECUTE
-- outright, because no logged-out visitor has any business buying chips.
--
-- The body is edited IN PLACE from pg_get_functiondef rather than retyped. It is
-- 12,815 characters of money path, and a transcription error in it would be a
-- worse bug than the one being fixed. The replacement asserts it matched
-- exactly once, so a silent no-op is impossible.

DO $$
DECLARE
  v_def text;
  v_old text := 'IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN';
  v_new text :=
    'IF NOT (COALESCE(auth.role(), ''service_role'') = ''service_role'')' || E'\n' ||
    '     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'process_tournament_rebuy';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'process_tournament_rebuy not found';
  END IF;

  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly one fail-open guard to replace, found %', v_hits;
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END $$;

-- No logged-out visitor buys chips.
REVOKE ALL ON FUNCTION public.process_tournament_rebuy(uuid, uuid, text, numeric, numeric, integer, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_tournament_rebuy(uuid, uuid, text, numeric, numeric, integer, text)
  TO authenticated, service_role;

-- Prove the edit took and the grants are what they should be, rather than
-- shipping quietly on the assumption that they are.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'process_tournament_rebuy';

  IF position('auth.uid() IS NOT NULL AND auth.uid() <> p_user_id' in v_def) > 0 THEN
    RAISE EXCEPTION 'the fail-open guard is still there';
  END IF;
  IF position('COALESCE(auth.role(), ''service_role'') = ''service_role''' in v_def) = 0 THEN
    RAISE EXCEPTION 'the new guard is not there';
  END IF;
  IF has_function_privilege('anon',
       'public.process_tournament_rebuy(uuid, uuid, text, numeric, numeric, integer, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute it';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.process_tournament_rebuy(uuid, uuid, text, numeric, numeric, integer, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.process_tournament_rebuy(uuid, uuid, text, numeric, numeric, integer, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a legitimate caller lost access';
  END IF;
END $$;

