-- 20260914112817_one_club_shop_item_offers_all_throwables.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
-- The starter catalog described three generic throwable-credit grants as if
-- they were item-locked Tomato, Snowball, and Golden Egg packs. Fulfillment
-- never enforced those names: every `feature_purchases(feature='throwable')`
-- credit can be spent on any throwable id. Sell that existing contract
-- truthfully as one ten-use offer with artwork made from five real table
-- throwables. Historical rows and purchase receipts remain intact; duplicate
-- offers are only hidden.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- Clubs created before the starter catalog (or after a manual cleanup) may not
-- have any throwable row to normalize. Give each one the same platform offer.
-- Diamonds are burned by the existing atomic checkout; this migration does not
-- add a club commission or another wallet destination.
INSERT INTO public.club_shop_items (
  club_id,
  name,
  description,
  price,
  category,
  image_url,
  is_active,
  item_type,
  grant_spec,
  stackable,
  per_user_limit,
  sort_order
)
SELECT
  c.id,
  'All Throwables Pack (10)',
  'Ten Uses Across All 49 Table Throwables, Including Boxing Gloves, Water Guns, Eggs, Tomatoes, Snowballs, And More.',
  1500,
  'Throwables',
  '/hub/club-arena/images/marketplace/throwables/all-throwables-access-v1.png',
  true,
  'throwable',
  jsonb_build_object('type', 'throwable', 'qty', 10),
  true,
  NULL,
  30
FROM public.clubs c
WHERE NOT EXISTS (
  SELECT 1
  FROM public.club_shop_items i
  WHERE i.club_id = c.id
    AND (
      i.category = 'Throwables'
      OR COALESCE(i.grant_spec->>'type', '') = 'throwable'
    )
);

-- Preserve one deterministic row per club so its price, sale window, stock,
-- purchase foreign keys, and reporting history stay stable. The old product
-- names were never an entitlement boundary, so hiding the surplus rows cannot
-- remove a member's already-delivered generic credits.
WITH ranked AS (
  SELECT
    i.id,
    row_number() OVER (
      PARTITION BY i.club_id
      ORDER BY
        CASE
          WHEN i.name = 'All Throwables Pack (10)' THEN 0
          WHEN i.name = 'Tomato Pack (10)' THEN 1
          WHEN i.name = 'Snowball Pack (10)' THEN 2
          WHEN i.name = 'Golden Egg (3)' THEN 3
          ELSE 4
        END,
        CASE WHEN COALESCE(i.is_active, false) THEN 0 ELSE 1 END,
        i.created_at,
        i.id
    ) AS position
  FROM public.club_shop_items i
  WHERE i.category = 'Throwables'
     OR COALESCE(i.grant_spec->>'type', '') = 'throwable'
)
UPDATE public.club_shop_items i
SET
  is_active = ranked.position = 1,
  name = CASE
    WHEN ranked.position = 1 THEN 'All Throwables Pack (10)'
    ELSE i.name
  END,
  description = CASE
    WHEN ranked.position = 1 THEN
      'Ten Uses Across All 49 Table Throwables, Including Boxing Gloves, Water Guns, Eggs, Tomatoes, Snowballs, And More.'
    ELSE i.description
  END,
  category = CASE WHEN ranked.position = 1 THEN 'Throwables' ELSE i.category END,
  item_type = CASE WHEN ranked.position = 1 THEN 'throwable' ELSE i.item_type END,
  image_url = CASE
    WHEN ranked.position = 1 THEN
      '/hub/club-arena/images/marketplace/throwables/all-throwables-access-v1.png'
    ELSE i.image_url
  END,
  grant_spec = CASE
    WHEN ranked.position = 1 THEN jsonb_build_object('type', 'throwable', 'qty', 10)
    ELSE i.grant_spec
  END,
  stackable = CASE WHEN ranked.position = 1 THEN true ELSE i.stackable END,
  per_user_limit = CASE WHEN ranked.position = 1 THEN NULL ELSE i.per_user_limit END
FROM ranked
WHERE i.id = ranked.id;

