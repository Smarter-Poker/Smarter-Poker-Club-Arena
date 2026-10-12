-- ============================================================================
-- A DIAMOND CASH BUY-IN REACHES THE WALLET
-- ============================================================================
--
-- Phase 11 of the Diamond Arena programme, line 2: "Test transfer/store/game
-- concurrency, duplicate delivery and crash recovery". The suite that tests it
-- (tests/sql/run-diamond-concurrency.py) drives every Diamond money door from
-- real concurrent sessions against production's own function and table text,
-- captured md5-pinned. Its first client buy-in never reached a race: a
-- player's Diamond cash buy-in, called from the browser exactly as
-- src/services/CashBuyInRecovery.ts calls it (atomic_table_buyin under the
-- player's own JWT), is refused twice before it can move a Diamond.
--
--   1. fn_guard_profile_privileged_columns refuses the wallet write.
--      atomic_table_buyin -> fn_poker_diamond_buyin -> fn_poker_diamond_reserve
--      runs under the PLAYER'S JWT. The reserve journals the deposit and then
--      writes profiles.diamonds; the guard admits that write only from service
--      context or from a call stack naming a listed money door, and none of the
--      three is listed (the list still names fn_arena_deposit, the door the
--      custody reserve replaced). So every client buy-in answers "profiles.
--      diamonds is server-managed and cannot be modified by role postgres"
--      (42501) and rolls back. fn_ca_diamond_unreachable_money() cannot see it:
--      it looks for one function that is both granted to authenticated and
--      writes the wallet, and here the grant and the write are two functions
--      apart. The guard's own contract says what the fix is - name the route -
--      and 20260919223115 named the transfer door the same way. The route named
--      is fn_poker_diamond_buyin: executable by its owner alone, reached only
--      through atomic_table_buyin, which requires a live session and refuses a
--      purchase for another user, and whose one wallet write is the reserve's,
--      journaled before the balance moves. All three are pinned below, so the
--      guard admits only the route that was reviewed.
--
--   2. fn_poker_guard_arena_structure refuses the seat count.
--      With the wallet admitted, the buy-in's last write - the table's
--      current_players - is refused as "Diamond Games Require Platform
--      Operations". The guard lets a player's door move a Diamond table's
--      play-state counters by comparing the row without them, before and
--      after. public.tables carries four STORED GENERATED columns (min_buyin,
--      max_buyin, min_buy_in_bb, max_buy_in_bb), and inside a BEFORE trigger
--      PostgreSQL has not computed them yet: NEW holds NULL where OLD holds the
--      table's values, so the comparison sees a structural change nobody made.
--      A generated column cannot be written; it follows the base columns the
--      comparison already holds fixed. So the generated columns leave the
--      comparison, read from the catalogue by TG_RELID - which also covers one
--      added later. A player's tournament entry was never affected: tournaments
--      has no generated column.
--
-- Neither refusal shows while cash_games_enabled is false, which is why
-- production has never met them, and the isolated cash runners carry neither
-- guard. Both functions are on fn_ca_guard_watchlist(); each redefinition is
-- declared. Grants, owner, security and search_path are untouched: each is
-- re-created from its own pg_get_functiondef. Nothing is opened, nothing is
-- priced.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_guard_profile_privileged_columns   5ec21958ce25b6a88a0f370b4050b542
--   fn_poker_guard_arena_structure        f17675dd0b647abda7b0b9d8772c9c0e
--   fn_poker_diamond_buyin                2f76148f74df8766a958cdd403582e24  (read, not changed)
--   atomic_table_buyin                    2f8b47a714db3f297aff3f7a2e814c44  (read, not changed)
--   fn_poker_diamond_reserve              cf2150429728d8d796711e9bdbb22f51  (read, not changed)
--
-- The migration creates no object, so it declares its own proof of being live:
-- @live-proof: position('function (public[.])?fn_poker_diamond_buyin[(]' in pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure)) > 0
-- @live-proof: position('a.attrelid = TG_RELID AND a.attgenerated' in pg_get_functiondef('public.fn_poker_guard_arena_structure()'::regprocedure)) > 0
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. THE PROFILE GUARD NAMES THE DIAMOND CASH BUY-IN
-- ---------------------------------------------------------------------------
DO $name_the_buy_in$
DECLARE
  v_def text; v_after text; v_route text; v_hits integer;
  v_old CONSTANT text := $old$     OR v_stack ~ 'function (public[.])?send_wallet_diamond_transfer[(]'$old$;
  v_new CONSTANT text := $new$     OR v_stack ~ 'function (public[.])?send_wallet_diamond_transfer[(]'
     -- DIAMOND PHASE 11: a player's Diamond cash buy-in. atomic_table_buyin runs under the
     -- player's JWT and reaches the wallet only through fn_poker_diamond_buyin, whose one
     -- wallet write is fn_poker_diamond_reserve's journaled deposit; unnamed here, every
     -- client buy-in answered 42501 at that write.
     OR v_stack ~ 'function (public[.])?fn_poker_diamond_buyin[(]'$new$;
