-- 20261024213758_a_classic_game_never_moves_its_players.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch.
--
-- ===========================================================================
-- THE RULE (Dan 2026-10-24, verbatim)
--
--   "THIS HAS GOT TO BE FIXED AT ONCE, PLAYERS SHOULD NOT BE MOVING ON
--    CLASSIC GAMES PERIOD. FIX THAT BUG AT ITS ROOT CAUSE AND PREVENT IT FROM
--    HAPPENING AGAIN."
--
-- Classic is the regular ring game (docs/changelog/2026-10-23-classic-and-
-- lightning-standard.md: "Classic keeps regular ring-game rules"). A seated
-- Classic player stays in the chair they chose until they leave or ask to
-- change seats themselves.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS (2026-10-24 ~21:00 UTC)
--
-- 50 enabled Classic games (template_name 'classic'). 24 have must_move =
-- false and never moved anyone. The other 26 - Midway Union's Classic lineup
-- (NLH 0.05/0.10 Classic ... Short Deck 0.50/1 Classic), 188 Main tables and
-- 26 feeders - carry must_move = true, so every 5 s fn_cash_cluster_tick
-- planned three kinds of automatic move for them:
--   * 'must_move': every open Main seat drew the longest-seated feeder player
--     (observed: PLO6 0.10/0.25 Classic Main 5 refilled from its feeder at
--     21:04 UTC);
--   * 'break': the newest table whose players fit elsewhere was broken and
--     everyone on it moved to the shortest table;
--   * 'balance': fn_cash_cluster_balance evened the feeders.
-- must_move is the CAPABILITY that also owns table management (Main 1 always
-- open, a new table when every seat is taken, empty tables closed), so
-- turning it off would have stopped those games opening tables. The defect is
-- that the capability moved players at all on a Classic game.
--
-- ===========================================================================
-- WHAT CHANGES
--
-- 1. public.fn_cash_game_never_moves_players(template, ruleset): the one
--    definition. Classic, except the PLO5 1/2 Madness stand-in whose ruleset
--    says rules_profile 'madness_without_lightning' (a Madness game by the
--    owner's own words, docs/changelog/2026-10-24-plo5-one-two-madness-
--    without-lightning.md).
-- 2. fn_cash_cluster_tick, for such a game:
--    * plans no must-move (step 2 is skipped);
--    * chooses only an EMPTY table (nobody seated, nothing reserved) to break,
--      so empty tables still close;
--    * withdraws a break already started on a table that has players: the
--      table goes back to live and nobody is moved;
--    * still opens tables, keeps Main 1, closes empties and honours a
--      player's own seat-change request (reason 'seat_change').
--    Asserted single-anchor substitutions against the live body (pre-image
--    md5 of pg_get_functiondef 801638baef58f9f44ff4e80e24c153ab), the same
--    shape as 20260921025523.
-- 3. fn_cash_cluster_balance plans nothing for such a game.
-- 4. PREVENT IT FROM HAPPENING AGAIN: a BEFORE INSERT OR UPDATE trigger on
--    cash_seat_moves refuses any move but 'seat_change' for such a game, so
--    no planner, present or future, can move a Classic player.
-- 5. The automatic moves already planned for such games (3 pending at
--    ~21:40 UTC) are cancelled with note 'classic_game_never_moves_players'.
--    A cancelled move is never executed (fn_cash_seat_move_execute takes only
--    pending rows). No seat, stack, wallet or hand is touched.
--
-- 6. fn_cash_game_lobby's game object says never_moves_players (from the one
--    definition above), so the on-table lobby stops showing a Classic player
--    a Must Move List and a place on it that will never move them.
--
-- 7. fn_cash_game_join fills a Classic game's fullest table with an open
--    chair first, whatever its role: feeder-last only made sense while the
--    tick moved the feeder's players up.
--
-- No chip moves. No hot table (clubs, tables, hand_history) is locked by this
-- file: it replaces two functions, adds a trigger on cash_seat_moves and
-- updates pending rows of cash_seat_moves.
--
-- Pinned by tests/a-classic-game-never-moves-its-players.law.test.ts.

