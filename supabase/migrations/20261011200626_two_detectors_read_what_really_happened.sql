-- two_detectors_read_what_really_happened
--
-- TWO DETECTORS READ WHAT REALLY HAPPENED (2026-10-11). Full account:
-- docs/changelog/2026-10-11-two-detectors-read-what-really-happened.md.
--
-- Measured on production (kuklfnapbkmacvwxktbh) 2026-10-11 19:30-20:10 UTC.
--
-- 1. fn_ca_absent_tournament_players (hourly conservation sweep at :52) filed
--    critical incident 5ae05f8a at 16:52 and 17:52: "2 player(s) are still in
--    this event with no chips and no chair, the oldest for 0.6 hour(s)" on
--    Coffee Break Freeroll (PLO4) 7aace408. Nobody was stranded. At 17:52:00
--    fifteen of its players were inside their 30 second rebuy decision
--    (tournament_knockout_candidates created 17:51:16-17:52:00, every one
--    resolved by 17:52:41); no candidate anywhere was older than 10 minutes and
--    unresolved at 16:52 or 17:52. The detector clocked absence from
--    max(table_seats.left_at), falling back to registration when no seat row
--    names the player. table_seats keeps ONE row per chair (UNIQUE table_id,
--    seat_number) and the seating path reuses a vacated row (20260825091500),
--    so the chair a player just lost is re-taken seconds later, user_id and
--    left_at are overwritten, and the player reads as absent since an earlier
--    table's left_at or since registering (registered 17:11-17:15, so 37
--    minutes). Every elimination has a knockout candidate (median 0.25 s, max
--    52 s to resolve) and every move a tournament_seat_move_receipts row; those
--    rows are never reused. Absence is now clocked from the latest of: any seat
--    row still naming the player, the latest knockout candidate (from the end
--    of its rebuy prompt, capped at 5 minutes after the bust, because a pending
--    rebuy decision is not absence), and the latest seat move receipt.
--    Registration is the clock only when none exists. The live-minute
--    maintenance clause (2026-10-03) is unchanged.
--
-- 2. fn_ca_midway_burnin_gate (cron ca-burnin-gate-hourly, :58) failed 8 of
--    24 runs on the 120 s statement timeout and took 87-115 s when it passed:
--    its settlement check counted failed and stuck rows with a FILTER over
--    every ca_settlements row updated in 24 h (about 1.2 million, 47 s and 1.2
--    million heap fetches on a 25 GB table). Every row in that window is
--    'final' (measured), and both counts only ever count non-final rows. So
--    the check first counts, in ONE statement and so one snapshot, all rows
--    updated in (since, now - 10 min] minus the final rows in the same range
--    (index-only scans on idx_ca_settlements_updated_at and the partial
--    idx_ca_settlements_final_updated_at, about 0.4 s). If that difference is
--    0, no row old enough to be stuck is non-final, so stuck is exactly 0 and
--    failed is exactly the failed rows updated in the last 10 minutes (a few
--    thousand rows). Otherwise the original exact query runs unchanged. No
--    index is built; every other check and the output are unchanged.
--
-- @live-proof: (SELECT position('A SEAT ROW IS NOT A DEPARTURE' IN pg_get_functiondef('public.fn_ca_absent_tournament_players(integer)'::regprocedure)) > 0 AND position('tournament_knockout_candidates' IN pg_get_functiondef('public.fn_ca_absent_tournament_players(integer)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('THE GATE COUNTS SETTLEMENTS WITHOUT READING THE TABLE' IN pg_get_functiondef('public.fn_ca_midway_burnin_gate(integer)'::regprocedure)) > 0 AND position('idx_ca_settlements_final_updated_at' IN pg_get_functiondef('public.fn_ca_midway_burnin_gate(integer)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text
LANGUAGE plpgsql
AS $swap$
DECLARE
  v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / NULLIF(length(p_anchor), 0);
  IF v_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'TWO_DETECTORS_ANCHOR_NOT_UNIQUE: % anchor found % time(s)', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $mig$
DECLARE
  v_src text;
  v_new text;
BEGIN
  -- 1. fn_ca_absent_tournament_players
  v_src := pg_get_functiondef('public.fn_ca_absent_tournament_players(integer)'::regprocedure);
  IF position('A SEAT ROW IS NOT A DEPARTURE' IN v_src) > 0 THEN
    RAISE NOTICE 'fn_ca_absent_tournament_players already carries the change; skipping';
  ELSIF md5(v_src) <> '054e2ef927791833ca6dc8946d7bbfe6' THEN
    RAISE EXCEPTION 'TWO_DETECTORS_PREIMAGE_CHANGED: fn_ca_absent_tournament_players md5 %', md5(v_src);
  ELSE
    v_new := pg_temp.ca_swap_once(v_src,
$a$           COALESCE(
             (SELECT max(s.left_at)
                FROM public.table_seats s
                JOIN public.tables tb ON tb.id = s.table_id
               WHERE tb.tournament_id = t.id AND s.user_id = p.user_id),
$a$,
$w$           /* A SEAT ROW IS NOT A DEPARTURE (2026-10-11). table_seats keeps
              one row per chair and the seating path reuses a vacated row, so
              the chair a player just lost can be re-taken seconds later and
              stop naming them. Absence is clocked from the LATEST trace of the
              player at this event: a seat row still naming them, their latest
              knockout candidate (from the end of its rebuy prompt, capped at 5
              minutes after the bust: a pending rebuy decision is not absence),
              and their latest seat move receipt. Neither of those two tables
              ever reuses a row. Registration is the clock only when none of
              the three exists. */
           COALESCE(
             GREATEST(
               (SELECT max(s.left_at)
                  FROM public.table_seats s
                  JOIN public.tables tb ON tb.id = s.table_id
                 WHERE tb.tournament_id = t.id AND s.user_id = p.user_id),
               (SELECT max(GREATEST(k.created_at,
                                    LEAST(COALESCE(k.rebuy_prompt_until, k.created_at),
                                          k.created_at + interval '5 minutes')))
                  FROM public.tournament_knockout_candidates k
                 WHERE k.tournament_id = t.id AND k.eliminated_user_id = p.user_id),
               (SELECT max(m.moved_at)
                  FROM public.tournament_seat_move_receipts m
                 WHERE m.tournament_id = t.id AND m.user_id = p.user_id)),
$w$,
      'fn_ca_absent_tournament_players lost_chair_at');
    EXECUTE v_new;
  END IF;

  -- 2. fn_ca_midway_burnin_gate
  v_src := pg_get_functiondef('public.fn_ca_midway_burnin_gate(integer)'::regprocedure);
  IF position('THE GATE COUNTS SETTLEMENTS WITHOUT READING THE TABLE' IN v_src) > 0 THEN
    RAISE NOTICE 'fn_ca_midway_burnin_gate already carries the change; skipping';
  ELSIF md5(v_src) <> 'd5135c555bbb6ae2a0e58a3e96a13286' THEN
    RAISE EXCEPTION 'TWO_DETECTORS_PREIMAGE_CHANGED: fn_ca_midway_burnin_gate md5 %', md5(v_src);
  ELSE
    v_new := pg_temp.ca_swap_once(v_src,
$a$  v_supply record; v_checks jsonb; v_pass boolean;
$a$,
$w$  v_supply record; v_checks jsonb; v_pass boolean;
  v_settled_by timestamptz; v_open_before bigint;
$w$,
      'fn_ca_midway_burnin_gate declarations');
    v_new := pg_temp.ca_swap_once(v_new,
$a$  SELECT count(*) FILTER (WHERE state = 'failed'),
         count(*) FILTER (WHERE state NOT IN ('final','failed') AND updated_at < now() - interval '10 minutes')
    INTO c_failed_settlements, c_stuck_settlements
    FROM public.ca_settlements WHERE updated_at > v_since;
$a$,
$w$  /* THE GATE COUNTS SETTLEMENTS WITHOUT READING THE TABLE (2026-10-11).
     The FILTER below reads the heap of every row updated in the window
     (about 1.2 million in 24 h, 47 s; the cron timed out 8 of 24 runs). Both
     counts only ever count NON-final rows. One statement, so one snapshot:
     rows updated in (since, now - 10 min] minus the 'final' rows in the same
     range, two index-only scans (idx_ca_settlements_updated_at and the partial
     idx_ca_settlements_final_updated_at). When that is 0, no row old enough
     to be stuck is non-final, so stuck is exactly 0 and failed is exactly the
     failed rows updated in the last 10 minutes. Otherwise the original exact
     query runs. */
  v_settled_by := now() - interval '10 minutes';
  SELECT (SELECT count(*) FROM public.ca_settlements
           WHERE updated_at > v_since AND updated_at <= v_settled_by)
       - (SELECT count(*) FROM public.ca_settlements
           WHERE state = 'final' AND updated_at > v_since AND updated_at <= v_settled_by)
    INTO v_open_before;
  IF v_open_before = 0 THEN
    c_stuck_settlements := 0;
    SELECT count(*) FILTER (WHERE state = 'failed')
      INTO c_failed_settlements
      FROM public.ca_settlements
     WHERE updated_at > GREATEST(v_since, v_settled_by);
  ELSE
    SELECT count(*) FILTER (WHERE state = 'failed'),
           count(*) FILTER (WHERE state NOT IN ('final','failed') AND updated_at < now() - interval '10 minutes')
      INTO c_failed_settlements, c_stuck_settlements
      FROM public.ca_settlements WHERE updated_at > v_since;
  END IF;
$w$,
      'fn_ca_midway_burnin_gate settlement check');
    EXECUTE v_new;
  END IF;
END
$mig$;

DO $prove$
DECLARE
  v_absent text := pg_get_functiondef('public.fn_ca_absent_tournament_players(integer)'::regprocedure);
  v_gate text := pg_get_functiondef('public.fn_ca_midway_burnin_gate(integer)'::regprocedure);
  v_rows bigint;
BEGIN
  IF position('A SEAT ROW IS NOT A DEPARTURE' IN v_absent) = 0
     OR position('FROM public.tournament_knockout_candidates k' IN v_absent) = 0
     OR position('FROM public.tournament_seat_move_receipts m' IN v_absent) = 0
     OR position('THEN p.registered_at END) AS lost_chair_at' IN v_absent) = 0
     OR position('public.fn_ca_engine_live_minutes(a.lost_chair_at, now())' IN v_absent) = 0 THEN
    RAISE EXCEPTION 'TWO_DETECTORS_RESULT_CHANGED: fn_ca_absent_tournament_players';
  END IF;
  IF position('THE GATE COUNTS SETTLEMENTS WITHOUT READING THE TABLE' IN v_gate) = 0
     OR position('IF v_open_before = 0 THEN' IN v_gate) = 0
     OR position('fn_ca_verify_ledger_chain(50000)' IN v_gate) = 0
     OR position('''no_failed_or_stuck_settlements''' IN v_gate) = 0 THEN
    RAISE EXCEPTION 'TWO_DETECTORS_RESULT_CHANGED: fn_ca_midway_burnin_gate';
  END IF;
  SELECT count(*) INTO v_rows FROM public.fn_ca_absent_tournament_players(10);
  RAISE NOTICE 'fn_ca_absent_tournament_players(10) returns % row(s)', v_rows;
END
$prove$;

COMMIT;
