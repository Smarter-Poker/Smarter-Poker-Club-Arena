-- ═══════════════════════════════════════════════════════════════════════════════
--  A SPONSOR IS QUOTED A PRICE IN DOLLARS
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch.
--
-- The sponsor door opened this morning with "Priced On Request", because what
-- a sponsor pays was left as Dan's number. Dan, 2026-09-13: "NOTHING IS MINE,
-- THEY ARE ALL YOURS." So here is the number, derived rather than guessed:
--
--   `diamond_packages` sells 100 diamonds for $1.00 at every tier, so a
--   diamond is one cent and the club rate card already prices each surface in
--   cents: lobby strip 500/day = $5, session summary 400 = $4, hub promotions
--   300 = $3, empty lobby 250 = $2.50, between hands 800 = $8.
--
--   A sponsor is an outside business sending players OFF the platform to its
--   own site, invoiced by a person rather than paying in a currency it already
--   holds. That is worth more than a club promoting a game inside the room,
--   and it costs a person's time to bill. A sponsor pays TWICE the club rate,
--   rounded to whole dollars (no decimals on a forward-facing page):
--
--     lobby_strip          $10 / day
--     session_summary       $8 / day
--     hub_promotions        $6 / day
--     empty_state           $5 / day
--     table_between_hands  $16 / day   (not bookable: nothing renders it yet)
--
-- The quote is FROZEN ON THE FLIGHT. `ad_campaign.quoted_cents` is written by
-- the submit RPC from the rate card at that moment, so the invoice a person
-- raises matches the number the sponsor was shown when they booked, whatever
-- the rate card says later. A quote of zero is refused: a surface with no
-- price is not for sale to a sponsor.
--
-- `fn_sponsor_campaign_list` and `fn_ad_campaign_list` return `quoted_cents`
-- (return-type change, DROP + CREATE) so the sponsor sees what they owe and
-- staff see what to invoice.
--
-- ROLLBACK: drop ad_rate_card.sponsor_cents_per_day and
-- ad_campaign.quoted_cents; re-apply the four functions from 20260913193627.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- 1. THE PRICE ────────────────────────────────────────────────────────────────
alter table public.ad_rate_card
  add column if not exists sponsor_cents_per_day integer not null default 0
    check (sponsor_cents_per_day >= 0);

comment on column public.ad_rate_card.sponsor_cents_per_day is
  'What an outside sponsor is invoiced per day on this surface, in US cents. Twice the club diamond rate (1 diamond = 1 cent), whole dollars. 0 means not for sale to a sponsor.';

update public.ad_rate_card set sponsor_cents_per_day = v.cents, updated_at = now()
  from (values
    ('lobby_strip',         1000),
    ('session_summary',      800),
    ('hub_promotions',       600),
    ('empty_state',          500),
    ('table_between_hands', 1600)
  ) as v(slot, cents)
 where public.ad_rate_card.slot = v.slot;

alter table public.ad_campaign
  add column if not exists quoted_cents integer
    check (quoted_cents is null or quoted_cents >= 0);

comment on column public.ad_campaign.quoted_cents is
  'The price the sponsor was shown when they booked, in US cents: sponsor_cents_per_day x days at that moment. NULL on a club flight (paid in diamonds). The invoice matches this, not the rate card later.';

