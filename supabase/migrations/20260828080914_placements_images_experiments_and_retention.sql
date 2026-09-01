-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828080914; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

do $$
declare v_bad int;
begin
  select count(*) into v_bad
    from public.ad_placement pl
   where pl.club_id is not null
     and not exists (select 1 from public.clubs c where c.id = pl.club_id);
  if v_bad > 0 then
    raise exception
      '% placement(s) name a club that does not exist; resolve them before adding the key', v_bad;
  end if;
end $$;

alter table public.ad_placement
  add constraint ad_placement_club_fk
  foreign key (club_id) references public.clubs(id) on delete cascade;

comment on column public.ad_placement.club_id is
  'NULL means every club. A club id scopes this placement to one club only, which fn_resolve_ads has honoured since Phase 1 and nothing has ever used.';

alter table public.ad_catalog
  add column if not exists experiment_key text;

comment on column public.ad_catalog.experiment_key is
  'Two campaigns sharing a key are variants of the same test. The weighted draw already splits traffic between them; this is what lets a report say so.';

alter table public.ad_catalog
  add column if not exists image_url text;

alter table public.ad_catalog
  add constraint ad_catalog_image_is_same_origin
  check (
    image_url is null
    or (image_url like '/%' and image_url not like '//%')
  );

comment on constraint ad_catalog_image_is_same_origin on public.ad_catalog is
  'Same-origin paths only. An external image URL hands every viewer''s IP and user agent to a third party chosen by whoever typed it into the panel.';

create table if not exists public.ad_event_retention_policy (
  id                   boolean primary key default true,
  event_retention_days integer not null default 180,
  updated_at           timestamptz not null default now(),
  constraint ad_event_retention_policy_singleton check (id),
  constraint ad_event_retention_days_sane check (event_retention_days between 7 and 3650)
);

insert into public.ad_event_retention_policy (id, event_retention_days)
values (true, 180)
on conflict (id) do nothing;

alter table public.ad_event_retention_policy enable row level security;

comment on table public.ad_event_retention_policy is
  'One row. ad_event is the denominator of every number the ads panel prints, so pruning it changes history and belongs in a policy somebody set, not in a cleanup script somebody ran.';

create or replace function public.fn_prune_ad_events()
returns table(deleted bigint, cutoff timestamptz)
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_days   integer;
  v_cutoff timestamptz;
  v_count  bigint;
BEGIN
  SELECT event_retention_days INTO v_days FROM public.ad_event_retention_policy WHERE id;
  IF v_days IS NULL THEN
    RAISE EXCEPTION 'ad_event_retention_policy has no row; refusing to prune';
  END IF;

  v_cutoff := now() - make_interval(days => v_days);

  DELETE FROM public.ad_event WHERE created_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN QUERY SELECT v_count, v_cutoff;
END;
$function$;

revoke all on function public.fn_prune_ad_events() from public, anon, authenticated;
grant execute on function public.fn_prune_ad_events() to service_role;

do $$
declare
  v_cols int;
  v_acl  text;
begin
  select count(*) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'ad_catalog'
     and column_name in ('image_url', 'experiment_key');
  if v_cols <> 2 then
    raise exception 'expected image_url and experiment_key on ad_catalog, found % of 2', v_cols;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.ad_catalog'::regclass
       and conname = 'ad_catalog_image_is_same_origin'
  ) then
    raise exception 'the image origin constraint was not created';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.ad_placement'::regclass
       and conname = 'ad_placement_club_fk'
  ) then
    raise exception 'the placement club foreign key was not created';
  end if;

  begin
    insert into public.ad_catalog (ad_key, category, headline, image_url, weight)
    values ('zz_probe_external_image', 'other', 'Probe', 'https://example.com/x.png', 1);
    raise exception 'the image origin constraint accepted an external URL';
  exception
    when check_violation then null;
  end;

  if not exists (select 1 from public.ad_event_retention_policy where id) then
    raise exception 'the retention policy row was not created';
  end if;

  select array_to_string(proacl, ' | ') into v_acl
    from pg_proc where proname = 'fn_prune_ad_events';
  if v_acl like '%authenticated=X%' or v_acl like '%anon=X%' then
    raise exception 'fn_prune_ad_events is executable by players; it deletes measurement history';
  end if;
end $$;
