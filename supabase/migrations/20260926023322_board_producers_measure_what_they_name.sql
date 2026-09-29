-- 20260926023322_board_producers_measure_what_they_name
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-26 02:33:22 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
--
-- Three drift-board producers named one thing and measured another. Each is a
-- read-only STABLE SQL function the hourly fn_ca_conservation_sweep reads; no
-- money moves here and no guard changes. Measured 2026-09-26 02:20-02:35 UTC.
--
-- 1. fn_tournament_chip_conservation_check reported "Sunday Funday Six-Card
--    Closer" (c7f21a83) as chip drift -30,000 (incident 0f8f8cc6, 70
--    occurrences). No chips are missing. Four seated horses hold exactly the
--    120,000 they were issued; the fifth row (5330edb2) registered 34 h late
--    (2026-09-22 14:08), has status 'registered', chips 0, no rebuy, no add-on
--    and has NEVER had a table_seats row in this event. fn_ca_tournament_chip_supply
--    counts every tournament_players row as a 30,000 starting stack, so a stack
--    that was never issued read as a stack that was lost. The check now
--    subtracts starting stacks owed to registrations that were never issued a
--    chair; the shared supply function is deliberately NOT changed, because the
--    felt-may-not-exceed-supply guard and the chip-grant assertion read it at
--    seating time, before the seat row exists.
--    Proof: the new body, run as a plain query at 02:32, returns zero rows.
--    Whether 5330edb2 is seated or refunded is an owner decision; this only
--    stops calling it missing chips.
--
-- 2. That registration still keeps the event from finishing, and no producer
--    named it: fn_ca_absent_tournament_players requires a chair that was LOST
--    (lost_chair_at IS NOT NULL), so a chair never given was invisible to it.
--    It now also reports a RUNNING event's registrant who holds no chips and
--    has never been seated, clocked from registered_at. Measured: exactly one
--    such row exists platform-wide (5330edb2 in c7f21a83), so this adds one
--    finding and hides none.
--
-- 3. fn_ca_tables_that_cannot_deal clocked "how long has it been in this
--    shape" from the newest seat JOIN, so an event whose tables thinned to one
--    player each by busts reported the age of its oldest seating. Five-Card
--    Bounty (6a6d0385) dealt hand #14614252 at 02:15:47 (three players, two
--    busted) and was reported as stuck for 11,602 minutes. The shape changes
--    when a seat is vacated too, so the clock now also reads the newest
--    left_at on the event's tables. The condition itself (every table holds
--    one player, >1 table) is real and still reported.
--
-- 4. fn_tournament_progress_metrics published stalled_running with no
--    denominator. MttPlayStopped (poker_mtt_stalled_running > 0) was loaded
--    and FIRING for three days straight - 483 five-minute samples between
--    2026-09-23 02:35 and 2026-09-26 02:30, at 89-116 stalled MTTs - while the
--    whole tournament fleet sat still: hand_history shows 2-15 MTT events
--    dealing per 30 minutes for five days outside three post-restart bursts.
--    Permanently stuck events keep the count near 55 even when healthy, so
--    the rule could not tell one broken event from a stopped fleet and was
--    read as noise. The function now also returns progressing_running (same
--    eligible population, DID produce a hand), so the ratio can be alarmed.
--    Measured 02:45 UTC with the new body: stalled 60, progressing 68, of 129.
--    Return type changes, so DROP + CREATE in this transaction; grants restored
--    exactly (postgres, service_role). The engine reads columns by name and
--    tolerates the old shape; the old engine ignores the new column.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_tournament_chip_conservation_check(p_tolerance_per_player numeric DEFAULT 1)
 RETURNS TABLE(tournament_id uuid, name text, players bigint, expected_chips numeric, actual_chips numeric, drift numeric, drift_per_player numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH calc AS (
    SELECT t.id,
           t.name,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) AS players,
           public.fn_ca_tournament_chip_supply(t.id)
             -- A starting stack owed to a registration that was never issued a
             -- chair is not on the felt because it was never issued, not
             -- because it was lost (2026-09-26, c7f21a83).
             - COALESCE(t.starting_chips, 0) * (
                 SELECT count(*) FROM public.tournament_players tp
                  WHERE tp.tournament_id = t.id
                    AND tp.status = 'registered'
                    AND COALESCE(tp.chips, 0) <= 0
                    AND COALESCE(tp.rebuys, 0) = 0
                    AND NOT COALESCE(tp.add_on, false)
                    AND NOT EXISTS (
                          SELECT 1 FROM public.table_seats s
                            JOIN public.tables tb ON tb.id = s.table_id
                           WHERE tb.tournament_id = t.id AND s.user_id = tp.user_id)
               ) AS expected_chips,
           public.fn_ca_tournament_felt_total(t.id)  AS actual_chips
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
  )
  SELECT c.id, c.name, c.players,
         round(c.expected_chips, 2),
         round(c.actual_chips, 2),
         round(c.actual_chips - c.expected_chips, 2),
         round((c.actual_chips - c.expected_chips) / NULLIF(c.players, 0), 3)
    FROM calc c
   WHERE c.players > 0
     AND abs(c.actual_chips - c.expected_chips)
         > (GREATEST(p_tolerance_per_player, 0) * c.players)
   ORDER BY abs(c.actual_chips - c.expected_chips) DESC;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_absent_tournament_players(p_min_absent_minutes integer DEFAULT 10)
 RETURNS TABLE(tournament_id uuid, tournament_name text, absent_players bigint, oldest_absence_minutes numeric, prize_held numeric, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH absent AS (
    SELECT t.id, t.name, p.user_id,
           -- A chair that was lost is clocked from losing it; a chair that was
           -- never given is clocked from registering (2026-09-26).
           COALESCE(
             (SELECT max(s.left_at)
                FROM public.table_seats s
                JOIN public.tables tb ON tb.id = s.table_id
               WHERE tb.tournament_id = t.id AND s.user_id = p.user_id),
             CASE WHEN NOT EXISTS (
                    SELECT 1 FROM public.table_seats s
                      JOIN public.tables tb ON tb.id = s.table_id
                     WHERE tb.tournament_id = t.id AND s.user_id = p.user_id)
                  THEN p.registered_at END) AS lost_chair_at
      FROM public.tournaments t
      JOIN public.tournament_players p ON p.tournament_id = t.id
     WHERE t.status = 'RUNNING'
       AND p.status IN ('playing', 'registered')
       AND COALESCE(p.chips, 0) <= 0
       AND NOT EXISTS (
             SELECT 1 FROM public.table_seats s
               JOIN public.tables tb ON tb.id = s.table_id
              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id
                AND s.left_at IS NULL)
       AND NOT EXISTS (
             SELECT 1 FROM public.table_seats s
               JOIN public.tables tb ON tb.id = s.table_id
              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id
                AND COALESCE(s.stack, 0) > 0)
  )
  SELECT a.id, a.name, count(*),
         round(extract(epoch FROM (now() - min(a.lost_chair_at))) / 60.0, 1),
         round(COALESCE((SELECT e.prize_balance FROM public.tournament_escrow e
                          WHERE e.tournament_id = a.id), 0), 2),
         count(*) || ' player(s) are still in this event with no chips and no chair, the '
           || 'oldest for '
           || round(extract(epoch FROM (now() - min(a.lost_chair_at))) / 3600.0, 1)
           || ' hour(s). An unranked player keeps the event from finishing, so the '
           || round(COALESCE((SELECT e.prize_balance FROM public.tournament_escrow e
                               WHERE e.tournament_id = a.id), 0), 2)
           || ' still in escrow cannot be paid to anyone' AS detail
    FROM absent a
   WHERE a.lost_chair_at IS NOT NULL
     AND a.lost_chair_at <= now() - make_interval(mins => GREATEST(p_min_absent_minutes, 1))
   GROUP BY a.id, a.name
   ORDER BY 3 DESC
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_tables_that_cannot_deal(p_dwell_minutes integer DEFAULT 5)
 RETURNS TABLE(tournament_id uuid, tournament_name text, club_id uuid, tables_with_open_seats bigint, max_open_seats_on_any_table bigint, total_open_seats numeric, stuck_minutes numeric, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH per_table AS (
    SELECT tb.tournament_id AS tid, tb.id AS table_id, count(*) AS open_seats,
           GREATEST(max(s.joined_at), max(tb.opened_at),
                    -- A bust changes the shape as surely as a seating does
                    -- (2026-09-26, 6a6d0385).
                    (SELECT max(v.left_at) FROM public.table_seats v
                      WHERE v.table_id = tb.id AND v.left_at IS NOT NULL)) AS last_change
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id = s.table_id
     WHERE s.left_at IS NULL
       AND tb.tournament_id IS NOT NULL
     GROUP BY tb.tournament_id, tb.id
  ), per_event AS (
    SELECT t.id, t.name, t.club_id,
           count(*) AS tbls,
           max(p.open_seats) AS max_open,
           sum(p.open_seats)::numeric AS total_open,
           COALESCE(max(p.last_change), to_timestamp(0)) AS last_change
      FROM public.tournaments t
      JOIN per_table p ON p.tid = t.id
     WHERE t.status = 'RUNNING'
     GROUP BY t.id, t.name, t.club_id
  )
  SELECT e.id, e.name, e.club_id, e.tbls, e.max_open, e.total_open,
         round((extract(epoch FROM (now() - e.last_change)) / 60.0)::numeric, 1),
         'this RUNNING event holds open seats on ' || e.tbls
           || ' table(s) and the busiest of them has exactly 1 open seat, so no '
           || 'player anywhere in it has an opponent. It cannot be dealt a hand, '
           || 'by definition, and it has been in this shape for '
           || round((extract(epoch FROM (now() - e.last_change)) / 60.0)::numeric, 1)
           || ' minute(s) - far past any table balance in flight'
    FROM per_event e
   WHERE e.tbls > 1
     AND e.max_open = 1
     AND e.last_change < now() - make_interval(mins => GREATEST(p_dwell_minutes, 1))
   ORDER BY e.tbls DESC, e.total_open DESC
$function$;

DROP FUNCTION public.fn_tournament_progress_metrics(integer, integer);
CREATE FUNCTION public.fn_tournament_progress_metrics(p_stalled_minutes integer DEFAULT 15, p_break_grace_minutes integer DEFAULT 10)
 RETURNS TABLE(stalled_running integer, overdue_breaks integer, progressing_running integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH bounds AS (
    SELECT statement_timestamp() - make_interval(mins =>
             LEAST(1440, GREATEST(1, COALESCE(p_stalled_minutes,15)))) AS hand_cutoff,
           statement_timestamp() - make_interval(mins =>
             LEAST(1440, GREATEST(1, COALESCE(p_break_grace_minutes,10)))) AS break_cutoff
  )
  SELECT
    count(*) FILTER (
      WHERE NOT COALESCE(t.on_break,false)
        -- A recently completed add-on is a legitimate interval without hands.
        AND COALESCE(t.addon_period_ends_at,'-infinity'::timestamptz) < b.hand_cutoff
        AND NOT EXISTS (
          SELECT 1 FROM public.hand_history h
           WHERE h.tournament_id=t.id AND h.created_at>b.hand_cutoff
        )
    )::integer,
    count(*) FILTER (
      WHERE COALESCE(t.on_break,false)
        -- A missing end timestamp is the pre-countdown state, not an unlimited
        -- exemption. Give it the normal five-minute break plus the grace.
        AND GREATEST(
          COALESCE(t.break_ends_at,
                   t.break_started_at + interval '5 minutes',
                   COALESCE(t.started_at,t.start_time,t.created_at) + interval '5 minutes'),
          COALESCE(t.addon_period_ends_at,'-infinity'::timestamptz)
        ) < b.break_cutoff
    )::integer,
    -- The denominator's other half (2026-09-26): the same eligible events
    -- that DID deal a hand in the window.
    count(*) FILTER (
      WHERE NOT COALESCE(t.on_break,false)
        AND COALESCE(t.addon_period_ends_at,'-infinity'::timestamptz) < b.hand_cutoff
        AND EXISTS (
          SELECT 1 FROM public.hand_history h
           WHERE h.tournament_id=t.id AND h.created_at>b.hand_cutoff
        )
    )::integer
  FROM public.tournaments t CROSS JOIN bounds b
  WHERE t.status='RUNNING'
    -- Immutable recorded format includes old numeric and new NULL MTTs.
    -- Historical seat-first satellites retain their own lifecycle.
    AND t.format_contract IN ('mtt-v1','mtt-v2')
    AND COALESCE(t.started_at,t.start_time,t.created_at)<b.hand_cutoff;
$function$;
REVOKE ALL ON FUNCTION public.fn_tournament_progress_metrics(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_progress_metrics(integer, integer) TO service_role;

-- Operator telemetry: the live ACL on all three is postgres + service_role, and
-- CREATE OR REPLACE keeps it; stated here so the file says what production has.
REVOKE ALL ON FUNCTION public.fn_tournament_chip_conservation_check(numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_chip_conservation_check(numeric) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_absent_tournament_players(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_absent_tournament_players(integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_tables_that_cannot_deal(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tables_that_cannot_deal(integer) TO service_role;

COMMIT;
