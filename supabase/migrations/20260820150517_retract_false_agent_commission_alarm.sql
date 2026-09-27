-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820150517 "retract_false_agent_commission_alarm"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e6d1a2b75657d481ceb9d5eb7c3c53c0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- RETRACTING MY OWN FALSE ALARM (2026-08-20)
--
-- Earlier today I reported "all 11 agents have commission accrued but never
-- recorded — 154,205.11 chips of variance" and shipped an invariant
-- (agent_commission_unrecorded) plus per-player commission columns to expose
-- it. THAT FINDING WAS WRONG. There is no missing money.
--
-- The error: `agent_commissions.user_id` is the AGENT who EARNED the
-- commission, not the player who generated the rake. Reading the writer
-- (credit_agent_commission_from_rake) makes it explicit:
--     INSERT INTO agent_commissions (club_id, user_id, ...)
--     VALUES (COALESCE(v_book_club, p_club_id), v_agent_user_id, ...)
-- I joined that column as if it were the player, so every per-player lookup
-- found nothing and the whole roster looked unpaid.
--
-- Proof it is correctly recorded: 26 distinct users were credited this week
-- and ALL 26 are agents; the super_agent I cited as having "zero credited"
-- was in fact credited 6,337.59 for the week, matching the 6,330.32 its own
-- aggregate statement reported (the small delta is elapsed time between the
-- two reads). Total credited this week: 83,533.70.
--
-- Why no replacement invariant: commission is a WATERFALL, not a flat rate.
-- The direct agent earns rake x own_rate; the parent super-agent then earns
-- (rake - direct) x parent_rate; and the row is booked to the PLAYER's
-- resolved club (fn_resolve_player_club_for_agent), which need not equal the
-- agent's own club_id. So neither "rake x commission_rate" nor "row rate ==
-- agents.commission_rate" is a valid expectation — I tested the latter and it
-- flagged 187,258 of 187,258 rows, i.e. another false positive. A false alarm
-- on money is worse than no alarm, so the check is REMOVED rather than
-- replaced with a third guess. If commission assurance is wanted later it
-- needs to model the waterfall explicitly, which is a piece of work in its
-- own right.
--
-- 1. Remove the bad invariant, keeping the three sound ones.
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
  HAVING count(*) > 0;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_credit_risk_check() FROM PUBLIC, anon, authenticated;

-- 2. Per-player breakdown WITHOUT the misleading commission columns. The
--    ledger books commission per agent per rake source, not per player, so
--    there is no honest per-player "credited" figure to show. Agent-level
--    earnings come from fn_agent_weekly_statement, which is correct.
CREATE OR REPLACE FUNCTION public.fn_agent_player_breakdown(
  p_agent_user_id uuid DEFAULT NULL,
  p_period_start timestamptz DEFAULT NULL,
  p_period_end timestamptz DEFAULT NULL)
RETURNS TABLE(
  player_id uuid, username text, club_id uuid,
  rake_generated numeric, player_net numeric,
  rakeback_rate numeric, rakeback_due numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from  timestamptz := COALESCE(p_period_start, fn_union_week_start());
  v_to    timestamptz := COALESCE(p_period_end, now());
BEGIN
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'no_agent_context' USING ERRCODE = '42704';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_agent
     AND NOT public.fn_is_any_union_overseer(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH roster AS (
    -- club_members.agent_id stores the agent's USER id, not agents.id
    SELECT DISTINCT cm.user_id AS player_id, cm.club_id
      FROM club_members cm
     WHERE cm.agent_id = v_agent
  ),
  deal AS (
    SELECT r.club_id, MAX(COALESCE(a.player_rakeback_rate, 0)) AS rb
      FROM roster r
      LEFT JOIN agents a ON a.user_id = v_agent AND a.club_id = r.club_id
     GROUP BY r.club_id
  ),
  ut AS (
    SELECT t.id FROM tables t
     WHERE t.union_id IS NOT NULL AND t.tournament_id IS NULL
  ),
  rake AS (
    SELECT u.user_id, round(SUM(u.rake_amount), 2) AS amt
      FROM union_rake_paid_daily_user u
      JOIN roster r ON r.player_id = u.user_id
     WHERE u.day >= (v_from AT TIME ZONE 'UTC')::date
       AND u.day <= (v_to   AT TIME ZONE 'UTC')::date
     GROUP BY u.user_id
  ),
  flows AS (
    SELECT wt.user_id,
           round(SUM(CASE WHEN wt.type = 'credit' THEN wt.amount ELSE -wt.amount END), 2) AS pnl
      FROM wallet_transactions wt
      JOIN roster r ON r.player_id = wt.user_id
     WHERE wt.created_at >= v_from AND wt.created_at < v_to
       AND wt.category IN ('buyin','cashout')
       AND wt.table_id IN (SELECT id FROM ut)
     GROUP BY wt.user_id
  )
  SELECT r.player_id,
         COALESCE(p.username, p.display_name, left(r.player_id::text, 8))::text,
         r.club_id,
         COALESCE(rake.amt, 0),
         COALESCE(flows.pnl, 0),
         COALESCE(d.rb, 0),
         round(COALESCE(rake.amt, 0) * COALESCE(d.rb, 0), 2)
    FROM roster r
    LEFT JOIN profiles p ON p.id = r.player_id
    LEFT JOIN deal d     ON d.club_id = r.club_id
    LEFT JOIN rake       ON rake.user_id = r.player_id
    LEFT JOIN flows      ON flows.user_id = r.player_id
   ORDER BY COALESCE(rake.amt, 0) DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_agent_player_breakdown(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_agent_player_breakdown(uuid, timestamptz, timestamptz) TO authenticated;
