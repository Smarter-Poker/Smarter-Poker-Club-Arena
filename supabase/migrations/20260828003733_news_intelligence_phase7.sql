-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828003733; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- =============================================================================
-- Migration: News Intelligence Phase 7
-- Purpose  : Licensed POY provenance + auditable newsletter operations
-- Tier     : 2 (additive schema and policy correction)
-- Rollback : Drop newsletter_campaigns; remove POY metadata columns/index;
--            restore the previous newsletter_subscribers policies if required.
-- =============================================================================

begin;

-- The existing table was designed for internal Smarter.Poker users. Licensed
-- external rankings need a source-owned id instead of overloading player_id,
-- which is a UUID foreign key to auth.users.
alter table public.poy_leaderboard
  add column if not exists external_player_id text,
  add column if not exists source_url text,
  add column if not exists source_updated_at timestamptz,
  add column if not exists country text,
  add column if not exists team text;

create unique index if not exists poy_leaderboard_year_rank_uidx
  on public.poy_leaderboard (year, rank);

create index if not exists poy_leaderboard_freshness_idx
  on public.poy_leaderboard (year, source_updated_at desc);

create or replace function public.fn_replace_licensed_poy_rankings(
  p_year integer,
  p_rows jsonb,
  p_source_url text,
  p_source_updated_at timestamptz
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;
  if p_year < 2000 or p_year > extract(year from now())::integer + 1 then
    raise exception 'invalid ranking year';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 500 then
    raise exception 'ranking payload must contain 1..500 rows';
  end if;

  delete from public.poy_leaderboard where year = p_year;

  insert into public.poy_leaderboard (
    player_name, external_player_id, points, rank, year, source,
    source_url, source_updated_at, country, team, updated_at
  )
  select
    nullif(trim(row.player_name), ''),
    nullif(trim(row.external_player_id), ''),
    row.points,
    row.rank,
    p_year,
    'gpi_licensed_feed',
    p_source_url,
    p_source_updated_at,
    nullif(trim(row.country), ''),
    nullif(trim(row.team), ''),
    now()
  from jsonb_to_recordset(p_rows) as row(
    player_name text,
    external_player_id text,
    points numeric,
    rank integer,
    country text,
    team text
  )
  where row.player_name is not null
    and row.rank between 1 and 500
    and row.points >= 0;

  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then
    raise exception 'ranking payload produced no valid rows';
  end if;
  return inserted_count;
end;
$$;

revoke all on function public.fn_replace_licensed_poy_rankings(integer, jsonb, text, timestamptz) from public;
grant execute on function public.fn_replace_licensed_poy_rankings(integer, jsonb, text, timestamptz) to service_role;

-- Campaign history makes every irreversible send visible and auditable. Email
-- addresses remain only in newsletter_subscribers; this table stores counts,
-- configuration and provider-safe aggregate errors, never a recipient list.
create table if not exists public.newsletter_campaigns (
  id uuid primary key default gen_random_uuid(),
  subject text not null check (char_length(subject) between 1 and 200),
  status text not null default 'sending'
    check (status in ('sending', 'sent', 'partial', 'failed', 'cancelled')),
  audience text not null default 'active_subscribers'
    check (audience = 'active_subscribers'),
  lookback_days integer not null check (lookback_days between 1 and 30),
  article_limit integer not null check (article_limit between 1 and 20),
  article_ids uuid[] not null default '{}',
  recipient_count integer not null default 0 check (recipient_count >= 0),
  sent_count integer not null default 0 check (sent_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  error_summary text,
  created_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists newsletter_campaigns_created_idx
  on public.newsletter_campaigns (created_at desc);

alter table public.newsletter_campaigns enable row level security;

drop policy if exists newsletter_campaigns_service_select on public.newsletter_campaigns;
create policy newsletter_campaigns_service_select
  on public.newsletter_campaigns for select to service_role
  using ((select auth.role()) = 'service_role');

drop policy if exists newsletter_campaigns_service_insert on public.newsletter_campaigns;
create policy newsletter_campaigns_service_insert
  on public.newsletter_campaigns for insert to service_role
  with check ((select auth.role()) = 'service_role');

drop policy if exists newsletter_campaigns_service_update on public.newsletter_campaigns;
create policy newsletter_campaigns_service_update
  on public.newsletter_campaigns for update to service_role
  using ((select auth.role()) = 'service_role')
  with check ((select auth.role()) = 'service_role');

-- The public signup form writes through /api/news/subscribe with the service
-- role. Direct anonymous SELECT previously exposed every guest subscriber row
-- because user_id IS NULL was treated as ownership. Remove that privacy leak.
drop policy if exists users_insert_subscription on public.newsletter_subscribers;
drop policy if exists users_read_own_subscription on public.newsletter_subscribers;

create policy users_read_own_subscription
  on public.newsletter_subscribers for select to authenticated
  using ((select auth.uid()) = user_id);

create index if not exists newsletter_subscribers_active_created_idx
  on public.newsletter_subscribers (is_active, created_at desc);

commit;

