-- the_unpaid_tournament_alarm_reads_the_diamond_book
--
-- Dan, 2026-10-09 18:30 CT, on the push "Money Check Failed: 2 completed
-- tournament(s) with a prize pool and no payout": why is this reaching my
-- phone instead of being fixed, and how are tournaments still failing to pay.
-- Approved for production by Dan 2026-10-09 ("Yes, apply all 3").
--
-- They are not failing to pay. TournamentCompletedUnpaid fires on the engine
-- gauge poker_tournaments_unpaid_completed, which reads
-- fn_tournament_metrics().unpaid_completed. That count accepted a payout only
-- as a chip wallet prize row (wallet_transactions, category 'prize') or a
-- satellite award. A Diamond Arena event pays through
-- fn_poker_diamond_tournament_pay: a Diamond journal row (diamond_transactions)
-- and a poker_diamond_tournament_ledger 'prize' row, inside the terminal
-- receipt's transaction. No chip wallet row exists for it, so every Diamond
-- event with a prize pool read as "nobody was paid" and paged the owner, while
-- the payout reconciler (which reads tournament_payouts) correctly found the
-- pool fully discharged and declined to act.
--
-- Evidence, measured read-only 2026-10-09 ~23:55 UTC:
--   * The alarm first fired 2026-10-07 13:19 UTC, the day Diamond Arena events
--     began completing; it has no earlier row in operational_alert_events.
--   * From 6 hours before that first firing to the measurement, the old count
--     flagged 32 tournaments. All 32 are Diamond Arena events; for all 32 the
--     Diamond prize rows equal the prize pool exactly (143,069 of 143,069
--     Diamonds) and every prize row carries its Diamond journal row for the
--     same player.
--   * 2026-10-02..10-09: 204,191 completed tournaments with a prize pool,
--     0 with no delivery on any rail.
--   * The other payout checks that read chip prize rows
--     (fn_satellite_conservation_audit, fn_tournament_prize_disbursement_audit,
--     fn_hu_shortfall_candidates, fn_spin_unpaid_settlements,
--     fn_ca_payout_rows_without_money, fn_spin_metrics.unpaid_settlements) all
--     read 0 over 7 days: this gauge was the only one crying wolf.
--
-- What changes:
--   1. unpaid_completed counts a tournament as unpaid only when NO rail
--      delivered value: no chip wallet prize, no Diamond prize-ledger row with
--      its journal, and no satellite award. Same signature, same columns, same
--      grants (CREATE OR REPLACE keeps the ACL).
--   2. The TournamentCompletedUnpaid rows in the Production Alerts inbox
--      (49 at measurement: 25 firing, 24 resolved, 2026-10-07..10-09) are
--      closed as verified_fixed with this evidence, but only after the block
--      below proves again, at apply time, that nothing in their span went
--      unpaid on any rail.
-- No money moves.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_tournament_metrics(
  p_overdue_minutes integer DEFAULT 10,
  p_completing_minutes integer DEFAULT 10,
  p_unpaid_hours integer DEFAULT 6)
 RETURNS TABLE(running integer, registering integer, overdue_start integer, stuck_completing integer,
               seatless_phantoms integer, unpaid_completed integer, seat_first_waiting integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    -- UNPAID means nothing of value reached anybody on ANY rail: no chip
    -- prize, no Diamond prize, and no satellite award delivered. A new rail
    -- that delivers prize-pool value must be added here, or every event it
    -- pays will read as unpaid and page the owner (2026-10-09: the Diamond
    -- rail was missing). The Diamond probe rides
    -- poker_diamond_tournament_ledger_tournament_idx (tournament_id, kind);
    -- the awards probe rides the primary key (tournament_id, place).
    (SELECT count(*) FROM tournaments t
      WHERE t.status = 'COMPLETED'
        AND t.ended_at > now() - make_interval(hours => GREATEST(p_unpaid_hours, 0))
        AND COALESCE(t.prize_pool, 0) > 0
        AND NOT EXISTS (
          SELECT 1 FROM wallet_transactions w
           WHERE w.related_entity_id = t.id AND w.category = 'prize')
        AND NOT EXISTS (
          SELECT 1 FROM poker_diamond_tournament_ledger d
           WHERE d.tournament_id = t.id
             AND d.kind = 'prize'
             AND d.wallet_journal_id IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM tournament_satellite_awards a
           WHERE a.tournament_id = t.id))::int,
    (SELECT count(*) FROM tournaments
      WHERE status IN ('REGISTERING','ANNOUNCED')
        AND tournament_type <> 'MTT'
        AND start_time < now() - make_interval(mins => GREATEST(p_overdue_minutes, 0)))::int;
$function$;

COMMENT ON FUNCTION public.fn_tournament_metrics(integer, integer, integer) IS
  'Engine gauges for tournament health. unpaid_completed feeds TournamentCompletedUnpaid (a page to the owner) and counts a completed event with a prize pool as unpaid only when no rail delivered value: chip wallet prize, Diamond prize ledger with its journal, or satellite award. Every new payout rail must be added here. Migration the_unpaid_tournament_alarm_reads_the_diamond_book, 2026-10-09.';

DO $prove$
DECLARE
  v_now  integer;
  v_week integer;
  v_span integer;
BEGIN
  -- 1. The gauge reads zero now and across the week.
  SELECT unpaid_completed INTO v_now  FROM public.fn_tournament_metrics(10, 10, 6);
  SELECT unpaid_completed INTO v_week FROM public.fn_tournament_metrics(10, 10, 168);
  IF v_now <> 0 OR v_week <> 0 THEN
    RAISE EXCEPTION 'UNPAID_ALARM_STILL_COUNTS: 6h=%, 7d=%', v_now, v_week;
  END IF;

  -- 2. Across the span every inbox row covers (6 hours before the first
  --    firing, to now) nothing went unpaid on any rail.
  SELECT count(*) INTO v_span
    FROM public.tournaments t
   WHERE t.status = 'COMPLETED'
     AND t.ended_at > timestamptz '2026-10-07 07:19:06+00'
     AND COALESCE(t.prize_pool, 0) > 0
     AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions w
                      WHERE w.related_entity_id = t.id AND w.category = 'prize')
     AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger d
                      WHERE d.tournament_id = t.id AND d.kind = 'prize'
                        AND d.wallet_journal_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.tournament_satellite_awards a
                      WHERE a.tournament_id = t.id);
  IF v_span <> 0 THEN
    RAISE EXCEPTION 'REAL_UNPAID_TOURNAMENTS_IN_ALARM_SPAN: %', v_span;
  END IF;

  -- 3. Every tournament the old count flagged in that span is a Diamond Arena
  --    event whose Diamond prize rows equal its prize pool exactly.
  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
      JOIN public.clubs c ON c.id = t.club_id
     WHERE t.status = 'COMPLETED'
       AND t.ended_at > timestamptz '2026-10-07 07:19:06+00'
       AND COALESCE(t.prize_pool, 0) > 0
       AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions w
                        WHERE w.related_entity_id = t.id AND w.category = 'prize')
       AND NOT EXISTS (SELECT 1 FROM public.tournament_satellite_awards a
                        WHERE a.tournament_id = t.id)
       AND (c.asset IS DISTINCT FROM 'diamonds'
            OR COALESCE((SELECT sum(d.prize_part) FROM public.poker_diamond_tournament_ledger d
                          WHERE d.tournament_id = t.id AND d.kind = 'prize'), 0) <> t.prize_pool)) THEN
    RAISE EXCEPTION 'OLD_FLAG_NOT_A_DIAMOND_EVENT_PAID_IN_FULL';
  END IF;
