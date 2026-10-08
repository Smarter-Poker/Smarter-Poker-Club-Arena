-- 20261008150332_a_satellite_with_one_player_left_is_watched_like_any_event.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- A SATELLITE WITH ONE PLAYER LEFT IS WATCHED LIKE ANY EVENT
-- ============================================================================
--
-- fn_ca_tournament_finished_but_not_completed (cron
-- ca-tournament-finished-not-completed-5m) pages a RUNNING event that is down
-- to one player or fewer and has not completed, but skipped satellites ("a
-- satellite awards seats, not prizes, and finishes on its own terms").
-- fn_ca_tournament_dark_while_running (20261008113537) covers an event with
-- two or more live players. So a single-winner satellite stuck on its last
-- player was watched by neither.
--
-- Measured on production, seven days to 2026-10-08: 12 of 122 single-winner
-- satellites took more than 15 minutes from their deciding bust to
-- completion (healthy finishes settle in ~20 s), up to 101 minutes
-- (c2a1ece4 "Saturday Night Big Stack Satellite", 82 live minutes), all
-- 2026-10-01 to 2026-10-03, none paged. No RUNNING satellite is at one
-- player or fewer at apply time, so this raises nothing on its own.
--
-- THE CHANGE: the two satellite exclusions are removed from the watch, so the
-- two watches together cover every RUNNING event of every format: two or more
-- live players by the dark watch, one or fewer by this one. Thresholds,
-- message, dedupe and resolve behaviour are unchanged.
--
-- @live-proof: (SELECT position('<> ''satellite''' in pg_get_functiondef('public.fn_ca_tournament_finished_but_not_completed(integer)'::regprocedure)) = 0)

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  v_src text; v_anchor text; v_n int; v_md5 text;
BEGIN
  v_src := pg_get_functiondef('public.fn_ca_tournament_finished_but_not_completed(integer)'::regprocedure);
  v_anchor := $a$       AND COALESCE(t.variant, '') <> 'satellite'
       AND upper(COALESCE(t.tournament_type, '')) <> 'SATELLITE'
$a$;
  IF position(v_anchor in v_src) = 0 THEN
    RAISE NOTICE 'fn_ca_tournament_finished_but_not_completed already watches satellites; skipping';
    RETURN;
  END IF;
  v_md5 := md5(v_src);
  IF v_md5 <> 'e1cb59df1f2c84bd0441a31bb99a0c2d' THEN
    RAISE EXCEPTION 'preimage: fn_ca_tournament_finished_but_not_completed is % - re-read this edit against the live body', v_md5;
  END IF;
  v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the watch carries the satellite exclusion % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_src, v_anchor, '');
END
$mig$;

DO $prove$
BEGIN
  IF position('<> ''satellite''' in pg_get_functiondef('public.fn_ca_tournament_finished_but_not_completed(integer)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'the unfinished-finish watch still skips satellites';
  END IF;
END
$prove$;

COMMIT;
