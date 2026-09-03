-- HOUSE ADS PHASE 2 -- the hub_promotions slot, and per-placement destinations
--
-- Phase 1 declared five slots and wired exactly one (lobby_strip). This lights
-- the second: hub_promotions, on the World Hub, which until today had no ad
-- surface of any kind.
--
-- WHY ad_placement GETS ITS OWN target_url
-- Every Phase 1 campaign points at a Club Arena SPA route: /vip, /cashier,
-- /tournaments, /invite. Those paths are correct INSIDE Club Arena, which is
-- served from /hub/club-arena/, and wrong everywhere else. From the World Hub,
-- /vip is a 404 and /cashier belongs to nothing at all.
--
-- So the destination is a property of WHERE the ad ran, not only of the
-- campaign. ad_catalog.target_url stays the campaign default; a placement may
-- override it for its own surface. This is also the shape a real advertiser
-- expects -- one campaign, a different landing page per placement -- so nothing
-- has to be rebuilt when one arrives.
--
-- The alternative was to let the Hub client prefix CA-relative paths itself.
-- That is the client inventing routing the server never agreed to, and it is
-- precisely the split-brain that fn_resolve_ads exists to prevent. Targeting
-- and destination both stay server-side.
--
-- SAFETY
-- Additive and reversible. The column is nullable; every existing lobby_strip
-- placement leaves it NULL and COALESCE makes those rows behave identically to
-- before. The function's return signature is unchanged -- same eight columns,
-- same types -- so the Club Arena client is unaffected and needs no redeploy.
--
-- VIP suppression is deliberately still absent (Dan 2026-08-27: "even vips will
-- see ads remove that for now"). Do not add it here in either direction.
--
-- ROLLBACK
--   1. Re-create fn_resolve_ads with c.target_url in place of the COALESCE.
--   2. delete from public.ad_placement where slot = 'hub_promotions';
--   3. alter table public.ad_placement drop column target_url;

-- 1. Per-placement destination override
alter table public.ad_placement
  add column if not exists target_url text;

comment on column public.ad_placement.target_url is
  'Per-placement destination override. NULL means fall back to ad_catalog.target_url. '
  'Exists because one campaign lands on a different route depending on which app '
  'the placement runs in: Club Arena SPA paths 404 from the World Hub.';

-- 2. Resolver honours the override.
-- Body is otherwise identical to Phase 1. Only the target_url expression moves.
create or replace function public.fn_resolve_ads(
  p_slot text,
  p_club_id uuid default null::uuid,
  p_limit integer default 3
)
returns table(
  ad_id uuid, ad_key text, category text, headline text,
  body text, glyph text, target_url text, cta_label text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_user uuid := auth.uid();
  v_vip  boolean := false;
BEGIN
  IF v_user IS NOT NULL THEN
    SELECT COALESCE(p.is_vip, false) INTO v_vip FROM public.profiles p WHERE p.id = v_user;
  END IF;

  RETURN QUERY
  SELECT c.id, c.ad_key, c.category, c.headline, c.body, c.glyph,
         -- The placement decides where its own surface should land; the
         -- campaign default applies when it has no opinion.
         COALESCE(pl.target_url, c.target_url) AS target_url,
         c.cta_label
    FROM public.ad_catalog c
    JOIN public.ad_placement pl ON pl.ad_id = c.id
   WHERE c.is_active
     AND pl.is_active
     AND pl.slot = p_slot
     AND (c.starts_at IS NULL OR c.starts_at <= now())
     AND (c.ends_at   IS NULL OR c.ends_at   >  now())
     AND (pl.club_id IS NULL OR pl.club_id = p_club_id)
     -- Audience. A signed-out viewer only ever matches 'all'/NULL.
     AND (
           pl.audience IS NULL
        OR pl.audience = 'all'
        OR (pl.audience = 'vip'      AND v_vip)
        OR (pl.audience = 'non_vip'  AND v_user IS NOT NULL AND NOT v_vip)
        OR (pl.audience = 'new_player' AND v_user IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.profiles p
               WHERE p.id = v_user AND p.created_at > now() - interval '7 days'))
        OR (pl.audience = 'returning'  AND v_user IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.profiles p
               WHERE p.id = v_user AND p.created_at <= now() - interval '7 days'))
     )
     -- Frequency cap: never show one player the same thing all day.
     AND (
           pl.daily_cap IS NULL
        OR v_user IS NULL
        OR (SELECT count(*) FROM public.ad_event e
             WHERE e.user_id = v_user AND e.ad_id = c.id
               AND e.event_type = 'impression'
               AND e.created_at > now() - interval '24 hours') < pl.daily_cap
     )
   ORDER BY c.weight DESC, c.created_at DESC
   LIMIT GREATEST(0, LEAST(p_limit, 10));
