-- 20260905040622_card_slide_absorbs_card_squeeze.sql
--
-- Version reserved by scripts/new-migration.mjs, then re-stamped to the version the
-- Supabase MCP recorded when it was applied to production (2026-09-04).
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-09-04: "THE CORNERS OF THE CARDS SHOULD BE 'PEELED BACK' LIKE YOUR
-- LOOKING AT THEM AT A REAL POKER TABLE ... IT NEEDS TO FEEL AND ACT LIKE THE
-- USER IS ACTUALLY TOUCHING THE SCREEN AND LIFTING THE CARDS OFF THE FELT ...
-- THIS IS HOW IT WORKS WHEN YOU 'SLIDE THE CARDS' TO LOOK AT YOUR HOLE CARDS."
--
-- The feature - hero cards dealt face down, opened by a finger gesture - was
-- switched by `card_squeeze` (2026-08-19, a hinge animation), while a second
-- switch, `card_slide`, sat beside it in the same panel doing nothing. Dan
-- calls the feature Card Slide. So: ONE switch, `card_slide`, drives the new
-- corner peel; `card_squeeze` is retired from the UI and no longer read.
--
-- Data: anyone who had turned Card Squeeze on keeps the feature - their
-- preference is carried into card_slide. No DDL; the retired column stays
-- (dropping it would fire a 28s PostgREST reload for no player benefit and
-- break any client still holding the old bundle).
--
-- Read before writing (2026-09-04): 3 rows; card_squeeze true on 0-3 of them.
-- The carry-over is idempotent either way.

BEGIN;

UPDATE public.user_table_settings
   SET card_slide = true,
       settings_touched = CASE
         WHEN 'card_slide' = ANY (COALESCE(settings_touched, '{}'::text[]))
           THEN settings_touched
         ELSE array_append(COALESCE(settings_touched, '{}'::text[]), 'card_slide')
       END
 WHERE card_squeeze = true
   AND card_slide = false;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.user_table_settings
     WHERE card_squeeze = true AND card_slide = false
  ) THEN
    RAISE EXCEPTION 'a card_squeeze preference was not carried into card_slide';
  END IF;
END $$;

COMMIT;
