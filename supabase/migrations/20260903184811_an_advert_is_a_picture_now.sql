-- ═══════════════════════════════════════════════════════════════════════════════
--  AN ADVERT IS A PICTURE NOW
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-03: the lobby strip and the post-session modal each show THREE
-- ROTATING IMAGES, and only images. Text-and-glyph cards are retired on those
-- two surfaces.
--
-- Three things stood in the way, all fixed here in one transaction (one
-- PostgREST schema reload, not four - see CLAUDE.md, Production DDL policy):
--
--   1. ONE IMAGE PER AD CANNOT SERVE TWO SHAPES. The lobby strip is 6:1 and the
--      session summary is 3:1. `ad_catalog.image_url` is one column, so the
--      same picture would have to be cropped badly on one of them. The creative
--      now lives on the PLACEMENT (`ad_placement.image_url`), with the catalog
--      column as the fallback. Same same-origin CHECK as the catalog: an
--      external image hands every viewer's IP to whoever typed the URL.
--
--   2. THE RESOLVER DID NOT SAY WHICH PLACEMENT WON, OR WHO IS SPEAKING. It now
--      returns `placement_id` (so a click can be attributed to the surface's
--      own creative), `advertiser_kind` and `advertiser_name`. Today every
--      row is 'house' / 'smarter.poker'. When club owners and sponsors buy
--      space (next migration) the rotator labels their creatives without
--      another return-type change - which needs DROP + CREATE, which this
--      migration is doing for the last time.
--
--   3. "IMPRESSION" MEANT "RESOLVED", NOT "SEEN". Every surface logged the
--      impression the moment the resolver answered, whether or not the pixels
--      ever reached the viewport. A sponsor will not pay for that, and the
--      MRC will not call it an impression. `viewable` is a new event type:
--      at least half the creative in view for a full second. `impression`
--      keeps its old meaning (rendered) so the existing reports stay
--      comparable; the panel gains viewability as a second column.
--
-- Data changes at the bottom seat the first six image creatives and switch
-- the two image-only surfaces to exactly three active placements each.
--
-- ROLLBACK: drop the two columns, restore the previous CHECK on ad_event,
-- and re-apply 20260828081427_the_resolver_hands_back_the_image_too.sql.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- 1. THE CREATIVE MOVES TO THE PLACEMENT ────────────────────────────────────────
alter table public.ad_placement
  add column if not exists image_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ad_placement_image_is_same_origin') then
    alter table public.ad_placement
      add constraint ad_placement_image_is_same_origin
      check (image_url is null or (image_url like '/%' and image_url not like '//%'));
  end if;
end $$;

comment on column public.ad_placement.image_url is
  'Per-surface creative (same-origin path). Falls back to ad_catalog.image_url. lobby_strip is 6:1 (1200x200), session_summary is 3:1 (900x300); see docs/ads/AD-SURFACES-AND-CREATIVE-SIZES.md.';

-- 2. A SEEN AD IS A DIFFERENT EVENT FROM A RENDERED ONE ─────────────────────────
alter table public.ad_event drop constraint if exists ad_event_event_type_check;
alter table public.ad_event
  add constraint ad_event_event_type_check
  check (event_type in ('impression', 'viewable', 'click', 'dismiss'));

-- 3. THE RESOLVER, LAST RETURN-TYPE CHANGE ──────────────────────────────────────
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
  placement_id uuid, advertiser_kind text, advertiser_name text
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
           c.weight,
           c.created_at
      FROM public.ad_catalog c
      JOIN public.ad_placement pl ON pl.ad_id = c.id
     WHERE c.is_active
       AND pl.is_active
       AND pl.slot = p_slot
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
         r.placement_id,
         'house'::text        AS advertiser_kind,
         'smarter.poker'::text AS advertiser_name
    FROM resolved r
   WHERE r.target_url IS NULL OR r.target_url NOT LIKE '%{%'
   ORDER BY random() ^ (1.0 / GREATEST(r.weight, 1)) DESC
   LIMIT GREATEST(0, LEAST(p_limit, 10));
END;
$function$;

grant execute on function public.fn_resolve_ads(text, uuid, integer) to anon, authenticated, service_role;

-- 4. THE FIRST SIX CREATIVES, AND THREE ACTIVE PLACEMENTS PER IMAGE SURFACE ─────
-- Paths are same-origin: Club Arena's bundle is served under /hub/club-arena/
-- on smarter.poker, so the Hub can load them too.

update public.ad_placement pl
   set image_url = '/hub/club-arena/assets/ads/' || replace(c.ad_key, '_', '-') || '-lobby-strip-v1.webp',
       daily_cap = null
  from public.ad_catalog c
 where c.id = pl.ad_id
   and pl.slot = 'lobby_strip'
   and c.ad_key in ('spins_jackpot', 'bbj_running', 'vip_upsell');

