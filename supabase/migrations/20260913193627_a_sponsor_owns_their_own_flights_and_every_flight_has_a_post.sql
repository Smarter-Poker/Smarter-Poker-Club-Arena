-- ═══════════════════════════════════════════════════════════════════════════════
--  A SPONSOR OWNS THEIR OWN FLIGHTS, AND EVERY FLIGHT HAS A POSTER
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch.
--
-- Dan, 2026-09-03: "allow others to advertise with us." Until today an outside
-- sponsor could not touch the platform: a member of staff typed their flight
-- into the admin queue (`fn_sponsor_campaign_create`), and the only people who
-- could read what it did were staff. Dan, 2026-09-13: every advert is a fluid
-- picture and a tap opens it full screen - which gave every flight a
-- `poster_url`, and gave neither self-serve flow a way to supply one.
--
-- Three things, each enforced here rather than in a page:
--
-- 1. EVERY SELF-SERVE FLIGHT CAN CARRY A POSTER. `fn_club_ad_submit` and
--    `fn_sponsor_campaign_create` gain `p_poster_url`, checked exactly as the
--    surface creative is (same folder, same origin). The parameter defaults to
--    NULL so the bundle already in players' tabs keeps working while the new
--    one rolls out; the client requires it.
--
-- 2. A SPONSOR SIGNS IN AND OWNS THEIR FLIGHTS. `ad_advertiser.self_serve`
--    marks an advertiser that a signed-in person created for themselves; one
--    per account (`ad_advertiser_one_self_serve_sponsor_per_owner`). Staff-
--    created sponsors keep `self_serve = false` and their `owner_user_id` is
--    the member of staff who typed them in, so the two never collide.
--      `fn_sponsor_advertiser_upsert`  - my advertiser (created on first use)
--      `fn_sponsor_ad_submit`          - my flight, into the SAME review queue
--      `fn_sponsor_campaign_list`      - my flights and their numbers
--    and the storage policy lets that owner, and only that owner, upload into
--    `ad-creatives/sponsor/<their advertiser id>/`. No diamonds move: a sponsor
--    is invoiced off-platform by a person (CLAUDE.md 10.9: money that a bank
--    sees is Dan's). A sponsor flight lands `submitted`, priority 90, exactly
--    where a staff-typed one does, and nothing serves until staff approve it.
--
-- 3. THE NUMBERS ARE THE ADVERTISER'S TO READ. `fn_ad_campaign_report` was
--    staff and club-staff only; the 09-09 changelog listed "a sponsor-facing
--    view" as still to do. The owner of a campaign's advertiser can now read
--    it. `fn_club_ad_cancel` lets that owner withdraw a flight that has not
--    been reviewed yet (no refund - nothing was charged).
--
-- WHAT THIS DOES NOT DO: set a price for a sponsor. `ad_rate_card` prices
-- surfaces in diamonds for clubs; what a sponsor pays is Dan's number, quoted
-- by a person, and this migration invents none.
--
-- ROLLBACK: drop the three fn_sponsor_* functions and the storage policy,
-- drop ad_advertiser.self_serve, and re-apply fn_club_ad_submit,
-- fn_sponsor_campaign_create, fn_ad_campaign_report and fn_club_ad_cancel
-- from 20260903190516 / 20260909071146.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- 1. ONE SELF-SERVE SPONSOR PER ACCOUNT ───────────────────────────────────────
alter table public.ad_advertiser add column if not exists self_serve boolean not null default false;

comment on column public.ad_advertiser.self_serve is
  'True when a signed-in person created this advertiser for themselves through fn_sponsor_advertiser_upsert. One per owner. Staff-typed sponsors are false and their owner_user_id is the member of staff.';

create unique index if not exists ad_advertiser_one_self_serve_sponsor_per_owner
  on public.ad_advertiser (owner_user_id)
  where kind = 'sponsor' and self_serve;

-- 2. MY ADVERTISER ────────────────────────────────────────────────────────────
create or replace function public.fn_sponsor_advertiser_mine()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select jsonb_build_object(
              'advertiser_id', a.id, 'name', a.name, 'contact_email', a.contact_email,
              'status', a.status, 'created_at', a.created_at)
       from public.ad_advertiser a
      where a.kind = 'sponsor' and a.self_serve and a.owner_user_id = auth.uid()
      limit 1),
    'null'::jsonb);
