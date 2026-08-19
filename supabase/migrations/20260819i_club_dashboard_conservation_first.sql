-- ============================================================================
-- 20260819i_club_dashboard_conservation_first.sql
-- Club Dashboard — conservation-first attribution (Tier 2, correctness+coverage)
--
-- Applied to production as: club_dashboard_conservation_first_attribution
--
-- ── WHAT WAS TOO STRICT ────────────────────────────────────────────────────
-- Attribution required STRICT ADJACENCY: a player's stack delta only counted
-- if no hand had run at that table without them. That was only ever a PROXY
-- for the real question — "were any chips injected between these two
-- observations?"
--
-- The real guarantee is per-hand chip conservation. If every seat in a hand
-- has a prior stack and the deltas sum to -(rake + bbj), then nothing entered
-- or left the table during ANY of those gaps, and every delta in that hand is
-- exact — no matter how many hands a player sat out in between.
--
-- Adjacency was therefore discarding provably-good data on precisely the
-- tables where players rotate seats constantly, which is what the horse clubs
-- do all day.
--
-- ── MEASURED (table 68c94447, 13,898 hands) ────────────────────────────────
--   fully adjacent hands ................. 8,361
--   hands where every seat has a prior .... 13,634
--   ...of those, conserving exactly ....... 10,887   (79.9%)
--
-- ── THE RULE ───────────────────────────────────────────────────────────────
--   If every seated player has a prior stack:
--       conservation holds -> attribute ALL their deltas (gaps allowed)
--       conservation fails -> attribute NONE (chips were injected)
--   Otherwise (a player is brand new, so the hand cannot be balanced):
--       fall back to per-player adjacency AND delta <= won.
--
-- The delta <= won sanity check is applied ONLY on the unvalidated fallback
-- path. Where conservation holds the deltas are proven, and applying
-- delta <= won there would wrongly discard split/side-pot rows whose winners[]
-- entry under-reports (measured: 1 such row in 8,189).
--
-- ── VERIFIED AFTER THE CHANGE (same table) ─────────────────────────────────
--   fully attributed hands ... 8,052 -> 10,894  (+35%)
--   non_reconciling .......... 0  (unchanged — still exact)
--   sum(deltas) -1415.71 == -(sum rake+bbj) -1415.71
--   stored hands_attributed 41,384 == independent recompute 41,384
--   table coverage ........... 69% -> 83.7%
--   Midway Union club coverage 89.1% -> 93.4%
--
-- ROLLBACK: re-apply the trigger and rebuild bodies from
--           20260819c_club_dashboard_stats_final.sql (adjacency-only gate),
--           then rebuild affected tables.
-- ============================================================================

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
      pl.uid, pl.stack, coalesce(wn.won, 0) AS won, st.last_stack,
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
           count(*) FILTER (WHERE last_stack IS NOT NULL) AS with_prior,
           coalesce(sum(stack - last_stack) FILTER (WHERE last_stack IS NOT NULL), 0) AS dsum
    FROM base
  ),
  calc AS (
    SELECT
      b.uid, b.won,
      CASE WHEN b.last_stack IS NOT NULL THEN b.stack - b.last_stack ELSE 0 END AS delta,
      CASE
        WHEN a.seated = a.with_prior
          THEN abs(a.dsum + coalesce(NEW.rake_amount, 0) + coalesce(NEW.bbj_amount, 0)) < 0.005
        ELSE b.adjacent AND (b.stack - b.last_stack) <= b.won + 0.001
      END AS attributable
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
  -- Stats must never block the engine's hand insert.
  RAISE WARNING 'trg_hand_history_club_member_stats failed: %', SQLERRM;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.ca_rebuild_club_member_stats_table(p_table_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '170s'
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
           -- Row ordinal, NOT hand_number: hand_number is unique only above
           -- 1,000,000 and legacy tables repeat it (see 20260819g).
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
    SELECT d.*,
           (prev_rn = rn - 1) AS adjacent,
           CASE WHEN prev_stack IS NOT NULL THEN stack - prev_stack ELSE 0 END AS delta
    FROM d
  ),
  per_hand AS (
    SELECT rn,
           count(*) AS seated,
           count(*) FILTER (WHERE prev_stack IS NOT NULL) AS with_prior,
           coalesce(sum(delta) FILTER (WHERE prev_stack IS NOT NULL), 0) AS dsum,
           max(rake_bbj) AS rake_bbj
    FROM marked GROUP BY rn
  ),
  calc AS (
    SELECT
      m.uid,
      (m.created_at AT TIME ZONE 'UTC')::date AS stat_date,
      m.won, m.pot_size, m.delta,
      CASE
        WHEN ph.seated = ph.with_prior THEN abs(ph.dsum + ph.rake_bbj) < 0.005
        ELSE m.adjacent AND m.delta <= m.won + 0.001
      END AS attributable
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
