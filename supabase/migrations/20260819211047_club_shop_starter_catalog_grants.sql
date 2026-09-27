-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819211047 "club_shop_starter_catalog_grants"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8ed80504b0b21aa5bd0e6e011f41cce9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Attach real grants to the starter catalog, and correct the two Time Bank
-- names: fn_time_bank_allowance credits 20 SECONDS PER USE, so "+30s" was not
-- expressible. 3 uses = 60s, 5 uses = 100s.

UPDATE club_shop_items SET
  name = 'Time Bank +60s',
  description = 'Adds 60 seconds of extra decision time (3 uses x 20s). [starter]',
  grant_spec = '{"type":"time_bank","qty":3}'::jsonb
WHERE name = 'Time Bank +30s';

UPDATE club_shop_items SET
  name = 'Time Bank Bundle (+100s)',
  description = 'Five time bank uses at a bundle discount (5 x 20s = 100s). [starter]',
  grant_spec = '{"type":"time_bank","qty":5}'::jsonb
WHERE name = 'Time Bank Bundle (5x)';

UPDATE club_shop_items SET grant_spec = '{"type":"table_skin","theme_id":"midnight_felt"}'::jsonb
WHERE name = 'Midnight Felt Table Skin';

UPDATE club_shop_items SET grant_spec = '{"type":"table_skin","theme_id":"royal_gold"}'::jsonb
WHERE name = 'Royal Gold Table Skin';

UPDATE club_shop_items SET grant_spec = '{"type":"throwable","qty":10}'::jsonb
WHERE name IN ('Tomato Pack (10)', 'Snowball Pack (10)');

UPDATE club_shop_items SET grant_spec = '{"type":"throwable","qty":3}'::jsonb
WHERE name = 'Golden Egg (3)';

UPDATE club_shop_items SET grant_spec = '{"type":"emote_pack"}'::jsonb
WHERE name IN ('Classic Emote Pack', 'Premium Emote Pack');

UPDATE club_shop_items SET grant_spec = '{"type":"avatar","avatar_id":"shark"}'::jsonb
WHERE name = 'Shark Avatar';

UPDATE club_shop_items SET grant_spec = '{"type":"avatar","avatar_id":"crown"}'::jsonb
WHERE name = 'Crown Avatar';

UPDATE club_shop_items SET grant_spec = '{"type":"none"}'::jsonb
WHERE name = 'VIP Rail Seat (7 days)';

-- Keep the artwork pointing at the renamed time bank rows.
UPDATE club_shop_items SET image_url = '/hub/club-arena/images/shop/time-bank-30s.svg'
WHERE name = 'Time Bank +60s' AND image_url IS NULL;
UPDATE club_shop_items SET image_url = '/hub/club-arena/images/shop/time-bank-bundle.svg'
WHERE name = 'Time Bank Bundle (+100s)' AND image_url IS NULL;

DO $$
DECLARE v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
  FROM club_shop_items
  WHERE is_active AND description LIKE '%[starter]%' AND grant_spec IS NULL;
  IF v_missing > 0 THEN
    RAISE EXCEPTION '% starter item(s) still have no grant_spec', v_missing;
  END IF;
END $$;
