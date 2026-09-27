-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819211839 "club_dashboard_rebuild_chunked"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2fd4e5a905bd11231bb52fcbb55786af of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Some tables on the two largest clubs hold 65k-75k hands. Rebuilding one of
-- those in a single statement exceeds any workable timeout, and because it is
-- one statement the whole thing rolls back — the table could never be
-- backfilled at all, no matter how many times it was retried.
--
-- This adds a RESUMABLE chunked rebuild. Chunks are contiguous ranges of
-- hand_number, so adjacency (the property the whole profit model rests on)
-- survives the boundary: for a player's first appearance inside a chunk, the
-- previous hand at that table is either the previous row in the chunk or,
-- for the very first row, p_after_hand — exactly what the caller just
-- finished. Baseline state carries in club_member_table_state, the same
-- structure the live trigger uses, so chunked and live paths agree.
--
-- Rows ACCUMULATE, so the caller must clear the table's rows once before
-- chunk 1 (p_after_hand = 0 does this automatically).
CREATE OR REPLACE FUNCTION public.ca_rebuild_club_member_stats_chunk(
  p_table_id   uuid,
  p_after_hand bigint  DEFAULT 0,
  p_max_hands  integer DEFAULT 4000
)
RETURNS TABLE (last_hand bigint, hands_processed integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '170s'
AS $fn$
DECLARE
  v_club  uuid;
  v_last  bigint;
  v_count integer;
BEGIN
  SELECT club_id INTO v_club FROM tables WHERE id = p_table_id;
  IF v_club IS NULL THEN
    last_hand := p_after_hand; hands_processed := 0; RETURN NEXT; RETURN;
  END IF;

  -- First chunk: clear prior rows and any stale baseline for this table.
  IF coalesce(p_after_hand, 0) = 0 THEN
    DELETE FROM club_member_daily_stats WHERE table_id = p_table_id;
    DELETE FROM club_member_table_state WHERE table_id = p_table_id;
  END IF;

  CREATE TEMP TABLE _chunk ON COMMIT DROP AS
  WITH hseq AS (
    SELECT hh.hand_number, hh.created_at, coalesce(hh.pot_size, 0) AS pot_size,
           coalesce(hh.rake_amount, 0) + coalesce(hh.bbj_amount, 0) AS rake_bbj,
           hh.players, hh.winners,
           row_number() OVER (ORDER BY hh.hand_number) AS rn,
           lag(hh.hand_number) OVER (ORDER BY hh.hand_number) AS prev_hand_at_table
    FROM hand_history hh
    WHERE hh.table_id = p_table_id
      AND hh.hand_number > coalesce(p_after_hand, 0)
    ORDER BY hh.hand_number
    LIMIT greatest(coalesce(p_max_hands, 4000), 1)
  )
  SELECT
    h.rn, h.hand_number, h.created_at, h.pot_size, h.rake_bbj,
    coalesce(h.prev_hand_at_table, coalesce(p_after_hand, 0)) AS prev_hand_at_table,
    (p->>'userId')::uuid   AS uid,
    (p->>'stack')::numeric AS stack,
    coalesce((SELECT sum((w->>'amount')::numeric)
              FROM jsonb_array_elements(coalesce(h.winners, '[]'::jsonb)) w
              WHERE w->>'userId' = p->>'userId'), 0) AS won
  FROM hseq h
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(h.players, '[]'::jsonb)) p
  WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND (p->>'stack') IS NOT NULL;

  SELECT max(hand_number), count(DISTINCT hand_number) INTO v_last, v_count FROM _chunk;
  IF v_last IS NULL THEN
    last_hand := p_after_hand; hands_processed := 0; RETURN NEXT; RETURN;
  END IF;

  WITH d AS (
    SELECT c.*,
           lag(c.stack)       OVER (PARTITION BY c.uid ORDER BY c.rn) AS prev_stack_in,
           lag(c.hand_number) OVER (PARTITION BY c.uid ORDER BY c.rn) AS prev_hand_in,
           st.last_stack       AS carried_stack,
           st.last_hand_number AS carried_hand
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
           (r.prev_stack IS NOT NULL AND r.prev_hand = r.prev_hand_at_table) AS adjacent
    FROM resolved r
  ),
  withdelta AS (
    SELECT m.*, CASE WHEN m.adjacent THEN m.stack - m.prev_stack ELSE 0 END AS delta
    FROM marked m
  ),
  per_hand AS (
    SELECT hand_number,
           count(*) AS seated,
           count(*) FILTER (WHERE adjacent) AS covered,
           coalesce(sum(delta) FILTER (WHERE adjacent), 0) AS dsum,
           max(rake_bbj) AS rake_bbj
    FROM withdelta GROUP BY hand_number
  ),
  calc AS (
    SELECT w.uid, (w.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           w.won, w.pot_size, w.delta,
           (w.adjacent
            AND w.delta <= w.won + 0.001
            AND (ph.seated <> ph.covered OR abs(ph.dsum + ph.rake_bbj) < 0.005)
           ) AS attributable
    FROM withdelta w JOIN per_hand ph ON ph.hand_number = w.hand_number
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

  -- Carry the baseline: every player's last stack seen in this chunk.
  INSERT INTO club_member_table_state AS st (table_id, user_id, last_stack, last_hand_number)
  SELECT DISTINCT ON (uid) p_table_id, uid, stack, hand_number
  FROM _chunk
  ORDER BY uid, hand_number DESC
  ON CONFLICT (table_id, user_id) DO UPDATE SET
    last_stack       = EXCLUDED.last_stack,
    last_hand_number = EXCLUDED.last_hand_number,
    updated_at       = now();

  INSERT INTO club_stats_rebuild_log (table_id, rebuilt_at, rows_written)
  VALUES (p_table_id, now(), v_count)
  ON CONFLICT (table_id) DO UPDATE SET rebuilt_at = now(), rows_written = EXCLUDED.rows_written;

  last_hand := v_last;
  hands_processed := v_count;
  RETURN NEXT;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_rebuild_club_member_stats_chunk(uuid, bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_rebuild_club_member_stats_chunk(uuid, bigint, integer) TO service_role;
