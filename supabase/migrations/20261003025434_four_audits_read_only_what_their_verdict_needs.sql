-- ===========================================================================
--  FOUR AUDITS READ ONLY WHAT THEIR VERDICT NEEDS
-- ===========================================================================
--
-- Launch-gate sweep, 2026-10-03. Read from cron.job_run_details on production
-- (6 hours to 02:20 UTC) and timed against production 02:35-03:00 UTC with
-- read-only queries and rolled-back pg_temp copies of each rewritten body.
--
-- These four audits were cancelled more often than they finished, so the
-- invariant each guards went unchecked for that run. ca-stats-witness-audit
-- runs every 15 minutes, so it can reach fn_ca_cron_failure_watch's threshold
-- (5 failures and no success in 2 hours) and file an "unknown" incident that
-- holds fn_ca_midway_burnin_gate red; it did on 2026-09-30 and 2026-10-01.
-- Each change keeps the verdict row for row; none narrows what is covered.
--
-- 1. fn_ca_ratchet_watch (job 214, 5 of 6 cancelled at 300 s).
--    The rake_law_violations_24h ratchet counted
--      fn_rake_law_violations('2 hours') WHERE kind IN
--        ('no_flop_no_drop','over_cap','over_percent')
--    but that SQL function carries SET search_path, so it is never inlined
--    and the outer filter cannot prune it: every run computed all nine kinds,
--    including fn_effective_rake and fn_effective_bbj_drop for every flopped
--    hand in two hours. 'over_cap' and 'over_percent' are not kinds it emits.
--    The ratchet now counts no_flop_no_drop directly with that function's own
--    rule (same tables, same window, same predicate). Measured 7.5 s; the
--    other seven ratchets measured 43 s together.
--
-- 2. fn_spin_unpaid_check (job 143, 3 of 6 cancelled at 120 s, ok up to
--    117 s). v_spin_unpaid_settlements aggregates the reserve ledger, every
--    prize/refund credit and (for seat_shape/unranked_seats) every
--    tournament_players row before the window applies, and the function read
--    it twice, the second time with the seat aggregate. Now one pass without
--    the seat columns gives every counter and the alert candidates, and the
--    seat columns are read per alerted tournament (tournament_id = $1 pushes
--    into every aggregate: 40 ms measured). 9.6 s measured; same output.
--
-- 3. fn_ca_settlement_correctness_check (job 178, 3 of 6 cancelled at 120 s).
--    Section G materialised ~885,000 hands of the last 24 hours and their
--    receipts every hour, to evaluate a 24-hour adoption gate that only
--    matters when the last hour is short of receipts. The hour is now read
--    first (17.3 s) and the day exactly as before only when the hour would
--    fire. Whole function 10.5 s in a rolled-back copy; it found the one
--    finding already open (rakeback-evidence, warning). It is a watched guard,
--    so the redefinition is declared.
--
-- 4. ca_stats_witness_audit (job 263, 49-283 s per run, cancelled at 300 s).
--    2d probed ca_hand_player_idx per seat through its (user_id, hand_id)
--    primary key - 37,949 random probes, 27.3 s - and now fetches the
--    window's index rows once by hand_id (16.0 s). 2f hashed the 801,620-row
--    seven-day candidate set to join it back to ~3,600 per-hand verdicts
--    (32-35 s, spilling to temp) and now judges each seat in one pass, reading
--    the action log only for seats without a figure. Whole function 31.7 s in
--    a rolled-back copy, with the same counts the live job logged.
--
-- HOW. Each body is edited by exact substitution through a pg_temp helper:
-- the live text must hash to the pinned preimage, each anchor must occur
-- exactly once, the substituted text must hash to the derived postimage
-- (computed read-only on production: pg_get_functiondef re-emits the body
-- verbatim), and owner, SECURITY DEFINER, proconfig and grants must not move.
-- No schedule, grant, index or table changes. The helper lives in pg_temp and
-- ends with the session that applied this file.
-- ===========================================================================
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_ratchet_watch()'::regprocedure)) = '0a39cfd46d44e3bb0863d4049a3a1924' AND md5(pg_get_functiondef('public.fn_spin_unpaid_check(integer)'::regprocedure)) = '483f09fc67a627b961e20a273249269d' AND md5(pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure)) = 'a58c53d6d111fe2d9a9b966a2144e769' AND md5(pg_get_functiondef('public.ca_stats_witness_audit(integer,integer)'::regprocedure)) = 'fbea24b80e755d047b6177b0c1f1fd56')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_ratchet_watch()',
  '420c3f077b89c7a1aef11d17d265636e', '0a39cfd46d44e3bb0863d4049a3a1924',
  ARRAY[$o$      SELECT count(*)::int INTO v_current
        FROM public.fn_rake_law_violations('2 hours'::interval)
       WHERE kind IN ('no_flop_no_drop','over_cap','over_percent');
$o$],
  ARRAY[$n$      /* THE ONE KIND THIS RATCHET COUNTS, READ DIRECTLY (2026-10-03).
         fn_rake_law_violations computes nine finding kinds, including
         fn_effective_rake and fn_effective_bbj_drop for every flopped hand
         in the window; it is a SQL function with SET search_path, so it is
         never inlined and an outer WHERE kind IN (...) cannot prune it. Of
         the three kinds this ratchet counts, 'over_cap' and 'over_percent'
         are not kinds that function emits; the one that exists is
         no_flop_no_drop, whose rule there is: a non-tournament hand on a
         non-tournament table in (now()-2h, now()-5min) with no board
         (board_n = 0), no showdown, and rake + BBJ drop > 0.005, where BBJ
         is COALESCE(rake_records.bbj_contribution, hand_history.bbj_amount,
         0). This is that rule, row for row (rake_records.hand_id is unique;
         the clubs join it also carries is a left join on a key and cannot
         change a count). Measured on production 2026-10-03: the old call
         was cancelled at 300 s in 5 of 6 runs; this reads in 7.5 s. */
      SELECT count(*)::int INTO v_current
        FROM public.hand_history hh
        JOIN public.tables t ON t.id = hh.table_id
        LEFT JOIN public.rake_records rr ON rr.hand_id = hh.id
       WHERE hh.created_at > now() - '2 hours'::interval
         AND hh.created_at < now() - interval '5 minutes'
         AND t.tournament_id IS NULL
         AND hh.tournament_id IS NULL
         AND COALESCE(array_length(hh.community_cards, 1), 0)
               + COALESCE(array_length(hh.community_cards2, 1), 0) = 0
         AND hh.showdown IS NULL
         AND COALESCE(hh.rake_amount, 0)
               + COALESCE(rr.bbj_contribution, hh.bbj_amount, 0) > 0.005;
$n$]);

