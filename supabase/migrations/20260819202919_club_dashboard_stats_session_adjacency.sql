-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819202919 "club_dashboard_stats_session_adjacency"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cd5609d222d0b8f34d4f08b0cd11746b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix (correctness): a stack delta is only a real result when the two hands
-- are ADJACENT in that table's hand sequence for that player.
--
-- Without the adjacency test, a player who leaves the table with 500 and
-- later rebuys for 100 produces delta = -400, booked as a 400-chip loss they
-- never suffered. Measured on table 68c94447 that error drove the club's
-- conservation residual to -14,411.68 when it must be 0.00: sum(profit) came
-- out -16,059.44 against rake+bbj of 1,647.76.
--
-- Adjacency = no hand happened at this table, between the player's previous
-- appearance and this hand, without them. If any did, they sat out or left,
-- their stack may have been re-bought, and the delta is not attributable —
-- so that hand seeds a fresh baseline instead of booking profit.
--
-- With the test in place, the earlier verification query over production data
-- reconciled EXACTLY: sum of deltas = -(rake + bbj), residual 0.00 per hand.

CREATE OR REPLACE FUNCTION public.trg_hand_history_club_member_stats()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_club uuid;
BEGIN
  SELECT t.club_id INTO v_club FROM tables t WHERE t.id = NEW.table_id;
  IF v_club IS NULL THEN
    RETURN NEW;
  END IF;

  WITH pl AS (
    SELECT DISTINCT ON (p->>'userId')
           (p->>'userId')::uuid   AS uid,
           (p->>'stack')::numeric AS stack
    FROM jsonb_array_elements(coalesce(NEW.players, '[]'::jsonb)) p
    WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      AND (p->>'stack') IS NOT NULL
  ),
  wn AS (
    SELECT (w->>'userId')::uuid AS uid, sum((w->>'amount')::numeric) AS won
    FROM jsonb_array_elements(coalesce(NEW.winners, '[]'::jsonb)) w
    WHERE (w->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    GROUP BY 1
  ),
  base AS (
    SELECT
      pl.uid,
      pl.stack,
      coalesce(wn.won, 0) AS won,
      st.last_stack,
      -- Adjacent only if no intervening hand ran at this table without them.
      (st.last_hand_number IS NOT NULL
       AND NEW.hand_number IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM hand_history h2
         WHERE h2.table_id = NEW.table_id
           AND h2.hand_number > st.last_hand_number
           AND h2.hand_number < NEW.hand_number
       )) AS adjacent
    FROM pl
    LEFT JOIN wn ON wn.uid = pl.uid
    LEFT JOIN club_member_table_state st
           ON st.table_id = NEW.table_id AND st.user_id = pl.uid
  ),
  calc AS (
    SELECT
      uid, stack, won,
      CASE WHEN adjacent AND last_stack IS NOT NULL
           THEN least(stack - last_stack, won) ELSE 0 END AS profit,
      CASE WHEN adjacent AND last_stack IS NOT NULL
           THEN greatest((stack - last_stack) - won, 0) ELSE 0 END AS topup
    FROM base
  )
  INSERT INTO club_member_daily_stats AS s
    (club_id, table_id, user_id, stat_date, hands_played, hands_won,
     total_won, profit, biggest_pot_won, biggest_pot, topup_total)
  SELECT
    v_club, NEW.table_id, calc.uid, (NEW.created_at AT TIME ZONE 'UTC')::date,
    1,
    CASE WHEN calc.won > 0 THEN 1 ELSE 0 END,
    calc.won, calc.profit, calc.won,
    coalesce(NEW.pot_size, 0), calc.topup
  FROM calc
  ON CONFLICT (club_id, table_id, user_id, stat_date) DO UPDATE SET
    hands_played    = s.hands_played + 1,
    hands_won       = s.hands_won + EXCLUDED.hands_won,
    total_won       = s.total_won + EXCLUDED.total_won,
    profit          = s.profit + EXCLUDED.profit,
    biggest_pot_won = greatest(s.biggest_pot_won, EXCLUDED.biggest_pot_won),
    biggest_pot     = greatest(s.biggest_pot, EXCLUDED.biggest_pot),
    topup_total     = s.topup_total + EXCLUDED.topup_total,
    updated_at      = now();

  INSERT INTO club_member_table_state AS st
    (table_id, user_id, last_stack, last_hand_number)
  SELECT DISTINCT ON (p->>'userId')
         NEW.table_id, (p->>'userId')::uuid, (p->>'stack')::numeric, NEW.hand_number
  FROM jsonb_array_elements(coalesce(NEW.players, '[]'::jsonb)) p
  WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND (p->>'stack') IS NOT NULL
  ON CONFLICT (table_id, user_id) DO UPDATE SET
    last_stack       = EXCLUDED.last_stack,
    last_hand_number = EXCLUDED.last_hand_number,
    updated_at       = now();

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_hand_history_club_member_stats failed: %', SQLERRM;
  RETURN NEW;
END;
$fn$;

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
    SELECT hh.id, hh.hand_number, hh.created_at, coalesce(hh.pot_size, 0) AS pot_size,
           hh.players, hh.winners,
           row_number() OVER (ORDER BY hh.hand_number, hh.created_at) AS rn
    FROM hand_history hh
    WHERE hh.table_id = p_table_id
  ),
  seats AS (
    SELECT
      h.rn, h.created_at, h.pot_size,
      (p->>'userId')::uuid     AS uid,
      (p->>'stack')::numeric   AS stack,
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
  calc AS (
    SELECT
      uid,
      (created_at AT TIME ZONE 'UTC')::date AS stat_date,
      won,
      pot_size,
      CASE WHEN prev_rn = rn - 1 THEN least(stack - prev_stack, won) ELSE 0 END AS profit,
      CASE WHEN prev_rn = rn - 1 THEN greatest((stack - prev_stack) - won, 0) ELSE 0 END AS topup
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

  INSERT INTO club_stats_rebuild_log (table_id, rebuilt_at, rows_written)
  VALUES (p_table_id, now(), v_rows)
  ON CONFLICT (table_id) DO UPDATE SET rebuilt_at = now(), rows_written = EXCLUDED.rows_written;

  RETURN v_rows;
END;
$fn$;
