-- ═══════════════════════════════════════════════════════════════════════════════
--  AN ADVERT IS A PICTURE EVERYWHERE, AND A TAP OPENS IT FULL SCREEN
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-13: "MAKE THE STANDARD FOR ADS EVERYWHERE INSIDE OF SMARTER.POKER
-- TO BE RESPONSIVE FLUID IMAGES ONLY! AND ANY TIME THEY ARE CLICKED THEY SHOULD
-- BE OPEN AND DIRECTED TO WHATEVER THE AD IS DISPLAYING AS A FULL SCREEN POP UP."
--
-- Two standards. Both are enforced HERE, at the source, not in a component:
-- a renderer can be replaced, forgotten, or mounted on a new surface by
-- somebody who never read the rule. The resolver cannot be bypassed.
--
-- 1. ONLY A PICTURE IS EVER SERVED. `fn_resolve_ads` now refuses any
--    placement that has no creative. Until today two surfaces - `empty_state`
--    in Club Arena and `hub_promotions` on the Hub - rendered text with a
--    thumbnail, and three of the six house campaigns had no picture at all.
--    All six now carry a creative for every one of the four shapes, and a
--    placement without one is not inventory anywhere. A text card in an ad
--    slot is the thing this retires.
--
-- 2. EVERY ADVERT HAS A POSTER FOR THE POPUP. A 6:1 strip is a thin band on
--    a phone; opening it full screen as-is would be a stripe across the
--    middle of a black screen. So the catalog gains `poster_url` - a 3:4
--    creative made for the full-screen popup - and the resolver hands it back
--    beside the surface creative, falling back to the surface creative when
--    a campaign has no poster. This is a RETURN-TYPE change, DROP + CREATE.
--    The 09-03 migration called its change the last one; the standard moved,
--    and a contract that has to change should change rather than be worked
--    around with a second query on every tap.
--
-- The same-origin CHECK on the poster is the same CHECK the other two image
-- columns carry. The popup renders it fluid and contained, exactly as every
-- surface does: width 100%, aspect-ratio locked, object-fit contain.
--
-- ROLLBACK: drop ad_catalog.poster_url and ad_campaign.poster_url, and
-- re-apply the resolver from 20260909071146.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- 1. THE POSTER ───────────────────────────────────────────────────────────────
alter table public.ad_catalog  add column if not exists poster_url text;
alter table public.ad_campaign add column if not exists poster_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ad_catalog_poster_is_same_origin') then
    alter table public.ad_catalog add constraint ad_catalog_poster_is_same_origin
      check (poster_url is null or (poster_url like '/%' and poster_url not like '//%'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ad_campaign_poster_is_same_origin') then
    alter table public.ad_campaign add constraint ad_campaign_poster_is_same_origin
      check (poster_url is null or (poster_url like '/%' and poster_url not like '//%'));
  end if;
end $$;

comment on column public.ad_catalog.poster_url is
  'The 3:4 creative the full-screen popup shows when the advert is tapped (1080x1440). Same-origin path. Falls back to the surface creative.';

-- 2. SIX CAMPAIGNS, FOUR SHAPES EACH ───────────────────────────────────────────
-- Posters on the catalog; per-surface creatives on every placement.
update public.ad_catalog c
   set poster_url = '/hub/club-arena/assets/ads/' || replace(c.ad_key, '_', '-') || '-poster-v1.webp'
 where c.ad_key in ('spins_jackpot', 'bbj_running', 'vip_upsell', 'diamonds_store', 'referral_invite', 'tournaments_daily');

-- lobby_strip and session_summary: every campaign gets its creative, but the
-- three Dan asked for "for now" stay the three that are ACTIVE. The others are
-- ready the moment they are switched on, and never serve as text again.
update public.ad_placement pl
   set image_url = '/hub/club-arena/assets/ads/' || replace(c.ad_key, '_', '-') || '-lobby-strip-v1.webp'
  from public.ad_catalog c
 where c.id = pl.ad_id and pl.slot = 'lobby_strip' and pl.image_url is null;

update public.ad_placement pl
   set image_url = '/hub/club-arena/assets/ads/' || replace(c.ad_key, '_', '-') || '-session-summary-v1.webp'
  from public.ad_catalog c
 where c.id = pl.ad_id and pl.slot = 'session_summary' and pl.image_url is null;

-- empty_state: the 3:4 poster IS the surface creative (the docs proposed
-- exactly this shape for the surface on 2026-08-29).
update public.ad_placement pl
   set image_url = '/hub/club-arena/assets/ads/' || replace(c.ad_key, '_', '-') || '-poster-v1.webp'
  from public.ad_catalog c
 where c.id = pl.ad_id and pl.slot = 'empty_state';

-- hub_promotions: 16:9 cards.
update public.ad_placement pl
   set image_url = '/hub/club-arena/assets/ads/' || replace(c.ad_key, '_', '-') || '-hub-promotions-v1.webp'
  from public.ad_catalog c
 where c.id = pl.ad_id and pl.slot = 'hub_promotions';

-- Campaigns placed on the other two surfaces that had no picture were still
-- ACTIVE there, serving text. They now have one and stay active. Nothing on
-- lobby_strip / session_summary changes state.

-- 3. THE RESOLVER: A PICTURE OR NOTHING, AND THE POSTER BESIDE IT ─────────────
drop function if exists public.fn_resolve_ads(text, uuid, integer);

create function public.fn_resolve_ads(
  p_slot text,
  p_club_id uuid default null::uuid,
  p_limit integer default 3
)
returns table(
  ad_id uuid, ad_key text, category text, headline text,
  body text, glyph text, target_url text, cta_label text,
  image_url text,
  placement_id uuid, advertiser_kind text, advertiser_name text,
  poster_url text
)
language plpgsql
volatile
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
  WITH resolved AS (
    SELECT c.id, c.ad_key, c.category, c.headline, c.body, c.glyph,
           replace(
             replace(
               COALESCE(pl.target_url, c.target_url),
               '{clubId}',  COALESCE(p_club_id::text, '{clubId}')
             ),
             '{club_id}', COALESCE(p_club_id::text, '{club_id}')
           ) AS target_url,
           c.cta_label,
           COALESCE(pl.image_url, c.image_url) AS image_url,
           pl.id AS placement_id,
           COALESCE(adv.kind, 'house')         AS advertiser_kind,
           COALESCE(adv.name, 'smarter.poker') AS advertiser_name,
           /* The popup's picture: the poster, or the surface creative when a
              campaign has none. Never null when image_url is not. */
           COALESCE(c.poster_url, pl.image_url, c.image_url) AS poster_url,
           c.priority,
           c.weight,
           CASE
             WHEN cam.id IS NULL OR cam.goal_impressions IS NULL OR cam.pacing <> 'even' THEN 0::numeric
             ELSE (
               cam.goal_impressions * LEAST(1.0, GREATEST(0.0,
                 extract(epoch from (now() - cam.starts_at))
                 / NULLIF(extract(epoch from (cam.ends_at - cam.starts_at)), 0)
               ))
               - COALESCE((SELECT count(*) FROM public.ad_event e2
                            WHERE e2.ad_id = c.id AND e2.event_type = 'impression'), 0)
             )::numeric
           END AS pace_debt,
           c.created_at
      FROM public.ad_catalog c
      JOIN public.ad_placement pl ON pl.ad_id = c.id
      LEFT JOIN public.ad_advertiser adv ON adv.id = c.advertiser_id
      LEFT JOIN public.ad_campaign  cam ON cam.id = c.campaign_id
     WHERE c.is_active
       AND pl.is_active
       AND pl.slot = p_slot
       /* THE STANDARD. An advert with no picture is not inventory on any
          surface. This is the line that retires text cards everywhere. */
       AND COALESCE(pl.image_url, c.image_url) IS NOT NULL
       AND (adv.id IS NULL OR adv.status = 'active')
       AND (c.starts_at IS NULL OR c.starts_at <= now())
       AND (c.ends_at   IS NULL OR c.ends_at   >  now())
       AND (pl.club_id IS NULL OR pl.club_id = p_club_id)
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
       AND (
             pl.daily_cap IS NULL
          OR v_user IS NULL
          OR (SELECT count(*) FROM public.ad_event e
               WHERE e.user_id = v_user AND e.ad_id = c.id
                 AND e.slot = pl.slot
                 AND e.event_type = 'impression'
                 AND e.created_at > now() - interval '24 hours') < pl.daily_cap
       )
  )
  SELECT r.id, r.ad_key, r.category, r.headline, r.body, r.glyph,
         r.target_url, r.cta_label, r.image_url,
         r.placement_id, r.advertiser_kind, r.advertiser_name,
         r.poster_url
    FROM resolved r
   WHERE r.target_url IS NULL OR r.target_url NOT LIKE '%{%'
   ORDER BY r.priority DESC, r.pace_debt DESC, random() ^ (1.0 / GREATEST(r.weight, 1)) DESC
   LIMIT GREATEST(0, LEAST(p_limit, 10));
END;
$function$;

grant execute on function public.fn_resolve_ads(text, uuid, integer) to anon, authenticated, service_role;

-- 4. A CAMPAIGN'S POSTER TRAVELS TO THE CATALOG ON APPROVAL ────────────────────
-- Same function as 20260909071146 with one line added: poster_url is copied
-- when the campaign becomes inventory. Everything else is byte-for-byte.
create or replace function public.fn_ad_campaign_review(
  p_campaign_id uuid,
  p_decision    text,
  p_note        text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_user uuid := auth.uid();
  v_c    public.ad_campaign%rowtype;
  v_ad   uuid;
  v_ref  jsonb;
  v_code text;
  v_target text;
BEGIN
  IF NOT (COALESCE(auth.role(), '') = 'service_role' OR public.fn_is_platform_admin()) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_platform_admin');
  END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_decision');
  END IF;

  SELECT * INTO v_c FROM public.ad_campaign WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_c.status <> 'submitted' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_reviewed', 'status', v_c.status);
  END IF;

  IF p_decision = 'reject' THEN
    IF v_c.diamonds_charged > 0 AND v_c.submitted_by IS NOT NULL THEN
      v_ref := public.add_diamonds_to_balance(
        v_c.submitted_by, v_c.diamonds_charged, 'refund',
        'Club advert not approved: ' || v_c.name,
        'adcamp-refund:' || v_c.id::text
      );
      IF COALESCE((v_ref->>'success')::boolean, false) IS NOT TRUE
         AND COALESCE((v_ref->>'duplicate')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'refund failed: %', v_ref->>'error';
      END IF;
    END IF;
    UPDATE public.ad_campaign
       SET status = 'rejected', diamonds_refunded = diamonds_charged,
           reviewed_by = v_user, reviewed_at = now(), review_note = p_note, updated_at = now()
     WHERE id = p_campaign_id;
    RETURN jsonb_build_object('ok', true, 'status', 'rejected', 'diamonds_refunded', v_c.diamonds_charged);
  END IF;

  IF v_c.external_url IS NOT NULL THEN
    v_code := COALESCE(v_c.click_code, substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
    v_target := '/c/' || v_code;
    UPDATE public.ad_campaign SET click_code = v_code WHERE id = p_campaign_id;
  ELSE
    v_code := NULL;
    v_target := v_c.target_url;
  END IF;

  INSERT INTO public.ad_catalog
    (ad_key, category, headline, body, glyph, target_url, cta_label, is_active,
     starts_at, ends_at, weight, created_by, image_url, advertiser_id, campaign_id, priority,
     poster_url)
  VALUES
    ('camp_' || replace(v_c.id::text, '-', ''),
     CASE WHEN v_c.club_id IS NULL THEN 'other' ELSE 'club' END,
     v_c.headline, NULL, NULL,
     v_target, NULL, true,
     v_c.starts_at, v_c.ends_at, 100, v_user, v_c.image_url, v_c.advertiser_id, v_c.id, v_c.priority,
     v_c.poster_url)
  RETURNING id INTO v_ad;

  INSERT INTO public.ad_placement (ad_id, slot, club_id, audience, daily_cap, is_active, image_url)
  VALUES (v_ad, v_c.slot,
          CASE WHEN v_c.scope = 'own_club' THEN v_c.club_id ELSE NULL END,
          'all', NULL, true, v_c.image_url);

  UPDATE public.ad_campaign
     SET status = 'approved', ad_id = v_ad,
         reviewed_by = v_user, reviewed_at = now(), review_note = p_note, updated_at = now()
   WHERE id = p_campaign_id;

  RETURN jsonb_build_object('ok', true, 'status', 'approved', 'ad_id', v_ad, 'click_code', v_code);
END;
$function$;

revoke all on function public.fn_ad_campaign_review(uuid, text, text) from public, anon;
grant execute on function public.fn_ad_campaign_review(uuid, text, text) to authenticated, service_role;

-- 5. ASSERTIONS ────────────────────────────────────────────────────────────────
do $$
declare
  v_def text; v_vol char; v_acl text; v_n int; v_club uuid;
begin
  select pg_get_functiondef(oid), provolatile, array_to_string(proacl, ' | ')
    into v_def, v_vol, v_acl from pg_proc where proname = 'fn_resolve_ads';

  -- Every rule every earlier migration asserted, re-asserted across the rewrite.
  if v_def not like '%COALESCE(pl.image_url, c.image_url) IS NOT NULL%' then raise exception 'the picture standard is not enforced in the resolver'; end if;
  if v_def not like '%poster_url%' then raise exception 'the resolver does not return the poster'; end if;
  if v_def not like '%placement_id%' or v_def not like '%advertiser_kind%' then raise exception 'placement_id / advertiser_kind lost'; end if;
  if v_def not like '%e.slot = pl.slot%' then raise exception 'per-surface cap lost'; end if;
  if v_def not like '%{clubId}%' then raise exception 'club placeholder substitution lost'; end if;
  if v_def not like '%NOT LIKE ''%{%''%' then raise exception 'unresolved-placeholder guard lost'; end if;
  if v_def not like '%random()%' then raise exception 'weighted draw lost'; end if;
  if v_def not like '%r.priority DESC, r.pace_debt DESC%' then raise exception 'priority / pacing order lost'; end if;
  if v_def like '%NOT v_vip%AND NOT v_vip%' then raise exception 'VIP suppression appeared'; end if;
  if v_vol <> 'v' then raise exception 'resolver marked % again', v_vol; end if;
  if v_acl not like '%anon=X%' or v_acl not like '%authenticated=X%' then raise exception 'resolver lost its grants: %', v_acl; end if;

  -- Every active placement on every surface now has a picture. None serve text.
  select count(*) into v_n from public.ad_placement pl join public.ad_catalog c on c.id = pl.ad_id
   where pl.is_active and coalesce(pl.image_url, c.image_url) is null;
  if v_n <> 0 then raise exception '% active placements still have no picture', v_n; end if;

  -- Every house campaign has a poster for the popup.
  select count(*) into v_n from public.ad_catalog where advertiser_id is null and poster_url is null;
  if v_n <> 0 then raise exception '% house campaigns have no poster', v_n; end if;

  -- The two surfaces Dan named still rotate exactly three.
  select count(*) into v_n from public.ad_placement where slot = 'lobby_strip' and is_active;
  if v_n <> 3 then raise exception 'lobby_strip has % active, expected 3', v_n; end if;
  select count(*) into v_n from public.ad_placement where slot = 'session_summary' and is_active;
  if v_n <> 3 then raise exception 'session_summary has % active, expected 3', v_n; end if;

  -- An external poster is refused.
  begin
    update public.ad_catalog set poster_url = 'https://evil.example/p.webp' where id = (select id from public.ad_catalog limit 1);
    raise exception 'ad_catalog accepted an external poster';
  exception when check_violation then null;
  end;

  -- The resolver hands back a poster with every row, on every surface.
  select id into v_club from public.clubs order by created_at limit 1;
  select count(*) into v_n from public.fn_resolve_ads('hub_promotions', v_club, 10) r where r.poster_url is null or r.image_url is null;
  if v_n <> 0 then raise exception 'hub_promotions returned % rows without a picture or poster', v_n; end if;
  select count(*) into v_n from public.fn_resolve_ads('empty_state', v_club, 10) r where r.poster_url is null or r.image_url is null;
  if v_n <> 0 then raise exception 'empty_state returned % rows without a picture or poster', v_n; end if;
  select count(*) into v_n from public.fn_resolve_ads('hub_promotions', v_club, 10);
  if v_n = 0 then raise exception 'hub_promotions serves nothing'; end if;
end $$;

commit;
