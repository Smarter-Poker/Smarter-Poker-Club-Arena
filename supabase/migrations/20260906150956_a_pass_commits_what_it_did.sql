-- 20260906150956_a_pass_commits_what_it_did.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A PASS COMMITS WHAT IT DID.
--
-- `fn_cash_clusters_tick_all` is one RPC per 5-second pass (20260905091025),
-- called by the engine under service_role's 8-second statement_timeout
-- (pinned 2026-08-31, PGRST002; do not raise it). pg_stat_statements on
-- 2026-09-06 09:40 CDT: 15,922 calls, mean 1,187 ms, MAX 7,993 ms - the
-- ceiling - and the engine log carried nine `ClusterController.pass_failed`
-- 57014 rows in three hours. A pass that crosses the ceiling is rolled back
-- whole: every game it ticked is un-ticked, no feeder opens, no table breaks,
-- no move is planned, and the 8 seconds are simply gone.
--
-- The work is not the problem. A rolled-back probe (psql, BEGIN ... ROLLBACK,
-- 10:08 CDT) ticked all 108 enabled games in sequence: 2,652 ms of tick,
-- 185 ms of balance, 425 ms of census - 3.3 s for everything, average 25 ms a
-- game, worst 675 ms (PLO6 1/2 Madness). The overrun is WAITING: the tick
-- takes `cash_games FOR UPDATE` and writes `tables` and `table_seats`, rows
-- the engine and the fleet write every second.
--
-- Two changes to the pass, nothing to the per-game tick:
--
--   1. A BUDGET. The pass stops STARTING games at 5.5 s (a game already in
--      its tick finishes). Games not started are DEFERRED: counted, returned
--      as identity rows beside `rested_games` so the controller's map knows
--      them, and left with their `last_tick_at` untouched. The worklist is
--      now ordered oldest-ticked first (it was `created_at`, which with a
--      budget would defer the same tail every pass), so a deferred game is
--      first in line five seconds later. 5.5 s under an 8 s ceiling leaves
--      2.5 s for the slowest game measured (675 ms) three times over.
--
--   2. A LOCK BOUND. `lock_timeout` is set transaction-locally to 2,000 ms.
--      Unlike statement_timeout it is checked at each lock acquisition, so it
--      CAN be set from inside the statement it governs. A game whose tick
--      waits longer raises 55P03 inside its own sub-block, is rolled back
--      alone, and lands in `cash_cluster_events` as a `controller_tick_error`
--      row naming the lock - the pass goes on. One held row costs one game
--      one pass, never the pass.
--
-- Nothing else moves. The body below is the LIVE one (md5
-- 8dadda13170127ec2b571790d198d79e, read 10:12 CDT), which is
-- 20260906011318's; the pin in server/src/cluster/
-- TheTablesOpenAndCloseThemselves.law.test.ts moves to this file in the same
-- commit. `fn_cash_cluster_tick` and `fn_cash_cluster_balance` are not
-- re-declared here.
--
-- The engine reads `deferred` and `elapsed_ms` (ClusterController) and
-- publishes poker_cluster_pass_deferred; a pass that defers is logged.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_cash_clusters_tick_all(p_eligible jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  w record;
  v_now timestamptz := clock_timestamp();
  v_games integer := 0;
  v_ticked integer := 0;
  v_errors integer := 0;
  v_rested integer := 0;
  v_balanced integer := 0;
  v_bal integer;
  v_eligible integer;
  v_res jsonb;
  v_results jsonb := '[]'::jsonb;
  v_rested_games jsonb := '[]'::jsonb;
  v_sqlstate text;
  v_message text;
  -- A PASS COMMITS WHAT IT DID (2026-09-06). See the header of migration
  -- 20260906150956. The engine's role has an 8-second statement_timeout, and
  -- a pass that crosses it is rolled back WHOLE: every game it ticked is
  -- un-ticked and the 8 seconds are gone. Measured 2026-09-06: mean 1,187 ms,
  -- max 7,993 ms, 9 whole-pass timeouts in three hours, while a pass over all
  -- 108 games in isolation is ~3.3 s (avg 25 ms a game, worst 675 ms) - the
  -- overrun is waiting, not work. So: the pass stops STARTING games at
  -- v_budget and hands the rest to the next pass (they are ordered oldest-
  -- ticked first, so nothing starves), and a single lock wait is bounded by
  -- v_lock_wait so one held row costs one game its tick, not the pass.
  v_budget interval := interval '5500 milliseconds';
  v_lock_wait text := '2000ms';
  v_deferred integer := 0;
  v_deferred_games jsonb := '[]'::jsonb;
BEGIN
  -- Transaction-local, so it dies with the RPC. lock_timeout is checked at
  -- every lock acquisition, so unlike statement_timeout it can be set from
  -- inside the statement it governs. A game whose tick waits longer than this
  -- raises 55P03 inside its own sub-block below and becomes an error row.
  PERFORM set_config('lock_timeout', v_lock_wait, true);

  -- THE FREEZE (CLAUDE.md 13): the same short-circuit the per-game tick has,
  -- taken once for the pass so a frozen platform costs one row read.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'skipped', 'frozen',
                              'games', 0, 'ticked', 0, 'errors', 0, 'rested', 0,
                              'balanced', 0,
                              'results', '[]'::jsonb, 'rested_games', '[]'::jsonb);
  END IF;

  FOR w IN
    SELECT l.game_id, l.club_id, l.main1_table_id, l.state, l.enabled,
           g.last_tick_at,
           coalesce((p_eligible ->> (l.main1_table_id::text))::integer, 0) AS eligible,
           EXISTS (
             SELECT 1
               FROM public.tables t
               JOIN public.table_seats ts ON ts.table_id = t.id AND ts.left_at IS NULL
              WHERE t.cluster_id = l.game_id
                AND t.lifecycle <> 'closed'
           ) AS anyone_seated
      FROM public.fn_cash_clusters_to_tick() l
      JOIN public.cash_games g ON g.id = l.game_id
     -- Oldest-ticked first (2026-09-06; it was created_at). With a budget
     -- that can defer the tail of the list, creation order would defer the
     -- SAME games every pass. A game deferred now is the oldest next pass.
     ORDER BY g.last_tick_at NULLS FIRST, g.created_at
  LOOP
    v_games := v_games + 1;


    -- DUE? Live, disabled, occupied or wanted: every pass. Otherwise every 30 s.
    IF NOT (
         w.state = 'live'
      OR NOT w.enabled
      OR w.anyone_seated
      OR w.eligible > 0
      OR w.last_tick_at IS NULL
      OR w.last_tick_at < v_now - interval '30 seconds'
    ) THEN
      v_rested := v_rested + 1;
      -- A RESTED GAME STILL ANSWERS "WHO ARE YOU" (2026-09-05). The controller
      -- builds its per-game row map from what this pass returns, and a wake on
      -- a game absent from that map cannot read `enabled` or find Main 1 - so
      -- the 18.4 dealer wake was skipped for precisely the dormant game a wake
      -- is for. Identity only; no result, because it was not ticked.
      v_rested_games := v_rested_games || jsonb_build_object(
        'game_id', w.game_id,
        'main1_table_id', w.main1_table_id,
        'enabled', w.enabled,
        'state', w.state
      );
      CONTINUE;
    END IF;

    -- THE BUDGET. Checked after the rest test and before a game STARTS, so
    -- a resting game is still counted as rested and `deferred` means DUE but
    -- not started; a game already ticking finishes. Deferred games answer
    -- "who are you" exactly as rested games do, so the controller's row map
    -- still knows them and a wake finds Main 1. Their last_tick_at is
    -- untouched, which is what puts them first next pass.
    IF clock_timestamp() - v_now > v_budget THEN
      v_deferred := v_deferred + 1;
      v_deferred_games := v_deferred_games || jsonb_build_object(
        'game_id', w.game_id,
        'main1_table_id', w.main1_table_id,
        'enabled', w.enabled,
        'state', w.state
      );
      CONTINUE;
    END IF;

    v_eligible := w.eligible;
    BEGIN
      v_res := public.fn_cash_cluster_tick(w.game_id, v_eligible);
      v_ticked := v_ticked + 1;
      -- THE TABLES STAY WITHIN ONE PLAYER (Dan 2026-09-05). After the tick,
      -- never before it: the must-move step has just filled the main game's
      -- open seats from the list, and balancing against the board as it was
      -- BEFORE that would move players the tick was about to move anyway.
      v_bal := public.fn_cash_cluster_balance(w.game_id, v_now);
      v_balanced := v_balanced + coalesce(v_bal, 0);
      v_results := v_results || jsonb_build_object(
        'game_id', w.game_id,
        'main1_table_id', w.main1_table_id,
        'enabled', w.enabled,
        'state', w.state,
        'balanced', coalesce(v_bal, 0),
        'result', coalesce(v_res, '{}'::jsonb)
      );
    EXCEPTION WHEN OTHERS THEN
      -- The sub-block rolled this game's tick back; the pass goes on. The
      -- error is a row, not a log line, so the next agent can find it.
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
      v_errors := v_errors + 1;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (w.game_id, w.main1_table_id, 'controller_tick_error',
              jsonb_build_object('sqlstate', v_sqlstate, 'message', v_message,
                                 'eligible_horses', v_eligible));
      v_results := v_results || jsonb_build_object(
        'game_id', w.game_id,
        'main1_table_id', w.main1_table_id,
        'enabled', w.enabled,
        'state', w.state,
        'error', jsonb_build_object('sqlstate', v_sqlstate, 'message', v_message)
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'games', v_games,
    'ticked', v_ticked,
    'errors', v_errors,
    'rested', v_rested,
    'deferred', v_deferred,
    'balanced', v_balanced,
    'elapsed_ms', round(extract(epoch from (clock_timestamp() - v_now)) * 1000),
    'results', v_results,
    -- Deferred games ride with the rested ones: identity rows, so the
    -- controller's map is complete without a new shape to parse.
    'rested_games', v_rested_games || v_deferred_games
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_clusters_tick_all(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_clusters_tick_all(jsonb) TO service_role;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_cash_clusters_tick_all' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%v_budget interval := interval ''5500 milliseconds''%' THEN
    RAISE EXCEPTION 'VERIFY: the pass carries no budget';
  END IF;
  IF v_src NOT LIKE '%set_config(''lock_timeout'', v_lock_wait, true)%' THEN
    RAISE EXCEPTION 'VERIFY: the pass sets no lock bound';
  END IF;
  IF v_src NOT LIKE '%ORDER BY g.last_tick_at NULLS FIRST, g.created_at%' THEN
    RAISE EXCEPTION 'VERIFY: the worklist is not oldest-ticked first';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_cash_clusters_tick_all(jsonb)', 'execute') THEN
    RAISE EXCEPTION 'VERIFY: a browser role can execute the pass';
  END IF;
END $$;

COMMIT;
