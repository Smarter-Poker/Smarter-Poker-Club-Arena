-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828164109; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  RETENTION YOU CAN LOOK AT BEFORE YOU PULL THE LEVER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_prune_ad_events()` was added in 20260828100000 and is called from
-- NOWHERE. It is dead code, and worse than dead: it is a loaded delete with no
-- caller, no schedule and no preview. The estate cannot schedule it either -
-- CLAUDE.md section 11 makes Open Claw the only sanctioned scheduler and
-- section 11.3 fails CI on a net-new pages/api/cron/ file - so the honest
-- answer is to put it in the operator's hands and show them exactly what it
-- would do first.
--
-- Nobody should ever press a DELETE whose blast radius is invisible. This adds
-- the read-only half: how old the policy is, where the cutoff falls, what the
-- oldest event is, and precisely how many rows would go. `fn_prune_ad_events`
-- keeps the deleting to itself.
--
-- WHY A FUNCTION RATHER THAN THE PANEL COUNTING. Because the panel would have
-- to fetch the rows to count them, and the whole point of a retention screen
-- is that the table is too big to fetch.

create or replace function public.fn_ad_retention_status()
returns table (
  retention_days   int,
  cutoff           timestamptz,
  total_events     bigint,
  prunable_events  bigint,
  oldest_event     timestamptz,
  newest_event     timestamptz
)
language sql
security definer
set search_path = public, pg_catalog
stable
as $$
  select
    p.event_retention_days,
    now() - make_interval(days => p.event_retention_days),
    count(e.id),
    count(e.id) filter (
      where e.created_at < now() - make_interval(days => p.event_retention_days)
    ),
    min(e.created_at),
    max(e.created_at)
  from public.ad_event_retention_policy p
  left join public.ad_event e on true
  group by p.event_retention_days;
$$;

comment on function public.fn_ad_retention_status() is
  'Read-only preview for the house-ads retention card: what the policy is, where the cutoff falls, and exactly how many ad_event rows fn_prune_ad_events() would delete. Counts server-side because the reason a retention screen exists is that the table is too large to fetch.';

revoke execute on function public.fn_ad_retention_status() from public, anon, authenticated;
grant execute on function public.fn_ad_retention_status() to service_role;

do $postcheck$
declare
  r record;
begin
  -- (a) It runs, and it agrees with the policy row.
  select * into r from public.fn_ad_retention_status();
  if r.retention_days is null then
    raise exception 'fn_ad_retention_status returned no policy row';
  end if;

  -- (b) prunable can never exceed total. If it does the cutoff arithmetic is
  --     inverted, and an operator would be shown a delete larger than the
  --     table.
  if r.prunable_events > r.total_events then
    raise exception 'prunable (%) exceeds total (%) - the cutoff is inverted',
      r.prunable_events, r.total_events;
  end if;

  -- (c) The preview must not be callable by a browser. It is a definer
  --     function over every ad event in the estate.
  if has_function_privilege('authenticated', 'public.fn_ad_retention_status()', 'EXECUTE')
     or has_function_privilege('anon', 'public.fn_ad_retention_status()', 'EXECUTE') then
    raise exception 'fn_ad_retention_status is client-callable; it must be service_role only';
  end if;
end;
$postcheck$;

-- ROLLBACK
--   drop function if exists public.fn_ad_retention_status();
