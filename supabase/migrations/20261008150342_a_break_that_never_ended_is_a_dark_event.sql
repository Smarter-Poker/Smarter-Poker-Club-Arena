-- 20261008150342_a_break_that_never_ended_is_a_dark_event.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- A BREAK THAT NEVER ENDED IS A DARK EVENT
-- ============================================================================
--
-- fn_ca_tournament_dark_candidates (20261008140537) skipped every RUNNING
-- event with on_break set, so an event whose break never resumed was invisible
-- to the dark watch, the five-minute page built on it, and the engine's dark
-- rebuild. That state is not hypothetical: on 2026-08-25 seven tournaments
-- carried on_break = true with no live break, the oldest for 41 hours
-- (TournamentManagerBase resume, "A BREAK WHOSE COUNTDOWN NEVER STARTED IS
-- STILL A BREAK").
--
-- A tournament's own break is five minutes plus a last-hand grace; the
-- maintenance break is excluded by live-minute accounting anyway. So an
-- event still flagged on_break thirty minutes after its break started (or,
-- with no break_started_at, thirty minutes after the row last changed) is
-- stuck, and it is now a candidate exactly like any other dark event. A
-- rebuild cures it: a resumed manager clears an expired break and resumes
-- play (TournamentManagerBase resume, "The break already expired while we
-- were down").
--
-- At apply time six RUNNING events are on break, none for more than thirty
-- minutes, so this changes no reading on its own.
--
-- @live-proof: (SELECT position('interval ''30 minutes''' in pg_get_functiondef('public.fn_ca_tournament_dark_candidates(integer)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  v_src text; v_anchor text; v_ins text; v_n int; v_md5 text;
BEGIN
  v_src := pg_get_functiondef('public.fn_ca_tournament_dark_candidates(integer)'::regprocedure);
  IF position('interval ''30 minutes''' in v_src) > 0 THEN
    RAISE NOTICE 'fn_ca_tournament_dark_candidates already reads a stuck break as dark; skipping';
    RETURN;
  END IF;
  v_md5 := md5(v_src);
  IF v_md5 <> 'd68ae55ff9d1684a5046f98ea44468a7' THEN
    RAISE EXCEPTION 'preimage: fn_ca_tournament_dark_candidates is % - re-read this edit against the live body', v_md5;
  END IF;
  v_anchor := $a$     WHERE t.status = 'RUNNING'
       AND COALESCE(t.on_break, false) IS NOT TRUE
$a$;
  v_ins := $i$     WHERE t.status = 'RUNNING'
       AND (COALESCE(t.on_break, false) IS NOT TRUE
            OR COALESCE(t.break_started_at, t.updated_at) < now() - interval '30 minutes')
$i$;
  v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the candidates read carries the break filter % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_src, v_anchor, v_ins);
END
$mig$;

DO $prove$
BEGIN
  IF position('interval ''30 minutes''' in pg_get_functiondef('public.fn_ca_tournament_dark_candidates(integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'a break that never ended is still invisible to the dark watch';
  END IF;
END
$prove$;

COMMIT;
