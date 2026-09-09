-- 20260909071854_a_signed_out_caller_cannot_read_another_players_round.sql
--
-- Recorded at the version production assigned. The Supabase MCP assigns its own
-- version, and a file left at a different number is applied a SECOND time on a
-- rebuild - which here would abort on its own "already carries a signed-out
-- guard" assertion.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THREE-VALUED LOGIC, IN A MONEY GAME
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FOUND BY FOLLOWING A RED WORKFLOW. `Schema Manifest Refresh` had been failing
-- on `main` at its "No unaccounted DEFINER writer is reachable from a browser"
-- job. `fn_definer_exposure_audit()` names five SECURITY DEFINER functions that
-- a LOGGED-OUT caller can execute and that WRITE:
--
--     fn_crash_start, fn_plinko_drop, fn_wheel_commit,
--     fn_wheel_set_config, fn_wheel_spin
--
-- All five are the Diamonds casino games. Three of them refuse a signed-out
-- caller in their first statement. TWO DID NOT:
--
--     function          IF v_user IS NULL guard    owner check
--     fn_crash_start    no                         user_id <> v_user
--     fn_plinko_drop    no                         user_id <> v_user
--     fn_wheel_commit   yes                        -
--     fn_wheel_spin     yes                        user_id <> v_user
--     fn_wheel_set_config  yes (service_role form) -
--
-- Missing the guard is only defence in depth on its own - `fn_diamond_game_-
-- admit` further down would still have to admit the bet. The exposure is the
-- COMBINATION with the ownership check, which read:
--
--     SELECT * INTO prior FROM public.crash_rounds WHERE commit_id = p_commit_id;
--     IF prior.id IS NOT NULL THEN
--       IF prior.user_id <> v_user THEN
--         RETURN ... 'That Round Belongs To Another Player';
--       END IF;
--       RETURN public.fn_crash_round_result(prior) || ... 'replayed';
--     END IF;
--
-- With `v_user` NULL - which is exactly what a logged-out caller has -
-- `prior.user_id <> NULL` evaluates to NULL. NULL is not TRUE, so the refusal
-- does not fire, and execution falls straight through to the RETURN below it.
-- **A signed-out caller holding a commit_id could read another player's round
-- result.** Same shape in `fn_plinko_drop`.
--
-- ── WHAT THIS CHANGES ──────────────────────────────────────────────────────
--
-- 1. `fn_crash_start` and `fn_plinko_drop` refuse a NULL `auth.uid()` in their
--    first statement, exactly as their three siblings already do.
-- 2. Every `user_id <> v_user` in those two and in `fn_wheel_spin` becomes
--    `user_id IS DISTINCT FROM v_user`. `fn_wheel_spin` was never reachable
--    with a NULL because its guard is already there; it is made null-safe so
--    that a later edit which moves that guard cannot silently re-open this.
--
-- Both changes are strictly more restrictive. Nothing that a signed-in player
-- could do before is refused now.
--
-- The grants are left exactly as they are. Revoking EXECUTE from `anon` would
-- also be correct and is the stronger fix, but it changes what the client can
-- call and belongs with whoever owns the Diamonds surface; the functions now
-- refuse on their own merits either way. `fn_definer_exposure_audit`'s
-- `anon_writers` list still names all five, so the audit stays honest about the
-- grant rather than being quieted by this.
--
-- HOW THE EDIT IS MADE. Bodies are read LIVE with pg_get_functiondef and
-- changed by literal replace, with four assertions each before the edit and two
-- post-checks after it, so a body that has moved on aborts rather than being
-- rewritten from a stale copy. The first attempt DID abort, on its own
-- post-check: the targeted replace fixed `prior.user_id <> v_user` and left a
-- second `c.user_id <> v_user` behind, and the check counted it. That is the
-- assertion working.

BEGIN;

