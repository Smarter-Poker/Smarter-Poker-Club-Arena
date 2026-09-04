-- ═══════════════════════════════════════════════════════════════════════════
--  THE BUSIEST TABLES COUNT TABLE HANDS
--  Club Operations upgrade, phase 6 of 8. Found by the gate on phase 6.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Phase 6 set out to make "hands" mean one thing, and left the dashboard's own
-- Busiest Tables list counting something else. `ca_club_revenue.by_table` sums
-- `club_member_daily_stats.hands_played`, which is one row PER PLAYER PER
-- HAND, and the client prints it as "Hands". Measured over seven days on
-- Deep Stack Society:
--
--   Busiest Tables, as shipped   2,113,324  "Hands"
--   hands actually dealt            596,730  (club_hand_daily)
--   hands actually raked            181,766  (club_table_daily)
--
-- An 11.6x overstatement, on the same page whose cards this phase relabelled
-- so that raked hands and hands dealt could not be confused - and it is
-- literally the defect the plan document named ("Hands means two different
-- things across two tabs of one page"). It survived because I changed the
-- totals and never looked down the page at the list.
--
-- A table's hands are its hands. `club_table_daily.hands` is COUNT(DISTINCT
-- rake_record) per (club, table, day) - the raked hands played AT that table,
-- attributed to this club - which is the same basis as the Rake column beside
-- it and as the headline above it. The player count stays a DISTINCT count of
-- people, which is what it always was and is not affected.
--
-- Tables with wallet movement but no raked hand still appear (a table that
-- was bought into and never dealt a raked pot is real activity), so the join
-- is a FULL one over the same window.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '0';