END
$prove$;

-- The false alarms close with their evidence. No other alert is touched.
UPDATE public.operational_alert_events e
   SET investigation_status = 'verified_fixed',
       investigation = COALESCE(e.investigation, '{}'::jsonb) || jsonb_build_object(
         'root_cause',
           'fn_tournament_metrics.unpaid_completed, the gauge behind TournamentCompletedUnpaid, counted only chip wallet prize rows and satellite awards. Diamond Arena events pay in Diamonds (poker_diamond_tournament_ledger prize rows with their diamond_transactions journal), so every Diamond event with a prize pool read as unpaid. Nobody was unpaid.',
         'evidence', jsonb_build_object(
           'measured_at', '2026-10-09T23:55Z',
           'old_count_flagged_since_first_firing', 32,
           'flagged_that_are_diamond_arena_events', 32,
           'diamonds_paid_of_pool', '143069 of 143069',
           'unpaid_on_any_rail_in_alarm_span_at_apply', 0,
           'completed_with_pool_7d_unpaid_on_any_rail', '0 of 204191'),
         'fixing_migration', 'the_unpaid_tournament_alarm_reads_the_diamond_book',
         'verified_at', clock_timestamp())
 WHERE e.alertname = 'TournamentCompletedUnpaid'
   AND e.investigation_status = 'new'
   AND e.received_at >= timestamptz '2026-10-07 00:00:00+00';

COMMIT;