-- 20261003223747_a_cluster_wake_does_not_queue_behind_the_pass.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A CLUSTER WAKE DOES NOT QUEUE BEHIND THE PASS (phase 7 of 9: availability).
-- Full account:
-- docs/changelog/2026-10-03-a-cluster-wake-does-not-queue-behind-the-pass.md.
--
-- The engine ticks a must-move Cluster two ways: the 5-second pass
-- (fn_cash_clusters_tick_all, one transaction over every due game, budget
-- 5.5 s) and a per-game wake after a seat change or a hand
-- (ClusterController.tickGame -> fn_cash_cluster_tick). The pass holds every
-- game row it ticked until the whole pass commits, so a wake for one of
-- those games waited behind the rest of the pass. Production, 21:00-22:40 UTC
-- 2026-10-03 (pg_stat_statements): 27,682 wakes, 8,486 s, mean 307 ms, max
-- 5.8 s; a 20-second lock sample found fn_cash_cluster_tick waiting on a
-- cash_games row held by fn_cash_clusters_tick_all in 55 of 80 readings.
-- Each wait holds a PostgREST connection and a backend for nothing: the pass
-- is ticking that game, and the next pass ticks it again.
--
-- Called by the pass (which publishes ca.cluster_pass_deadline), the tick
-- locks its row exactly as before. Called alone, it takes the row with SKIP
-- LOCKED and, if somebody holds it, returns {ok:false, reason:
-- 'ticking_elsewhere'} at once. ClusterController.afterGameTick does nothing
-- with a result that has no actions and no seated_total, so the engine needs
-- no change. No money moves; only this lock and its two returns change.
--
-- Applied as a substitution on the live text (pinned by md5, exactly one
-- occurrence, reverse substitution reproduces the pin, privileges unchanged):
-- the live body was last written by hand-applied DO blocks and is not in this
-- repository as a CREATE statement.
--
-- @live-proof: (SELECT position('A WAKE DOES NOT QUEUE BEHIND THE PASS' IN pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $subs$
DECLARE
  v_sig regprocedure := 'public.fn_cash_cluster_tick(uuid,integer)'::regprocedure;
  v_def text; v_old text; v_new text; v_n integer; v_after text; v_acl text;
BEGIN
  v_def := pg_get_functiondef(v_sig);
  IF md5(v_def) <> '8b1223ad422f9a147e6719c8522217b9' THEN
    RAISE EXCEPTION 'fn_cash_cluster_tick is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;\n'
        || E'  IF NOT FOUND THEN RETURN jsonb_build_object(\'ok\', false, \'reason\', \'not_found\'); END IF;\n';
  v_new := E'  /* A WAKE DOES NOT QUEUE BEHIND THE PASS (2026-10-03). Called by the pass\n'
        || E'     (fn_cash_clusters_tick_all publishes ca.cluster_pass_deadline), the tick\n'
        || E'     waits for its row as before, bounded by the pass\'s lock_timeout. Called\n'
        || E'     alone, as the engine\'s per-game wake, it takes the row only if nobody\n'
        || E'     holds it: a held row means the pass (or another wake) is ticking this\n'
        || E'     game now, and the next pass ticks it again in five seconds. Waiting\n'
        || E'     cost 27,682 wakes 8,486 s in 100 minutes (mean 307 ms, max 5.8 s),\n'
        || E'     almost all of it behind the pass\'s transaction. */\n'
        || E'  IF COALESCE(current_setting(\'ca.cluster_pass_deadline\', true), \'\') = \'\' THEN\n'
        || E'    SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE SKIP LOCKED;\n'
        || E'    IF NOT FOUND THEN\n'
        || E'      IF EXISTS (SELECT 1 FROM public.cash_games cg WHERE cg.id = p_game_id) THEN\n'
        || E'        RETURN jsonb_build_object(\'ok\', false, \'reason\', \'ticking_elsewhere\', \'locked\', false);\n'
        || E'      END IF;\n'
        || E'      RETURN jsonb_build_object(\'ok\', false, \'reason\', \'not_found\');\n'
        || E'    END IF;\n'
        || E'  ELSE\n'
        || E'    SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;\n'
        || E'    IF NOT FOUND THEN RETURN jsonb_build_object(\'ok\', false, \'reason\', \'not_found\'); END IF;\n'
        || E'  END IF;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the replaced row lock occurs % times, expected exactly 1', v_n;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = v_sig;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef(v_sig);
  IF md5(v_after) <> md5(replace(v_def, v_old, v_new)) THEN
    RAISE EXCEPTION 'fn_cash_cluster_tick is not its intended post-image (md5 %)', md5(v_after);
  END IF;
  IF md5(replace(v_after, v_new, v_old)) <> '8b1223ad422f9a147e6719c8522217b9' THEN
    RAISE EXCEPTION 'the reverse substitution does not reproduce the pinned text';
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_sig) IS DISTINCT FROM v_acl
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_cash_cluster_tick: its privileges changed';
  END IF;
  RAISE NOTICE 'fn_cash_cluster_tick post-image md5 %', md5(v_after);
END $subs$;

COMMIT;
