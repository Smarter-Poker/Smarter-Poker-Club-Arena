-- ============================================================================
-- 20260819e_club_dashboard_rebuild_perf.sql
-- Club Dashboard stats — backfill performance + ordering (Tier 2)
--
-- Applied to production as:
--   20260819...  club_dashboard_rebuild_recent_first
--   20260819...  club_dashboard_rebuild_seed_last_hand_only
--
-- TWO PROBLEMS, both only visible on the large clubs (the two busiest have
-- ~4.5k and ~2.8k tables and ~1.1M hands each):
--
-- 1. ORDERING. ca_rebuild_club_member_stats walked tables in whatever order
--    the planner returned. A bounded backfill therefore spent its budget on
--    arbitrary history while the dashboard's default Time Range is "week".
--    Now ordered by each table's most recent hand, descending, so a bounded
--    run rebuilds exactly what the page is about to read.
--
-- 2. SEEDING TIMED OUT. ca_rebuild_club_member_stats_table seeded
--    club_member_table_state with DISTINCT ON (userId) over EVERY player row
--    of the table, which sorts the table's entire history — it hit the
--    statement timeout on big tables and aborted the whole batch.
--
--    Only the FINAL hand can matter. Adjacency requires that no hand ran at
--    the table without the player, so a player absent from the last hand is
--    non-adjacent to the next hand regardless of what state is stored — they
--    correctly re-baseline. Seeding from the last hand alone is equivalent
--    and reads one row instead of the full history.
--
-- ROLLBACK: re-apply the definitions in 20260819c_club_dashboard_stats_final.sql.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ca_rebuild_club_member_stats(
  p_club_id uuid,
  p_limit   integer DEFAULT 25,
  p_since   timestamptz DEFAULT now() - interval '90 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r record;
  v_done integer := 0;
BEGIN
  FOR r IN
    SELECT t.id
    FROM tables t
    JOIN LATERAL (
      SELECT max(hh.created_at) AS last_hand
      FROM hand_history hh
      WHERE hh.table_id = t.id AND hh.created_at >= p_since
    ) lh ON lh.last_hand IS NOT NULL
    WHERE t.club_id = p_club_id
      AND NOT EXISTS (
        SELECT 1 FROM club_stats_rebuild_log l
        WHERE l.table_id = t.id AND l.rebuilt_at >= p_since
      )
    ORDER BY lh.last_hand DESC
    LIMIT greatest(coalesce(p_limit, 25), 1)
  LOOP
    PERFORM ca_rebuild_club_member_stats_table(r.id);
    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END;
$fn$;

-- Only the state-seeding tail of ca_rebuild_club_member_stats_table changes;
-- the attribution body is identical to 20260819c.
CREATE OR REPLACE FUNCTION public.ca_rebuild_club_member_stats_table(p_table_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_club uuid;
  v_rows integer;
BEGIN
  SELECT club_id INTO v_club FROM tables WHERE id = p_table_id;
  IF v_club IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM club_member_daily_stats WHERE table_id = p_table_id;

  WITH hseq AS (
    SELECT hh.hand_number, hh.created_at, coalesce(hh.pot_size, 0) AS pot_size,
           coalesce(hh.rake_amount, 0) + coalesce(hh.bbj_amount, 0) AS rake_bbj,
           hh.players, hh.winners,
           row_number() OVER (ORDER BY hh.hand_number, hh.created_at) AS rn
    FROM hand_history hh
    WHERE hh.table_id = p_table_id
  ),
  seats AS (
    SELECT
      h.rn, h.created_at, h.pot_size, h.rake_bbj,
      (p->>'userId')::uuid   AS uid,
      (p->>'stack')::numeric AS stack,
      coalesce((SELECT sum((w->>'amount')::numeric)
                FROM jsonb_array_elements(coalesce(h.winners, '[]'::jsonb)) w
                WHERE w->>'userId' = p->>'userId'), 0) AS won
    FROM hseq h
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(h.players, '[]'::jsonb)) p
    WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      AND (p->>'stack') IS NOT NULL
  ),
  d AS (
    SELECT s.*,
           lag(stack) OVER (PARTITION BY uid ORDER BY rn) AS prev_stack,
           lag(rn)    OVER (PARTITION BY uid ORDER BY rn) AS prev_rn
    FROM seats s
  ),
  marked AS (
    SELECT d.*, (prev_rn = rn - 1) AS adjacent,
           CASE WHEN prev_rn = rn - 1 THEN stack - prev_stack ELSE 0 END AS delta
    FROM d
  ),
  per_hand AS (
    SELECT rn,
           count(*) AS seated,
           count(*) FILTER (WHERE adjacent) AS covered,
           coalesce(sum(delta) FILTER (WHERE adjacent), 0) AS dsum,
           max(rake_bbj) AS rake_bbj
    FROM marked GROUP BY rn
  ),
  calc AS (
    SELECT
      m.uid,
      (m.created_at AT TIME ZONE 'UTC')::date AS stat_date,
      m.won, m.pot_size, m.delta,
      (m.adjacent
       AND m.delta <= m.won + 0.001
       AND (ph.seated <> ph.covered OR abs(ph.dsum + ph.rake_bbj) < 0.005)
      ) AS attributable
    FROM marked m JOIN per_hand ph ON ph.rn = m.rn
  )
  INSERT INTO club_member_daily_stats
    (club_id, table_id, user_id, stat_date, hands_played, hands_attributed, hands_won,
     total_won, profit, biggest_pot_won, biggest_pot, topup_total)
  SELECT
    v_club, p_table_id, uid, stat_date,
    count(*),
    count(*) FILTER (WHERE attributable),
    count(*) FILTER (WHERE won > 0),
    sum(won),
    coalesce(sum(delta) FILTER (WHERE attributable), 0),
    max(won), max(pot_size),
    coalesce(sum(delta - won) FILTER (WHERE NOT attributable AND delta > won), 0)
  FROM calc
  GROUP BY uid, stat_date
  ON CONFLICT (club_id, table_id, user_id, stat_date) DO UPDATE SET
    hands_played     = EXCLUDED.hands_played,
    hands_attributed = EXCLUDED.hands_attributed,
    hands_won        = EXCLUDED.hands_won,
    total_won        = EXCLUDED.total_won,
    profit           = EXCLUDED.profit,
    biggest_pot_won  = EXCLUDED.biggest_pot_won,
    biggest_pot      = EXCLUDED.biggest_pot,
    topup_total      = EXCLUDED.topup_total,
    updated_at       = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Seed only from the final hand — see header note 2.
  WITH last_hand AS (
    SELECT hh.players, hh.hand_number
    FROM hand_history hh
    WHERE hh.table_id = p_table_id
    ORDER BY hh.hand_number DESC
    LIMIT 1
  )
  INSERT INTO club_member_table_state AS st (table_id, user_id, last_stack, last_hand_number)
  SELECT DISTINCT ON (p->>'userId')
         p_table_id, (p->>'userId')::uuid, (p->>'stack')::numeric, lh.hand_number
  FROM last_hand lh
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(lh.players, '[]'::jsonb)) p
  WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND (p->>'stack') IS NOT NULL
  ON CONFLICT (table_id, user_id) DO UPDATE SET
    last_stack       = EXCLUDED.last_stack,
    last_hand_number = EXCLUDED.last_hand_number,
    updated_at       = now();

  INSERT INTO club_stats_rebuild_log (table_id, rebuilt_at, rows_written)
  VALUES (p_table_id, now(), v_rows)
  ON CONFLICT (table_id) DO UPDATE SET rebuilt_at = now(), rows_written = EXCLUDED.rows_written;

  RETURN v_rows;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_rebuild_club_member_stats_table(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_rebuild_club_member_stats_table(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz) TO service_role;
