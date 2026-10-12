-- ===========================================================================
--  THE LEGACY DIAMOND ARENA DATABASE OBJECTS ARE DROPPED
-- ===========================================================================
--
-- Poker Arena Diamond build programme, Phase 12 of 12, line 7: "Remove
-- exclusive obsolete database functions, triggers and tables through new
-- forward migrations after reconciling balances and obligations. Preserve
-- historical migration files and financial journal evidence."
--
-- WHAT GOES, each read from production on 2026-10-04 21:30 to 21:45 UTC:
--
--   public.fn_arena_deposit(integer, text)
--   public.fn_arena_withdraw(integer, text)
--     The chip-backed manual arena doors of 20260908034530. 20260909065458
--     (custody) replaced both bodies with a single RAISE: "Manual arena
--     deposits are retired; use game reservation." and its withdrawal twin.
--     Neither has moved a Diamond since. No function body, view, trigger or
--     policy names either one except the two allowlist lines in
--     fn_guard_profile_privileged_columns removed below; neither repository
--     calls them. pg_get_functiondef md5: 0eee60a9c665445960e282de503da96f
--     and fcf9a0a122a172e35e8d59b0f372900c.
--
--   two allowlist lines in public.fn_guard_profile_privileged_columns()
--     The guard admitted a profiles.diamonds write made from a call stack
--     naming either door. A door that only raises can never be that stack, and
--     once the function is gone the name is free: a later function created
--     under it would inherit an admission nobody reviewed. The two lines are
--     removed and nothing else in the guard changes (asserted byte for byte).
--     Preimage d40c547c47f3d0516dc24f22ab53da7e, the body 20260930121500 left;
--     postimage b140541b68ba8f97ce74d7e0a5e7680f.
--
--   public.diamond_arena_events
--     The retired standalone Diamond Arena's trivia event log (score,
--     correct_count, prize_awarded, entry_fee, diamonds_delta). 0 rows, 0
--     inserts since statistics began, no trigger, no inbound foreign key, in
--     no publication, named by no function body and by no statement in
--     pg_stat_statements except audits. It is not a financial journal: the
--     Diamond journal is diamond_transactions, which this file does not touch.
--
--   public.profiles.diamond_arena_preferences
--     The retired standalone arena's per-player settings. 1,841 rows NULL and
--     3 rows '{}'; no row holds a value. No view, index, constraint, default,
--     trigger or policy depends on it. Two function bodies name it and both
--     are redefined here from their live text with only that name removed:
--     update_page_preferences (the column leaves its allowlist, so a stale
--     client is refused 'Invalid preference column' as for any unknown name)
--     and fn_close_account (the column leaves the list it blanks). The
--     column's own grant, SELECT to authenticated, is revoked before the drop.
--
-- WHAT STAYS, deliberately:
--   * the two ca_money_rpc_registry rows, status 'retired', as evidence. A
--     retired row whose function is absent is the register's existing shape
--     (six such rows today, fn_poker_diamond_recover_releases among them) and
--     no reader reports it: fn_ca_money_rpc_drift walks pg_proc for
--     unregistered writers and joins the register to pg_proc only for status
--     'closed'; fn_ca_second_writer_check and fn_ca_undeclared_money_paths
--     start from functions that exist. Nothing to change, so nothing changed.
--   * every diamond_transactions row and the arena_deposit / arena_withdraw
--     journal kinds, which the custody doors write today.
--   * fn_ca_arena_diamonds (it now reads the custody float), ca_arena_settings
--     (the two switches), fn_ca_arena_seat_is_same_asset with DR15, and the
--     'arena_withdrawals' payout-freeze scope (open owner questions).
--   * public.poker_hands: 0 rows and no function names it, but it is not an
--     arena object (20260419214617, foreign key to poker_tables, which holds 4
--     rows and is read by eight poker-near-me functions). Not this change.
--
-- BALANCES AND OBLIGATIONS. Nothing here holds or moves a Diamond or a chip.
-- The migration refuses unless both arena switches are false and
-- poker_diamond_custody is empty, so no arena obligation is outstanding while
-- the guard is redefined.
--
-- LOCKS. profiles is hot. Dropping its column needs AccessExclusive on it, and
-- dropping diamond_arena_events removes the foreign-key triggers it placed on
-- profiles and on auth.users, which needs AccessExclusive on both. The three
-- function redefinitions and every assertion that does not need the locks run
-- FIRST; then the three locks are taken together in ONE LOCK TABLE under a
-- 250 ms lock_timeout, rolled back and retried after 100 ms, at most 40 times
-- (the pattern of 20261002030942, docs/changelog/2026-10-01-a-drop-trigger-
-- takes-the-auth-schema-hostage.md). No live transaction waits on this file
-- longer than 250 ms at a time, none can be chosen as a deadlock victim by
-- it, and once the locks are held only catalogue work and one 1,844-row read
-- remain before COMMIT. If the locks cannot be had the whole file rolls back.
-- No DROP TRIGGER and no DROP POLICY is written: the table's one policy goes
-- with the table.
--
-- CLAUDE.md section 2: one migration, one transaction. Apply it ONCE, through
-- apply-merged-migration.yml, outside :50-:03 UTC, never in a retry loop.
-- ===========================================================================
-- @live-proof: to_regprocedure('public.fn_arena_deposit(integer,text)') IS NULL AND to_regprocedure('public.fn_arena_withdraw(integer,text)') IS NULL
-- @live-proof: to_regclass('public.diamond_arena_events') IS NULL
-- @live-proof: NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.profiles'::regclass AND attname = 'diamond_arena_preferences' AND NOT attisdropped)
-- @live-proof: md5(pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure)) = 'b140541b68ba8f97ce74d7e0a5e7680f'
-- @live-proof: md5(pg_get_functiondef('public.update_page_preferences(uuid,text,jsonb)'::regprocedure)) = '8cd27b35b801feb60a239bdf1c0c51cd'
-- @live-proof: md5(pg_get_functiondef('public.fn_close_account(uuid)'::regprocedure)) = 'b563620364f47288038818f2f0e24ad9'

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. PREIMAGE: the estate is the one read on 2026-10-04
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  r record;
  v_live text;
  v_bad text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.fn_guard_profile_privileged_columns()',   'd40c547c47f3d0516dc24f22ab53da7e'),
      ('public.update_page_preferences(uuid,text,jsonb)', 'd98e1becf64a5c606d310b26b0a1e49c'),
      ('public.fn_close_account(uuid)',                   '3e00cb1086da53eac75ba2d34001a75a'),
      ('public.fn_arena_deposit(integer,text)',           '0eee60a9c665445960e282de503da96f'),
      ('public.fn_arena_withdraw(integer,text)',          'fcf9a0a122a172e35e8d59b0f372900c')) AS x(sig, m)
  LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'preimage: % does not exist; read the live catalog before applying this file', r.sig;
    END IF;
    v_live := md5(pg_get_functiondef(to_regprocedure(r.sig)));
    IF v_live IS DISTINCT FROM r.m THEN
      RAISE EXCEPTION 'preimage: % is not the text read on 2026-10-04 (md5 %, expected %); re-read it before changing it', r.sig, v_live, r.m;
    END IF;
  END LOOP;

  -- Each name has exactly one overload, so nothing survives the drops below.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('fn_arena_deposit', 'fn_arena_withdraw')
     AND p.oid NOT IN ('public.fn_arena_deposit(integer,text)'::regprocedure,
                       'public.fn_arena_withdraw(integer,text)'::regprocedure);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'preimage: an unread overload of a retired arena door exists: %', v_bad;
  END IF;

  -- No function other than the three redefined here names what is dropped.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND p.prokind IN ('f', 'p')
     AND p.prosrc ~ '\m(fn_arena_deposit|fn_arena_withdraw|diamond_arena_events|diamond_arena_preferences)\M'
     AND p.oid NOT IN ('public.fn_guard_profile_privileged_columns()'::regprocedure,
                       'public.update_page_preferences(uuid,text,jsonb)'::regprocedure,
                       'public.fn_close_account(uuid)'::regprocedure);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'preimage: a function this file does not redefine names a legacy arena object: %', v_bad;
  END IF;

  -- No arena obligation is outstanding while the wallet guard is redefined.
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'preimage: an arena switch is open; this file is written for a closed arena';
  END IF;
  IF EXISTS (SELECT 1 FROM public.poker_diamond_custody) THEN
    RAISE EXCEPTION 'preimage: poker_diamond_custody holds rows; reconcile the custody float before retiring arena objects';
  END IF;

  -- The register keeps both rows, retired, as evidence.
  IF (SELECT count(*) FROM public.ca_money_rpc_registry
       WHERE proname IN ('fn_arena_deposit', 'fn_arena_withdraw') AND status = 'retired') <> 2 THEN
    RAISE EXCEPTION 'preimage: ca_money_rpc_registry does not hold both arena doors as retired';
  END IF;

  -- The table: nothing fires on it, nothing points at it, nobody publishes it.
  IF EXISTS (SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid = 'public.diamond_arena_events'::regclass AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'preimage: diamond_arena_events carries a trigger';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c
              WHERE c.contype = 'f' AND c.confrelid = 'public.diamond_arena_events'::regclass) THEN
    RAISE EXCEPTION 'preimage: a foreign key points at diamond_arena_events';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables
              WHERE schemaname = 'public' AND tablename = 'diamond_arena_events') THEN
    RAISE EXCEPTION 'preimage: diamond_arena_events is published';
  END IF;

  -- The column: nothing but its own grant hangs off it.
  SELECT string_agg(pg_describe_object(d.classid, d.objid, d.objsubid), ', ') INTO v_bad
    FROM pg_depend d
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
   WHERE d.refclassid = 'pg_class'::regclass
     AND d.refobjid = 'public.profiles'::regclass
     AND a.attname = 'diamond_arena_preferences';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'preimage: profiles.diamond_arena_preferences has dependents: %', v_bad;
  END IF;
