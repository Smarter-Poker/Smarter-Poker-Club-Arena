-- =============================================================================
-- the_pineapple_on_the_floor_is_crazy_pineapple
-- Applied to production via Supabase MCP 2026-09-01 14:03 UTC.
--
-- Dan, 2026-09-01: "CHECK TO SEE IF ITS JUST 'PINEAPPLE' OR ANY OTHER NAME
-- VARIATIONS ... I'VE PLAYED IT IN THE MIDWAY UNION SO IT DOES EXIST."
--
-- He is right. The engine's one pineapple variant deals three cards and runs
-- the discard AFTER the flop: HandStage is 'preflop' -> 'flop' ->
-- 'pineapple_discard' -> 'turn', and pineappleDiscardChoice.ts opens with
-- "Crazy Pineapple has exactly one decision the other variants do not". That
-- is Crazy Pineapple by definition -- it has simply been labeled "Pineapple"
-- everywhere. Classic Pineapple (discard BEFORE the flop) is the variant the
-- engine does NOT have.
--
-- This renames the 140 seeded Deep Stack tables to say what they actually
-- deal, and moves their seed keys to dss:crazypineapple:* so a rerun of the
-- catalog seed cannot double-create. Classic Pineapple's 140 tables stay
-- blocked on engine work (a discard stage between preflop and flop).
-- =============================================================================
DO $$
DECLARE v_n int;
BEGIN
  UPDATE tables
     SET name = replace(name, 'Pineapple ', 'Crazy Pineapple '),
         settings = jsonb_set(settings, '{seed_key}',
           to_jsonb(replace(settings->>'seed_key', 'dss:pineapple:', 'dss:crazypineapple:')))
   WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
     AND coalesce(is_deleted,false)=false
     AND game_variant='pineapple'
     AND settings->>'catalog'='dss-cash-v1'
     AND name NOT LIKE 'Crazy %';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 140 THEN
    RAISE EXCEPTION 'renamed % pineapple tables, expected 140', v_n;
  END IF;
  IF (SELECT count(*) FROM tables
       WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
         AND coalesce(is_deleted,false)=false
         AND settings->>'seed_key' LIKE 'dss:crazypineapple:%') <> 140 THEN
    RAISE EXCEPTION 'seed keys did not move';
  END IF;
END $$;
