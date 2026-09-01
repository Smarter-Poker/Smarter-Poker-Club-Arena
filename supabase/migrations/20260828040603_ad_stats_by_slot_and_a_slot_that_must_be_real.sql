-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828040603; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create or replace function public.fn_ad_stats()
returns table(
  ad_id uuid,
  slot text,
  impressions bigint,
  clicks bigint,
  dismisses bigint,
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
         max(e.created_at)                                   AS last_event_at
    FROM public.ad_event e
   GROUP BY e.ad_id, e.slot;
$function$;

revoke all on function public.fn_ad_stats() from public, anon, authenticated;
grant execute on function public.fn_ad_stats() to service_role;

do $$
declare v_bad int;
begin
  select count(*) into v_bad
    from public.ad_event
   where slot is null
      or slot not in ('lobby_strip','session_summary','empty_state','hub_promotions','table_between_hands');
  if v_bad > 0 then
    raise exception
      '% ad_event row(s) carry a slot that is not one of the five declared surfaces; inspect them before constraining', v_bad;
  end if;
end $$;

alter table public.ad_event
  add constraint ad_event_slot_check
  check (slot = any (array['lobby_strip','session_summary','empty_state','hub_promotions','table_between_hands']));

do $$
declare
  v_rows int;
  v_acl  text;
begin
  if not exists (select 1 from pg_proc where proname = 'fn_ad_stats') then
    raise exception 'fn_ad_stats was not created';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.ad_event'::regclass and conname = 'ad_event_slot_check'
  ) then
    raise exception 'ad_event_slot_check was not created';
  end if;

  select count(*) into v_rows from public.fn_ad_stats();
  if v_rows = 0 and exists (select 1 from public.ad_event) then
    raise exception 'fn_ad_stats returned nothing while ad_event has rows';
  end if;

  select array_to_string(proacl, ' | ') into v_acl from pg_proc where proname = 'fn_ad_stats';
  if v_acl like '%authenticated=X%' or v_acl like '%anon=X%' then
    raise exception 'fn_ad_stats is executable by players; ad_event has no select policy for a reason';
  end if;
end $$;
