-- ═══════════════════════════════════════════════════════════════════════════
-- INSURANCE P&L IN THE DAILY REPORTS — Dan 2026-08-26:
-- "profit and loss needs to be tracked by the union (or club if it's a
--  standalone club with no union affiliation) ... in the daily profit and
--  loss, or anywhere it's supposed to be."
--
-- Source of truth is insurance_transactions: one row per settled contract
-- (premium in, payout out, bank_type/bank_entity_id say whose bank moved).
-- Two report surfaces gain the numbers:
--
--   1. ca_club_revenue — the club daily P&L (ClubDashboard). Gains a
--      totals.insurance object and a per-day ins_net column. The `bank`
--      field says where the money actually settles ('union' for affiliated
--      clubs, 'club' for standalone) so the dashboard can caption it
--      honestly instead of implying union insurance money is club money.
--
--   2. ca_union_insurance_pnl — NEW: the union's own daily insurance P&L
--      (totals, per-day, per-club), oversight-gated like the statement
--      board. Live from the ledger, not from weekly invoices, because
--      insurance settles into the union wallet in real time.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.ca_club_revenue(p_club_id uuid, p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v jsonb;
  v_from date := (now() AT TIME ZONE 'UTC')::date - (greatest(least(coalesce(p_days,14), 90), 1) - 1);
  v_union uuid;
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT union_id INTO v_union FROM clubs WHERE id = p_club_id;

  SELECT jsonb_build_object(
    'range_days', greatest(least(coalesce(p_days,14), 90), 1),
    'totals', (
      SELECT jsonb_build_object(
        'hands', coalesce(sum(d.hands), 0),
        'rake',  coalesce(sum(d.rake), 0),
        'bbj',   coalesce(sum(d.bbj), 0),
        'pot_total', coalesce(sum(d.pot_total), 0),
        'avg_pot', CASE WHEN coalesce(sum(d.hands),0) > 0
                        THEN round(sum(d.pot_total) / sum(d.hands), 4) ELSE 0 END,
        'rake_per_hand', CASE WHEN coalesce(sum(d.hands),0) > 0
                        THEN round(sum(d.rake) / sum(d.hands), 4) ELSE 0 END
      )
      FROM club_hand_daily d
      WHERE d.club_id = p_club_id AND d.stat_date >= v_from
    ),
    -- INSURANCE P&L 2026-08-27: settled contracts written at this club's
    -- tables. `bank` names where the money settles.
    'insurance', (
      SELECT jsonb_build_object(
        'contracts', coalesce(count(*), 0),
        'premiums',  round(coalesce(sum(it.premium), 0), 2),
        'payouts',   round(coalesce(sum(it.payout), 0), 2),
        'net',       round(coalesce(sum(it.premium - it.payout), 0), 2),
        'bank',      CASE WHEN v_union IS NULL THEN 'club' ELSE 'union' END)
      FROM insurance_transactions it
      WHERE it.club_id = p_club_id
        AND it.created_at >= v_from::timestamptz
    ),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'd', g.day::date,
               'hands', coalesce(d.hands, 0),
               'rake', coalesce(d.rake, 0),
               'bbj', coalesce(d.bbj, 0),
               'pot_total', coalesce(d.pot_total, 0),
               'ins_net', coalesce(i.net, 0))
             ORDER BY g.day)
      FROM generate_series(v_from, (now() AT TIME ZONE 'UTC')::date, interval '1 day') g(day)
      LEFT JOIN club_hand_daily d ON d.club_id = p_club_id AND d.stat_date = g.day::date
      LEFT JOIN (
        SELECT (it.created_at AT TIME ZONE 'UTC')::date AS d,
               round(sum(it.premium - it.payout), 2) AS net
          FROM insurance_transactions it
         WHERE it.club_id = p_club_id AND it.created_at >= v_from::timestamptz
         GROUP BY 1
      ) i ON i.d = g.day::date
    ), '[]'::jsonb),
    'by_table', coalesce((
      SELECT jsonb_agg(x ORDER BY (x->>'hands')::bigint DESC)
      FROM (
        SELECT jsonb_build_object(
                 'table_id', s.table_id,
                 'name', coalesce(t.name, 'Unnamed'),
                 'status', coalesce(t.status, 'unknown'),
                 'stakes', coalesce(t.stakes,
                            concat(t.small_blind::text, '/', t.big_blind::text)),
                 'hands', sum(s.hands_played),
                 'players', count(DISTINCT s.user_id)
               ) AS x
        FROM club_member_daily_stats s
        LEFT JOIN tables t ON t.id = s.table_id
        WHERE s.club_id = p_club_id AND s.stat_date >= v_from
        GROUP BY s.table_id, t.name, t.status, t.stakes, t.small_blind, t.big_blind
        ORDER BY sum(s.hands_played) DESC
        LIMIT 20
      ) q
    ), '[]'::jsonb)
  ) INTO v;

  RETURN v;
END;
$fn$;

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
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'd', g.day::date,
               'contracts', coalesce(i.n, 0),
               'premiums', coalesce(i.prem, 0),
               'payouts', coalesce(i.pay, 0),
               'net', coalesce(i.net, 0))
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

REVOKE ALL ON FUNCTION public.ca_union_insurance_pnl(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_union_insurance_pnl(uuid, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.ca_club_revenue(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_revenue(uuid, integer) TO authenticated;
