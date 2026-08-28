-- ═══════════════════════════════════════════════════════════════════════════
--  AN UNAUTHENTICATED CALLER COULD BUY REBUYS WITH SOMEBODY ELSE'S CHIPS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Applied to production 2026-08-28 via the Supabase MCP (apply_migration
-- "rebuy_identity_check_must_fail_closed_for_anon"). This file is the record.
--
-- THE HOLE. process_tournament_rebuy guarded its identity check like this:
--
--     IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
--       RAISE EXCEPTION 'caller may only transact for themselves' ... 42501
--     END IF;
--
-- The check is skipped entirely when auth.uid() IS NULL. That was written to let
-- the ENGINE through: it calls this for horses on the service key and has no
-- auth.uid() to offer. A real requirement, solved the wrong way - because `anon`
-- has no auth.uid() either, and `anon` held EXECUTE on the function.
--
-- So the guard failed OPEN for exactly the caller it most needed to stop: one
-- holding nothing but the public anon key, which ships inside the client bundle.
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
-- Anyone could force any seated player in any rebuy-enabled tournament to buy
-- rebuys they never asked for, repeatedly with a fresh client token, and drain
-- their club wallet. No account required.
--
-- AFTER THIS MIGRATION, same event, same player, all four callers:
--
--   REPROBE8 A(anon)        = refused 42501
--            B(other user)  = refused 42501
--            C(the player)  = allowed success=true
--            D(engine)      = past the gate, refused later by a BUSINESS rule
--                             ("Stack too high for a rebuy") because C had just
--                             topped the same stack up in the same transaction
--
-- THE FIX, the same shape as the two authorization bypasses closed in #1532:
-- identify the engine by WHAT ROLE IS CALLING, never by the absence of a user.
--
--   * service_role, or no PostgREST request context at all, is the engine;
--   * everyone else must be logged in AND be the player being charged.
--
-- A NULL auth.uid() is now a refusal, not a free pass. `anon` loses EXECUTE
-- outright as well, because no logged-out visitor has any business buying chips.
--
-- THE BODY IS EDITED IN PLACE from pg_get_functiondef rather than retyped. It is
-- 12,815 characters of money path, and a transcription error in it would be a
-- worse bug than the one being fixed. The replacement asserts it matched exactly
-- once, so a silent no-op is impossible, and the verification block below
-- re-reads the installed definition rather than trusting the edit.

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
