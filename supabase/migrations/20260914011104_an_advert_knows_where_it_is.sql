-- 20260914011104_an_advert_knows_where_it_is.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- AN ADVERT KNOWS WHERE IT IS
--
-- An outside sponsor sends players to its own site, and some sponsors may
-- only serve some places. Until now a sponsor flight ran everywhere and the
-- only gate was a person's judgement at approval. This gives the flight a
-- country list and the resolver a country to check it against.
--
-- 1. THE LIST. ad_campaign.countries text[]: ISO 3166-1 alpha-2, upper case,
--    null means everywhere (every club flight and every existing flight).
--    fn_ad_countries_clean(text[]) trims, upper-cases, de-duplicates and
--    returns null for an empty list; anything that is not two letters makes
--    the whole list invalid and the submit refuses with bad_countries rather
--    than quietly dropping the bad entry (a sponsor who typed "USA" meant
--    something, and silently serving everywhere is the opposite of it).
--
-- 2. THE CHECK. fn_resolve_ads gains p_country. A gated flight is served only
--    to a player whose country is known AND in the list. Unknown is not in
--    any list: a flight that must not run in some place is not run for a
--    player we cannot place. House and club flights (no campaign, or a null
--    list) are untouched, so a missing country changes nothing for them.
--    The old three-argument signature is dropped, not overloaded: PostgREST
--    cannot choose between two functions that differ only in defaults.
--
-- 3. WHERE THE COUNTRY COMES FROM. The World Hub's edge (Vercel) stamps
--    x-vercel-ip-country on every request, and both the Hub and Club Arena
--    are served from smarter.poker, so a same-origin GET /api/geo returns it.
--    The clients fetch it once and pass it here. It is a hint from the edge,
--    not a credential: a player who lies about where they are sees an advert
--    they were not meant to; nothing on this platform is unlocked by it.
--
-- 4. THE SUBMITS. fn_sponsor_ad_submit and fn_sponsor_campaign_create take
--    p_countries; old signatures dropped so each keeps one overload. Both
--    lists return countries.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- 1. THE LIST
alter table public.ad_campaign
  add column if not exists countries text[];

comment on column public.ad_campaign.countries is
  'Where this flight may run: ISO 3166-1 alpha-2 codes, upper case. NULL means everywhere. A player whose country is unknown is never inside a list.';

create or replace function public.fn_ad_countries_clean(p_countries text[])
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
           when p_countries is null or cardinality(p_countries) = 0 then null
           when exists (select 1 from unnest(p_countries) x where btrim(x) !~ '^[A-Za-z]{2}$') then null
           else (select array_agg(distinct upper(btrim(x)) order by upper(btrim(x))) from unnest(p_countries) x)
         end;
$$;

alter table public.ad_campaign
  drop constraint if exists ad_campaign_countries_are_alpha2;
alter table public.ad_campaign
  add constraint ad_campaign_countries_are_alpha2
  check (countries is null or (cardinality(countries) > 0 and countries = public.fn_ad_countries_clean(countries)));

