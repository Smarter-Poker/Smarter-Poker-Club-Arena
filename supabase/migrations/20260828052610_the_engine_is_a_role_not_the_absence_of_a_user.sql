-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828052610; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
--  THE ENGINE IS A ROLE, NOT THE ABSENCE OF A USER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Thirty-nine SECURITY DEFINER functions guarded themselves like this:
--
--     IF auth.uid() IS NOT NULL AND <the real check> THEN refuse
--
-- which skips the check entirely when there is no auth.uid(). Every one of them
-- was written that way for the same honest reason: the ENGINE calls them on the
-- service key and has no auth.uid() to offer, so "no user" became shorthand for
-- "trusted". It is the wrong shorthand, because `anon` has no auth.uid() either.
--
-- On 2026-08-28 that shorthand was live-exploitable in process_tournament_rebuy
-- (#1570): with nothing but the public anon key that ships in the client bundle,
-- an unauthenticated call bought a rebuy for a real seated player and took the
-- chips out of their balance. That one had the grant; the other thirty-eight do
-- not, so they are not bugs today. Their safety rests on a GRANT rather than on
-- their own GUARD, and a grant is one migration away from changing.
--
-- THE REWRITE, applied to 37 of them:
--
--     IF auth.uid() IS NOT NULL AND C THEN refuse
--  -> IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR (C)) THEN refuse
--
--     IF auth.uid() IS NOT NULL THEN <checks> END IF
--  -> IF NOT public.fn_caller_is_engine() THEN <checks> END IF
--
-- Semantics for the two callers that actually exist are IDENTICAL:
--
--   the engine (service_role)  never refused, before and after
--   a logged-in browser        refused exactly when C, before and after
--   a logged-out caller        was never refused; is now always refused
--
-- so the only behaviour that changes is the one that should never have existed.
--
-- TWO ARE DELIBERATELY LEFT ALONE, and they are not oversights:
--
--   ca_player_hands(uuid, text, integer)
--   fn_union_report_caller_ok(uuid)
--
-- Both use `auth.uid() IS NOT NULL AND auth.uid() = ...` as a POSITIVE
-- permission test inside a boolean expression, not as an IF guard. That shape
-- already fails CLOSED: being logged out makes it false, which denies. Rewriting
-- them would invert their meaning. Both are read-only. The rewrite skips them by
-- construction - it only matches a condition that ends in THEN and contains no
-- statement separator - and the assertion below expects exactly these two to
-- remain, so a future rewrite cannot quietly leave a third behind.
--
-- The bodies are edited in place from pg_get_functiondef rather than retyped.
-- Thirty-seven functions of money and admin path is far past the point where
-- transcription is the greater risk. The migration is one transaction: all
-- thirty-seven land or none do.

CREATE OR REPLACE FUNCTION public.fn_caller_is_engine()
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  -- The engine and every server-side job authenticate as service_role. A NULL
  -- means there is no PostgREST request context at all - psql, pg_cron, a
  -- migration - which is equally trusted. A browser can never produce NULL:
  -- reaching `authenticated` requires a verified JWT and PostgREST always sets
  -- request.jwt.claims from it.
  --
  -- NOT current_user. Inside a SECURITY DEFINER body current_user is the
  -- function OWNER for the browser and the engine alike, which is what made an
  -- earlier guard on club_members a silent no-op.
  SELECT COALESCE(auth.role(), 'service_role') = 'service_role';
$function$;

REVOKE ALL ON FUNCTION public.fn_caller_is_engine() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_caller_is_engine() TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_caller_is_engine() IS
  'True when the caller is the engine or another server-side job: service_role, or no request context at all. The single definition of that question, so no two guards can disagree about it.';

DO $$
DECLARE
  r record;
  v_new text;
  v_done int := 0;
  v_skipped int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS d
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.proname <> 'fn_caller_is_engine'
       AND pg_get_functiondef(p.oid) ~ 'auth\.uid\(\) IS NOT NULL'
     ORDER BY p.oid::regprocedure::text
  LOOP
    -- `[^;]*?` is load-bearing: a condition never contains a statement
    -- separator, so this cannot run past the end of an IF and swallow half a
    -- function. It is also what makes the two expression-embedded cases skip
    -- themselves instead of being mangled.
    v_new := regexp_replace(
               regexp_replace(r.d,
                 'auth\.uid\(\) IS NOT NULL\s+AND([^;]*?)\s+THEN',
                 'NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR (\1)) THEN', 'g'),
               'auth\.uid\(\) IS NOT NULL\s+THEN',
               'NOT public.fn_caller_is_engine() THEN', 'g');

    IF v_new = r.d THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    EXECUTE v_new;
    v_done := v_done + 1;
  END LOOP;

  IF v_done <> 37 THEN
    RAISE EXCEPTION 'expected to rewrite 37 functions, rewrote %', v_done;
  END IF;
  IF v_skipped <> 2 THEN
    RAISE EXCEPTION 'expected to skip exactly 2 expression-embedded guards, skipped %', v_skipped;
  END IF;
END $$;

-- Prove it, rather than assuming it.
DO $$
DECLARE v_left text; v_n int;
BEGIN
  SELECT count(*), string_agg(p.oid::regprocedure::text, ', ')
    INTO v_n, v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND pg_get_functiondef(p.oid) ~ 'auth\.uid\(\) IS NOT NULL';

  IF v_n <> 2
     OR v_left NOT LIKE '%ca_player_hands%'
     OR v_left NOT LIKE '%fn_union_report_caller_ok%' THEN
    RAISE EXCEPTION 'expected exactly the two positive-test guards to remain, found %: %', v_n, v_left;
  END IF;

  -- And those two must still be read-only, or leaving them alone was wrong.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('ca_player_hands','fn_union_report_caller_ok')
       AND pg_get_functiondef(p.oid) ~* '(^|[^a-z_])(insert into|update |delete from)'
  ) THEN
    RAISE EXCEPTION 'a skipped guard writes; it cannot be left as a positive test';
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND pg_get_functiondef(p.oid) ~ 'fn_caller_is_engine';
  IF v_n < 37 THEN
    RAISE EXCEPTION 'only % functions reference fn_caller_is_engine', v_n;
  END IF;
END $$;

