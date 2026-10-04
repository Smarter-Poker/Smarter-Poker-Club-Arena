-- ===========================================================================
--  PAGE PREFERENCES COUNT THE ROW THEY WROTE, AND THE DEAD ARENA FREEZE
--  SCOPE IS RETIRED
-- ===========================================================================
--
-- Two root-cause fixes, each read from production on 2026-10-04 23:00 to
-- 23:20 UTC. Neither holds nor moves a chip or a Diamond.
--
-- 1. public.update_page_preferences(uuid, text, jsonb) HAS NEVER SAVED A ROW
--
--    The body ran its UPDATE through EXECUTE ... INTO and then tested FOUND:
--
--        EXECUTE format('UPDATE profiles SET %I = $1, ... RETURNING %I', ...)
--          INTO v_preferences USING p_preferences, p_user_id;
--        IF NOT FOUND THEN
--          RAISE EXCEPTION 'Profile not found';
--
--    PL/pgSQL: "EXECUTE changes the output of GET DIAGNOSTICS, but does not
--    change FOUND." FOUND starts false in every call and no earlier statement
--    in the body sets it, so the test was true on EVERY call: the function
--    raised 'Profile not found' for a profile it had just updated, and the
--    exception rolled the update back. Reproduced on a local PostgreSQL 16
--    with the live text (md5 d98e1becf64a5c606d310b26b0a1e49c) loaded.
--    Production agrees: of 1,860+ profiles, 0 hold a non-empty
--    bankroll_preferences, news_preferences, memory_games_preferences or
--    video_library_preferences, the columns written only through this door.
--
--    THE FIX is the test and nothing else: the row count of the EXECUTE is
--    read with GET DIAGNOSTICS and compared to zero. Signature, SECURITY
--    DEFINER, search_path, owner, grants, the caller check, the allowlist and
--    every other line are asserted byte-identical. Preimage
--    8cd27b35b801feb60a239bdf1c0c51cd, the text migration 20261004214251
--    leaves (it removes 'diamond_arena_preferences' from the allowlist and
--    MUST be applied before this file; the preimage check refuses otherwise).
--    Postimage 875d8538e2edb229d6ebe898eebb1281.
--
--    Not changed, and written down so nobody mistakes it for this fix: the
--    allowlist still names trivia_preferences, video_preferences and
--    diamond_arcade_preferences, which are not columns of profiles. A call
--    naming one fails 42703 at the UPDATE, as it always did.
--
-- 2. THE 'arena_withdrawals' PAYOUT-FREEZE SCOPE FREEZES NOTHING
--
--    Its one reader was fn_arena_withdraw, a door that has only raised since
--    20260909065458 and that 20261004214251 drops. After that drop the name
--    survives in exactly three places, all changed here:
--      * fn_ca_open_payout_freeze's accepted list (an operator could open a
--        freeze that refuses nothing and believe withdrawals were stopped);
--      * the ca_payout_freeze_scope_check constraint;
--      * the comment on ca_payout_freeze.scope.
--    ca_payout_freeze holds 0 rows in any scope, so there is no history to
--    keep; the file refuses if a row in that scope exists when it runs. No
--    other scope is touched. Custody release is not a withdrawal door and is
--    governed by its own guards; nothing is wired to this name any more.
--    fn_ca_open_payout_freeze: preimage ecf284c2ab749e2339918ff89ed4c874,
--    postimage 03fe1a6b3b13713de339f9a9c58eedef.
--
-- NOT CHANGED: fn_ca_arena_seat_is_same_asset and DR15 are KEPT. They are
-- shared by the new Poker Arena seat path, not legacy.
--
-- GUARD WATCHLIST. Neither redefined function is on fn_ca_guard_watchlist()
-- (read 2026-10-04); the file refuses if either has joined it, so a watched
-- guard is never redefined here without its declaration.
--
-- LOCKS. The two function redefinitions run first and take no table lock.
-- The constraint swap needs AccessExclusive on ca_payout_freeze, an empty
-- table that the wheel, mint, BBJ and tournament settle paths read. It is
-- taken in ONE LOCK TABLE under a 250 ms lock_timeout, retried after 100 ms,
-- at most 40 times (the pattern of 20261002030942 and 20261004214251), so no
-- reader queues behind this file for more than 250 ms at a time. Under the
-- lock: one zero-row read, one ALTER TABLE that drops and re-adds the CHECK
-- (validated against 0 rows), one COMMENT. No foreign key, no hot-table scan.
--
-- CLAUDE.md section 2: one migration, one transaction. Apply it ONCE, after
-- 20261004214251, outside :50-:03 UTC, never in a retry loop.
-- ===========================================================================
-- @live-proof: md5(pg_get_functiondef('public.update_page_preferences(uuid,text,jsonb)'::regprocedure)) = '875d8538e2edb229d6ebe898eebb1281'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_open_payout_freeze(text,text,text)'::regprocedure)) = '03fe1a6b3b13713de339f9a9c58eedef'
-- @live-proof: NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.ca_payout_freeze'::regclass AND pg_get_constraintdef(c.oid) LIKE '%arena_withdrawals%')
-- @live-proof: NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc LIKE '%arena_withdrawals%')

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. PREIMAGE: the estate is the one read on 2026-10-04, after 20261004214251
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  r record;
  v_live text;
  v_bad text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.update_page_preferences(uuid,text,jsonb)', '8cd27b35b801feb60a239bdf1c0c51cd'),
      ('public.fn_ca_open_payout_freeze(text,text,text)', 'ecf284c2ab749e2339918ff89ed4c874')) AS x(sig, m)
  LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'preimage: % does not exist; read the live catalog before applying this file', r.sig;
    END IF;
    v_live := md5(pg_get_functiondef(to_regprocedure(r.sig)));
    IF v_live IS DISTINCT FROM r.m THEN
      RAISE EXCEPTION 'preimage: % is not the text this file was written for (md5 %, expected %); if update_page_preferences reads d98e1becf64a5c606d310b26b0a1e49c, apply 20261004214251 first', r.sig, v_live, r.m;
    END IF;
  END LOOP;

  -- One overload each, so the redefinition below is the whole function.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('update_page_preferences', 'fn_ca_open_payout_freeze')
     AND p.oid NOT IN ('public.update_page_preferences(uuid,text,jsonb)'::regprocedure,
                       'public.fn_ca_open_payout_freeze(text,text,text)'::regprocedure);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'preimage: an unread overload exists: %', v_bad;
  END IF;

  -- The scope's one reader is gone; only the opener still names it.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND p.prokind IN ('f', 'p')
     AND p.prosrc LIKE '%arena_withdrawals%'
     AND p.oid <> 'public.fn_ca_open_payout_freeze(text,text,text)'::regprocedure;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'preimage: a function still names the arena_withdrawals scope: % (apply 20261004214251 first; if it is a new reader, the scope is not dead and this file is wrong)', v_bad;
  END IF;

  -- Neither function is a watched guard; if one has become one, it needs its
  -- declaration and this file does not carry it.
  IF 'update_page_preferences' = ANY (public.fn_ca_guard_watchlist())
     OR 'fn_ca_open_payout_freeze' = ANY (public.fn_ca_guard_watchlist()) THEN
    RAISE EXCEPTION 'preimage: a function redefined here joined fn_ca_guard_watchlist(); add fn_ca_declare_guard_redefinition before applying';
  END IF;

  -- The constraint and the comment are the ones read.
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.ca_payout_freeze'::regclass
         AND c.conname = 'ca_payout_freeze_scope_check') IS DISTINCT FROM
     $c$CHECK ((scope = ANY (ARRAY['tournament_payouts'::text, 'bbj_payouts'::text, 'diamond_issuance'::text, 'diamond_tournament_payouts'::text, 'arena_withdrawals'::text, 'wheel'::text, 'plinko'::text, 'crash'::text, 'crossing'::text, 'mines'::text])))$c$ THEN
    RAISE EXCEPTION 'preimage: ca_payout_freeze_scope_check is not the constraint read on 2026-10-04';
  END IF;
  IF md5(col_description('public.ca_payout_freeze'::regclass,
           (SELECT a.attnum FROM pg_attribute a
             WHERE a.attrelid = 'public.ca_payout_freeze'::regclass AND a.attname = 'scope')))
     IS DISTINCT FROM '47fa231d142c29700a04296312b23bda' THEN
    RAISE EXCEPTION 'preimage: the comment on ca_payout_freeze.scope is not the one read on 2026-10-04';
  END IF;
