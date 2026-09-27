-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819233514 "club_stats_chunk_reentrant"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c36942418b46aa3a6bca791754bbb1e3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ON COMMIT DROP only fires at COMMIT, so calling the walker repeatedly inside
-- one transaction (a DO-block drain loop, which is exactly how it is meant to
-- be used) failed with "relation _chunk already exists" on the second call.
-- Drop it explicitly on entry so the function is re-entrant.
DROP FUNCTION IF EXISTS public.ca_rebuild_table_chunk_prep();

CREATE OR REPLACE FUNCTION public.ca_rebuild_table_chunk(
  p_table_id  uuid,
  p_max_hands integer DEFAULT 3000
)
RETURNS TABLE (hands_processed integer, complete boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '170s'
AS $fn$
DECLARE
  v_club    uuid;
  v_cur_ts  timestamptz;
  v_cur_id  uuid;
  v_count   integer := 0;
  v_last_ts timestamptz;
  v_last_id uuid;
  v_limit   integer := greatest(coalesce(p_max_hands, 3000), 1);
BEGIN
  SELECT club_id INTO v_club FROM tables WHERE id = p_table_id;
  IF v_club IS NULL THEN
    hands_processed := 0; complete := true; RETURN NEXT; RETURN;
  END IF;

  EXECUTE 'DROP TABLE IF EXISTS _chunk';

  SELECT l.cursor_created_at, l.cursor_id INTO v_cur_ts, v_cur_id
  FROM club_stats_rebuild_log l WHERE l.table_id = p_table_id;

  IF v_cur_ts IS NULL THEN
    DELETE FROM club_member_daily_stats WHERE table_id = p_table_id;
    DELETE FROM club_member_table_state WHERE table_id = p_table_id;
  END IF;

  CREATE TEMP TABLE _chunk ON COMMIT DROP AS
  WITH picked AS (
    SELECT hh.id, hh.created_at, hh.hand_number,
           coalesce(hh.pot_size, 0) AS pot_size,
           coalesce(hh.rake_amount, 0) + coalesce(hh.bbj_amount, 0) AS rake_bbj,
           hh.players, hh.winners
    FROM hand_history hh
    WHERE hh.table_id = p_table_id
      AND (v_cur_ts IS NULL OR (hh.created_at, hh.id) > (v_cur_ts, v_cur_id))
    ORDER BY hh.created_at, hh.id
    LIMIT v_limit
  ),
  seq AS (
    SELECT p.*,
           row_number() OVER (ORDER BY p.created_at, p.id) AS rn,
           lag(p.id) OVER (ORDER BY p.created_at, p.id) AS prev_hand_at_table
    FROM picked p
  )
  SELECT
    s.rn, s.id AS hand_id, s.created_at, s.hand_number, s.pot_size, s.rake_bbj,
    coalesce(s.prev_hand_at_table, v_cur_id) AS prev_hand_at_table,
    (pl->>'userId')::uuid   AS uid,
    (pl->>'stack')::numeric AS stack,
    coalesce((SELECT sum((w->>'amount')::numeric)
              FROM jsonb_array_elements(coalesce(s.winners, '[]'::jsonb)) w
              WHERE w->>'userId' = pl->>'userId'), 0) AS won
  FROM seq s
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.players, '[]'::jsonb)) pl
  WHERE (pl->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND (pl->>'stack') IS NOT NULL;

  SELECT count(DISTINCT hand_id) INTO v_count FROM _chunk;

  IF v_count = 0 THEN
    INSERT INTO club_stats_rebuild_log (table_id, rebuilt_at, complete, rows_written)
    VALUES (p_table_id, now(), true, 0)
    ON CONFLICT (table_id) DO UPDATE SET complete = true, rebuilt_at = now();
    hands_processed := 0; complete := true; RETURN NEXT; RETURN;
  END IF;

  SELECT c.created_at, c.hand_id INTO v_last_ts, v_last_id
  FROM _chunk c ORDER BY c.created_at DESC, c.hand_id DESC LIMIT 1;

  WITH d AS (
    SELECT c.*,
           lag(c.stack)   OVER (PARTITION BY c.uid ORDER BY c.rn) AS prev_stack_in,
           lag(c.hand_id) OVER (PARTITION BY c.uid ORDER BY c.rn) AS prev_hand_in,
           st.last_stack   AS carried_stack,
           st.last_hand_id AS carried_hand
    FROM _chunk c
    LEFT JOIN club_member_table_state st
           ON st.table_id = p_table_id AND st.user_id = c.uid
  ),
  resolved AS (
    SELECT d.*,
           coalesce(d.prev_stack_in, d.carried_stack) AS prev_stack,
           coalesce(d.prev_hand_in,  d.carried_hand)  AS prev_hand
    FROM d
  ),
  marked AS (
    SELECT r.*,
           (r.prev_stack IS NOT NULL AND r.prev_hand IS NOT NULL
            AND r.prev_hand = r.prev_hand_at_table) AS adjacent,
           CASE WHEN r.prev_stack IS NOT NULL THEN r.stack - r.prev_stack ELSE 0 END AS delta
    FROM resolved r
  ),
  per_hand AS (
    SELECT hand_id,
           count(*) AS seated,
           count(*) FILTER (WHERE prev_stack IS NOT NULL) AS with_prior,
           coalesce(sum(delta) FILTER (WHERE prev_stack IS NOT NULL), 0) AS dsum,
           max(rake_bbj) AS rake_bbj
    FROM marked GROUP BY hand_id
  ),
  calc AS (
    SELECT m.uid, (m.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           m.won, m.pot_size, m.delta,
           CASE
             WHEN ph.seated = ph.with_prior THEN abs(ph.dsum + ph.rake_bbj) < 0.005
             ELSE m.adjacent AND m.delta <= m.won + 0.001
           END AS attributable
    FROM marked m JOIN per_hand ph ON ph.hand_id = m.hand_id
  )
  INSERT INTO club_member_daily_stats AS s
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
    hands_played     = s.hands_played + EXCLUDED.hands_played,
    hands_attributed = s.hands_attributed + EXCLUDED.hands_attributed,
    hands_won        = s.hands_won + EXCLUDED.hands_won,
    total_won        = s.total_won + EXCLUDED.total_won,
    profit           = s.profit + EXCLUDED.profit,
    biggest_pot_won  = greatest(s.biggest_pot_won, EXCLUDED.biggest_pot_won),
    biggest_pot      = greatest(s.biggest_pot, EXCLUDED.biggest_pot),
    topup_total      = s.topup_total + EXCLUDED.topup_total,
    updated_at       = now();

  INSERT INTO club_member_table_state AS st
    (table_id, user_id, last_stack, last_hand_number, last_created_at, last_hand_id)
  SELECT DISTINCT ON (uid)
         p_table_id, uid, stack, hand_number, created_at, hand_id
  FROM _chunk
  ORDER BY uid, created_at DESC, hand_id DESC
  ON CONFLICT (table_id, user_id) DO UPDATE SET
    last_stack       = EXCLUDED.last_stack,
    last_hand_number = EXCLUDED.last_hand_number,
    last_created_at  = EXCLUDED.last_created_at,
    last_hand_id     = EXCLUDED.last_hand_id,
    updated_at       = now();

  INSERT INTO club_stats_rebuild_log
    (table_id, rebuilt_at, rows_written, cursor_created_at, cursor_id, complete, hands_done)
  VALUES (p_table_id, now(), v_count, v_last_ts, v_last_id, v_count < v_limit, v_count)
  ON CONFLICT (table_id) DO UPDATE SET
    rebuilt_at        = now(),
    rows_written      = EXCLUDED.rows_written,
    cursor_created_at = EXCLUDED.cursor_created_at,
    cursor_id         = EXCLUDED.cursor_id,
    complete          = EXCLUDED.complete,
    hands_done        = club_stats_rebuild_log.hands_done + EXCLUDED.hands_done;

  hands_processed := v_count;
  complete := v_count < v_limit;
  RETURN NEXT;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_rebuild_table_chunk(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_rebuild_table_chunk(uuid, integer) TO service_role;