-- 2. THE CHECK
drop function if exists public.fn_resolve_ads(text, uuid, integer);
create function public.fn_resolve_ads(
  p_slot text,
  p_club_id uuid default null,
  p_limit integer default 3,
  p_country text default null
)
returns table (
  ad_id uuid, ad_key text, category text, headline text, body text, glyph text,
  target_url text, cta_label text, image_url text, placement_id uuid,
  advertiser_kind text, advertiser_name text, poster_url text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_vip     boolean := false;
  v_country text := case when p_country ~ '^[A-Za-z]{2}$' then upper(p_country) else null end;
begin
  if v_user is not null then
    select coalesce(p.is_vip, false) into v_vip from public.profiles p where p.id = v_user;
  end if;
  return query
  with resolved as (
    select c.id, c.ad_key, c.category, c.headline, c.body, c.glyph,
           replace(
             replace(
               coalesce(pl.target_url, c.target_url),
               '{clubId}',  coalesce(p_club_id::text, '{clubId}')
             ),
             '{club_id}', coalesce(p_club_id::text, '{club_id}')
           ) as target_url,
           c.cta_label,
           coalesce(pl.image_url, c.image_url) as image_url,
           pl.id as placement_id,
           coalesce(adv.kind, 'house')         as advertiser_kind,
           coalesce(adv.name, 'smarter.poker') as advertiser_name,
           coalesce(c.poster_url, pl.image_url, c.image_url) as poster_url,
           c.priority,
           c.weight,
           case
             when cam.id is null or cam.goal_impressions is null or cam.pacing <> 'even' then 0::numeric
             else (
               cam.goal_impressions * least(1.0, greatest(0.0,
                 extract(epoch from (now() - cam.starts_at))
                 / nullif(extract(epoch from (cam.ends_at - cam.starts_at)), 0)
               ))
               - coalesce((select count(*) from public.ad_event e2
                            where e2.ad_id = c.id and e2.event_type = 'impression'), 0)
             )::numeric
           end as pace_debt,
           c.created_at
      from public.ad_catalog c
      join public.ad_placement pl on pl.ad_id = c.id
      left join public.ad_advertiser adv on adv.id = c.advertiser_id
      left join public.ad_campaign  cam on cam.id = c.campaign_id
     where c.is_active
       and pl.is_active
       and pl.slot = p_slot
       and coalesce(pl.image_url, c.image_url) is not null
       and (adv.id is null or adv.status = 'active')
       and (c.starts_at is null or c.starts_at <= now())
       and (c.ends_at   is null or c.ends_at   >  now())
       and (pl.club_id is null or pl.club_id = p_club_id)
       -- A gated flight is shown only to a player known to be inside its
       -- list. Unknown location is not inside any list.
       and (cam.id is null or cam.countries is null
            or (v_country is not null and v_country = any(cam.countries)))
       and (
             pl.audience is null
          or pl.audience = 'all'
          or (pl.audience = 'vip'      and v_vip)
          or (pl.audience = 'non_vip'  and v_user is not null and not v_vip)
          or (pl.audience = 'new_player' and v_user is not null and exists (
                select 1 from public.profiles p
                 where p.id = v_user and p.created_at > now() - interval '7 days'))
          or (pl.audience = 'returning'  and v_user is not null and exists (
                select 1 from public.profiles p
                 where p.id = v_user and p.created_at <= now() - interval '7 days'))
       )
       and (
             pl.daily_cap is null
          or v_user is null
          or (select count(*) from public.ad_event e
               where e.user_id = v_user and e.ad_id = c.id
                 and e.slot = pl.slot
                 and e.event_type = 'impression'
                 and e.created_at > now() - interval '24 hours') < pl.daily_cap
       )
  )
  select r.id, r.ad_key, r.category, r.headline, r.body, r.glyph,
         r.target_url, r.cta_label, r.image_url,
         r.placement_id, r.advertiser_kind, r.advertiser_name,
         r.poster_url
    from resolved r
   where r.target_url is null or r.target_url not like '%{%'
   order by r.priority desc, r.pace_debt desc, random() ^ (1.0 / greatest(r.weight, 1)) desc
   limit greatest(0, least(p_limit, 10));
end;
$$;

revoke all on function public.fn_resolve_ads(text, uuid, integer, text) from public;
grant execute on function public.fn_resolve_ads(text, uuid, integer, text) to anon, authenticated, service_role;

-- 4. THE SUBMITS
drop function if exists public.fn_sponsor_ad_submit(text, text, text, text, text, timestamptz, integer, integer, text);
create function public.fn_sponsor_ad_submit(
  p_slot text,
  p_headline text,
  p_image_url text,
  p_poster_url text,
  p_external_url text,
  p_starts_at timestamptz,
  p_days integer,
  p_goal_impressions integer default null,
  p_pacing text default 'even',
  p_countries text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user  uuid := auth.uid();
  v_adv   public.ad_advertiser%rowtype;
  v_rate  public.ad_rate_card%rowtype;
  v_id    uuid := gen_random_uuid();
  v_start timestamptz;
  v_end   timestamptz;
  v_folder text;
  v_quote integer;
  v_countries text[];
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;
  select * into v_adv from public.ad_advertiser
   where kind = 'sponsor' and self_serve and owner_user_id = v_user;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_advertiser');
  end if;
  if v_adv.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'advertiser_suspended');
  end if;
  if p_headline is null or length(btrim(p_headline)) not between 1 and 120 then
    return jsonb_build_object('ok', false, 'reason', 'bad_headline');
  end if;
  /* Any priced surface except the one nothing renders yet: an approved flight
     on table_between_hands would be invoiced for a picture nobody sees. */
  select * into v_rate from public.ad_rate_card where slot = p_slot;
  if not found or p_slot = 'table_between_hands' then
    return jsonb_build_object('ok', false, 'reason', 'unknown_slot');
  end if;
  if v_rate.sponsor_cents_per_day <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'surface_not_for_sale');
  end if;
  if p_days is null or p_days < 1 or p_days > 365 then
    return jsonb_build_object('ok', false, 'reason', 'bad_days');
  end if;
  v_folder := '/ad-creatives/sponsor/' || v_adv.id::text || '/';
  if p_image_url is null or p_image_url not like (v_folder || '%') then
    return jsonb_build_object('ok', false, 'reason', 'creative_not_in_your_folder');
  end if;
  if p_poster_url is null or p_poster_url not like (v_folder || '%') then
    return jsonb_build_object('ok', false, 'reason', 'poster_not_in_your_folder');
  end if;
  if p_external_url is null or p_external_url !~ '^https://[a-zA-Z0-9]'
     or length(p_external_url) not between 12 and 500
     or position(' ' in p_external_url) > 0
     or position(E'\n' in p_external_url) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'destination_must_be_https');
  end if;
  if p_goal_impressions is not null and p_goal_impressions <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'bad_goal');
  end if;
  if p_pacing not in ('even', 'asap') then
    return jsonb_build_object('ok', false, 'reason', 'bad_pacing');
  end if;
  v_countries := public.fn_ad_countries_clean(p_countries);
  if v_countries is null and p_countries is not null and cardinality(p_countries) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'bad_countries');
  end if;
  v_start := greatest(coalesce(p_starts_at, now()), now() - interval '10 minutes');
  v_end   := v_start + make_interval(days => p_days);
  v_quote := v_rate.sponsor_cents_per_day * p_days;
  insert into public.ad_campaign
    (id, advertiser_id, club_id, name, slot, status, scope, priority,
     starts_at, ends_at, days, image_url, poster_url, target_url, headline,
     diamonds_charged, submitted_by, external_url, pacing, goal_impressions, quoted_cents, countries)
  values
    (v_id, v_adv.id, null, left(v_adv.name, 80), p_slot, 'submitted', 'platform', 90,
     v_start, v_end, p_days, p_image_url, p_poster_url, '/', btrim(p_headline),
     0, v_user, p_external_url, p_pacing, p_goal_impressions, v_quote, v_countries);
  return jsonb_build_object('ok', true, 'campaign_id', v_id, 'advertiser_id', v_adv.id,
                            'starts_at', v_start, 'ends_at', v_end, 'quoted_cents', v_quote,
                            'countries', v_countries);
