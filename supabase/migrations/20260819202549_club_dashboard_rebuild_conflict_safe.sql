-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819202549 "club_dashboard_rebuild_conflict_safe"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6c30fdbc9a79c55b440164295de1f463 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: ca_rebuild_club_member_stats_table raced the live trigger on an
-- actively-dealing table. The DELETE and the INSERT are separate statements,
-- so a hand landing between them made the trigger write a row that the bulk
-- INSERT then collided with. The bulk INSERT's snapshot already INCLUDES that
-- hand, so the rebuilt value is the complete one — resolve by letting the
-- rebuild win rather than erroring out.
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

  WITH seats AS (
    SELECT
      hh.hand_number,
      hh.created_at,
      coalesce(hh.pot_size, 0) AS pot_size,
      (p->>'userId')::uuid     AS uid,
      (p->>'stack')::numeric   AS stack,
      coalesce((SELECT sum((w->>'amount')::numeric)
                FROM jsonb_array_elements(coalesce(hh.winners, '[]'::jsonb)) w
                WHERE w->>'userId' = p->>'userId'), 0) AS won
    FROM hand_history hh
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(hh.players, '[]'::jsonb)) p
    WHERE hh.table_id = p_table_id
      AND (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      AND (p->>'stack') IS NOT NULL
  ),
  d AS (
    SELECT s.*,
           lag(stack) OVER (PARTITION BY uid ORDER BY hand_number, created_at) AS prev_stack
    FROM seats s
  ),
  calc AS (
    SELECT
      uid,
      (created_at AT TIME ZONE 'UTC')::date AS stat_date,
      won,
      pot_size,
      CASE WHEN prev_stack IS NULL THEN 0
           ELSE least(stack - prev_stack, won) END AS profit,
      CASE WHEN prev_stack IS NULL THEN 0
           ELSE greatest((stack - prev_stack) - won, 0) END AS topup
    FROM d
  )
  INSERT INTO club_member_daily_stats
    (club_id, table_id, user_id, stat_date, hands_played, hands_won,
     total_won, profit, biggest_pot_won, biggest_pot, topup_total)
  SELECT
    v_club, p_table_id, uid, stat_date,
    count(*), count(*) FILTER (WHERE won > 0),
    sum(won), sum(profit), max(won), max(pot_size), sum(topup)
  FROM calc
  GROUP BY uid, stat_date
  ON CONFLICT (club_id, table_id, user_id, stat_date) DO UPDATE SET
    hands_played    = EXCLUDED.hands_played,
    hands_won       = EXCLUDED.hands_won,
    total_won       = EXCLUDED.total_won,
    profit          = EXCLUDED.profit,
    biggest_pot_won = EXCLUDED.biggest_pot_won,
    biggest_pot     = EXCLUDED.biggest_pot,
    topup_total     = EXCLUDED.topup_total,
    updated_at      = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  INSERT INTO club_member_table_state AS st (table_id, user_id, last_stack, last_hand_number)
  SELECT DISTINCT ON (p->>'userId')
         p_table_id, (p->>'userId')::uuid, (p->>'stack')::numeric, hh.hand_number
  FROM hand_history hh
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(hh.players, '[]'::jsonb)) p
  WHERE hh.table_id = p_table_id
    AND (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND (p->>'stack') IS NOT NULL
  ORDER BY p->>'userId', hh.hand_number DESC
  ON CONFLICT (table_id, user_id) DO UPDATE SET
    last_stack       = EXCLUDED.last_stack,
    last_hand_number = EXCLUDED.last_hand_number,
    updated_at       = now();

  RETURN v_rows;
END;
$fn$;
