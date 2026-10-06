-- @live-proof: EXISTS (SELECT 1 FROM public.ad_catalog WHERE ad_key = 'spins_jackpot' AND headline = 'Spins Pay Up To 100X' AND poster_url = '/hub/club-arena/assets/ads/spins-jackpot-poster-v2.webp') AND NOT EXISTS (SELECT 1 FROM public.ad_placement p JOIN public.ad_catalog c ON c.id = p.ad_id WHERE c.ad_key = 'spins_jackpot' AND p.is_active AND p.image_url LIKE '%spins-jackpot-%-v1.webp')
-- Correct the owner-identified Spins advertising claim; no game or payout changes.
-- Publish the four v2 creative assets before installing this catalog update.
-- Existing v1 URLs remain immutable for old clients.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

UPDATE public.ad_catalog
SET headline = 'Spins Pay Up To 100X',
    poster_url = '/hub/club-arena/assets/ads/spins-jackpot-poster-v2.webp'
WHERE ad_key = 'spins_jackpot'
  AND headline IN ('Spins Pay Up To 1000x', 'Spins Pay Up To 1000X', 'Spins Pay Up To 100X')
  AND poster_url IN ('/hub/club-arena/assets/ads/spins-jackpot-poster-v1.webp',
                     '/hub/club-arena/assets/ads/spins-jackpot-poster-v2.webp');

UPDATE public.ad_placement p
SET image_url = replace(p.image_url, '-v1.webp', '-v2.webp')
FROM public.ad_catalog c
WHERE p.ad_id = c.id AND c.ad_key = 'spins_jackpot'
  AND p.image_url IN (
    '/hub/club-arena/assets/ads/spins-jackpot-lobby-strip-v1.webp',
    '/hub/club-arena/assets/ads/spins-jackpot-hub-promotions-v1.webp',
    '/hub/club-arena/assets/ads/spins-jackpot-session-summary-v1.webp'
  );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ad_catalog WHERE ad_key = 'spins_jackpot'
    AND headline = 'Spins Pay Up To 100X'
    AND poster_url = '/hub/club-arena/assets/ads/spins-jackpot-poster-v2.webp') THEN
    RAISE EXCEPTION 'Spins ad changed before the 100X correction';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ad_placement p JOIN public.ad_catalog c ON c.id = p.ad_id
    WHERE c.ad_key = 'spins_jackpot' AND p.is_active
    AND p.image_url LIKE '%spins-jackpot-%-v1.webp') THEN
    RAISE EXCEPTION 'An active Spins placement still selects the 1000X artwork';
  END IF;
END $$;
COMMIT;
