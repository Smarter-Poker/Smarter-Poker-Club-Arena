-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819203232 "club_dashboard_stats_conservation_gate"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8ca1c8d31cafcba3ef19f8bd65a0cc74 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Final correctness pass on the profit attribution.
--
-- Measured on table 68c94447 (13.7k hands, 48k player-hands):
--   * strict adjacency alone still let rebuys through: 234 of 8,189
--     fully-covered hands (2.9%) violate chip conservation.
--   * the per-player test (delta > won) is precise but incomplete — it flags
--     141 of those 234 (60% recall, 1 false positive in 8,189). A player who
--     tops up AND then loses enough keeps delta <= won and slips past it.
--   * per-hand conservation catches 100% of them, but can only be evaluated
--     when every seated player is adjacent (60% of hands).
--
-- So both gates are applied, each where it is valid:
--   hand gate    — if the hand is fully covered it MUST conserve
--                  (sum of deltas = -(rake + bbj)); otherwise not testable.
--   player gate  — a player can never finish a hand up more than they won,
--                  so delta <= won; applies to every attributed player-hand.
-- A player-hand failing either gate contributes hands_played but no profit,
-- and the injected chips are recorded in topup_total. Nothing is fabricated.
--
-- hands_attributed is added so profit always has an honest denominator and
-- the UI can show what share of hands the figure is based on.

ALTER TABLE public.club_member_daily_stats
  ADD COLUMN IF NOT EXISTS hands_attributed integer NOT NULL DEFAULT 0;

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
      (st.last_stack IS NOT NULL
       AND st.last_hand_number IS NOT NULL
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
  agg AS (
    SELECT count(*) AS seated,
           count(*) FILTER (WHERE adjacent) AS covered,
           coalesce(sum(stack - last_stack) FILTER (WHERE adjacent), 0) AS dsum
    FROM base
  ),
  calc AS (
    SELECT
      b.uid, b.won,
      (b.adjacent
       AND (b.stack - b.last_stack) <= b.won + 0.001
       AND (a.seated <> a.covered
            OR abs(a.dsum + coalesce(NEW.rake_amount, 0) + coalesce(NEW.bbj_amount, 0)) < 0.005)
      ) AS attributable,
      CASE WHEN b.adjacent THEN b.stack - b.last_stack ELSE 0 END AS delta
    FROM base b CROSS JOIN agg a
  )
  INSERT INTO club_member_daily_stats AS s
    (club_id, table_id, user_id, stat_date, hands_played, hands_attributed, hands_won,
     total_won, profit, biggest_pot_won, biggest_pot, topup_total)
  SELECT
    v_club, NEW.table_id, calc.uid, (NEW.created_at AT TIME ZONE 'UTC')::date,
    1,
    CASE WHEN calc.attributable THEN 1 ELSE 0 END,
    CASE WHEN calc.won > 0 THEN 1 ELSE 0 END,
    calc.won,
    CASE WHEN calc.attributable THEN calc.delta ELSE 0 END,
    calc.won,
    coalesce(NEW.pot_size, 0),
    CASE WHEN NOT calc.attributable AND calc.delta > calc.won
         THEN calc.delta - calc.won ELSE 0 END
  FROM calc
  ON CONFLICT (club_id, table_id, user_id, stat_date) DO UPDATE SET
    hands_played     = s.hands_played + 1,
    hands_attributed = s.hands_attributed + EXCLUDED.hands_attributed,
    hands_won        = s.hands_won + EXCLUDED.hands_won,
    total_won        = s.total_won + EXCLUDED.total_won,
    profit           = s.profit + EXCLUDED.profit,
    biggest_pot_won  = greatest(s.biggest_pot_won, EXCLUDED.biggest_pot_won),
    biggest_pot      = greatest(s.biggest_pot, EXCLUDED.biggest_pot),
    topup_total      = s.topup_total + EXCLUDED.topup_total,
    updated_at       = now();

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
