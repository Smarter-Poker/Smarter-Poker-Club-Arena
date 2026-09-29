-- 20260924034010_kill_pot_table_settings.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
-- It sorts after 20260924025555_one_capability_registry_and_accepted_event_
-- continuation on purpose: this migration asks public.fn_capability_available
-- and refuses to install without it.
--
/*
 * ===========================================================================
 *  KILL POT TABLE SETTINGS: THE DATABASE REFUSES WHAT THE ENGINE CANNOT HONOUR
 *  2026-09-24 (rule manifest kill-v1, integration-owner decisions 2026-09-22)
 * ===========================================================================
 *
 * WHAT THIS ADDS.
 *
 *   1. tables.kill_mode ('off' | 'half' | 'full', default 'off') and
 *      tables.kill_threshold_bb (8 | 10 | 12 | 15, default 10), and
 *      hand_history.kill_pot jsonb NULL, where the engine records the kill a
 *      hand played, the kill it scheduled and a kill it cancelled.
 *
 *   2. zz_tables_kill_pot_guard, a BEFORE INSERT OR UPDATE trigger on tables
 *      that refuses (SQLSTATE 22023) a kill configuration the engine cannot
 *      honour. It never fires on a row whose kill_mode is 'off' (a WHEN
 *      clause), so every existing row and every write that leaves kill off is
 *      untouched and pays nothing. When kill is on it refuses:
 *        - a tournament table (tournament_id set, or game_type 'tournament',
 *          the engine's own isTournamentTable test);
 *        - any variant but flh or flo8 (FIXED_LIMIT_VARIANTS in
 *          server/src/engine/BettingStructure.ts; kill-v1 scope);
 *        - bomb_pot_enabled = true (the one bomb switch: BombPotScheduler
 *          gates every trigger mode on it, and the manual bomb request is
 *          consulted only when it is on);
 *        - a big blind that is not a whole number of minor units, or, for
 *          half kill, one whose minor units are odd (kill-v1 exactness rule).
 *          Minor units are cents for chips and whole Diamonds for the Diamond
 *          arena, identified by its club id - the same literal the Gate 7
 *          constraint tables_cash_needs_a_game carries and src/lib/constants.ts
 *          pins as DIAMOND_ARENA_CLUB_ID. clubs has a unique index on
 *          (asset) WHERE asset = 'diamonds' (poker_arena_one_diamond_identity),
 *          so there is exactly one Diamond club, and the precondition below
 *          refuses to install if it is not this id.
 *      and, when the kill configuration itself is being SET (an INSERT, or an
 *      UPDATE that changes kill_mode or kill_threshold_bb), it refuses while
 *      public.fn_capability_available('cash.fixed_limit.kill_pots') is false.
 *      A write that leaves the kill configuration alone (the cluster tick
 *      re-applying blinds, a status write) is not re-asked about readiness:
 *      readiness gates turning Kill on, and the structural rules above are
 *      what the engine needs on every row.
 *      The trigger function is SECURITY INVOKER. It reads only NEW (and OLD)
 *      and calls two functions: fn_kill_pot_configuration_refusal, a pure
 *      IMMUTABLE function of its arguments, and fn_capability_available, which
 *      is itself SECURITY DEFINER and granted to authenticated and
 *      service_role, the two roles that write tables.
 *
 *   3. fn_set_cash_game_kill_settings(game, mode, threshold): how an owner
 *      turns Kill on. See THE OWNER PATH below.
 *
 * THE OWNER PATH, AND WHY IT IS THE CLUSTER RULESET AND NOT A TABLE RPC.
 *
 *   Every open chip cash table belongs to a cash game: the Gate 7 constraint
 *   tables_cash_needs_a_game refuses an open cash table without a
 *   tournament_id or a cluster_id (the Diamond arena is the only exemption).
 *   A game's tables are written by exactly two functions, both reading
 *   cash_games.ruleset_snapshot: fn_cash_cluster_open_table INSERTs every new
 *   table with an explicit column list, and fn_cash_apply_ruleset ("the one
 *   function allowed to map a snapshot onto a cluster", 20260905033729) runs
 *   on every cluster tick and rewrites every drifted column. So a per-table
 *   setting written the way fn_update_table_bomb_settings writes one
 *   (20260829161712) would be LOST: the next table the cluster opens takes the
 *   column default 'off', and a must-move game then moves players between
 *   tables playing two rulebooks - the exact drift 20260909181230 measured for
 *   run-it-twice (four tables of one game offering it and the fifth not).
 *
 *   So the setting lives in the game's snapshot as {"kill":{"mode","threshold_bb"}}
 *   and both writers project it, and the owner door writes the snapshot and
 *   then applies it through fn_cash_apply_ruleset itself (never a hand-written
 *   UPDATE on tables). The door is an audited SECURITY DEFINER RPC:
 *     - it asks who is calling (auth.uid(), fn_caller_session_is_live) and
 *       authorizes with fn_can_create_games(game club, caller), the
 *       union-aware authority the cash-game creator (20260906091511) and the
 *       managed-game update door use. fn_update_table_bomb_settings has no
 *       helper of its own - it inlines clubs.owner_id OR club_members.role IN
 *       (owner, co_owner, admin), which is not union-aware, and 20260906091511
 *       closed exactly that bypass for game management;
 *     - it validates with the same refusal function the trigger uses, so the
 *       owner is told the precise reason before anything is written;
 *     - it writes one table_settings_changes row per table whose kill columns
 *       changed (the bomb settings audit trail, same before/after shape) and
 *       one cash_cluster_events row 'kill_settings_changed' for the game.
 *   'off' is always accepted, whatever the capability says.
 *
 *   The projection gives 'off' whenever the snapshot's kill would be refused
 *   by the trigger - a bomb template, a non-fixed-limit game, an odd big blind
 *   for half kill, or the capability no longer available. Both writers run on
 *   the cluster's hot path (the tick every few seconds; a player waiting on a
 *   new table), and a projection the trigger refuses would stop the game
 *   rather than the kill. The owner door refuses the same inputs up front, so
 *   this only arises if the game changes under a kill setting (its template is
 *   rewritten, or the capability is demoted), and 'off' is the direction the
 *   engine can always honour.
 *
 * TEXT PATCHES OF TWO PINNED FUNCTIONS. fn_cash_cluster_open_table and
 * fn_cash_apply_ruleset are extended by anchored literal replacement, the
 * shape 20260909191454, 20260921025523 and 20260921044045 use for the same two
 * bodies, and each is pinned first by md5(prosrc). The pinned values were
 * computed from the NEWEST REPOSITORY DEFINITIONS (20260905050000 as patched by
 * 20260909191454, 20260921025523 and 20260921044045; 20260909181230 as patched
 * by 20260909191454), rebuilt on an isolated PostgreSQL 16. Production was not
 * read. The owner must confirm before installing that
 *   SELECT md5(prosrc) FROM pg_proc
 *    WHERE oid = 'public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure;
 * returns d0a29f6532f92bce3e22d92269c030ce and that the same query for
 * 'public.fn_cash_apply_ruleset(uuid)' returns 955b66471351f80e5e7a7385aed5f527.
 * If either differs this migration refuses (55000) and changes nothing.
 *
 * THE MANAGED GAME CONTRACT AND THE CLONER, READ AND NOT CHANGED.
 *   fn_managed_game_contract_document('table', row) is the whole row MINUS an
 *   explicit list of runtime-state keys. kill_mode and kill_threshold_bb are
 *   configuration, so they are deliberately NOT added to that list: they are
 *   part of every table's published contract from now on. The consequence is
 *   stated rather than hidden: the first write to each table after this
 *   installs captures one new contract revision, because the document gained
 *   two keys - the same thing every earlier configuration column did.
 *   fn_clone_table_row copies every non-generated column except identity and
 *   live state, so a clone carries its source's kill configuration, and this
 *   trigger checks it on the clone's INSERT. Neither function is touched.
 *
 * HOT TABLES. tables is published to realtime; hand_history is ~3.6 GB.
 *   - Three ADD COLUMNs, each nullable or NOT NULL with a constant DEFAULT:
 *     metadata only since PostgreSQL 11 (attmissingval), no rewrite. The
 *     isolated harness asserts relfilenode is unchanged and that neither
 *     table was scanned (pg_stat_user_tables.seq_scan) by the install.
 *   - The three CHECKs are added NOT VALID, so adding them scans nothing.
 *     Every row inserted or updated from now on is checked. Existing rows hold
 *     the constant defaults, which satisfy all three by construction.
 *     VALIDATE CONSTRAINT can be run later, each in its own transaction: it
 *     takes SHARE UPDATE EXCLUSIVE and does not block readers or writers.
 *   - No index is built. The ALTERs and the trigger come last, so the
 *     ACCESS EXCLUSIVE locks are held only for the catalogue writes and the
 *     post-image checks, which read the catalogue and never a row.
 *
 * WHAT THIS DOES NOT DO.
 *   - It adds no Diamond owner door. Diamond tables are a staff ladder with
 *     their own doors (fn_poker_diamond_set_table_*); the trigger already
 *     judges a Diamond row by whole Diamonds, and a staff door is a follow-up.
 *   - It does not change fn_update_table_bomb_settings: turning bombs on at a
 *     kill table is refused by the trigger with the precise message.
 *   - No money moves. No existing row is rewritten.
 *
 * ROLLBACK (one transaction):
 *   DROP TRIGGER zz_tables_kill_pot_guard ON public.tables;
 *   re-run the two anchored replacements in reverse (each quotes its before
 *   and after below), DROP FUNCTION fn_set_cash_game_kill_settings(uuid,text,integer),
 *   fn_tables_kill_pot_guard(), fn_kill_pot_configuration_refusal(text,text,text,uuid,boolean,numeric,uuid);
 *   the three columns may stay (they are inert once the engine ignores them).
 */