$$;

revoke all on function public.fn_sponsor_advertiser_mine() from public, anon;
grant execute on function public.fn_sponsor_advertiser_mine() to authenticated, service_role;

create or replace function public.fn_sponsor_advertiser_upsert(
  p_name text,
  p_contact_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_id   uuid;
  v_status text;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 80 then
    return jsonb_build_object('ok', false, 'reason', 'bad_advertiser_name');
  end if;
  if p_contact_email is not null and (length(p_contact_email) > 200 or position('@' in p_contact_email) = 0) then
    return jsonb_build_object('ok', false, 'reason', 'bad_contact_email');
  end if;
  insert into public.ad_advertiser (kind, name, club_id, owner_user_id, contact_email, self_serve)
  values ('sponsor', btrim(p_name), null, v_user, p_contact_email, true)
  on conflict (owner_user_id) where kind = 'sponsor' and self_serve
  do update set name = excluded.name,
                contact_email = coalesce(excluded.contact_email, public.ad_advertiser.contact_email),
                updated_at = now()
  returning id, status into v_id, v_status;
  return jsonb_build_object('ok', true, 'advertiser_id', v_id, 'status', v_status);
end;
$$;

revoke all on function public.fn_sponsor_advertiser_upsert(text, text) from public, anon;
grant execute on function public.fn_sponsor_advertiser_upsert(text, text) to authenticated, service_role;

-- 3. THE OWNER UPLOADS INTO THEIR OWN FOLDER ──────────────────────────────────
drop policy if exists "ad creatives sponsor owner insert" on storage.objects;
create policy "ad creatives sponsor owner insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ad-creatives'
    and (storage.foldername(name))[1] = 'sponsor'
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and exists (
      select 1 from public.ad_advertiser a
       where a.id = ((storage.foldername(name))[2])::uuid
         and a.kind = 'sponsor' and a.self_serve
         and a.owner_user_id = auth.uid()
         and a.status = 'active'
    )
  );

-- 4. MY FLIGHT, INTO THE SAME QUEUE ───────────────────────────────────────────
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
  v_id    uuid := gen_random_uuid();
  v_start timestamptz;
  v_end   timestamptz;
  v_folder text;
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
  if p_slot = 'table_between_hands'
     or not exists (select 1 from public.ad_rate_card where slot = p_slot) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_slot');
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
  insert into public.ad_campaign
    (id, advertiser_id, club_id, name, slot, status, scope, priority,
     starts_at, ends_at, days, image_url, poster_url, target_url, headline,
     diamonds_charged, submitted_by, external_url, pacing, goal_impressions)
  values
    (v_id, v_adv.id, null, left(v_adv.name, 80), p_slot, 'submitted', 'platform', 90,
     v_start, v_end, p_days, p_image_url, p_poster_url, '/', btrim(p_headline),
     0, v_user, p_external_url, p_pacing, p_goal_impressions);
  return jsonb_build_object('ok', true, 'campaign_id', v_id, 'advertiser_id', v_adv.id,
                            'starts_at', v_start, 'ends_at', v_end);
end;
$$;

revoke all on function public.fn_sponsor_ad_submit(text, text, text, text, text, timestamptz, integer, integer, text) from public, anon;
grant execute on function public.fn_sponsor_ad_submit(text, text, text, text, text, timestamptz, integer, integer, text) to authenticated, service_role;

