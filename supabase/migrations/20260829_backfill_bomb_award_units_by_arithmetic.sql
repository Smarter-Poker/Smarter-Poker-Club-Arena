-- ═══════════════════════════════════════════════════════════════════════════
-- BACKFILL THE AWARD LEDGER WHERE THE ANSWER IS ARITHMETIC, NOT A GUESS
-- (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 301 bomb hands carry no award units. Two of them are transient write losses
-- (see fn_bomb_pot_ledger_gaps); the other 299 pre-date PR #1685, when the
-- write was still gated to a subset of bomb hands and the ledger was partial
-- BY DESIGN.
--
-- The last pass refused to backfill these, and the reasoning was right as far
-- as it went: `hand_history.winners` is MERGED PER USER, so for a hand where
-- two people won different boards it does not record WHICH BOARD each of them
-- took — and that is precisely the fact the award ledger exists to preserve.
-- Reconstructing it would mean re-evaluating hole cards against both boards
-- and storing the result as though it had been recorded at the time. This repo
-- has been burned by exactly that shape before (CLAUDE.md §10.5: an invention
-- presented as a design decision is worse than a plain bug).
--
-- But that argument does not cover every hand. It covers hands with MORE THAN
-- ONE WINNER. For a hand with exactly one winner there is nothing to infer:
-- every unit belongs to that player, and the decomposition is the engine's own
-- arithmetic, reproduced exactly rather than approximated.
--
--   boards      = 1, plus board 2 and board 3 when each holds five cards
--                 (HandController.settlementBoards: a fold-around leaves the
--                 later boards short and the whole pot settles on board 1)
--   pot shares  = per pot layer, cents = round(amount * 100),
--                 base = cents / boards, remainder cents to the LOWEST board
--                 numbers first (the spec's LOWEST_BOARD_NUMBER policy)
--   rake        = each share scaled by totalWinnings / totalPot, then the
--                 penny difference put on the largest share so the units sum
--                 to the winner's credit EXACTLY — the same repair
--                 completeHandInner performs before it emits perPotAwards
--
-- Every number above comes from a column already stored on the hand. No card
-- is evaluated, because no card needs to be: the winner is recorded.
--
-- 135 of the 301 qualify. The other 166 stay missing and stay VISIBLE in
-- fn_bomb_pot_ledger_gaps, which is the honest state for them. An incomplete
-- ledger that says so beats a complete-looking one that is partly fiction.
--
-- Tier 2: inserts into a ledger table, idempotent on its own UNIQUE key, and
-- it moves no money. Re-runnable; a second run inserts nothing.

CREATE OR REPLACE FUNCTION public.fn_backfill_bomb_pot_award_units(
  p_limit integer DEFAULT 1000,
  p_dry_run boolean DEFAULT true
)
RETURNS TABLE (
  hands_considered  bigint,
  hands_written     bigint,
  units_written     bigint,
  hands_skipped     bigint,
  skip_reason       text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_considered bigint := 0;
  v_written    bigint := 0;
  v_units      bigint := 0;
  v_skipped    bigint := 0;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS zz_backfill_units (
    hand_history_id uuid,
    table_id        uuid,
    hand_number     bigint,
    pot_index       integer,
    board           smallint,
    side            text,
    user_id         uuid,
    amount          numeric,
    hand_name       text
  ) ON COMMIT DROP;
  DELETE FROM zz_backfill_units;

  WITH candidates AS (
    SELECT
      h.id, h.table_id, h.hand_number,
      h.winners -> 0 ->> 'userId' AS winner_id,
      h.winners -> 0 -> 'hand' ->> 'name' AS hand_name,
      -- Boards that actually settled. array_length is NULL on an absent board.
      1
        + (CASE WHEN COALESCE(array_length(h.community_cards2, 1), 0) = 5 THEN 1 ELSE 0 END)
        + (CASE WHEN COALESCE(array_length(h.community_cards3, 1), 0) = 5 THEN 1 ELSE 0 END)
        AS boards,
      -- Pot layers. A hand with no stored pots is treated as one pot of the
      -- whole pot_size, which is what a single-layer hand is.
      COALESCE(
        NULLIF(h.pots, 'null'::jsonb),
        jsonb_build_array(jsonb_build_object('index', 0, 'amount', h.pot_size))
      ) AS pots,
      round(COALESCE(h.pot_size, 0) - COALESCE(h.rake_amount, 0) - COALESCE(h.bbj_amount, 0), 2)
        AS net_winnings,
      COALESCE(h.pot_size, 0) AS gross_pot
    FROM public.hand_history h
    WHERE h.bomb_pot IS NOT NULL
      AND jsonb_array_length(COALESCE(h.winners, '[]'::jsonb)) = 1
      AND h.winners -> 0 ->> 'userId' IS NOT NULL
      AND COALESCE(h.pot_size, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.bomb_pot_award_units a WHERE a.hand_history_id = h.id
      )
    ORDER BY h.created_at
    LIMIT GREATEST(p_limit, 0)
  ),
  -- One row per (pot layer, board): the engine's integer-cent split, with the
  -- indivisible remainder cents going to the lowest board numbers first.
  shares AS (
    SELECT
      c.*,
      (p.value ->> 'index')::int AS pot_index,
      b.board_no,
      (
        (round((p.value ->> 'amount')::numeric * 100)::bigint / c.boards)
        + CASE
            WHEN b.board_no <= (round((p.value ->> 'amount')::numeric * 100)::bigint % c.boards)
            THEN 1 ELSE 0
          END
      ) AS share_cents
    FROM candidates c
    CROSS JOIN LATERAL jsonb_array_elements(c.pots) p
    CROSS JOIN LATERAL generate_series(1, c.boards) AS b(board_no)
  ),
  -- Scale every share by the same rake ratio the engine applied globally.
  scaled AS (
    SELECT
      s.*,
      round(s.share_cents * (s.net_winnings / NULLIF(s.gross_pot, 0))) AS scaled_cents
    FROM shares s
  ),
  -- The penny repair: the winner's units must sum to the winner's credit to
  -- the cent, so the difference lands on the largest share.
  repaired AS (
    SELECT
      sc.*,
      row_number() OVER (
        PARTITION BY sc.id ORDER BY sc.scaled_cents DESC, sc.pot_index, sc.board_no
      ) AS rn,
      round(sc.net_winnings * 100) - SUM(sc.scaled_cents) OVER (PARTITION BY sc.id) AS diff
    FROM scaled sc
  )
  INSERT INTO zz_backfill_units
  SELECT
    r.id, r.table_id, r.hand_number, r.pot_index, r.board_no::smallint,
    'high', r.winner_id::uuid,
    (r.scaled_cents + CASE WHEN r.rn = 1 THEN r.diff ELSE 0 END) / 100.0,
    r.hand_name
  FROM repaired r;

  SELECT count(DISTINCT hand_history_id), count(*)
    INTO v_written, v_units
  FROM zz_backfill_units;
  v_considered := v_written;

  -- A unit of zero or less is not an award. If any appeared, the arithmetic
  -- disagreed with the hand and the whole hand is left alone rather than
  -- half-written.
  DELETE FROM zz_backfill_units u
  WHERE EXISTS (
    SELECT 1 FROM zz_backfill_units z
    WHERE z.hand_history_id = u.hand_history_id AND z.amount <= 0
  );

  SELECT count(DISTINCT hand_history_id), count(*)
    INTO v_written, v_units
  FROM zz_backfill_units;
  v_skipped := v_considered - v_written;

  IF NOT p_dry_run THEN
    INSERT INTO public.bomb_pot_award_units
      (hand_history_id, table_id, hand_number, pot_index, board, side, user_id, amount, hand_name)
    SELECT hand_history_id, table_id, hand_number, pot_index, board, side, user_id, amount, hand_name
    FROM zz_backfill_units
    ON CONFLICT (hand_history_id, pot_index, board, side, user_id) DO NOTHING;
  END IF;

  hands_considered := v_considered;
  hands_written    := v_written;
  units_written    := v_units;
  hands_skipped    := v_skipped;
  skip_reason      := 'non-positive share after rake scaling';
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_backfill_bomb_pot_award_units(integer, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_backfill_bomb_pot_award_units(integer, boolean)
  TO service_role;

COMMENT ON FUNCTION public.fn_backfill_bomb_pot_award_units(integer, boolean) IS
  'Reconstructs bomb_pot_award_units for SINGLE-WINNER bomb hands only, from '
  'stored pots/boards/rake — arithmetic, never card evaluation. Multi-winner '
  'hands are deliberately left missing and visible in fn_bomb_pot_ledger_gaps, '
  'because hand_history.winners does not record which board each winner took.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_backfill_bomb_pot_award_units'
  ) THEN
    RAISE EXCEPTION 'assertion failed: fn_backfill_bomb_pot_award_units missing';
  END IF;
END $$;

-- ROLLBACK: the inserted rows are identifiable as award units on hands whose
-- created_at pre-dates the ledger's own first row (2026-08-28 18:20:49Z):
--   DELETE FROM public.bomb_pot_award_units a
--    USING public.hand_history h
--    WHERE h.id = a.hand_history_id
--      AND h.created_at < timestamptz '2026-08-28 18:20:49+00';
--   DROP FUNCTION IF EXISTS public.fn_backfill_bomb_pot_award_units(integer, boolean);