--
-- HOW A READER SEES THIS IS LIVE. The objects are found by name by
-- scripts/ci/check-migrations-are-live.mjs; the lines below prove the columns,
-- the trigger, the two projections and the grants, read-only.
-- @live-proof: (SELECT count(*) = 3 FROM pg_attribute a WHERE NOT a.attisdropped AND ((a.attrelid = 'public.tables'::regclass AND a.attname IN ('kill_mode','kill_threshold_bb') AND a.attnotnull) OR (a.attrelid = 'public.hand_history'::regclass AND a.attname = 'kill_pot' AND NOT a.attnotnull)))
-- @live-proof: (SELECT count(*) = 3 FROM pg_constraint c WHERE c.conname IN ('tables_kill_mode_check','tables_kill_threshold_bb_check','hand_history_kill_pot_is_object') AND c.contype = 'c')
-- @live-proof: (SELECT count(*) = 1 FROM pg_trigger t WHERE t.tgrelid = 'public.tables'::regclass AND t.tgname = 'zz_tables_kill_pot_guard' AND NOT t.tgisinternal AND t.tgenabled = 'O')
-- @live-proof: (SELECT position('v_kill_mode, v_kill_bb' in pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure)) > 0 AND position('kill_mode = v_kill_mode' in pg_get_functiondef('public.fn_cash_apply_ruleset(uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT has_function_privilege('authenticated','public.fn_set_cash_game_kill_settings(uuid,text,integer)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_set_cash_game_kill_settings(uuid,text,integer)','EXECUTE') AND to_regprocedure('public.fn_kill_pot_configuration_refusal(text,text,text,uuid,boolean,numeric,uuid)') IS NOT NULL)
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS. Everything this migration reasons from is what it was
--    written against, or it stops before writing anything.
-- ---------------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regprocedure('public.fn_capability_available(text)') IS NULL THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_NEED_THE_CAPABILITY_REGISTRY: install 20260924025555 first'
      USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.fn_can_create_games(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_caller_session_is_live()') IS NULL THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_AUTHORITY_MISSING' USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.table_settings_changes') IS NULL
     OR to_regclass('public.cash_cluster_events') IS NULL
     OR to_regclass('public.cash_games') IS NULL THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_AUDIT_TABLES_MISSING' USING ERRCODE = '55000';
  END IF;

  -- The columns the trigger and the projections read, with the types they
  -- were written against. Type names are compared without typmod: production
  -- declares tables.big_blind numeric(15,2) (refused on first install, 2026-09-24).
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid = 'public.tables'::regclass AND NOT a.attisdropped
         AND (a.attname, format_type(a.atttypid, NULL)) IN
             (('club_id','uuid'),('game_variant','text'),('game_type','text'),
              ('tournament_id','uuid'),('bomb_pot_enabled','boolean'),
              ('big_blind','numeric'),('cluster_id','uuid'))) <> 7 THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_TABLE_COLUMNS_CHANGED' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute a
              WHERE NOT a.attisdropped
                AND ((a.attrelid = 'public.tables'::regclass AND a.attname IN ('kill_mode','kill_threshold_bb'))
                  OR (a.attrelid = 'public.hand_history'::regclass AND a.attname = 'kill_pot'))) THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_ALREADY_INSTALLED' USING ERRCODE = '42701';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid = 'public.tables'::regclass AND t.tgname = 'zz_tables_kill_pot_guard') THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_TRIGGER_NAME_TAKEN' USING ERRCODE = '42710';
  END IF;

  -- The one Diamond club is the id the refusal function names.
  IF EXISTS (SELECT 1 FROM public.clubs c
              WHERE c.asset = 'diamonds'
                AND c.id <> '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid) THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_DIAMOND_ARENA_ID_CHANGED' USING ERRCODE = '55000';
  END IF;

  -- The two bodies this migration edits, pinned by source. See the header:
  -- pinned against the newest repository definitions, to be confirmed live.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = to_regprocedure('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)')
       AND md5(prosrc) = 'd0a29f6532f92bce3e22d92269c030ce'
       AND prosecdef
  ) THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_OPENER_PREIMAGE_CHANGED' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = to_regprocedure('public.fn_cash_apply_ruleset(uuid)')
       AND md5(prosrc) = '955b66471351f80e5e7a7385aed5f527'
       AND prosecdef
  ) THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_RULESET_PREIMAGE_CHANGED' USING ERRCODE = '55000';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE RULE, ONCE. A pure function of the row's own values: NULL when the
