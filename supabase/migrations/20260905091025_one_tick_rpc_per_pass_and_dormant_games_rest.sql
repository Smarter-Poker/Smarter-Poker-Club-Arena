-- 20260905091025_one_tick_rpc_per_pass_and_dormant_games_rest.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- ONE TICK RPC PER PASS (Operation Table Stakes, Slice 6 follow-up, 2026-09-05).
--
-- The cluster controller (server/src/cluster/ClusterController.ts, OPORD 1.4
-- section 18.2) ran every 5 s on the leader as ONE worklist RPC followed by
-- ONE fn_cash_cluster_tick RPC PER GAME through an eight-wide pool. With 149
-- games (119 enabled) that is 150 PostgREST round trips a pass, 12 passes a
-- minute, ~86,000 RPCs an hour - and the overwhelming majority of those ticks
-- read the rows, found nothing to do, and wrote last_tick_at. Pass length was
-- fine; the shape was not, and every RPC is a round trip from Hetzner.
--
-- This migration adds fn_cash_clusters_tick_all(p_eligible jsonb): the whole
-- pass in one call. It reads the same worklist (fn_cash_clusters_to_tick,
-- untouched), decides which games are DUE, and calls the existing per-game
-- fn_cash_cluster_tick for each inside its own sub-block, so one game's error
-- is caught, written to cash_cluster_events as controller_tick_error, and the
-- pass continues. fn_cash_cluster_tick itself is NOT redeclared here (another
-- branch owns it); this is a wrapper around whatever body is live.
--
-- p_eligible is keyed by MAIN 1 TABLE ID, not game id: the fleet's census is
-- per table (HorseFleetManager.eligibleCounts()), and keying by the table lets
-- the controller send the whole map without first asking which game owns
-- which table. That is what makes the pass one RPC instead of two.
--
-- DORMANT GAMES REST. A game is due every pass when it is live, when it is
-- disabled (its tables must drain), when ANYONE is seated at any of its
-- tables (a lone human at a dormant Main 1 still needs a dealer inside 5 s),
-- or when the fleet reports a horse could sit at it (a horse is a buyer, Law
-- 10.5). Otherwise - dormant, enabled, nobody seated, no horse eligible - it
-- is due when last_tick_at is null or older than 30 s. Nothing can happen to
-- such a game between ticks that the next tick would not see the same way,
-- and a seat change wakes it from the engine side anyway (ClusterController
-- .wake, in-process, no LISTEN/NOTIFY).
--
-- The whole pass is one transaction, so every game's row lock is held until
-- the call returns. Each game's tick is milliseconds, so a seat-change request
-- or a wake that wants one game's lock waits at most one pass.
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
AS $$
DECLARE
  w record;
  v_now timestamptz := clock_timestamp();
  v_games integer := 0;
  v_ticked integer := 0;
  v_errors integer := 0;
  v_rested integer := 0;
  v_eligible integer;
  v_res jsonb;
  v_results jsonb := '[]'::jsonb;
  v_sqlstate text;
  v_message text;
BEGIN
  -- THE FREEZE (CLAUDE.md 13): the same short-circuit the per-game tick has,
  -- taken once for the pass so a frozen platform costs one row read.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'skipped', 'frozen',
                              'games', 0, 'ticked', 0, 'errors', 0, 'rested', 0,
                              'results', '[]'::jsonb);
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
     ORDER BY g.created_at
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
      CONTINUE;
    END IF;

    v_eligible := w.eligible;
    BEGIN
      v_res := public.fn_cash_cluster_tick(w.game_id, v_eligible);
      v_ticked := v_ticked + 1;
      v_results := v_results || jsonb_build_object(
        'game_id', w.game_id,
        'main1_table_id', w.main1_table_id,
        'enabled', w.enabled,
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
    'results', v_results
  );
END;
$$;

COMMENT ON FUNCTION public.fn_cash_clusters_tick_all(jsonb) IS
  'One cluster-controller pass in one call (OPORD 1.4 s18.2). p_eligible is {main1_table_id: eligible_horses}. Live, disabled, occupied or horse-wanted games tick every pass; a dormant empty game every 30 s. Per-game errors are caught and written to cash_cluster_events as controller_tick_error.';

REVOKE ALL ON FUNCTION public.fn_cash_clusters_tick_all(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_clusters_tick_all(jsonb) TO service_role;

-- The wrapper is only as good as the function it wraps: assert the per-game
-- tick it calls still has the signature this body uses.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_cash_cluster_tick'
       AND pg_get_function_arguments(p.oid) LIKE 'p_game_id uuid, p_eligible_horses integer%'
  ) THEN
    RAISE EXCEPTION 'fn_cash_cluster_tick(p_game_id uuid, p_eligible_horses integer) is not declared; fn_cash_clusters_tick_all would fail on its first game';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_cash_clusters_to_tick'
  ) THEN
    RAISE EXCEPTION 'fn_cash_clusters_to_tick() is not declared';
  END IF;
END $$;

COMMIT;