DO $fix$
DECLARE
  r record;
  v_def text;
  v_new text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname,
           CASE p.proname WHEN 'fn_crash_start' THEN 'crash_rounds'
                          WHEN 'fn_plinko_drop' THEN 'plinko_drops' END AS tbl,
           CASE p.proname WHEN 'fn_crash_start' THEN 'Sign In To Play'
                          WHEN 'fn_plinko_drop' THEN 'Sign In To Drop' END AS msg
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('fn_crash_start','fn_plinko_drop')
     ORDER BY p.proname
  LOOP
    v_def := pg_get_functiondef(r.oid);

    IF position('v_user uuid := auth.uid();' IN v_def) = 0 THEN
      RAISE EXCEPTION '%: v_user is no longer auth.uid(); the body has moved on', r.proname;
    END IF;
    IF position('IF v_user IS NULL THEN' IN v_def) <> 0 THEN
      RAISE EXCEPTION '%: already carries a signed-out guard; refusing to add a second', r.proname;
    END IF;
    IF position('  SELECT * INTO prior FROM public.' || r.tbl || ' WHERE commit_id = p_commit_id;' IN v_def) = 0 THEN
      RAISE EXCEPTION '%: the commit_id replay lookup is not where this edit expects it', r.proname;
    END IF;
    IF position('user_id <> v_user' IN v_def) = 0 THEN
      RAISE EXCEPTION '%: the owner check is not the null-unsafe form this edit fixes', r.proname;
    END IF;

    v_new := replace(
      v_def,
      'BEGIN
  SELECT * INTO prior FROM public.' || r.tbl || ' WHERE commit_id = p_commit_id;',
      'BEGIN
  -- A SIGNED-OUT CALLER IS NOT A PLAYER (2026-09-09).
  --
  -- This RPC is granted to `anon`, and it had no sign-in guard while its
  -- siblings (fn_wheel_commit, fn_wheel_spin, fn_wheel_set_config) all do. On
  -- its own that is only defence in depth - but the ownership check below read
  -- `user_id <> v_user`, and with v_user NULL that comparison is NULL, which is
  -- not TRUE, so the refusal did not fire and execution fell through to return
  -- the round. A logged-out caller holding a commit_id could read another
  -- player''s result. Three-valued logic, in a money game. Every such
  -- comparison in this body is now IS DISTINCT FROM as well.
  IF v_user IS NULL THEN
    RETURN jsonb_build_object(''ok'', false, ''error'', ''' || r.msg || ''');
  END IF;
  SELECT * INTO prior FROM public.' || r.tbl || ' WHERE commit_id = p_commit_id;'
    );
    v_new := replace(v_new, 'user_id <> v_user', 'user_id IS DISTINCT FROM v_user');

    IF v_new = v_def THEN
      RAISE EXCEPTION '%: replacement matched nothing', r.proname;
    END IF;
    EXECUTE v_new;
  END LOOP;

  -- fn_wheel_spin already refuses a NULL v_user up front, so its comparison can
  -- never be reached with a NULL. Make it null-safe anyway: the next edit that
  -- moves that guard must not silently re-open this.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_wheel_spin';
  IF v_def IS NOT NULL AND position('IF v_user IS NULL THEN' IN v_def) > 0
     AND position('user_id <> v_user' IN v_def) > 0 THEN
    v_new := replace(v_def, 'user_id <> v_user', 'user_id IS DISTINCT FROM v_user');
    IF v_new <> v_def THEN EXECUTE v_new; END IF;
  END IF;
END;
$fix$;

DO $proof$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname='public'
     AND p.proname IN ('fn_crash_start','fn_plinko_drop')
     AND pg_get_functiondef(p.oid) ~ 'IF v_user IS NULL THEN';
  IF n <> 2 THEN
    RAISE EXCEPTION 'post-check: only % of 2 game entry points refuse a signed-out caller', n;
  END IF;

  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname='public'
     AND p.proname IN ('fn_crash_start','fn_plinko_drop','fn_wheel_spin')
     AND pg_get_functiondef(p.oid) ~ 'user_id <> v_user';
  IF n <> 0 THEN
    RAISE EXCEPTION 'post-check: % null-unsafe owner comparison(s) remain', n;
  END IF;
END;
$proof$;

COMMIT;