--    engine can honour the kill configuration (or kill is off), otherwise the
--    Title Case reason. The trigger, the owner door and both projections ask
--    this one function, so they cannot disagree.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_kill_pot_configuration_refusal(
  p_kill_mode text,
  p_variant text,
  p_game_type text,
  p_tournament_id uuid,
  p_bomb_pot_enabled boolean,
  p_big_blind numeric,
  p_club_id uuid)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_diamond boolean := p_club_id IS NOT DISTINCT FROM '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid;
  v_minor numeric;
BEGIN
  IF p_kill_mode IS NULL OR p_kill_mode NOT IN ('off','half','full') THEN
    RETURN 'Kill Mode Must Be Off, Half Or Full';
  END IF;
  IF p_kill_mode = 'off' THEN
    RETURN NULL;
  END IF;
  IF p_tournament_id IS NOT NULL OR lower(coalesce(p_game_type, '')) = 'tournament' THEN
    RETURN 'Kill Pots Are Only Available At Cash Tables';
  END IF;
  IF lower(coalesce(p_variant, '')) NOT IN ('flh','flo8') THEN
    RETURN 'Kill Pots Need Fixed Limit Hold''em Or Fixed Limit Omaha Hi-Lo';
  END IF;
  IF coalesce(p_bomb_pot_enabled, false) THEN
    RETURN 'Kill Pots Cannot Be Combined With Bomb Pots';
  END IF;
  -- kill-v1 exactness: the base big blind in minor units (cents, or whole
  -- Diamonds) times the multiplier must be an integer. Full is 2/1, half 3/2.
  v_minor := p_big_blind * CASE WHEN v_diamond THEN 1 ELSE 100 END;
  IF v_minor IS NULL OR v_minor <= 0 OR v_minor <> trunc(v_minor) THEN
    RETURN CASE WHEN v_diamond THEN 'Kill Pots Need A Big Blind Of Whole Diamonds'
                ELSE 'Kill Pots Need A Big Blind Of Whole Cents' END;
  END IF;
  IF p_kill_mode = 'half' AND mod(v_minor, 2) <> 0 THEN
    RETURN CASE WHEN v_diamond THEN 'Half Kill Needs An Even Number Of Diamonds As The Big Blind'
                ELSE 'Half Kill Needs A Big Blind That Is An Even Number Of Cents' END;
  END IF;
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.fn_kill_pot_configuration_refusal(text,text,text,uuid,boolean,numeric,uuid) IS
  'kill-v1. NULL when the engine can honour this kill configuration (or kill is off), otherwise the Title Case reason it cannot: cash tables only, flh or flo8 only, never with bomb pots, and the base big blind a whole number of minor units (cents; whole Diamonds at the Diamond arena) that is even for half kill. Pure: reads only its arguments. 20260924034010.';