SELECT pg_temp.ca_audit_subst(
  'public.fn_spin_unpaid_check(integer)',
  '9c04b99ae4b10e7e58a7df8d91050c19', '483f09fc67a627b961e20a273249269d',
  ARRAY[$o$  v_ids         uuid[];
$o$, $o$  SELECT COUNT(*) FILTER (WHERE v.chips_short > 0),
         COALESCE(SUM(v.chips_short) FILTER (WHERE v.chips_short > 0), 0),
         COUNT(*) FILTER (WHERE v.chips_short < 0),
         COALESCE(SUM(-v.chips_short) FILTER (WHERE v.chips_short < 0), 0),
         COUNT(*) FILTER (WHERE v.verdict = 'nobody_paid'),
         COALESCE(array_agg(v.tournament_id ORDER BY v.chips_short DESC)
                  FILTER (WHERE v.chips_short > 0), ARRAY[]::uuid[])
    INTO v_unpaid, v_short, v_over, v_over_amt, v_nobody, v_ids
    FROM public.v_spin_unpaid_settlements v
   WHERE COALESCE(v.drawn_at, v.started_at) >= v_since;

  -- One alert per offending tournament, never a duplicate while unresolved.
  FOR v_row IN
    SELECT v.* FROM public.v_spin_unpaid_settlements v
     WHERE COALESCE(v.drawn_at, v.started_at) >= v_since
       AND v.chips_short > 0
  LOOP
$o$, $o$                              'seat_shape',    v_row.seat_shape,
                              'unranked_seats',v_row.unranked_seats,
$o$],
  ARRAY[$n$  v_ids         uuid[] := ARRAY[]::uuid[];
  v_shape       text;
  v_unranked    bigint;
$n$, $n$  /* ONE READ OF THE VIEW, NOT TWO (2026-10-03). v_spin_unpaid_settlements
     aggregates spin_reserve_ledger, every prize/refund credit in
     wallet_transactions and - when a caller asks for seat_shape or
     unranked_seats - every tournament_players row, before the window can
     apply. The counters and the alert loop each read it whole, the loop with
     the seat aggregate; the job ran up to 117 s and was cancelled at 120 s in
     3 of 6 runs. Now one pass without the seat columns (the planner drops
     that join) yields every counter, the worst-first id list and the alert
     candidates, and the seat columns are read per alerted tournament, where
     tournament_id = $1 is pushed into every aggregate of the view. Same rows,
     same counters, same alerts, same dedupe. */
  FOR v_row IN
    SELECT v.tournament_id, v.club_id, v.name, v.prize_drawn, v.prize_credited,
           v.chips_short, v.verdict, v.buy_in_amount, v.spin_multiplier, v.drawn_at
      FROM public.v_spin_unpaid_settlements v
     WHERE COALESCE(v.drawn_at, v.started_at) >= v_since
     ORDER BY v.chips_short DESC
  LOOP
    IF v_row.verdict = 'nobody_paid' THEN v_nobody := v_nobody + 1; END IF;
    IF v_row.chips_short < 0 THEN
      v_over := v_over + 1;
      v_over_amt := v_over_amt - v_row.chips_short;
    END IF;
    CONTINUE WHEN v_row.chips_short IS NULL OR v_row.chips_short <= 0;
    v_unpaid := v_unpaid + 1;
    v_short := v_short + v_row.chips_short;
    v_ids := v_ids || v_row.tournament_id;

    SELECT s.seat_shape, s.unranked_seats INTO v_shape, v_unranked
      FROM public.v_spin_unpaid_settlements s
     WHERE s.tournament_id = v_row.tournament_id;

    -- One alert per offending tournament, never a duplicate while unresolved.
$n$, $n$                              'seat_shape',    v_shape,
                              'unranked_seats',v_unranked,
$n$]);

SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_settlement_correctness_check()',
  '331dfe59b157b733bc1efc99bbf193d0', 'a58c53d6d111fe2d9a9b966a2144e769',
  ARRAY[$o$    WITH recent AS MATERIALIZED (
      SELECT id,table_id,hand_number,created_at
      FROM public.hand_history WHERE created_at>now()-interval '24 hours'
    ), receipts AS MATERIALIZED (
      SELECT hand_id,table_id,hand_number FROM public.hand_atomic_commits
      WHERE hand_number BETWEEN (SELECT min(hand_number) FROM recent)
                            AND (SELECT max(hand_number) FROM recent)
    )
    SELECT count(*) AS hands_24h,count(c.hand_id) AS commits_24h,
           count(*) FILTER(WHERE h.created_at>now()-interval '60 minutes') AS hands_1h,
           count(c.hand_id) FILTER(WHERE h.created_at>now()-interval '60 minutes') AS commits_1h
    INTO v_hands_24h,v_claims_24h,v_hands_1h,v_claims_1h
    FROM recent h LEFT JOIN receipts c
     ON c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number
;
$o$],
  ARRAY[$n$    /* THE HOUR FIRST, THE DAY ONLY WHEN THE HOUR ACCUSES (2026-10-03).
       An incident needs BOTH the 24-hour adoption gate and the 1-hour
       shortfall. Reading the day first materialised ~885,000 hands and as
       many receipts every hour and was cancelled in 3 of 6 runs. The hour is
       read alone (the same hands: created_at > now() - 60 min is inside the
       24 h set, and a receipt that matches a hand's hand_number is inside the
       set's hand_number range by construction; hand_atomic_commits.hand_id is
       unique, so the join cannot duplicate). The day is read, exactly as
       before, only when the hour would fire; otherwise its counts stay NULL
       and the gate below is false, which is the verdict the hour already
       gave. Measured: 17.3 s for the hour on production. */
    SELECT count(*), count(c.hand_id)
      INTO v_hands_1h, v_claims_1h
      FROM public.hand_history h
      LEFT JOIN public.hand_atomic_commits c
        ON c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number
     WHERE h.created_at>now()-interval '60 minutes';
    IF v_hands_1h >= 20 AND v_claims_1h < (v_hands_1h * 9) / 10 THEN
      WITH recent AS MATERIALIZED (
        SELECT id,table_id,hand_number,created_at
        FROM public.hand_history WHERE created_at>now()-interval '24 hours'
      ), receipts AS MATERIALIZED (
        SELECT hand_id,table_id,hand_number FROM public.hand_atomic_commits
        WHERE hand_number BETWEEN (SELECT min(hand_number) FROM recent)
                              AND (SELECT max(hand_number) FROM recent)
      )
      SELECT count(*) AS hands_24h,count(c.hand_id) AS commits_24h
      INTO v_hands_24h,v_claims_24h
      FROM recent h LEFT JOIN receipts c
       ON c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number;
    END IF;
$n$]);

SELECT public.fn_ca_declare_guard_redefinition('fn_ca_settlement_correctness_check', 'migration 20261003025434_four_audits_read_only_what_their_verdict_needs');

