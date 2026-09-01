-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828165810; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-08-28: club-facing insurance report RPC. Mirrored in repo:
-- supabase/migrations/20260828200000_ca_club_insurance_report_rpc.sql
-- Gated on ca_can_view_club_finances (staff), ERRCODE 42501 like its
-- siblings. Funnel from insurance_offer_events, money from
-- insurance_transactions, one jsonb payload for the CA page.

CREATE OR REPLACE FUNCTION public.ca_club_insurance_report(p_club_id uuid, p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 90);
BEGIN
  IF NOT ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'window_days', v_days,
    'bank', (SELECT CASE WHEN c.union_id IS NOT NULL THEN 'union' ELSE 'club' END
             FROM clubs c WHERE c.id = p_club_id),
    'totals', (
      SELECT jsonb_build_object(
        'offers',    COALESCE(SUM((e.event = 'offered')::int), 0),
        'accepted',  COALESCE(SUM((e.event = 'accepted')::int), 0),
        'declined',  COALESCE(SUM((e.event = 'declined')::int), 0),
        'timeouts',  COALESCE(SUM((e.event = 'timeout')::int), 0),
        'cashouts',  COALESCE(SUM((e.event = 'cashed_out')::int), 0),
        'avg_offer_equity', ROUND(AVG(e.equity_percent) FILTER (WHERE e.event = 'offered'), 1),
        'avg_offer_pot',    ROUND(AVG(e.pot) FILTER (WHERE e.event = 'offered'), 2)
      )
      FROM insurance_offer_events e
      WHERE e.club_id = p_club_id
        AND e.created_at > now() - (v_days || ' days')::interval
    ),
    'money', (
      SELECT jsonb_build_object(
        'contracts', COUNT(*),
        'insurance_contracts', COALESCE(SUM((t.kind = 'insurance')::int), 0),
        'cashout_contracts',   COALESCE(SUM((t.kind = 'ev_cashout')::int), 0),
        'bank_in',  ROUND(COALESCE(SUM(t.premium), 0), 2),
        'bank_out', ROUND(COALESCE(SUM(t.payout), 0), 2),
        'bank_net', ROUND(COALESCE(SUM(t.premium - t.payout), 0), 2)
      )
      FROM insurance_transactions t
      WHERE t.club_id = p_club_id
        AND t.created_at > now() - (v_days || ' days')::interval
    ),
    'days', COALESCE((
      SELECT jsonb_agg(row_to_json(d) ORDER BY d.day DESC)
      FROM (
        SELECT
          COALESCE(a.day, m.day) AS day,
          COALESCE(a.offers, 0)    AS offers,
          COALESCE(a.accepted, 0)  AS accepted,
          COALESCE(a.declined, 0)  AS declined,
          COALESCE(a.timeouts, 0)  AS timeouts,
          COALESCE(a.cashouts, 0)  AS cashouts,
          COALESCE(m.contracts, 0) AS contracts,
          COALESCE(m.bank_in, 0)   AS bank_in,
          COALESCE(m.bank_out, 0)  AS bank_out,
          COALESCE(m.bank_net, 0)  AS bank_net
        FROM (
          SELECT (e.created_at AT TIME ZONE 'utc')::date AS day,
                 SUM((e.event = 'offered')::int)   AS offers,
                 SUM((e.event = 'accepted')::int)  AS accepted,
                 SUM((e.event = 'declined')::int)  AS declined,
                 SUM((e.event = 'timeout')::int)   AS timeouts,
                 SUM((e.event = 'cashed_out')::int) AS cashouts
          FROM insurance_offer_events e
          WHERE e.club_id = p_club_id
            AND e.created_at > now() - (v_days || ' days')::interval
          GROUP BY 1
        ) a
        FULL OUTER JOIN (
          SELECT (t.created_at AT TIME ZONE 'utc')::date AS day,
                 COUNT(*) AS contracts,
                 ROUND(SUM(t.premium), 2) AS bank_in,
                 ROUND(SUM(t.payout), 2)  AS bank_out,
                 ROUND(SUM(t.premium - t.payout), 2) AS bank_net
          FROM insurance_transactions t
          WHERE t.club_id = p_club_id
            AND t.created_at > now() - (v_days || ' days')::interval
          GROUP BY 1
        ) m USING (day)
      ) d
    ), '[]'::jsonb)
  ) INTO v;

  RETURN v;
END;
$function$;
