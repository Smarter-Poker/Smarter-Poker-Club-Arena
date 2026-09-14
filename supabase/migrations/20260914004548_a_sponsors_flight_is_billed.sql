-- 20260914004548_a_sponsors_flight_is_billed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A SPONSOR'S FLIGHT IS BILLED, AND A SPONSOR OPENED OVER THE PHONE CAN LOG IN
--
-- 20260913235536 froze a dollar quote on every sponsor flight and told staff
-- "$70 To Invoice". Nothing recorded whether anybody did. Money coming IN off
-- platform is a person raising an invoice and a person seeing it paid; the
-- platform's job is to remember both so the queue does not show the same
-- "To Invoice" for ever and the sponsor can see where they stand.
--
-- 1. THE MARKS. ad_campaign.invoiced_at / paid_at / billed_by. Set by staff
--    through fn_sponsor_campaign_bill(campaign, mark) with mark in
--    'invoiced', 'paid', 'none' (a mistaken click is undone by the same hand,
--    never by editing a row). Only a sponsor flight (club_id null, quoted_cents
--    not null) and only once approved: an invoice is for a flight that runs.
--    'paid' on an uninvoiced flight sets both, because the money arrived.
--    Nothing here moves chips or diamonds; it is a ledger of an offline fact.
--
-- 2. THE SPONSOR SEES IT. fn_sponsor_campaign_list and fn_ad_campaign_list
--    return invoiced_at and paid_at (returns-table change, so drop + create,
--    one overload each as before).
--
-- 3. THE HAND-OFF. A sponsor opened by staff over the phone
--    (fn_sponsor_campaign_create: self_serve false, owner_user_id = the member
--    of staff) could never log in to see their flights.
--    fn_sponsor_advertiser_handoff(advertiser, email) finds the account by
--    e-mail in auth.users, refuses if that account already owns a self-serve
--    sponsor (the one-per-owner index would refuse anyway; this says why), and
--    sets owner_user_id + self_serve. From then on the sponsor's own page
--    lists every flight staff booked for them, quotes and marks included.
--
-- 4. STAFF SEE THEIR SPONSORS. fn_sponsor_advertiser_list(): every sponsor
--    advertiser with its owner's e-mail (from auth.users), whether it is
--    self-serve, and how many flights it has, so the hand-off has a list to
--    act on and staff can see who is a phone sponsor and who logs in.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- 1. THE MARKS
alter table public.ad_campaign
  add column if not exists invoiced_at timestamptz,
  add column if not exists paid_at timestamptz,
  add column if not exists billed_by uuid;

comment on column public.ad_campaign.invoiced_at is
  'When a member of staff recorded that the sponsor invoice for this flight was sent. Null on a club flight and on an unbilled sponsor flight.';
comment on column public.ad_campaign.paid_at is
  'When a member of staff recorded that the sponsor invoice for this flight was paid. Never set without invoiced_at.';
comment on column public.ad_campaign.billed_by is
  'The member of staff who last changed invoiced_at or paid_at.';