-- ---------------------------------------------------------------------------
-- 2. THE TRIGGER FUNCTION. SECURITY INVOKER: it reads NEW and OLD only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_tables_kill_pot_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_refusal text;
BEGIN
  -- The WHEN clause already skips 'off'; this keeps the function honest if it
  -- is ever attached without one. A mode outside the vocabulary is left to
  -- tables_kill_mode_check, which refuses it (23514) after this trigger.
  IF NEW.kill_mode IS NULL OR NEW.kill_mode NOT IN ('half','full') THEN
    RETURN NEW;
  END IF;

  -- Readiness gates SETTING the kill configuration, not every later write to
  -- a row that already carries one.
  IF (TG_OP = 'INSERT'
      OR NEW.kill_mode IS DISTINCT FROM OLD.kill_mode
      OR NEW.kill_threshold_bb IS DISTINCT FROM OLD.kill_threshold_bb)
     AND NOT public.fn_capability_available('cash.fixed_limit.kill_pots') THEN
    RAISE EXCEPTION 'Kill Pots Are Not Available Yet'
      USING ERRCODE = '22023',
            DETAIL = 'capability cash.fixed_limit.kill_pots is not deployed';
  END IF;

  v_refusal := public.fn_kill_pot_configuration_refusal(
    NEW.kill_mode, NEW.game_variant, NEW.game_type, NEW.tournament_id,
    NEW.bomb_pot_enabled, NEW.big_blind, NEW.club_id);
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION '%', v_refusal
      USING ERRCODE = '22023',
            DETAIL = format('table %s kill_mode %s', NEW.id, NEW.kill_mode);
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.fn_tables_kill_pot_guard() IS
  'BEFORE INSERT OR UPDATE on public.tables, only while kill_mode is not off. Refuses (22023) a kill configuration the engine cannot honour (fn_kill_pot_configuration_refusal), and refuses setting one while capability cash.fixed_limit.kill_pots is not available. Reads only NEW/OLD. 20260924034010.';

