-- ═══════════════════════════════════════════════════════════════════════════
--  A SATELLITE THAT PAID IN SEATS READ AS A TOURNAMENT THAT PAID NOBODY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS (2026-09-12)
--
-- `TournamentCompletedUnpaid` is the strongest money alert this platform has.
-- It is critical severity, it pages by SMS, and it says:
--
--     "Players bought in and nobody was paid."
--
-- It has never once been right. Every firing in the whole visible history of
-- the metric was a satellite that paid correctly:
--
--     12 firings in the 14 days to 2026-09-12
--     12 of them satellites
--      0 of them unpaid
--
-- Checked by hand, the winners were paid to the row: two seats registered
-- directly into the target event (`tournament_players` holds them), one ticket
-- issued and outstanding (`tournament_tickets` holds it, $200, entry-only).
-- Reaching back 120 days finds six more, all of them the same satellites
-- paying the same way through the pre-2026-09-09 settlement path, every winner
-- seated in the target.
--
-- ── WHY IT WAS WRONG ──────────────────────────────────────────────────────
--
-- The gauge asks one question: did any `wallet_transactions` row with
-- `category = 'prize'` land against this tournament? That is the right
-- question for a tournament that pays in chips. A satellite does not pay in
-- chips. It pays in a SEAT at the target event, or in a TICKET to enter one
-- later, and neither of those is a wallet transaction.
--
-- So the one format that pays in something other than cash was, by
-- construction, always unpaid.
--
-- This is not a new rule. `aSatelliteSeatIsAPayout` has been law here since
-- 2026-08-31, and the structure reconciler was taught the same lesson in the
-- same week: "A seat is funded by the satellite's pool buying a ticket, not by
-- the satellite's prize_pool paying a place." The reconciler learned it. This
-- gauge never did.
--
-- ── WHY A FALSE ALERT ON THIS CHANNEL IS A DEFECT, NOT AN ANNOYANCE ───────
--
-- An alert that is wrong every time it fires trains the on-call to close it
-- without reading it. This one has been wrong every time it has ever fired, on
-- the SMS channel, with the words "nobody was paid" in it. The day a
-- tournament genuinely pays nobody, that page will look exactly like the last
-- twelve. The cost of leaving this is not noise; it is the loss of the alert.
--
-- ── WHAT PROVES A SEAT WAS DELIVERED ──────────────────────────────────────
--
-- `tournament_satellite_awards`, and nothing weaker. A payout row marked
-- `paid_at` is the ledger's INTENT and is written by the payout code itself,
-- so reading it would only prove the code believed it had paid. The awards
-- table proves delivery by constraint:
--
--     delivery_kind = 'seat'    =>  registration_id IS NOT NULL
--     delivery_kind = 'ticket'  =>  ticket_id  -> tournament_tickets   (FK)
--     delivery_kind = 'cash'    =>  obligation_id -> tournament_obligations (FK)
--
-- all three enforced by `tournament_satellite_awards_check`, all three ON
-- DELETE RESTRICT. A row cannot exist unless the instrument exists.
--
-- The cash half of the predicate is left exactly as it was. A satellite that
-- fails to settle writes no award row and moves no cash, so it still counts as
-- unpaid - which is the true positive this alert was built for and has been
-- waiting to find.
--
-- Measured against production, 14 days, day by day:
--
--     day          current expr    this expr
--     2026-09-12        3              0
--     2026-09-11        6              0
--     2026-09-10        3              0
--
-- `category = 'prize'` is deliberately NOT widened to include 'bounty'. A
-- bounty is not a prize, and counting it as one would let a tournament that
-- paid its bounties and none of its prizes read as paid.

