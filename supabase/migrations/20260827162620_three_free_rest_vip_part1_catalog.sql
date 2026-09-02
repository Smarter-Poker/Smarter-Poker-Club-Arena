-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827162620; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE TABLE IF NOT EXISTS public.cosmetic_catalog (
  category   text NOT NULL CHECK (category IN ('theme_id','table_id','button_id','background_id','cards_id')),
  asset_id   text NOT NULL,
  tier       text NOT NULL CHECK (tier IN ('free','vip')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category, asset_id)
);
ALTER TABLE public.cosmetic_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cosmetic_catalog_read ON public.cosmetic_catalog;
CREATE POLICY cosmetic_catalog_read ON public.cosmetic_catalog FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.cosmetic_catalog TO anon, authenticated;

INSERT INTO public.cosmetic_catalog (category, asset_id, tier) VALUES
  ('theme_id','default-dark','free'),('theme_id','classic-brown','free'),('theme_id','ocean-depths','free'),
  ('theme_id','neon-blue','vip'),('theme_id','rustic-wood','vip'),('theme_id','casino-green','vip'),
  ('theme_id','crimson-club','vip'),('theme_id','arctic-suite','vip'),('theme_id','amethyst-night','vip'),
  ('theme_id','carbon-ion','vip'),
  ('table_id','classic_green','free'),('table_id','ocean_blue','free'),('table_id','carbon_red','free'),
  ('table_id','neon_city','vip'),('table_id','ice_cavern','vip'),('table_id','arctic_white','vip'),
  ('table_id','mahogany_red','vip'),('table_id','crimson','vip'),('table_id','electric_purple','vip'),
  ('table_id','golden_sand','vip'),('table_id','jade_city','vip'),('table_id','amethyst_cavern','vip'),
  ('table_id','carbon_ion','vip'),
  ('button_id','classic-white','free'),('button_id','red-d-gear','free'),('button_id','gray-d-gear','free'),
  ('button_id','blue-crystal','vip'),('button_id','gold-star','vip'),('button_id','sports-themed','vip'),
  ('button_id','jade-seal','vip'),('button_id','amethyst-chip','vip'),('button_id','carbon-ion','vip'),
  ('button_id','ocean-pearl','vip'),
  ('background_id','midnight','free'),('background_id','royal_indigo','free'),('background_id','emerald_room','free'),
  ('background_id','crimson_lounge','vip'),('background_id','ocean_abyss','vip'),('background_id','golden_dusk','vip'),
  ('background_id','galaxy','vip'),('background_id','carbon_grid','vip'),('background_id','ice_frost','vip'),
  ('background_id','jade_neon','vip'),
  ('cards_id','classic_blue','free'),('cards_id','classic_red','free'),('cards_id','royal','free'),
  ('cards_id','gold','vip'),('cards_id','holographic','vip'),('cards_id','carbon','vip'),
  ('cards_id','club-branded','vip'),('cards_id','diamond-foil','vip'),('cards_id','neon','vip'),
  ('cards_id','galaxy','vip'),('cards_id','diamond','vip'),('cards_id','dragon','vip')
ON CONFLICT (category, asset_id) DO UPDATE SET tier = EXCLUDED.tier;

CREATE TABLE IF NOT EXISTS public.theme_asset_unlocks (
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category     text NOT NULL,
  asset_id     text NOT NULL,
  unlock_method text NOT NULL DEFAULT 'grant',
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category, asset_id)
);
ALTER TABLE public.theme_asset_unlocks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS theme_asset_unlocks_read_own ON public.theme_asset_unlocks;
CREATE POLICY theme_asset_unlocks_read_own ON public.theme_asset_unlocks
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
GRANT SELECT ON public.theme_asset_unlocks TO authenticated;

DO $$
DECLARE v_cats integer; v_free integer;
BEGIN
  SELECT count(*) INTO v_cats FROM (
    SELECT category FROM public.cosmetic_catalog WHERE tier='free' GROUP BY category HAVING count(*)=3
  ) t;
  SELECT count(*) INTO v_free FROM public.cosmetic_catalog WHERE tier='free';
  IF v_cats <> 5 OR v_free <> 15 THEN
    RAISE EXCEPTION 'expected 5 categories x 3 free (15), got % categories / % free', v_cats, v_free;
  END IF;
END $$;
