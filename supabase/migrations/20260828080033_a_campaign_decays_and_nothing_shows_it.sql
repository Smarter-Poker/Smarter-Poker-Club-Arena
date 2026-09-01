-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828080033; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

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

revoke all on function public.fn_ad_daily(integer) from public, anon, authenticated;
grant execute on function public.fn_ad_daily(integer) to service_role;

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
  'Weight is a share of voice (20260828070000). Zero is a mistake, not a share, and the resolver should not have to reinterpret it at draw time.';

comment on constraint ad_catalog_flight_window_ordered on public.ad_catalog is
  'A window that ends before it begins can never satisfy the resolver, so the campaign is live in the editor and dead everywhere else.';

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
