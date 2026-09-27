-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820121902 "union_rollup_invariant_and_reconciliation_report"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 17054eb7dd058381cabac2916127f7b6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- 2026-08-20 REVIEW ROUND 3:
--  (a) a governance invariant so a rollup that stops being maintained is
--      visible BEFORE Monday rather than as a slow settlement;
--  (b) fn_union_reconciliation_report — the read-only pre-Monday preview the
--      handoff asked for (P3-5). Shows exactly what the settlement would do,
--      including the residual and the tolerance the guard will apply, WITHOUT
--      writing anything or creating a temp table (the existing dry run is
--      VOLATILE and cannot be used from a report/RLS context).

-- ─── (a) governance: rollup maintenance ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_union_governance_check()
 RETURNS TABLE(invariant text, severity text, offenders bigint, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT 'club_owned_cash_table_in_union', 'critical', count(*),
         'Open cash tables under a union club with no union_id and not private'
    FROM tables t JOIN union_clubs uc ON uc.club_id = t.club_id
   WHERE t.union_id IS NULL AND COALESCE(t.is_private,false) = false
     AND t.tournament_id IS NULL AND COALESCE(t.is_deleted,false) = false
     AND t.status NOT IN ('closed','deleted')
  HAVING count(*) > 0

  UNION ALL
  SELECT 'club_owned_tournament_in_union', 'critical', count(*),
         'Live non-private tournaments under a union club with no union_id'
    FROM tournaments t JOIN union_clubs uc ON uc.club_id = t.club_id
   WHERE t.union_id IS NULL AND COALESCE(t.is_private,false) = false
     AND t.status IN ('ANNOUNCED','SCHEDULED','REGISTERING','LATE_REG','RUNNING')
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_game_not_owned_by_union', 'critical', count(*),
         'Live union games whose club_id names a member club instead of the union '
         || '(cash/MTT/SNG/Spin)'
    FROM (
      SELECT id FROM tables
       WHERE union_id IS NOT NULL AND COALESCE(is_private,false) = false
         AND club_id IS DISTINCT FROM union_id
         AND COALESCE(is_deleted,false) = false AND status NOT IN ('closed','deleted')
      UNION ALL
      SELECT id FROM tournaments
       WHERE union_id IS NOT NULL AND COALESCE(is_private,false) = false
         AND club_id IS DISTINCT FROM union_id
         AND status IN ('ANNOUNCED','SCHEDULED','REGISTERING','LATE_REG','RUNNING')
    ) x
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_lost_a_member_club', 'critical', count(*),
         'Clubs expected in Midway Union that are no longer members'
    FROM (
      SELECT c.id FROM clubs c
       WHERE c.id IN ('a0000000-0000-0000-0000-000000000001',
                      'a41434bb-8d0c-400a-8f0d-e8b3d65afed4')
         AND NOT EXISTS (SELECT 1 FROM union_clubs uc
                          WHERE uc.club_id = c.id
                            AND uc.union_id = 'fade0000-0000-0000-0000-000000000001')
    ) m
  HAVING count(*) > 0

  UNION ALL
  SELECT 'clubs_union_id_mirror_drift', 'critical', count(*),
         'clubs.union_id disagrees with union_clubs'
    FROM union_clubs uc JOIN clubs c ON c.id = uc.club_id
   WHERE c.union_id IS DISTINCT FROM uc.union_id
  HAVING count(*) > 0

  UNION ALL
  SELECT 'private_game_union_visible', 'critical', count(*),
         'Rows flagged private that still carry a union_id'
    FROM (
      SELECT id FROM tables WHERE COALESCE(is_private,false) AND union_id IS NOT NULL
      UNION ALL
      SELECT id FROM tournaments WHERE COALESCE(is_private,false) AND union_id IS NOT NULL
    ) x
  HAVING count(*) > 0

  UNION ALL
  SELECT 'ownership_triggers_missing', 'critical', 5 - count(*),
         'Expected 5 union ownership/mirror triggers'
    FROM pg_trigger
   WHERE tgname IN ('trg_tables_union_ownership','trg_tournaments_union_ownership',
                    'trg_union_clubs_sync_mirror','trg_tables_union_ownership_upd',
                    'trg_tournaments_union_ownership_upd')
  HAVING count(*) < 5

  UNION ALL
  SELECT 'tables_rls_not_private_aware', 'critical', 1,
         'tables SELECT policy no longer considers is_private'
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policy
      WHERE polrelid = 'public.tables'::regclass AND polcmd = 'r'
        AND pg_get_expr(polqual, polrelid) LIKE '%is_private%')

  UNION ALL
  SELECT 'union_clubs_unreadable_by_members', 'critical', 1,
         'A club member can no longer discover their own union (union_clubs RLS)'
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policy
      WHERE polrelid = 'public.union_clubs'::regclass AND polcmd = 'r'
        AND pg_get_expr(polqual, polrelid) LIKE '%club_members%')

  UNION ALL
  SELECT 'union_rake_wallet_stale', 'warning', count(*),
         'Union rake wallets holding a balance with no rakeback in 14 days'
    FROM union_wallets uw
   WHERE uw.rake_wallet > 0
     AND NOT EXISTS (
       SELECT 1 FROM union_wallet_transactions t
        WHERE t.union_id = uw.union_id AND t.wallet = 'rake_wallet'
          AND t.direction = 'debit' AND t.created_at > now() - interval '14 days')
  HAVING count(*) > 0

  UNION ALL
  SELECT 'settlement_needs_review', 'warning', count(*),
         'Player P&L periods parked for review and never re-settled'
    FROM union_pnl_settlements WHERE status = 'needs_review'
  HAVING count(*) > 0

  UNION ALL
  SELECT 'settlement_period_overdue_open', 'warning', count(*),
         'settlement_periods still open/processing more than 24h past end_at'
    FROM settlement_periods
   WHERE status IN ('open','processing') AND end_at < now() - interval '24 hours'
  HAVING count(*) > 0

  UNION ALL
  SELECT 'settlement_period_orphan', 'critical', count(*),
         'settlement_periods with NULL club_id AND NULL union_id'
    FROM settlement_periods
   WHERE club_id IS NULL AND union_id IS NULL
  HAVING count(*) > 0

  UNION ALL
  -- 2026-08-20: the rake rollup is a speed cache only (a stale day is
  -- recomputed live), so this is a WARNING, not a correctness alarm: it means
  -- the settlement will do that work inline while holding treasury locks.
  SELECT 'union_rake_rollup_unmaintained', 'warning', count(*),
         'Unions with 3+ stale/missing rake rollup days in the last week — the '
         || 'weekly settlement would recompute them while holding treasury locks'
    FROM (
      SELECT un.id,
             (SELECT count(*)
                FROM generate_series((now() AT TIME ZONE 'UTC')::date - 7,
                                     (now() AT TIME ZONE 'UTC')::date - 1,
                                     interval '1 day') gs
               WHERE NOT fn_union_rake_day_is_fresh(un.id, gs::date)) AS stale_days
        FROM unions un
       WHERE EXISTS (SELECT 1 FROM union_clubs uc WHERE uc.union_id = un.id)
    ) s
   WHERE s.stale_days >= 3
  HAVING count(*) > 0;
