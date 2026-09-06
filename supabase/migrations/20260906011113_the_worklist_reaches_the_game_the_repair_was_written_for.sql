-- THE WORKLIST REACHES THE GAME THE REPAIR WAS WRITTEN FOR (2026-09-05)
--
-- Three findings from the audit of the cluster surface, all in these two
-- functions, all fixed together because they are one round trip.
--
-- 1. A REPAIR THAT CANNOT REACH THE STATE IT EXISTS TO REPAIR.
--    `fn_cash_cluster_tick` gained `lifecycle_followed_status` (20260905083756)
--    for exactly one shape: a table left at `lifecycle = 'live'` with
--    `status = 'closed'`, which the census drops and the roles step still
--    counts. But `fn_cash_clusters_to_tick` admits a DISABLED game only when
--    it still has a table whose status is one of waiting/running/active - so a
--    disabled game whose only table is in precisely that state is never on the
--    worklist, is never ticked, and the repair never runs.
--    MEASURED 2026-09-05: 14 such games (NLH 0.01/0.02 Classic, PLO5 0.05/0.10
--    Classic, FLH 0.50/1 Action, FLH 0.50/1 Madness, Short Deck 1/2 Classic and
--    nine more), every one with `last_tick_at IS NULL` - never ticked once
--    since the controller was built. No seats on any of them, so no player is
--    affected; the rows simply never resolve.
--    FIX: for a disabled game the worklist asks only that a table is not
--    closed. An enabled game is unchanged (it is admitted on `g.enabled`
--    alone), and a game with nothing open is still absent.
--
-- 2. `poker_cluster_games{state}` IS A GAUGE NOTHING SETS. The one-RPC pass
--    (20260905091025) selects `l.state` for its due-rule and then leaves it out
--    of the per-game result, so `ClusterMetrics.recordPass` never receives it
--    and the Grafana panel renders an empty series. FIX: the result entries
--    carry `state`.
--
-- 3. A RESTED GAME IS INVISIBLE TO THE WAKE. A game that rests (dormant,
--    nobody seated, no eligible horse, ticked within 30 s) is `CONTINUE`d
--    before its entry is built, so it appears in no result. `ClusterController`
--    builds `rowByGame` from the results, so `wake(gameId)` on a rested game
--    finds no row, reads `enabled` as false and skips the 18.4 dealer wake -
--    for exactly the game a wake exists to serve. It self-corrects on the next
--    5 s pass, so the cost is bounded, but the wake is the thing that is
--    supposed to beat the pass. FIX: the pass returns a `rested` roster
--    (`rested_games`) of the games it skipped, with the same identity fields,
--    so the controller can wake one immediately.
--
-- Neither function is changed in any other way. Both are re-declared whole
-- with their live md5 asserted before and after, because both have been
-- edited by string substitution in the past and no file held the result.
--
-- ROLLBACK: re-apply 20260905091025 for fn_cash_clusters_tick_all and
-- 20260905010500 (as amended) for fn_cash_clusters_to_tick.
--
-- One transaction (production DDL policy, CLAUDE.md section 2). Two function
-- re-declarations, one schema-cache reload.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE v_a text; v_b text;
BEGIN
  SELECT md5(prosrc) INTO v_a FROM pg_proc WHERE proname = 'fn_cash_clusters_to_tick' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_b FROM pg_proc WHERE proname = 'fn_cash_clusters_tick_all' AND pronamespace = 'public'::regnamespace;
  IF v_b IS DISTINCT FROM 'a1464cd2227b772521aede2282c19f99' THEN
    RAISE EXCEPTION 'fn_cash_clusters_tick_all is % (expected a1464cd2227b772521aede2282c19f99) - rebase this migration on the live source', coalesce(v_b, 'absent');
  END IF;
  IF v_a IS NULL THEN
    RAISE EXCEPTION 'fn_cash_clusters_to_tick is absent';
  END IF;
END
$guard$;

-- ── 1. The worklist ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_cash_clusters_to_tick()
RETURNS TABLE (game_id uuid, club_id uuid, main1_table_id uuid, state text, enabled boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT g.id, g.club_id,
         (SELECT t.id FROM public.tables t WHERE t.cluster_id = g.id AND t.role = 'main' AND t.main_index = 1
            AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false ORDER BY t.created_at LIMIT 1),
         g.state, g.enabled
    FROM public.cash_games g
   WHERE g.must_move
     -- A DISABLED GAME IS ADMITTED ON LIFECYCLE ALONE (2026-09-05). This used
     -- to require status IN ('waiting','running','active') as well, and a
     -- table stranded at lifecycle='live' with status='closed' satisfies the
     -- lifecycle test and fails the status one - which is the exact shape
     -- `lifecycle_followed_status` was written to repair. Fourteen games sat
     -- that way, never ticked once.
     AND (g.enabled OR EXISTS (SELECT 1 FROM public.tables t
                                WHERE t.cluster_id = g.id
                                  AND t.lifecycle <> 'closed'
                                  AND coalesce(t.is_deleted, false) = false))
   ORDER BY g.created_at;
$$;

REVOKE ALL ON FUNCTION public.fn_cash_clusters_to_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_clusters_to_tick() TO service_role;

-- ── 2 and 3. The pass ───────────────────────────────────────────────────────
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
  v_eligible integer;
  v_res jsonb;
  v_results jsonb := '[]'::jsonb;
  v_rested_games jsonb := '[]'::jsonb;
  v_sqlstate text;
  v_message text;
BEGIN
  -- THE FREEZE (CLAUDE.md 13): the same short-circuit the per-game tick has,
  -- taken once for the pass so a frozen platform costs one row read.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'skipped', 'frozen',
                              'games', 0, 'ticked', 0, 'errors', 0, 'rested', 0,
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

    v_eligible := w.eligible;
    BEGIN
      v_res := public.fn_cash_cluster_tick(w.game_id, v_eligible);
      v_ticked := v_ticked + 1;
      v_results := v_results || jsonb_build_object(
        'game_id', w.game_id,
        'main1_table_id', w.main1_table_id,
        'enabled', w.enabled,
        'state', w.state,
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
    'results', v_results,
    'rested_games', v_rested_games
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_clusters_tick_all(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_clusters_tick_all(jsonb) TO service_role;

DO $post$
DECLARE v_src text; v_stranded integer;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_cash_clusters_to_tick' AND pronamespace = 'public'::regnamespace;
  IF position('A DISABLED GAME IS ADMITTED ON LIFECYCLE ALONE' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the worklist still requires a status on a disabled game';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_cash_clusters_tick_all' AND pronamespace = 'public'::regnamespace;
  IF position('rested_games' IN v_src) = 0 OR position('''state'', w.state' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the pass does not return state or the rested roster';
  END IF;

  -- The fourteen are now reachable. They are not repaired yet - the tick does
  -- that on its next pass - but they must be ON the worklist.
  SELECT count(*) INTO v_stranded
    FROM public.cash_games g
   WHERE NOT g.enabled AND g.must_move
     AND EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g.id
                  AND t.lifecycle = 'live' AND t.status = 'closed')
     AND NOT EXISTS (SELECT 1 FROM public.fn_cash_clusters_to_tick() l WHERE l.game_id = g.id);
  IF v_stranded > 0 THEN
    RAISE EXCEPTION '% disabled game(s) with a live/closed table are still off the worklist', v_stranded;
  END IF;
END
$post$;

COMMIT;