CREATE OR REPLACE FUNCTION public.ca_club_revenue(p_club_id uuid, p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  v_from date := (now() AT TIME ZONE 'UTC')::date - (greatest(least(coalesce(p_days,14), 90), 1) - 1);
  v_union uuid;
BEGIN
  IF NOT ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT union_id INTO v_union FROM clubs WHERE id = p_club_id;

  SELECT jsonb_build_object(
    'range_days', greatest(least(coalesce(p_days,14), 90), 1),
    'totals', (
      SELECT jsonb_build_object(
        'hands', coalesce(sum(d.hands), 0),
        'hands_dealt', coalesce((SELECT sum(h.hands) FROM club_hand_daily h
                                  WHERE h.club_id = p_club_id AND h.stat_date >= v_from), 0),
        'rake',  round(coalesce(sum(d.rake), 0), 2),
        'bbj',   round(coalesce(sum(d.bbj), 0), 2),
        'pot_total', round(coalesce(sum(d.pot), 0), 2),
        'tournament_fees', round(coalesce((SELECT sum(t.fee) FROM ca_club_tournament_daily t
                                            WHERE t.club_id = p_club_id AND t.stat_date >= v_from), 0), 2),
        'avg_pot', CASE WHEN coalesce(sum(d.hands),0) > 0
                        THEN round(sum(d.pot) / sum(d.hands), 4) ELSE 0 END,
        'rake_per_hand', CASE WHEN coalesce(sum(d.hands),0) > 0
                        THEN round(sum(d.rake) / sum(d.hands), 4) ELSE 0 END
      )
      FROM ca_club_rake_daily d
      WHERE d.club_id = p_club_id AND d.stat_date >= v_from
    ),
    'insurance', (
      SELECT jsonb_build_object(
        'contracts', coalesce(count(*), 0),
        'premiums',  round(coalesce(sum(it.premium), 0), 2),
        'payouts',   round(coalesce(sum(it.payout), 0), 2),
        'net',       round(coalesce(sum(it.premium - it.payout), 0), 2),
        'bank',      CASE WHEN v_union IS NULL THEN 'club' ELSE 'union' END)
      FROM insurance_transactions it
      WHERE it.club_id = p_club_id
        AND it.created_at >= (v_from::timestamp AT TIME ZONE 'UTC')
    ),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'd', g.day::date,
               'hands', coalesce(d.hands, 0),
               'hands_dealt', coalesce(h.hands, 0),
               'rake', round(coalesce(d.rake, 0), 2),
               'bbj', round(coalesce(d.bbj, 0), 2),
               'pot_total', round(coalesce(d.pot, 0), 2),
               'tournament_fees', round(coalesce(m.fee, 0), 2),
               'ins_net', coalesce(i.net, 0))
             ORDER BY g.day)
      FROM generate_series(v_from, (now() AT TIME ZONE 'UTC')::date, interval '1 day') g(day)
      LEFT JOIN ca_club_rake_daily d ON d.club_id = p_club_id AND d.stat_date = g.day::date
      LEFT JOIN club_hand_daily h ON h.club_id = p_club_id AND h.stat_date = g.day::date
      LEFT JOIN (
        SELECT t.stat_date, sum(t.fee) AS fee FROM ca_club_tournament_daily t
         WHERE t.club_id = p_club_id AND t.stat_date >= v_from GROUP BY t.stat_date
      ) m ON m.stat_date = g.day::date
      LEFT JOIN (
        SELECT (it.created_at AT TIME ZONE 'UTC')::date AS d,
               round(sum(it.premium - it.payout), 2) AS net
          FROM insurance_transactions it
         WHERE it.club_id = p_club_id AND it.created_at >= (v_from::timestamp AT TIME ZONE 'UTC')
         GROUP BY 1
      ) i ON i.d = g.day::date
    ), '[]'::jsonb),
    -- RAKED HANDS AT THE TABLE, not player-hands. See the header: this summed
    -- club_member_daily_stats.hands_played, one row per player per hand, and
    -- the client printed it as "Hands" - 2,113,324 against 596,730 dealt.
    'by_table', coalesce((
      SELECT jsonb_agg(x ORDER BY (x->>'hands')::bigint DESC, (x->>'players')::int DESC)
      FROM (
        SELECT jsonb_build_object(
                 'table_id', q.table_id,
                 'name', coalesce(t.name, 'Unnamed'),
                 'status', coalesce(t.status, 'unknown'),
                 'stakes', coalesce(t.stakes,
                            concat(t.small_blind::text, '/', t.big_blind::text)),
                 'hands', q.hands,
                 'rake', round(q.rake, 2),
                 'players', q.players
               ) AS x
        FROM (
          SELECT coalesce(c.table_id, s.table_id) AS table_id,
                 coalesce(c.hands, 0)::bigint AS hands,
                 coalesce(c.rake, 0)::numeric AS rake,
                 coalesce(s.players, 0)::integer AS players
            FROM (
              SELECT c.table_id, sum(c.hands)::bigint AS hands, sum(c.rake) AS rake
                FROM club_table_daily c
               WHERE c.club_id = p_club_id AND c.stat_date >= v_from
               GROUP BY c.table_id
            ) c
            FULL OUTER JOIN (
              SELECT s.table_id, count(DISTINCT s.user_id)::integer AS players
                FROM club_member_daily_stats s
               WHERE s.club_id = p_club_id AND s.stat_date >= v_from
               GROUP BY s.table_id
            ) s ON s.table_id = c.table_id
        ) q
        LEFT JOIN tables t ON t.id = q.table_id
        WHERE q.table_id IS NOT NULL
        ORDER BY q.hands DESC, q.players DESC
        LIMIT 20
      ) z
    ), '[]'::jsonb),
    'rake_source', 'rake_records',
    'data_updated_at', (SELECT max(d.updated_at) FROM ca_club_rake_daily d
                         WHERE d.club_id = p_club_id AND d.stat_date >= v_from)
  ) INTO v;

  RETURN v;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_revenue(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_revenue(uuid, integer) TO authenticated, service_role;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'ca_club_revenue'
     AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%sum(s.hands_played)%' THEN
    RAISE EXCEPTION 'Busiest Tables still counts a hand once per player sitting in it';
  END IF;
  IF v_src NOT LIKE '%FROM club_table_daily c%' THEN
    RAISE EXCEPTION 'Busiest Tables no longer reads the per-table rollup';
  END IF;
END $$;

COMMIT;
