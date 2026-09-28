-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906013826; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906013826   (the stamp IS the apply time, UTC: 2026-09-06 01:38:26)
--   name        the_balancer_carries_the_rested_games_forward
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 5581 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906013826 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_cash_clusters_tick_all
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- REPAIR (2026-09-06). 20260906011318 re-emitted fn_cash_clusters_tick_all
-- from the 20260905091025 baseline and applied two minutes AFTER
-- 20260906011113, which had re-declared the same function WHOLE. The later
-- apply therefore clobbered that migration's work: `rested_games` (the
-- identity rows a wake on a DORMANT game needs - without them the 18.4 dealer
-- wake is skipped for precisely the game a wake is for), the per-result
-- `state` field, `eligible_horses` on the error payload, and the error entry
-- appended to `results`. This is that body, verbatim, plus the balance call.
--
-- The lesson, written into the repo comment too: re-emitting a whole function
-- means reading the LIVE body first, not the migration you happen to have
-- open. Two agents re-declared this function inside three minutes.

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
BEGIN
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
    'balanced', v_balanced,
    'results', v_results,
    'rested_games', v_rested_games
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_clusters_tick_all(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_clusters_tick_all(jsonb) TO service_role;