-- ---------------------------------------------------------------------------
-- 3. THE CLUSTER OPENER CARRIES THE GAME'S KILL SETTING.
--    Before (column list):  ... cluster_id, role, main_index, lifecycle, opened_at, live_at
--    After:                 ... the same, then kill_mode, kill_threshold_bb
-- ---------------------------------------------------------------------------
DO $opener$
DECLARE
  v_src text; v_hits integer;
  v_decl_old CONSTANT text :=
    '  v_min_bb integer; v_max_bb integer; v_name text; v_table_id uuid; v_n integer;' || E'\n' || 'BEGIN';
  v_decl_new CONSTANT text :=
    '  v_min_bb integer; v_max_bb integer; v_name text; v_table_id uuid; v_n integer;' || E'\n' ||
    '  v_kill_mode text; v_kill_bb smallint;' || E'\n' || 'BEGIN';
  v_calc_old CONSTANT text :=
    '  v_max_bb := coalesce((s->>''max_buyin_bb'')::integer, 200);' || E'\n';
  v_calc_new CONSTANT text :=
    '  v_max_bb := coalesce((s->>''max_buyin_bb'')::integer, 200);' || E'\n' ||
    '  -- KILL POTS (kill-v1, 20260924034010). The game''s snapshot carries' || E'\n' ||
    '  -- {"kill":{"mode","threshold_bb"}}; fn_cash_apply_ruleset projects the' || E'\n' ||
    '  -- same two values identically. ''off'' whenever the kill would be refused' || E'\n' ||
    '  -- at this table, so opening a table never fails on a kill setting.' || E'\n' ||
    '  v_kill_bb := CASE WHEN (s->''kill''->>''threshold_bb'') IN (''8'',''10'',''12'',''15'')' || E'\n' ||
    '                    THEN (s->''kill''->>''threshold_bb'')::smallint ELSE 10 END;' || E'\n' ||
    '  v_kill_mode := lower(coalesce(s->''kill''->>''mode'', ''off''));' || E'\n' ||
    '  IF v_kill_mode NOT IN (''half'', ''full'') THEN' || E'\n' ||
    '    v_kill_mode := ''off'';' || E'\n' ||
    '  ELSIF public.fn_kill_pot_configuration_refusal(v_kill_mode, g.variant, ''cash'', NULL, v_bomb_on, g.bb, g.club_id) IS NOT NULL THEN' || E'\n' ||
    '    v_kill_mode := ''off'';' || E'\n' ||
    '  ELSIF NOT public.fn_capability_available(''cash.fixed_limit.kill_pots'') THEN' || E'\n' ||
    '    v_kill_mode := ''off'';' || E'\n' ||
    '  END IF;' || E'\n';
  v_cols_old CONSTANT text :=
    '    cluster_id, role, main_index, lifecycle, opened_at, live_at' || E'\n' || '  ) VALUES (';
  v_cols_new CONSTANT text :=
    '    cluster_id, role, main_index, lifecycle, opened_at, live_at,' || E'\n' ||
    '    kill_mode, kill_threshold_bb' || E'\n' || '  ) VALUES (';
  v_vals_old CONSTANT text :=
    '    clock_timestamp(), CASE WHEN p_lifecycle = ''live'' THEN clock_timestamp() END' || E'\n' ||
    '  ) RETURNING id INTO v_table_id;';
  v_vals_new CONSTANT text :=
    '    clock_timestamp(), CASE WHEN p_lifecycle = ''live'' THEN clock_timestamp() END,' || E'\n' ||
    '    v_kill_mode, v_kill_bb' || E'\n' ||
    '  ) RETURNING id INTO v_table_id;';
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure);
  FOREACH v_hits IN ARRAY ARRAY[
      (length(v_src) - length(replace(v_src, v_decl_old, ''))) / length(v_decl_old),
      (length(v_src) - length(replace(v_src, v_calc_old, ''))) / length(v_calc_old),
      (length(v_src) - length(replace(v_src, v_cols_old, ''))) / length(v_cols_old),
      (length(v_src) - length(replace(v_src, v_vals_old, ''))) / length(v_vals_old)] LOOP
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'KILL_POT_SETTINGS_OPENER_ANCHOR_MATCHED_% times', v_hits USING ERRCODE = '55000';
    END IF;
  END LOOP;
  v_src := replace(v_src, v_decl_old, v_decl_new);
  v_src := replace(v_src, v_calc_old, v_calc_new);
  v_src := replace(v_src, v_cols_old, v_cols_new);
  v_src := replace(v_src, v_vals_old, v_vals_new);
  IF position('the cluster''s first table stands for the game' in v_src) = 0
     OR position('ROLE_INVALID' in v_src) = 0 OR position('MAIN_INDEX_INVALID' in v_src) = 0
     OR position('LIFECYCLE_INVALID' in v_src) = 0 OR position('GAME_NOT_FOUND' in v_src) = 0
     OR position('fn_cash_stakes_label' in v_src) = 0 OR position('cash_cluster_events' in v_src) = 0 THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_OPENER_LOST_A_LIMB' USING ERRCODE = '55000';
  END IF;
  EXECUTE v_src;
END
$opener$;