-- Spins and the jackpot were never placed on the session summary because
-- their destinations carry {clubId} and that host had no club in hand. It
-- does now (useUserStore.currentClubId), so they are placed here with the
-- club template intact.
insert into public.ad_placement (ad_id, slot, club_id, audience, daily_cap, is_active, image_url)
select c.id, 'session_summary', null, 'all', null, true,
       '/hub/club-arena/assets/ads/' || replace(c.ad_key, '_', '-') || '-session-summary-v1.webp'
  from public.ad_catalog c
 where c.ad_key in ('spins_jackpot', 'bbj_running')
on conflict (ad_id, slot, club_id) do update
   set image_url = excluded.image_url, is_active = true, daily_cap = null;

update public.ad_placement pl
   set image_url = '/hub/club-arena/assets/ads/vip-upsell-session-summary-v1.webp',
       daily_cap = null
  from public.ad_catalog c
 where c.id = pl.ad_id and pl.slot = 'session_summary' and c.ad_key = 'vip_upsell';

-- The two image-only surfaces rotate exactly three. Text-only placements are
-- paused, not deleted: they come back the day they have a picture.
update public.ad_placement pl
   set is_active = false
  from public.ad_catalog c
 where c.id = pl.ad_id
   and pl.slot in ('lobby_strip', 'session_summary')
   and pl.image_url is null;

-- 5. ASSERTIONS ────────────────────────────────────────────────────────────────
do $$
declare
  v_def  text;
  v_vol  char;
  v_acl  text;
  v_n    int;
  v_club uuid;
begin
  select pg_get_functiondef(oid), provolatile, array_to_string(proacl, ' | ')
    into v_def, v_vol, v_acl
    from pg_proc where proname = 'fn_resolve_ads';

  if v_def not like '%COALESCE(pl.image_url, c.image_url)%' then
    raise exception 'the resolver does not prefer the placement creative';
  end if;
  if v_def not like '%placement_id%' or v_def not like '%advertiser_kind%' then
    raise exception 'the resolver lost placement_id / advertiser_kind';
  end if;
  if v_def not like '%e.slot = pl.slot%' then
    raise exception 'the per-surface frequency cap was lost in this rewrite';
  end if;
  if v_def not like '%{clubId}%' then
    raise exception 'the club placeholder substitution was lost in this rewrite';
  end if;
  if v_def not like '%NOT LIKE ''%{%''%' then
    raise exception 'the unresolved-placeholder guard was lost in this rewrite';
  end if;
  if v_def not like '%random()%' then
    raise exception 'the weighted draw was lost in this rewrite';
  end if;
  if v_def like '%NOT v_vip%AND NOT v_vip%' then
    raise exception 'VIP suppression appeared in the resolver';
  end if;
  if v_vol <> 'v' then
    raise exception 'the resolver is marked % again; random() would be evaluated once', v_vol;
  end if;
  if v_acl not like '%anon=X%' or v_acl not like '%authenticated=X%' then
    raise exception 'the resolver lost its grants: %', v_acl;
  end if;

  -- The event CHECK admits viewable and still refuses nonsense.
  begin
    insert into public.ad_event (ad_id, user_id, slot, event_type)
    values (gen_random_uuid(), gen_random_uuid(), 'lobby_strip', 'stared_at');
    raise exception 'ad_event accepted an unknown event type';
  exception
    when check_violation then null;
    when foreign_key_violation then raise exception 'the CHECK on event_type ran after the FK; it should have refused first';
  end;

  -- An external creative is refused on the placement, exactly as on the catalog.
  begin
    update public.ad_placement set image_url = 'https://evil.example/x.webp'
     where id = (select id from public.ad_placement limit 1);
    raise exception 'ad_placement accepted an external image';
  exception
    when check_violation then null;
  end;

  -- Exactly three active placements per image surface, every one with a picture.
  select count(*) into v_n from public.ad_placement where slot = 'lobby_strip' and is_active;
  if v_n <> 3 then raise exception 'lobby_strip has % active placements, expected 3', v_n; end if;
  select count(*) into v_n from public.ad_placement where slot = 'session_summary' and is_active;
  if v_n <> 3 then raise exception 'session_summary has % active placements, expected 3', v_n; end if;
  select count(*) into v_n from public.ad_placement
   where slot in ('lobby_strip', 'session_summary') and is_active and image_url is null;
  if v_n <> 0 then raise exception '% active image-surface placements carry no image', v_n; end if;

  -- And the resolver actually hands the picture back.
  select id into v_club from public.clubs order by created_at limit 1;
  select count(*) into v_n from public.fn_resolve_ads('lobby_strip', v_club, 10) r
   where r.image_url like '/hub/club-arena/assets/ads/%';
  if v_n = 0 then raise exception 'the resolver returned no image creative for the lobby'; end if;
end $$;

commit;
