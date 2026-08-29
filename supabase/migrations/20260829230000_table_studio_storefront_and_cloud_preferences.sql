-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE STUDIO — A-LA-CARTE CHECKOUT + CROSS-DEVICE COLLECTIONS
-- ═══════════════════════════════════════════════════════════════════════════
-- A premium tile must have one complete path: server-owned price, atomic
-- diamond charge, permanent category entitlement, immediate selection, and a
-- durable receipt. Favorites and loadouts are player preferences rather than
-- entitlements, but they still need to follow the player between devices.

BEGIN;

-- ── 1. Server-authoritative permanent SKUs ───────────────────────────────
-- Prefix format is intentionally parseable without guessing where an asset id
-- ends: studio:<cosmetic_catalog category>:<asset id>.

INSERT INTO public.feature_pricing (feature, diamond_cost, usage_type, description)
SELECT 'studio:' || c.category || ':' || c.asset_id,
       CASE c.category
         WHEN 'theme_id'      THEN 600
         WHEN 'table_id'      THEN 350
         WHEN 'button_id'     THEN 175
         WHEN 'background_id' THEN 250
         ELSE 0
       END,
       'permanent',
       'Table Studio ' || replace(c.category, '_id', '') || ': ' || replace(c.asset_id, '_', ' ')
  FROM public.cosmetic_catalog c
 WHERE c.tier = 'vip'
   AND c.category IN ('theme_id', 'table_id', 'button_id', 'background_id')
ON CONFLICT (feature) DO UPDATE SET
  diamond_cost = EXCLUDED.diamond_cost,
  usage_type = EXCLUDED.usage_type,
  description = EXCLUDED.description;

-- Card backs retain their deliberately tiered prices and historic feature
-- names. The existing delivery trigger remains their entitlement path.

CREATE OR REPLACE FUNCTION public.trg_deliver_table_studio_entitlement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_category text;
  v_asset_id text;
  v_theme_id text;
BEGIN
  IF NEW.feature NOT LIKE 'studio:%' THEN RETURN NEW; END IF;

  v_category := split_part(NEW.feature, ':', 2);
  v_asset_id := substring(NEW.feature from length('studio:' || v_category || ':') + 1);

  IF v_category NOT IN ('theme_id', 'table_id', 'button_id', 'background_id')
     OR v_asset_id IS NULL OR btrim(v_asset_id) = ''
     OR NOT EXISTS (
       SELECT 1 FROM public.cosmetic_catalog c
        WHERE c.category = v_category AND c.asset_id = v_asset_id AND c.tier = 'vip'
     ) THEN
    RAISE EXCEPTION 'Invalid Table Studio entitlement SKU %', NEW.feature
      USING ERRCODE = '23514';
  END IF;

  IF v_category = 'theme_id' THEN
    v_theme_id := public.sp_grant_theme_preset(NEW.user_id, v_asset_id, 'diamond_purchase');
    IF v_theme_id IS NULL THEN
      RAISE EXCEPTION 'Table Studio preset % cannot be delivered', v_asset_id
        USING ERRCODE = '23514';
    END IF;
  ELSE
    INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
    VALUES (NEW.user_id, v_category, v_asset_id, 'diamond_purchase')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deliver_table_studio_entitlement ON public.feature_purchases;
CREATE TRIGGER trg_deliver_table_studio_entitlement
  AFTER INSERT ON public.feature_purchases
  FOR EACH ROW EXECUTE FUNCTION public.trg_deliver_table_studio_entitlement();

REVOKE ALL ON FUNCTION public.trg_deliver_table_studio_entitlement() FROM PUBLIC, anon, authenticated;

-- Backfill a receipt if this migration is replayed after a purchase import.
INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT DISTINCT fp.user_id,
       split_part(fp.feature, ':', 2),
       substring(fp.feature from length('studio:' || split_part(fp.feature, ':', 2) || ':') + 1),
       'purchase_backfill'
  FROM public.feature_purchases fp
  JOIN public.cosmetic_catalog c
    ON c.category = split_part(fp.feature, ':', 2)
   AND c.asset_id = substring(fp.feature from length('studio:' || split_part(fp.feature, ':', 2) || ':') + 1)
 WHERE fp.feature LIKE 'studio:%'
   AND c.category <> 'theme_id'
ON CONFLICT DO NOTHING;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT fp.user_id,
           substring(fp.feature from length('studio:theme_id:') + 1) AS theme_id
      FROM public.feature_purchases fp
     WHERE fp.feature LIKE 'studio:theme_id:%'
  LOOP
    PERFORM public.sp_grant_theme_preset(r.user_id, r.theme_id, 'purchase_backfill');
  END LOOP;
END $$;

-- ── 2. Cross-device favorites and three named loadout slots ──────────────

CREATE TABLE IF NOT EXISTS public.user_table_studio_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  favorites text[] NOT NULL DEFAULT '{}',
  loadouts jsonb NOT NULL DEFAULT '[null,null,null]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT table_studio_favorites_limit CHECK (cardinality(favorites) <= 100),
  CONSTRAINT table_studio_loadouts_array CHECK (
    jsonb_typeof(loadouts) = 'array' AND jsonb_array_length(loadouts) = 3
  )
);

CREATE OR REPLACE FUNCTION public.trg_touch_table_studio_preferences()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_table_studio_preferences ON public.user_table_studio_preferences;
CREATE TRIGGER trg_touch_table_studio_preferences
  BEFORE UPDATE ON public.user_table_studio_preferences
  FOR EACH ROW EXECUTE FUNCTION public.trg_touch_table_studio_preferences();

ALTER TABLE public.user_table_studio_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS table_studio_preferences_select_own ON public.user_table_studio_preferences;
CREATE POLICY table_studio_preferences_select_own
  ON public.user_table_studio_preferences FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS table_studio_preferences_insert_own ON public.user_table_studio_preferences;
CREATE POLICY table_studio_preferences_insert_own
  ON public.user_table_studio_preferences FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS table_studio_preferences_update_own ON public.user_table_studio_preferences;
CREATE POLICY table_studio_preferences_update_own
  ON public.user_table_studio_preferences FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

GRANT SELECT, INSERT, UPDATE ON public.user_table_studio_preferences TO authenticated;
REVOKE ALL ON public.user_table_studio_preferences FROM anon;

ALTER TABLE public.user_table_studio_preferences REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'user_table_studio_preferences'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_table_studio_preferences;
  END IF;
END $$;

-- ── 3. Assertions: nobody may be charged for an undeliverable promise ────

DO $$
DECLARE v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
    FROM public.cosmetic_catalog c
   WHERE c.tier = 'vip'
     AND c.category IN ('theme_id', 'table_id', 'button_id', 'background_id')
     AND NOT EXISTS (
       SELECT 1 FROM public.feature_pricing p
        WHERE p.feature = 'studio:' || c.category || ':' || c.asset_id
          AND p.usage_type = 'permanent'
          AND p.diamond_cost > 0
     );
  IF v_missing <> 0 THEN
    RAISE EXCEPTION '% premium Table Studio assets still have no executable price', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.feature_purchases'::regclass
       AND tgname = 'trg_deliver_table_studio_entitlement'
  ) THEN
    RAISE EXCEPTION 'Table Studio purchase delivery trigger is missing';
  END IF;
END $$;

COMMIT;

