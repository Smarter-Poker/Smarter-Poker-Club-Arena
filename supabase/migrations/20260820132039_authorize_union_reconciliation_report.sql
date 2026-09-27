-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820132039 "authorize_union_reconciliation_report"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 258bebcb32a64871a9d90531db4a8972 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- SEC-2 (2026-08-20): fn_union_reconciliation_report — which I added earlier
-- today — was executable by PUBLIC, i.e. by `anon`, i.e. by anyone with the
-- project's publishable key and no login at all. It is SECURITY DEFINER and
-- takes an arbitrary p_union_id, so it exposed every union's full financial
-- position: buy-ins, cash-outs, realized net, seated stacks, rake, and the
-- exact amount each club owes or is owed. Granting it to `authenticated` did
-- not remove the default PUBLIC grant.
--
-- Fix: revoke PUBLIC/anon, and authorize INSIDE the function so it is safe to
-- keep available to logged-in users for the union dashboard. A caller may
-- read a union's reconciliation only if they are:
--   * the service role (auth.uid() IS NULL — workers, engine, API routes), or
--   * the union's owner, or
--   * a union admin, or
--   * an owner/admin/super_agent of one of the union's member clubs
-- which matches the authorization the engine's admin handler uses for
-- union-owned tables. Anyone else gets a clear exception rather than data.
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
  v_caller uuid := auth.uid();
BEGIN
  -- Authorization. auth.uid() IS NULL means the service role (no JWT), which
  -- is how the workers, the engine and the API routes call this.
  IF v_caller IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM unions u
                      WHERE u.id = p_union_id AND u.owner_id = v_caller)
     AND NOT EXISTS (SELECT 1 FROM union_admins ua
                      WHERE ua.union_id = p_union_id AND ua.user_id = v_caller)
     AND NOT EXISTS (SELECT 1
                       FROM union_clubs uc
                       JOIN club_members cm ON cm.club_id = uc.club_id
                      WHERE uc.union_id = p_union_id
                        AND cm.user_id = v_caller
                        AND cm.role IN ('owner','admin','super_agent'))
  THEN
    RAISE EXCEPTION 'not authorized to read union reconciliation'
      USING ERRCODE = '42501';
  END IF;

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

REVOKE EXECUTE ON FUNCTION public.fn_union_reconciliation_report(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_reconciliation_report(uuid, timestamptz, timestamptz) TO authenticated;
