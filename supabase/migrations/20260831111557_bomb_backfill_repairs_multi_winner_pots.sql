-- PHASE 1: the bomb-pot repair could not repair a bomb pot.
--
-- fn_backfill_bomb_pot_award_units selects candidates with
--     AND jsonb_array_length(COALESCE(h.winners,'[]'::jsonb)) = 1
-- so it only ever repairs SINGLE-winner hands. A multi-board bomb pot has a
-- winner per board, which is the entire point of a bomb pot. Measured
-- 2026-08-31: the detector reported 6 gaps, every one with 2-3 winners and
-- board_count 2-3, and the repair function left all 6 untouched while
-- reporting success on 6 unrelated single-winner hands. The gap could never
-- reach zero and accumulated indefinitely.
--
-- The multi-winner case needs NO scaling arithmetic: hand_history.winners
-- already carries userId, amount and potIndex per winner, and those amounts
-- are already net. Verified on all 6 live gaps - winners_sum equals
-- (pot_size - rake_amount - bbj_amount) to the cent on every one.
--
-- Board attribution: the winners array does not name a board, so each winner
-- within a pot is assigned a distinct board ordinal. That satisfies the
-- (hand_history_id, pot_index, board, side, user_id) unique key and, more
-- importantly, makes the SUM exact - which is what fn_bomb_pot_ledger_gaps
-- actually asserts. The per-board attribution is a reconstruction and is
-- labelled as such by side='high' exactly as the single-winner path does.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5): no is_horse branch. A horse's bomb-pot
-- award is reconstructed identically to a human's.
--
-- TIER 3 (function change). ROLLBACK pasted at the bottom.

DO $$
DECLARE v_gaps int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_backfill_bomb_pot_award_units') THEN
    RAISE EXCEPTION 'pre-flight: fn_backfill_bomb_pot_award_units missing';
  END IF;
  SELECT count(*) INTO v_gaps FROM public.fn_bomb_pot_ledger_gaps('1 day'::interval);
  RAISE NOTICE 'pre-flight: % bomb gaps open', v_gaps;
END $$;

CREATE OR REPLACE FUNCTION public.fn_backfill_bomb_multi_winner_units(
  p_limit integer DEFAULT 500,
  p_dry_run boolean DEFAULT true
)
RETURNS TABLE (hands_considered bigint, hands_written bigint, units_written bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_hands bigint := 0;
  v_units bigint := 0;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS zz_bomb_multi (
    hand_history_id uuid, table_id uuid, hand_number bigint,
    pot_index integer, board smallint, side text,
    user_id uuid, amount numeric, hand_name text
  ) ON COMMIT DROP;
  DELETE FROM zz_bomb_multi;

  WITH candidates AS (
    SELECT h.id, h.table_id, h.hand_number, h.winners,
           round(COALESCE(h.pot_size,0) - COALESCE(h.rake_amount,0) - COALESCE(h.bbj_amount,0), 2) AS net_winnings
    FROM public.hand_history h
    WHERE h.bomb_pot IS NOT NULL
      AND jsonb_array_length(COALESCE(h.winners,'[]'::jsonb)) > 1
      AND COALESCE(h.pot_size,0) > 0
      AND NOT EXISTS (SELECT 1 FROM public.bomb_pot_award_units a WHERE a.hand_history_id = h.id)
    ORDER BY h.created_at
    LIMIT GREATEST(p_limit, 0)
  ),
  exploded AS (
    SELECT c.id, c.table_id, c.hand_number, c.net_winnings,
           (w.value ->> 'userId')::uuid                       AS user_id,
           COALESCE((w.value ->> 'potIndex')::int, 0)         AS pot_index,
           (w.value ->> 'amount')::numeric                    AS amount,
           w.value -> 'hand' ->> 'name'                       AS hand_name,
           row_number() OVER (PARTITION BY c.id, COALESCE((w.value ->> 'potIndex')::int,0)
                              ORDER BY w.ordinality)          AS board_no
    FROM candidates c
    CROSS JOIN LATERAL jsonb_array_elements(c.winners) WITH ORDINALITY AS w(value, ordinality)
    WHERE (w.value ->> 'userId') IS NOT NULL
      AND (w.value ->> 'amount') IS NOT NULL
  ),
  -- Only repair hands whose winner amounts reconstruct the net pot exactly.
  -- A hand that does not add up is a DIFFERENT defect and must stay visible.
  exact AS (
    SELECT e.*
    FROM exploded e
    JOIN (
      SELECT id, net_winnings, round(SUM(amount),2) AS winners_sum
      FROM exploded GROUP BY id, net_winnings
    ) s ON s.id = e.id AND s.winners_sum = e.net_winnings
  )
  INSERT INTO zz_bomb_multi
  SELECT e.id, e.table_id, e.hand_number, e.pot_index, e.board_no::smallint,
         'high', e.user_id, e.amount, e.hand_name
  FROM exact e
  WHERE e.amount > 0;

  SELECT count(DISTINCT hand_history_id), count(*) INTO v_hands, v_units FROM zz_bomb_multi;

  IF NOT p_dry_run THEN
    INSERT INTO public.bomb_pot_award_units
      (hand_history_id, table_id, hand_number, pot_index, board, side, user_id, amount, hand_name)
    SELECT hand_history_id, table_id, hand_number, pot_index, board, side, user_id, amount, hand_name
    FROM zz_bomb_multi
    ON CONFLICT (hand_history_id, pot_index, board, side, user_id) DO NOTHING;
  END IF;

  hands_considered := v_hands;
  hands_written    := v_hands;
  units_written    := v_units;
  RETURN NEXT;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_backfill_bomb_multi_winner_units(integer, boolean) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_backfill_bomb_multi_winner_units(integer, boolean) IS
  'Repairs bomb_pot_award_units for MULTI-winner bomb pots, which fn_backfill_bomb_pot_award_units excludes via its jsonb_array_length(winners)=1 filter. Uses the per-winner amounts already recorded in hand_history.winners, and only repairs hands whose winner amounts sum exactly to the net pot.';

DO $$
DECLARE v_h bigint; v_u bigint;
BEGIN
  SELECT hands_written, units_written INTO v_h, v_u
    FROM public.fn_backfill_bomb_multi_winner_units(500, true);
  IF v_h IS NULL THEN RAISE EXCEPTION 'post-apply: dry run returned no row'; END IF;
  RAISE NOTICE 'post-apply: dry run would repair % hands / % units', v_h, v_u;
  IF has_function_privilege('anon','public.fn_backfill_bomb_multi_winner_units(integer,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'post-apply: anon can execute the repair';
  END IF;
END $$;

-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_backfill_bomb_multi_winner_units(integer, boolean);
--   -- award units already written are correct reconstructions; to remove them:
--   -- DELETE FROM public.bomb_pot_award_units WHERE created_at >= '<apply time>';
