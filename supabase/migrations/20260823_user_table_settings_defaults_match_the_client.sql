-- A setting that switches itself off the first time you change a different one.
--
-- `useUserTableSettings` renders from DEFAULT_USER_TABLE_SETTINGS until the
-- user's row loads, and saves with a PER-KEY upsert:
--
--     upsert({ user_id, [key]: newValue }, { onConflict: 'user_id' })
--
-- So for a user with no row, changing ANY one setting inserts the row and every
-- other column silently takes its COLUMN default. Where the column default
-- disagreed with the client default, the user's other settings flipped
-- underneath them and stuck, on every device, for good.
--
-- Four columns disagreed. Two are corrected on the client (a beta and a
-- permission prompt must never default on): multi_shared_socket and
-- multi_desktop_alerts stay false and the client now says false too.
--
-- These two go the other way. `card_slide` and `enhanced_view` have been
-- effectively TRUE for every user since the client default is what they
-- actually experience; making the client false would be the behaviour change,
-- while making the column true simply stops the silent flip. Existing rows are
-- left exactly as they are -- a default change is not a data change, and
-- anyone who deliberately turned these off keeps them off.
--
-- APPLIED TO PRODUCTION 2026-08-23 via Supabase MCP apply_migration before this
-- branch was pushed, per CHECK 17. Pinned from the client side by
-- tests/user-table-settings-defaults.test.ts, which asserts EVERY boolean.
ALTER TABLE public.user_table_settings ALTER COLUMN card_slide SET DEFAULT true;
ALTER TABLE public.user_table_settings ALTER COLUMN enhanced_view SET DEFAULT true;

DO $$
DECLARE
  v_card_slide text;
  v_enhanced   text;
BEGIN
  SELECT column_default INTO v_card_slide FROM information_schema.columns
   WHERE table_schema='public' AND table_name='user_table_settings' AND column_name='card_slide';
  SELECT column_default INTO v_enhanced FROM information_schema.columns
   WHERE table_schema='public' AND table_name='user_table_settings' AND column_name='enhanced_view';
  IF v_card_slide IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'card_slide default is %, expected true', v_card_slide;
  END IF;
  IF v_enhanced IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'enhanced_view default is %, expected true', v_enhanced;
  END IF;
END $$;

-- ROLLBACK
--   ALTER TABLE public.user_table_settings ALTER COLUMN card_slide SET DEFAULT false;
--   ALTER TABLE public.user_table_settings ALTER COLUMN enhanced_view SET DEFAULT false;
