-- ============================================================================
-- A DIAMOND TOP-UP TAKES THE TABLE BEFORE THE WALLET
-- ============================================================================
--
-- Diamond Phase 11 line 5: "Measure lobby fan-out, action latency, event-loop
-- load, database locks and reconnect storms."
--
-- Every Diamond cash door that moves a seated player's money locks the TABLE
-- row and then the WALLET (the player's profiles row): the hand settler
-- (fn_poker_diamond_settle_cash_hand takes the table FOR UPDATE, then every
-- player's wallet), the buy-in (fn_poker_diamond_buyin takes the table, then
-- fn_poker_diamond_reserve takes the wallet) and the cash-out
-- (fn_poker_diamond_cashout: the table, then the wallet). The top-up took them
-- the other way round - the wallet, then the table - under a comment that said
-- it matched the settler. It did not, and two sessions that take the same two
-- rows in opposite orders deadlock.
--
-- Measured on an isolated PostgreSQL 17 cluster with the live doors laid over
-- the tests/sql fixture (scripts/qualification/diamond-lock-waits.py; numbers,
-- commands and environment in docs/evidence/diamond-phase-11/
-- operating-envelope.md): hands settling at 64 and 96 tables while the players
-- seated at them top up deadlocked, and with the table taken first they did
-- not. In production the window is the second or so after a hand ends while
-- its settlement is still committing; the engine now queues a top-up asked for
-- in that window as it does one asked for mid hand (ServerTableEngineSeating),
-- and this makes the door itself safe whoever calls it and whenever.
--
-- The change is one lock, taken earlier: PERFORM 1 FROM public.tables WHERE
-- id=p_table_id FOR UPDATE, before the wallet. Bare, so every refusal and
-- every replay below it answers exactly as it did; the validating SELECT ...
-- FOR UPDATE OF t further down re-takes a lock the transaction already holds.
-- Only the order changes. No switch is touched (cash_games_enabled and
-- tournaments_enabled stay false), no Diamond moves, the signature and grants
-- are unchanged. An asserted substitution over the pinned live text: the
-- clause occurs once, the new text is the one the harness measured (its md5 is
-- asserted), the reverse substitution reproduces the pinned md5, and the door
-- is declared to the guard watch.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-09-30:
--   fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid)  fe1cf0ce225ef0977ceef3dd8bfb4598
-- AFTER (the text scripts/qualification/diamond-lock-waits.py measured):
--   fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid)  f7659bddc424e9e4b6785228ee0eec6a
--
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = 'f7659bddc424e9e4b6785228ee0eec6a' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_poker_diamond_top_up')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $m$
DECLARE
  v_def text; v_old text; v_new text; v_n integer; v_after text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'an arena switch is open; this migration expects both closed';
  END IF;
  v_def := pg_get_functiondef('public.fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid)'::regprocedure);
  IF md5(v_def) <> 'fe1cf0ce225ef0977ceef3dd8bfb4598' THEN
    RAISE EXCEPTION 'fn_poker_diamond_top_up is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E' PERFORM pg_advisory_xact_lock(hashtextextended(''table_seat:''||p_table_id,0));\n'
        || E' -- Wallet first, exactly as the reserve and the hand settler take it.\n'
        || E' SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR UPDATE;\n';
  v_new := E' PERFORM pg_advisory_xact_lock(hashtextextended(''table_seat:''||p_table_id,0));\n'
        || E' -- The table row before the wallet. The hand settler, the buy-in and the cash-out\n'
        || E' -- all take this table and then the wallet; a top-up that took the wallet first\n'
        || E' -- deadlocked against the settlement of the hand it followed (Diamond Phase 11\n'
        || E' -- line 5, measured). Locked bare, so every refusal and replay below answers as\n'
        || E' -- it did: only the order in which the locks are taken changes.\n'
        || E' PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;\n'
        || E' -- Then the wallet, before its custody and lots, as the reserve and the settler take it.\n'
        || E' SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR UPDATE;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the wallet-first clause occurs % times in fn_poker_diamond_top_up, expected exactly 1', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef('public.fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid)'::regprocedure);
  IF md5(v_after) <> 'f7659bddc424e9e4b6785228ee0eec6a' THEN
    RAISE EXCEPTION 'fn_poker_diamond_top_up is not the text the harness measured (md5 %)', md5(v_after);
  END IF;
  IF md5(replace(v_after, v_new, v_old)) <> 'fe1cf0ce225ef0977ceef3dd8bfb4598' THEN
    RAISE EXCEPTION 'fn_poker_diamond_top_up: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_top_up', 'migration a_diamond_top_up_takes_the_table_before_the_wallet');

-- ---------------------------------------------------------------------------
-- THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_txt text; v_bad text;
BEGIN
  v_txt := pg_get_functiondef('public.fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid)'::regprocedure);
  IF position('PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;' IN v_txt) = 0
     OR position('PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;' IN v_txt)
        > position('SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR UPDATE;' IN v_txt)
     OR position('SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR UPDATE;' IN v_txt)
        > position('FOR UPDATE OF t;' IN v_txt) THEN
    RAISE EXCEPTION 'the top-up does not take the table, then the wallet, then validate the table';
  END IF;
  IF has_function_privilege('anon', 'public.fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the top-up door is reachable by a client, or no longer by the engine';
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
  RAISE NOTICE 'a Diamond top-up takes the table before the wallet: one lock earlier, nothing else changed, nothing opened';
END $m$;

COMMIT;
