-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819233212 "club_stats_resumable_chunked_rebuild"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 08162d644f21b7ea1e9d22d99938943d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Resumable per-table rebuild, so tables too large for one statement can
-- finally be backfilled. 7,281 tables remain across the two largest clubs and
-- the biggest holds 75,211 hands; the single-statement rebuild cannot finish
-- one of those inside any workable timeout, and because it is ONE statement it
-- rolls back entirely — such a table could never be done at all.
--
-- The earlier attempt (withdrawn in 20260819g) resumed by hand_number, which
-- is NOT a total order within a table: it is unique only above 1,000,000 and
-- legacy tables mix the old per-table 1..N numbering with the global one.
--
-- This walks (created_at, id) instead, which IS a total order and is also the
-- physical order hands were dealt. The cursor lives in club_stats_rebuild_log,
-- so a chunk can stop and resume without losing the delta chain:
--   * a player's previous stack comes from the in-chunk lag, falling back to
--     club_member_table_state carried from the previous chunk;
--   * adjacency compares the player's previous hand key against the hand
--     immediately preceding this one at the table — in-chunk lag, falling back
--     to the cursor the previous chunk left behind.
-- Rows ACCUMULATE, so the first chunk clears the table's prior rows.

ALTER TABLE public.club_stats_rebuild_log
  ADD COLUMN IF NOT EXISTS cursor_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS cursor_id         uuid,
  ADD COLUMN IF NOT EXISTS complete          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hands_done        bigint  NOT NULL DEFAULT 0;

ALTER TABLE public.club_member_table_state
  ADD COLUMN IF NOT EXISTS last_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_hand_id    uuid;

CREATE INDEX IF NOT EXISTS idx_hand_history_table_created_id
  ON public.hand_history (table_id, created_at, id);

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
  v_club        uuid;
  v_cur_ts      timestamptz;
  v_cur_id      uuid;
  v_started     boolean;
  v_count       integer := 0;
  v_last_ts     timestamptz;
  v_last_id     uuid;
BEGIN
  SELECT club_id INTO v_club FROM tables WHERE id = p_table_id;
  IF v_club IS NULL THEN
    hands_processed := 0; complete := true; RETURN NEXT; RETURN;
  END IF;

  SELECT l.cursor_created_at, l.cursor_id, (l.table_id IS NOT NULL)
    INTO v_cur_ts, v_cur_id, v_started
  FROM club_stats_rebuild_log l WHERE l.table_id = p_table_id;

  -- First chunk: wipe anything previously recorded for this table.
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
    LIMIT greatest(coalesce(p_max_hands, 3000), 1)
  ),
  seq AS (
    SELECT p.*,
           row_number() OVER (ORDER BY p.created_at, p.id) AS rn,
           lag(p.id)         OVER (ORDER BY p.created_at, p.id) AS prev_hand_at_table,
           lag(p.created_at) OVER (ORDER BY p.created_at, p.id) AS prev_ts_at_table
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
    UPDATE club_stats_rebuild_log SET complete = true, rebuilt_at = now()
     WHERE table_id = p_table_id;
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
           (r.prev_stack IS NOT NULL
            AND r.prev_hand IS NOT NULL
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

  -- Carry each player's last observation into the next chunk.
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
  VALUES (p_table_id, now(), v_count, v_last_ts, v_last_id,
          v_count < greatest(coalesce(p_max_hands, 3000), 1), v_count)
  ON CONFLICT (table_id) DO UPDATE SET
    rebuilt_at        = now(),
    rows_written      = EXCLUDED.rows_written,
    cursor_created_at = EXCLUDED.cursor_created_at,
    cursor_id         = EXCLUDED.cursor_id,
    complete          = EXCLUDED.complete,
    hands_done        = club_stats_rebuild_log.hands_done + EXCLUDED.hands_done;

  hands_processed := v_count;
  complete := v_count < greatest(coalesce(p_max_hands, 3000), 1);
  RETURN NEXT;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_rebuild_table_chunk(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_rebuild_table_chunk(uuid, integer) TO service_role;