END $pre$;

-- ---------------------------------------------------------------------------
-- 1. THE TWO FUNCTIONS, EACH FROM ITS LIVE TEXT WITH ONLY THE NAMED LINES MOVED
-- ---------------------------------------------------------------------------
DO $redefine$
DECLARE
  r record;
  v_def text; v_want text; v_after text; v_hits integer; v_acl text; v_owner oid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      -- the row counter is declared
      (1, 'public.update_page_preferences(uuid,text,jsonb)',
       $o1$  v_preferences jsonb;
BEGIN
$o1$,
       $n1$  v_preferences jsonb;
  v_rows bigint;
BEGIN
$n1$),
      -- and it, not FOUND, answers whether the EXECUTE wrote a row
      (2, 'public.update_page_preferences(uuid,text,jsonb)',
       $o2$  ) INTO v_preferences USING p_preferences, p_user_id;
  IF NOT FOUND THEN
$o2$,
       $n2$  ) INTO v_preferences USING p_preferences, p_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
$n2$),
      -- the opener stops accepting the scope nobody reads
      (3, 'public.fn_ca_open_payout_freeze(text,text,text)',
       $o3$                     'diamond_tournament_payouts', 'arena_withdrawals') THEN
$o3$,
       $n3$                     'diamond_tournament_payouts') THEN