BEGIN
  -- The route the guard is about to admit is the one that was reviewed.
  v_route := pg_get_functiondef('public.fn_poker_diamond_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure);
  IF md5(v_route) <> '2f76148f74df8766a958cdd403582e24'
     OR position('public.fn_poker_diamond_reserve(p_user_id,''cash_seat'',p_table_id,' IN v_route) = 0
     OR has_function_privilege('authenticated', 'public.fn_poker_diamond_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_poker_diamond_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_poker_diamond_buyin changed or became client-executable; review it before the guard admits it';
  END IF;
  v_route := pg_get_functiondef('public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure);
  IF md5(v_route) <> '2f8b47a714db3f297aff3f7a2e814c44'
     OR position('public.fn_caller_session_is_live()' IN v_route) = 0
     OR position('Cannot buy in for another user' IN v_route) = 0
     OR position('PERFORM public.fn_poker_diamond_buyin(' IN v_route) = 0
     OR has_function_privilege('anon', 'public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'atomic_table_buyin changed or its grants moved; review it before the guard admits its Diamond route';
  END IF;
  v_route := pg_get_functiondef('public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)'::regprocedure);
  IF md5(v_route) <> 'cf2150429728d8d796711e9bdbb22f51'
     OR position('INSERT INTO public.diamond_transactions(' IN v_route) = 0
     OR position('INSERT INTO public.diamond_transactions(' IN v_route)
        > position('UPDATE public.profiles SET diamonds=diamonds-p_amount::integer' IN v_route)
     OR has_function_privilege('authenticated', 'public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_poker_diamond_reserve changed, stopped journaling first, or became client-executable';
  END IF;

  v_def := pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure);
  IF md5(v_def) <> '5ec21958ce25b6a88a0f370b4050b542' THEN
    RAISE EXCEPTION 'fn_guard_profile_privileged_columns changed (md5 %); re-read it before extending it', md5(v_def);
  END IF;
  IF position('fn_poker_diamond_buyin' IN v_def) > 0 THEN
    RAISE EXCEPTION 'the guard already names fn_poker_diamond_buyin';
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'guard marker found % time(s), expected 1', v_hits;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure);
  IF md5(replace(v_after, v_new, v_old)) <> '5ec21958ce25b6a88a0f370b4050b542' THEN
    RAISE EXCEPTION 'unrelated profile guard text changed';
  END IF;
  IF has_function_privilege('anon', 'public.fn_guard_profile_privileged_columns()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_guard_profile_privileged_columns()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the profile guard became executable by anon or authenticated';
  END IF;
  PERFORM public.fn_ca_declare_guard_redefinition('fn_guard_profile_privileged_columns',
    'migration 20260930121500_a_diamond_cash_buy_in_reaches_the_wallet');
END $name_the_buy_in$;

-- ---------------------------------------------------------------------------
-- 2. THE ARENA GUARD LEAVES GENERATED COLUMNS OUT OF ITS COMPARISON
-- ---------------------------------------------------------------------------
DO $generated_columns$
DECLARE
  v_def text; v_after text; v_hits integer;
  v_old CONSTANT text := $old$                AND (to_jsonb(NEW) - public.fn_poker_diamond_play_state_columns(TG_TABLE_NAME))
                  = (to_jsonb(OLD) - public.fn_poker_diamond_play_state_columns(TG_TABLE_NAME))) THEN$old$;
  v_new CONSTANT text := $new$                -- DIAMOND PHASE 11: a stored generated column is NULL in NEW before
                -- the row is written, and follows the base columns compared here; it
                -- is left out, or a player's buy-in reads as a structural change.
                AND (to_jsonb(NEW) - public.fn_poker_diamond_play_state_columns(TG_TABLE_NAME)
                       - ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a
                                WHERE a.attrelid = TG_RELID AND a.attgenerated <> '' AND NOT a.attisdropped))
                  = (to_jsonb(OLD) - public.fn_poker_diamond_play_state_columns(TG_TABLE_NAME)
                       - ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a
                                WHERE a.attrelid = TG_RELID AND a.attgenerated <> '' AND NOT a.attisdropped))) THEN$new$;
BEGIN
  v_def := pg_get_functiondef('public.fn_poker_guard_arena_structure()'::regprocedure);
  IF md5(v_def) <> 'f17675dd0b647abda7b0b9d8772c9c0e' THEN
    RAISE EXCEPTION 'fn_poker_guard_arena_structure changed (md5 %); re-read it before editing it', md5(v_def);
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'play-state comparison found % time(s), expected 1', v_hits;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef('public.fn_poker_guard_arena_structure()'::regprocedure);
  IF md5(replace(v_after, v_new, v_old)) <> 'f17675dd0b647abda7b0b9d8772c9c0e' THEN
    RAISE EXCEPTION 'unrelated arena guard text changed';
  END IF;
  IF has_function_privilege('anon', 'public.fn_poker_guard_arena_structure()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_poker_guard_arena_structure()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the arena guard became executable by anon or authenticated';
  END IF;
  PERFORM public.fn_ca_declare_guard_redefinition('fn_poker_guard_arena_structure',
    'migration 20260930121500_a_diamond_cash_buy_in_reaches_the_wallet');
END $generated_columns$;

-- ---------------------------------------------------------------------------
-- 3. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_def text; v_bad text;
BEGIN
  v_def := pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure);
  IF position('function (public[.])?fn_poker_diamond_buyin[(]' IN v_def) = 0
     OR position('function (public[.])?send_wallet_diamond_transfer[(]' IN v_def) = 0
     OR position('''profiles.% is server-managed and cannot be modified by role %''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the profile guard does not name the buy-in route and still refuse every other write';
  END IF;
  v_def := pg_get_functiondef('public.fn_poker_guard_arena_structure()'::regprocedure);
  IF (length(v_def) - length(replace(v_def, 'a.attrelid = TG_RELID AND a.attgenerated <> ''''', '')))
     / length('a.attrelid = TG_RELID AND a.attgenerated <> ''''') <> 2
     OR position('Diamond Games Require Platform Operations' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the arena guard does not leave generated columns out of both sides and still refuse structure';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open an arena switch';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'a Diamond cash buy-in reaches the wallet: the profile guard names the buy-in route, the arena guard ignores generated columns, nothing opened';
END $m$;

COMMIT;