-- ---------------------------------------------------------------------------
-- 4. THE RULESET PROJECTION CARRIES IT TOO, AND RECONCILES DRIFT.
--    Before (SET):        action_time_seconds = v_action_secs, updated_at = now()
--    After:               ... kill_mode = v_kill_mode, kill_threshold_bb = v_kill_bb, ...
--    Before (predicate):  ... OR t.action_time_seconds IS DISTINCT FROM v_action_secs )
--    After:               ... OR t.kill_mode / t.kill_threshold_bb IS DISTINCT FROM ... )
-- ---------------------------------------------------------------------------
DO $reconciler$
DECLARE
  v_src text; v_hits integer;
  v_decl_old CONSTANT text := '  v_n integer := 0;' || E'\n' || 'BEGIN';
  v_decl_new CONSTANT text :=
    '  v_n integer := 0;' || E'\n' || '  v_kill_mode text; v_kill_bb smallint;' || E'\n' || 'BEGIN';
  v_calc_old CONSTANT text :=
    '  v_sd := coalesce((v_opts->>''seven_deuce_enabled'')::boolean, false) AND g.variant = ''nlh'';' || E'\n';
  v_calc_new CONSTANT text :=
    '  v_sd := coalesce((v_opts->>''seven_deuce_enabled'')::boolean, false) AND g.variant = ''nlh'';' || E'\n' ||
    '  -- KILL POTS (kill-v1, 20260924034010). Exactly the opener''s projection:' || E'\n' ||
    '  -- ''off'' whenever the kill would be refused at this game''s tables, so a' || E'\n' ||
    '  -- tick never fails on a kill setting and a demoted capability turns the' || E'\n' ||
    '  -- whole game off together rather than one table at a time.' || E'\n' ||
    '  v_kill_bb := CASE WHEN (s->''kill''->>''threshold_bb'') IN (''8'',''10'',''12'',''15'')' || E'\n' ||
    '                    THEN (s->''kill''->>''threshold_bb'')::smallint ELSE 10 END;' || E'\n' ||
    '  v_kill_mode := lower(coalesce(s->''kill''->>''mode'', ''off''));' || E'\n' ||
    '  IF v_kill_mode NOT IN (''half'', ''full'') THEN' || E'\n' ||
    '    v_kill_mode := ''off'';' || E'\n' ||
    '  ELSIF public.fn_kill_pot_configuration_refusal(v_kill_mode, g.variant, ''cash'', NULL, v_bomb_on, g.bb, g.club_id) IS NOT NULL THEN' || E'\n' ||
    '    v_kill_mode := ''off'';' || E'\n' ||
    '  ELSIF NOT public.fn_capability_available(''cash.fixed_limit.kill_pots'') THEN' || E'\n' ||
    '    v_kill_mode := ''off'';' || E'\n' ||
    '  END IF;' || E'\n';
  v_set_old CONSTANT text :=
    '         action_time_seconds = v_action_secs,' || E'\n' || '         updated_at = now()';
  v_set_new CONSTANT text :=
    '         action_time_seconds = v_action_secs,' || E'\n' ||
    '         kill_mode = v_kill_mode,' || E'\n' ||
    '         kill_threshold_bb = v_kill_bb,' || E'\n' ||
    '         updated_at = now()';
  v_pred_old CONSTANT text :=
    '       OR t.action_time_seconds IS DISTINCT FROM v_action_secs' || E'\n' || '     );';
  v_pred_new CONSTANT text :=
    '       OR t.action_time_seconds IS DISTINCT FROM v_action_secs' || E'\n' ||
    '       OR t.kill_mode IS DISTINCT FROM v_kill_mode' || E'\n' ||
    '       OR t.kill_threshold_bb IS DISTINCT FROM v_kill_bb' || E'\n' || '     );';
  v_log_old CONSTANT text := '''rit'', v_rit_mode));';
  v_log_new CONSTANT text := '''rit'', v_rit_mode, ''kill'', v_kill_mode));';
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_apply_ruleset(uuid)'::regprocedure);
  FOREACH v_hits IN ARRAY ARRAY[
      (length(v_src) - length(replace(v_src, v_decl_old, ''))) / length(v_decl_old),
      (length(v_src) - length(replace(v_src, v_calc_old, ''))) / length(v_calc_old),
      (length(v_src) - length(replace(v_src, v_set_old, ''))) / length(v_set_old),
      (length(v_src) - length(replace(v_src, v_pred_old, ''))) / length(v_pred_old),
      (length(v_src) - length(replace(v_src, v_log_old, ''))) / length(v_log_old)] LOOP
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'KILL_POT_SETTINGS_RULESET_ANCHOR_MATCHED_% times', v_hits USING ERRCODE = '55000';
    END IF;
  END LOOP;
  v_src := replace(v_src, v_decl_old, v_decl_new);
  v_src := replace(v_src, v_calc_old, v_calc_new);
  v_src := replace(v_src, v_set_old, v_set_new);
  v_src := replace(v_src, v_pred_old, v_pred_new);
  v_src := replace(v_src, v_log_old, v_log_new);
  IF position('bomb_pot_double_board' in v_src) = 0
     OR position('maintain_percent_min = v_vpip' in v_src) = 0
     OR position('straddle_enabled = false' in v_src) = 0
     OR position('ruleset_applied' in v_src) = 0
     OR position('max_players = GREATEST(g.handedness' in v_src) = 0
     OR position('run_it_mode = v_rit_mode' in v_src) = 0
     OR position('t.lifecycle <> ''closed''' in v_src) = 0 THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_RULESET_LOST_A_LIMB' USING ERRCODE = '55000';
  END IF;
  EXECUTE v_src;