END $pre$;

-- ---------------------------------------------------------------------------
-- 1. THE WALLET GUARD FORGETS THE TWO RETIRED DOORS, AND NOTHING ELSE
-- ---------------------------------------------------------------------------
DO $forget_the_doors$
DECLARE
  v_def text; v_want text; v_after text; v_hits integer;
  v_old CONSTANT text := $old$     OR v_stack ~ 'function (public[.])?fn_arena_deposit[(]'
     OR v_stack ~ 'function (public[.])?fn_arena_withdraw[(]'
$old$;
BEGIN
  v_def := pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure);
  IF md5(v_def) <> 'd40c547c47f3d0516dc24f22ab53da7e' THEN
    RAISE EXCEPTION 'fn_guard_profile_privileged_columns changed (md5 %); re-read it before editing it', md5(v_def);
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'the two retired-door lines were found % time(s), expected 1', v_hits;
  END IF;
  v_want := replace(v_def, v_old, '');
  IF md5(v_want) <> 'b140541b68ba8f97ce74d7e0a5e7680f' OR length(v_def) - length(v_want) <> length(v_old) THEN
    RAISE EXCEPTION 'the guard postimage is not the one this file was written for (md5 %)', md5(v_want);
  END IF;
  EXECUTE v_want;
  v_after := pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure);
  IF v_after IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION 'unrelated profile guard text changed (md5 %)', md5(v_after);
  END IF;
  IF position('fn_arena_' IN v_after) > 0
     OR position('function (public[.])?send_stream_gift[(]' IN v_after) = 0
     OR position('function (public[.])?fn_poker_diamond_tournament_charge[(]' IN v_after) = 0
     OR position('function (public[.])?send_wallet_diamond_transfer[(]' IN v_after) = 0
     OR position('function (public[.])?fn_poker_diamond_buyin[(]' IN v_after) = 0
     OR position('''profiles.% is server-managed and cannot be modified by role %''' IN v_after) = 0 THEN
    RAISE EXCEPTION 'the profile guard does not keep every other door and its refusal';
  END IF;
  IF has_function_privilege('anon', 'public.fn_guard_profile_privileged_columns()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_guard_profile_privileged_columns()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the profile guard became executable by anon or authenticated';
  END IF;
  IF NOT ('fn_guard_profile_privileged_columns' = ANY (public.fn_ca_guard_watchlist())) THEN
    RAISE EXCEPTION 'fn_guard_profile_privileged_columns left the guard watchlist; re-read fn_ca_guard_watchlist()';
  END IF;
  PERFORM public.fn_ca_declare_guard_redefinition('fn_guard_profile_privileged_columns',
    'migration 20261004214251_the_legacy_diamond_arena_database_objects_are_dropped');
END $forget_the_doors$;

-- ---------------------------------------------------------------------------
-- 2. THE TWO FUNCTIONS THAT NAME THE COLUMN STOP NAMING IT
-- ---------------------------------------------------------------------------
DO $stop_naming_the_column$
DECLARE
  r record;
  v_def text; v_want text; v_after text; v_hits integer; v_acl text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.update_page_preferences(uuid,text,jsonb)',
       'd98e1becf64a5c606d310b26b0a1e49c', '8cd27b35b801feb60a239bdf1c0c51cd',
       $o1$    'diamond_arcade_preferences','diamond_arena_preferences','poker_near_me_preferences') THEN$o1$,
       $n1$    'diamond_arcade_preferences','poker_near_me_preferences') THEN$n1$),
      ('public.fn_close_account(uuid)',
       '3e00cb1086da53eac75ba2d34001a75a', 'b563620364f47288038818f2f0e24ad9',
       $o2$    bankroll_preferences = '{}'::jsonb, diamond_arena_preferences = '{}'::jsonb,$o2$,
       $n2$    bankroll_preferences = '{}'::jsonb,$n2$)) AS x(sig, pre, post, old, new)
  LOOP
    v_def := pg_get_functiondef(to_regprocedure(r.sig));
    IF md5(v_def) <> r.pre THEN
      RAISE EXCEPTION '% changed (md5 %); re-read it before editing it', r.sig, md5(v_def);
    END IF;
    v_hits := (length(v_def) - length(replace(v_def, r.old, ''))) / length(r.old);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '%: the line naming the column was found % time(s), expected 1', r.sig, v_hits;
    END IF;
    v_want := replace(v_def, r.old, r.new);
    IF md5(v_want) <> r.post OR position('diamond_arena_preferences' IN v_want) > 0 THEN
      RAISE EXCEPTION '%: the postimage is not the one this file was written for (md5 %)', r.sig, md5(v_want);
    END IF;
    SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    EXECUTE v_want;
    v_after := pg_get_functiondef(to_regprocedure(r.sig));
    IF v_after IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION '%: unrelated text changed (md5 %)', r.sig, md5(v_after);
    END IF;
    IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig)) IS DISTINCT FROM v_acl THEN
      RAISE EXCEPTION '%: its grants moved', r.sig;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.update_page_preferences(uuid,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_close_account(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_close_account(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a redefined function became executable by a role that could not execute it';
  END IF;
END $stop_naming_the_column$;

-- ---------------------------------------------------------------------------
-- 3. EVERY WATCHED GUARD IS ON ITS BASELINE (read before the locks are taken)
-- ---------------------------------------------------------------------------
DO $baseline$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE w.fn = 'fn_guard_profile_privileged_columns'
     AND d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'the redefined guard is off its declared baseline: %', v_bad;
  END IF;
END $baseline$;

-- ---------------------------------------------------------------------------
-- 4. THE THREE LOCKS, TOGETHER OR NOT AT ALL
-- ---------------------------------------------------------------------------
DO $locks$
DECLARE v_tries int := 0;
BEGIN
  PERFORM set_config('lock_timeout', '250ms', true);
  LOOP
    BEGIN
      LOCK TABLE public.profiles, auth.users, public.diamond_arena_events IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      v_tries := v_tries + 1;
      IF v_tries >= 40 THEN
        RAISE EXCEPTION 'profiles, auth.users and diamond_arena_events could not be locked together in % tries (about 14 s); nothing was applied - apply once more when the platform is quieter, never in a loop', v_tries;
      END IF;
      PERFORM pg_sleep(0.1);
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', '2s', true);
  RAISE NOTICE 'legacy arena objects: three AccessExclusive locks taken together after % failed tries', v_tries;
END $locks$;

-- ---------------------------------------------------------------------------
-- 5. THE DATA IS EMPTY, READ UNDER THE LOCKS THAT KEEP IT EMPTY
-- ---------------------------------------------------------------------------
DO $empty$
DECLARE v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.diamond_arena_events;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'diamond_arena_events holds % row(s); it is dropped only when empty', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.profiles
   WHERE diamond_arena_preferences IS NOT NULL AND diamond_arena_preferences <> '{}'::jsonb;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'profiles.diamond_arena_preferences holds a value on % row(s); it is dropped only when every row is NULL or {}', v_n;
  END IF;
END $empty$;

-- ---------------------------------------------------------------------------
-- 6. THE DROPS (no CASCADE: an unread dependent aborts the file)
-- ---------------------------------------------------------------------------
REVOKE SELECT (diamond_arena_preferences) ON public.profiles FROM authenticated;
ALTER TABLE public.profiles DROP COLUMN diamond_arena_preferences;

DROP TABLE public.diamond_arena_events;

DROP FUNCTION public.fn_arena_deposit(integer, text);
DROP FUNCTION public.fn_arena_withdraw(integer, text);

-- ---------------------------------------------------------------------------
-- 7. THE ESTATE IS AS IT SHOULD BE
-- ---------------------------------------------------------------------------
DO $post$
BEGIN
  IF to_regprocedure('public.fn_arena_deposit(integer,text)') IS NOT NULL
     OR to_regprocedure('public.fn_arena_withdraw(integer,text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                   AND p.proname IN ('fn_arena_deposit', 'fn_arena_withdraw')) THEN
    RAISE EXCEPTION 'a retired arena door is still installed';
  END IF;
  IF to_regclass('public.diamond_arena_events') IS NOT NULL THEN
    RAISE EXCEPTION 'diamond_arena_events is still installed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = 'public.profiles'::regclass
                AND a.attname = 'diamond_arena_preferences' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'profiles.diamond_arena_preferences is still installed';
  END IF;
  IF (SELECT count(*) FROM public.ca_money_rpc_registry
       WHERE proname IN ('fn_arena_deposit', 'fn_arena_withdraw') AND status = 'retired') <> 2 THEN
    RAISE EXCEPTION 'the register lost a retired arena door row; they are kept as evidence';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open an arena switch';
  END IF;
  RAISE NOTICE 'the legacy Diamond Arena database objects are dropped: two doors, two guard lines, one table, one column; the register rows and every journal row are kept';
END $post$;

COMMIT;
