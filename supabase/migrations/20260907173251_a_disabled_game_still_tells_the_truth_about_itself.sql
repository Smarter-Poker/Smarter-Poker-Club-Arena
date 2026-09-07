-- 20260907173251_a_disabled_game_still_tells_the_truth_about_itself.sql
--
-- A DISABLED GAME STILL TELLS THE TRUTH ABOUT ITSELF.
--
-- Section 7 of fn_cash_cluster_tick decides whether a game is live or dormant
-- from whether anybody is sitting in it, and then writes it down only if the
-- game is ENABLED:
--
--     v_new_state := CASE WHEN v_seated_total = 0 AND ... THEN 'dormant' ELSE 'live' END;
--     IF g.enabled AND g.state IS DISTINCT FROM v_new_state THEN
--
-- `enabled` is the host's switch for whether a game may OPEN tables. It has
-- nothing to do with whether `state` is accurate, and coupling them means a
-- game disabled while live can never be corrected: the tick refuses to write
-- the new state, its tables eventually close, and fn_cash_clusters_to_tick then
-- stops admitting it altogether -
--
--     WHERE g.must_move AND (g.enabled OR EXISTS (non-closed table))
--
-- - because it is neither enabled nor holding a table. The cleanup needs the
-- tick, and the tick is exactly what it can no longer get. A self-referential
-- dead end.
--
-- Measured on production 2026-09-07: three games in state 'live', enabled
-- false, with zero non-closed tables and zero seated players, last ticked
-- 2026-09-06 00:52, 01:27 and 02:31 - stranded for 38 hours and unreachable.
--
-- They are not player-facing: get_club_home builds its lobby rows FROM tables
-- and collapses a cluster to its Main 1 row, so a game with no tables paints
-- nothing. What they are is a row that says 'live' and is not, waiting for the
-- next person to read cash_games.state and believe it. I nearly did: an earlier
-- pass of this audit checked for stale ticks with `state = 'open'`, a value this
-- column has never held, and reported a clean zero.
--
-- One flag governing two unrelated things, with the truth as the casualty.
--
-- After this, a disabled game with nobody seated goes dormant on its next tick,
-- which happens while it still has tables and is therefore still selectable.
-- A disabled game that somehow still holds players stays 'live', truthfully,
-- until they leave. The selector needs no change.
--
-- Applied as an asserted single substitution on the live definition rather than
-- a retyped 38KB body; it fails if the search text is not found exactly once.
--
-- One transaction, per the production DDL policy in CLAUDE.md section 2.

BEGIN;

DO $patch$
DECLARE v_old text; v_new text; v_find text; v_repl text; v_hits integer;
BEGIN
  v_old := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);

  v_find := '  IF g.enabled AND g.state IS DISTINCT FROM v_new_state THEN';

  v_repl := '  -- NOT gated on g.enabled (2026-09-07). `enabled` says whether this game
  -- may OPEN tables; it has nothing to do with whether `state` is true. Three
  -- games sat at ''live'' with no tables and nobody in them for 38 hours
  -- because a disabled game could never be corrected, and once its last table
  -- closed fn_cash_clusters_to_tick stopped admitting it at all.
  IF g.state IS DISTINCT FROM v_new_state THEN';

  SELECT count(*) INTO v_hits
    FROM regexp_matches(v_old, regexp_replace(v_find, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly one enabled-gated state write, found %', v_hits;
  END IF;

  v_new := replace(v_old, v_find, v_repl);
  IF v_new = v_old THEN RAISE EXCEPTION 'the substitution changed nothing'; END IF;
  EXECUTE v_new;
END $patch$;

-- The three already stranded. Nobody is seated in any of them and none has an
-- open table, so 'dormant' is simply what they are.
WITH corrected AS (
  UPDATE public.cash_games g
     SET state = 'dormant', updated_at = now()
   WHERE g.state = 'live'
     AND NOT g.enabled
     AND NOT EXISTS (SELECT 1 FROM public.tables t
                      WHERE t.cluster_id = g.id AND t.lifecycle <> 'closed'
                        AND coalesce(t.is_deleted, false) = false)
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts
                       JOIN public.tables t2 ON t2.id = ts.table_id
                      WHERE t2.cluster_id = g.id AND ts.left_at IS NULL)
  RETURNING g.id
)
INSERT INTO public.cash_cluster_events (game_id, kind, payload)
SELECT id, 'game_dormant',
       jsonb_build_object('seated_total', 0, 'reason', 'stranded_live_with_no_tables')
  FROM corrected;

DO $assert$
DECLARE v_def text; v_left integer;
BEGIN
  v_def := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);
  IF position('IF g.enabled AND g.state IS DISTINCT FROM v_new_state THEN' in v_def) <> 0 THEN
    RAISE EXCEPTION 'the state write is still gated on enabled';
  END IF;
  IF position('IF g.state IS DISTINCT FROM v_new_state THEN' in v_def) = 0 THEN
    RAISE EXCEPTION 'the ungated state write is not there';
  END IF;

  SELECT count(*) INTO v_left FROM public.cash_games g
   WHERE g.state = 'live' AND NOT g.enabled
     AND NOT EXISTS (SELECT 1 FROM public.tables t
                      WHERE t.cluster_id = g.id AND t.lifecycle <> 'closed'
                        AND coalesce(t.is_deleted, false) = false);
  IF v_left <> 0 THEN
    RAISE EXCEPTION '% game(s) still stranded at live with no tables', v_left;
  END IF;
END $assert$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) TO service_role;

COMMIT;
