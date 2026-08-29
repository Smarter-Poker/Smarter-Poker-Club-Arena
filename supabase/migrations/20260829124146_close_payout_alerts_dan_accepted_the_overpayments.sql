-- ═══════════════════════════════════════════════════════════════════════════
--  DAN'S RULING ON THE OVERPAYMENTS, WRITTEN DOWN AND THE ALERTS CLOSED
--  (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_tournament_payout_reconcile files a `critical` financial_alert for every
-- issue list it produces and NOTHING has ever closed one. 206 were closed by
-- hand on 2026-08-28 (20260828_resolve_reconciled_payout_alerts); 77 stand
-- open now, and a dozen of those were filed by the DRY RUNS used to
-- investigate them, which is the shape of a table that becomes noise and then
-- gets ignored.
--
-- Dan, 2026-08-29, asked what to do about the residual overpayments:
-- LEAVE THE MONEY, CLOSE THE ALERTS. The reconciler deliberately never claws
-- back automatically, so an `overpaid` line is a report, not a task; and a
-- `no_finisher_recorded` place is owed to nobody identifiable. Neither is
-- going to change on its own, so leaving the alert open only buries the next
-- real one.
--
-- WHAT IS NOT CLOSED: anything still owing money. The whole point of this
-- table is the shortfall direction, and 11,238.80 of it was found this
-- morning hiding behind exactly these alerts
-- (20260829_pay_prize_money_outside_the_thirty_day_window). So every alert is
-- RE-ASKED against the live reconciler and only the ones that now come back
-- with `total_top_up = 0` are resolved. An alert that still owes a cent stays
-- open and loud.

DO $$
DECLARE
  v_open       int;
  v_closed     int;
  v_left_owing int;
BEGIN
  SELECT count(*) INTO v_open
    FROM financial_alerts
   WHERE source = 'fn_tournament_payout_reconcile' AND resolved = false;

  WITH candidates AS (
    SELECT a.id,
           coalesce(
             (fn_tournament_payout_reconcile((a.context->>'tournament_id')::uuid, false)->>'total_top_up')::numeric,
             0
           ) AS owed
      FROM financial_alerts a
     WHERE a.source = 'fn_tournament_payout_reconcile'
       AND a.resolved = false
       AND a.context ? 'tournament_id'
  ), settled AS (
    UPDATE financial_alerts a
       SET resolved = true,
           resolved_at = now(),
           context = a.context || jsonb_build_object(
             'resolution', 'accepted_by_dan_2026_08_29',
             'resolution_detail',
               'Overpaid and no_finisher_recorded places reviewed and accepted. '
               'The reconciler never claws back automatically and Dan chose not to; '
               'a place with no identifiable finisher is owed to nobody. '
               'Re-asked at resolution time: nothing owed on this event.'
           )
      FROM candidates c
     WHERE a.id = c.id AND c.owed = 0
    RETURNING a.id
  )
  SELECT count(*) INTO v_closed FROM settled;

  SELECT count(*) INTO v_left_owing
    FROM financial_alerts
   WHERE source = 'fn_tournament_payout_reconcile' AND resolved = false;

  RAISE NOTICE 'payout alerts: % open before, % closed, % still open', v_open, v_closed, v_left_owing;

  -- An alert left open here is one that still owes money. That is a fact
  -- worth reporting if it is unexpected, but it is NOT an error condition on
  -- its own -- it is the table doing its job.
  IF v_left_owing > 0 THEN
    RAISE NOTICE 'NOTE: % payout alert(s) still owe money and were deliberately left open', v_left_owing;
  END IF;
END $$;
