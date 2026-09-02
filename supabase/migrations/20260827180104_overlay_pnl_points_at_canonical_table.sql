-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827180104; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ca_union_insurance_pnl briefly referenced tournament_overlay_funding, the
-- table from the parallel overlay implementation that was dropped in favour of
-- the canonical fn_apply_prize_guarantee / tournament_guarantee_overlays.
-- Repointed here, and the club-side overlay report is rebuilt on the canonical
-- table so both surfaces read one source of truth.

CREATE OR REPLACE FUNCTION public.ca_union_insurance_pnl(p_union_id uuid, p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v jsonb;
  v_from date := (now() AT TIME ZONE 'UTC')::date - (greatest(least(coalesce(p_days,14), 90), 1) - 1);
BEGIN
  IF NOT ca_can_oversee_union(p_union_id) THEN
    RAISE EXCEPTION 'not authorized for this union' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'union_id', p_union_id,
    'range_days', greatest(least(coalesce(p_days,14), 90), 1),
    'totals', (
      SELECT jsonb_build_object(
        'contracts', coalesce(count(*), 0),
        'premiums',  round(coalesce(sum(it.premium), 0), 2),
        'payouts',   round(coalesce(sum(it.payout), 0), 2),
        'net',       round(coalesce(sum(it.premium - it.payout), 0), 2))
      FROM insurance_transactions it
      WHERE it.union_id = p_union_id AND it.bank_type = 'union'
        AND it.created_at >= v_from::timestamptz
    ),
    -- Guarantee overlays this union's bank covered.
    'overlay', (
      SELECT jsonb_build_object(
        'events', coalesce(count(*), 0),
        'funded', round(coalesce(sum(o.amount), 0), 2))
      FROM tournament_guarantee_overlays o
      WHERE o.bank_type = 'union' AND o.bank_entity_id = p_union_id
        AND o.funded_at >= v_from::timestamptz
    ),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'd', g.day::date,
               'contracts', coalesce(i.n, 0),
               'premiums', coalesce(i.prem, 0),
               'payouts', coalesce(i.pay, 0),
               'net', coalesce(i.net, 0),
               'overlay', coalesce(ov.funded, 0))
             ORDER BY g.day)
      FROM generate_series(v_from, (now() AT TIME ZONE 'UTC')::date, interval '1 day') g(day)
      LEFT JOIN (
        SELECT (it.created_at AT TIME ZONE 'UTC')::date AS d,
               count(*) AS n,
               round(sum(it.premium), 2) AS prem,
               round(sum(it.payout), 2) AS pay,
               round(sum(it.premium - it.payout), 2) AS net
          FROM insurance_transactions it
         WHERE it.union_id = p_union_id AND it.bank_type = 'union'
           AND it.created_at >= v_from::timestamptz
         GROUP BY 1
      ) i ON i.d = g.day::date
      LEFT JOIN (
        SELECT (o.funded_at AT TIME ZONE 'UTC')::date AS d,
               round(sum(o.amount), 2) AS funded
          FROM tournament_guarantee_overlays o
         WHERE o.bank_type = 'union' AND o.bank_entity_id = p_union_id
           AND o.funded_at >= v_from::timestamptz
         GROUP BY 1
      ) ov ON ov.d = g.day::date
    ), '[]'::jsonb),
    'by_club', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'club_id', q.club_id, 'club_name', q.club_name,
               'contracts', q.n, 'premiums', q.prem, 'payouts', q.pay, 'net', q.net)
             ORDER BY q.net DESC)
      FROM (
        SELECT it.club_id, coalesce(c.name, 'Unknown') AS club_name,
               count(*) AS n,
               round(sum(it.premium), 2) AS prem,
               round(sum(it.payout), 2) AS pay,
               round(sum(it.premium - it.payout), 2) AS net
          FROM insurance_transactions it
          LEFT JOIN clubs c ON c.id = it.club_id
         WHERE it.union_id = p_union_id AND it.bank_type = 'union'
           AND it.created_at >= v_from::timestamptz
         GROUP BY it.club_id, c.name
      ) q
    ), '[]'::jsonb),
    'generated_at', now()
  ) INTO v;

  RETURN v;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.ca_club_overlay_pnl(p_club_id uuid, p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v jsonb;
  v_from date := (now() AT TIME ZONE 'UTC')::date - (greatest(least(coalesce(p_days,14), 90), 1) - 1);
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'club_id', p_club_id,
    'range_days', greatest(least(coalesce(p_days,14), 90), 1),
    'totals', (
      SELECT jsonb_build_object(
        'events', coalesce(count(*), 0),
        'funded', round(coalesce(sum(o.amount), 0), 2),
        'bank', coalesce(max(o.bank_type),
                         (SELECT CASE WHEN c.union_id IS NULL THEN 'club' ELSE 'union' END
                            FROM clubs c WHERE c.id = p_club_id)))
      FROM tournament_guarantee_overlays o
      WHERE o.club_id = p_club_id AND o.funded_at >= v_from::timestamptz
    ),
    'events', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'tournament_id', o.tournament_id,
               'name', coalesce(t.name, 'Unknown'),
               'overlay', o.amount,
               'pool_before', o.pool_before,
               'pool_after', o.pool_after,
               'bank', o.bank_type,
               'at', o.funded_at)
             ORDER BY o.funded_at DESC)
      FROM tournament_guarantee_overlays o
      LEFT JOIN tournaments t ON t.id = o.tournament_id
      WHERE o.club_id = p_club_id AND o.funded_at >= v_from::timestamptz
    ), '[]'::jsonb),
    'generated_at', now()
  ) INTO v;

  RETURN v;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_overlay_pnl(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_overlay_pnl(uuid, integer) TO authenticated;