CREATE OR REPLACE FUNCTION public.fn_tournament_metrics(
  p_overdue_minutes    integer DEFAULT 10,
  p_completing_minutes integer DEFAULT 10,
  p_unpaid_hours       integer DEFAULT 6
)
RETURNS TABLE (
  running            integer,
  registering        integer,
  overdue_start      integer,
  stuck_completing   integer,
  seatless_phantoms  integer,
  unpaid_completed   integer,
  seat_first_waiting integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    (SELECT count(*) FROM tournaments WHERE status = 'RUNNING')::int,
    (SELECT count(*) FROM tournaments WHERE status = 'REGISTERING')::int,
    (SELECT count(*) FROM tournaments
      WHERE status IN ('REGISTERING','ANNOUNCED')
        AND tournament_type = 'MTT'
        AND start_time < now() - make_interval(mins => GREATEST(p_overdue_minutes, 0)))::int,
    (SELECT count(*) FROM tournaments
      WHERE status = 'COMPLETING'
        AND updated_at < now() - make_interval(mins => GREATEST(p_completing_minutes, 0)))::int,
    (SELECT count(*) FROM tournament_players tp
       JOIN tournaments t ON t.id = tp.tournament_id AND t.status = 'RUNNING'
      WHERE tp.status = 'playing'
        AND tp.chips > 0
        AND NOT EXISTS (
          SELECT 1 FROM table_seats s
            JOIN tables tb ON tb.id = s.table_id
           WHERE tb.tournament_id = tp.tournament_id
             AND s.user_id = tp.user_id
             AND s.left_at IS NULL))::int,
    -- UNPAID means nothing of value reached anybody: no cash prize, and no
    -- satellite award delivered. See the header. The awards probe rides the
    -- primary key (tournament_id, place).
    (SELECT count(*) FROM tournaments t
      WHERE t.status = 'COMPLETED'
        AND t.ended_at > now() - make_interval(hours => GREATEST(p_unpaid_hours, 0))
        AND COALESCE(t.prize_pool, 0) > 0
        AND NOT EXISTS (
          SELECT 1 FROM wallet_transactions w
           WHERE w.related_entity_id = t.id AND w.category = 'prize')
        AND NOT EXISTS (
          SELECT 1 FROM tournament_satellite_awards a
           WHERE a.tournament_id = t.id))::int,
    (SELECT count(*) FROM tournaments
      WHERE status IN ('REGISTERING','ANNOUNCED')
        AND tournament_type <> 'MTT'
        AND start_time < now() - make_interval(mins => GREATEST(p_overdue_minutes, 0)))::int;
$$;

-- GRANTS: service_role and nothing else.
--
-- `CREATE OR REPLACE` preserves the existing grants, so these lines only
-- re-assert what is already live. They are written out anyway because the
-- 2026-08-31 v2 migration this function was last defined in ends with
--
--     GRANT EXECUTE ... TO service_role, authenticated;
--
-- and that is no longer true. `the_operator_console_was_open_to_every_player`
-- (2026-08-31) took `authenticated` off this function and thirty-four others
-- after finding that every logged-in player could read operator telemetry.
-- Production today is `{postgres=X/postgres,service_role=X/postgres}`.
--
-- Copying the old grant line forward would have silently undone that security
-- fix. It was caught by the definer-authorization pre-push gate, which is what
-- that gate is for. Nothing is lost by the narrow grant: the engine builds its
-- client with SUPABASE_SERVICE_ROLE_KEY, and no RLS policy references this
-- function (checked: zero rows in pg_policy).
REVOKE ALL ON FUNCTION public.fn_tournament_metrics(integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_metrics(integer, integer, integer)
  TO service_role;

-- Report what changed on the live data, so the migration log carries the proof
-- rather than a promise. Both halves are computed the same way the function
-- computes them, over the same six-hour window.
DO $$
DECLARE
  r        record;
  v_before integer;
BEGIN
  SELECT * INTO r FROM public.fn_tournament_metrics(10, 10, 6);

  IF r.running IS NULL OR r.overdue_start IS NULL OR r.unpaid_completed IS NULL THEN
    RAISE EXCEPTION 'fn_tournament_metrics returned NULLs - the gauges would read as zero';
  END IF;

  -- Operator telemetry stays closed to the browser roles. See the grant note.
  IF has_function_privilege('anon', 'public.fn_tournament_metrics(integer,integer,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_tournament_metrics(integer,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION
      'fn_tournament_metrics is executable by a browser role - this migration would reopen the operator console';
  END IF;

  SELECT count(*)::int INTO v_before
    FROM tournaments t
   WHERE t.status = 'COMPLETED'
     AND t.ended_at > now() - interval '6 hours'
     AND COALESCE(t.prize_pool, 0) > 0
     AND NOT EXISTS (
       SELECT 1 FROM wallet_transactions w
        WHERE w.related_entity_id = t.id AND w.category = 'prize');

  IF r.unpaid_completed > v_before THEN
    RAISE EXCEPTION
      'unpaid_completed went UP (% -> %). This change may only ever remove satellites that paid.',
      v_before, r.unpaid_completed;
  END IF;

  RAISE NOTICE
    'fn_tournament_metrics OK: unpaid_completed % -> % (% satellite payout(s) no longer read as unpaid)',
    v_before, r.unpaid_completed, v_before - r.unpaid_completed;
END $$;
