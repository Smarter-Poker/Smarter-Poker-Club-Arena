-- Migration: Add card back feature pricing for diamond purchases
-- Date: 2026-08-25

INSERT INTO feature_pricing (feature, diamond_cost, usage_type, description, vip_tiers_included)
VALUES 
  ('card_back_classic', 50, 'permanent', 'Classic Card Back', '{}'),
  ('card_back_burgundy', 75, 'permanent', 'Burgundy Card Back', '{}'),
  ('card_back_navy', 75, 'permanent', 'Navy Card Back', '{}'),
  ('card_back_gold', 150, 'permanent', 'Premium Gold Card Back', '{}'),
  ('card_back_holographic', 200, 'permanent', 'Holographic Card Back', '{}'),
  ('card_back_carbon', 175, 'permanent', 'Carbon Fiber Card Back', '{}'),
  ('card_back_club-branded', 250, 'permanent', 'Club Crest Card Back', '{}'),
  ('card_back_diamond-foil', 300, 'permanent', 'Diamond Foil Card Back', '{}')
ON CONFLICT (feature) DO UPDATE 
SET diamond_cost = EXCLUDED.diamond_cost,
    usage_type = EXCLUDED.usage_type;
