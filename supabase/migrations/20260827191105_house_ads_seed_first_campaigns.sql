-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827191105; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The opening inventory. Every line promotes something that EXISTS and is
-- reachable at the path given - a promo that deep-links to a 404 is worse
-- than an empty slot. Copy is Title Case with no em dashes (house popup rule)
-- and uses glyphs, never emoji (emoji in source breaks the SWC compiler).
INSERT INTO public.ad_catalog (ad_key, category, headline, body, glyph, target_url, cta_label, weight) VALUES
  ('vip_upsell', 'vip',
   'Unlock Every Table Theme',
   'VIP Opens All Felts, Card Backs, Backgrounds And Frames. Three Of Each Are Free For Everyone.',
   '◆', '/vip', 'See VIP', 120),
  ('spins_jackpot', 'spins',
   'Spins Pay Up To 1000x',
   'Three Players, One Hand, A Prize Drawn Before The Cards. Sit Down And It Starts.',
   '◉', '/', 'Find A Spin', 110),
  ('bbj_running', 'bbj',
   'The Bad Beat Jackpot Is Live',
   'Lose With Quads Or Better At A Qualifying Table And The Whole Room Gets Paid.',
   '★', '/', 'How It Works', 100),
  ('diamonds_store', 'diamonds',
   'Diamonds Buy Chips Instantly',
   'Top Up Without Leaving The Table. Every Purchase Is Server Priced.',
   '◈', '/cashier', 'Open Cashier', 90),
  ('referral_invite', 'referral',
   'Bring A Friend, Both Get Paid',
   'They Join, You Both Collect Diamonds When They Play Their First Hands.',
   '▣', '/invite', 'Invite A Friend', 85),
  ('tournaments_daily', 'tournaments',
   'Tournaments Run All Day',
   'Guarantees, Bounties And Mystery Chests. Late Registration Is Usually Still Open.',
   '▲', '/tournaments', 'See The Board', 80)
ON CONFLICT (ad_key) DO NOTHING;

-- All six run in the lobby strip, every club, uncapped except the upsells:
-- seeing the same VIP pitch more than three times in a day is how a player
-- learns to stop reading the strip entirely.
INSERT INTO public.ad_placement (ad_id, slot, audience, daily_cap)
SELECT c.id, 'lobby_strip',
       CASE WHEN c.ad_key = 'vip_upsell' THEN 'non_vip' ELSE 'all' END,
       CASE WHEN c.ad_key IN ('vip_upsell','diamonds_store') THEN 3 ELSE NULL END
  FROM public.ad_catalog c
 WHERE c.ad_key IN ('vip_upsell','spins_jackpot','bbj_running','diamonds_store','referral_invite','tournaments_daily')
ON CONFLICT (ad_id, slot, club_id) DO NOTHING;

DO $$
DECLARE v_ads integer; v_placements integer;
BEGIN
  SELECT count(*) INTO v_ads FROM public.ad_catalog;
  SELECT count(*) INTO v_placements FROM public.ad_placement WHERE slot='lobby_strip';
  IF v_ads < 6 OR v_placements < 6 THEN
    RAISE EXCEPTION 'seed incomplete: % ads, % placements', v_ads, v_placements;
  END IF;
END $$;