end;
$$;

revoke all on function public.fn_sponsor_ad_submit(text, text, text, text, text, timestamptz, integer, integer, text, text[]) from public, anon;
grant execute on function public.fn_sponsor_ad_submit(text, text, text, text, text, timestamptz, integer, integer, text, text[]) to authenticated, service_role;

drop function if exists public.fn_sponsor_campaign_create(text, text, text, text, text, timestamptz, integer, text, integer, text, text);
create function public.fn_sponsor_campaign_create(
  p_advertiser_name text,
  p_headline text,
  p_slot text,
  p_image_url text,
  p_external_url text,
  p_starts_at timestamptz,
  p_days integer,
  p_contact_email text default null,
  p_goal_impressions integer default null,
  p_pacing text default 'even',
  p_poster_url text default null,
  p_countries text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_adv  uuid;
  v_id   uuid := gen_random_uuid();
  v_end  timestamptz;
  v_start timestamptz;
  v_quote integer;
  v_countries text[];
begin
  if not (coalesce(auth.role(), '') = 'service_role' or public.fn_is_platform_admin()) then
    return jsonb_build_object('ok', false, 'reason', 'not_platform_admin');
  end if;
  if p_advertiser_name is null or length(btrim(p_advertiser_name)) not between 1 and 80 then
    return jsonb_build_object('ok', false, 'reason', 'bad_advertiser_name');
  end if;
  if p_headline is null or length(btrim(p_headline)) not between 1 and 120 then
    return jsonb_build_object('ok', false, 'reason', 'bad_headline');
  end if;
  select sponsor_cents_per_day into v_quote from public.ad_rate_card where slot = p_slot;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_slot');
  end if;
  if p_days is null or p_days < 1 or p_days > 365 then
    return jsonb_build_object('ok', false, 'reason', 'bad_days');
  end if;
  if p_image_url is null or p_image_url not like '/%' or p_image_url like '//%' then
    return jsonb_build_object('ok', false, 'reason', 'creative_not_same_origin');
  end if;
  if p_poster_url is not null and (p_poster_url not like '/%' or p_poster_url like '//%') then
    return jsonb_build_object('ok', false, 'reason', 'poster_not_same_origin');
  end if;
  if p_external_url is null or p_external_url !~ '^https://[a-zA-Z0-9]'
     or length(p_external_url) not between 12 and 500
     or position(' ' in p_external_url) > 0
     or position(E'\n' in p_external_url) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'destination_must_be_https');
  end if;
  if p_pacing not in ('even', 'asap') then
    return jsonb_build_object('ok', false, 'reason', 'bad_pacing');
  end if;
  v_countries := public.fn_ad_countries_clean(p_countries);
  if v_countries is null and p_countries is not null and cardinality(p_countries) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'bad_countries');
  end if;
  v_start := greatest(coalesce(p_starts_at, now()), now() - interval '10 minutes');
  v_end   := v_start + make_interval(days => p_days);
  v_quote := v_quote * p_days;
  insert into public.ad_advertiser (kind, name, club_id, owner_user_id, contact_email)
  values ('sponsor', left(btrim(p_advertiser_name), 80), null, v_user, p_contact_email)
  returning id into v_adv;
  insert into public.ad_campaign
    (id, advertiser_id, club_id, name, slot, status, scope, priority,
     starts_at, ends_at, days, image_url, poster_url, target_url, headline,
     diamonds_charged, submitted_by, external_url, pacing, goal_impressions, quoted_cents, countries)
  values
    (v_id, v_adv, null, left(btrim(p_advertiser_name), 80), p_slot, 'submitted', 'platform', 90,
     v_start, v_end, p_days, p_image_url, p_poster_url,
     '/', btrim(p_headline),
     0, v_user, p_external_url, p_pacing, p_goal_impressions, v_quote, v_countries);
  return jsonb_build_object('ok', true, 'campaign_id', v_id, 'advertiser_id', v_adv,
                            'starts_at', v_start, 'ends_at', v_end, 'quoted_cents', v_quote,
                            'countries', v_countries);