SELECT pg_temp.ca_audit_subst(
  'public.ca_stats_witness_audit(integer,integer)',
  'a7738fa961dccb1ae5229c1825adb3c3', 'fbea24b80e755d047b6177b0c1f1fd56',
  ARRAY[$o$  SELECT count(*)::int INTO v_without_idx
  FROM (
    SELECT h.id AS hand_id, (pl->>'userId')::uuid AS uid
    FROM hand_history h
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(h.players, '[]'::jsonb)) pl
    WHERE h.created_at >= v_from AND h.created_at < v_to
      AND (pl->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) seat
  WHERE NOT EXISTS (
    SELECT 1 FROM public.ca_hand_player_idx i WHERE i.hand_id = seat.hand_id AND i.user_id = seat.uid
  );
$o$, $o$  WITH cand AS (
    SELECT f.hand_id, f.all_in_equity
    FROM public.ca_hand_facts f
    WHERE f.was_all_in = true
      AND f.went_to_showdown
      AND coalesce(f.all_in_street, '') <> 'river'
      AND f.played_at >= now() - interval '7 days'
  ), hands AS (
$o$, $o$  FROM cand c
  LEFT JOIN hands h USING (hand_id);
$o$],
  ARRAY[$n$  -- 2026-10-03: the per-seat probe went through ca_hand_player_idx_pkey
  -- (user_id, hand_id), 1.8 GB keyed by user: 37,949 random probes, 32,122
  -- buffer reads, 27.3 s for one 10-minute window. The window's index rows
  -- are now fetched once by hand_id (idx_ca_hand_player_idx_hand_id, 560 MB)
  -- and anti-joined in memory: same seats, same verdict, 16.0 s / 11,184
  -- reads measured on the same window size.
  WITH seat AS MATERIALIZED (
    SELECT h.id AS hand_id, (pl->>'userId')::uuid AS uid
    FROM hand_history h
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(h.players, '[]'::jsonb)) pl
    WHERE h.created_at >= v_from AND h.created_at < v_to
      AND (pl->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ), have AS MATERIALIZED (
    SELECT i.hand_id, i.user_id
      FROM public.ca_hand_player_idx i
     WHERE i.hand_id = ANY (ARRAY(SELECT DISTINCT s.hand_id FROM seat s))
  )
  SELECT count(*)::int INTO v_without_idx
  FROM seat
  WHERE NOT EXISTS (
    SELECT 1 FROM have x WHERE x.hand_id = seat.hand_id AND x.user_id = seat.uid
  );
$n$, $n$  /* 2026-10-03: one pass, no 800,000-row hash join. The seven-day
     candidate set (801,620 seats measured) was materialised, hashed
     (32 MB, 2 batches, spilled to temp) and joined back to the per-hand
     verdicts of the ~3,600 hands that still owe a figure: 32-35 s of a run
     that was cancelled at 300 s. A seat that carries a figure is owed
     whatever the betting did, so its verdict needs no join; a seat without
     one reads its own hand's action log in place (CASE, so only those seats
     do). Same rule, same two counts. 21.5 s measured cold. */
  SELECT count(*) FILTER (WHERE x.has_eq OR NOT coalesce(x.betting_continued, true))::int,
         count(*) FILTER (WHERE NOT x.has_eq AND NOT coalesce(x.betting_continued, true))::int
    INTO v_allin_sd, v_allin_sd_no_eq
  FROM (
    SELECT f.all_in_equity IS NOT NULL AS has_eq,
           CASE WHEN f.all_in_equity IS NULL THEN
             (SELECT bool_or(a.act->>'action' IN ('check', 'bet', 'raise') AND a.ord > la.last_allin)
                FROM public.hand_history h
                CROSS JOIN LATERAL (
                  SELECT max(b.ord) AS last_allin
                  FROM jsonb_array_elements(h.actions) WITH ORDINALITY b(act, ord)
                  WHERE b.act->>'action' IN ('all_in', 'allin')
                ) la
                CROSS JOIN LATERAL jsonb_array_elements(h.actions) WITH ORDINALITY a(act, ord)
               WHERE h.id = f.hand_id)
           END AS betting_continued
      FROM public.ca_hand_facts f
     WHERE f.was_all_in = true
       AND f.went_to_showdown
       AND coalesce(f.all_in_street, '') <> 'river'
       AND f.played_at >= now() - interval '7 days'
    OFFSET 0
  ) x;

  /* The pre-2026-10-03 form, kept unexecuted for the record:
  WITH cand AS (...seven-day candidate seats...), hands AS (
$n$, $n$  FROM cand c
  LEFT JOIN hands h USING (hand_id);
  */
$n$]);

-- pg_temp.ca_audit_subst is a temporary object and ends with this session.

COMMIT;
