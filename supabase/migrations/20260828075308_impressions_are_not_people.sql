-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828075308; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

drop function if exists public.fn_ad_stats();

create or replace function public.fn_ad_stats()
returns table(
  ad_id uuid,
  slot text,
  impressions bigint,
  clicks bigint,
  dismisses bigint,
  viewers bigint,
  clickers bigint,
  last_event_at timestamptz
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  SELECT e.ad_id,
         e.slot,
         count(*) FILTER (WHERE e.event_type = 'impression') AS impressions,
         count(*) FILTER (WHERE e.event_type = 'click')      AS clicks,
         count(*) FILTER (WHERE e.event_type = 'dismiss')    AS dismisses,
         count(DISTINCT e.user_id) FILTER (WHERE e.event_type = 'impression') AS viewers,
         count(DISTINCT e.user_id) FILTER (WHERE e.event_type = 'click')      AS clickers,
         max(e.created_at)                                   AS last_event_at
    FROM public.ad_event e
   GROUP BY e.ad_id, e.slot;
$function$;

revoke all on function public.fn_ad_stats() from public, anon, authenticated;
grant execute on function public.fn_ad_stats() to service_role;

do $$
declare
  v_acl  text;
  v_bad  int;
  v_rows int;
begin
  select array_to_string(proacl, ' | ') into v_acl from pg_proc where proname = 'fn_ad_stats';
  if v_acl like '%authenticated=X%' or v_acl like '%anon=X%' then
    raise exception 'fn_ad_stats is executable by players; ad_event has no select policy for a reason';
  end if;

  select count(*) into v_bad
    from public.fn_ad_stats()
   where viewers > impressions or clickers > clicks;
  if v_bad > 0 then
    raise exception '% row(s) report more people than events; the distinct count is wrong', v_bad;
  end if;

  select count(*) into v_rows from public.fn_ad_stats();
  if v_rows <> (select count(*) from (select 1 from public.ad_event group by ad_id, slot) g) then
    raise exception 'fn_ad_stats returned % groups; ad_event has a different number', v_rows;
  end if;
end $$;