end;
$$;

revoke all on function public.fn_sponsor_campaign_create(text, text, text, text, text, timestamptz, integer, text, integer, text, text, text[]) from public, anon;
grant execute on function public.fn_sponsor_campaign_create(text, text, text, text, text, timestamptz, integer, text, integer, text, text, text[]) to authenticated, service_role;

drop function if exists public.fn_sponsor_campaign_list();
create function public.fn_sponsor_campaign_list()
returns table (
  id uuid, club_id uuid, club_name text, name text, slot text, status text,
  display_status text, scope text, starts_at timestamptz, ends_at timestamptz,
  days integer, image_url text, poster_url text, target_url text, external_url text,
  headline text, pacing text, goal_impressions integer,
  diamonds_charged integer, diamonds_refunded integer, submitted_by uuid,
  reviewed_at timestamptz, review_note text, created_at timestamptz,
  impressions bigint, viewable bigint, clicks bigint, viewers bigint,
  quoted_cents integer, invoiced_at timestamptz, paid_at timestamptz, countries text[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id, c.club_id, adv.name as club_name, c.name, c.slot, c.status,
         case
           when c.status <> 'approved' then c.status
           when now() < c.starts_at then 'scheduled'
           when now() >= c.ends_at  then 'finished'
           else 'live'
         end as display_status,
         c.scope, c.starts_at, c.ends_at, c.days,
         c.image_url, c.poster_url, c.target_url, c.external_url,
         c.headline, c.pacing, c.goal_impressions,
         c.diamonds_charged, c.diamonds_refunded,
         c.submitted_by, c.reviewed_at, c.review_note, c.created_at,
         coalesce(s.impressions, 0), coalesce(s.viewable, 0), coalesce(s.clicks, 0), coalesce(s.viewers, 0),
         c.quoted_cents, c.invoiced_at, c.paid_at, c.countries
    from public.ad_campaign c
    join public.ad_advertiser adv on adv.id = c.advertiser_id
    left join lateral (
      select count(*) filter (where e.event_type = 'impression') as impressions,
             count(*) filter (where e.event_type = 'viewable')   as viewable,
             count(*) filter (where e.event_type = 'click')      as clicks,
             count(distinct e.user_id) filter (where e.event_type = 'impression') as viewers
        from public.ad_event e
       where e.ad_id = c.ad_id
    ) s on true
   where adv.kind = 'sponsor' and adv.self_serve and adv.owner_user_id = auth.uid()
   order by c.created_at desc
   limit 200;
$$;

revoke all on function public.fn_sponsor_campaign_list() from public, anon;
grant execute on function public.fn_sponsor_campaign_list() to authenticated, service_role;

drop function if exists public.fn_ad_campaign_list(uuid);
create function public.fn_ad_campaign_list(p_club_id uuid default null)
returns table (
  id uuid, club_id uuid, club_name text, name text, slot text, status text,
  display_status text, scope text, starts_at timestamptz, ends_at timestamptz,
  days integer, image_url text, target_url text, headline text,
  diamonds_charged integer, diamonds_refunded integer, submitted_by uuid,
  reviewed_at timestamptz, review_note text, created_at timestamptz,
  impressions bigint, viewable bigint, clicks bigint, viewers bigint,
  quoted_cents integer, invoiced_at timestamptz, paid_at timestamptz, countries text[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id, c.club_id,
         coalesce(cl.name, adv.name) as club_name,
         c.name, c.slot, c.status,
         case
           when c.status <> 'approved' then c.status
           when now() < c.starts_at then 'scheduled'
           when now() >= c.ends_at  then 'finished'
           else 'live'
         end as display_status,
         c.scope, c.starts_at, c.ends_at, c.days,
         c.image_url, c.target_url, c.headline,
         c.diamonds_charged, c.diamonds_refunded,
         c.submitted_by, c.reviewed_at, c.review_note, c.created_at,
         coalesce(s.impressions, 0), coalesce(s.viewable, 0), coalesce(s.clicks, 0), coalesce(s.viewers, 0),
         c.quoted_cents, c.invoiced_at, c.paid_at, c.countries
    from public.ad_campaign c
    left join public.clubs cl on cl.id = c.club_id
    left join public.ad_advertiser adv on adv.id = c.advertiser_id
    left join lateral (
      select count(*) filter (where e.event_type = 'impression') as impressions,
             count(*) filter (where e.event_type = 'viewable')   as viewable,
             count(*) filter (where e.event_type = 'click')      as clicks,
             count(distinct e.user_id) filter (where e.event_type = 'impression') as viewers
        from public.ad_event e
       where e.ad_id = c.ad_id
    ) s on true
   where (
           (p_club_id is not null and c.club_id = p_club_id and public.fn_club_is_staff(p_club_id, auth.uid()))
        or (p_club_id is null and (coalesce(auth.role(), '') = 'service_role' or public.fn_is_platform_admin()))
         )
   order by c.created_at desc
   limit 200;
$$;

revoke all on function public.fn_ad_campaign_list(uuid) from public, anon;
grant execute on function public.fn_ad_campaign_list(uuid) to authenticated, service_role;

-- 5. PROVE IT
do $$
declare
  v_n int;
begin
  if public.fn_ad_countries_clean(array[' us ', 'ca', 'US']) is distinct from array['CA', 'US'] then
    raise exception 'fn_ad_countries_clean does not trim, upper-case and de-duplicate';
  end if;
  if public.fn_ad_countries_clean(array['USA']) is not null then
    raise exception 'fn_ad_countries_clean accepted a three-letter code';
  end if;
  if public.fn_ad_countries_clean(array[]::text[]) is not null then
    raise exception 'fn_ad_countries_clean did not return null for an empty list';
  end if;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('fn_resolve_ads', 'fn_sponsor_ad_submit', 'fn_sponsor_campaign_create',
                       'fn_sponsor_campaign_list', 'fn_ad_campaign_list');
  if v_n <> 5 then raise exception 'expected one overload each of five functions, found %', v_n; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'fn_resolve_ads'
                    and pg_get_function_arguments(p.oid) like '%p_country text DEFAULT NULL%') then
    raise exception 'fn_resolve_ads does not take p_country';
  end if;
  if exists (select 1 from public.ad_campaign where countries is not null) then
    raise exception 'an existing flight is gated; every existing flight runs everywhere';
  end if;
end $$;

COMMIT;