$function$;

-- ─── (b) read-only pre-Monday reconciliation preview ─────────────────────────
CREATE OR REPLACE FUNCTION public.fn_union_reconciliation_report(
  p_union_id uuid, p_start timestamptz, p_end timestamptz)
RETURNS TABLE(
  club_id uuid, club_name text,
  buyins numeric, cashouts numeric, realized_net numeric,
  seated_start numeric, seated_end numeric, stack_delta numeric,
  rake_paid numeric, settle_net numeric, direction text,
  turnover numeric, house_residual numeric, tolerance numeric, within_tolerance boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_prev jsonb;
BEGIN
  v_prev := fn_union_pnl_baseline(p_union_id, p_start);

  RETURN QUERY
  WITH pnl AS (
    SELECT c.club_id, c.buyins, c.cashouts, c.realized_net, c.seated_stack
      FROM fn_union_pnl_all_clubs(p_union_id, p_start, p_end, true) c
  ),
  rk AS (
    SELECT r.club_id, r.rake_paid
      FROM fn_union_rake_paid_readonly(p_union_id, p_start, p_end, true) r
  ),
  base AS (
    SELECT (e->>'club_id')::uuid AS club_id, (e->>'seated_end')::numeric AS seated_start
      FROM jsonb_array_elements(COALESCE(v_prev, '[]'::jsonb)) e
  ),
  rows AS (
    SELECT p.club_id,
           cl.name::text AS club_name,
           p.buyins, p.cashouts, p.realized_net,
           COALESCE(b.seated_start, p.seated_stack) AS seated_start,
           p.seated_stack AS seated_end,
           round(p.seated_stack - COALESCE(b.seated_start, p.seated_stack), 2) AS stack_delta,
           COALESCE(k.rake_paid, 0) AS rake_paid,
           round(p.realized_net
                 + (p.seated_stack - COALESCE(b.seated_start, p.seated_stack))
                 + COALESCE(k.rake_paid, 0), 2) AS settle_net,
           (p.buyins + p.cashouts) AS turnover
      FROM pnl p
      LEFT JOIN clubs cl ON cl.id = p.club_id
      LEFT JOIN rk k ON k.club_id = p.club_id
      LEFT JOIN base b ON b.club_id = p.club_id
  ),
  agg AS (
    SELECT round(SUM(r.settle_net), 2) AS residual,
           round(SUM(r.turnover), 2) AS total_turnover
      FROM rows r
  )
  SELECT r.club_id, r.club_name, r.buyins, r.cashouts, r.realized_net,
         r.seated_start, r.seated_end, r.stack_delta, r.rake_paid, r.settle_net,
         CASE WHEN r.settle_net < 0 THEN 'club pays union'
              WHEN r.settle_net > 0 THEN 'union pays club'
              ELSE 'square' END::text,
         r.turnover,
         a.residual,
         GREATEST(100, round(a.total_turnover * 0.01, 2)),
         abs(a.residual) <= GREATEST(100, round(a.total_turnover * 0.01, 2))
    FROM rows r CROSS JOIN agg a
   ORDER BY r.settle_net;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_union_reconciliation_report(uuid, timestamptz, timestamptz) TO authenticated;
