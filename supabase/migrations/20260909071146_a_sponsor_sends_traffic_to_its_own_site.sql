-- ═══════════════════════════════════════════════════════════════════════════════
--  A SPONSOR SENDS TRAFFIC TO ITS OWN SITE, AND WE COUNT THE TRIP
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-03: "allow others to advertise with us". Club owners can buy a
-- flight since 20260903190516. An outside sponsor still cannot, and exactly
-- one thing stops them: an advert that cannot send a player to the
-- advertiser's own site is not something an advertiser will pay for. Every
-- destination on this platform is a rooted path on smarter.poker, enforced in
-- four independent places, and every one of those checks is correct.
--
-- ── THE SHAPE THAT KEEPS ALL FOUR LOCKS ────────────────────────────────────────
-- The external address is NEVER handed to a browser, and never travels in a
-- request. It is stored on the campaign, and the campaign gets an opaque
-- `click_code`. The resolver serves `/c/<click_code>` - a rooted, same-origin
-- path - so `ad_catalog`'s CHECK, the Hub API's readSitePath, isSafeAdTarget
-- in Club Arena and isSafeHubDestination on the Hub all keep refusing exactly
-- what they refused yesterday. Not one of them is weakened.
--
-- The World Hub route at that path calls `fn_ad_click_redirect`, which looks
-- the destination UP BY CODE, records the click, and returns the address for
-- a 302. There is no URL parameter anywhere in the flow, so this cannot become
-- an open redirect: a caller who invents a code gets `not_found`, and a caller
-- who guesses a real one still only reaches the address WE approved.
-- (OWASP's open-redirect guidance is precisely "never redirect to a
-- user-supplied address"; the way to obey it is to not accept one.)
--
-- ── THE CLICK IS COUNTED WHERE IT ACTUALLY HAPPENS ─────────────────────────────
-- A click on an internal advert is logged by the browser. A click that LEAVES
-- the site cannot be, reliably: the page is being torn down as the request
-- goes out. So the redirect logs it server-side, in the same call that hands
-- back the address. That is also the number a sponsor is shown, and it is the
-- one number in this system an advertiser has any reason to dispute, so it is
-- the one that should not depend on the browser staying alive long enough to
-- report it. `ad_event.user_id` is nullable, so a signed-out click still
-- counts as a click; it just counts toward nobody.
--
-- ── PACING ─────────────────────────────────────────────────────────────────────
-- A flight with an impression goal used to be able to spend itself on day one.
-- `fn_resolve_ads` now sorts by how far BEHIND its own even-delivery line each
-- campaign is, after priority and before the weighted draw. A campaign that is
-- behind sorts first; one that is ahead sorts last but never goes dark, which
-- matters because dark inventory is how a surface ends up empty while somebody
-- is paying for it. Same signature, same return type - CREATE OR REPLACE, no
-- drop, and the previous migration's promise that the return type was settled
-- for the last time still holds.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────────
-- NO GEO TARGETING. A real-money operator may only be advertised where it is
-- licensed, and that is a compliance control, not a preference. The only
-- country this database could consult is one the browser told it, and a
-- control a player can edit is not a compliance control - it would read as
-- armed while being decorative, which is the failure shape this estate keeps
-- paying for. Geo-gating needs a country resolved at the edge (the World Hub
-- sees one; the resolver is called directly from the browser and does not).
-- Until that exists, `ad_rate_card` keeps every surface a sponsor could buy
-- CLOSED, and this migration adds no country column to pretend otherwise.
--
-- ROLLBACK: drop fn_ad_click_redirect, fn_sponsor_campaign_create and
-- fn_ad_campaign_report; drop the four ad_campaign columns; and re-apply
-- 20260903190516_who_is_speaking_and_who_paid.sql for the three functions it
-- defines, which this migration replaces in place.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- 1. WHAT A SPONSOR FLIGHT CARRIES THAT A CLUB FLIGHT DOES NOT ─────────────────
alter table public.ad_campaign add column if not exists external_url      text;
alter table public.ad_campaign add column if not exists click_code        text;
alter table public.ad_campaign add column if not exists pacing            text not null default 'even';
alter table public.ad_campaign add column if not exists goal_impressions  integer;

do $$
begin
  -- https only, and long enough to be a real address. A sponsor destination is
  -- the one place an outside string reaches a player's browser, so the shape is
  -- checked here as well as at the door that writes it.
  if not exists (select 1 from pg_constraint where conname = 'ad_campaign_external_is_https') then
    alter table public.ad_campaign add constraint ad_campaign_external_is_https
      check (external_url is null or (external_url ~ '^https://[a-zA-Z0-9]' and length(external_url) between 12 and 500));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ad_campaign_pacing_known') then
    alter table public.ad_campaign add constraint ad_campaign_pacing_known
      check (pacing in ('even', 'asap'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ad_campaign_goal_positive') then
    alter table public.ad_campaign add constraint ad_campaign_goal_positive
      check (goal_impressions is null or goal_impressions > 0);
  end if;
  -- A code is minted only for a campaign that has somewhere external to go.
  if not exists (select 1 from pg_constraint where conname = 'ad_campaign_code_needs_a_destination') then
    alter table public.ad_campaign add constraint ad_campaign_code_needs_a_destination
      check (click_code is null or external_url is not null);
  end if;
end $$;

create unique index if not exists ad_campaign_click_code_key on public.ad_campaign (click_code) where click_code is not null;

comment on column public.ad_campaign.external_url is
  'Sponsor destination. Never served to a browser: the resolver serves /c/<click_code> and fn_ad_click_redirect resolves this by code.';
comment on column public.ad_campaign.click_code is
  'Opaque key in the /c/<code> path. Minted at approval. The only thing that travels; the address never does.';

-- 2. A SPONSOR EXISTS WITHOUT A CLUB ───────────────────────────────────────────
-- ad_advertiser already admits kind='sponsor' with club_id NULL. What is
-- missing is a door: club flights are bought with diamonds by club staff, and
-- a sponsor is invoiced off-platform by a person. So this is platform-staff
-- only, takes no money, and lands in the SAME review queue a club flight does,
-- because one approval path is easier to trust than two.
create or replace function public.fn_sponsor_campaign_create(
  p_advertiser_name text,
  p_headline        text,
  p_slot            text,
  p_image_url       text,
  p_external_url    text,
  p_starts_at       timestamptz,
  p_days            integer,
  p_contact_email   text default null,
  p_goal_impressions integer default null,
  p_pacing          text default 'even'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_user uuid := auth.uid();
  v_adv  uuid;
  v_id   uuid := gen_random_uuid();
  v_end  timestamptz;
  v_start timestamptz;
BEGIN
  IF NOT (COALESCE(auth.role(), '') = 'service_role' OR public.fn_is_platform_admin()) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_platform_admin');
  END IF;
  IF p_advertiser_name IS NULL OR length(btrim(p_advertiser_name)) NOT BETWEEN 1 AND 80 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_advertiser_name');
  END IF;
  IF p_headline IS NULL OR length(btrim(p_headline)) NOT BETWEEN 1 AND 120 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_headline');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ad_rate_card WHERE slot = p_slot) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_slot');
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_days');
  END IF;
  -- Same-origin creative, exactly as a club's. A sponsor's picture is uploaded
  -- to the same bucket by staff, under sponsor/.
  IF p_image_url IS NULL OR p_image_url NOT LIKE '/%' OR p_image_url LIKE '//%' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'creative_not_same_origin');
  END IF;
  -- The destination is the ONE outside string in the system. It is checked
  -- here, constrained on the column, and never handed to a browser.
  IF p_external_url IS NULL OR p_external_url !~ '^https://[a-zA-Z0-9]'
     OR length(p_external_url) NOT BETWEEN 12 AND 500
     OR position(' ' in p_external_url) > 0
     OR position(E'\n' in p_external_url) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_must_be_https');
  END IF;
  IF p_pacing NOT IN ('even', 'asap') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_pacing');
  END IF;

  v_start := GREATEST(COALESCE(p_starts_at, now()), now() - interval '10 minutes');
  v_end   := v_start + make_interval(days => p_days);

  INSERT INTO public.ad_advertiser (kind, name, club_id, owner_user_id, contact_email)
  VALUES ('sponsor', left(btrim(p_advertiser_name), 80), NULL, v_user, p_contact_email)
  RETURNING id INTO v_adv;

  INSERT INTO public.ad_campaign
    (id, advertiser_id, club_id, name, slot, status, scope, priority,
     starts_at, ends_at, days, image_url, target_url, headline,
     diamonds_charged, submitted_by, external_url, pacing, goal_impressions)
  VALUES
    (v_id, v_adv, NULL, left(btrim(p_advertiser_name), 80), p_slot, 'submitted', 'platform', 90,
     v_start, v_end, p_days, p_image_url,
     -- A placeholder the resolver would refuse to serve. Approval replaces it
     -- with /c/<code>; until then this campaign is not inventory at all.
     '/', btrim(p_headline),
     0, v_user, p_external_url, p_pacing, p_goal_impressions);

  RETURN jsonb_build_object('ok', true, 'campaign_id', v_id, 'advertiser_id', v_adv,
                            'starts_at', v_start, 'ends_at', v_end);
END;
$function$;

revoke all on function public.fn_sponsor_campaign_create(text, text, text, text, text, timestamptz, integer, text, integer, text) from public, anon;
grant execute on function public.fn_sponsor_campaign_create(text, text, text, text, text, timestamptz, integer, text, integer, text) to authenticated, service_role;

-- 3. APPROVAL MINTS THE CODE ───────────────────────────────────────────────────
-- Replaces the version in 20260903190516. The club path is byte-for-byte the
-- behaviour it had; the only addition is that a campaign with an external
-- destination gets a code, and its catalog row points at /c/<code> rather than
-- at the placeholder.
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
    -- Only a flight that was PAID FOR is refunded. A sponsor flight is
    -- invoiced off-platform and charged nothing, so there is nothing to give
    -- back and add_diamonds_to_balance is not called with a zero.
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

  -- Approve. A destination off this site is reached only through the redirect,
  -- so the catalog row - which every same-origin check reads - carries the
  -- rooted path and never the address.
  IF v_c.external_url IS NOT NULL THEN
    /* gen_random_uuid() is in pg_catalog; gen_random_bytes is pgcrypto, which
       this database installs in `extensions` - outside this function's
       search_path. Reaching for it would have raised "function does not
       exist" at the moment somebody approved their first sponsor, which is
       the worst possible time to find out. 16 hex characters of the same
       CSPRNG is 64 bits, and a guessed code still only reaches a destination
       we approved. */
    v_code := COALESCE(v_c.click_code, substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
    v_target := '/c/' || v_code;
    UPDATE public.ad_campaign SET click_code = v_code WHERE id = p_campaign_id;
  ELSE
    v_code := NULL;
    v_target := v_c.target_url;
  END IF;

  INSERT INTO public.ad_catalog
    (ad_key, category, headline, body, glyph, target_url, cta_label, is_active,
     starts_at, ends_at, weight, created_by, image_url, advertiser_id, campaign_id, priority)
  VALUES
    ('camp_' || replace(v_c.id::text, '-', ''),
     CASE WHEN v_c.club_id IS NULL THEN 'other' ELSE 'club' END,
     v_c.headline, NULL, NULL,
     v_target, NULL, true,
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

  RETURN jsonb_build_object('ok', true, 'status', 'approved', 'ad_id', v_ad, 'click_code', v_code);
END;
$function$;

revoke all on function public.fn_ad_campaign_review(uuid, text, text) from public, anon;
grant execute on function public.fn_ad_campaign_review(uuid, text, text) to authenticated, service_role;

-- 4. THE REDIRECT: LOOK UP BY CODE, RECORD, HAND BACK ──────────────────────────
-- service_role only. The World Hub route is the sole caller. It takes no URL
-- and returns one, which is the whole reason this cannot be an open redirect.
create or replace function public.fn_ad_click_redirect(
  p_click_code text,
  p_user_id    uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_c public.ad_campaign%rowtype;
BEGIN
  IF p_click_code IS NULL OR length(p_click_code) NOT BETWEEN 6 AND 40 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_code');
  END IF;

  SELECT * INTO v_c FROM public.ad_campaign WHERE click_code = p_click_code;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  -- A withdrawn, rejected or finished flight stops sending traffic the moment
  -- it stops being live. An advertiser is not owed clicks after their flight.
  IF v_c.status <> 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_live', 'status', v_c.status);
  END IF;
  IF now() < v_c.starts_at OR now() >= v_c.ends_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_live', 'status', 'outside_flight');
  END IF;
  IF v_c.external_url IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_destination');
  END IF;

  -- Counted here because the page is being torn down at the moment a click
  -- leaves the site; a browser-side insert is the one this would lose.
  INSERT INTO public.ad_event (ad_id, user_id, slot, event_type, club_id)
  VALUES (v_c.ad_id, p_user_id, v_c.slot, 'click', v_c.club_id);

  RETURN jsonb_build_object('ok', true, 'url', v_c.external_url,
                            'campaign_id', v_c.id, 'ad_id', v_c.ad_id, 'slot', v_c.slot);
END;
$function$;

revoke all on function public.fn_ad_click_redirect(text, uuid) from public, anon, authenticated;
grant execute on function public.fn_ad_click_redirect(text, uuid) to service_role;

-- 5. EVERY CAMPAIGN IS VISIBLE, INCLUDING THE ONES WITH NO CLUB ────────────────
-- The previous version INNER JOINed clubs, so a sponsor campaign - club_id
-- NULL by definition - was invisible to the queue that is supposed to review
-- it. It would have been approved by nobody because nobody could see it.
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
  SELECT c.id, c.club_id,
         COALESCE(cl.name, adv.name) AS club_name,
         c.name, c.slot, c.status,
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
    LEFT JOIN public.clubs cl ON cl.id = c.club_id
    LEFT JOIN public.ad_advertiser adv ON adv.id = c.advertiser_id
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

-- 6. WHAT AN ADVERTISER IS SHOWN, COMPUTED ON READ ─────────────────────────────
-- Deliberately not a rollup table and not a scheduled job. CLAUDE.md section 11
-- routes every scheduled trigger through Open Claw, and this does not need one:
-- ad_event is small, the read is indexed, and a number computed at the moment
-- it is asked for cannot be a stale number nobody noticed had stopped updating.
create or replace function public.fn_ad_campaign_report(p_campaign_id uuid)
returns table(
  day date, impressions bigint, viewable bigint, clicks bigint, viewers bigint
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  SELECT d::date AS day,
         count(e.id) FILTER (WHERE e.event_type = 'impression') AS impressions,
         count(e.id) FILTER (WHERE e.event_type = 'viewable')   AS viewable,
         count(e.id) FILTER (WHERE e.event_type = 'click')      AS clicks,
         count(DISTINCT e.user_id) FILTER (WHERE e.event_type = 'impression') AS viewers
    FROM public.ad_campaign c
    CROSS JOIN LATERAL generate_series(
      date_trunc('day', c.starts_at),
      LEAST(date_trunc('day', c.ends_at), date_trunc('day', now())),
      interval '1 day'
    ) AS d
    LEFT JOIN public.ad_event e
           ON e.ad_id = c.ad_id
          AND e.created_at >= d
          AND e.created_at <  d + interval '1 day'
   WHERE c.id = p_campaign_id
     AND (
           COALESCE(auth.role(), '') = 'service_role'
        OR public.fn_is_platform_admin()
        OR (c.club_id IS NOT NULL AND public.fn_club_is_staff(c.club_id, auth.uid()))
         )
   GROUP BY d
   ORDER BY d;
$function$;

revoke all on function public.fn_ad_campaign_report(uuid) from public, anon;
grant execute on function public.fn_ad_campaign_report(uuid) to authenticated, service_role;

-- 7. THE RESOLVER PACES A FLIGHT ───────────────────────────────────────────────
-- Same signature, same return type: CREATE OR REPLACE, no drop.
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
           /* HOW FAR BEHIND ITS OWN LINE THIS FLIGHT IS.
              Positive means owed impressions, so it sorts first. A campaign
              with no goal, or one asked to spend as fast as it can, sits at
              zero and is decided by the weighted draw exactly as before. */
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
   ORDER BY r.priority DESC, r.pace_debt DESC, random() ^ (1.0 / GREATEST(r.weight, 1)) DESC
   LIMIT GREATEST(0, LEAST(p_limit, 10));
END;
$function$;

grant execute on function public.fn_resolve_ads(text, uuid, integer) to anon, authenticated, service_role;

-- 8. ASSERTIONS ────────────────────────────────────────────────────────────────
do $$
declare
  v_def text;
  v_vol char;
  v_acl text;
  v_n   int;
  v_res jsonb;
begin
  select pg_get_functiondef(oid), provolatile, array_to_string(proacl, ' | ')
    into v_def, v_vol, v_acl from pg_proc where proname = 'fn_resolve_ads';

  -- Every rule the previous three migrations asserted, re-asserted. A rewrite
  -- of this function is exactly where they get dropped.
  if v_def not like '%COALESCE(pl.image_url, c.image_url)%' then raise exception 'the placement creative was lost'; end if;
  if v_def not like '%placement_id%' or v_def not like '%advertiser_kind%' then raise exception 'the resolver lost placement_id / advertiser_kind'; end if;
  if v_def not like '%e.slot = pl.slot%' then raise exception 'the per-surface frequency cap was lost'; end if;
  if v_def not like '%{clubId}%' then raise exception 'the club placeholder substitution was lost'; end if;
  if v_def not like '%NOT LIKE ''%{%''%' then raise exception 'the unresolved-placeholder guard was lost'; end if;
  if v_def not like '%random()%' then raise exception 'the weighted draw was lost'; end if;
  if v_def not like '%r.priority DESC%' then raise exception 'priority no longer outranks the draw'; end if;
  if v_def not like '%pace_debt DESC%' then raise exception 'pacing is not in the order'; end if;
  if v_def like '%NOT v_vip%AND NOT v_vip%' then raise exception 'VIP suppression appeared in the resolver'; end if;
  if v_vol <> 'v' then raise exception 'the resolver is marked % again', v_vol; end if;
  if v_acl not like '%anon=X%' or v_acl not like '%authenticated=X%' then raise exception 'the resolver lost its grants: %', v_acl; end if;

  -- The redirect is service_role only. A browser reaching it would be able to
  -- read every sponsor's destination and forge clicks.
  select array_to_string(proacl, ' | ') into v_acl from pg_proc where proname = 'fn_ad_click_redirect';
  if v_acl like '%anon=X%' or v_acl like '%authenticated=X%' then
    raise exception 'fn_ad_click_redirect is reachable from a browser: %', v_acl;
  end if;
  if v_acl not like '%service_role=X%' then
    raise exception 'fn_ad_click_redirect is not callable by the route that needs it: %', v_acl;
  end if;

  -- An external destination that is not https is refused by the column itself.
  begin
    insert into public.ad_campaign
      (advertiser_id, club_id, name, slot, starts_at, ends_at, days, image_url, target_url, headline, external_url)
    values ((select id from public.ad_advertiser limit 1), null, 'probe', 'lobby_strip',
            now(), now() + interval '1 day', 1, '/x.webp', '/', 'probe', 'http://evil.example');
    raise exception 'ad_campaign accepted a non-https destination';
  exception
    when check_violation then null;
  end;

  -- A code cannot exist without a destination to go with it.
  begin
    insert into public.ad_campaign
      (advertiser_id, club_id, name, slot, starts_at, ends_at, days, image_url, target_url, headline, click_code)
    values ((select id from public.ad_advertiser limit 1), null, 'probe', 'lobby_strip',
            now(), now() + interval '1 day', 1, '/x.webp', '/', 'probe', 'orphancode');
    raise exception 'ad_campaign accepted a click code with nowhere to go';
  exception
    when check_violation then null;
  end;

  -- An unknown code is a refusal, not a redirect. This is the open-redirect
  -- question, asked of the live function.
  v_res := public.fn_ad_click_redirect('definitely-not-a-real-code');
  if coalesce(v_res->>'reason', '') <> 'not_found' then
    raise exception 'fn_ad_click_redirect answered % to an unknown code', v_res;
  end if;
  if v_res ? 'url' then
    raise exception 'fn_ad_click_redirect returned a url for an unknown code';
  end if;

  -- Creating a sponsor needs platform staff; an anonymous caller gets nothing.
  v_res := public.fn_sponsor_campaign_create('probe', 'probe', 'lobby_strip', '/x.webp',
                                             'https://example.com/landing', now(), 1);
  if coalesce(v_res->>'reason', '') <> 'not_platform_admin' then
    raise exception 'fn_sponsor_campaign_create answered % to an anonymous caller', v_res;
  end if;

  -- The review queue can see a campaign with no club.
  select count(*) into v_n from pg_proc where proname = 'fn_ad_campaign_list';
  if v_n <> 1 then raise exception 'fn_ad_campaign_list is overloaded: %', v_n; end if;
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'fn_ad_campaign_list';
  if v_def not like '%LEFT JOIN public.clubs%' then
    raise exception 'the campaign list still inner-joins clubs, so no sponsor campaign can be reviewed';
  end if;

  -- Nothing about the six house adverts changed.
  select count(*) into v_n from public.ad_catalog where advertiser_id is null and priority = 50;
  if v_n < 6 then raise exception 'house catalog rows changed: %', v_n; end if;
  select count(*) into v_n from public.ad_placement where slot in ('lobby_strip','session_summary') and is_active;
  if v_n <> 6 then raise exception 'the two picture surfaces no longer carry three placements each: %', v_n; end if;
end $$;

commit;