END
$reconciler$;

-- ---------------------------------------------------------------------------
-- 5. THE OWNER DOOR.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_set_cash_game_kill_settings(
  p_game_id uuid,
  p_kill_mode text,
  p_kill_threshold_bb integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_mode text := lower(btrim(p_kill_mode));
  g public.cash_games%ROWTYPE;
  v_refusal text;
  v_before jsonb;
  v_after jsonb;
  v_tables_before jsonb;
  v_applied integer;
  v_audited integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign In To Change Kill Pots' USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'This Session Has Ended, Sign In Again' USING ERRCODE = '28000';
  END IF;
  IF v_mode IS NULL OR v_mode NOT IN ('off','half','full') THEN
    RAISE EXCEPTION 'Kill Mode Must Be Off, Half Or Full' USING ERRCODE = '22023';
  END IF;
  IF p_kill_threshold_bb IS NULL OR p_kill_threshold_bb NOT IN (8,10,12,15) THEN
    RAISE EXCEPTION 'Kill Threshold Must Be 8, 10, 12 Or 15 Big Blinds' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cash Game Not Found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.fn_can_create_games(g.club_id, v_uid) THEN
    RAISE EXCEPTION 'Only The Club Owner Or An Admin Can Change Kill Pots' USING ERRCODE = '42501';
  END IF;
  -- A game with no snapshot is projected by nothing (fn_cash_apply_ruleset
  -- returns at once for it). Writing {"kill":...} into it would make every
  -- OTHER rule of that game project from an empty snapshot, so it is refused.
  IF g.ruleset_snapshot IS NULL OR jsonb_typeof(g.ruleset_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'This Cash Game Has No Ruleset To Change' USING ERRCODE = '22023';
  END IF;

  IF v_mode <> 'off' THEN
    IF NOT public.fn_capability_available('cash.fixed_limit.kill_pots') THEN
      RAISE EXCEPTION 'Kill Pots Are Not Available Yet' USING ERRCODE = '22023';
    END IF;
    v_refusal := public.fn_kill_pot_configuration_refusal(
      v_mode, g.variant, 'cash', NULL,
      coalesce((g.ruleset_snapshot->'bombs'->>'enabled')::boolean, false), g.bb, g.club_id);
    IF v_refusal IS NOT NULL THEN
      RAISE EXCEPTION '%', v_refusal USING ERRCODE = '22023';
    END IF;
  END IF;

  v_before := coalesce(g.ruleset_snapshot->'kill', '{"mode":"off","threshold_bb":10}'::jsonb);
  v_after := jsonb_build_object('mode', v_mode, 'threshold_bb', p_kill_threshold_bb);

  SELECT coalesce(jsonb_object_agg(t.id::text, jsonb_build_object(
           'kill_mode', t.kill_mode, 'kill_threshold_bb', t.kill_threshold_bb)), '{}'::jsonb)
    INTO v_tables_before
    FROM public.tables t
   WHERE t.cluster_id = g.id AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false;

  UPDATE public.cash_games
     SET ruleset_snapshot = ruleset_snapshot || jsonb_build_object('kill', v_after),
         updated_at = now()
   WHERE id = g.id;

  -- Through the one function allowed to map a snapshot onto a cluster.
  v_applied := public.fn_cash_apply_ruleset(g.id);

  INSERT INTO public.table_settings_changes (table_id, club_id, changed_by, before, after)
  SELECT t.id, coalesce(t.club_id, g.club_id), v_uid,
         v_tables_before->(t.id::text),
         jsonb_build_object('kill_mode', t.kill_mode, 'kill_threshold_bb', t.kill_threshold_bb)
    FROM public.tables t
   WHERE t.cluster_id = g.id AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false
     AND v_tables_before ? (t.id::text)
     AND (v_tables_before->(t.id::text)) IS DISTINCT FROM
         jsonb_build_object('kill_mode', t.kill_mode, 'kill_threshold_bb', t.kill_threshold_bb);
  GET DIAGNOSTICS v_audited = ROW_COUNT;

  IF v_before IS DISTINCT FROM v_after OR v_audited > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (g.id, 'kill_settings_changed',
            jsonb_build_object('before', v_before, 'after', v_after, 'changed_by', v_uid,
                               'tables_changed', v_audited, 'rule_version', 'kill-v1'));
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'changed', v_before IS DISTINCT FROM v_after OR v_audited > 0,
    'game_id', g.id,
    'kill', v_after,
    'tables_applied', v_applied,
    'tables_changed', v_audited);
END
$fn$;

COMMENT ON FUNCTION public.fn_set_cash_game_kill_settings(uuid,text,integer) IS
  'Owner door for Kill and Half Kill (kill-v1) on a fixed-limit cash game. Caller must pass fn_can_create_games for the game''s club. Validates with fn_kill_pot_configuration_refusal and the capability registry (off is always accepted), writes cash_games.ruleset_snapshot.kill, projects it onto every live table of the game through fn_cash_apply_ruleset, and audits one table_settings_changes row per changed table plus one cash_cluster_events kill_settings_changed row. Moves no money. 20260924034010.';

-- ---------------------------------------------------------------------------
-- 6. PRIVILEGES. Supabase grants anon and authenticated on every new function
--    by default, so every grant is explicit. The refusal function is invoked
--    by the trigger as the writing role, so both writing roles keep it.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_kill_pot_configuration_refusal(text,text,text,uuid,boolean,numeric,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_kill_pot_configuration_refusal(text,text,text,uuid,boolean,numeric,uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_tables_kill_pot_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_set_cash_game_kill_settings(uuid,text,integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fn_set_cash_game_kill_settings(uuid,text,integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. THE COLUMNS AND THE TRIGGER. Last, because ALTER TABLE holds ACCESS
--    EXCLUSIVE on tables and hand_history until COMMIT. Metadata only: no
--    rewrite (constant defaults) and no scan (NOT VALID checks).
-- ---------------------------------------------------------------------------
ALTER TABLE public.tables
  ADD COLUMN kill_mode text NOT NULL DEFAULT 'off',
  ADD COLUMN kill_threshold_bb smallint NOT NULL DEFAULT 10,
  ADD CONSTRAINT tables_kill_mode_check
    CHECK (kill_mode IN ('off','half','full')) NOT VALID,
  ADD CONSTRAINT tables_kill_threshold_bb_check
    CHECK (kill_threshold_bb IN (8,10,12,15)) NOT VALID;

ALTER TABLE public.hand_history
  ADD COLUMN kill_pot jsonb NULL,
  ADD CONSTRAINT hand_history_kill_pot_is_object
    CHECK (kill_pot IS NULL OR jsonb_typeof(kill_pot) = 'object') NOT VALID;

COMMENT ON COLUMN public.tables.kill_mode IS
  'Kill pots (kill-v1): off, half (limits x 3/2) or full (limits x 2) on the hand after one player scoops a pot of at least kill_threshold_bb base big blinds. Configuration, part of the managed contract. Refused by zz_tables_kill_pot_guard unless the engine can honour it. Set for a cash game through fn_set_cash_game_kill_settings.';
COMMENT ON COLUMN public.tables.kill_threshold_bb IS
  'Kill pots (kill-v1): the scoop threshold in BASE big blinds, one of 8, 10, 12, 15.';
COMMENT ON COLUMN public.hand_history.kill_pot IS
  'Kill pots (kill-v1): the kill this hand played, the kill it scheduled for the next hand (restored from here at engine start) and a kill it cancelled. NULL on every other hand. small_blind/big_blind on the row stay the BASE blinds.';

CREATE TRIGGER zz_tables_kill_pot_guard
  BEFORE INSERT OR UPDATE OF kill_mode, kill_threshold_bb, game_variant, game_type,
    tournament_id, bomb_pot_enabled, big_blind, club_id
  ON public.tables
  FOR EACH ROW
  WHEN (NEW.kill_mode IS DISTINCT FROM 'off')
  EXECUTE FUNCTION public.fn_tables_kill_pot_guard();

-- ---------------------------------------------------------------------------
-- 8. POST-IMAGE, from the catalogue only (no row of either hot table is read).
-- ---------------------------------------------------------------------------
DO $post$
BEGIN
  IF (SELECT count(*) FROM pg_constraint c
       WHERE c.conname IN ('tables_kill_mode_check','tables_kill_threshold_bb_check','hand_history_kill_pot_is_object')
         AND c.contype = 'c') <> 3 THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_CHECKS_MISSING' USING ERRCODE = '55000';
  END IF;
  IF position('v_kill_mode, v_kill_bb' in pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure)) = 0
     OR position('kill_mode = v_kill_mode' in pg_get_functiondef('public.fn_cash_apply_ruleset(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_PROJECTION_MISSING' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', 'public.fn_set_cash_game_kill_settings(uuid,text,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_set_cash_game_kill_settings(uuid,text,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_kill_pot_configuration_refusal(text,text,text,uuid,boolean,numeric,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_kill_pot_configuration_refusal(text,text,text,uuid,boolean,numeric,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_GRANTS_NOT_AS_DECLARED' USING ERRCODE = '42501';
  END IF;
  -- The two contract readers were read and deliberately left alone: the kill
  -- columns are configuration and must NOT be stripped from the contract.
  IF position('kill_mode' in pg_get_functiondef('public.fn_managed_game_contract_document(text,jsonb)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'KILL_POT_SETTINGS_CONTRACT_EXCLUDES_KILL' USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