-- @live-proof: (SELECT position('v_classic := public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot);' in pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('public.fn_cash_game_never_moves_players(cg.template_name, cg.ruleset_snapshot)' in pg_get_functiondef('public.fn_cash_cluster_balance(uuid,timestamptz)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('''never_moves_players'', public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot)' in pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('v_never_moves := public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot);' in pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT count(*) = 1 FROM pg_trigger WHERE tgrelid = 'public.cash_seat_moves'::regclass AND tgname = 'a_classic_game_never_moves_players' AND tgenabled = 'O')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m JOIN public.cash_games g ON g.id = m.game_id WHERE m.state = 'pending' AND m.reason <> 'seat_change' AND public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot)))

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

-- ===========================================================================
-- 1. THE ONE DEFINITION
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_cash_game_never_moves_players(p_template text, p_ruleset jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $never_moves$
  SELECT coalesce(p_template, '') = 'classic'
     AND coalesce(p_ruleset->>'rules_profile', '') <> 'madness_without_lightning'
$never_moves$;

COMMENT ON FUNCTION public.fn_cash_game_never_moves_players(text, jsonb) IS
  'A Classic game never moves its players (Dan 2026-10-24: "PLAYERS SHOULD NOT BE MOVING ON CLASSIC GAMES PERIOD"). True for template_name classic, except the madness_without_lightning rules profile. Read by fn_cash_cluster_tick, fn_cash_cluster_balance and the cash_seat_moves trigger.';

REVOKE ALL ON FUNCTION public.fn_cash_game_never_moves_players(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_never_moves_players(text, jsonb) TO service_role;

-- ===========================================================================
-- 2. THE TICK PLANS NO AUTOMATIC MOVE FOR A CLASSIC GAME
-- ===========================================================================
DO $classic_tick$
DECLARE
  v_fn  text := 'public.fn_cash_cluster_tick(uuid,integer)';
  v_src text; v_find text; v_repl text; v_n integer;
BEGIN
  v_src := pg_get_functiondef(v_fn::regprocedure);

  IF position('public.fn_cash_game_never_moves_players(' in v_src) > 0 THEN
    RAISE NOTICE 'fn_cash_cluster_tick already never moves a Classic player; nothing to do';
    RETURN;
  END IF;
  IF md5(v_src) <> '801638baef58f9f44ff4e80e24c153ab' THEN
    RAISE EXCEPTION 'CLASSIC_NEVER_MOVES_TICK_PREIMAGE_DRIFT: fn_cash_cluster_tick is %, read it before re-running', md5(v_src);
  END IF;

  -- (a) DECLARE v_classic.
  v_find := '  v_table_cap integer;' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'declaration anchor found % times, not once', v_n; END IF;
  v_src := replace(v_src, v_find, v_find || '  v_classic boolean := false;' || chr(10));

  -- (b) Read it once the game row is held.
  v_find := '  IF NOT g.must_move THEN RETURN jsonb_build_object(''ok'', false, ''reason'', ''manual_game''); END IF;' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'manual_game anchor found % times, not once', v_n; END IF;
  v_repl := v_find
    || '  -- A CLASSIC GAME NEVER MOVES ITS PLAYERS (Dan 2026-10-24: "PLAYERS SHOULD' || chr(10)
    || '  -- NOT BE MOVING ON CLASSIC GAMES PERIOD"). The tick still manages its' || chr(10)
    || '  -- tables; it plans no must-move, breaks only an empty table, and withdraws' || chr(10)
    || '  -- a break started under seated players. cash_seat_moves refuses the rest.' || chr(10)
    || '  v_classic := public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot);' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  -- (c) Step 2, MUST-MOVE: no Main seat draws anyone on a Classic game.
  v_find := '            WHERE c.role = ''main'' AND c.lifecycle = ''live'' AND c.open_unreserved > 0' || chr(10)
         || '            ORDER BY c.main_index' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'must-move anchor found % times, not once', v_n; END IF;
  v_repl := '            WHERE NOT v_classic AND c.role = ''main'' AND c.lifecycle = ''live'' AND c.open_unreserved > 0' || chr(10)
         || '            ORDER BY c.main_index' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  -- (d) Step 5, BREAK candidate: a Classic game breaks only an empty table.
  v_find := '   WHERE c.id IS DISTINCT FROM v_front AND c.lifecycle = ''live''' || chr(10)
         || '   ORDER BY (c.seated = 0) DESC,';
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'break candidate anchor found % times, not once', v_n; END IF;
  v_repl := '   WHERE c.id IS DISTINCT FROM v_front AND c.lifecycle = ''live''' || chr(10)
         || '     AND (NOT v_classic OR (c.seated = 0 AND c.reserved = 0))' || chr(10)
         || '   ORDER BY (c.seated = 0) DESC,';
  v_src := replace(v_src, v_find, v_repl);

  -- (e) A breaking Classic table that still has players is not broken: the
  --     break is withdrawn and nobody is moved. An empty one already closed
  --     in the branch above this anchor.
  v_find := '    -- Native committed ownership makes duplicate-chair cashout unnecessary.' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'break-move anchor found % times, not once', v_n; END IF;
  v_repl := '    -- A CLASSIC TABLE IS NEVER BROKEN UNDER ITS PLAYERS (Dan 2026-10-24).' || chr(10)
         || '    IF v_classic THEN' || chr(10)
         || '      UPDATE public.tables SET lifecycle = ''live'', break_started_at = NULL, break_eligible_since = NULL, updated_at = now()' || chr(10)
         || '       WHERE id = t.id AND lifecycle = ''breaking'';' || chr(10)
         || '      INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, ''classic_break_withdrawn'');' || chr(10)
         || '      v_actions := v_actions || jsonb_build_object(''classic_break_withdrawn'', t.id);' || chr(10)
         || '      v_census := public.fn_cash_cluster_census(g.id, v_now);' || chr(10)
         || '      CONTINUE;' || chr(10)
         || '    END IF;' || chr(10)
         || v_find;
  v_src := replace(v_src, v_find, v_repl);

  -- Every sibling refusal and step must have survived.
  IF position('''lightning_cluster_stands_down''' in v_src) = 0
     OR position('''manual_game''' in v_src) = 0
     OR position('''ticking_elsewhere''' in v_src) = 0
     OR position('''feeder_abandoned''' in v_src) = 0
     OR position('''table_break_completed''' in v_src) = 0
     OR position('VALUES (g.id, r.user_id, r.table_id, t.id, ''must_move'');' in v_src) = 0
     OR position('VALUES (g.id, r.user_id, t.id, v_shortest, ''break'');' in v_src) = 0
     OR position('-- ── 2b. SEAT CHANGES' in v_src) = 0 THEN
    RAISE EXCEPTION 'a sibling step did not survive the edit to fn_cash_cluster_tick';
  END IF;

  EXECUTE v_src;
END
$classic_tick$;

-- ===========================================================================
-- 3. THE BALANCER PLANS NOTHING FOR A CLASSIC GAME
-- ===========================================================================
DO $classic_balance$
DECLARE
  v_fn  text := 'public.fn_cash_cluster_balance(uuid,timestamp with time zone)';
  v_src text; v_find text; v_n integer;
BEGIN
  v_src := pg_get_functiondef(v_fn::regprocedure);

  IF position('public.fn_cash_game_never_moves_players(' in v_src) > 0 THEN
    RAISE NOTICE 'fn_cash_cluster_balance already plans nothing for a Classic game; nothing to do';
    RETURN;
  END IF;
  IF md5(v_src) <> '3c4b563f1f00b4372ebd024c7494a884' THEN
    RAISE EXCEPTION 'CLASSIC_NEVER_MOVES_BALANCE_PREIMAGE_DRIFT: fn_cash_cluster_balance is %, read it before re-running', md5(v_src);
  END IF;

  v_find := '  IF EXISTS (SELECT 1 FROM public.cash_games cg' || chr(10)
         || '              WHERE cg.id = p_game_id AND cg.cluster_mode IS DISTINCT FROM ''must_move'') THEN' || chr(10)
         || '    RETURN 0;' || chr(10)
         || '  END IF;' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'balance guard anchor found % times, not once', v_n; END IF;
  v_src := replace(v_src, v_find, v_find
         || '  -- A CLASSIC GAME NEVER MOVES ITS PLAYERS (Dan 2026-10-24).' || chr(10)
         || '  IF EXISTS (SELECT 1 FROM public.cash_games cg' || chr(10)
         || '              WHERE cg.id = p_game_id AND public.fn_cash_game_never_moves_players(cg.template_name, cg.ruleset_snapshot)) THEN' || chr(10)
         || '    RETURN 0;' || chr(10)
         || '  END IF;' || chr(10));

  EXECUTE v_src;
END
$classic_balance$;

-- ===========================================================================
-- 4. NO PLANNER CAN MOVE A CLASSIC PLAYER
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_refuses_classic()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $refuses_classic$
BEGIN
  -- A player's own seat-change request is the only move a Classic game
  -- admits. Every automatic reason (must_move, break, balance) is refused
  -- here, whoever plans it (Dan 2026-10-24: "PREVENT IT FROM HAPPENING
  -- AGAIN").
  IF NEW.reason IS DISTINCT FROM 'seat_change' AND EXISTS (
       SELECT 1 FROM public.cash_games g
        WHERE g.id = NEW.game_id
          AND public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot)) THEN
    RAISE EXCEPTION 'CLASSIC_GAME_NEVER_MOVES_PLAYERS: a % move was refused for Classic game %', NEW.reason, NEW.game_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$refuses_classic$;

REVOKE ALL ON FUNCTION public.fn_cash_seat_move_refuses_classic() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_classic_game_never_moves_players ON public.cash_seat_moves;
CREATE TRIGGER a_classic_game_never_moves_players
  BEFORE INSERT OR UPDATE OF reason, game_id ON public.cash_seat_moves
  FOR EACH ROW EXECUTE FUNCTION public.fn_cash_seat_move_refuses_classic();

-- ===========================================================================
-- 5. WHAT WAS ALREADY PLANNED IS NOT EXECUTED
-- ===========================================================================
UPDATE public.cash_seat_moves m
   SET state = 'cancelled', note = 'classic_game_never_moves_players'
  FROM public.cash_games g
 WHERE g.id = m.game_id
   AND m.state = 'pending'
   AND m.reason <> 'seat_change'
   AND public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot);

-- ===========================================================================
-- 6. THE LOBBY SAYS SO
-- ===========================================================================
DO $classic_lobby$
DECLARE
  v_fn  text := 'public.fn_cash_game_lobby(uuid)';
  v_src text; v_find text; v_n integer;
BEGIN
  v_src := pg_get_functiondef(v_fn::regprocedure);

  IF position('''never_moves_players''' in v_src) > 0 THEN
    RAISE NOTICE 'fn_cash_game_lobby already says never_moves_players; nothing to do';
    RETURN;
  END IF;
  IF md5(v_src) <> '1fb26fc0037a7491d6f259d526fc0217' THEN
    RAISE EXCEPTION 'CLASSIC_NEVER_MOVES_LOBBY_PREIMAGE_DRIFT: fn_cash_game_lobby is %, read it before re-running', md5(v_src);
  END IF;

  v_find := '                               ''last_tick_at'', g.last_tick_at),' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'lobby game-object anchor found % times, not once', v_n; END IF;
  v_src := replace(v_src, v_find,
         '                               ''last_tick_at'', g.last_tick_at,' || chr(10)
      || '                               ''never_moves_players'', public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot)),' || chr(10));

  IF position('SELECT * INTO g FROM public.cash_games WHERE id = p_game_id;' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_cash_game_lobby no longer reads the whole game row; the lobby edit cannot see ruleset_snapshot';
  END IF;

  EXECUTE v_src;
END
$classic_lobby$;

-- ===========================================================================
-- 7. THE JOIN DOOR FILLS A CLASSIC GAME'S FULLEST TABLE FIRST
-- ===========================================================================
-- Feeder-last made sense only while the tick moved a feeder's players up to
-- the Mains. A Classic game moves nobody, so a newcomer sent past the feeder
-- to a Main left the feeder's players short-handed for good. For a game that
-- never moves its players the role is ignored and the fullest table with an
-- open chair fills first (Dan 2026-10-23: "A FULLER TABLE FILLS FIRST").
-- Every other game keeps its order exactly.
DO $classic_join$
DECLARE
  v_fn  text := 'public.fn_cash_game_join(uuid)';
  v_src text; v_find text; v_n integer;
BEGIN
  v_src := pg_get_functiondef(v_fn::regprocedure);

  IF position('v_never_moves' in v_src) > 0 THEN
    RAISE NOTICE 'fn_cash_game_join already fills a Classic game fullest first; nothing to do';
    RETURN;
  END IF;
  IF md5(v_src) <> '2ab096598d5d2240d546a08dd96094ea' THEN
    RAISE EXCEPTION 'CLASSIC_NEVER_MOVES_JOIN_PREIMAGE_DRIFT: fn_cash_game_join is %, read it before re-running', md5(v_src);
  END IF;

  v_find := '  v_need numeric;' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'join declaration anchor found % times, not once', v_n; END IF;
  v_src := replace(v_src, v_find, v_find || '  v_never_moves boolean := false;' || chr(10));

  v_find := '  IF NOT FOUND THEN RAISE EXCEPTION ''GAME_NOT_FOUND: %'', p_game_id; END IF;' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'join game-row anchor found % times, not once', v_n; END IF;
  v_src := replace(v_src, v_find, v_find
    || '  -- A CLASSIC GAME NEVER MOVES ITS PLAYERS (Dan 2026-10-24): its fullest table' || chr(10)
    || '  -- with an open chair fills first, whatever its role.' || chr(10)
    || '  v_never_moves := public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot);' || chr(10));

  v_find := '     ORDER BY (tb.role = ''feeder'') ASC, seated ASC, tb.main_index ASC NULLS LAST, tb.created_at ASC' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'join order anchor found % times, not once', v_n; END IF;
  v_src := replace(v_src, v_find,
       '     ORDER BY (tb.role = ''feeder'' AND NOT v_never_moves) ASC,' || chr(10)
    || '              (CASE WHEN v_never_moves THEN -1 ELSE 1 END)' || chr(10)
    || '                * (SELECT count(*) FROM public.table_seats ts2 WHERE ts2.table_id = tb.id AND ts2.left_at IS NULL) ASC,' || chr(10)
    || '              tb.main_index ASC NULLS LAST, tb.created_at ASC' || chr(10));

  -- Every sibling door must have survived.
  IF position('NOT_AUTHENTICATED' in v_src) = 0
     OR position('PRIVATE_MEMBERSHIP_REQUIRED' in v_src) = 0
     OR position('GAME_BARRED' in v_src) = 0
     OR position('INSUFFICIENT_CHIPS' in v_src) = 0
     OR position('LIGHTNING NEVER QUEUES' in v_src) = 0
     OR position('''waitlisted''' in v_src) = 0 THEN
    RAISE EXCEPTION 'a sibling door did not survive the edit to fn_cash_game_join';
  END IF;

  EXECUTE v_src;
END
$classic_join$;

-- ===========================================================================
-- POST-IMAGE
-- ===========================================================================
DO $classic_post$
DECLARE v_tick text; v_bal text;
BEGIN
  v_tick := pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure);
  v_bal  := pg_get_functiondef('public.fn_cash_cluster_balance(uuid,timestamp with time zone)'::regprocedure);
  IF position('v_classic := public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot);' in v_tick) = 0
     OR position('WHERE NOT v_classic AND c.role = ''main'' AND c.lifecycle = ''live'' AND c.open_unreserved > 0' in v_tick) = 0
     OR position('AND (NOT v_classic OR (c.seated = 0 AND c.reserved = 0))' in v_tick) = 0
     OR position('''classic_break_withdrawn''' in v_tick) = 0
     OR position('public.fn_cash_game_never_moves_players(cg.template_name, cg.ruleset_snapshot)' in v_bal) = 0
     OR position('v_never_moves := public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot);' in pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure)) = 0
     OR position('''never_moves_players'', public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot)' in pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure)) = 0
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.cash_seat_moves'::regclass
                     AND tgname = 'a_classic_game_never_moves_players' AND tgenabled = 'O')
     OR EXISTS (SELECT 1 FROM public.cash_seat_moves m JOIN public.cash_games g ON g.id = m.game_id
                 WHERE m.state = 'pending' AND m.reason <> 'seat_change'
                   AND public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot)) THEN
    RAISE EXCEPTION 'CLASSIC_NEVER_MOVES_POSTIMAGE_DRIFT';
  END IF;
  IF NOT public.fn_cash_game_never_moves_players('classic', '{}'::jsonb)
     OR public.fn_cash_game_never_moves_players('classic', '{"rules_profile":"madness_without_lightning"}'::jsonb)
     OR public.fn_cash_game_never_moves_players('madness', '{}'::jsonb)
     OR public.fn_cash_game_never_moves_players('action', '{}'::jsonb)
     OR public.fn_cash_game_never_moves_players(NULL, NULL) THEN
    RAISE EXCEPTION 'CLASSIC_NEVER_MOVES_POSTIMAGE_DRIFT: the definition does not say what it should';
  END IF;
END
$classic_post$;

COMMIT;