-- 2. THE QUOTE IS FROZEN AT SUBMIT ────────────────────────────────────────────
create or replace function public.fn_sponsor_ad_submit(
  p_slot text,
  p_headline text,
  p_image_url text,
  p_poster_url text,
  p_external_url text,
  p_starts_at timestamptz,
  p_days integer,
  p_goal_impressions integer default null,
  p_pacing text default 'even'
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
  v_start := greatest(coalesce(p_starts_at, now()), now() - interval '10 minutes');
  v_end   := v_start + make_interval(days => p_days);
  v_quote := v_rate.sponsor_cents_per_day * p_days;
  insert into public.ad_campaign
    (id, advertiser_id, club_id, name, slot, status, scope, priority,
     starts_at, ends_at, days, image_url, poster_url, target_url, headline,
     diamonds_charged, submitted_by, external_url, pacing, goal_impressions, quoted_cents)
  values
    (v_id, v_adv.id, null, left(v_adv.name, 80), p_slot, 'submitted', 'platform', 90,
     v_start, v_end, p_days, p_image_url, p_poster_url, '/', btrim(p_headline),
     0, v_user, p_external_url, p_pacing, p_goal_impressions, v_quote);
  return jsonb_build_object('ok', true, 'campaign_id', v_id, 'advertiser_id', v_adv.id,
                            'starts_at', v_start, 'ends_at', v_end, 'quoted_cents', v_quote);
end;
$$;

revoke all on function public.fn_sponsor_ad_submit(text, text, text, text, text, timestamptz, integer, integer, text) from public, anon;
grant execute on function public.fn_sponsor_ad_submit(text, text, text, text, text, timestamptz, integer, integer, text) to authenticated, service_role;

-- The staff-typed sponsor flight is quoted the same way, from the same card.
create or replace function public.fn_sponsor_campaign_create(
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
  p_poster_url text default null
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
  v_start := greatest(coalesce(p_starts_at, now()), now() - interval '10 minutes');
  v_end   := v_start + make_interval(days => p_days);
  v_quote := v_quote * p_days;
  insert into public.ad_advertiser (kind, name, club_id, owner_user_id, contact_email)
  values ('sponsor', left(btrim(p_advertiser_name), 80), null, v_user, p_contact_email)
  returning id into v_adv;
  insert into public.ad_campaign
    (id, advertiser_id, club_id, name, slot, status, scope, priority,
     starts_at, ends_at, days, image_url, poster_url, target_url, headline,
     diamonds_charged, submitted_by, external_url, pacing, goal_impressions, quoted_cents)
  values
    (v_id, v_adv, null, left(btrim(p_advertiser_name), 80), p_slot, 'submitted', 'platform', 90,
     v_start, v_end, p_days, p_image_url, p_poster_url,
     '/', btrim(p_headline),
     0, v_user, p_external_url, p_pacing, p_goal_impressions, v_quote);
  return jsonb_build_object('ok', true, 'campaign_id', v_id, 'advertiser_id', v_adv,
                            'starts_at', v_start, 'ends_at', v_end, 'quoted_cents', v_quote);
end;
$$;

revoke all on function public.fn_sponsor_campaign_create(text, text, text, text, text, timestamptz, integer, text, integer, text, text) from public, anon;
grant execute on function public.fn_sponsor_campaign_create(text, text, text, text, text, timestamptz, integer, text, integer, text, text) to authenticated, service_role;

-- 3. THE SPONSOR SEES WHAT THEY OWE; STAFF SEE WHAT TO INVOICE ────────────────
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
  quoted_cents integer
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
         c.quoted_cents
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
  quoted_cents integer
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
         c.quoted_cents
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

-- 4. PROVE IT ─────────────────────────────────────────────────────────────────
do $$
declare
  v_n int;
begin
  select count(*) into v_n from public.ad_rate_card where sponsor_cents_per_day > 0;
  if v_n <> 5 then raise exception 'expected 5 priced surfaces, found %', v_n; end if;
  if (select sponsor_cents_per_day from public.ad_rate_card where slot = 'lobby_strip') <> 1000 then
    raise exception 'lobby_strip is not $10 a day';
  end if;
  -- whole dollars, every one
  if exists (select 1 from public.ad_rate_card where sponsor_cents_per_day % 100 <> 0) then
    raise exception 'a sponsor price is not a whole dollar';
  end if;
  -- twice the club rate, every one (1 diamond = 1 cent)
  if exists (select 1 from public.ad_rate_card where sponsor_cents_per_day <> 2 * diamonds_per_day) then
    raise exception 'a sponsor price is not twice the club rate';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'ad_campaign' and column_name = 'quoted_cents') then
    raise exception 'ad_campaign.quoted_cents is missing';
  end if;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('fn_sponsor_campaign_list', 'fn_ad_campaign_list');
  if v_n <> 2 then raise exception 'expected one overload each of the two list functions, found %', v_n; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'fn_sponsor_campaign_list'
                    and pg_get_function_result(p.oid) like '%quoted_cents integer)') then
    raise exception 'fn_sponsor_campaign_list does not return quoted_cents';
  end if;
end $$;

commit;
