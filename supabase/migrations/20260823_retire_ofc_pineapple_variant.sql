-- ═══════════════════════════════════════════════════════════════════════════
-- Retire the `ofc_pineapple` game variant. It is not a game this platform runs.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- OFC (Open Face Chinese) is a card-PLACEMENT game: no betting rounds, no
-- board, no flop. Every row tagged `ofc_pineapple` in this database is a Crazy
-- Pineapple table wearing the wrong label:
--
--   * all 6 rows are NAMED "Pineapple" — "Pineapple 0.25/0.50",
--     "Pineapple 0.50/1.00", "Noon Grinder (Pineapple) - Table 1/2";
--   * their hands carry preflop / pineapple_discard / flop / turn / river
--     stages, which is Crazy Pineapple and is impossible in OFC;
--   * `HorseFleetManager` has no `ofc_pineapple` entry at all — its Pineapple
--     table is `gameVariant: 'pineapple'` — and its own comment already calls
--     these rows legacy drift: "an old 'ofc_pineapple' row under the
--     crazy-pineapple table name. The config is authoritative";
--   * zero rows have ever used the bare `ofc` variant.
--
-- So the engine has always DEALT pineapple at these tables. Only the label was
-- wrong, and it was wrong loudly: 13,820 hands in three days were written to
-- hand_history under a game nobody was playing, which is what the hand history
-- then reported back to the player.
--
-- This relabels the tables so new hands are recorded correctly. Existing
-- hand_history rows are left alone deliberately — they are an append-only
-- record of what happened, 5.1M rows deep, and rewriting history to make a
-- past mistake invisible is the opposite of what that table is for. The
-- application no longer offers `ofc`/`ofc_pineapple` anywhere, so the old rows
-- fall back to the same display path as any unknown legacy variant.
--
-- TIER 2. No schema change, no destructive change. Reversible: see ROLLBACK.

DO $$
DECLARE
  v_mislabelled int;
  v_wrong_name  int;
BEGIN
  SELECT count(*) INTO v_mislabelled
    FROM public.tables WHERE game_variant = 'ofc_pineapple';

  -- Refuse to run if any of them is NOT a pineapple table by name: that would
  -- mean a real OFC table exists and this migration's premise is wrong.
  SELECT count(*) INTO v_wrong_name
    FROM public.tables
   WHERE game_variant = 'ofc_pineapple'
     AND name NOT ILIKE '%pineapple%';

  IF v_wrong_name > 0 THEN
    RAISE EXCEPTION
      'Aborting: % of % ofc_pineapple tables are not named as Pineapple tables. Re-check before relabelling.',
      v_wrong_name, v_mislabelled;
  END IF;

  RAISE NOTICE 'Relabelling % ofc_pineapple table(s) to pineapple.', v_mislabelled;
END $$;

UPDATE public.tables
   SET game_variant = 'pineapple',
       updated_at   = now()
 WHERE game_variant = 'ofc_pineapple';

-- Post-condition: nothing may still claim to be OFC.
DO $$
DECLARE
  v_left int;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.tables WHERE game_variant IN ('ofc', 'ofc_pineapple');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'Post-condition failed: % table(s) still on an OFC variant.', v_left;
  END IF;
END $$;

-- ROLLBACK (there is no automatic reversal — the original rows are identified
-- by name, and this is the exact set this migration touched):
--
--   UPDATE public.tables SET game_variant = 'ofc_pineapple'
--    WHERE id IN (
--      '06a161fe-caa0-4c22-999a-44c0cae13fc9',  -- Pineapple 0.25/0.50 (running)
--      '8142974f-0213-4023-8394-47b8679f2296',  -- Pineapple 0.50/1.00 (running)
--      'f1391bb1-b160-4fdf-bd08-1b98957fc9e3',  -- Noon Grinder (Pineapple) - Table 2
--      '1f70a18c-1d90-4775-a554-aa6a3cc7672f',  -- Noon Grinder (Pineapple) - Table 1
--      '76b437f7-18d6-427b-bbb7-387687a6270e',  -- Pineapple 0.50/1.00 (deleted)
--      '4cacd366-922f-41b6-9984-db7997327a81'   -- Pineapple 0.25/0.50 (deleted)
--    );
