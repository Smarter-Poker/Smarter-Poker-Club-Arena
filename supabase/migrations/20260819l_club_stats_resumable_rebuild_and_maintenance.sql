-- ============================================================================
-- 20260819l_club_stats_resumable_rebuild_and_maintenance.sql
-- Club stats — resumable rebuild, drain driver, maintenance probes (Tier 2)
--
-- Applied to production as:
--   club_stats_resumable_chunked_rebuild
--   club_stats_chunk_reentrant
--   club_stats_drain_driver
--   club_stats_maintenance_probes
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- club_member_daily_stats is exact for NEW hands (the hand_history trigger
-- owns them), but history was not: 7,281 tables across the two largest clubs
-- had never been rebuilt and the biggest holds 75,211 hands. The
-- single-statement rebuild cannot process one of those inside any workable
-- timeout, and because it IS one statement it rolls back entirely — such a
-- table could never be backfilled at all, no matter how often it was retried.
--
-- An earlier chunked attempt (withdrawn in 20260819g) resumed by hand_number,
-- which is NOT a total order within a table: unique only above 1,000,000, and
-- legacy tables mix the old per-table 1..N numbering with the global one.
--
-- This walks (created_at, id) — a true total order, and the physical order the
-- hands were dealt. The cursor lives in club_stats_rebuild_log so a chunk can
-- stop and resume without breaking the delta chain:
--   * previous stack  = in-chunk lag, else club_member_table_state carried
--                       from the previous chunk;
--   * adjacency       = the player's previous hand id equals the hand that
--                       immediately precedes this one at the table (in-chunk
--                       lag, else the cursor the previous chunk left behind).
-- Rows ACCUMULATE, so the first chunk clears the table's prior rows.
--
-- ── VALIDATED ──────────────────────────────────────────────────────────────
-- Driving one table in 90-hand chunks (multiple resumes) produced results
-- BYTE-IDENTICAL to the verified single-statement rebuild: 0 rows differing in
-- either direction, identical profit (2250.0000) and hands_attributed (1301).
--
-- Result after draining: attribution coverage went Club JAQK 55.1% -> 91.8%,
-- SHARK CLUB 39.9% -> 92.8%, Midway Union 89.1% -> 94.8%.
--
-- ── ROLLBACK ───────────────────────────────────────────────────────────────
--   DROP FUNCTION IF EXISTS public.ca_drain_club_rebuild(uuid, integer, integer, timestamptz);
--   DROP FUNCTION IF EXISTS public.ca_rebuild_table_chunk(uuid, integer);
--   DROP FUNCTION IF EXISTS public.ca_clubs_with_rebuild_backlog(timestamptz, integer);
--   DROP FUNCTION IF EXISTS public.ca_clubs_missing_hand_daily(date);
--   ALTER TABLE public.club_stats_rebuild_log
--     DROP COLUMN IF EXISTS cursor_created_at, DROP COLUMN IF EXISTS cursor_id,
--     DROP COLUMN IF EXISTS complete,          DROP COLUMN IF EXISTS hands_done;
--   ALTER TABLE public.club_member_table_state
--     DROP COLUMN IF EXISTS last_created_at, DROP COLUMN IF EXISTS last_hand_id;
-- ============================================================================

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

  -- ON COMMIT DROP only fires at COMMIT, so a drain loop inside one
  -- transaction hit "relation _chunk already exists" on its second call.
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

-- Time-boxed drain used by the scheduled maintenance job.
CREATE OR REPLACE FUNCTION public.ca_drain_club_rebuild(
  p_club_id     uuid,
  p_max_seconds integer DEFAULT 120,
  p_chunk       integer DEFAULT 3000,
  p_since       timestamptz DEFAULT now() - interval '90 days'
)
RETURNS TABLE (tables_touched integer, tables_completed integer, hands_processed bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '600s'
AS $fn$
DECLARE
  v_deadline timestamptz := clock_timestamp() + make_interval(secs => greatest(coalesce(p_max_seconds, 120), 5));
  r record; c record;
  v_touched integer := 0; v_done integer := 0; v_hands bigint := 0;
BEGIN
  FOR r IN
    SELECT t.id
    FROM tables t
    JOIN LATERAL (
      SELECT max(hh.created_at) AS last_hand
      FROM hand_history hh
      WHERE hh.table_id = t.id AND hh.created_at >= p_since
    ) lh ON lh.last_hand IS NOT NULL
    LEFT JOIN club_stats_rebuild_log l ON l.table_id = t.id
    WHERE t.club_id = p_club_id
      AND coalesce(l.complete, false) = false
    ORDER BY lh.last_hand DESC
  LOOP
    EXIT WHEN clock_timestamp() >= v_deadline;
    v_touched := v_touched + 1;
    LOOP
      EXIT WHEN clock_timestamp() >= v_deadline;
      BEGIN
        SELECT * INTO c FROM ca_rebuild_table_chunk(r.id, p_chunk);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'chunk failed for table %: %', r.id, SQLERRM;
        EXIT;
      END;
      v_hands := v_hands + coalesce(c.hands_processed, 0);
      IF c.complete THEN v_done := v_done + 1; EXIT; END IF;
    END LOOP;
  END LOOP;

  tables_touched := v_touched; tables_completed := v_done; hands_processed := v_hands;
  RETURN NEXT;
END;
$fn$;

-- Probes so the scheduled job never hardcodes a club list and costs nothing
-- once the backlog is drained.
CREATE OR REPLACE FUNCTION public.ca_clubs_with_rebuild_backlog(
  p_since timestamptz DEFAULT now() - interval '90 days',
  p_limit integer     DEFAULT 10
)
RETURNS TABLE (club_id uuid, tables_pending bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT t.club_id, count(*)::bigint
  FROM tables t
  LEFT JOIN club_stats_rebuild_log l ON l.table_id = t.id
  WHERE t.club_id IS NOT NULL
    AND coalesce(l.complete, false) = false
    AND EXISTS (SELECT 1 FROM hand_history hh
                WHERE hh.table_id = t.id AND hh.created_at >= p_since)
  GROUP BY t.club_id
  ORDER BY count(*) DESC
  LIMIT greatest(coalesce(p_limit, 10), 1);
$fn$;

CREATE OR REPLACE FUNCTION public.ca_clubs_missing_hand_daily(p_date date)
RETURNS TABLE (club_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT DISTINCT t.club_id
  FROM tables t
  WHERE t.club_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM club_hand_daily d
                    WHERE d.club_id = t.club_id AND d.stat_date = p_date)
    AND EXISTS (SELECT 1 FROM hand_history hh
                WHERE hh.table_id = t.id
                  AND hh.created_at >= p_date::timestamp AT TIME ZONE 'UTC'
                  AND hh.created_at <  (p_date + 1)::timestamp AT TIME ZONE 'UTC');
$fn$;

REVOKE ALL ON FUNCTION public.ca_rebuild_table_chunk(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ca_drain_club_rebuild(uuid, integer, integer, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ca_clubs_with_rebuild_backlog(timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ca_clubs_missing_hand_daily(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_rebuild_table_chunk(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ca_drain_club_rebuild(uuid, integer, integer, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.ca_clubs_with_rebuild_backlog(timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ca_clubs_missing_hand_daily(date) TO service_role;