-- Fail closed if a later service or direct admin write tries to split the
-- catalog back into named object packs. Price, stock, sales, and availability
-- remain configurable; the product identity and generic ten-use grant do not.
ALTER TABLE public.club_shop_items
  ADD CONSTRAINT club_shop_active_throwable_is_all_access CHECK (
    NOT (
      COALESCE(is_active, false)
      AND (
        category = 'Throwables'
        OR COALESCE(grant_spec->>'type', '') = 'throwable'
      )
    )
    OR (
      name IS NOT DISTINCT FROM 'All Throwables Pack (10)'
      AND description IS NOT DISTINCT FROM
        'Ten Uses Across All 49 Table Throwables, Including Boxing Gloves, Water Guns, Eggs, Tomatoes, Snowballs, And More.'
      AND category IS NOT DISTINCT FROM 'Throwables'
      AND item_type IS NOT DISTINCT FROM 'throwable'
      AND image_url IS NOT DISTINCT FROM
        '/hub/club-arena/images/marketplace/throwables/all-throwables-access-v1.png'
      AND grant_spec IS NOT DISTINCT FROM jsonb_build_object('type', 'throwable', 'qty', 10)
      AND COALESCE(stackable, false)
      AND per_user_limit IS NULL
    )
  );

CREATE UNIQUE INDEX club_shop_one_active_throwable_per_club
  ON public.club_shop_items (club_id)
  WHERE COALESCE(is_active, false)
    AND (
      category = 'Throwables'
      OR COALESCE(grant_spec->>'type', '') = 'throwable'
    );

-- The original starter catalog was a one-time backfill. Keep the corrected
-- offer true for clubs created after this migration as well.
CREATE OR REPLACE FUNCTION public.fn_seed_all_throwables_shop_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.club_shop_items (
    club_id,
    name,
    description,
    price,
    category,
    image_url,
    is_active,
    item_type,
    grant_spec,
    stackable,
    per_user_limit,
    sort_order
  ) VALUES (
    NEW.id,
    'All Throwables Pack (10)',
    'Ten Uses Across All 49 Table Throwables, Including Boxing Gloves, Water Guns, Eggs, Tomatoes, Snowballs, And More.',
    1500,
    'Throwables',
    '/hub/club-arena/images/marketplace/throwables/all-throwables-access-v1.png',
    true,
    'throwable',
    jsonb_build_object('type', 'throwable', 'qty', 10),
    true,
    NULL,
    30
  );
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_seed_all_throwables_shop_item()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_seed_all_throwables_shop_item
  AFTER INSERT ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_seed_all_throwables_shop_item();

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.clubs c
    LEFT JOIN public.club_shop_items i
      ON i.club_id = c.id
     AND i.is_active
     AND (
       i.category = 'Throwables'
       OR COALESCE(i.grant_spec->>'type', '') = 'throwable'
     )
    GROUP BY c.id
    HAVING count(i.id) <> 1
  ) THEN
    RAISE EXCEPTION 'Each club must expose exactly one active throwable offer';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.club_shop_items i
    WHERE i.is_active
      AND (
        i.category = 'Throwables'
        OR COALESCE(i.grant_spec->>'type', '') = 'throwable'
      )
      AND (
        i.name IS DISTINCT FROM 'All Throwables Pack (10)'
        OR i.description IS DISTINCT FROM
          'Ten Uses Across All 49 Table Throwables, Including Boxing Gloves, Water Guns, Eggs, Tomatoes, Snowballs, And More.'
        OR i.category IS DISTINCT FROM 'Throwables'
        OR i.item_type IS DISTINCT FROM 'throwable'
        OR i.grant_spec IS DISTINCT FROM jsonb_build_object('type', 'throwable', 'qty', 10)
        OR i.image_url IS DISTINCT FROM '/hub/club-arena/images/marketplace/throwables/all-throwables-access-v1.png'
        OR NOT COALESCE(i.stackable, false)
        OR i.per_user_limit IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'An active throwable offer still promises item-specific or nonstandard access';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.club_shop_items'::regclass
      AND c.conname = 'club_shop_active_throwable_is_all_access'
      AND c.contype = 'c'
      AND c.convalidated
  ) THEN
    RAISE EXCEPTION 'The all-throwables catalog identity is not fail-closed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    WHERE i.indrelid = 'public.club_shop_items'::regclass
      AND idx.relname = 'club_shop_one_active_throwable_per_club'
      AND i.indisunique
      AND i.indisvalid
      AND i.indisready
      AND COALESCE(pg_get_expr(i.indpred, i.indrelid), '') LIKE '%category%Throwables%'
      AND COALESCE(pg_get_expr(i.indpred, i.indrelid), '') LIKE '%grant_spec%throwable%'
      AND COALESCE(pg_get_expr(i.indpred, i.indrelid), '') LIKE '% OR %'
  ) THEN
    RAISE EXCEPTION 'The one-active-throwable guard can be bypassed by changing category or grant type';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.clubs'::regclass
      AND t.tgname = 'trg_seed_all_throwables_shop_item'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Future clubs will not receive the all-throwables offer';
  END IF;
END
$verify$;

COMMIT;