-- 5. MY FLIGHTS AND THEIR NUMBERS ─────────────────────────────────────────────
create or replace function public.fn_sponsor_campaign_list()
returns table (
  id uuid, club_id uuid, club_name text, name text, slot text, status text,
  display_status text, scope text, starts_at timestamptz, ends_at timestamptz,
  days integer, image_url text, poster_url text, target_url text, external_url text,
  headline text, pacing text, goal_impressions integer,
  diamonds_charged integer, diamonds_refunded integer, submitted_by uuid,
  reviewed_at timestamptz, review_note text, created_at timestamptz,
  impressions bigint, viewable bigint, clicks bigint, viewers bigint
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
         coalesce(s.impressions, 0), coalesce(s.viewable, 0), coalesce(s.clicks, 0), coalesce(s.viewers, 0)
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

-- 6. THE REPORT IS THE ADVERTISER'S TO READ ───────────────────────────────────
create or replace function public.fn_ad_campaign_report(p_campaign_id uuid)
returns table (day date, impressions bigint, viewable bigint, clicks bigint, viewers bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d::date as day,
         count(e.id) filter (where e.event_type = 'impression') as impressions,
         count(e.id) filter (where e.event_type = 'viewable')   as viewable,
         count(e.id) filter (where e.event_type = 'click')      as clicks,
         count(distinct e.user_id) filter (where e.event_type = 'impression') as viewers
    from public.ad_campaign c
    left join public.ad_advertiser adv on adv.id = c.advertiser_id
    cross join lateral generate_series(
      date_trunc('day', c.starts_at),
      least(date_trunc('day', c.ends_at), date_trunc('day', now())),
      interval '1 day'
    ) as d
    left join public.ad_event e
           on e.ad_id = c.ad_id
          and e.created_at >= d
          and e.created_at <  d + interval '1 day'
   where c.id = p_campaign_id
     and (
           coalesce(auth.role(), '') = 'service_role'
        or public.fn_is_platform_admin()
        or (c.club_id is not null and public.fn_club_is_staff(c.club_id, auth.uid()))
        or (adv.owner_user_id is not null and adv.owner_user_id = auth.uid())
         )
   group by d
   order by d;
$$;

revoke all on function public.fn_ad_campaign_report(uuid) from public, anon;
grant execute on function public.fn_ad_campaign_report(uuid) to authenticated, service_role;

-- 7. WITHDRAW: A CLUB IS REFUNDED, A SPONSOR WAS NEVER CHARGED ────────────────
create or replace function public.fn_club_ad_cancel(p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_c    public.ad_campaign%rowtype;
  v_ref  jsonb;
  v_owner uuid;
begin
  if v_user is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  select * into v_c from public.ad_campaign where id = p_campaign_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_c.club_id is not null then
    if not public.fn_club_is_staff(v_c.club_id, v_user) then
      return jsonb_build_object('ok', false, 'reason', 'not_club_staff');
    end if;
  else
    select a.owner_user_id into v_owner from public.ad_advertiser a
     where a.id = v_c.advertiser_id and a.kind = 'sponsor' and a.self_serve;
    if v_owner is null or v_owner <> v_user then
      return jsonb_build_object('ok', false, 'reason', 'not_the_advertiser');
    end if;
  end if;
  if v_c.status <> 'submitted' then
    return jsonb_build_object('ok', false, 'reason', 'not_cancellable', 'status', v_c.status);
  end if;
  if v_c.diamonds_charged > 0 then
    v_ref := public.add_diamonds_to_balance(
      v_c.submitted_by, v_c.diamonds_charged, 'refund',
      'Club advert cancelled: ' || v_c.name,
      'adcamp-refund:' || v_c.id::text
    );
    if coalesce((v_ref->>'success')::boolean, false) is not true
       and coalesce((v_ref->>'duplicate')::boolean, false) is not true then
      raise exception 'refund failed: %', v_ref->>'error';
    end if;
  end if;
  update public.ad_campaign
     set status = 'cancelled', diamonds_refunded = diamonds_charged,
         reviewed_at = now(), updated_at = now()
   where id = p_campaign_id;
  return jsonb_build_object('ok', true, 'diamonds_refunded', v_c.diamonds_charged);
end;
$$;

revoke all on function public.fn_club_ad_cancel(uuid) from public, anon;
grant execute on function public.fn_club_ad_cancel(uuid) to authenticated, service_role;

-- 8. A POSTER ON EVERY SELF-SERVE FLIGHT ──────────────────────────────────────
-- Both gain a trailing `p_poster_url` with a NULL default, so the bundle that
-- is live while this applies keeps working and the new one supplies it. The
-- old signatures are dropped: two overloads that differ only by a defaulted
-- trailing argument are ambiguous to PostgREST.
drop function if exists public.fn_club_ad_submit(uuid, text, text, text, text, timestamptz, integer, text);
create or replace function public.fn_club_ad_submit(
  p_club_id uuid,
  p_slot text,
  p_headline text,
  p_image_url text,
  p_target_url text,
  p_starts_at timestamptz,
  p_days integer,
  p_scope text default 'platform',
  p_poster_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_rate   public.ad_rate_card%rowtype;
  v_club   record;
  v_adv    uuid;
  v_id     uuid := gen_random_uuid();
  v_cost   integer;
  v_start  timestamptz;
  v_end    timestamptz;
  v_debit  jsonb;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;
  if not public.fn_club_is_staff(p_club_id, v_user) then
    return jsonb_build_object('ok', false, 'reason', 'not_club_staff');
  end if;
  select * into v_rate from public.ad_rate_card where slot = p_slot;
  if not found or not v_rate.is_open then
    return jsonb_build_object('ok', false, 'reason', 'surface_not_open');
  end if;
  if p_days is null or p_days < v_rate.min_days or p_days > v_rate.max_days then
    return jsonb_build_object('ok', false, 'reason', 'days_out_of_range',
                              'min_days', v_rate.min_days, 'max_days', v_rate.max_days);
  end if;
  if p_scope not in ('platform', 'own_club') then
    return jsonb_build_object('ok', false, 'reason', 'bad_scope');
  end if;
  if p_image_url is null
     or p_image_url not like ('/ad-creatives/club/' || p_club_id::text || '/%') then
    return jsonb_build_object('ok', false, 'reason', 'creative_not_in_club_folder');
  end if;
  if p_poster_url is not null
     and p_poster_url not like ('/ad-creatives/club/' || p_club_id::text || '/%') then
    return jsonb_build_object('ok', false, 'reason', 'poster_not_in_club_folder');
  end if;
  if p_target_url is null or p_target_url not like '/%'
     or p_target_url like '//%' or position('\' in p_target_url) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'bad_destination');
  end if;
  if p_headline is null or length(btrim(p_headline)) not between 1 and 120 then
    return jsonb_build_object('ok', false, 'reason', 'bad_headline');
  end if;
  v_start := greatest(coalesce(p_starts_at, now()), now() - interval '10 minutes');
  v_end   := v_start + make_interval(days => p_days);
  v_cost  := v_rate.diamonds_per_day * p_days;
  select id, name into v_club from public.clubs where id = p_club_id;
  insert into public.ad_advertiser (kind, name, club_id, owner_user_id)
  values ('club', left(v_club.name, 80), p_club_id, v_user)
  on conflict (club_id) where club_id is not null
  do update set name = excluded.name, updated_at = now()
  returning id into v_adv;
  insert into public.ad_campaign
    (id, advertiser_id, club_id, name, slot, status, scope, priority,
     starts_at, ends_at, days, image_url, poster_url, target_url, headline,
     diamonds_charged, submitted_by)
  values
    (v_id, v_adv, p_club_id, left(btrim(p_headline), 80), p_slot, 'submitted', p_scope, 75,
     v_start, v_end, p_days, p_image_url, p_poster_url, p_target_url, btrim(p_headline),
     v_cost, v_user);
  v_debit := public.deduct_diamonds(
    v_user, v_cost,
    'Club advert: ' || v_rate.label || ' x ' || p_days || ' day(s)',
    'ad_purchase', 'club_ads',
    jsonb_build_object('campaign_id', v_id, 'club_id', p_club_id, 'slot', p_slot, 'days', p_days),
    'adcamp:' || v_id::text,
    0
  );
  if coalesce((v_debit->>'success')::boolean, false) is not true then
    raise exception 'AD_DEBIT_FAILED:%', coalesce(v_debit->>'error', 'unknown')
      using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'ok', true, 'campaign_id', v_id, 'diamonds_charged', v_cost,
    'balance', v_debit->'balance', 'starts_at', v_start, 'ends_at', v_end
  );
exception
  when others then
    if sqlerrm like 'AD_DEBIT_FAILED:%' then
      return jsonb_build_object('ok', false, 'reason', 'debit_failed',
                                'detail', substr(sqlerrm, 17));
    end if;
    raise;
end;
$$;

revoke all on function public.fn_club_ad_submit(uuid, text, text, text, text, timestamptz, integer, text, text) from public, anon;
grant execute on function public.fn_club_ad_submit(uuid, text, text, text, text, timestamptz, integer, text, text) to authenticated, service_role;

drop function if exists public.fn_sponsor_campaign_create(text, text, text, text, text, timestamptz, integer, text, integer, text);
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
  if not exists (select 1 from public.ad_rate_card where slot = p_slot) then
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
  insert into public.ad_advertiser (kind, name, club_id, owner_user_id, contact_email)
  values ('sponsor', left(btrim(p_advertiser_name), 80), null, v_user, p_contact_email)
  returning id into v_adv;
  insert into public.ad_campaign
    (id, advertiser_id, club_id, name, slot, status, scope, priority,
     starts_at, ends_at, days, image_url, poster_url, target_url, headline,
     diamonds_charged, submitted_by, external_url, pacing, goal_impressions)
  values
    (v_id, v_adv, null, left(btrim(p_advertiser_name), 80), p_slot, 'submitted', 'platform', 90,
     v_start, v_end, p_days, p_image_url, p_poster_url,
     '/', btrim(p_headline),
     0, v_user, p_external_url, p_pacing, p_goal_impressions);
  return jsonb_build_object('ok', true, 'campaign_id', v_id, 'advertiser_id', v_adv,
                            'starts_at', v_start, 'ends_at', v_end);
end;
$$;

revoke all on function public.fn_sponsor_campaign_create(text, text, text, text, text, timestamptz, integer, text, integer, text, text) from public, anon;
grant execute on function public.fn_sponsor_campaign_create(text, text, text, text, text, timestamptz, integer, text, integer, text, text) to authenticated, service_role;

-- 9. PROVE IT ─────────────────────────────────────────────────────────────────
do $$
declare
  v_n int;
  v_acl text;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'ad_advertiser' and column_name = 'self_serve') then
    raise exception 'ad_advertiser.self_serve is missing';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'ad_advertiser_one_self_serve_sponsor_per_owner') then
    raise exception 'the one-sponsor-per-owner index is missing';
  end if;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('fn_sponsor_advertiser_mine', 'fn_sponsor_advertiser_upsert', 'fn_sponsor_ad_submit', 'fn_sponsor_campaign_list');
  if v_n <> 4 then raise exception 'expected 4 sponsor functions, found %', v_n; end if;
  -- exactly one overload each of the two functions that gained a poster
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_club_ad_submit';
  if v_n <> 1 then raise exception 'fn_club_ad_submit has % overloads', v_n; end if;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_sponsor_campaign_create';
  if v_n <> 1 then raise exception 'fn_sponsor_campaign_create has % overloads', v_n; end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                  and policyname = 'ad creatives sponsor owner insert') then
    raise exception 'the sponsor upload policy is missing';
  end if;
  -- nobody anonymous can submit a flight or read a report
  select p.proacl::text into v_acl from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_sponsor_ad_submit';
  if v_acl like '%anon=%' then raise exception 'fn_sponsor_ad_submit is reachable anonymously: %', v_acl; end if;
  -- no staff-typed sponsor was silently turned self-serve
  select count(*) into v_n from public.ad_advertiser where kind = 'sponsor' and self_serve;
  if v_n <> 0 then raise exception '% existing sponsors read as self-serve; expected 0', v_n; end if;
end $$;

commit;
