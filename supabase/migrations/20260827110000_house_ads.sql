-- ═══════════════════════════════════════════════════════════════════════════
--  HOUSE ADS — an advertising system with no advertisers
-- ═══════════════════════════════════════════════════════════════════════════
-- Dan 2026-08-27: "SINCE WE HAVE ZERO PAID ADS WE SHOULD BE PROMOTING OUR OWN
-- FEATURES AND CONTENTS IN THE AD SPACE." And, explicitly: "even vips will see
-- ads" — so there is NO VIP suppression in this design, and the "Ad-Free
-- Experience" line was removed from every VIP surface that still sold it (the
-- Geeves knowledge base was the live one).
--
-- The plumbing is deliberately what a paying advertiser would need, so the day
-- one arrives nothing is rebuilt: a catalog of creative, a placement layer
-- that decides where and to whom, and an event log that says whether any of it
-- worked.
--
-- WHY THE EVENT LOG IS THE POINT. Eleven promotional surfaces already ship in
-- this product — the lobby strip, the tournament ticker, overlay
-- announcements, the promotion carousel — and NOT ONE recorded an impression
-- or a click. We have been advertising for months with no idea whether anyone
-- looked. That is the gap this closes first.
--
-- Applied to production 2026-08-27 as `house_ads_catalog_and_events` +
-- `house_ads_seed_first_campaigns`; this file is the consolidated record.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── The creative ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ad_catalog (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_key        text NOT NULL UNIQUE,
  category      text NOT NULL CHECK (category IN
                  ('vip','diamonds','spins','tournaments','bbj','mystery_bounty',
                   'referral','feature','club','event','other')),
  headline      text NOT NULL,
  body          text,
  -- A glyph, never an emoji: emoji in source breaks the SWC compiler.
  glyph         text,
  target_url    text,
  cta_label     text,
  is_active     boolean NOT NULL DEFAULT true,
  starts_at     timestamptz,
  ends_at       timestamptz,
  weight        integer NOT NULL DEFAULT 100 CHECK (weight BETWEEN 0 AND 1000),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_catalog_live ON public.ad_catalog (is_active, starts_at, ends_at);

-- ── Where it runs, and to whom ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ad_placement (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_id       uuid NOT NULL REFERENCES public.ad_catalog(id) ON DELETE CASCADE,
  slot        text NOT NULL CHECK (slot IN
                ('lobby_strip','session_summary','empty_state','hub_promotions','table_between_hands')),
  club_id     uuid,
  audience    text CHECK (audience IN ('all','non_vip','vip','new_player','returning')),
  daily_cap   integer CHECK (daily_cap IS NULL OR daily_cap > 0),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ad_id, slot, club_id)
);
CREATE INDEX IF NOT EXISTS idx_ad_placement_slot ON public.ad_placement (slot, is_active);

-- ── Did anyone look? ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ad_event (
  id         bigserial PRIMARY KEY,
  ad_id      uuid REFERENCES public.ad_catalog(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  slot       text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('impression','click','dismiss')),
  club_id    uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_event_rollup ON public.ad_event (ad_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_event_cap ON public.ad_event (user_id, ad_id, created_at DESC);

-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.ad_catalog   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_placement ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_event     ENABLE ROW LEVEL SECURITY;

-- Reading the creative is public: it is an advert. Writing is service-role
-- only — no write policy exists, so RLS denies every browser write and the
-- admin panel must go through the authenticated API route.
DROP POLICY IF EXISTS ad_catalog_read ON public.ad_catalog;
CREATE POLICY ad_catalog_read ON public.ad_catalog FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS ad_placement_read ON public.ad_placement;
CREATE POLICY ad_placement_read ON public.ad_placement FOR SELECT TO anon, authenticated USING (true);

-- A player records their OWN views and clicks and reads none back: one player
-- must never be able to enumerate another's viewing history.
DROP POLICY IF EXISTS ad_event_insert_own ON public.ad_event;
CREATE POLICY ad_event_insert_own ON public.ad_event
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));

GRANT SELECT ON public.ad_catalog, public.ad_placement TO anon, authenticated;
GRANT INSERT ON public.ad_event TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.ad_event_id_seq TO authenticated;

