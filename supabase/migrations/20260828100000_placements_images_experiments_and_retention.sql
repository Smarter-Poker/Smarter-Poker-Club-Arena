-- FOUR GAPS THE PANEL COULD NOT REACH
--
-- Everything shipped today made the ad system measure better. This makes it
-- OPERABLE, and closes the three smaller gaps found in the same audit.
--
-- ── 1. A PLACEMENT COULD BE CREATED AND NEVER MANAGED ──────────────────────
--
-- `POST /api/club-arena/house-ads` inserts the advert plus exactly ONE
-- placement. `PATCH` touches `ad_catalog` only and never goes near
-- `ad_placement`. So from the panel an operator can create a campaign on one
-- surface, edit its copy, pause it and delete it - and cannot:
--
--   * put an existing campaign on a second surface
--   * change a slot, an audience or a daily cap
--   * pause it on the lobby while leaving it live on the Hub
--
-- Every one of the eighteen multi-slot placements running in production today
-- was written by an agent, in a migration. The ordinary operational actions
-- were all schema changes.
--
-- Nothing in the DATABASE was missing for this; the route simply never
-- exposed it. What this migration adds is the guard rail that makes exposing
-- it safe: a unique index already covers (ad_id, slot, club_id), and now the
-- club reference is a real foreign key so a placement cannot name a club that
-- does not exist. Club-scoped inventory has been possible since Phase 1 and
-- never used - `ad_placement.club_id` is NULL on all eighteen rows - which is
-- exactly the state in which a typo goes unnoticed.
--
-- ── 2. ONE CREATIVE PER CAMPAIGN, AND NO WAY TO SAY OTHERWISE ──────────────
--
-- Two headlines cannot be tested against each other. Nothing stops somebody
-- creating two catalog rows, and since 20260828070000 the weighted draw would
-- split traffic between them correctly - but the panel would report them as
-- unrelated campaigns, so nobody could read the result.
--
-- `experiment_key` makes the relationship explicit. Two rows sharing one are
-- variants of the same test; reporting can group them, and the draw already
-- does the right thing. Deliberately a free text label rather than a table: an
-- experiment is a thing somebody names for a fortnight, not an entity.
--
-- ── 3. GLYPH AND TEXT ONLY ─────────────────────────────────────────────────
--
-- Right for a one-line strip and thin for a card. `image_url` is added with a
-- CHECK, not just a column: an ad destination already had to be checked before
-- a browser was sent to it (20260828034000), and an ad IMAGE is the same
-- question one step earlier - it is a URL, chosen by an operator, that every
-- viewer's browser will fetch. Same-origin paths only. An external host would
-- mean every player's IP handed to a third party by whoever typed the URL.
--
-- ── 4. ad_event GROWS FOREVER ──────────────────────────────────────────────
--
-- ~200 rows a day today, which is nothing, and no retention policy at all.
-- The estate has the precedent (`hand_history_retention_policy`) and the
-- reason to use it: this table is the denominator of every number the panel
-- prints, so pruning it changes history and must be a stated policy rather
-- than a cleanup somebody runs.
--
-- `fn_prune_ad_events()` reads its window from a one-row policy table and
-- returns what it deleted. IT IS NOT SCHEDULED HERE, deliberately: CLAUDE.md
-- section 11 makes Open Claw the only sanctioned scheduler and a new cron a
-- governed change, and section 11.3 fails CI on a net-new file in
-- `pages/api/cron/`. Wiring it to a schedule is a decision with a paper trail,
-- not a side effect of this migration. Until then it is a function somebody
-- runs deliberately, which at 200 rows a day is the correct amount of
-- automation.
--
-- ROLLBACK
--   alter table public.ad_catalog drop column if exists image_url;
--   alter table public.ad_catalog drop column if exists experiment_key;
--   alter table public.ad_placement drop constraint if exists ad_placement_club_fk;
--   drop function if exists public.fn_prune_ad_events();
--   drop table if exists public.ad_event_retention_policy;

-- 1. A placement's club must be a real club.
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
  'NULL means every club. A club id scopes this placement to one club only, '
  'which fn_resolve_ads has honoured since Phase 1 and nothing has ever used.';

-- 2. Variants of one test.
alter table public.ad_catalog
  add column if not exists experiment_key text;

comment on column public.ad_catalog.experiment_key is
  'Two campaigns sharing a key are variants of the same test. The weighted '
  'draw already splits traffic between them; this is what lets a report say so.';

-- 3. A creative may carry an image, and only a same-origin one.
alter table public.ad_catalog
  add column if not exists image_url text;

alter table public.ad_catalog
  add constraint ad_catalog_image_is_same_origin
  check (
    image_url is null
    or (image_url like '/%' and image_url not like '//%')
  );

comment on constraint ad_catalog_image_is_same_origin on public.ad_catalog is
  'Same-origin paths only. An external image URL hands every viewer''s IP and '
  'user agent to a third party chosen by whoever typed it into the panel.';

-- 4. Retention, as a stated policy rather than a cleanup somebody runs.
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
  'One row. ad_event is the denominator of every number the ads panel prints, '
  'so pruning it changes history and belongs in a policy somebody set, not in '
  'a cleanup script somebody ran.';

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
    -- No policy row is not permission to delete everything.
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

-- 5. Assertions. Abort rather than half-apply.
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

  -- The constraint has to actually refuse an external image, or it is
  -- decoration. Probed and rolled back rather than trusted.
  begin
    insert into public.ad_catalog (ad_key, category, headline, image_url, weight)
    values ('zz_probe_external_image', 'other', 'Probe', 'https://example.com/x.png', 1);
    raise exception 'the image origin constraint accepted an external URL';
  exception
    when check_violation then null;  -- correct
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
