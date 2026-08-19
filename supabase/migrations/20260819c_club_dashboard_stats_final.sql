-- ============================================================================
-- 20260819c_club_dashboard_stats_final.sql
-- Club Dashboard stats — final attribution model (Tier 2, additive/replace)
--
-- Consolidates four fixes applied to production on 2026-08-19 while the
-- attribution model was being validated against live data. Applied versions:
--   20260819202549  club_dashboard_rebuild_conflict_safe
--   20260819202732  club_dashboard_rebuild_log
--   20260819202919  club_dashboard_stats_session_adjacency
--   20260819203232  club_dashboard_stats_conservation_gate
-- This file is the resulting definition of each object, so re-running it
-- reproduces production exactly.
--
-- ── THE MODEL ──────────────────────────────────────────────────────────────
-- hand_history.players[].stack is written from postHandTasks in
-- ServerTableEngineSettlement.ts, i.e. it is the POST-hand stack. A player's
-- result for a hand is therefore the delta between their stack on that hand
-- and on the previous hand they played at that table.
--
-- Three things can corrupt that delta; each has a gate, applied where it is
-- actually valid:
--
--  1. SESSION BREAKS — if a hand ran at the table without the player, they
--     may have left and rebought; a 500-chip cash-out followed by a 100-chip
--     rebuy reads as a 400-chip loss they never took. Gate: strict adjacency
--     (no intervening hand at that table). On table 68c94447 this one error
--     alone moved the club residual to -14,411.68 when it must be 0.00.
--
--  2. BETWEEN-HAND TOP-UPS on an otherwise adjacent pair. Gate A (per player):
--     a player cannot finish a hand up more than they won, so delta <= won.
--     Precise (1 false positive in 8,189 hands) but only 60% recall.
--     Gate B (per hand): if every seated player is adjacent, the hand is a
--     closed system and the deltas MUST sum to -(rake + bbj). 100% recall,
--     but only evaluable on fully-covered hands. Both are applied.
--
--  3. Malformed rows — non-uuid userId or missing stack are skipped.
--
-- A player-hand failing a gate still counts in hands_played, but contributes
-- no profit, and any detected chip injection is recorded in topup_total.
-- hands_attributed records how many hands the profit figure actually rests
-- on, so the number always has an honest denominator.
--
-- ── VERIFIED ON PRODUCTION (table 68c94447, 13.7k hands / 48k player-hands) ─
--   fully_attributed_hands 7958, non_reconciling 0,
--   sum(deltas) -1111.27 == -(sum rake+bbj) -1111.27  (exact)
--   club-wide attribution coverage 83.0% of player-hands.
--
-- ── ROLLBACK ───────────────────────────────────────────────────────────────
--   See 20260819b_club_dashboard_stats_correctness.sql; additionally
--   DROP TABLE IF EXISTS public.club_stats_rebuild_log;
--   ALTER TABLE public.club_member_daily_stats DROP COLUMN IF EXISTS hands_attributed;
-- ============================================================================

ALTER TABLE public.club_member_daily_stats
  ADD COLUMN IF NOT EXISTS hands_attributed integer NOT NULL DEFAULT 0;

-- Rebuild bookkeeping. The driver previously decided "already rebuilt" by
-- checking whether the table had any club_member_daily_stats rows — but the
-- live trigger creates rows for an active table within seconds, so every
-- actively-dealing table was permanently skipped and kept only the handful of
-- rows written since the migration. Rebuild state gets its own log.
CREATE TABLE IF NOT EXISTS public.club_stats_rebuild_log (
  table_id     uuid PRIMARY KEY,
  rebuilt_at   timestamptz NOT NULL DEFAULT now(),
  rows_written integer
);

ALTER TABLE public.club_stats_rebuild_log ENABLE ROW LEVEL SECURITY;

-- ── Live path ───────────────────────────────────────────────────────────────

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
  -- Stats must never block the engine's hand insert.
  RAISE WARNING 'trg_hand_history_club_member_stats failed: %', SQLERRM;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS hand_history_club_member_stats ON public.hand_history;
CREATE TRIGGER hand_history_club_member_stats
  AFTER INSERT ON public.hand_history
  FOR EACH ROW EXECUTE FUNCTION public.trg_hand_history_club_member_stats();

-- ── Rebuild path ────────────────────────────────────────────────────────────

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
  -- The DELETE above and this INSERT are separate statements, so on an
  -- actively dealing table a hand can land between them and the trigger
  -- writes a row this INSERT then collides with. This INSERT's snapshot
  -- already includes that hand, so the rebuilt value is complete: it wins.
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
    WHERE t.club_id = p_club_id
      AND EXISTS (
        SELECT 1 FROM hand_history hh
        WHERE hh.table_id = t.id AND hh.created_at >= p_since
      )
      AND NOT EXISTS (
        SELECT 1 FROM club_stats_rebuild_log l
        WHERE l.table_id = t.id AND l.rebuilt_at >= p_since
      )
    LIMIT greatest(coalesce(p_limit, 25), 1)
  LOOP
    PERFORM ca_rebuild_club_member_stats_table(r.id);
    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_rebuild_club_member_stats_table(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_rebuild_club_member_stats_table(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'club_member_daily_stats'
      AND column_name = 'hands_attributed'
  ) THEN
    RAISE EXCEPTION 'hands_attributed column missing';
  END IF;
  IF to_regclass('public.club_stats_rebuild_log') IS NULL THEN
    RAISE EXCEPTION 'club_stats_rebuild_log missing';
  END IF;
END $$;