-- ── The resolver ───────────────────────────────────────────────────────────
-- One question, one answer: what should THIS player see in THIS slot right
-- now. Every targeting rule lives here so the client cannot disagree with the
-- database about eligibility, and so a future paid advertiser is never billed
-- for impressions a browser decided to serve itself.
--
-- NOTE, deliberately: there is NO VIP exclusion (Dan, above). If that ever
-- changes it changes here and nowhere else.
CREATE OR REPLACE FUNCTION public.fn_resolve_ads(
  p_slot text, p_club_id uuid DEFAULT NULL, p_limit integer DEFAULT 3
)
RETURNS TABLE (
  ad_id uuid, ad_key text, category text, headline text,
  body text, glyph text, target_url text, cta_label text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_vip  boolean := false;
BEGIN
  IF v_user IS NOT NULL THEN
    SELECT COALESCE(p.is_vip, false) INTO v_vip FROM public.profiles p WHERE p.id = v_user;
  END IF;

  RETURN QUERY
  SELECT c.id, c.ad_key, c.category, c.headline, c.body, c.glyph, c.target_url, c.cta_label
    FROM public.ad_catalog c
    JOIN public.ad_placement pl ON pl.ad_id = c.id
   WHERE c.is_active AND pl.is_active AND pl.slot = p_slot
     AND (c.starts_at IS NULL OR c.starts_at <= now())
     AND (c.ends_at   IS NULL OR c.ends_at   >  now())
     AND (pl.club_id IS NULL OR pl.club_id = p_club_id)
     AND (
           pl.audience IS NULL OR pl.audience = 'all'
        OR (pl.audience = 'vip'     AND v_vip)
        OR (pl.audience = 'non_vip' AND v_user IS NOT NULL AND NOT v_vip)
        OR (pl.audience = 'new_player' AND v_user IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.profiles p WHERE p.id = v_user AND p.created_at > now() - interval '7 days'))
        OR (pl.audience = 'returning'  AND v_user IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.profiles p WHERE p.id = v_user AND p.created_at <= now() - interval '7 days'))
     )
     -- Frequency cap: never show one player the same thing all day.
     AND (
           pl.daily_cap IS NULL OR v_user IS NULL
        OR (SELECT count(*) FROM public.ad_event e
             WHERE e.user_id = v_user AND e.ad_id = c.id AND e.event_type = 'impression'
               AND e.created_at > now() - interval '24 hours') < pl.daily_cap
     )
   ORDER BY c.weight DESC, c.created_at DESC
   LIMIT GREATEST(0, LEAST(p_limit, 10));
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_resolve_ads(text, uuid, integer) TO anon, authenticated;

-- ── Opening inventory ──────────────────────────────────────────────────────
-- Every line promotes something that EXISTS at the path given: a promo that
-- deep-links to a 404 is worse than an empty slot. Title Case, no em dashes
-- (house popup rule), glyphs not emoji.
INSERT INTO public.ad_catalog (ad_key, category, headline, body, glyph, target_url, cta_label, weight) VALUES
  ('vip_upsell','vip','Unlock Every Table Theme',
   'VIP Opens All Felts, Card Backs, Backgrounds And Frames. Three Of Each Are Free For Everyone.','◆','/vip','See VIP',120),
  ('spins_jackpot','spins','Spins Pay Up To 1000x',
   'Three Players, One Hand, A Prize Drawn Before The Cards. Sit Down And It Starts.','◉','/','Find A Spin',110),
  ('bbj_running','bbj','The Bad Beat Jackpot Is Live',
   'Lose With Quads Or Better At A Qualifying Table And The Whole Room Gets Paid.','★','/','How It Works',100),
  ('diamonds_store','diamonds','Diamonds Buy Chips Instantly',
   'Top Up Without Leaving The Table. Every Purchase Is Server Priced.','◈','/cashier','Open Cashier',90),
  ('referral_invite','referral','Bring A Friend, Both Get Paid',
   'They Join, You Both Collect Diamonds When They Play Their First Hands.','▣','/invite','Invite A Friend',85),
  ('tournaments_daily','tournaments','Tournaments Run All Day',
   'Guarantees, Bounties And Mystery Chests. Late Registration Is Usually Still Open.','▲','/tournaments','See The Board',80)
ON CONFLICT (ad_key) DO NOTHING;

-- Seeing the same VIP pitch more than three times a day is how a player learns
-- to stop reading the strip entirely.
INSERT INTO public.ad_placement (ad_id, slot, audience, daily_cap)
SELECT c.id, 'lobby_strip',
       CASE WHEN c.ad_key = 'vip_upsell' THEN 'non_vip' ELSE 'all' END,
       CASE WHEN c.ad_key IN ('vip_upsell','diamonds_store') THEN 3 ELSE NULL END
  FROM public.ad_catalog c
 WHERE c.ad_key IN ('vip_upsell','spins_jackpot','bbj_running','diamonds_store','referral_invite','tournaments_daily')
ON CONFLICT (ad_id, slot, club_id) DO NOTHING;

-- ── Post-apply assertions ──────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='ad_catalog') THEN
    RAISE EXCEPTION 'ad_catalog missing';
  END IF;
  PERFORM * FROM public.fn_resolve_ads('lobby_strip', NULL, 3);
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.ad_catalog'::regclass AND polcmd <> 'r') THEN
    RAISE EXCEPTION 'ad_catalog has a non-SELECT policy - clients could write adverts';
  END IF;
END $$;

-- ROLLBACK:
--   DROP FUNCTION public.fn_resolve_ads(text, uuid, integer);
--   DROP TABLE public.ad_event; DROP TABLE public.ad_placement; DROP TABLE public.ad_catalog;
