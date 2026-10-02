-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820140843 "eco_and_agent_commission_invariants"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d7914517bafcf8a5abbe1c885ae61c67 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Extend the credit-risk sweep with ECO and agent-commission invariants.
-- Same return type, so it slots into the governance sweep already appended
-- earlier today with no further rewrite.
--
-- Both new checks are bounded to the current settlement week and to the small
-- agented population (184 club_members across 11 agents, 3.3k rollup rows), so
-- they are safe at the 30-minute engine cadence. The ECO check costs nothing
-- while ECO is disabled.
CREATE OR REPLACE FUNCTION public.fn_union_credit_risk_check()
RETURNS TABLE(invariant text, severity text, offenders bigint, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  -- No collateral on file. Every real union holds a security deposit per
  -- club; without one the union carries the club's losses unsecured.
  SELECT 'union_club_no_terms', 'warning', count(*),
         'Member clubs with no union_club_terms row: no security deposit and '
         || 'no stop loss on file, so their losses are carried unsecured'
    FROM union_clubs uc
   WHERE NOT EXISTS (SELECT 1 FROM union_club_terms t
                      WHERE t.union_id = uc.union_id AND t.club_id = uc.club_id)
  HAVING count(*) > 0

  UNION ALL
  -- A club past its stop loss that is still active. In a real union this is
  -- the moment play is suspended until the club settles.
  SELECT 'union_club_stop_loss_breached', 'critical', count(*),
         'Clubs past their weekly stop loss and still active: '
         || COALESCE(string_agg(x.club_name || ' (exposure ' || x.exposure || ' vs limit '
                                || x.stop_loss_limit || ')', '; '), '')
    FROM (
      SELECT e.club_name, e.exposure, e.stop_loss_limit
        FROM (SELECT DISTINCT t.union_id
                FROM union_club_terms t
               WHERE t.stop_loss_limit IS NOT NULL
                 AND t.status <> 'suspended') u
        CROSS JOIN LATERAL fn_union_club_exposure(u.union_id) e
       WHERE e.breached AND e.status <> 'suspended'
    ) x
  HAVING count(*) > 0

  UNION ALL
  -- ECO is switched on but this week's adjustment was never written to the
  -- ledger, so the invoice cannot be reproduced later as it was issued.
  SELECT 'union_eco_not_recorded', 'warning', count(*),
         'Unions with ECO enabled and no union_eco_ledger row for the current '
         || 'settlement week: this week''s win tax / loss rebate is not reproducible'
    FROM unions un
   WHERE COALESCE((un.settings->>'eco_enabled')::boolean, false)
     AND EXISTS (SELECT 1 FROM union_clubs uc WHERE uc.union_id = un.id)
     AND NOT EXISTS (SELECT 1 FROM union_eco_ledger l
                      WHERE l.union_id = un.id
                        AND l.period_start >= fn_union_week_start())
  HAVING count(*) > 0

  UNION ALL
  -- Agent commission accrued by the deal but never recorded to the ledger.
  -- Surfaced 2026-08-20: 187,181 commission rows were written this week but
  -- only 26 distinct users were credited, against 184 players who have an
  -- agent, and one super_agent's 16 players had zero credited against a
  -- 48% deal.
  SELECT 'agent_commission_unrecorded', 'warning', count(*),
         'Agents with commission accrued this week but not recorded in '
         || 'agent_commissions (total variance '
         || COALESCE(round(SUM(v.variance), 2)::text, '0') || ')'
    FROM (
      SELECT cm.agent_id,
             SUM(COALESCE(rk.amt, 0) * COALESCE(a.commission_rate, 0))
               - COALESCE(SUM(cr.amt), 0) AS variance
        FROM club_members cm
        JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id
        LEFT JOIN LATERAL (
          SELECT round(SUM(u.rake_amount), 2) AS amt
            FROM union_rake_paid_daily_user u
           WHERE u.user_id = cm.user_id
             AND u.day >= (fn_union_week_start() AT TIME ZONE 'UTC')::date
        ) rk ON true
        LEFT JOIN LATERAL (
          SELECT round(SUM(ac.amount), 2) AS amt
            FROM agent_commissions ac
           WHERE ac.user_id = cm.user_id AND ac.club_id = cm.club_id
             AND ac.created_at >= fn_union_week_start()
        ) cr ON true
       WHERE cm.agent_id IS NOT NULL
       GROUP BY cm.agent_id
      HAVING SUM(COALESCE(rk.amt, 0) * COALESCE(a.commission_rate, 0))
             - COALESCE(SUM(cr.amt), 0) > 1
    ) v
  HAVING count(*) > 0;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_credit_risk_check() FROM PUBLIC, anon, authenticated;