END;
$function$;

-- 3. Place the existing catalog on the Hub.
-- Hub-correct destinations, verified against pages/ in Smarter-Poker-World-Hub
-- on 2026-08-28. Two campaigns have no Hub page of their own and correctly
-- point back into Club Arena, which the Hub serves at /hub/club-arena/.
--
--   vip_upsell        -> pages/hub/vip-membership.js
--   diamonds_store    -> pages/hub/diamond-store.js
--   tournaments_daily -> pages/hub/daily-tournaments.js
--   spins_jackpot     -> Club Arena lobby (no Hub equivalent)
--   bbj_running       -> Club Arena lobby (no Hub equivalent)
--   referral_invite   -> Club Arena /invite (the Hub has referral APIs but no page)
--
-- Caps are tighter than the lobby's. The Hub is a navigation surface a player
-- crosses repeatedly in one session; the lobby is a destination they sit in.
-- The same cap would mean a far higher real-world frequency here.
insert into public.ad_placement (ad_id, slot, audience, daily_cap, club_id, is_active, target_url)
select c.id, 'hub_promotions', v.audience, v.daily_cap, null, true, v.target_url
  from public.ad_catalog c
  join (values
      ('vip_upsell',        'non_vip', 2, '/hub/vip-membership'),
      ('spins_jackpot',     'all',     3, '/hub/club-arena/'),
      ('bbj_running',       'all',     3, '/hub/club-arena/'),
      ('diamonds_store',    'all',     2, '/hub/diamond-store'),
      ('referral_invite',   'all',     2, '/hub/club-arena/invite'),
      ('tournaments_daily', 'all',     3, '/hub/daily-tournaments')
  ) as v(ad_key, audience, daily_cap, target_url) on v.ad_key = c.ad_key
on conflict (ad_id, slot, club_id) do update
  set target_url = excluded.target_url,
      audience   = excluded.audience,
      daily_cap  = excluded.daily_cap,
      is_active  = excluded.is_active;

-- 4. Assertions -- abort rather than half-apply.
do $$
declare
  v_placements int;
  v_bad_urls   int;
  v_lobby      int;
begin
  select count(*) into v_placements
    from public.ad_placement where slot = 'hub_promotions' and is_active;
  if v_placements <> 6 then
    raise exception 'Expected 6 active hub_promotions placements, found %', v_placements;
  end if;

  -- Every Hub destination must be Hub-absolute. A CA-relative path here is the
  -- exact bug this migration exists to prevent, so it must not survive it.
  select count(*) into v_bad_urls
    from public.ad_placement
   where slot = 'hub_promotions'
     and (target_url is null or target_url not like '/hub/%');
  if v_bad_urls > 0 then
    raise exception '% hub_promotions placement(s) do not point at a /hub/ route', v_bad_urls;
  end if;

  -- Phase 1 must be untouched.
  select count(*) into v_lobby
    from public.ad_placement where slot = 'lobby_strip' and is_active;
  if v_lobby <> 6 then
    raise exception 'lobby_strip placements changed: expected 6, found %', v_lobby;
  end if;

  if exists (
    select 1 from public.ad_placement
     where slot = 'lobby_strip' and target_url is not null
  ) then
    raise exception 'lobby_strip placements must keep the campaign default destination';
  end if;
end $$;
