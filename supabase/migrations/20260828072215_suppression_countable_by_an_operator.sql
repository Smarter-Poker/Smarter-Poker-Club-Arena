-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828072215; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

drop function if exists public.fn_ad_cap_status(text);

create or replace function public.fn_ad_suppression()
returns table(
  ad_id uuid,
  slot text,
  daily_cap integer,
  served_users_24h bigint,
  capped_users_24h bigint
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  WITH per_user AS (
    SELECT e.ad_id, e.slot, e.user_id, count(*) AS impressions
      FROM public.ad_event e
     WHERE e.event_type = 'impression'
       AND e.created_at > now() - interval '24 hours'
       AND e.user_id IS NOT NULL
     GROUP BY e.ad_id, e.slot, e.user_id
  )
  SELECT pl.ad_id,
         pl.slot,
         pl.daily_cap,
         COALESCE(count(pu.user_id), 0) AS served_users_24h,
         COALESCE(count(pu.user_id) FILTER (
           WHERE pl.daily_cap IS NOT NULL AND pu.impressions >= pl.daily_cap
         ), 0) AS capped_users_24h
    FROM public.ad_placement pl
    LEFT JOIN per_user pu
           ON pu.ad_id = pl.ad_id AND pu.slot = pl.slot
   WHERE pl.is_active
   GROUP BY pl.ad_id, pl.slot, pl.daily_cap;
$function$;

revoke all on function public.fn_ad_suppression() from public, anon, authenticated;
grant execute on function public.fn_ad_suppression() to service_role;

drop index if exists public.idx_ad_event_cap;
create index idx_ad_event_cap
  on public.ad_event (user_id, ad_id, slot, event_type, created_at desc);

comment on index public.idx_ad_event_cap is
  'Exactly the frequency-cap predicate in fn_resolve_ads: user, ad, slot, '
  'event_type, time. Runs once per candidate advert on every page load.';

do $$
declare
  v_acl  text;
  v_def  text;
  v_rows int;
begin
  if exists (select 1 from pg_proc where proname = 'fn_ad_cap_status') then
    raise exception 'fn_ad_cap_status still exists; it was meant to be replaced, not duplicated';
  end if;

  if not exists (select 1 from pg_proc where proname = 'fn_ad_suppression') then
    raise exception 'fn_ad_suppression was not created';
  end if;

  select array_to_string(proacl, ' | ') into v_acl from pg_proc where proname = 'fn_ad_suppression';
  if v_acl like '%authenticated=X%' or v_acl like '%anon=X%' then
    raise exception 'fn_ad_suppression is executable by players; it aggregates across every player';
  end if;

  select count(*) into v_rows from public.fn_ad_suppression();
  if v_rows <> (select count(*) from public.ad_placement where is_active) then
    raise exception 'fn_ad_suppression returned % rows for % active placements',
      v_rows, (select count(*) from public.ad_placement where is_active);
  end if;

  select indexdef into v_def from pg_indexes
   where schemaname = 'public' and indexname = 'idx_ad_event_cap';
  if v_def is null or v_def not like '%slot%' or v_def not like '%event_type%' then
    raise exception 'idx_ad_event_cap does not cover the cap predicate: %', coalesce(v_def, 'MISSING');
  end if;
end $$;