$n3$)) AS x(step, sig, old, new)
    ORDER BY step
  LOOP
    v_def := pg_get_functiondef(to_regprocedure(r.sig));
    v_hits := (length(v_def) - length(replace(v_def, r.old, ''))) / length(r.old);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '% step %: the text to replace was found % time(s), expected 1', r.sig, r.step, v_hits;
    END IF;
    v_want := replace(v_def, r.old, r.new);
    IF length(v_want) - length(v_def) <> length(r.new) - length(r.old) THEN
      RAISE EXCEPTION '% step %: the replacement moved more than its own lines', r.sig, r.step;
    END IF;
    SELECT p.proacl::text, p.proowner INTO v_acl, v_owner FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    EXECUTE v_want;
    v_after := pg_get_functiondef(to_regprocedure(r.sig));
    IF v_after IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION '% step %: unrelated text changed (md5 %)', r.sig, r.step, md5(v_after);
    END IF;
    IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig)) IS DISTINCT FROM v_acl
       OR (SELECT p.proowner FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig)) IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION '% step %: its grants or owner moved', r.sig, r.step;
    END IF;
  END LOOP;

  -- Postimages: exactly the texts this file was written and proved for.
  v_after := pg_get_functiondef('public.update_page_preferences(uuid,text,jsonb)'::regprocedure);
  IF md5(v_after) <> '875d8538e2edb229d6ebe898eebb1281' THEN
    RAISE EXCEPTION 'update_page_preferences postimage is not the one this file was written for (md5 %)', md5(v_after);
  END IF;
  IF v_after ~ '\mFOUND\M'
     OR position('GET DIAGNOSTICS v_rows = ROW_COUNT;' IN v_after) = 0
     OR position('IF auth.uid() IS NULL OR auth.uid() != p_user_id THEN' IN v_after) = 0
     OR position('SECURITY DEFINER' IN v_after) = 0
     OR position('SET search_path TO ''public''' IN v_after) = 0
     OR position('RAISE EXCEPTION ''Profile not found'';' IN v_after) = 0 THEN
    RAISE EXCEPTION 'update_page_preferences does not keep its caller check, its settings and its refusal, or still tests FOUND';
  END IF;
  v_after := pg_get_functiondef('public.fn_ca_open_payout_freeze(text,text,text)'::regprocedure);
  IF md5(v_after) <> '03fe1a6b3b13713de339f9a9c58eedef' OR position('arena_withdrawals' IN v_after) > 0 THEN
    RAISE EXCEPTION 'fn_ca_open_payout_freeze postimage is not the one this file was written for (md5 %)', md5(v_after);
  END IF;

  IF has_function_privilege('anon', 'public.update_page_preferences(uuid,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.update_page_preferences(uuid,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_open_payout_freeze(text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_open_payout_freeze(text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a redefined function changed who may execute it';
  END IF;
END $redefine$;

-- ---------------------------------------------------------------------------
-- 2. THE LOCK ON THE FREEZE TABLE, IN BOUNDED ATTEMPTS
-- ---------------------------------------------------------------------------
DO $lock$
DECLARE v_tries int := 0;
BEGIN
  PERFORM set_config('lock_timeout', '250ms', true);
  LOOP
    BEGIN
      LOCK TABLE public.ca_payout_freeze IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      v_tries := v_tries + 1;
      IF v_tries >= 40 THEN
        RAISE EXCEPTION 'ca_payout_freeze could not be locked in % tries (about 14 s); nothing was applied - apply once more when the platform is quieter, never in a loop', v_tries;
      END IF;
      PERFORM pg_sleep(0.1);
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', '2s', true);
  RAISE NOTICE 'ca_payout_freeze: AccessExclusive taken after % failed tries', v_tries;
END $lock$;

-- ---------------------------------------------------------------------------
-- 3. NO ROW HOLDS THE SCOPE, READ UNDER THE LOCK THAT KEEPS IT SO
-- ---------------------------------------------------------------------------
DO $empty$
DECLARE v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.ca_payout_freeze WHERE scope = 'arena_withdrawals';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'ca_payout_freeze holds % row(s) in scope arena_withdrawals; freeze history is never deleted or rewritten, so this file does not apply - retire the scope from the opener only and keep the constraint', v_n;
  END IF;
END $empty$;

-- ---------------------------------------------------------------------------
-- 4. THE CONSTRAINT AND THE COMMENT STOP NAMING IT (every other scope kept)
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_payout_freeze
  DROP CONSTRAINT ca_payout_freeze_scope_check,
  ADD CONSTRAINT ca_payout_freeze_scope_check CHECK (scope = ANY (ARRAY[
    'tournament_payouts'::text, 'bbj_payouts'::text, 'diamond_issuance'::text,
    'diamond_tournament_payouts'::text, 'wheel'::text, 'plinko'::text,
    'crash'::text, 'crossing'::text, 'mines'::text]));

COMMENT ON COLUMN public.ca_payout_freeze.scope IS
  'What an open row refuses. tournament_payouts is read by fn_settle_tournament_obligation. diamond_issuance and diamond_tournament_payouts are names standard 3.4 layer 6 reserves for the diamond paths. The legacy arena withdrawal scope was retired on 2026-10-04 with its only reader, the dropped fn_arena_withdraw (migration 20261004231057). A row in a scope nobody reads refuses nothing.';

-- ---------------------------------------------------------------------------
-- 5. THE ESTATE IS AS IT SHOULD BE
-- ---------------------------------------------------------------------------
DO $post$
DECLARE v_bad text;
BEGIN
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.ca_payout_freeze'::regclass
         AND c.conname = 'ca_payout_freeze_scope_check' AND c.convalidated) IS DISTINCT FROM
     $c$CHECK ((scope = ANY (ARRAY['tournament_payouts'::text, 'bbj_payouts'::text, 'diamond_issuance'::text, 'diamond_tournament_payouts'::text, 'wheel'::text, 'plinko'::text, 'crash'::text, 'crossing'::text, 'mines'::text])))$c$ THEN
    RAISE EXCEPTION 'ca_payout_freeze_scope_check is not the nine remaining scopes, validated';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND p.prosrc LIKE '%arena_withdrawals%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a function still names the retired scope: %', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_description d
              WHERE d.objoid = 'public.ca_payout_freeze'::regclass
                AND d.description LIKE '%arena_withdrawals%') THEN
    RAISE EXCEPTION 'a comment on ca_payout_freeze still names the retired scope';
  END IF;
  IF (SELECT c.relacl::text FROM pg_class c WHERE c.oid = 'public.ca_payout_freeze'::regclass) IS NULL
     OR has_table_privilege('anon', 'public.ca_payout_freeze', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ca_payout_freeze', 'SELECT') THEN
    RAISE EXCEPTION 'ca_payout_freeze became readable by anon or authenticated';
  END IF;
  RAISE NOTICE 'update_page_preferences counts the row it wrote; the arena_withdrawals freeze scope is retired from the opener, the constraint and the comment';
END $post$;

COMMIT;
