-- UNAPPLIED. Only unpaid legacy liability projections exclude source-owned rows.
CREATE OR REPLACE FUNCTION public.fn_agent_commission_rollup_recompute(p_pairs jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  WITH pairs AS (
    SELECT DISTINCT (p->>'club_id')::uuid AS club_id, (p->>'user_id')::uuid AS user_id
      FROM jsonb_array_elements(p_pairs) p
     WHERE p->>'club_id' IS NOT NULL AND p->>'user_id' IS NOT NULL
  ),
  fresh AS (
    SELECT pr.club_id, pr.user_id,
           coalesce(sum(ac.amount), 0)  AS owed,
           count(ac.id)                 AS rows_behind,
           min(ac.created_at)           AS oldest
      FROM pairs pr
      LEFT JOIN public.agent_commissions ac
        ON ac.club_id = pr.club_id AND ac.user_id = pr.user_id
       AND ac.settled_at IS NULL AND ac.commission_capture_version IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                        WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                          AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)
     GROUP BY pr.club_id, pr.user_id
  )
  INSERT INTO public.agent_commission_unsettled_rollup AS r
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT f.club_id, f.user_id, f.owed, f.rows_behind, f.oldest, now() FROM fresh f
  ON CONFLICT (club_id, user_id) DO UPDATE
     SET owed = EXCLUDED.owed,
         rows_behind = EXCLUDED.rows_behind,
         oldest_unsettled = EXCLUDED.oldest_unsettled,
         updated_at = now();
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_agent_commission_rollup_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.agent_commission_unsettled_rollup AS r
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT n.club_id, n.user_id,
         sum(n.amount), count(*), min(n.created_at), now()
    FROM new_rows n
   WHERE n.settled_at IS NULL AND n.commission_capture_version IS NULL AND n.club_id IS NOT NULL AND n.user_id IS NOT NULL
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
$function$;

CREATE OR REPLACE VIEW public.agent_commissions_unsettled WITH (security_invoker=true) AS
 SELECT id,
    club_id,
    user_id,
    amount,
    commission_rate,
    source_type,
    source_id,
    notes,
    created_at,
    settled_at
   FROM agent_commissions ac
  WHERE settled_at IS NULL AND ac.commission_capture_version IS NULL AND NOT (EXISTS ( SELECT 1
           FROM agent_commission_settlements s
          WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id AND ac.created_at >= s.period_start AND ac.created_at < s.period_end));
