-- A CAMPAIGN CAN DECAY FOR A MONTH AND EVERY NUMBER ON THE PAGE STAYS FINE
--
-- Every figure this system reports is a LIFETIME total. `fn_ad_stats` groups
-- by ad and slot and nothing else, so a campaign that worked for three weeks
-- and has done nothing since looks identical to one that is working now - the
-- averages simply absorb the decline, and the longer a campaign runs the more
-- inertia its own history gives it.
--
-- That is the shape of a metric that cannot tell you to act. `last_event_at`
-- (20260828050000) catches a surface that stopped completely; it says nothing
-- about one that is quietly halving.
--
-- ── fn_ad_daily(days) ──────────────────────────────────────────────────────
--
-- One row per ad, per slot, per DAY: impressions, clicks, and the people
-- behind them. Enough to see a trend, in the same shape as everything else on
-- the page.
--
-- Live-computed rather than a rollup table maintained by a cron. At 201 events
-- that is not a close call, and a rollup would be a second source of truth to
-- keep in step - the estate has enough of those. `idx_ad_event_rollup` already
-- covers this. When `ad_event` gets large enough for it to matter, the answer
-- is a materialised daily table fed by Open Claw (CLAUDE.md section 11 - Open
-- Claw is the only sanctioned scheduler, and a new cron is a governed change),
-- not a bigger limit here.
--
-- The window is a parameter, clamped 1..365. A year of daily rows for one
-- campaign is 365 rows; a request for ten years is a mistake, not a need.
--
-- ── AND TWO CONSTRAINTS THE PANEL HAS BEEN ASSUMING ────────────────────────
--
-- `weight` had no CHECK. `20260828070000` made weight the share of voice, and
-- its draw guards the exponent with `GREATEST(weight, 1)` precisely because a
-- 0 or a negative would divide by zero or invert the ordering. That guard is
-- correct and stays, but the panel offers a free-text weight box and the
-- database should not be silently reinterpreting what somebody typed. A weight
-- of 0 is not "vanishingly unlikely", it is a mistake, and the save should say
-- so at the point it happens.
--
-- `starts_at`/`ends_at` had no ordering rule either, so a flight window that
-- ends before it begins saves cleanly and the campaign never runs. The
-- resolver's `starts_at <= now() AND ends_at > now()` can never both be true,
-- so it is a campaign that is live, correct-looking in the editor, and dead.
-- Exactly the silent-nothing this system keeps finding.
--
-- Both are verified against existing rows first - 0 violations today - and
-- both abort rather than reject data retroactively.
--
-- ROLLBACK
--   drop function if exists public.fn_ad_daily(integer);
--   alter table public.ad_catalog drop constraint if exists ad_catalog_weight_positive;
--   alter table public.ad_catalog drop constraint if exists ad_catalog_flight_window_ordered;

create or replace function public.fn_ad_daily(p_days integer default 30)
returns table(
  ad_id uuid,
  slot text,
  day date,
  impressions bigint,
  clicks bigint,
  viewers bigint
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  SELECT e.ad_id,
         e.slot,
         (e.created_at AT TIME ZONE 'UTC')::date AS day,
         count(*) FILTER (WHERE e.event_type = 'impression') AS impressions,
         count(*) FILTER (WHERE e.event_type = 'click')      AS clicks,
         count(DISTINCT e.user_id) FILTER (WHERE e.event_type = 'impression') AS viewers
    FROM public.ad_event e
   WHERE e.created_at >= now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_days, 30), 365)))
   GROUP BY e.ad_id, e.slot, (e.created_at AT TIME ZONE 'UTC')::date;
$function$;

-- Same reasoning as fn_ad_stats and fn_ad_suppression: ad_event has no select
-- policy so one player can never enumerate another's viewing history, and this
-- aggregates across every player.
revoke all on function public.fn_ad_daily(integer) from public, anon, authenticated;
grant execute on function public.fn_ad_daily(integer) to service_role;

-- Two constraints the panel has been assuming all along.
do $$
declare v_bad int;
begin
  select count(*) into v_bad from public.ad_catalog where weight is null or weight <= 0;
  if v_bad > 0 then
    raise exception
      '% campaign(s) carry a weight of zero or less; decide what they should be before constraining', v_bad;
  end if;

  select count(*) into v_bad
    from public.ad_catalog
   where starts_at is not null and ends_at is not null and ends_at <= starts_at;
  if v_bad > 0 then
    raise exception
      '% campaign(s) end before they begin; those are live and dead at once, fix them before constraining', v_bad;
  end if;
end $$;

alter table public.ad_catalog
  add constraint ad_catalog_weight_positive check (weight > 0);

alter table public.ad_catalog
  add constraint ad_catalog_flight_window_ordered
  check (starts_at is null or ends_at is null or ends_at > starts_at);

comment on constraint ad_catalog_weight_positive on public.ad_catalog is
  'Weight is a share of voice (20260828070000). Zero is a mistake, not a share, '
  'and the resolver should not have to reinterpret it at draw time.';

comment on constraint ad_catalog_flight_window_ordered on public.ad_catalog is
  'A window that ends before it begins can never satisfy the resolver, so the '
  'campaign is live in the editor and dead everywhere else.';

-- Assertions. Abort rather than half-apply.
do $$
declare
  v_acl  text;
  v_rows int;
  v_sum  bigint;
begin
  if not exists (select 1 from pg_proc where proname = 'fn_ad_daily') then
    raise exception 'fn_ad_daily was not created';
  end if;

  select array_to_string(proacl, ' | ') into v_acl from pg_proc where proname = 'fn_ad_daily';
  if v_acl like '%authenticated=X%' or v_acl like '%anon=X%' then
    raise exception 'fn_ad_daily is executable by players; it aggregates across every player';
  end if;

  -- The days must add up to the lifetime, or one of the two is wrong and the
  -- panel would show a trend that contradicts its own totals.
  select count(*) into v_rows from public.fn_ad_daily(365);
  if v_rows = 0 and exists (select 1 from public.ad_event) then
    raise exception 'fn_ad_daily returned nothing while ad_event has rows';
  end if;

  select coalesce(sum(impressions), 0) into v_sum from public.fn_ad_daily(365);
  if v_sum <> (select count(*) from public.ad_event
                where event_type = 'impression'
                  and created_at >= now() - interval '365 days') then
    raise exception 'fn_ad_daily impressions do not sum to ad_event over the same window';
  end if;

  if (select count(*) from pg_constraint
       where conrelid = 'public.ad_catalog'::regclass
         and conname in ('ad_catalog_weight_positive','ad_catalog_flight_window_ordered')) <> 2 then
    raise exception 'one or both ad_catalog constraints were not created';
  end if;
end $$;
