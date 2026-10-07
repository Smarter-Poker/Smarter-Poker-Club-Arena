-- Exact current original INSERT owner; dependencies are structural scoped fixtures.
CREATE SCHEMA smarter_private;
CREATE TABLE public.agent_commission_unsettled_rollup(
 club_id uuid NOT NULL,user_id uuid NOT NULL,owed numeric NOT NULL,rows_behind bigint NOT NULL,
 oldest_unsettled timestamptz,updated_at timestamptz,PRIMARY KEY(club_id,user_id));
CREATE OR REPLACE FUNCTION public.trg_agent_commission_rollup_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_club uuid;
BEGIN
  /* ONE KEY PER CLUB, IN CLUB ORDER, BEFORE ITS ROLLUP ROWS (2026-10-01).
     Each commission row takes its agent's unsettled row and then the club's
     day row, so a writer with two tiers held the day row while it asked for
     its second agent's row - which a tournament finish, holding that agent's
     row, was waiting to pass on its way to the day row. The club's
     commission key comes first, in club order: the cash accrual batch takes
     every key it will need before its first item (fn_credit_agent_commissions_batch,
     fn_retry_cash_accounting_sources), a finish takes them here source by
     source in club order, and within one club only its holder writes these
     rows. The sums below are unchanged. */
  FOR v_club IN SELECT DISTINCT n.club_id FROM new_rows n WHERE n.club_id IS NOT NULL ORDER BY n.club_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:'||v_club::text,0));
  END LOOP;

  INSERT INTO public.agent_commission_unsettled_rollup AS r
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT n.club_id, n.user_id,
         sum(n.amount), count(*), min(n.created_at), now()
    FROM new_rows n
   WHERE n.settled_at IS NULL AND n.club_id IS NOT NULL AND n.user_id IS NOT NULL
     AND NOT public.fn_agent_commission_paid_by_period(n.club_id, n.user_id, n.created_at)
   GROUP BY n.club_id, n.user_id
  ON CONFLICT (club_id, user_id) DO UPDATE
     SET owed             = r.owed + EXCLUDED.owed,
         rows_behind      = r.rows_behind + EXCLUDED.rows_behind,
         oldest_unsettled = least(r.oldest_unsettled, EXCLUDED.oldest_unsettled),
         updated_at       = now();

  -- Phase 6: the per-day total the Financials page reads.
  INSERT INTO public.ca_club_commission_daily AS c
         (club_id, stat_date, amount, rows_counted, updated_at)
  SELECT n.club_id, (n.created_at AT TIME ZONE 'UTC')::date, sum(n.amount), count(*), now()
    FROM new_rows n
   WHERE n.club_id IS NOT NULL
   GROUP BY n.club_id, (n.created_at AT TIME ZONE 'UTC')::date
  ON CONFLICT (club_id, stat_date) DO UPDATE
     SET amount       = c.amount + EXCLUDED.amount,
         rows_counted = c.rows_counted + EXCLUDED.rows_counted,
         updated_at   = now();
  RETURN NULL;
END;
$function$
;
REVOKE ALL ON FUNCTION public.trg_agent_commission_rollup_insert() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trg_agent_commission_rollup_insert() TO service_role;
