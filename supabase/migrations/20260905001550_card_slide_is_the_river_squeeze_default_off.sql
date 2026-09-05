-- 20260905001550_card_slide_is_the_river_squeeze_default_off.sql
--
-- APPLIED TO PRODUCTION 2026-09-04 (version 20260905001550, as recorded in
-- supabase_migrations.schema_migrations); this file is the record of it.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- `user_table_settings.card_slide` ("Card Slide") defaulted to TRUE and, since
-- 2026-08-23, had no consumer at all - the switch showed ON and did nothing.
-- Dan 2026-09-04: the card slide feature "SHOULD ALWAYS BE TURNED OFF BY
-- DEFAULT". This flips the column default to false and resets any row still
-- holding the old default that the user never deliberately touched
-- (settings_touched). A true nobody chose, on a switch that did nothing, is
-- not a preference; rows the user DID touch are left alone.
--
-- Read before writing: 3 rows, 2 false (both touched), 1 untouched true.
-- (The name says "river squeeze" because that was the first use planned for
-- the switch. It is now the hole-card corner peel - see 20260905040622.)

BEGIN;

ALTER TABLE public.user_table_settings
  ALTER COLUMN card_slide SET DEFAULT false;

UPDATE public.user_table_settings
   SET card_slide = false
 WHERE card_slide = true
   AND NOT ('card_slide' = ANY (COALESCE(settings_touched, '{}'::text[])));

DO $$
DECLARE
  v_default text;
BEGIN
  SELECT column_default INTO v_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'user_table_settings'
     AND column_name = 'card_slide';
  IF v_default IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'card_slide default is % - expected false', v_default;
  END IF;
END $$;

COMMIT;