create or replace function public.fn_sponsor_campaign_bill(
  p_campaign_id uuid,
  p_mark text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_c    public.ad_campaign%rowtype;
begin
  if not (coalesce(auth.role(), '') = 'service_role' or public.fn_is_platform_admin()) then
    return jsonb_build_object('ok', false, 'reason', 'not_platform_admin');
  end if;
  if p_mark not in ('invoiced', 'paid', 'none') then
    return jsonb_build_object('ok', false, 'reason', 'bad_mark');
  end if;
  select * into v_c from public.ad_campaign where id = p_campaign_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_such_campaign');
  end if;
  if v_c.club_id is not null or v_c.quoted_cents is null then
    return jsonb_build_object('ok', false, 'reason', 'not_a_sponsor_flight');
  end if;
  if v_c.status <> 'approved' then
    return jsonb_build_object('ok', false, 'reason', 'not_approved');
  end if;
  update public.ad_campaign
     set invoiced_at = case p_mark
                         when 'none' then null
                         else coalesce(invoiced_at, now())
                       end,
         paid_at     = case p_mark
                         when 'paid' then coalesce(paid_at, now())
                         else null
                       end,
         billed_by   = v_user,
         updated_at  = now()
   where id = p_campaign_id;
  select * into v_c from public.ad_campaign where id = p_campaign_id;
  return jsonb_build_object('ok', true, 'campaign_id', v_c.id,
                            'invoiced_at', v_c.invoiced_at, 'paid_at', v_c.paid_at,
                            'quoted_cents', v_c.quoted_cents);
end;
$$;

revoke all on function public.fn_sponsor_campaign_bill(uuid, text) from public, anon;
grant execute on function public.fn_sponsor_campaign_bill(uuid, text) to authenticated, service_role;

-- 2. THE SPONSOR SEES IT
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
  quoted_cents integer, invoiced_at timestamptz, paid_at timestamptz
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
         c.quoted_cents, c.invoiced_at, c.paid_at
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
  quoted_cents integer, invoiced_at timestamptz, paid_at timestamptz
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
         c.quoted_cents, c.invoiced_at, c.paid_at
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

-- 3. THE HAND-OFF
create or replace function public.fn_sponsor_advertiser_handoff(
  p_advertiser_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_adv   public.ad_advertiser%rowtype;
  v_owner uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not (coalesce(auth.role(), '') = 'service_role' or public.fn_is_platform_admin()) then
    return jsonb_build_object('ok', false, 'reason', 'not_platform_admin');
  end if;
  if v_email = '' or position('@' in v_email) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'bad_email');
  end if;
  select * into v_adv from public.ad_advertiser where id = p_advertiser_id for update;
  if not found or v_adv.kind <> 'sponsor' then
    return jsonb_build_object('ok', false, 'reason', 'not_a_sponsor');
  end if;
  if v_adv.self_serve then
    return jsonb_build_object('ok', false, 'reason', 'already_handed_off');
  end if;
  select u.id into v_owner from auth.users u where lower(u.email) = v_email limit 1;
  if v_owner is null then
    return jsonb_build_object('ok', false, 'reason', 'no_account_with_that_email');
  end if;
  if exists (select 1 from public.ad_advertiser a
              where a.kind = 'sponsor' and a.self_serve and a.owner_user_id = v_owner) then
    return jsonb_build_object('ok', false, 'reason', 'account_already_has_a_sponsor');
  end if;
  update public.ad_advertiser
     set owner_user_id = v_owner,
         self_serve    = true,
         contact_email = coalesce(nullif(btrim(contact_email), ''), v_email),
         updated_at    = now()
   where id = p_advertiser_id;
  return jsonb_build_object('ok', true, 'advertiser_id', p_advertiser_id, 'owner_user_id', v_owner);
end;
$$;

revoke all on function public.fn_sponsor_advertiser_handoff(uuid, text) from public, anon;
grant execute on function public.fn_sponsor_advertiser_handoff(uuid, text) to authenticated, service_role;

-- 4. STAFF SEE THEIR SPONSORS
create or replace function public.fn_sponsor_advertiser_list()
returns table (
  id uuid, name text, contact_email text, status text, self_serve boolean,
  owner_email text, flights bigint, unpaid_cents bigint, created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.name, a.contact_email, a.status, a.self_serve,
         case when a.self_serve then u.email::text else null end as owner_email,
         (select count(*) from public.ad_campaign c where c.advertiser_id = a.id) as flights,
         (select coalesce(sum(c.quoted_cents), 0)
            from public.ad_campaign c
           where c.advertiser_id = a.id and c.status = 'approved' and c.paid_at is null) as unpaid_cents,
         a.created_at
    from public.ad_advertiser a
    left join auth.users u on u.id = a.owner_user_id
   where a.kind = 'sponsor'
     and (coalesce(auth.role(), '') = 'service_role' or public.fn_is_platform_admin())
   order by a.created_at desc
   limit 200;
$$;

revoke all on function public.fn_sponsor_advertiser_list() from public, anon;
grant execute on function public.fn_sponsor_advertiser_list() to authenticated, service_role;

-- 5. PROVE IT
do $$
declare
  v_n int;
begin
  select count(*) into v_n from information_schema.columns
   where table_schema = 'public' and table_name = 'ad_campaign'
     and column_name in ('invoiced_at', 'paid_at', 'billed_by');
  if v_n <> 3 then raise exception 'expected 3 billing columns on ad_campaign, found %', v_n; end if;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('fn_sponsor_campaign_list', 'fn_ad_campaign_list');
  if v_n <> 2 then raise exception 'expected one overload each of the two list functions, found %', v_n; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'fn_sponsor_campaign_list'
                    and pg_get_function_result(p.oid) like '%paid_at timestamp with time zone)') then
    raise exception 'fn_sponsor_campaign_list does not return paid_at';
  end if;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('fn_sponsor_campaign_bill', 'fn_sponsor_advertiser_handoff', 'fn_sponsor_advertiser_list');
  if v_n <> 3 then raise exception 'expected the three new functions, found %', v_n; end if;
  if exists (select 1 from public.ad_campaign where paid_at is not null and invoiced_at is null) then
    raise exception 'a flight is paid without being invoiced';
  end if;
end $$;

COMMIT;
