-- ============================================================================
-- A FROZEN ENGINE MINUTE IS NOT A STUCK MINUTE
-- ============================================================================
--
-- Measured on production (kuklfnapbkmacvwxktbh) 2026-10-03 02:30-03:05 UTC.
--
-- WHAT KEEPS THE LAUNCH GATE AT RISK
--
-- fn_ca_midway_burnin_gate needs 24 h with no new critical row in
-- ca_drift_incidents. Four tournament detectors file criticals by measuring
-- WALL-CLOCK minutes since something last happened, and the engine is
-- deliberately frozen for part of every hour: the hourly maintenance break
-- (:55 -> :00-:04, engine_maintenance_break_log, 327-588 s each) and every
-- out-of-band release break (2026-10-02: 13:11, 14:33, 15:36, 19:12, 21:05,
-- 22:42; 340-530 s each). While frozen no finish, no elimination sweep, no
-- balance and no hand can run, by design. A wait that straddles one break
-- costs ~8 minutes; two breaks back to back cost ~16.
--
-- 1. fn_ca_tournament_finished_but_not_completed (cron 304, every 5 min,
--    threshold 15). The 21:10 2026-10-02 critical: 10 Spins/SNGs decided
--    20:53:02-20:53:27, hourly break 20:55:00-21:02:29, release break
--    21:05:05-21:12:54, all paid 21:12:54-21:13:10 - the first seconds after
--    the second break ended. ~20 wall minutes, ~4.5 live minutes. The 15:05
--    and 15:45 alerts are the same shape (release breaks 14:33 and 15:36 next
--    to the 14:55 hourly break). Backtest over every non-satellite event
--    COMPLETED 2026-10-01 00:00 -> 2026-10-02 22:00 (break overlap from
--    engine_maintenance_break_log): wall >= 15 vs live >= 15 per hour -
--    10-02 15h 171 -> 0, 16h 21 -> 1, 21h 10 -> 0; every lane-saturation hour
--    keeps alerting (10-02 18h 386 -> 246, 19h 631 -> 529, 10-01 20h
--    695 -> 655). Since the cash commission batch fix (2026-10-02 19:15/19:57)
--    the live wait is p99 42-107 s per hour and max 4.8 live minutes (23:00-
--    02:00, ~1,000 completions an hour); the only waits over 3 wall minutes
--    are the ones that straddle a break (decided :52-:54, paid :00-:02).
--
-- 2. fn_ca_orphaned_running_tournaments (hourly conservation sweep at :52,
--    which runs 3-10 minutes and so evaluates its late checks inside the :55
--    break). The 20:52 2026-10-02 critical named cc4a0294 and a7f0cf4f as
--    "no engine has claimed this event, so nobody is dealing it". Both were
--    being dealt: hand_atomic_commits shows a7f0cf4f hands at 20:52:01.65,
--    :08, :15, :22, :41, :49, :54 and cc4a0294 at 20:52:24, :43, :46, 20:54:08
--    - the tournament lease row was absent for a moment (a manager stop
--    releases it before the successor claims it, GameServer
--    stopTournamentManagerIfOwned) while the tables kept dealing. The no_lease
--    branch had no dwell on the absence at all: an event older than 10
--    minutes alerted on one snapshot.
--
-- 3. fn_ca_absent_tournament_players / fn_ca_tables_that_cannot_deal (same
--    sweep). Their 2026-10-02 18:52 findings were real (engine 1c155771 had
--    stopped running elimination and balance stages; fixed by the 19:13
--    takeover) and stay detectable. They clock wall minutes too, so a bust
--    or a seat change just before an out-of-band release break reads as 10
--    stuck minutes after a 6-minute freeze.
--
-- THE CHANGE
--
-- fn_ca_engine_live_minutes(from, to): minutes in [from, to) that were NOT a
-- maintenance break - every engine_maintenance_break_log interval plus the
-- break in progress (engine_maintenance_break, enforce_freeze; counted for at
-- most 20 minutes from its start, so a row that is never cleared cannot
-- discount forever). Intervals are merged with range_agg, so an overlap is
-- never subtracted twice. Engine downtime that is not a declared break (a
-- crash, a hang) is NOT subtracted: that is exactly what these detectors are
-- for.
--
--   * finished_but_not_completed alerts when LIVE minutes since the last
--     recorded elimination reach the threshold (15), OR when wall-clock
--     minutes reach max(3 x threshold, 45) whatever the breaks. A winner
--     unpaid 45 minutes is critical even if the break log were wrong. The
--     first 200 characters of the message are unchanged (the incident bridge
--     keys on them); the context and message carry live_minutes and
--     frozen_minutes.
--   * orphaned_running no_lease alerts only when, in addition, no hand has
--     been committed on any of the event's tables for the dwell in LIVE
--     minutes (measured to clock_timestamp(), because the sweep's now() is
--     its start at :52 and its late checks run minutes later). An event that
--     is dealing is, by definition, being dealt. lease_not_renewed is
--     unchanged.
--   * absent_tournament_players and tables_that_cannot_deal keep their wall
--     prefilter and add the same live-minute condition.
--
-- Not changed: any money, seat, lease or tournament row; any severity; any
-- schedule; the alert-closing rules. No job is added.
--
-- @live-proof: (SELECT position('A FROZEN ENGINE MINUTE IS NOT A STUCK MINUTE' in pg_get_functiondef('public.fn_ca_tournament_finished_but_not_completed(integer)'::regprocedure)) > 0 AND position('A FROZEN ENGINE MINUTE IS NOT A STUCK MINUTE' in pg_get_functiondef('public.fn_ca_orphaned_running_tournaments(integer)'::regprocedure)) > 0)
-- @live-proof: (SELECT public.fn_ca_engine_live_minutes(b.break_started_at - interval '1 minute', b.break_ended_at + interval '1 minute') = 2.0 FROM public.engine_maintenance_break_log b ORDER BY b.break_started_at DESC LIMIT 1)

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.fn_ca_engine_live_minutes(p_from timestamptz, p_to timestamptz)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  /* A FROZEN ENGINE MINUTE IS NOT A STUCK MINUTE (2026-10-03). Minutes in
     [p_from, p_to) during which the engine was NOT in a declared maintenance
     break. A break in progress counts for at most 20 minutes from its start
     (fn_platform_frozen never honours one longer than 15 from announcement).
     Undeclared downtime is live time. NULL in, NULL out. */
  WITH win AS (
    SELECT tstzrange(p_from, GREATEST(p_from, p_to), '[)') AS w
  ), frozen AS (
    SELECT tstzrange(b.break_started_at, b.break_ended_at, '[)') AS r
      FROM public.engine_maintenance_break_log b
     WHERE b.break_started_at < p_to
       AND b.break_ended_at > p_from
       AND b.break_ended_at > b.break_started_at
    UNION ALL
    SELECT tstzrange(o.started, LEAST(p_to, o.started + interval '20 minutes'), '[)')
      FROM (SELECT COALESCE(m.break_started_at, m.announced_at + interval '2 minutes') AS started
              FROM public.engine_maintenance_break m
             WHERE m.enforce_freeze) o
     WHERE o.started < p_to
  ), merged AS (
    SELECT range_agg(f.r * win.w) AS m
      FROM frozen f CROSS JOIN win
     WHERE NOT isempty(f.r * win.w)
  )
  SELECT CASE WHEN p_from IS NULL OR p_to IS NULL THEN NULL::numeric ELSE
         round(GREATEST(0::numeric,
               extract(epoch FROM (GREATEST(p_from, p_to) - p_from))
               - COALESCE((SELECT sum(extract(epoch FROM (upper(x) - lower(x))))
                             FROM merged, unnest(merged.m) x), 0)) / 60.0, 1) END
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_engine_live_minutes(timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_engine_live_minutes(timestamptz, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_engine_live_minutes(timestamptz, timestamptz) TO service_role;

DO $mig$
DECLARE
  v_fn text; v_src text; v_new text; v_anchor text; v_ins text; v_n int;
  v_marker constant text := 'A FROZEN ENGINE MINUTE IS NOT A STUCK MINUTE';
  v_expect constant jsonb := jsonb_build_object(
    'fn_ca_tournament_finished_but_not_completed', 'ba367204fd36dc9a0034d56c960f4500',
    'fn_ca_orphaned_running_tournaments',         'ed7600565d0dd3573957e70ddb202f1b',
    'fn_ca_absent_tournament_players',            '29087f5ade3b9677605692048c65374c',
    'fn_ca_tables_that_cannot_deal',              'bd78d4c1db935ec06df350d85ba0a32d');
  v_edits jsonb;
  e jsonb;
BEGIN
  IF NOT (current_user IN ('postgres','service_role','supabase_admin')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  v_edits := jsonb_build_array(
    -- 1a. finished_but_not_completed: live minutes decide, wall backstop stays.
    jsonb_build_object('fn', 'fn_ca_tournament_finished_but_not_completed',
      'anchor', $a$           'stuck_for_minutes', round(extract(epoch FROM (now() - last_elimination)) / 60.0, 1))
           ORDER BY last_elimination), '[]'::jsonb)
    INTO v_count, v_sample
    FROM stuck
   WHERE alive <= 1
     AND last_elimination IS NOT NULL
     AND last_elimination < now() - v_cutoff;$a$,
      'with', $w$           'stuck_for_minutes', round(extract(epoch FROM (now() - last_elimination)) / 60.0, 1),
           'live_minutes', live_minutes,
           'frozen_minutes', round(extract(epoch FROM (now() - last_elimination)) / 60.0, 1) - live_minutes)
           ORDER BY last_elimination), '[]'::jsonb)
    INTO v_count, v_sample
    FROM (SELECT s.*,
                 public.fn_ca_engine_live_minutes(s.last_elimination, now()) AS live_minutes
            FROM stuck s
           WHERE s.alive <= 1
             AND s.last_elimination IS NOT NULL
             AND s.last_elimination < now() - v_cutoff) w
   /* A FROZEN ENGINE MINUTE IS NOT A STUCK MINUTE (2026-10-03). No finish can
      run during a declared maintenance break, so the threshold counts LIVE
      engine minutes since the last recorded elimination
      (fn_ca_engine_live_minutes). A wait of max(3 x threshold, 45) wall-clock
      minutes alerts whatever the breaks: a winner is never unpaid that long
      without a page. */
   WHERE w.live_minutes >= extract(epoch FROM v_cutoff) / 60.0
      OR w.last_elimination < now() - GREATEST(v_cutoff * 3, interval '45 minutes');$w$),
    -- 1b. finished_but_not_completed: the message says which minutes were frozen.
    jsonb_build_object('fn', 'fn_ca_tournament_finished_but_not_completed',
      'anchor', $a$           || 'and healthy tournaments settle within 20s of it (p99 over 4,242 events).',
           s->>'tournament_id', s->>'stuck_for_minutes', s->>'last_elimination',
           GREATEST(COALESCE(p_minutes, 15), 1)),$a$,
      'with', $w$           || 'and healthy tournaments settle within 20s of it (p99 over 4,242 events). '
           || '%s of those minutes were live engine time and %s were a maintenance break, '
           || 'when no finish can run; the threshold counts live minutes, and a wait of '
           || '%s wall-clock minutes alerts whatever the breaks.',
           s->>'tournament_id', s->>'stuck_for_minutes', s->>'last_elimination',
           GREATEST(COALESCE(p_minutes, 15), 1),
           s->>'live_minutes', s->>'frozen_minutes',
           GREATEST(3 * GREATEST(COALESCE(p_minutes, 15), 1), 45)),$w$),
    -- 2. orphaned_running: no lease AND nobody has dealt it for the dwell.
    jsonb_build_object('fn', 'fn_ca_orphaned_running_tournaments',
      'anchor', $a$     AND (l.tournament_id IS NULL
          OR l.heartbeat_at IS NULL
          OR l.heartbeat_at < now() - make_interval(mins => GREATEST(p_dwell_minutes, 1)))$a$,
      'with', $w$     /* A FROZEN ENGINE MINUTE IS NOT A STUCK MINUTE (2026-10-03). A missing
        lease row is a moment between a manager stop and its successor's claim
        unless nobody has dealt the event either: no_lease needs no hand
        committed on any of its tables for the dwell in LIVE engine minutes,
        measured to clock_timestamp() because the sweep's now() is its start.
        2026-10-02 20:52: both events named were dealing hands that minute. */
     AND ((l.tournament_id IS NULL
           AND public.fn_ca_engine_live_minutes(
                 GREATEST(COALESCE(t.started_at, t.created_at),
                          (SELECT max(h.committed_at)
                             FROM public.tables tb
                             CROSS JOIN LATERAL (
                               SELECT hc.committed_at
                                 FROM public.hand_atomic_commits hc
                                WHERE hc.table_id = tb.id
                                ORDER BY hc.hand_number DESC
                                LIMIT 1) h
                            WHERE tb.tournament_id = t.id)),
                 clock_timestamp()) >= GREATEST(p_dwell_minutes, 1))
          OR (l.tournament_id IS NOT NULL AND l.heartbeat_at IS NULL)
          OR l.heartbeat_at < now() - make_interval(mins => GREATEST(p_dwell_minutes, 1)))$w$),
    -- 3. absent players: the wall prefilter stays, live minutes decide.
    jsonb_build_object('fn', 'fn_ca_absent_tournament_players',
      'anchor', $a$     AND a.lost_chair_at <= now() - make_interval(mins => GREATEST(p_min_absent_minutes, 1))$a$,
      'with', $w$     AND a.lost_chair_at <= now() - make_interval(mins => GREATEST(p_min_absent_minutes, 1))
     /* A FROZEN ENGINE MINUTE IS NOT A STUCK MINUTE (2026-10-03): no
        elimination sweep runs during a declared maintenance break. */
     AND public.fn_ca_engine_live_minutes(a.lost_chair_at, now()) >= GREATEST(p_min_absent_minutes, 1)$w$),
    -- 4. tables that cannot deal: the wall prefilter stays, live minutes decide.
    jsonb_build_object('fn', 'fn_ca_tables_that_cannot_deal',
      'anchor', $a$     AND e.last_change < now() - make_interval(mins => GREATEST(p_dwell_minutes, 1))$a$,
      'with', $w$     AND e.last_change < now() - make_interval(mins => GREATEST(p_dwell_minutes, 1))
     /* A FROZEN ENGINE MINUTE IS NOT A STUCK MINUTE (2026-10-03): no balance
        stage runs during a declared maintenance break. */
     AND public.fn_ca_engine_live_minutes(e.last_change, now()) >= GREATEST(p_dwell_minutes, 1)$w$)
  );

  FOR v_fn IN SELECT DISTINCT x->>'fn' FROM jsonb_array_elements(v_edits) x LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn;
    IF v_src IS NULL THEN RAISE EXCEPTION '% not found', v_fn; END IF;
    IF position(v_marker in v_src) > 0 THEN
      RAISE NOTICE '% already carries the change; skipping', v_fn;
      CONTINUE;
    END IF;
    IF md5(v_src) <> v_expect->>v_fn THEN
      RAISE EXCEPTION '% has changed since it was measured (md5 % <> %) - re-read it before editing',
        v_fn, md5(v_src), v_expect->>v_fn;
    END IF;
    v_new := v_src;
    FOR e IN SELECT x FROM jsonb_array_elements(v_edits) x WHERE x->>'fn' = v_fn LOOP
      v_anchor := e->>'anchor';
      v_ins := e->>'with';
      v_n := (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'anchor in % appears % times, expected exactly 1', v_fn, v_n;
      END IF;
      v_new := replace(v_new, v_anchor, v_ins);
    END LOOP;
    IF v_new = v_src OR position(v_marker in v_new) = 0 THEN
      RAISE EXCEPTION 'substitution in % produced no marked change', v_fn;
    END IF;
    EXECUTE v_new;
  END LOOP;
END
$mig$;

-- Prove the helper on known shapes and the detectors still run.
DO $prove$
DECLARE
  b record;
  v jsonb;
BEGIN
  SELECT * INTO b FROM public.engine_maintenance_break_log ORDER BY break_started_at DESC LIMIT 1;
  IF public.fn_ca_engine_live_minutes(b.break_started_at - interval '1 minute',
                                      b.break_ended_at + interval '1 minute') <> 2.0 THEN
    RAISE EXCEPTION 'a window of one break plus two live minutes must read 2.0 live minutes';
  END IF;
  IF public.fn_ca_engine_live_minutes(b.break_started_at + interval '10 seconds',
                                      b.break_ended_at - interval '10 seconds') <> 0 THEN
    RAISE EXCEPTION 'a window inside a break must read 0 live minutes';
  END IF;
  IF public.fn_ca_engine_live_minutes(b.break_ended_at + interval '1 second',
                                      b.break_ended_at + interval '61 seconds') <> 1.0 THEN
    RAISE EXCEPTION 'the minute after a break must read one live minute';
  END IF;
  IF public.fn_ca_engine_live_minutes(NULL, now()) IS NOT NULL THEN
    RAISE EXCEPTION 'NULL in must be NULL out';
  END IF;
  PERFORM count(*) FROM public.fn_ca_orphaned_running_tournaments(10);
  PERFORM count(*) FROM public.fn_ca_absent_tournament_players(10);
  PERFORM count(*) FROM public.fn_ca_tables_that_cannot_deal(5);
END
$prove$;

COMMIT;
