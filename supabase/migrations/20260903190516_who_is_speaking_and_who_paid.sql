-- ═══════════════════════════════════════════════════════════════════════════════
--  WHO IS SPEAKING, AND WHO PAID
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-03: "focus on any and all code and missing things we need to
-- allow others to advertise with us, and how we can implement club owners to
-- start advertising their club or events (using diamonds)."
--
-- Until today `ad_catalog` had no advertiser. Every row was the house talking
-- to its own players, so nothing recorded who a creative belonged to, who paid
-- for it, when it was approved, or by whom. This migration adds the three
-- objects an advertiser-shaped system was missing, and the first buyer: a club
-- owner paying diamonds for a flight on a picture surface.
--
--   ad_advertiser   who is speaking: house | club | sponsor. One row per club.
--   ad_rate_card    what a surface costs per day in diamonds, what size the
--                   creative must be, and whether the surface is open to buy.
--   ad_campaign     one purchased flight: surface, dates, creative, price
--                   paid, review state. On approval it becomes an ad_catalog
--                   row plus an ad_placement row, so the resolver, the caps,
--                   the events and the reports all work on it unchanged.
--
-- THE MONEY. A submission debits the submitting owner's diamonds THROUGH THE
-- JOURNAL (`deduct_diamonds`, reference `adcamp:<campaign id>`), inside the
-- same transaction that creates the campaign, so a failed debit leaves no
-- campaign and a failed insert leaves no debit. A rejection or a cancellation
-- refunds through `add_diamonds_to_balance` under `adcamp-refund:<id>`. Both
-- references are unique in `diamond_transactions`, so a replay cannot charge
-- or refund twice. The house is never paid in cash here; the diamonds land on
-- `counterparty = 'revenue:club_ads'` exactly like every other sink.
--
-- THE RESOLVER. Same return type as this morning (no DROP needed): it now
-- reads advertiser kind and name off the advertiser row, and orders by
-- PRIORITY before the weighted draw - a paid flight beats the house, a
-- sponsor beats a club, and within a tier the share-of-voice weight still
-- decides. House rows keep priority 50 and no advertiser, so nothing about
-- today's six campaigns changes.
--
-- THE CREATIVE. Uploaded to the `ad-creatives` storage bucket under
-- `club/<club id>/...` by club staff only (storage RLS below), and referenced
-- as `/ad-creatives/club/<club id>/<file>` - a same-origin path, because the
-- World Hub rewrites `/ad-creatives/*` to the bucket. That keeps the three
-- same-origin locks intact: the catalog CHECK, the API, and the render.
--
-- PRICES ARE DAN'S TO SET. The rate card is seeded so the flow can be used,
-- with the two picture surfaces open and the rest closed. Change the rows,
-- not the code.
--
-- ROLLBACK: drop ad_campaign, ad_rate_card, ad_advertiser (cascade), the two
-- ad_catalog columns, the storage policies and bucket, and re-apply
-- 20260903200000_an_advert_is_a_picture_now.sql for the resolver.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- 1. WHO IS SPEAKING ───────────────────────────────────────────────────────────
create table if not exists public.ad_advertiser (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('house', 'club', 'sponsor')),
  name          text not null check (length(btrim(name)) between 1 and 80),
  club_id       uuid references public.clubs(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete set null,
  contact_email text,
  status        text not null default 'active' check (status in ('active', 'suspended')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint ad_advertiser_club_kind check ((kind = 'club') = (club_id is not null))
);
create unique index if not exists ad_advertiser_one_per_club on public.ad_advertiser (club_id) where club_id is not null;
create unique index if not exists ad_advertiser_one_house on public.ad_advertiser ((kind)) where kind = 'house';

insert into public.ad_advertiser (kind, name)
select 'house', 'smarter.poker'
 where not exists (select 1 from public.ad_advertiser where kind = 'house');

alter table public.ad_advertiser enable row level security;
drop policy if exists ad_advertiser_read on public.ad_advertiser;
create policy ad_advertiser_read on public.ad_advertiser
  for select to anon, authenticated using (true);
-- No write policy: rows are created by the SECURITY DEFINER functions below.

-- 2. WHAT A SURFACE COSTS ──────────────────────────────────────────────────────
create table if not exists public.ad_rate_card (
  slot             text primary key check (slot in ('lobby_strip', 'session_summary', 'empty_state', 'hub_promotions', 'table_between_hands')),
  diamonds_per_day integer not null check (diamonds_per_day > 0),
  min_days         integer not null default 1 check (min_days >= 1),
  max_days         integer not null default 30 check (max_days >= min_days),
  creative_width   integer not null check (creative_width > 0),
  creative_height  integer not null check (creative_height > 0),
  max_bytes        integer not null default 614400 check (max_bytes > 0),
  is_open          boolean not null default false,
  label            text not null,
  blurb            text not null default '',
  updated_at       timestamptz not null default now()
);

insert into public.ad_rate_card (slot, diamonds_per_day, min_days, max_days, creative_width, creative_height, is_open, label, blurb) values
  ('lobby_strip',         500, 1, 30, 1200, 200, true,  'Lobby Strip',      'Directly under the game bar in every club lobby, the last thing a player passes before choosing a table. Three creatives rotate.'),
  ('session_summary',     400, 1, 30,  900, 300, true,  'Session Summary',  'The Session Complete popup every player sees after leaving a table. Three creatives rotate.'),
  ('empty_state',         250, 1, 30, 1080, 1440, false, 'Empty Lobby',      'Shown when a club is running nothing.'),
  ('hub_promotions',      300, 1, 30, 1200, 675, false, 'Hub Promotions',   'The smarter.poker promotions feed on the World Hub.'),
  ('table_between_hands', 800, 1, 30, 1200, 675, false, 'Between Hands',    'Not yet built.')
on conflict (slot) do nothing;

alter table public.ad_rate_card enable row level security;
drop policy if exists ad_rate_card_read on public.ad_rate_card;
create policy ad_rate_card_read on public.ad_rate_card
  for select to anon, authenticated using (true);

-- 3. ONE PURCHASED FLIGHT ──────────────────────────────────────────────────────
create table if not exists public.ad_campaign (
  id                 uuid primary key default gen_random_uuid(),
  advertiser_id      uuid not null references public.ad_advertiser(id) on delete cascade,
  club_id            uuid references public.clubs(id) on delete cascade,
  name               text not null check (length(btrim(name)) between 1 and 80),
  slot               text not null references public.ad_rate_card(slot),
  status             text not null default 'submitted'
                     check (status in ('submitted', 'approved', 'rejected', 'cancelled')),
  -- 'platform': every lobby / every session summary. 'own_club': only inside the paying club.
  scope              text not null default 'platform' check (scope in ('platform', 'own_club')),
  priority           integer not null default 75 check (priority between 1 and 1000),
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  days               integer not null check (days >= 1),
  image_url          text not null check (image_url like '/%' and image_url not like '//%'),
  target_url         text not null check (target_url like '/%' and target_url not like '//%' and position('\' in target_url) = 0),
  headline           text not null check (length(btrim(headline)) between 1 and 120),
  diamonds_charged   integer not null default 0 check (diamonds_charged >= 0),
  diamonds_refunded  integer not null default 0 check (diamonds_refunded >= 0),
  submitted_by       uuid references auth.users(id) on delete set null,
  reviewed_by        uuid references auth.users(id) on delete set null,
  reviewed_at        timestamptz,
  review_note        text,
  ad_id              uuid references public.ad_catalog(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint ad_campaign_flight_ordered check (ends_at > starts_at)
);
create index if not exists idx_ad_campaign_status on public.ad_campaign (status, created_at desc);
create index if not exists idx_ad_campaign_club on public.ad_campaign (club_id, created_at desc);

alter table public.ad_campaign enable row level security;
-- A club's staff can read their own campaigns; platform admins read all.
drop policy if exists ad_campaign_read_own on public.ad_campaign;
create policy ad_campaign_read_own on public.ad_campaign
  for select to authenticated
  using (
    public.fn_is_platform_admin()
    or (club_id is not null and public.fn_club_is_staff(club_id, auth.uid()))
  );
-- No write policy: every write goes through the functions below.

-- The catalog learns who owns a row.
alter table public.ad_catalog add column if not exists advertiser_id uuid references public.ad_advertiser(id) on delete set null;
alter table public.ad_catalog add column if not exists campaign_id   uuid references public.ad_campaign(id) on delete set null;
alter table public.ad_catalog add column if not exists priority      integer not null default 50;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ad_catalog_priority_range') then
    alter table public.ad_catalog add constraint ad_catalog_priority_range check (priority between 1 and 1000);
  end if;
end $$;
create index if not exists idx_ad_catalog_campaign on public.ad_catalog (campaign_id) where campaign_id is not null;

-- 4. THE CREATIVE BUCKET ───────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ad-creatives', 'ad-creatives', true, 614400, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do update
  set public = true, file_size_limit = 614400,
      allowed_mime_types = array['image/webp', 'image/png', 'image/jpeg'];

drop policy if exists "ad creatives public read" on storage.objects;
create policy "ad creatives public read"
  on storage.objects for select using (bucket_id = 'ad-creatives');

-- club/<club uuid>/<file>: only that club's staff may put something there.
drop policy if exists "ad creatives club staff insert" on storage.objects;
create policy "ad creatives club staff insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ad-creatives'
    and (storage.foldername(name))[1] = 'club'
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.fn_club_is_staff(((storage.foldername(name))[2])::uuid, auth.uid())
  );

drop policy if exists "ad creatives uploader delete" on storage.objects;
create policy "ad creatives uploader delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'ad-creatives' and owner = auth.uid());

-- 5. THE RESOLVER READS THE ADVERTISER AND HONOURS PRIORITY ────────────────────
create or replace function public.fn_resolve_ads(
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
           COALESCE(adv.kind, 'house')         AS advertiser_kind,
           COALESCE(adv.name, 'smarter.poker') AS advertiser_name,
           c.priority,
           c.weight,
           c.created_at
      FROM public.ad_catalog c
      JOIN public.ad_placement pl ON pl.ad_id = c.id
      LEFT JOIN public.ad_advertiser adv ON adv.id = c.advertiser_id
     WHERE c.is_active
       AND pl.is_active
       AND pl.slot = p_slot
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
         r.placement_id, r.advertiser_kind, r.advertiser_name
    FROM resolved r
   WHERE r.target_url IS NULL OR r.target_url NOT LIKE '%{%'
   ORDER BY r.priority DESC, random() ^ (1.0 / GREATEST(r.weight, 1)) DESC
   LIMIT GREATEST(0, LEAST(p_limit, 10));
END;
$function$;

grant execute on function public.fn_resolve_ads(text, uuid, integer) to anon, authenticated, service_role;

-- 6. A CLUB BUYS A FLIGHT ──────────────────────────────────────────────────────
create or replace function public.fn_club_ad_submit(
  p_club_id    uuid,
  p_slot       text,
  p_headline   text,
  p_image_url  text,
  p_target_url text,
  p_starts_at  timestamptz,
  p_days       integer,
  p_scope      text default 'platform'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_user   uuid := auth.uid();
  v_rate   public.ad_rate_card%rowtype;
  v_club   record;
  v_adv    uuid;
  v_id     uuid := gen_random_uuid();
  v_cost   integer;
  v_start  timestamptz;
  v_end    timestamptz;
  v_debit  jsonb;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  END IF;
  IF NOT public.fn_club_is_staff(p_club_id, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_club_staff');
  END IF;

  SELECT * INTO v_rate FROM public.ad_rate_card WHERE slot = p_slot;
  IF NOT FOUND OR NOT v_rate.is_open THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'surface_not_open');
  END IF;
  IF p_days IS NULL OR p_days < v_rate.min_days OR p_days > v_rate.max_days THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'days_out_of_range',
                              'min_days', v_rate.min_days, 'max_days', v_rate.max_days);
  END IF;
  IF p_scope NOT IN ('platform', 'own_club') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_scope');
  END IF;

  -- The creative must be one this club uploaded to its own folder, same-origin.
  IF p_image_url IS NULL
     OR p_image_url NOT LIKE ('/ad-creatives/club/' || p_club_id::text || '/%') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'creative_not_in_club_folder');
  END IF;
  -- The destination is a rooted, same-origin path; no protocol-relative, no backslash.
  IF p_target_url IS NULL OR p_target_url NOT LIKE '/%'
     OR p_target_url LIKE '//%' OR position('\' in p_target_url) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_destination');
  END IF;
  IF p_headline IS NULL OR length(btrim(p_headline)) NOT BETWEEN 1 AND 120 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_headline');
  END IF;

  -- A flight starts no earlier than now (a little clock skew tolerated) and
  -- runs whole days.
  v_start := GREATEST(COALESCE(p_starts_at, now()), now() - interval '10 minutes');
  v_end   := v_start + make_interval(days => p_days);
  v_cost  := v_rate.diamonds_per_day * p_days;

  SELECT id, name INTO v_club FROM public.clubs WHERE id = p_club_id;

  -- One advertiser row per club, created on first purchase.
  INSERT INTO public.ad_advertiser (kind, name, club_id, owner_user_id)
  VALUES ('club', left(v_club.name, 80), p_club_id, v_user)
  ON CONFLICT (club_id) WHERE club_id IS NOT NULL
  DO UPDATE SET name = excluded.name, updated_at = now()
  RETURNING id INTO v_adv;

  INSERT INTO public.ad_campaign
    (id, advertiser_id, club_id, name, slot, status, scope, priority,
     starts_at, ends_at, days, image_url, target_url, headline,
     diamonds_charged, submitted_by)
  VALUES
    (v_id, v_adv, p_club_id, left(btrim(p_headline), 80), p_slot, 'submitted', p_scope, 75,
     v_start, v_end, p_days, p_image_url, p_target_url, btrim(p_headline),
     v_cost, v_user);

  -- THE DEBIT, in this transaction, through the journal. deduct_diamonds is
  -- service_role-only at the grant level; this function runs as its owner,
  -- which is the point of SECURITY DEFINER - the browser never calls it.
  v_debit := public.deduct_diamonds(
    v_user, v_cost,
    'Club advert: ' || v_rate.label || ' x ' || p_days || ' day(s)',
    'ad_purchase', 'club_ads',
    jsonb_build_object('campaign_id', v_id, 'club_id', p_club_id, 'slot', p_slot, 'days', p_days),
    'adcamp:' || v_id::text,
    0
  );
  IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
    -- Roll the campaign back with the failed debit: RAISE undoes the insert.
    RAISE EXCEPTION 'AD_DEBIT_FAILED:%', COALESCE(v_debit->>'error', 'unknown')
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'campaign_id', v_id, 'diamonds_charged', v_cost,
    'balance', v_debit->'balance', 'starts_at', v_start, 'ends_at', v_end
  );
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'AD_DEBIT_FAILED:%' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'debit_failed',
                                'detail', substr(SQLERRM, 17));
    END IF;
    RAISE;
END;
$function$;

revoke all on function public.fn_club_ad_submit(uuid, text, text, text, text, timestamptz, integer, text) from public, anon;
grant execute on function public.fn_club_ad_submit(uuid, text, text, text, text, timestamptz, integer, text) to authenticated, service_role;

-- 7. A CLUB CHANGES ITS MIND BEFORE REVIEW ─────────────────────────────────────
create or replace function public.fn_club_ad_cancel(p_campaign_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_user uuid := auth.uid();
  v_c    public.ad_campaign%rowtype;
  v_ref  jsonb;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in'); END IF;
  SELECT * INTO v_c FROM public.ad_campaign WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT public.fn_club_is_staff(v_c.club_id, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_club_staff');
  END IF;
  IF v_c.status <> 'submitted' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_cancellable', 'status', v_c.status);
  END IF;

  -- Refund to whoever paid, under a reference that cannot be replayed.
  v_ref := public.add_diamonds_to_balance(
    v_c.submitted_by, v_c.diamonds_charged, 'refund',
    'Club advert cancelled: ' || v_c.name,
    'adcamp-refund:' || v_c.id::text
  );
  IF COALESCE((v_ref->>'success')::boolean, false) IS NOT TRUE
     AND COALESCE((v_ref->>'duplicate')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'refund failed: %', v_ref->>'error';
  END IF;

  UPDATE public.ad_campaign
     SET status = 'cancelled', diamonds_refunded = diamonds_charged,
         reviewed_at = now(), updated_at = now()
   WHERE id = p_campaign_id;

  RETURN jsonb_build_object('ok', true, 'diamonds_refunded', v_c.diamonds_charged);
END;
$function$;

revoke all on function public.fn_club_ad_cancel(uuid) from public, anon;
grant execute on function public.fn_club_ad_cancel(uuid) to authenticated, service_role;

-- 8. THE HOUSE REVIEWS ─────────────────────────────────────────────────────────
-- Approval turns the campaign into a catalog row plus a placement, which is
-- all the resolver has ever needed. Rejection refunds. Either way the
-- decision, the reviewer and the note are kept on the campaign.
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
    v_ref := public.add_diamonds_to_balance(
      v_c.submitted_by, v_c.diamonds_charged, 'refund',
      'Club advert not approved: ' || v_c.name,
      'adcamp-refund:' || v_c.id::text
    );
    IF COALESCE((v_ref->>'success')::boolean, false) IS NOT TRUE
       AND COALESCE((v_ref->>'duplicate')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'refund failed: %', v_ref->>'error';
    END IF;
    UPDATE public.ad_campaign
       SET status = 'rejected', diamonds_refunded = diamonds_charged,
           reviewed_by = v_user, reviewed_at = now(), review_note = p_note, updated_at = now()
     WHERE id = p_campaign_id;
    RETURN jsonb_build_object('ok', true, 'status', 'rejected', 'diamonds_refunded', v_c.diamonds_charged);
  END IF;

  -- Approve: the campaign becomes inventory.
  INSERT INTO public.ad_catalog
    (ad_key, category, headline, body, glyph, target_url, cta_label, is_active,
     starts_at, ends_at, weight, created_by, image_url, advertiser_id, campaign_id, priority)
  VALUES
    ('camp_' || replace(v_c.id::text, '-', ''), 'club', v_c.headline, NULL, NULL,
     v_c.target_url, NULL, true,
     v_c.starts_at, v_c.ends_at, 100, v_user, v_c.image_url, v_c.advertiser_id, v_c.id, v_c.priority)
  RETURNING id INTO v_ad;

  INSERT INTO public.ad_placement (ad_id, slot, club_id, audience, daily_cap, is_active, image_url)
  VALUES (v_ad, v_c.slot,
          CASE WHEN v_c.scope = 'own_club' THEN v_c.club_id ELSE NULL END,
          'all', NULL, true, v_c.image_url);

  UPDATE public.ad_campaign
     SET status = 'approved', ad_id = v_ad,
         reviewed_by = v_user, reviewed_at = now(), review_note = p_note, updated_at = now()
   WHERE id = p_campaign_id;

  RETURN jsonb_build_object('ok', true, 'status', 'approved', 'ad_id', v_ad);
END;
$function$;

revoke all on function public.fn_ad_campaign_review(uuid, text, text) from public, anon;
grant execute on function public.fn_ad_campaign_review(uuid, text, text) to authenticated, service_role;

-- 9. WHAT A CLUB (OR THE HOUSE) SEES ───────────────────────────────────────────
-- Display status is derived from the dates, so no scheduler is needed to move
-- a flight from approved to live to finished (CLAUDE.md section 11).
create or replace function public.fn_ad_campaign_list(p_club_id uuid default null)
returns table(
  id uuid, club_id uuid, club_name text, name text, slot text, status text, display_status text,
  scope text, starts_at timestamptz, ends_at timestamptz, days integer,
  image_url text, target_url text, headline text,
  diamonds_charged integer, diamonds_refunded integer,
  submitted_by uuid, reviewed_at timestamptz, review_note text, created_at timestamptz,
  impressions bigint, viewable bigint, clicks bigint, viewers bigint
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  SELECT c.id, c.club_id, cl.name AS club_name, c.name, c.slot, c.status,
         CASE
           WHEN c.status <> 'approved' THEN c.status
           WHEN now() < c.starts_at THEN 'scheduled'
           WHEN now() >= c.ends_at  THEN 'finished'
           ELSE 'live'
         END AS display_status,
         c.scope, c.starts_at, c.ends_at, c.days,
         c.image_url, c.target_url, c.headline,
         c.diamonds_charged, c.diamonds_refunded,
         c.submitted_by, c.reviewed_at, c.review_note, c.created_at,
         COALESCE(s.impressions, 0), COALESCE(s.viewable, 0), COALESCE(s.clicks, 0), COALESCE(s.viewers, 0)
    FROM public.ad_campaign c
    JOIN public.clubs cl ON cl.id = c.club_id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE e.event_type = 'impression') AS impressions,
             count(*) FILTER (WHERE e.event_type = 'viewable')   AS viewable,
             count(*) FILTER (WHERE e.event_type = 'click')      AS clicks,
             count(DISTINCT e.user_id) FILTER (WHERE e.event_type = 'impression') AS viewers
        FROM public.ad_event e
       WHERE e.ad_id = c.ad_id
    ) s ON true
   WHERE (
           (p_club_id IS NOT NULL AND c.club_id = p_club_id AND public.fn_club_is_staff(p_club_id, auth.uid()))
        OR (p_club_id IS NULL AND (COALESCE(auth.role(), '') = 'service_role' OR public.fn_is_platform_admin()))
         )
   ORDER BY c.created_at DESC
   LIMIT 200;
$function$;

revoke all on function public.fn_ad_campaign_list(uuid) from public, anon;
grant execute on function public.fn_ad_campaign_list(uuid) to authenticated, service_role;

-- 10. ASSERTIONS ───────────────────────────────────────────────────────────────
do $$
declare
  v_def text;
  v_n   int;
  v_res jsonb;
  v_club uuid;
begin
  if not exists (select 1 from public.ad_advertiser where kind = 'house') then
    raise exception 'no house advertiser row';
  end if;
  select count(*) into v_n from public.ad_rate_card where is_open;
  if v_n <> 2 then raise exception 'expected exactly the two picture surfaces open, found %', v_n; end if;
  if not exists (select 1 from storage.buckets where id = 'ad-creatives') then
    raise exception 'ad-creatives bucket missing';
  end if;

  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'fn_resolve_ads';
  if v_def not like '%ORDER BY r.priority DESC, random()%' then
    raise exception 'the resolver does not order by priority before the weighted draw';
  end if;
  if v_def not like '%e.slot = pl.slot%' then raise exception 'per-surface cap lost'; end if;
  if v_def not like '%NOT LIKE ''%{%''%' then raise exception 'placeholder guard lost'; end if;
  if v_def not like '%COALESCE(pl.image_url, c.image_url)%' then raise exception 'placement creative lost'; end if;

  -- A second club advertiser for the same club is refused.
  select id into v_club from public.clubs order by created_at limit 1;
  if v_club is not null then
    begin
      insert into public.ad_advertiser (kind, name, club_id) values ('club', 'probe', v_club);
      insert into public.ad_advertiser (kind, name, club_id) values ('club', 'probe2', v_club);
      raise exception 'two advertiser rows for one club were accepted';
    exception
      when unique_violation then
        delete from public.ad_advertiser where club_id = v_club and name = 'probe';
    end;
  end if;

  -- The submit function refuses an anonymous caller without touching money.
  v_res := public.fn_club_ad_submit(v_club, 'lobby_strip', 'x', '/ad-creatives/club/x/y.webp', '/', now(), 1);
  if coalesce(v_res->>'reason', '') <> 'not_signed_in' then
    raise exception 'fn_club_ad_submit answered % to an anonymous caller', v_res;
  end if;

  -- The review function refuses a non-admin.
  v_res := public.fn_ad_campaign_review(gen_random_uuid(), 'approve');
  if coalesce(v_res->>'reason', '') not in ('not_platform_admin', 'not_found') then
    raise exception 'fn_ad_campaign_review answered % without an admin', v_res;
  end if;

  -- House rows are untouched: still six, still priority 50, still no advertiser.
  select count(*) into v_n from public.ad_catalog where advertiser_id is null and priority = 50;
  if v_n < 6 then raise exception 'house catalog rows changed: %', v_n; end if;
end $$;

commit;
