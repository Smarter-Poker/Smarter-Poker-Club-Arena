-- 20261004201450_the_satellite_qualifier_alert_of_2026_10_03_closes_on_its_re.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE SATELLITE QUALIFIER ALERT OF 2026-10-03 CLOSES ON ITS RECEIPT.
-- Full account:
-- docs/changelog/2026-10-04-a-postgres-error-is-an-answer-not-a-lost-response.md.
--
-- Records only. No chips move, no function changes, no job is added.
--
-- financial_alerts f2191cb7 (critical, Tournament.satellite_qualifiers_
-- outcome_unknown, 2026-10-03 20:13:19 UTC) names satellite ab4a05ce
-- "Saturday Night Big Stack Satellite" and eight qualifiers. Read from the
-- Postgres and API logs: the settlement call of 20:13:03 waited for the
-- exclusive finish lane and was cancelled with 55P03 (lock_timeout) at
-- 20:13:11, so it rolled back; the resolver call waited for the same lane
-- and was cancelled with the same 55P03 at 20:13:19; the engine reported the
-- outcome as unknown and stopped the event's manager. The next pass settled
-- it whole at 20:13:48:
--
--   tournament_satellite_settlements receipt v3, pool 432.00, field 24,
--   8 awards of 50.00 for exactly the eight qualifiers the alert names:
--   6 cash (7a74d9fe, 7c0be9c9, 7c165d15, 7e464f21, e8b32dc2, e96f6e72),
--   each credited 50.00 to the wallet; 2 target seats (e8cca6bc, f6371734),
--   each 50.00 moved to target bee370a7, which both players played (finished
--   70th and 36th); remainder 32.00 to place 9 (f140e49c). 400.00 + 32.00 =
--   432.00. Nine tournament_payouts rows, one per key, each paid once. The
--   satellite is COMPLETED, its three tables are closed, no seat is open, and
--   nothing is fenced. All nine are horses and were paid as players (10.5).
--
-- The engine line that made a definite rollback read as unknown is fixed in
-- server/src/tournament/satelliteQualifierRpc.ts with
-- aPostgresErrorIsAnAnswerNotALostResponse.law.test.ts.
--
-- Every pre-image is asserted; the migration aborts if any row moved.
-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE id = 'f2191cb7-ca68-472b-9df7-05fb94471604' AND resolved AND resolution LIKE '%20261004201450_the_satellite_qualifier_alert_of_2026_10_03_closes_on_its_re%') = 1

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'SATELLITE_QUALIFIER_ALERT_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $close$
DECLARE
  v_event constant uuid := 'ab4a05ce-3815-476b-a2ab-6e637284de55';
  v_n int;
  v_paid numeric;
  v_keys int;
BEGIN
  -- Every payout row of the event: nine keys, 432.00, each key once.
  SELECT count(*), coalesce(sum(amount), 0), count(DISTINCT idempotency_key)
    INTO v_n, v_paid, v_keys
    FROM public.tournament_payouts WHERE tournament_id = v_event;
  IF v_n <> 9 OR v_keys <> 9 OR v_paid <> 432.00 THEN
    RAISE EXCEPTION 'payouts moved: % rows, % keys, %', v_n, v_keys, v_paid;
  END IF;

  -- Eight awards of 50.00: six cash, two target seats, each with its payout.
  SELECT count(*) INTO v_n FROM public.tournament_satellite_awards
   WHERE tournament_id = v_event AND amount = 50.00 AND payout_id IS NOT NULL
     AND ((delivery_kind = 'cash' AND payout_source = 'satellite_ticket')
       OR (delivery_kind = 'seat' AND payout_source = 'satellite_seat' AND registration_id IS NOT NULL));
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'awards moved: % of 8', v_n;
  END IF;

  -- The satellite's three tables are closed with no seat open.
  SELECT count(*) INTO v_n FROM public.tables t
   WHERE t.tournament_id = v_event
     AND (t.status <> 'closed'
       OR EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id = t.id AND s.left_at IS NULL));
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'a table or seat of the satellite is still open: %', v_n;
  END IF;

  UPDATE public.financial_alerts a
     SET resolved = true, resolved_at = now(),
         resolution = 'verified: the outcome was never unknown. The 20:13:03 settlement call and the 20:13:11 resolver call were each cancelled '
           || 'with 55P03 (lock_timeout) waiting for the exclusive finish lane, so both rolled back, and the engine read a definite rollback as a lost '
           || 'response. The next pass settled satellite ab4a05ce whole: tournament_satellite_settlements receipt v3 at ' || s.settled_at::text
           || ', pool ' || s.pool::text || ', ' || s.ticket_award_count::text || ' awards (' || s.cash_ticket_count::text || ' cash, '
           || s.seat_count::text || ' target seats) of ' || s.ticket_cost::text || ' for exactly the eight qualifiers named here, remainder '
           || s.remainder::text || ' to place ' || s.bubble_position::text || '; nine payouts, each once; satellite COMPLETED, tables closed, '
           || 'nothing fenced. Engine fix: a Postgres error is an answer, not a lost response (satelliteQualifierRpc.ts). '
           || 'migration 20261004201450_the_satellite_qualifier_alert_of_2026_10_03_closes_on_its_re'
    FROM public.tournament_satellite_settlements s
    JOIN public.tournaments t ON t.id = s.tournament_id
   WHERE a.id = 'f2191cb7-ca68-472b-9df7-05fb94471604'
     AND a.resolved IS NOT TRUE
     AND a.severity = 'critical'
     AND a.source = 'Tournament.satellite_qualifiers_outcome_unknown'
     AND s.tournament_id = v_event
     AND s.tournament_id = (a.context->>'tournament_id')::uuid
     AND s.receipt_version = 3
     AND s.settled_at = '2026-10-03 20:13:48.323719+00'
     AND s.pool = 432.00 AND s.remainder = 32.00 AND s.ticket_cost = 50.00
     AND s.ticket_award_count = 8 AND s.cash_ticket_count = 6 AND s.seat_count = 2 AND s.entry_ticket_count = 0
     AND s.bubble_position = 9
     AND t.status = 'COMPLETED'
     AND (SELECT array_agg(x ORDER BY x) FROM unnest(s.qualifier_ids) x)
         = (SELECT array_agg(x::uuid ORDER BY x::uuid) FROM jsonb_array_elements_text(a.context->'qualifier_ids') x);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected 1 alert, matched %', v_n;
  END IF;
END
$close$;

COMMIT;
